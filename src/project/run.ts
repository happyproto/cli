// crates/hpy/src/project/run.rs: the HappyView binary in the foreground. Its output goes
// straight to this terminal, signals meant for `hpy` reach it, and its exit code becomes
// `hpy`'s.
//
// Rust's blocking threads are async here, and its `AtomicBool` stops are `AbortSignal`s.
import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join } from "node:path";
import { Failure } from "../core/failure.ts";
import { ioErrorText } from "../core/io.ts";
import { renderReport } from "../core/report.ts";
import { blockingStdio, flushStdio } from "../core/stdio.ts";
import {
  buildEach,
  buildModule,
  type ModuleSpec,
  type Snapshot,
  Toolchain,
  watch,
} from "./modules.ts";
import { REMOVED_ENV } from "./prepare.ts";

const UNIX = process.platform !== "win32";

type Execve = (file: string, args: string[], env: Record<string, string>) => never;

/**
 * The environment the binary gets: `hpy`'s, plus `envs`, less `removeEnv`. Windows names are
 * case-insensitive, as `Command::env_remove` and `env` treat them there, so `Plugin_Dir` is
 * removed or replaced along with `PLUGIN_DIR`.
 */
export function childEnv(
  envs: readonly (readonly [string, string])[],
  removeEnv: readonly string[],
  windows: boolean = !UNIX,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined) env[k] = v;
  const drop = (name: string) => {
    if (!windows) {
      delete env[name];
      return;
    }
    const upper = name.toUpperCase();
    for (const k of Object.keys(env)) if (k.toUpperCase() === upper) delete env[k];
  };
  for (const k of removeEnv) drop(k);
  for (const [k, v] of envs) {
    drop(k);
    env[k] = v;
  }
  return env;
}

function couldNotStart(program: string, e: unknown): Failure {
  return Failure.runtime(`could not start ${program}: ${ioErrorText(e)}`);
}

/**
 * Before Node 26.1 a failed `execve(2)` aborts the process instead of throwing, so the program
 * is checked first; see `precheck`.
 */
function execveThrows(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  return major > 26 || (major === 26 && minor >= 1);
}

/** `access(X_OK)` and a regular file: what exec refuses a missing or non-executable file for, with its errno. */
function runnable(path: string): void {
  accessSync(path, fsConstants.X_OK);
  if (!statSync(path).isFile()) {
    throw Object.assign(new Error("EACCES"), { code: "EACCES", errno: -13 });
  }
}

/** The first bytes of `path`, or `undefined` when it cannot be read (exec needs only X_OK). */
function head(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(512);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The Mach-O CPU type and the ELF machine of this host, the only binaries judged sure to exec. */
const MACHO_CPU = process.arch === "arm64" ? 0x0100000c : process.arch === "x64" ? 0x01000007 : -1;
const ELF_MACHINE = process.arch === "arm64" ? 183 : process.arch === "x64" ? 62 : -1;

/**
 * Whether `bytes` start an executable this host's kernel runs: a 64-bit little-endian ELF
 * executable or shared object for its machine on Linux, or a Mach-O executable (thin or fat)
 * with a slice for its CPU on macOS. Anything else might fail in exec with ENOEXEC (or
 * macOS's EBADARCH), which aborts Node before 26.1.
 */
function native(bytes: Buffer): boolean {
  if (process.platform === "linux") {
    return (
      bytes.length >= 64 &&
      bytes.readUInt32BE(0) === 0x7f454c46 &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes[6] === 1 &&
      [2, 3].includes(bytes.readUInt16LE(16)) &&
      bytes.readUInt16LE(18) === ELF_MACHINE
    );
  }
  if (process.platform === "darwin") {
    if (bytes.length >= 16 && bytes.readUInt32LE(0) === 0xfeedfacf)
      return bytes.readInt32LE(4) === MACHO_CPU && bytes.readUInt32LE(12) === 2;
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
      const n = bytes.readUInt32BE(4);
      for (let i = 0; i < n && 8 + 20 * (i + 1) <= bytes.length; i++)
        if (bytes.readInt32BE(8 + 20 * i) === MACHO_CPU) return true;
    }
  }
  return false;
}

/**
 * Checks `program` the way exec will, for a Node that aborts when exec fails. A missing or
 * non-executable program, or a `#!` naming a missing or non-executable interpreter, throws the
 * errno exec would give. Answers whether exec is sure to work: a native binary, or a script
 * whose interpreter is one. Anything else (a file it cannot read, another format, a script run
 * by a script) is run as a child instead, where a file that cannot start is an error, not an
 * abort.
 */
