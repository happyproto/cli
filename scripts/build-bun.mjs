// Compiles dist/hpy.mjs (from scripts/build.mjs, so the HPY_VERSION and
// HPY_PACKAGE_NAME defines are already in it) into standalone executables with
// `bun build --compile`, one per dist target, with the two napi addons
// embedded.
//
// Usage:
//   node scripts/build-bun.mjs [TARGET...]   into dist/bun/hpy-TARGET[.exe];
//                                            the host's target by default,
//                                            `all` for every target
//   node scripts/build-bun.mjs --dist        dist's build-command: the target
//                                            in DIST_TARGET, into ./hpy[.exe]
// Options:
//   --no-smoke   skip running the built binary
//
// Bun's version is pinned in .bun-version (CI's setup-bun reads it).
//
// The addons (D5). Bun embeds a `.node` file only when it can see a literal
// require or import of it. The napi-rs loaders (`@napi-rs/keyring/index.js`,
// `@napi-rs/lzma/index.js`) require every platform's package by name inside
// try blocks, so Bun embeds whichever of those it can resolve, and leaves the
// rest as requires that throw (and are never reached on that platform). Each
// target is therefore compiled in its own staging directory, outside the
// repository, whose node_modules holds the two loaders and only that target's
// platform packages: the binary carries exactly one copy of each addon. The
// platform packages come from node_modules when npm installed them (the
// host's) and otherwise from the registry, at the version and integrity
// package-lock.json records.
//
// macOS (D5): a cross-built darwin-x64 binary's signature is invalid, so every
// darwin binary built on a Mac is re-signed ad hoc with
// `codesign --force --sign -`, then verified. Every binary is checked to hold
// both addons' bytes. The smoke test then runs it: `--version` must print this
// version (which also loads the lzma addon, a static import), and `--help` must
// exit 0. A target this host cannot run is reported and skipped,
// unless HPY_SMOKE_REQUIRED=1 (CI's release builds), which makes that an error.
// darwin-x64 runs under Rosetta on Apple silicon; a musl target on a glibc
// Linux runs in an Alpine container when HPY_SMOKE_DOCKER=1.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

/**
 * dist's target triples, and how each is built. x64 uses Bun's `baseline`
 * builds, which need no AVX2, so they run on every x64 CPU as the Rust builds
 * did. Linux has both libcs: Bun's musl build is dynamically linked (it needs
 * musl's loader and libstdc++), so unlike Rust's static musl build it does not
 * run on glibc distributions, which get the gnu build.
 */
export const TARGETS = {
  "aarch64-apple-darwin": { bun: "bun-darwin-arm64", napi: "darwin-arm64" },
  "x86_64-apple-darwin": { bun: "bun-darwin-x64-baseline", napi: "darwin-x64" },
  "aarch64-unknown-linux-gnu": { bun: "bun-linux-arm64", napi: "linux-arm64-gnu" },
  "x86_64-unknown-linux-gnu": { bun: "bun-linux-x64-baseline", napi: "linux-x64-gnu" },
  "aarch64-unknown-linux-musl": { bun: "bun-linux-arm64-musl", napi: "linux-arm64-musl" },
  "x86_64-unknown-linux-musl": { bun: "bun-linux-x64-musl-baseline", napi: "linux-x64-musl" },
  "x86_64-pc-windows-msvc": { bun: "bun-windows-x64-baseline", napi: "win32-x64-msvc" },
};
const ADDONS = ["@napi-rs/keyring", "@napi-rs/lzma"];

function fail(message) {
  console.error(`build-bun: ${message}`);
  process.exit(1);
}

function hostLibc() {
  if (platform() !== "linux") return undefined;
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
}

/** The triple this machine runs natively. */
export function hostTarget() {
  const a = { arm64: "aarch64", x64: "x86_64" }[arch()];
  const os = platform();
  if (!a) fail(`no target for architecture ${arch()}`);
  if (os === "darwin") return `${a}-apple-darwin`;
  if (os === "linux") return `${a}-unknown-linux-${hostLibc()}`;
  if (os === "win32" && a === "x86_64") return "x86_64-pc-windows-msvc";
  fail(`no target for ${os}/${arch()}`);
}

const isWindows = (target) => target.includes("windows");

// --- The staging directory --------------------------------------------------

