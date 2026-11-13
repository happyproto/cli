// crates/hpy/src/project/modules.rs: a project's compiled script modules: which there are and
// whether the toolchain can build them. HappyView never runs a compiler; it reads what `hpy`
// writes to `.happyview/build/<module>.wasm`.
//
// Rust runs builds on blocking threads and stops them with an `AtomicBool`; here they are
// async, and `stop` is an `AbortSignal`.
import { type ChildProcess, spawn } from "node:child_process";
import {
  type BigIntStats,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, parse as parsePath, sep } from "node:path";
import { Failure } from "../core/failure.ts";
import { readToString, toIoError } from "../core/io.ts";
import { rustJoin } from "../core/paths.ts";
import { renderReport } from "../core/report.ts";
import {
  array,
  fromStr as jsonFromStr,
  map,
  optional,
  str,
  struct,
  withDefault,
} from "../core/serde-json.ts";
import {
  parseTable,
  TomlError,
  type TomlTable,
  type TomlValue,
  fromStr as tomlFromStr,
  get as tomlGet,
} from "../core/toml.ts";

const UNIX = process.platform !== "win32";

export const TARGET = "wasm32-wasip1";
export const BUILD_DIR = ".happyview/build";

export interface ModuleSpec {
  name: string;
  language: string;
  path: string;
}

/**
 * Only what a build needs. HappyView validates the whole file; reading anything else here
 * would be a second, drifting copy of its rules.
 */
const PROJECT_FILE = struct("ProjectFile", {
  modules: withDefault(
    map(struct("ModuleEntry", { language: str, path: str })),
    () => new Map<string, { language: string; path: string }>(),
  ),
});

/** HappyView refuses the same paths, so a project one accepts the other does. */
function isContainedPath(raw: string): boolean {
  if (raw.trim() === "") return false;
  if (UNIX) return !raw.startsWith("/") && !raw.split("/").includes("..");
  const prefix = /^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw);
  const hasRoot = raw.startsWith("/") || raw.startsWith("\\") || prefix;
  return !hasRoot && !prefix && !raw.split(/[\\/]/).includes("..");
}

/**
 * The name becomes `.happyview/build/<name>.wasm`, so it is limited to what cannot leave that
 * directory. HappyView applies the same rule.
 */
function isValidModuleName(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(name);
}

/** `Path::canonicalize`: throws the error. */
function canonicalize(path: string): string {
  return realpathSync.native(path);
}