function precheck(program: string, cwd: string): boolean {
  runnable(program);
  const bytes = head(program);
  if (bytes === undefined) return false;
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return native(bytes);
  const line = bytes.subarray(2).toString("latin1").split("\n")[0]!;
  // As the kernel reads it: blanks before the path, which ends at a blank (a `\r` is part of it).
  const interpreter = line.replace(/^[ \t]+/, "").split(/[ \t]/)[0] ?? "";
  if (interpreter === "") return false;
  const path = isAbsolute(interpreter) ? interpreter : join(cwd, interpreter);
  runnable(path);
  const interpreterBytes = head(path);
  return interpreterBytes !== undefined && native(interpreterBytes);
}

/** `process.execve` without the experimental warning, which a failure would print. */
function execve(execveFn: Execve, program: string, args: string[], env: Record<string, string>) {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("process.execve")) return;
    (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    execveFn(program, args, env);
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * On unix this replaces `hpy` with the binary and returns only if that fails. The process then
 * *is* HappyView, so the kernel delivers every signal and reports the exit status exactly as it
 * would had HappyView been started by hand, and there is no parent left to die and orphan it.
 * Nothing `hpy` would have done after the child exits runs.
 *
 * Windows has no `exec` (nor has a runtime without `process.execve`), so `hpy` waits for the
 * child instead: the console sends Ctrl-C to every process attached to it, and `hpy` only has
 * to outlive the child to report its code.
 */
export async function runForeground(
  program: string,
  args: readonly string[],
  cwd: string,
  envs: readonly (readonly [string, string])[],
  removeEnv: readonly string[],
): Promise<number> {
  const execveFn = (process as unknown as { execve?: Execve }).execve;
  if (!UNIX || typeof execveFn !== "function") {
    return UNIX
      ? runSupervised(program, args, cwd, envs, removeEnv)
      : waitIgnoringCtrlC(program, args, cwd, envs, removeEnv);
  }
  const env = childEnv(envs, removeEnv);
  let sure: boolean;
  try {
    sure = execveThrows() || precheck(program, cwd);
  } catch (e) {
    throw couldNotStart(program, e);
  }
  if (!sure) return runSupervised(program, args, cwd, envs, removeEnv);
  await flushStdio();
  // exec hands HappyView our stdout and stderr; they must not stay non-blocking.
  blockingStdio();
  const here = process.cwd();
  try {
    process.chdir(cwd);
    execve(execveFn, program, [program, ...args], env);
  } catch (e) {
    try {
      process.chdir(here);
    } catch {
      // Only messages print paths from here on, and they are absolute or the user's own.
    }
    throw couldNotStart(program, e);
  }
  throw couldNotStart(program, new Error("exec returned"));
}

function spawnChild(
  program: string,
  args: readonly string[],
  cwd: string,
  envs: readonly (readonly [string, string])[],
  removeEnv: readonly string[],
) {
  blockingStdio();
  return spawn(program, [...args], {
    cwd,
    env: childEnv(envs, removeEnv),
    stdio: "inherit",
  });
}

/** The exit code, or 128 plus the signal that ended it, as a shell reports it. */
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null && UNIX) {
    const n = osConstants.signals[signal];
    if (typeof n === "number") return 128 + n;
  }
  return 1;
}

/** Windows' `run_foreground`: wait for the child, outliving any Ctrl-C. */
function waitIgnoringCtrlC(
  program: string,
  args: readonly string[],
  cwd: string,
  envs: readonly (readonly [string, string])[],
  removeEnv: readonly string[],
): Promise<number> {
  return supervise(program, args, cwd, envs, removeEnv, []);
}

/**
 * Runs the binary as a child that `hpy` waits for, for a run where `hpy` has work of its own
 * to do while the binary runs and so cannot `exec`. It stays in `hpy`'s process group, so a
 * terminal's Ctrl-C and Ctrl-\ reach it directly and are not passed on a second time; a
 * SIGTERM or SIGHUP is passed on once. A handler cannot tell a signal sent to `hpy` alone from
 * one sent to its whole group, so a SIGTERM or SIGHUP sent to the group, as a closing
 * terminal's hangup is, reaches the binary twice. The exit code is the child's, or 128 plus
 * the signal that ended it, as a shell reports it.
 *
 * Rust also has Linux kill the binary when `hpy` dies without unwinding (PR_SET_PDEATHSIG),
 * which Node cannot ask for; here an `exit` hook kills it, which covers every death but
 * SIGKILL and the other signals `hpy` does not handle, as on macOS in Rust.
 */
export function runSupervised(
  program: string,
  args: readonly string[],
  cwd: string,
  envs: readonly (readonly [string, string])[],
  removeEnv: readonly string[],
): Promise<number> {
  if (!UNIX) return waitIgnoringCtrlC(program, args, cwd, envs, removeEnv);
  return supervise(program, args, cwd, envs, removeEnv, ["SIGTERM", "SIGHUP"]);
}

