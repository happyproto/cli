// crates/hpy/src/project/network/runner.rs: external commands (`deno`, `docker`) behind an
// interface, so the sandbox driver is testable without either installed.
//
// Every child runs in a process group of its own with no stdin, so a terminal's Ctrl-C reaches
// `hpy` alone. Atmosphere in a Box installs no signal handler: a `deno` stopped mid-operation
// leaves `state/cli.lock` behind, which refuses every later command until someone removes it.
// `hpy` decides when each child is done instead.
//
// Node has no `process_group(0)`: `detached: true` calls setsid(2), which makes the child the
// leader of a new session and so of a new process group. The child also loses the controlling
// terminal, which none of these commands reads (stdin is /dev/null either way).
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { constants } from "node:os";
import { Failure } from "../../core/failure.ts";
import { ioErrorText } from "../../core/io.ts";
import { rustJoin } from "../../core/paths.ts";
import { blockingStdio } from "../../core/stdio.ts";

/** How a shown child ended. */
export interface Exit {
  /** The exit code, or 128 plus the signal number for a child a signal ended, as a shell reports it. */
  code: number;
  /** The signal that ended the child, if one did; a child may exit above 128 of its own accord. */
  signal: number | undefined;
}

export const Exit = {
  code(code: number): Exit {
    return { code, signal: undefined };
  },

  /** A failure naming the command for anything but a clean exit. */
  check(exit: Exit, program: string, args: readonly string[]): void {
    const command = `\`${program} ${args.join(" ")}\``;
    if (exit.code === 0) return;
    if (exit.signal !== undefined)
      throw Failure.runtime(`${command} was ended by signal ${exit.signal}`);
    throw Failure.runtime(`${command} exited with ${exit.code}`);
  },
} as const;

export type Env = readonly (readonly [string, string])[];

export interface Runner {
  /**
   * Runs to completion with its output on this terminal; answers the exit code. Aborting
   * `cancel` kills the child (tokio's `kill_on_drop` when the future is dropped) and leaves
   * the promise pending.
   */
  show(program: string, args: readonly string[], cwd: string, cancel?: AbortSignal): Promise<Exit>;
  /** As `show`, with `env` added to the child's environment. */
  showWithEnv(program: string, args: readonly string[], env: Env, cwd: string): Promise<Exit>;
  /** As `show`, with the child's stdout sent to this process's stderr. */
  showOnStderr(program: string, args: readonly string[], cwd: string): Promise<Exit>;
  /** Runs to completion and answers its stdout; a non-zero exit is a failure carrying its stderr. */
  capture(program: string, args: readonly string[], cwd: string): Promise<string>;
}

function notInstalled(program: string): Failure {
  return Failure.usage(`\`${program}\` is not installed or not on PATH`);
}

function spawnFailure(program: string, e: unknown): Failure {
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return notInstalled(program);
  return Failure.runtime(`could not run \`${program}\`: ${ioErrorText(e)}`);
}

/** `String::from_utf8_lossy`. */
const lossy = (b: Buffer): string => new TextDecoder("utf-8", { fatal: false }).decode(b);

function exitFrom(code: number | null, signal: NodeJS.Signals | null): Exit {
  if (code !== null) return Exit.code(code);
  if (signal !== null) {
    const n = constants.signals[signal];
    if (n !== undefined) return { code: 128 + n, signal: n };
  }
  return Exit.code(1);
}

export class SystemRunner implements Runner {
  /** Sends every `show` child's stdout to stderr, for a run whose stdout is one JSON document. */
  readonly stdoutToStderr: boolean;

  constructor(opts: { stdoutToStderr?: boolean } = {}) {
    this.stdoutToStderr = opts.stdoutToStderr ?? false;
  }

  show(program: string, args: readonly string[], cwd: string, cancel?: AbortSignal): Promise<Exit> {
    return spawnAndWait(program, args, [], cwd, this.stdoutToStderr, cancel);
  }

  showWithEnv(program: string, args: readonly string[], env: Env, cwd: string): Promise<Exit> {
    return spawnAndWait(program, args, env, cwd, this.stdoutToStderr);
  }

  showOnStderr(program: string, args: readonly string[], cwd: string): Promise<Exit> {
    return spawnAndWait(program, args, [], cwd, true);
  }

  capture(program: string, args: readonly string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = detached(program, args, cwd, process.env, ["ignore", "pipe", "pipe"]);
      } catch (e) {
        reject(spawnFailure(program, e));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on("data", (d: Buffer) => out.push(d));
      child.stderr?.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e) => reject(spawnFailure(program, e)));
      child.on("close", (code, signal) => {
        if (code !== 0 || signal !== null) {
          reject(
            Failure.runtime(
              `\`${program} ${args.join(" ")}\` failed: ${lossy(Buffer.concat(err)).trim()}`,
            ),
          );
          return;
        }
        resolve(lossy(Buffer.concat(out)));
      });
    });
  }
}

/** A command in its own process group, reading nothing: a background group's read from the terminal would stop it with SIGTTIN. */
function detached(
  program: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdio: ("ignore" | "pipe" | "inherit" | number)[],
): ChildProcess {
  return spawn(program, args, { cwd, env, stdio, detached: true });
}

// Not `runForeground`: that replaces this process on unix, and the caller has more to do once
// the child is done.
function spawnAndWait(
  program: string,
  args: readonly string[],
  env: Env,
  cwd: string,
  stdoutToStderr: boolean,
  cancel?: AbortSignal,
): Promise<Exit> {
  if (which(program) === undefined) return Promise.reject(notInstalled(program));
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of env) childEnv[k] = v;
    let child: ChildProcess;
    try {
      blockingStdio();
      child = detached(program, args, cwd, childEnv, [
        "ignore",
        stdoutToStderr ? 2 : "inherit",
        "inherit",
      ]);
    } catch (e) {
      reject(spawnFailure(program, e));
      return;
    }
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    cancel?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      cancel?.removeEventListener("abort", onAbort);
      if (!cancelled) reject(spawnFailure(program, e));
    });
    child.on("exit", (code, signal) => {
      cancel?.removeEventListener("abort", onAbort);
      if (!cancelled) resolve(exitFrom(code, signal));
    });
  });
}

/** `program` on PATH, so a missing tool is a usage error naming it rather than a spawn error. */
function which(program: string): string | undefined {
  const paths = process.env.PATH;
  if (paths === undefined) return undefined;
  for (const dir of paths.split(":")) {
    const candidate = rustJoin(dir, program);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

export async function mustWithEnv(
  r: Runner,
  program: string,
  args: readonly string[],
  env: Env,
  cwd: string,
): Promise<void> {
  Exit.check(await r.showWithEnv(program, args, env, cwd), program, args);
}