/** `Path::starts_with`, for paths without `.` segments or doubled separators. */
function startsWithPath(path: string, base: string): boolean {
  if (path === base) return true;
  return path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Whether `raw` still names somewhere inside `project` once symlinks are followed. A path that
 * does not exist yet has nothing to follow, and is left to the build to report as missing.
 */
function resolvesInside(project: string, raw: string): boolean {
  let dir: string;
  try {
    dir = canonicalize(rustJoin(project, raw));
  } catch {
    return true;
  }
  let root: string;
  try {
    root = canonicalize(project);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  return startsWithPath(dir, root);
}

export function readModules(project: string): ModuleSpec[] {
  const file = rustJoin(project, "happyview.toml");
  let text: string;
  try {
    text = readToString(file);
  } catch (e) {
    if (toIoError(e).code === "ENOENT")
      throw Failure.usage(`${file} not found; run this in a HappyView project`);
    throw Failure.runtime(toIoError(e).message);
  }
  let parsed: { modules: Map<string, { language: string; path: string }> };
  try {
    parsed = tomlFromStr(text, PROJECT_FILE);
  } catch (e) {
    if (e instanceof TomlError) throw Failure.usage(`${file}: ${e.message}`);
    throw e;
  }
  const out: ModuleSpec[] = [];
  for (const [name, entry] of parsed.modules) {
    if (!isValidModuleName(name))
      throw Failure.usage(
        `module '${name}' must be lowercase letters, digits, '-' or '_', starting with a letter`,
      );
    if (!isContainedPath(entry.path) || !resolvesInside(project, entry.path))
      throw Failure.usage(
        `module '${name}': module path '${entry.path}' must be relative to the project root and stay inside it`,
      );
    out.push({ name, language: entry.language, path: entry.path });
  }
  return out;
}

/** The two programs a Rust module build runs. */
export interface Toolchain {
  cargo: string;
  rustup: string;
}

export const Toolchain = {
  /**
   * `HPY_CARGO` and `HPY_RUSTUP` replace the two programs, for a toolchain installed under
   * another name and for tests. Unlike most variables, an empty one still counts.
   */
  fromEnv(): Toolchain {
    return {
      cargo: process.env.HPY_CARGO ?? "cargo",
      rustup: process.env.HPY_RUSTUP ?? "rustup",
    };
  },
};

interface Exit {
  code: number | null;
  stdout: Buffer;
}

/** `Command::status` / `Command::output`: rejects with the spawn error, like Rust's `Err(e)`. */
function run(
  program: string,
  args: readonly string[],
  cwd: string,
  capture: boolean,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    if (program === "") {
      reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", errno: -2 }));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd,
        stdio: ["inherit", capture ? "pipe" : "ignore", "ignore"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(chunks) }));
  });
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export async function checkToolchain(
  tc: Toolchain,
  project: string,
  module: ModuleSpec,
): Promise<void> {
  if (module.language !== "rust")
    throw Failure.usage(
      `module '${module.name}': hpy builds only rust modules, not '${module.language}'`,
    );
  const dir = rustJoin(project, module.path);
  if (!isFile(rustJoin(dir, "Cargo.toml")))
    throw Failure.usage(`module '${module.name}': no Cargo.toml in ${module.path}`);
  // Probed from the module's directory so a pinned toolchain is the one that answers.
  let probe: Exit;
  try {
    probe = await run(tc.cargo, ["--version"], dir, false);
  } catch (e) {
    if (errCode(e) === "ENOENT")
      throw Failure.usage("cargo was not found; install Rust from https://rustup.rs");
    throw Failure.runtime(toIoError(e).message);
  }
  if (probe.code !== 0)
    throw Failure.usage(
      `cargo does not run for module '${module.name}'; install Rust from https://rustup.rs`,
    );
  // rustup answers for the module's own rust-toolchain.toml only when asked from inside it.
  let listed: Exit;
  try {
    listed = await run(tc.rustup, ["target", "list", "--installed"], dir, true);
  } catch (e) {
    // A toolchain without rustup is managed by hand; cargo's own error is the best there is.
    if (errCode(e) === "ENOENT") return;
    throw Failure.runtime(toIoError(e).message);
  }
  if (listed.code !== 0) return;
  const lines = new TextDecoder("utf-8", { ignoreBOM: true }).decode(listed.stdout).split("\n");
  if (lines.some((l) => l.trim() === TARGET)) return;
  throw Failure.usage(
    `module '${module.name}': the ${TARGET} target is not installed for its toolchain; install it with\n  ` +
      `(cd ${module.path} && rustup target add ${TARGET})`,
  );
}

export function buildModule(tc: Toolchain, project: string, module: ModuleSpec): Promise<string> {
  return buildModuleUnless(tc, project, module, undefined, false);
}

/**
 * As `buildModule`, but an aborted `stop` ends cargo at once rather than waiting out the build,
 * and nothing is installed. With `ownGroup`, cargo runs in a process group of its own, which a
 * terminal's Ctrl-C does not reach, and `stop` ends the whole group, since killing cargo alone
 * leaves its rustc children running.
 */