function lockEntry(name) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.version || !entry.resolved || !entry.integrity) {
    fail(`package-lock.json has no resolved ${name}; run npm install`);
  }
  return entry;
}

/** A platform package's directory: node_modules's, or a verified registry download. */
async function platformPackage(name) {
  const entry = lockEntry(name);
  const installed = join(root, "node_modules", name);
  if (existsSync(join(installed, "package.json"))) {
    const { version } = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    if (version === entry.version) return installed;
  }
  const cache = join(
    root,
    "node_modules",
    ".cache",
    "hpy-bun",
    `${name.replace("/", "+")}-${entry.version}`,
  );
  if (existsSync(join(cache, "package.json"))) return cache;

  const response = await fetch(entry.resolved);
  if (!response.ok) fail(`${entry.resolved}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = entry.integrity.split("-", 2);
  const actual = createHash(algorithm).update(tarball).digest("base64");
  if (actual !== expected) fail(`${entry.resolved} does not match package-lock.json's integrity`);

  const scratch = mkdtempSync(join(tmpdir(), "hpy-napi-"));
  try {
    const file = join(scratch, "package.tgz");
    writeFileSync(file, tarball);
    mkdirSync(join(scratch, "x"));
    // npm tarballs hold one top-level `package/` directory. Windows has bsdtar as tar.
    execFileSync("tar", ["-xzf", file, "-C", join(scratch, "x")], { stdio: "inherit" });
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(dirname(cache), { recursive: true });
    cpSync(join(scratch, "x", "package"), cache, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return cache;
}

/**
 * A directory outside the repository with the bundle and only `target`'s
 * addons, and the paths of those addons' `.node` files.
 */
async function stage(target) {
  const dir = mkdtempSync(join(tmpdir(), `hpy-bun-${target}-`));
  const natives = [];
  copyFileSync(join(root, "dist", "hpy.mjs"), join(dir, "hpy.mjs"));
  for (const addon of ADDONS) {
    const loader = join(root, "node_modules", addon);
    if (!existsSync(join(loader, "package.json"))) fail(`${addon} is not installed; run npm ci`);
    const want = lockEntry(addon).version;
    const have = JSON.parse(readFileSync(join(loader, "package.json"), "utf8")).version;
    if (have !== want)
      fail(`node_modules has ${addon} ${have}, package-lock.json ${want}; run npm ci`);
    cpSync(loader, join(dir, "node_modules", addon), { recursive: true });
    const platformName = `${addon}-${TARGETS[target].napi}`;
    const from = await platformPackage(platformName);
    cpSync(from, join(dir, "node_modules", platformName), { recursive: true });
    const node = readdirSync(from).filter((f) => f.endsWith(".node"));
    if (node.length !== 1) fail(`${platformName} has ${node.length} .node files, expected 1`);
    natives.push(join(from, node[0]));
  }
  return { dir, natives };
}

/**
 * Bun stores embedded files verbatim, so each addon's bytes must appear in the
 * binary. This holds for every target, including those this host can't run;
 * a missing keyring addon would otherwise show only as an unavailable
 * keychain, since hpy loads it lazily and falls back to the file.
 */
function checkEmbedded(target, outfile, natives) {
  const binary = readFileSync(outfile);
  for (const file of natives) {
    if (binary.indexOf(readFileSync(file)) < 0) {
      fail(`${target}: ${file.split(/[\\/]/).pop()} is not embedded in ${outfile}`);
    }
  }
}

// --- Compiling ----------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

async function compile(target, outfile) {
  const { bun } = TARGETS[target];
  const { dir, natives } = await stage(target);
  try {
    mkdirSync(dirname(outfile), { recursive: true });
    const args = [
      "build",
      "--compile",
      `--target=${bun}`,
      // hpy reads .env files itself (hv env push); the binary must not load
      // one from the working directory into its environment, or a bunfig.toml.
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      join(dir, "hpy.mjs"),
      "--outfile",
      outfile,
    ];
    // Bun sets these only when it compiles on Windows (the release does).
    if (isWindows(target) && platform() === "win32") {
      args.push(
        `--windows-title=hpy`,
        `--windows-publisher=HappyProto`,
        `--windows-description=${pkg.description}`,
        // Windows wants four numbers; the prerelease part is dropped.
        `--windows-version=${pkg.version.replace(/-.*$/, "")}.0`,
      );
    }
    run("bun", args, { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  checkEmbedded(target, outfile, natives);
  if (!isWindows(target)) chmodSync(outfile, 0o755);
  if (target.endsWith("apple-darwin") && platform() === "darwin") {
    run("codesign", ["--force", "--sign", "-", outfile]);
    run("codesign", ["--verify", "--strict", outfile]);
  }
}

// --- Smoke test -----------------------------------------------------------------

/** How to run a `target` binary here, or why it can't be. */
function runner(target, file) {
  const host = hostTarget();
  if (target === host) return { argv: [file] };
  if (target === "x86_64-apple-darwin" && host === "aarch64-apple-darwin") {
    const probe = spawnSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    if (probe.status === 0) return { argv: ["/usr/bin/arch", "-x86_64", file] };
    return { skip: "Rosetta is not installed (softwareupdate --install-rosetta)" };
  }
  const muslOnGlibc = target.replace("-musl", "-gnu") === host && target.endsWith("-musl");
  if (muslOnGlibc && process.env.HPY_SMOKE_DOCKER === "1") {
    const mount = `${dirname(resolve(file))}:/hpy:ro`;
    const name = `/hpy/${file.split(/[\\/]/).pop()}`;
    return {
      argv: ["docker", "run", "--rm", "-i", "-v", mount, "alpine:3.22", "sh", "-c"],
      shell: (args) => `apk add -q --no-cache libstdc++ >/dev/null && ${name} ${args.join(" ")}`,
    };
  }
  return { skip: `${host} cannot run ${target}` };
}

function exec(how, args, env = {}) {
  const [cmd, ...pre] = how.argv;
  const argv = how.shell ? [...pre, how.shell(args)] : [...pre, ...args];
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("HPY_")),
  );
  return spawnSync(cmd, argv, { encoding: "utf8", env: { ...base, ...env } });
}

function smoke(target, file) {
  const how = runner(target, file);
  if (how.skip) {
    if (process.env.HPY_SMOKE_REQUIRED === "1") fail(`cannot smoke-test ${target}: ${how.skip}`);
    console.log(`build-bun: not smoke-testing ${target}: ${how.skip}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "hpy-smoke-"));
  // A private home, no update check, and secrets kept in files: nothing of
  // the user's is read or written (--version and --help touch neither anyway).
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    APPDATA: join(home, "config"),
    HPY_NO_UPDATE_CHECK: "1",
    HPY_CREDENTIAL_STORE: "file",
  };
  try {
    const version = exec(how, ["--version"], env);
    if (version.status !== 0 || version.stdout.trim() !== `hpy ${pkg.version}`) {
      fail(`${target}: --version gave ${version.status}: ${version.stdout}${version.stderr}`);
    }
    const help = exec(how, ["--help"], env);
    if (help.status !== 0 || !help.stdout.includes("Usage: hpy")) {
      fail(`${target}: --help gave ${help.status}: ${help.stdout}${help.stderr}`);
    }
    console.log(`build-bun: ${target} ok (${version.stdout.trim()})`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- Main -------------------------------------------------------------------------

const argv = process.argv.slice(2);
const noSmoke = argv.includes("--no-smoke");
const distMode = argv.includes("--dist");
let targets = argv.filter((a) => !a.startsWith("--"));

if (distMode) {
  const target = process.env.DIST_TARGET || process.env.CARGO_DIST_TARGET;
  if (!target) fail("--dist needs DIST_TARGET (dist sets it)");
  targets = [target];
} else if (targets.length === 0) {
  targets = [hostTarget()];
} else if (targets.length === 1 && targets[0] === "all") {
  targets = Object.keys(TARGETS);
}
for (const t of targets)
  if (!TARGETS[t]) fail(`unknown target ${t}; one of ${Object.keys(TARGETS).join(", ")}`);

run(process.execPath, [join(root, "scripts", "build.mjs")]);
for (const target of targets) {
  const exe = isWindows(target) ? ".exe" : "";
  // dist picks the binary up from the package root.
  const outfile = distMode
    ? join(root, `hpy${exe}`)
    : join(root, "dist", "bun", `hpy-${target}${exe}`);
  await compile(target, outfile);
  console.log(`build-bun: ${outfile}`);
  if (!noSmoke) smoke(target, outfile);
}
