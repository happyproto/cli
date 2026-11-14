// crates/hpy/src/project/resolve.rs: turns `happyview.toml`'s plugin entries into
// `happyview.lock`: one version of every project the toml names and every library those reach
// through `requires`, each pinned by CID. Type mapping as in ./config.ts. Every async function
// here throws a `Failure`; a `Problem` or registry error is converted as Rust's `?` does.
import type { Registry, VersionView } from "../atproto/registry.ts";
import { Failure } from "../core/failure.ts";
import type { Json } from "../core/output.ts";
import { Version, VersionReq } from "../core/semver.ts";
import { compareKeys } from "../core/serde-json.ts";
import { artifactFromValue, type PluginArtifact } from "../plugin/artifact.ts";
import { TRACKS } from "../plugin/nsid.ts";
import { parseProjectUri, versionUri } from "../plugin/validate.ts";
import {
  entryProjectUri,
  type Pin,
  PluginKind,
  type ProjectToml,
  versionMatches,
} from "./config.ts";
import { LOCK_VERSION, type LockedPlugin, Lockfile } from "./lock.ts";
import { happyviewRequirement, projectRequirements } from "./manifest.ts";

/** A project that answers to an interpreter or library key, as `add` and `create` offer it. */
export class Candidate {
  project: string;
  did: string;
  name: string;
  handle: string | undefined;
  displayName: string;
  /** The channel a new entry follows: `latest`, else the only one there is. */
  channel: string;
  /** The version that channel points at. */
  version: string;
  languageId: string | undefined;
  namespace: string | undefined;

  constructor(fields: {
    project: string;
    did: string;
    name: string;
    handle?: string | undefined;
    displayName: string;
    channel: string;
    version: string;
    languageId?: string | undefined;
    namespace?: string | undefined;
  }) {
    this.project = fields.project;
    this.did = fields.did;
    this.name = fields.name;
    this.handle = fields.handle;
    this.displayName = fields.displayName;
    this.channel = fields.channel;
    this.version = fields.version;
    this.languageId = fields.languageId;
    this.namespace = fields.namespace;
  }

  label(): string {
    const by = this.handle ?? this.did;
    return `${this.displayName} (${this.name} ${this.channel} ${this.version}, by ${by}) ${this.project}`;
  }

  /** The name a project uses for it in `happyview.toml`. */
  key(kind: PluginKind): string {
    return kind === "interpreter" ? (this.languageId ?? this.name) : (this.namespace ?? this.name);
  }

  answers(kind: PluginKind, key: string): boolean {
    return answers(kind, key, this.name, this.languageId, this.namespace);
  }
}

function answers(
  kind: PluginKind,
  key: string,
  name: string,
  languageId: string | undefined,
  namespace: string | undefined,
): boolean {
  return kind === "interpreter" ? languageId === key : namespace === key || name === key;
}

/** Rust's `?` on an `hpy_atproto::Error` or a `Problem`. */
async function failing<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    throw Failure.from(e);
  }
}

/** The artifact a version view carries, refused by name when unreadable. Throws `Failure`. */
export function artifactOf(view: VersionView): PluginArtifact {
  try {
    return artifactFromValue(view.artifact);
  } catch (e) {
    throw Failure.runtime(`the registry's artifact for ${view.name} ${view.version} ${e}`);
  }
}

const at = (v: unknown, k: string): unknown =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)[k]
    : undefined;

/** `blob["ref"]["$link"].as_str()`. */
export function blobLink(blob: Json): string | undefined {
  const link = at(at(blob, "ref"), "$link");
  return typeof link === "string" ? link : undefined;
}

/** `blob["ref"]["$link"]`, or empty. */
export function blobCid(blob: Json): string {
  return blobLink(blob) ?? "";
}

/**
 * The projects a version requires. Only a library's count: HappyView links libraries to
 * libraries, and an interpreter reaches them by namespace.
 */
function libraryRequirements(artifact: PluginArtifact): [string, string][] {
  return artifact.pluginType === "library" ? projectRequirements(artifact) : [];
}