async function buildModuleUnless(
  tc: Toolchain,
  project: string,
  module: ModuleSpec,
  stop: AbortSignal | undefined,
  ownGroup: boolean,
): Promise<string> {
  await checkToolchain(tc, project, module);
  const dir = rustJoin(project, module.path);
  const manifest = rustJoin(dir, "Cargo.toml");
  requirePanicAbort(project, module);
  // Diagnostics render to stderr, which the developer sees as they would from cargo itself;
  // stdout carries the JSON that names the artifact.
  let child: ChildProcess;
  try {
    if (tc.cargo === "") throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    child = spawn(
      tc.cargo,
      [
        "build",
        "--release",
        "--target",
        TARGET,
        "--message-format=json-render-diagnostics",
        "--manifest-path",
        manifest,
      ],
      // Node has no `process_group(0)`; `detached` is setsid(2), a new session led by cargo,
      // whose process group a terminal's Ctrl-C does not reach either.
      { cwd: dir, stdio: ["ignore", "pipe", "inherit"], detached: ownGroup && UNIX },
    );
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  if (child.pid === undefined) {
    const e = await new Promise<unknown>((resolve) => child.once("error", resolve));
    throw Failure.runtime(toIoError(e).message);
  }
  const chunks: Buffer[] = [];
  child.stdout!.on("data", (c: Buffer) => chunks.push(c));
  let exited = false;
  const exit = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    }),
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const outcome = await new Promise<"done" | "stop">((resolve) => {
    closed.then(() => resolve("done"));
    if (stop === undefined) return;
    const onAbort = () => {
      if (!exited) resolve("stop");
    };
    if (stop.aborted) onAbort();
    else stop.addEventListener("abort", onAbort, { once: true });
    closed.then(() => stop.removeEventListener("abort", onAbort));
  });
  if (outcome === "stop") {
    if (ownGroup && UNIX) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    child.kill("SIGKILL");
    child.stdout!.destroy();
    await exit;
    throw Failure.runtime(`the build of module '${module.name}' was stopped`);
  }
  const code = await exit;
  if (code !== 0) throw Failure.runtime(`module '${module.name}' failed to build`);
  const built = findArtifact(Buffer.concat(chunks), manifest);
  if (built === undefined)
    throw Failure.usage(
      `module '${module.name}' built no wasm library; set crate-type = ["cdylib"] under [lib] in ${rustJoin(module.path, "Cargo.toml")}`,
    );
  return installArtifact(project, module.name, built);
}

const asStr = (v: TomlValue | undefined) => (v?.type === "string" ? v.value : undefined);

/**
 * A module that unwinds can carry exception-handling tags HappyView refuses at load, so it is
 * refused here, where the fix is a line in a manifest.
 */
