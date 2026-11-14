// crates/hpy/src/commands/happyview/add.rs: `hpy happyview add` (alias `install`). Adds
// plugins to `happyview.toml` and `happyview.lock` and downloads them; with none, brings the
// lock up to date and downloads it.
import type { Registry } from "../atproto/registry.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { readToString } from "../core/io.ts";
import type { Json } from "../core/output.ts";
import { rustJoin } from "../core/paths.ts";
import { TRACKS } from "../plugin/nsid.ts";
import { parseProjectUri, versionProblem } from "../plugin/validate.ts";
import { cacheRoot } from "../project/cache.ts";
import {
  CONFIG_FILE,
  entryProjectUri,
  type Pin,
  type PluginEntry,
  PluginKind,
  ProjectToml,
  pinLabel,
  setPlugin,
  writeIfChanged,
} from "../project/config.ts";
import { Lockfile } from "../project/lock.ts";
import { type Placement, placedMode, placePlugins } from "../project/place.ts";
import { ensurePlugin } from "../project/plugins.ts";
import { chooseWithPrompter, projectRoot } from "../project/prepare.ts";
import {
  type Candidate,
  type Choose,
  candidates,
  type Resolver,
  resolveLock,
} from "../project/resolve.ts";

export interface Addition {
  kind: PluginKind;
  key: string;
  /** What `happyview.toml` gets. */
  entry: PluginEntry;
  /** The version the entry resolves to today. */
  version: string;
}

/** `AddArgs`. */
export interface AddArgs {
  plugins: string[];
  interpreter: boolean;
  library: boolean;
  channel: string | undefined;
  version: string | undefined;
  project: string | undefined;
}

export function additionToJson(a: Addition): { [k: string]: Json } {
  const out: { [k: string]: Json } = {
    kind: PluginKind.pluginType(a.kind),
    key: a.key,
    project: entryProjectUri(a.entry),
    version: a.version,
  };
  if (a.entry.pin.kind === "channel") out.channel = a.entry.pin.channel;
  return out;
}

/**
 * The channel a new entry follows when none is named: `latest`, else the only one the project
 * has, so a plugin with nothing but prereleases can still be added.
 */
function defaultChannel(channels: readonly string[]): string | undefined {
  return TRACKS.find((t) => channels.includes(t));
}

/** The pin `--channel`/`--version` ask for. Throws `Failure`. */
export function requestedPin(
  channel: string | undefined,
  version: string | undefined,
): Pin | undefined {
  if (channel !== undefined && version !== undefined) {
    throw Failure.usage("--channel and --version both choose the version; pass one");
  }
  if (channel !== undefined) {
    if (!(TRACKS as readonly string[]).includes(channel)) {
      throw Failure.usage(`--channel: \`${channel}\` is not one of ${TRACKS.join(", ")}`);
    }
    return { kind: "channel", channel };
  }
  if (version !== undefined) {
    const p = versionProblem(version);
    if (p !== null) throw Failure.usage(`--version: ${p}`);
    return { kind: "version", version };
  }
  return undefined;
}

/** Rust's `?` on a registry call. */
async function reg<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    throw Failure.from(e);
  }
}

/**
 * Which project each spec means and how to pin it. A key the lock already records keeps the
 * lock's project unless `project` names another: searching by name again could land on a
 * second publisher's. Throws `Failure`.
 */