/** Every project of this kind with a channel to follow, with what it answers to. */
export function candidates(reg: Registry, kind: PluginKind): Promise<Candidate[]> {
  return failing(async () => {
    const out: Candidate[] = [];
    for (const project of await reg.searchProjects(PluginKind.pluginType(kind), undefined)) {
      // A search may leave the channels out; then each is asked for.
      const channels = TRACKS.filter((c) => project.channels.size === 0 || project.channels.has(c));
      let head: [string, VersionView] | undefined;
      for (const channel of channels) {
        const view = await reg.resolveChannel(project.did, project.name, channel);
        if (view !== null) {
          head = [channel, view];
          break;
        }
      }
      if (head === undefined) continue;
      const [channel, view] = head;
      let artifact: PluginArtifact;
      try {
        artifact = artifactFromValue(view.artifact);
      } catch {
        continue;
      }
      out.push(
        new Candidate({
          project: project.uri,
          did: project.did,
          name: project.name,
          handle: project.handle,
          displayName: project.publication.name,
          channel,
          version: view.version,
          languageId: artifact.languageId,
          namespace: artifact.namespace,
        }),
      );
    }
    return out;
  });
}

function parseVersion(s: string): Version | undefined {
  try {
    return Version.parse(s);
  } catch {
    return undefined;
  }
}

/** `Iterator::max_by`: the last of several equal maxima. */
function maxBy<T>(items: readonly T[], cmp: (a: T, b: T) => number): T | undefined {
  let best: T | undefined;
  for (const item of items) if (best === undefined || cmp(item, best) >= 0) best = item;
  return best;
}

/** The highest installable version satisfying every range. */
export function pickVersion(
  versions: readonly VersionView[],
  reqs: readonly string[],
): VersionView | undefined {
  const fit: [Version, VersionView][] = [];
  for (const v of versions) {
    if (!v.lifecycle.installable) continue;
    const parsed = parseVersion(v.version);
    if (parsed === undefined) continue;
    if (reqs.every((req) => versionMatches(req, v.version))) fit.push([parsed, v]);
  }
  return maxBy(fit, (a, b) => Version.compare(a[0], b[0]))?.[1];
}

/** Picks one of several candidates answering a key, by index. */
export type Choose = (key: string, found: readonly Candidate[]) => Promise<number>;

export interface Resolver {
  registry: Registry;
  warn: (msg: string) => void;
}

/** A range on a project, with the project URI of the library that asks it. */
type Req = [range: string, who: string];

interface Chosen {
  view: VersionView;
  artifact: PluginArtifact;
}

interface Node {
  did: string;
  name: string;
  kind: PluginKind;
  /** A BTreeSet: iterate `sorted(keys)`. */
  keys: Set<string>;
  /** What `happyview.toml` pins it to, and under which key. */
  pin: [Pin, string] | undefined;
  reqs: Req[];
  chosen: Chosen | undefined;
  /**
   * The newest version, when nothing satisfied the ranges and every installable version is a
   * prerelease, which no plain range matches.
   */
  onlyPrereleases: string | undefined;
}

const newNode = (did: string, name: string, kind: PluginKind): Node => ({
  did,
  name,
  kind,
  keys: new Set(),
  pin: undefined,
  reqs: [],
  chosen: undefined,
  onlyPrereleases: undefined,
});

const needed = (n: Node): boolean => n.keys.size > 0 || n.reqs.length > 0;
const nodeVersion = (n: Node): string | undefined => n.chosen?.view.version;
const sorted = (xs: Iterable<string>): string[] => [...xs].sort(compareKeys);
const pinEq = (a: Pin, b: Pin): boolean =>
  a.kind === "channel"
    ? b.kind === "channel" && a.channel === b.channel
    : b.kind === "version" && a.version === b.version;

/** `nodes[uri]`, which Rust indexes and would panic on. */
function nodeAt(nodes: Map<string, Node>, uri: string): Node {
  const n = nodes.get(uri);
  if (n === undefined) throw new Error(`no node for ${uri}`);
  return n;
}

/**
 * Removes every requirement `project` stated and returns the nodes that lost one. A node left
 * with no keys and no requirements is needed by nothing, so its own requirements are
 * withdrawn in turn and its choice forgotten.
 */
function withdraw(nodes: Map<string, Node>, project: string): string[] {
  const touched = new Set<string>();
  const pending = [project];
  for (let requirer = pending.pop(); requirer !== undefined; requirer = pending.pop()) {
    for (const uri of sorted(nodes.keys())) {
      const node = nodeAt(nodes, uri);
      const before = node.reqs.length;
      node.reqs = node.reqs.filter(([, who]) => who !== requirer);
      if (node.reqs.length === before) continue;
      touched.add(uri);
      if (!needed(node) && node.chosen !== undefined) {
        node.chosen = undefined;
        pending.push(uri);
      }
    }
  }
  return sorted(touched);
}