function requirePanicAbort(project: string, module: ModuleSpec): void {
  const manifest = profileManifest(rustJoin(project, module.path));
  const parsed = readManifest(manifest);
  const release = tomlGet(tomlGet(parsed, "profile"), "release");
  if (asStr(tomlGet(release, "panic")) === "abort") return;
  let root: string;
  try {
    root = canonicalize(project);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  const shown = stripPrefix(manifest, root) ?? manifest;
  const fix =
    release !== undefined
      ? `set \`panic = "abort"\` under the existing \`[profile.release]\` in ${shown}`
      : `add to ${shown}:\n  [profile.release]\n  panic = "abort"`;
  throw Failure.usage(
    `module '${module.name}' must build with panic = "abort", since HappyView refuses a module that unwinds; ${fix}`,
  );
}

/** `Path::strip_prefix`. */
function stripPrefix(path: string, base: string): string | undefined {
  if (path === base) return "";
  const b = base.endsWith(sep) ? base : base + sep;
  return path.startsWith(b) ? path.slice(b.length) : undefined;
}

function readManifest(path: string): TomlTable {
  let text: string;
  try {
    text = readToString(path);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  try {
    return parseTable(text);
  } catch (e) {
    if (e instanceof TomlError) throw Failure.usage(`${path}: ${e.message}`);
    throw e;
  }
}

/** `Path::is_file`: follows links. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The manifest whose `[profile]` cargo applies when building the crate in `dir`: a workspace
 * member's own profile is ignored in favour of the workspace root's.
 */
function profileManifest(raw: string): string {
  let dir: string;
  try {
    dir = canonicalize(raw);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  const own = rustJoin(dir, "Cargo.toml");
  const manifest = readManifest(own);
  if (manifest.has("workspace")) return own;
  const root = asStr(tomlGet(tomlGet(manifest, "package"), "workspace"));
  if (root !== undefined) return rustJoin(normalize(rustJoin(dir, root)), "Cargo.toml");
  // Cargo keeps looking above a workspace that excludes the crate, unless the crate is also
  // one of its members.
  for (const ancestor of ancestors(dir)) {
    const candidate = rustJoin(ancestor, "Cargo.toml");
    if (!isFile(candidate)) continue;
    const workspace = readManifest(candidate).get("workspace");
    if (workspace?.type !== "table") continue;
    const listed = (key: string): string[] => {
      const entries = workspace.value.get(key);
      if (entries?.type !== "array") return [];
      return entries.value
        .map(asStr)
        .filter((e): e is string => e !== undefined)
        .map((e) => normalize(rustJoin(ancestor, e)));
    };
    const excluded = listed("exclude").some((e) => startsWithPath(dir, e));
    // Cargo compares a member literally here, without expanding a glob.
    const member = listed("members").some((m) => startsWithPath(dir, m));
    if (excluded && !member) continue;
    return candidate;
  }
  return own;
}

/** `Path::ancestors().skip(1)`. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

/** `path` with `.` and `..` resolved lexically, without following symlinks. */
function normalize(path: string): string {
  const { root } = parsePath(path);
  const parts: string[] = [];
  for (const c of path.slice(root.length).split(UNIX ? "/" : /[\\/]/)) {
    if (c === "" || c === ".") continue;
    if (c === "..") parts.pop();
    else parts.push(c);
  }
  return root + parts.join(sep);
}

const CARGO_MESSAGE = struct("CargoMessage", {
  reason: str,
  manifest_path: withDefault(optional(str), undefined),
  target: withDefault(optional(struct("CargoTarget", { crate_types: array(str) })), undefined),
  filenames: withDefault(array(str), () => []),
});

/** `Path::extension`. */
function extension(path: string): string | undefined {
  const name = path.split(UNIX ? "/" : /[\\/]/).at(-1) ?? "";
  if (name === "..") return undefined;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : undefined;
}

/**
 * The `.wasm` cargo built for the module's own package; a module in a workspace also builds
 * its siblings, which are not it.
 */
function findArtifact(stdout: Buffer, manifestPath: string): string | undefined {
  let manifest: string;
  try {
    manifest = canonicalize(manifestPath);
  } catch {
    return undefined;
  }
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let start = 0;
  while (start <= stdout.length) {
    let end = stdout.indexOf(0x0a, start);
    if (end === -1) end = stdout.length;
    const line = stdout.subarray(start, end);
    start = end + 1;
    let m: ReturnType<typeof CARGO_MESSAGE>;
    try {
      m = jsonFromStr(utf8.decode(line), CARGO_MESSAGE);
    } catch {
      continue;
    }
    if (m.reason !== "compiler-artifact") continue;
    let own: string | undefined;
    try {
      own = m.manifest_path !== undefined ? canonicalize(m.manifest_path) : undefined;
    } catch {
      own = undefined;
    }
    if (own !== manifest) continue;
    if (!m.target?.crate_types.includes("cdylib")) continue;
    const wasm = m.filenames.find((f) => extension(f) === "wasm");
    if (wasm !== undefined) return wasm;
  }
  return undefined;
}

/**
 * Copy `built` into place by staging it beside the destination and renaming over it.
 * HappyView's dev watcher rebuilds on any name ending `.wasm`, so the staging name must not end
 * that way, and a rename within one directory is atomic; until it happens the previous build
 * keeps serving.
 */
export function installArtifact(project: string, name: string, built: string): string {
  const dir = rustJoin(project, BUILD_DIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  const dest = rustJoin(dir, `${name}.wasm`);
  const staging = rustJoin(dir, `.${name}.wasm.partial`);
  try {
    copyFileSync(built, staging);
    renameSync(staging, dest);
  } catch (e) {
    try {
      unlinkSync(staging);
    } catch {}
    throw Failure.runtime(toIoError(e).message);
  }
  return dest;
}

/**
 * Build every module, carrying on past a failure so one run reports all of them, each printed
 * to stderr as `main` prints a failure. The error keeps the first failure's exit code, so a
 * missing target stays a usage error. Answers `[name, path]` for each module built.
 */
export async function buildAll(tc: Toolchain, project: string): Promise<[string, string][]> {
  const built: [string, string][] = [];
  const failed: string[] = [];
  let code: number | undefined;
  for (const module of readModules(project)) {
    try {
      built.push([module.name, await buildModule(tc, project, module)]);
    } catch (e) {
      const f = Failure.from(e);
      process.stderr.write(`${renderReport(f.message)}\n`);
      code ??= f.code;
      failed.push(module.name);
    }
  }
  if (code === undefined) return built;
  throw new Failure(code, `${failed.length} module(s) failed to build: ${failed.join(", ")}`);
}

/** Path to `[size, mtime in ns]`. */
export type Fingerprint = Map<string, readonly [bigint, bigint]>;

/**
 * Every file under a module's crate that a build reads, with its size and modification time.
 * A module is tens of files, so polling this is cheaper than a platform watcher's dependency
 * and gives every platform the same behaviour. `target/` and dot-directories are build output
 * and tooling.
 */
export function fingerprint(dir: string): Fingerprint {
  const out: Fingerprint = new Map();
  const stack = [dir];
  while (stack.length > 0) {
    const next = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(next);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = rustJoin(next, name);
      let meta: BigIntStats;
      try {
        meta = lstatSync(path, { bigint: true });
      } catch {
        continue;
      }
      if (meta.isDirectory()) {
        if (name !== "target" && !name.startsWith(".")) stack.push(path);
      } else {
        out.set(path, [meta.size, meta.mtimeNs]);
      }
    }
  }
  return out;
}

/** `Fingerprint`'s `==`. */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  if (a.size !== b.size) return false;
  for (const [path, [size, mtime]] of a) {
    const other = b.get(path);
    if (other === undefined || other[0] !== size || other[1] !== mtime) return false;
  }
  return true;
}

/**
 * A project's modules with their sources as they stood when it was taken. A watch compares
 * against this rather than against whatever it finds when it first runs, so a save made after
 * `take` returns is rebuilt however late the watch starts. Taken before the first build, it
 * also catches a save made while that build runs.
 */
export class Snapshot {
  readonly #modules: ModuleSpec[];
  /** Read by `watch`. */
  readonly seen: Fingerprint[];

  private constructor(modules: ModuleSpec[], seen: Fingerprint[]) {
    this.#modules = modules;
    this.seen = seen;
  }

  static take(project: string, modules: ModuleSpec[]): Snapshot {
    return new Snapshot(
      modules,
      modules.map((m) => fingerprint(rustJoin(project, m.path))),
    );
  }

  modules(): readonly ModuleSpec[] {
    return this.#modules;
  }
}

/** What a build answers: the installed module's path, or why it failed. */
export type BuildResult = string | Failure;

async function settle(p: Promise<string>): Promise<BuildResult> {
  try {
    return await p;
  } catch (e) {
    return Failure.from(e);
  }
}

/**
 * Build each module in turn until `stop` is aborted. Aborting it ends the build under way,
 * cargo's whole process group with it, and starts no further module, so a caller that handles
 * Ctrl-C itself does not sit through the rest of the list. A build that `stop` cut short is
 * not reported. (Unix-only in Rust.)
 */
export async function buildEach(
  tc: Toolchain,
  project: string,
  modules: readonly ModuleSpec[],
  stop: AbortSignal,
  onBuild: (module: ModuleSpec, result: BuildResult) => void,
): Promise<void> {
  for (const module of modules) {
    if (stop.aborted) return;
    const result = await settle(buildModuleUnless(tc, project, module, stop, true));
    if (stop.aborted) return;
    onBuild(module, result);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll each module's crate every `intervalMs` and rebuild the ones that changed since `from`,
 * until `stop` is aborted. A build that fails leaves the previous module installed, so
 * HappyView keeps serving it. Edits made during a build are seen by the next poll. Aborting
 * `stop` ends a build under way, so whoever aborts it waits only for cargo to die, not for it
 * to finish.
 */
export async function watch(
  tc: Toolchain,
  project: string,
  from: Snapshot,
  intervalMs: number,
  stop: AbortSignal,
  onBuild: (module: ModuleSpec, result: BuildResult) => void,
): Promise<void> {
  const modules = from.modules();
  const seen = [...from.seen];
  while (!stop.aborted) {
    await sleep(intervalMs);
    for (const [i, module] of modules.entries()) {
      if (stop.aborted) return;
      const now = fingerprint(rustJoin(project, module.path));
      if (!sameFingerprint(now, seen[i]!)) {
        seen[i] = now;
        const result = await settle(buildModuleUnless(tc, project, module, stop, true));
        if (stop.aborted) return;
        onBuild(module, result);
      }
    }
  }
}
