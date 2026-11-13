// crates/hpy/src/project/run.rs, the parts `dev --network local` uses: the module watcher, the
// first build that a Ctrl-C can cut short, and `finish`. M4 ports the rest (run_foreground,
// run_supervised, run_rebuilding_modules, first_build) into this file.
import { Failure } from "../core/failure.ts";
import { renderReport } from "../core/report.ts";
import { buildEach, type ModuleSpec, type Snapshot, Toolchain, watch } from "./modules.ts";

/** Rebuilds a project's modules as their sources change from a snapshot, until stopped. */
export class ModuleWatcher {
  readonly #stop: AbortController;
  readonly #done: Promise<void>;

  private constructor(stop: AbortController, done: Promise<void>) {
    this.#stop = stop;
    this.#done = done;
  }

  /** `undefined` when there are no modules to watch. */
  static spawn(root: string, from: Snapshot): ModuleWatcher | undefined {
    if (from.modules().length === 0) return undefined;
    const stop = new AbortController();
    const done = watch(Toolchain.fromEnv(), root, from, 300, stop.signal, (module, result) => {
      if (typeof result === "string") process.stderr.write(`rebuilt module '${module.name}'\n`);
      else
        process.stderr.write(
          `${renderReport(result.message)}\nmodule '${module.name}' failed to build; the previous build keeps serving\n`,
        );
    }).catch(() => {});
    return new ModuleWatcher(stop, done);
  }

  /** Ends the watch, stopping a rebuild under way rather than waiting it out. */
  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#done;
  }
}

/**
 * As `first_build`, for a caller that handles Ctrl-C itself: aborting `stop` ends the module
 * being built at once and starts no other.
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

export function finish(code: number): void {
  if (code === 0) return;
  throw Failure.exit(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1);
}