function namesPrerelease(req: string): boolean {
  try {
    return VersionReq.parse(req).comparators.some((c) => !c.pre.isEmpty());
  } catch {
    return false;
  }
}

/**
 * Every constraint on `project` with who stated it, including the version of each requiring
 * library: that version is what a user can change.
 */
function conflict(nodes: Map<string, Node>, project: string): Failure {
  const node = nodeAt(nodes, project);
  const asked: string[] = [];
  if (node.pin !== undefined) {
    const [pin] = node.pin;
    const how = pin.kind === "channel" ? `channel ${pin.channel}` : `version ${pin.version}`;
    asked.push(`happyview.toml pins ${node.name} ${how}`);
  }
  const older: string[] = [];
  for (const [req, who] of node.reqs) {
    const requirer = nodeAt(nodes, who);
    older.push(`\`${requirer.name}\``);
    const version = nodeVersion(requirer) ?? "?";
    asked.push(`${requirer.name}@${version} needs ${node.name} ${req}`);
  }
  let msg = `no version of ${node.name} satisfies every requirement: ${asked.join("; ")}`;
  if (older.length > 0) {
    msg += `\nan older version of ${older.join(" or ")} may ask for less; naming one in happyview.toml may settle this`;
  }
  const newest = node.onlyPrereleases;
  if (newest !== undefined && !node.reqs.some(([req]) => namesPrerelease(req))) {
    msg += `\n${node.name} has only prereleases, which a range matches only when it names one, as "^${newest}" does`;
  }
  return Failure.usage(msg);
}

/** `unavailable: withdrawn by its publisher`, for messages. */
function standing(view: VersionView): string {
  const state = view.lifecycle.state;
  return view.lifecycle.reason !== undefined ? `${state}: ${view.lifecycle.reason}` : state;
}

export function resolveLock(
  r: Resolver,
  cfg: ProjectToml,
  previous: Lockfile | null | undefined,
): Promise<Lockfile> {
  return failing(() => resolve(r, cfg, previous ?? undefined));
}

