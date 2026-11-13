#!/usr/bin/env node
// Runs every case in cases.txt against the Rust hpy and the TypeScript one,
// each in a fresh HOME, and diffs exit code, stdout and stderr byte for byte.
//
//   RUST_HPY=/path/to/rust/hpy node test/parity/run.mjs [--offline] [--show] [--ts "node dist/hpy.mjs"] [filter]
//
// Exits 1 when any case's exit code, stdout, kept files or mock requests
// differ. stderr differences are listed but do not fail the run unless
// --strict-stderr is given.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SCOPE } from "../../src/atproto/settings.ts";
import { networkDir } from "../../src/project/network/atmosbox.ts";
import { FAKE_DENO, FAKE_DOCKER } from "../support/fake-network.ts";
import { describeRequest, startMock } from "./mock-happyview.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const fixtures = join(root, "test/fixtures/credentials");
const plugins = join(root, "test/fixtures/plugin");
const projects = join(root, "test/fixtures/hvproject");

/** The fixture credential, signed in to the mock registry `$MOCK/reg-<mode>` with `scopes`. */
function mockCredential(mockUrl, mode, scopes) {
  const stored = JSON.parse(readFileSync(join(fixtures, "credentials.file.json"), "utf8"));
  stored.registry = `${mockUrl}/reg-${mode}`;
  stored.pds = `${mockUrl}/reg-${mode}/pds`;
  stored.scopes = scopes;
  return Buffer.from(JSON.stringify(stored)).toString("base64url");
}
const args = process.argv.slice(2);
const flag = (f) => {
  const i = args.indexOf(f);
  if (i === -1) return undefined;
  args.splice(i, 1);
  return true;
};
const opt = (f) => {
  const i = args.indexOf(f);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const offline = flag("--offline");
const strictStderr = flag("--strict-stderr");
/** Print what each matching case printed (Rust's side), to see that a case tests something. */
const show = flag("--show");
// `node --`: Node 26 otherwise reads an `--env-file` anywhere in argv, even after the script,
// and exits 9 when that file is missing. The npm bin needs the same (`#!/usr/bin/env -S node --`).
const tsCmd = (opt("--ts") ?? `node -- ${join(root, "dist/hpy.mjs")}`).split(" ");
const rust = process.env.RUST_HPY;
if (!rust) {
  console.error("set RUST_HPY to a Rust hpy binary (see HANDOFF.md)");
  process.exit(2);
}
const filter = args[0];

const cases = readFileSync(join(here, "cases.txt"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"));

/** Spawns one step, feeding `input` on stdin, while this process keeps serving the mock. */
function spawnStep(cmd, argv, env, cwd, input) {
  return new Promise((res) => {
    // `node` by its own path: a case may give the child a PATH without it.
    const program = cmd[0] === "node" ? process.execPath : cmd[0];
    const child = spawn(program, [...cmd.slice(1), ...argv], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * `@netbin[=<mode>]`, for `hv dev --network local`: the fake `deno` and `docker` of
 * test/support/fake-network.ts first on PATH (logging to $HOME/net.log), hpy's data directory
 * in $HOME/data, and the project at $HOME/proj's checkout already installed, so nothing is
 * downloaded. HTTPS_PROXY points nowhere, so a download that was not meant to happen fails
 * rather than reaching the real archive. Modes: `ready` (the access walkthrough done),
 * `noaccess` (not done), `locked` (a lock left in the checkout), `nodeno` (no fake `deno`).
 * The net log and the files written into the checkout's `stacks/` are compared.
 */
function netbin(home, env, mode) {
  const bin = join(home, "netbin");
  mkdirSync(bin);
  const fakes = [["docker", FAKE_DOCKER]];
  if (mode === "olddeno")
    fakes.push(["deno", `echo "deno $*" >> "$NET_LOG"\necho "deno 2.7.9 (stable)"`]);
  else if (mode !== "nodeno") fakes.push(["deno", FAKE_DENO]);
  for (const [name, body] of fakes) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(home, "net.log");
  env.PATH = `${bin}:/usr/bin:/bin`;
  env.NET_LOG = log;
  env.HPY_DATA_DIR ??= join(home, "data");
  env.HPY_NETWORK_ACCESS_ADDR ??= "127.0.0.1:9";
  env.HTTPS_PROXY = "http://127.0.0.1:9";
  const project = join(home, "proj");
  mkdirSync(project, { recursive: true });
  const net = networkDir(join(home, "data"), project);
  const checkout = join(net.dir, "atmosphereinabox-v0.7.1");
  mkdirSync(join(checkout, "stacks"), { recursive: true });
  writeFileSync(join(checkout, "stacks/components.json"), "[]");
  writeFileSync(
    join(checkout, ".hpy-installed"),
    "73bd22ac78ba137a2b5e9b8ffb88944232f1d25f0df42cdd5ab70e8d12bb526c",
  );
  if (mode !== "noaccess") {
    const ca = createHash("sha256").update("fake-ca\n").digest("hex");
    writeFileSync(join(net.dir, "access.toml"), `ca_sha256 = "${ca}"\n`);
  }
  if (mode === "locked") mkdirSync(join(checkout, "state/cli.lock"), { recursive: true });
  if (mode === "pending") {
    mkdirSync(join(checkout, "state"), { recursive: true });
    writeFileSync(join(checkout, "state/pending-create.json"), "{}");
  }
  if (mode === "stale") {
    // A network whose project has gone, which a new network's first run names.
    const gone = join(home, "data/networks/gone-0123abcd");
    mkdirSync(gone, { recursive: true });
    writeFileSync(join(gone, "project"), join(home, "moved-away"));
  }
  // The new network's directory exists from the first run on, but `stale` needs it absent.
  if (mode === "stale") rmSync(net.dir, { recursive: true, force: true });
  const show = (label, p) => (existsSync(p) ? `${label}:\n${readFileSync(p, "utf8")}\n` : "");
  return {
    hash: net.project.slice(-8),
    subnet: net.subnet,
    files: () =>
      [
        show("net.log", log),
        show("project", join(net.dir, "project")),
        ...["happyview.yaml", "happyview.definition.json", "components.json"].map((f) =>
          show(`stacks/${f}`, join(checkout, "stacks", f)),
        ),
        show("access.toml", join(net.dir, "access.toml")),
      ].join(""),
  };
}

/**
 * One case: `[tags] -- argv [;; argv ...]`, every step in the same fresh HOME.
 * Tags: @cred, @file, @net, @mock (a mock HappyView at $MOCK), STDIN=text
 * (for every step), @keep=<path under the config dir, or ~/path under HOME>
 * (the file is compared after the last step, with its mode),
 * @mockcred=<mode>[:atproto] (HPY_CREDENTIAL signed in to $MOCK/reg-<mode>
 * with the default scope, or only `atproto`), @plugin=<fixture> (copies
 * test/fixtures/plugin/<fixture> to $HOME/p), @project=<fixture> (copies
 * test/fixtures/hvproject/<fixture> to $HOME/proj), @netbin[=<mode>] (see `netbin`), and
 * ENV=VALUE ($HOME in VALUE is the case's HOME).
 */
async function run(cmd, line, mock) {
  const [pre, argvText] = line.startsWith("-- ") ? ["", line.slice(3)] : line.split(" -- ");
  const tags = pre.split(" ").filter(Boolean);
  const sub = (t) => (mock ? t.replaceAll("$MOCK", mock.url) : t);
  const steps = argvText.split(" ;; ").map((s) => s.split(" ").filter(Boolean).map(sub));
  const home = mkdtempSync(join(tmpdir(), "hpy-parity-"));
  const config = join(home, ".config");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    HPY_NO_UPDATE_CHECK: "1",
    HPY_CREDENTIAL_STORE: "file",
  };
  let input = "";
  const keep = [];
  let net;
  for (const t of tags) {
    if (t === "@cred") env.HPY_CREDENTIAL = readFileSync(join(fixtures, "HPY_CREDENTIAL"), "utf8");
    else if (t === "@file") {
      mkdirSync(join(config, "hpy"), { recursive: true });
      copyFileSync(join(fixtures, "credentials.file.json"), join(config, "hpy/credentials.json"));
    } else if (t === "@net" || t === "@mock") {
    } else if (t.startsWith("@keep=")) keep.push(t.slice(6));
    else if (t.startsWith("@mockcred=")) {
      const [mode, scopes] = t.slice(10).split(":");
      env.HPY_CREDENTIAL = mockCredential(mock.url, mode, scopes ?? DEFAULT_SCOPE);
    } else if (t.startsWith("@plugin="))
      cpSync(join(plugins, t.slice(8)), join(home, "p"), { recursive: true });
    else if (t.startsWith("@project="))
      cpSync(join(projects, t.slice(9)), join(home, "proj"), { recursive: true });
    else if (t === "@netbin" || t.startsWith("@netbin=")) net = t.slice(8) || "ready";
    else if (t.startsWith("STDIN=")) input = sub(t.slice(6)).replaceAll("\\n", "\n");
    else if (t.includes("=")) {
      const [k, ...v] = t.split("=");
      // `$HOME` in a value is the case's HOME, for variables that must name an absolute path.
      env[k] = sub(v.join("=")).replaceAll("$HOME", home);
    }
  }
  const netState = net ? netbin(home, env, net) : undefined;
  if (mock) {
    mock.requests.length = 0;
    mock.reset?.();
  }
  let code = null;
  let stdout = "";
  let stderr = "";
  for (const [i, argv] of steps.entries()) {
    const r = await spawnStep(cmd, argv, env, home, input);
    const mark = steps.length > 1 ? `[step ${i + 1}: exit ${r.code}]\n` : "";
    code = r.code;
    stdout += mark + r.stdout;
    stderr += mark + r.stderr;
  }
  const files = keep
    .map((k) => {
      const p = k.startsWith("~/") ? join(home, k.slice(2)) : join(config, k);
      if (!existsSync(p)) return `${k}: absent\n`;
      const mode = (statSync(p).mode & 0o777).toString(8);
      return `${k} (${mode}):\n${readFileSync(p, "utf8")}\n`;
    })
    .join("");
  const netFiles = netState ? netState.files() : "";
  const requests = mock ? mock.requests.map(describeRequest).join("\n") : "";
  rmSync(home, { recursive: true, force: true });
  // macOS prints the temporary HOME through /private, which `home` is not; its random name is
  // blanked so a message that wraps inside the path still compares.
  const clean = (t) =>
    t
      .replaceAll(home, "$HOME")
      .replaceAll(basename(home), "hpy-parity-XXXXXX")
      // …even where a report wrapped the name across its gutter.
      .replace(/hpy-parity-(\n {2}│ )?[A-Za-z0-9]{6}/g, "hpy-parity-$1XXXXXX")
      .replaceAll(mock?.url ?? "\0", "$MOCK")
      // The network's name and subnet derive from the project's path, which HOME is in.
      .replaceAll(netState?.hash ?? "\0", "HASH")
      .replaceAll(netState?.subnet ?? "\0", "$SUBNET");
  return {
    code,
    stdout: clean(stdout),
    stderr: clean(stderr),
    files: clean(files + netFiles),
    requests: clean(requests),
  };
}

const mock = cases.some((l) => l.includes("@mock")) ? await startMock() : undefined;

let failed = 0;
let stderrOnly = 0;
for (const line of cases) {
  if (filter && !line.includes(filter)) continue;
  if (offline && line.includes("@net")) continue;
  const m = line.includes("@mock") ? mock : undefined;
  const a = await run([rust], line, m);
  const b = await run(tsCmd, line, m);
  const same =
    a.code === b.code && a.stdout === b.stdout && a.files === b.files && a.requests === b.requests;
  const errSame = a.stderr === b.stderr;
  if (same && errSame) {
    console.log(`ok      ${line}`);
    if (show) console.log(`        exit ${a.code}\n${a.stdout}${a.stderr}`);
    continue;
  }
  if (same) {
    stderrOnly++;
    console.log(`stderr  ${line}`);
  } else {
    failed++;
    console.log(`FAIL    ${line}`);
    if (a.code !== b.code) console.log(`        exit: rust ${a.code}, ts ${b.code}`);
    if (a.stdout !== b.stdout)
      console.log(`        stdout:\n--- rust\n${a.stdout}--- ts\n${b.stdout}---`);
    if (a.files !== b.files)
      console.log(`        files:\n--- rust\n${a.files}--- ts\n${b.files}---`);
    if (a.requests !== b.requests)
      console.log(`        requests:\n--- rust\n${a.requests}\n--- ts\n${b.requests}\n---`);
  }
  if (!errSame) console.log(`        stderr:\n--- rust\n${a.stderr}--- ts\n${b.stderr}---`);
}
console.log(`\n${cases.length} cases: ${failed} failing, ${stderrOnly} differing only on stderr`);
await mock?.stop();
process.exit(failed > 0 || (strictStderr && stderrOnly > 0) ? 1 : 0);
