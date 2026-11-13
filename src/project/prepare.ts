// crates/hpy/src/project/prepare.rs: everything `dev`, `check` and `test` do before the binary
// starts: find the project, bring the lock up to date, and put the pinned binary and the locked
// plugins where they are expected. Every function throws a `Failure`.
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { toIoError } from "../core/io.ts";
import { ensureBinary, HOST_TARGET, httpClient, ReleaseSource } from "./binary.ts";
import { cacheRoot } from "./cache.ts";
import { CONFIG_FILE, findRoot, ProjectToml } from "./config.ts";
import { Lockfile } from "./lock.ts";
import { type PlaceMode, type Placement, placePlugins } from "./place.ts";
import { ensurePlugin } from "./plugins.ts";
import { type Choose, type Resolver, resolveLock } from "./resolve.ts";

/**
 * Variables removed from the binary's environment. HappyView reads a real `PLUGIN_DIR` before
 * its own default, so an inherited one would load something other than the plugins just
 * placed.
 */
export const REMOVED_ENV: readonly string[] = ["PLUGIN_DIR"];

export interface PrepareOptions {
  /** Refuse to rewrite a lock that no longer matches, as CI should. */
  locked: boolean;
  place: PlaceMode;
  target: string;
}

export const PrepareOptions = {
  native(locked: boolean): PrepareOptions {
    return { locked, place: "link", target: HOST_TARGET };
  },
} as const;

export interface Prepared {
  root: string;
  binary: string;
}

/** The flag `create` and `add` take to decide among several projects. */
export const PROJECT_FLAG = "--project <AT-URI>";

/**
 * Asks which of several projects answering one key to use; without a terminal, the error
 * names `--project` as what decides.
 */
export function chooseWithPrompter(ctx: Ctx): Choose {
  return (key, found) =>
    ctx.prompter.choose(
      PROJECT_FLAG,
      `Several projects answer to \`${key}\`.`,
      found.map((c) => c.label()),
    );
}

/** The directory holding `happyview.toml`, found from the working directory upwards. */
export function projectRoot(ctx: Ctx): string {
  const root = findRoot(ctx.dir);
  if (root === undefined) {
    throw Failure.usage(
      `no ${CONFIG_FILE} in ${ctx.dir} or any directory above it; start one with \`hpy happyview create\``,
    );
  }
  return root;
}

/**
 * Why `--locked` cannot go on. Not always a mismatch: a lock from before hpy recorded plugin
 * capabilities has to be rewritten too, and telling a reader it does not match
 * `happyview.toml` would send them to a file that is fine.
 */
export function lockedRefusal(
  drift: readonly string[] | null | undefined,
  unrecorded: readonly string[],
): string {
  if (drift === null || drift === undefined) return "there is no happyview.lock";
  if (drift.length > 0) {
    return `happyview.lock does not match happyview.toml, and --locked forbids updating it:\n  ${drift.join("\n  ")}`;
  }
  return `happyview.lock records no capabilities for ${unrecorded.join(", ")}, and --locked forbids updating it. It was written by an hpy from before a deploy accepted them: run \`hpy happyview check\` once without --locked, then commit the rewritten happyview.lock`;
}

export async function prepare(ctx: Ctx, opts: PrepareOptions): Promise<Prepared> {
  return prepareAt(ctx, projectRoot(ctx), opts);
}

/** `prepare` for the project at `root`, which need not be where `hpy` runs. */
export async function prepareAt(ctx: Ctx, root: string, opts: PrepareOptions): Promise<Prepared> {
  try {
    return await prepareIn(ctx, root, opts);
  } catch (e) {
    throw Failure.from(e);
  }
}

async function prepareIn(ctx: Ctx, root: string, opts: PrepareOptions): Promise<Prepared> {
  if (process.env.PLUGIN_DIR !== undefined) {
    ctx.out.status("warning: ignoring PLUGIN_DIR; hpy runs the plugins locked in happyview.lock");
  }
  const config = ProjectToml.load(root);
  const version = config.happyviewVersion();
  const previous = Lockfile.load(root);
  const registry = ctx.registry();
  const drift = previous === null ? null : previous.drift(config);
  // A lock recording no capabilities for a plugin is rewritten as well, though it matches
  // happyview.toml: a deploy accepts the capabilities the lock records and cannot accept a set
  // that is not there. Re-resolving passes the previous lock, so the versions it pins do not
  // move.
  const unrecorded = previous === null ? [] : previous.unrecordedCapabilities();
  let lock: Lockfile;
  if (previous !== null && drift !== null && drift.length === 0 && unrecorded.length === 0) {
    lock = previous;
  } else {
    if (opts.locked) throw Failure.usage(lockedRefusal(drift, unrecorded));
    const r: Resolver = { registry, warn: (m) => ctx.out.status(`warning: ${m}`) };
    lock = await resolveLock(r, config, previous);
    try {
      lock.write(root);
    } catch (e) {
      throw Failure.runtime(toIoError(e).message);
    }
    ctx.out.status("updated happyview.lock");
  }
  const cache = cacheRoot();
  const env = (k: string) => {
    const v = process.env[k];
    return v === undefined || v === "" ? undefined : v;
  };
  const binary = await ensureBinary(
    httpClient(),
    ReleaseSource.fromEnv(env),
    cache,
    version,
    opts.target,
    (m) => ctx.out.status(m),
  );
  const placements: Placement[] = [];
  for (const p of lock.plugins) {
    placements.push({ id: p.id, source: await ensurePlugin(registry, cache, p) });
  }
  try {
    placePlugins(root, placements, opts.place);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  return { root, binary };
}