async function resolve(
  r: Resolver,
  cfg: ProjectToml,
  previous: Lockfile | undefined,
): Promise<Lockfile> {
  const hv = cfg.happyviewVersion();
  const nodes = new Map<string, Node>();
  const queue: string[] = [];

  for (const req of cfg.requirements()) {
    const uri = entryProjectUri(req.entry);
    let node = nodes.get(uri);
    if (node === undefined) {
      node = newNode(req.entry.did, req.entry.name, req.kind);
      nodes.set(uri, node);
    }
    if (node.kind !== req.kind) {
      throw Failure.usage(`happyview.toml names ${uri} as both an interpreter and a library`);
    }
    if (node.pin === undefined) {
      node.pin = [{ ...req.entry.pin }, req.key];
    } else if (!pinEq(node.pin[0], req.entry.pin)) {
      throw Failure.usage(
        `happyview.toml's \`${node.pin[1]}\` and \`${req.key}\` both name ${uri} but pin it differently; pin it one way`,
      );
    }
    node.keys.add(req.key);
    queue.push(uri);
  }

  // A project no version satisfies is set aside rather than refused: a later re-pick of
  // whoever asked can withdraw the request that caused it.
  const unsatisfied = new Set<string>();
  let rounds = 0;
  for (let uri = queue.shift(); uri !== undefined; uri = queue.shift()) {
    rounds += 1;
    if (rounds > 64 * (nodes.size + 1)) {
      const changing = new Set(queue.map((p) => nodeAt(nodes, p).name));
      changing.add(nodeAt(nodes, uri).name);
      throw Failure.runtime(
        `plugin requirements do not settle on one set of versions; still changing: ${sorted(changing).join(", ")}`,
      );
    }
    const n = nodeAt(nodes, uri);
    if (!needed(n)) continue;
    const ranges = n.reqs.map(([req]) => req);
    const pin = n.pin?.[0];
    const current = nodeVersion(n);
    if (current !== undefined && ranges.every((req) => versionMatches(req, current))) {
      unsatisfied.delete(uri);
      continue;
    }
    const picked = await choose(r, previous, uri, n, pin, ranges);
    if (!picked.ok) {
      n.onlyPrereleases = picked.onlyPrereleases;
      unsatisfied.add(uri);
      continue;
    }
    const chosen = picked.chosen;
    unsatisfied.delete(uri);
    checkChosen(r, n, chosen, hv);
    // What the version this replaces asked of other projects no longer holds; left in place,
    // it would conflict with what this one asks.
    for (const touched of withdraw(nodes, uri)) {
      if (needed(nodeAt(nodes, touched))) queue.push(touched);
      else unsatisfied.delete(touched);
    }
    // In a cycle, what this project required may have been all that required it.
    if (!needed(n)) continue;
    for (const [dep, range] of libraryRequirements(chosen.artifact)) {
      const parsed = parseProjectUri(dep);
      if (parsed === null) continue;
      let node = nodes.get(dep);
      if (node === undefined) {
        node = newNode(parsed[0], parsed[1], "library");
        nodes.set(dep, node);
      }
      node.reqs.push([range, uri]);
      queue.push(dep);
    }
    n.chosen = chosen;
  }
  const first = sorted(unsatisfied)[0];
  if (first !== undefined) throw conflict(nodes, first);

  // Keep what the toml names and what those reach through requires.
  const reachable = new Set([...nodes].filter(([, n]) => n.keys.size > 0).map(([k]) => k));
  const stack = sorted(reachable);
  for (let uri = stack.pop(); uri !== undefined; uri = stack.pop()) {
    const chosen = nodeAt(nodes, uri).chosen;
    if (chosen === undefined) continue;
    for (const [dep] of libraryRequirements(chosen.artifact)) {
      if (nodes.has(dep) && !reachable.has(dep)) {
        reachable.add(dep);
        stack.push(dep);
      }
    }
  }

  const plugins: LockedPlugin[] = [];
  for (const uri of sorted(reachable)) {
    const n = nodeAt(nodes, uri);
    const chosen = n.chosen;
    if (chosen === undefined) throw new Error("every reachable node was resolved");
    const other = plugins.find((p) => p.id === n.name);
    if (other !== undefined) {
      throw Failure.usage(
        `${other.project} and ${uri} are both named \`${n.name}\`, and HappyView loads plugins by id`,
      );
    }
    const dependencies = libraryRequirements(chosen.artifact)
      .filter(([dep]) => reachable.has(dep))
      .flatMap(([dep]) => {
        const parsed = parseProjectUri(dep);
        return parsed === null ? [] : [parsed[1]];
      });
    const version = chosen.view.version;
    plugins.push({
      id: n.name,
      kind: n.kind,
      keys: sorted(n.keys),
      project: uri,
      version,
      channel: n.pin?.[0].kind === "channel" ? n.pin[0].channel : undefined,
      version_uri: versionUri(n.did, n.name, version),
      manifest_cid: chosen.view.manifest.cid,
      package_cid: blobCid(chosen.artifact.package),
      manifest_blob_cid: blobCid(chosen.artifact.manifest),
      dependencies,
      capabilities: [...chosen.artifact.capabilities],
    });
  }
  return new Lockfile({ version: LOCK_VERSION, happyview: { version: hv }, plugins });
}

/** That the version chosen for `node` is the kind, and answers the keys, `happyview.toml` names it by. */
function checkChosen(r: Resolver, node: Node, chosen: Chosen, hv: string): void {
  const a = chosen.artifact;
  const at = `${node.name}@${chosen.view.version}`;
  const want = PluginKind.pluginType(node.kind);
  if (a.pluginType !== want) {
    throw Failure.usage(
      `${at} is a ${a.pluginType} plugin, but it is wanted as ${node.kind === "interpreter" ? "an" : "a"} ${want}`,
    );
  }
  const key = sorted(node.keys).find(
    (key) => !answers(node.kind, key, node.name, a.languageId, a.namespace),
  );
  if (key !== undefined) {
    throw Failure.usage(`${at} does not answer to \`${key}\`, which happyview.toml names it by`);
  }
  if (a.pluginType === "interpreter" && a.fileExtensions.length === 0) {
    throw Failure.usage(
      `${at} declares no file extensions, so no project file can name it; it predates project mode, so pick a later version`,
    );
  }
  const range = happyviewRequirement(a);
  if (range !== undefined && !versionMatches(range, hv)) {
    r.warn(`${at} asks for HappyView ${range}, and this project pins ${hv}`);
  }
}