export async function planAdditions(
  registry: Registry,
  specs: readonly string[],
  kind: PluginKind | undefined,
  project: string | undefined,
  pin: Pin | undefined,
  previous: Lockfile | null | undefined,
  choose: Choose,
): Promise<Addition[]> {
  const kinds: PluginKind[] = kind !== undefined ? [kind] : ["interpreter", "library"];
  const found = new Map<PluginKind, Candidate[]>();
  const out: Addition[] = [];
  for (const key of specs) {
    const at = key.lastIndexOf("@");
    if (at >= 0) {
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      throw Failure.usage(
        `\`${key}\`: pass the version as --version ${version} (\`${name}\` follows a channel otherwise)`,
      );
    }
    const locked: [PluginKind, string][] = [];
    if (project === undefined && previous !== null && previous !== undefined) {
      for (const k of kinds) {
        const p = previous.findKey(k, key);
        if (p !== undefined) locked.push([k, p.project]);
      }
    }
    let foundKind: PluginKind;
    let uri: string;
    let channels: string[];
    if (locked.length === 1) {
      const [k, lockedUri] = locked[0]!;
      const parsed = parseProjectUri(lockedUri);
      if (parsed === null) {
        throw Failure.usage(`happyview.lock: \`${lockedUri}\` is not a project URI`);
      }
      const [did, name] = parsed;
      const view = await reg(() => registry.getProject(did, name));
      channels = view === null ? [] : [...view.channels.keys()];
      foundKind = k;
      uri = lockedUri;
    } else if (locked.length > 1) {
      throw Failure.usage(
        `happyview.lock has \`${key}\` as both an interpreter and a library; pass --interpreter or --library`,
      );
    } else {
      const [k, c] = await search(registry, found, kinds, kind, key, project, choose);
      foundKind = k;
      uri = c.project;
      channels = [c.channel];
    }
    const parsed = parseProjectUri(uri);
    if (parsed === null) throw Failure.usage(`\`${uri}\` is not a project URI`);
    const [did, name] = parsed;
    let chosen: Pin;
    if (pin !== undefined) {
      chosen = { ...pin };
    } else {
      const channel = defaultChannel(channels);
      if (channel === undefined) {
        throw Failure.usage(`${name} has no channel to follow; pass --version`);
      }
      chosen = { kind: "channel", channel };
    }
    let version: string;
    if (chosen.kind === "channel") {
      const c = chosen.channel;
      const view = await reg(() => registry.resolveChannel(did, name, c));
      if (view === null) throw Failure.usage(`${name} has no ${c} channel`);
      version = view.version;
    } else {
      const v = chosen.version;
      const view = await reg(() => registry.getVersion(did, name, v));
      if (view === null) throw Failure.usage(`the registry has no ${name} ${v}`);
      version = view.version;
    }
    out.push({ kind: foundKind, key, entry: { did, name, pin: chosen }, version });
  }
  return out;
}

/**
 * The kind and candidate the registry answers `key` with, asking `choose` when several
 * projects do and `project` names none of them.
 */
async function search(
  registry: Registry,
  found: Map<PluginKind, Candidate[]>,
  kinds: readonly PluginKind[],
  flag: PluginKind | undefined,
  key: string,
  project: string | undefined,
  choose: Choose,
): Promise<[PluginKind, Candidate]> {
  const answering: [PluginKind, Candidate[]][] = [];
  for (const k of kinds) {
    let list = found.get(k);
    if (list === undefined) {
      list = await candidates(registry, k);
      found.set(k, list);
    }
    const matches = list.filter((c) => c.answers(k, key));
    if (matches.length > 0) answering.push([k, matches]);
  }
  if (answering.length === 0) {
    const what = flag !== undefined ? PluginKind.pluginType(flag) : "interpreter or library";
    throw Failure.usage(`no ${what} in the registry answers to \`${key}\``);
  }
  if (answering.length > 1) {
    throw Failure.usage(
      `\`${key}\` names both an interpreter and a library; pass --interpreter or --library`,
    );
  }
  const [kind, matches] = answering[0]!;
  let chosen: Candidate;
  if (project !== undefined) {
    const c = matches.find((c) => c.project === project);
    if (c === undefined) throw Failure.usage(`${project} does not answer to \`${key}\``);
    chosen = c;
  } else if (matches.length === 1) {
    chosen = matches[0]!;
  } else {
    const i = await choose(key, matches);
    chosen = matches[i]!;
  }
  return [kind, chosen];
}

/** Throws `Problem`. */
export function applyAdditions(text: string, additions: readonly Addition[]): string {
  let out = text;
  for (const a of additions) out = setPlugin(out, a.kind, a.key, a.entry);
  return out;
}

function runtime<T>(body: () => T): T {
  try {
    return body();
  } catch (e) {
    throw Failure.runtime(e);
  }
}

function usage<T>(body: () => T): T {
  try {
    return body();
  } catch (e) {
    throw Failure.from(e);
  }
}

/**
 * Adds `args.plugins` to the project at `root`, rewrites its lock and downloads every locked
 * plugin into `cache`. Throws `Failure`.
 */