function supervise(
  program: string,
  args: readonly string[],
  cwd: string,
  envs: readonly (readonly [string, string])[],
  removeEnv: readonly string[],
  forwarded: readonly NodeJS.Signals[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Installed before the child exists, so no signal can arrive while `hpy` still has the
    // default action of dying and leaving the child behind.
    const handlers: [NodeJS.Signals, () => void][] = [];
    let forward: (sig: NodeJS.Signals) => void = () => {};
    const ignored: NodeJS.Signals[] = UNIX ? ["SIGINT", "SIGQUIT"] : ["SIGINT"];
    for (const sig of forwarded) handlers.push([sig, () => forward(sig)]);
    for (const sig of ignored) handlers.push([sig, () => {}]);
    for (const [sig, h] of handlers) process.on(sig, h);
    const done = () => {
      for (const [sig, h] of handlers) process.off(sig, h);
      process.off("exit", killChild);
    };
    let child: ReturnType<typeof spawnChild>;
    let running = false;
    const killChild = () => {
      if (running) child.kill("SIGKILL");
    };
    try {
      child = spawnChild(program, args, cwd, envs, removeEnv);
    } catch (e) {
      done();
      reject(couldNotStart(program, e));
      return;
    }
    child.once("error", (e) => {
      if (running) return;
      done();
      reject(couldNotStart(program, e));
    });
    child.once("spawn", () => {
      running = true;
      forward = (sig) => {
        if (running) child.kill(sig);
      };
      process.on("exit", killChild);
    });
    child.once("exit", (code, signal) => {
      running = false;
      done();
      resolve(exitCode(code, signal));
    });
  });
}

/**
 * Runs the binary while rebuilding each module in `from` whenever its source changes, and
 * answers the binary's exit code. Without modules there is nothing to watch, and the binary
 * replaces `hpy` as `runForeground` does.
 */
export async function runRebuildingModules(
  binary: string,
  args: readonly string[],
  root: string,
  from: Snapshot,
): Promise<number> {
  const watcher = ModuleWatcher.spawn(root, from);
  if (watcher === undefined) return runForeground(binary, args, root, [], REMOVED_ENV);
  try {
    return await runSupervised(binary, args, root, [], REMOVED_ENV);
  } finally {
    await watcher.stop();
  }
}

/** Rebuilds a project's modules as their sources change from a snapshot, until stopped. */
export class ModuleWatcher {
  readonly #stop: AbortController;
  readonly #task: Promise<void>;

  private constructor(stop: AbortController, task: Promise<void>) {
    this.#stop = stop;
    this.#task = task;
  }

  /** `undefined` when there are no modules to watch. */
  static spawn(root: string, from: Snapshot): ModuleWatcher | undefined {
    if (from.modules().length === 0) return undefined;
    const stop = new AbortController();
    const task = watch(Toolchain.fromEnv(), root, from, 300, stop.signal, (module, result) => {
      if (typeof result === "string") process.stderr.write(`rebuilt module '${module.name}'\n`);
      else
        process.stderr.write(
          `${renderReport(result.message)}\nmodule '${module.name}' failed to build; the previous build keeps serving\n`,
        );
    }).catch(() => {});
    return new ModuleWatcher(stop, task);
  }

  /** Ends the watch, stopping a rebuild under way rather than waiting it out. */
  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#task;
  }
}

/**
 * Builds every module in `specs` once, reporting each failure without stopping: HappyView
 * names a module that has no build, and a watcher retries it on the next save.
 */
export async function firstBuild(root: string, specs: readonly ModuleSpec[]): Promise<void> {
  const toolchain = Toolchain.fromEnv();
  for (const module of specs) {
    try {
      await buildModule(toolchain, root, module);
    } catch (e) {
      process.stderr.write(`${renderReport(Failure.from(e).message)}\n`);
    }
  }
}

/**
 * As `firstBuild`, for a caller that handles Ctrl-C itself: aborting `stop` ends the module
 * being built at once and starts no other. (Unix-only in Rust.)
 */
export async function firstBuildUntil(
  root: string,
  specs: readonly ModuleSpec[],
  stop: AbortSignal,
): Promise<void> {
  await buildEach(Toolchain.fromEnv(), root, specs, stop, (_, result) => {
    if (typeof result !== "string") process.stderr.write(`${renderReport(result.message)}\n`);
  });
}

/** A code of 0 is success; any other is `hpy`'s exit code, or 1 past what one can hold. */
export function finish(code: number): void {
  if (code === 0) return;
  throw Failure.exit(Number.isInteger(code) && code > 0 && code <= 255 ? code : 1);
}