/**
 * `version` of the project, which the lock may already pin: a locked version whose manifest
 * changed is not the one locked, so it is refused.
 */
async function fetchVersion(
  r: Resolver,
  locked: LockedPlugin | undefined,
  node: Node,
  version: string,
): Promise<Chosen | undefined> {
  const view = await r.registry.getVersion(node.did, node.name, version);
  if (view === null) return undefined;
  if (
    locked !== undefined &&
    locked.version === version &&
    locked.manifest_cid !== view.manifest.cid
  ) {
    throw Failure.runtime(
      `the registry's ${node.name} ${version} no longer matches happyview.lock`,
    );
  }
  return { view, artifact: artifactOf(view) };
}

type Picked = { ok: true; chosen: Chosen } | { ok: false; onlyPrereleases: string | undefined };

const picked = (chosen: Chosen): Picked => ({ ok: true, chosen });
const unpicked = (onlyPrereleases: string | undefined): Picked => ({ ok: false, onlyPrereleases });

/**
 * The version for a node: what a pin names, else the locked one while it still satisfies,
 * else the highest installable one that does. When none does, the error is the newest
 * version if every installable one is a prerelease.
 */
async function choose(
  r: Resolver,
  previous: Lockfile | undefined,
  uri: string,
  node: Node,
  pin: Pin | undefined,
  ranges: readonly string[],
): Promise<Picked> {
  const locked = previous?.plugins.find((p) => p.project === uri);
  const satisfies = (v: string) => ranges.every((req) => versionMatches(req, v));
  if (pin?.kind === "version") {
    const v = pin.version;
    const chosen = await fetchVersion(r, locked, node, v);
    if (chosen === undefined) throw Failure.usage(`the registry has no ${node.name} ${v}`);
    if (!chosen.view.lifecycle.installable) {
      // An exact pin is the operator's call; they hear why it is not offered to anyone else.
      r.warn(
        `${node.name}@${v} is ${standing(chosen.view)}; happyview.toml pins it, so it is used anyway`,
      );
    }
    return satisfies(v) ? picked(chosen) : unpicked(undefined);
  }
  if (pin?.kind === "channel") {
    const c = pin.channel;
    // Only a version this channel chose is kept: one locked from another channel or an exact
    // pin is not what was asked for now.
    if (locked !== undefined && locked.channel === c && satisfies(locked.version)) {
      const chosen = await fetchVersion(r, locked, node, locked.version);
      if (chosen !== undefined) {
        if (!chosen.view.lifecycle.installable) {
          r.warn(
            `${node.name}@${locked.version} in happyview.lock is ${standing(chosen.view)}; it stays until \`hpy happyview add\` moves it`,
          );
        }
        return picked(chosen);
      }
    }
    const view = await r.registry.resolveChannel(node.did, node.name, c);
    if (view === null) {
      throw Failure.usage(`${node.name} has no ${c} channel; name another in happyview.toml`);
    }
    if (!view.lifecycle.installable) {
      throw Failure.usage(
        `${node.name}'s ${c} channel points at ${view.version}, which is ${standing(view)}; pin another version in happyview.toml`,
      );
    }
    const satisfied = satisfies(view.version);
    const chosen = { view, artifact: artifactOf(view) };
    return satisfied ? picked(chosen) : unpicked(undefined);
  }
  if (locked !== undefined && satisfies(locked.version)) {
    const chosen = await fetchVersion(r, locked, node, locked.version);
    if (chosen === undefined) {
      throw Failure.runtime(`the registry no longer has ${node.name}@${locked.version}`);
    }
    if (!chosen.view.lifecycle.installable) {
      r.warn(
        `${node.name}@${locked.version} in happyview.lock is ${standing(chosen.view)}; it stays until something asks for another`,
      );
    }
    return picked(chosen);
  }
  const versions = await r.registry.listVersions(node.did, node.name);
  const view = pickVersion(versions, ranges);
  if (view !== undefined) return picked({ view, artifact: artifactOf(view) });
  const installable = versions
    .filter((v) => v.lifecycle.installable)
    .flatMap((v) => {
      const parsed = parseVersion(v.version);
      return parsed === undefined ? [] : [parsed];
    });
  const onlyPrereleases = installable.every((v) => !v.pre.isEmpty())
    ? maxBy(installable, Version.compare)?.toString()
    : undefined;
  return unpicked(onlyPrereleases);
}