export async function addIn(
  root: string,
  registry: Registry,
  cache: string,
  args: AddArgs,
  choose: Choose,
  warn: (msg: string) => void,
): Promise<[Addition[], Lockfile]> {
  if (args.project !== undefined && parseProjectUri(args.project) === null) {
    throw Failure.usage(
      `--project: \`${args.project}\` is not an at://<did>/software.release.project/<name> URI`,
    );
  }
  const pin = requestedPin(args.channel, args.version);
  const kind: PluginKind | undefined = args.interpreter
    ? "interpreter"
    : args.library
      ? "library"
      : undefined;
  const previous = usage(() => Lockfile.load(root));
  const additions = await planAdditions(
    registry,
    args.plugins,
    kind,
    args.project,
    pin,
    previous,
    choose,
  );
  const path = rustJoin(root, CONFIG_FILE);
  const original = runtime(() => readToString(path));
  const text = usage(() => applyAdditions(original, additions));
  const config = usage(() => ProjectToml.parse(text));
  // What was just added resolves afresh, so adding a plugin again moves it to its channel's
  // current version; everything else keeps its lock.
  if (previous !== null) {
    previous.plugins = previous.plugins.filter(
      (p) => !additions.some((a) => a.kind === p.kind && p.keys.includes(a.key)),
    );
  }
  const r: Resolver = { registry, warn };
  const lock = await resolveLock(r, config, previous);
  // Everything that can fail on the network happens before either file is written, so a
  // refusal or a failed download leaves the project as it was. A plugin cached for a run that
  // then fails is reused by the next one.
  const cached: [string, string][] = [];
  for (const p of lock.plugins) cached.push([p.id, await ensurePlugin(registry, cache, p)]);
  runtime(() => writeIfChanged(path, text));
  runtime(() => lock.write(root));
  // Where `dev` has placed plugins, place the new lock's too, so a running `dev` can load them
  // without a restart. A project `dev` hasn't run in has nothing placed, and its first run
  // places them.
  const mode = runtime(() => placedMode(root));
  if (mode !== undefined) {
    const placements: Placement[] = cached.map(([id, source]) => ({ id, source }));
    runtime(() => placePlugins(root, placements, mode));
  }
  return [additions, lock];
}

/** The `--json` answer. */
export function report(additions: readonly Addition[], lock: Lockfile): Json {
  return {
    added: additions.map(additionToJson),
    locked: lock.plugins.map((p) => ({ id: p.id, version: p.version })),
  };
}

/**
 * What `add` says of one plugin it added; `defaulted` is whether hpy chose the pin rather than
 * the user.
 */
export function addedLine(a: Addition, defaulted: boolean): string {
  let line = `added ${PluginKind.pluginType(a.kind)} \`${a.key}\`: ${a.entry.name} ${pinLabel(a.entry)} (${a.version})`;
  if (defaulted && a.entry.pin.kind === "channel" && a.entry.pin.channel !== "latest") {
    line += "\n  it has no latest channel, so this follows a prerelease one";
  }
  return line;
}

/** The parsed `hv add` arguments. */
export function addArgs(args: Args): AddArgs {
  return {
    plugins: (args.PLUGIN as string[] | undefined) ?? [],
    interpreter: args.interpreter === true,
    library: args.library === true,
    channel: args.channel as string | undefined,
    version: args.version as string | undefined,
    project: args.project as string | undefined,
  };
}

export async function run(ctx: Ctx, raw: Args): Promise<void> {
  const args = addArgs(raw);
  const root = projectRoot(ctx);
  const cache = cacheRoot();
  const registry = ctx.registry();
  const choose = chooseWithPrompter(ctx);
  const warn = (m: string) => ctx.out.status(`warning: ${m}`);
  // The note is about a channel hpy chose, not one the user asked for.
  const defaulted = args.channel === undefined && args.version === undefined;
  const [additions, lock] = await addIn(root, registry, cache, args, choose, warn);
  const lines = additions.map((a) => addedLine(a, defaulted));
  const human =
    lines.length === 0 ? `${lock.plugins.length} plugins locked and downloaded` : lines.join("\n");
  ctx.out.done(human, report(additions, lock));
}
