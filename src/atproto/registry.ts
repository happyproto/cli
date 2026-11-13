// hpy-atproto/src/registry.rs: the plugin registry's XRPC queries over plain HTTP, and its
// procedures as the signed-in user. Commands are written against `Registry` so they can be
// tested with an in-memory fake.
import type { Json } from "../core/output.ts";
import {
  array,
  bool,
  type Decoder,
  fromValue,
  map,
  optional,
  parseValue,
  str,
  struct,
  toPlain,
  u32,
  unitEnum,
  value,
  withDefault,
} from "../core/serde-json.ts";
import type { Credential } from "./credential.ts";
import { AtprotoError } from "./error.ts";
import type { HappyView } from "./happyview.ts";
import { request, statusText, transportError } from "./http.ts";

/** A record the gateway wrote or the registry indexed. */
export interface Ref {
  uri: string;
  cid: string;
}

/** A sidecar or project record's address; the registry may not have its CID yet. */
export interface RecordRef {
  uri: string;
  cid?: string | undefined;
}

export const STATES = ["active", "deprecated", "unavailable", "retired"] as const;
export type State = (typeof STATES)[number];
/** `State`'s `Ord`: declaration order. */
export const stateRank = (s: State): number => STATES.indexOf(s);

export const AVAILABILITIES = ["pending", "available", "deletedAtSource"] as const;
export type Availability = (typeof AVAILABILITIES)[number];

export interface PublicationView {
  uri: string;
  cid: string;
  name: string;
  description?: string | undefined;
  url: string;
  /** The icon's blob CID. */
  icon?: string | undefined;
}

/** A channel's head: the version it points at and that version's standing. */
export interface ChannelView {
  version: string;
  uri: string;
  cid: string;
  state: State;
  availability: Availability;
}

export interface BannerView {
  cid: string;
  width: number;
  height: number;
  alt?: string | undefined;
}

export interface ProjectLifecycle {
  state: State;
}

export interface ProjectView {
  uri: string;
  cid?: string | undefined;
  did: string;
  handle?: string | undefined;
  name: string;
  sidecar: RecordRef;
  publication: PublicationView;
  pluginType: string;
  keywords: string[];
  /** `software.release` authors and security contacts, as published. */
  authors: Json[];
  security: Json[];
  /** A BTreeMap: iterate in `compareKeys` order. */
  channels: Map<string, ChannelView>;
  banner?: BannerView | undefined;
  lifecycle: ProjectLifecycle;
  indexedAt: string;
}

export interface ChangelogView {
  uri: string;
  title: string;
  markdown: string;
  fetchedAt: string;
}

/** One status record applied to a subject, newest last. */
export interface LifecycleEvent {
  uri: string;
  status: string;
  kind?: string | undefined;
  reason?: string | undefined;
  supersededBy?: string | undefined;
  withdrawnBy?: string | undefined;
}

export interface VersionLifecycle {
  state: State;
  installable: boolean;
  supersededBy?: string | undefined;
  reason?: string | undefined;
  kind?: string | undefined;
  events: LifecycleEvent[];
}

export interface VersionView {
  uri: string;
  cid: string;
  did: string;
  name: string;
  version: string;
  manifest: Ref;
  /** The `at.happyproto.plugin.v1` object as published; the plugin module reads it. */
  artifact: Json;
  changelog?: ChangelogView | undefined;
  availability: Availability;
  suspect: boolean;
  lifecycle: VersionLifecycle;
  indexedAt: string;
}

export interface PutProjectOut {
  created: boolean;
  project: Ref;
  publication: Ref;
  sidecar: Ref;
}

/**
 * What `publishRelease` and `promoteRelease` wrote. A promotion writes no manifest, and writes
 * a channel only when asked to move one.
 */
export interface PublishOut {
  /** The version already existed with this artifact; the call finished what was left unwritten. */
  resumed: boolean;
  manifest?: Ref | undefined;
  version: Ref;
  channel?: Ref | undefined;
  changelog?: Ref | undefined;
}

// --- serde (rename_all = "camelCase", so the keys below are the JSON names) ---

const opt = <T>(d: Decoder<T>) => withDefault(optional(d), undefined);

export const REF: Decoder<Ref> = struct("Ref", { uri: str, cid: str });
const RECORD_REF: Decoder<RecordRef> = struct("RecordRef", { uri: str, cid: opt(str) });
const STATE: Decoder<State> = unitEnum("State", STATES);
const AVAILABILITY: Decoder<Availability> = unitEnum("Availability", AVAILABILITIES);
const PUBLICATION_VIEW: Decoder<PublicationView> = struct("PublicationView", {
  uri: str,
  cid: str,
  name: str,
  description: opt(str),
  url: str,
  icon: opt(str),
});
const CHANNEL_VIEW: Decoder<ChannelView> = struct("ChannelView", {
  version: str,
  uri: str,
  cid: str,
  state: STATE,
  availability: AVAILABILITY,
});
const BANNER_VIEW: Decoder<BannerView> = struct("BannerView", {
  cid: str,
  width: u32,
  height: u32,
  alt: opt(str),
});
export const PROJECT_VIEW: Decoder<ProjectView> = struct("ProjectView", {
  uri: str,
  cid: opt(str),
  did: str,
  handle: opt(str),
  name: str,
  sidecar: RECORD_REF,
  publication: PUBLICATION_VIEW,
  pluginType: str,
  keywords: withDefault(array(str), () => []),
  authors: withDefault(array(value), () => []),
  security: withDefault(array(value), () => []),
  channels: withDefault(map(CHANNEL_VIEW), () => new Map<string, ChannelView>()),
  banner: opt(BANNER_VIEW),
  lifecycle: struct("ProjectLifecycle", { state: STATE }),
  indexedAt: str,
}) as Decoder<ProjectView>;
const CHANGELOG_VIEW: Decoder<ChangelogView> = struct("ChangelogView", {
  uri: str,
  title: str,
  markdown: str,
  fetchedAt: str,
});
const LIFECYCLE_EVENT: Decoder<LifecycleEvent> = struct("LifecycleEvent", {
  uri: str,
  status: str,
  kind: opt(str),
  reason: opt(str),
  supersededBy: opt(str),
  withdrawnBy: opt(str),
});
const VERSION_LIFECYCLE: Decoder<VersionLifecycle> = struct("VersionLifecycle", {
  state: STATE,
  installable: bool,
  supersededBy: opt(str),
  reason: opt(str),
  kind: opt(str),
  events: withDefault(array(LIFECYCLE_EVENT), () => []),
});
export const VERSION_VIEW: Decoder<VersionView> = struct("VersionView", {
  uri: str,
  cid: str,
  did: str,
  name: str,
  version: str,
  manifest: REF,
  artifact: value,
  changelog: opt(CHANGELOG_VIEW),
  availability: AVAILABILITY,
  suspect: withDefault(bool, false),
  lifecycle: VERSION_LIFECYCLE,
  indexedAt: str,
}) as Decoder<VersionView>;
const PUT_PROJECT_OUT: Decoder<PutProjectOut> = struct("PutProjectOut", {
  created: withDefault(bool, false),
  project: REF,
  publication: REF,
  sidecar: REF,
});
const PUBLISH_OUT: Decoder<PublishOut> = struct("PublishOut", {
  resumed: withDefault(bool, false),
  manifest: opt(REF),
  version: REF,
  channel: opt(REF),
  changelog: opt(REF),
});
const VERSIONS = struct("Versions", {
  versions: withDefault(array(VERSION_VIEW), () => []),
  cursor: optional(str),
});
const PROJECTS = struct("Projects", {
  projects: withDefault(array(PROJECT_VIEW), () => []),
  cursor: optional(str),
});

// serde's Serialize for the views, as `serde_json::to_value` gives them: `None` is `null`
// (no field skips), and key order is left to the caller's `sortKeys`.
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export const refJson = (r: Ref): Json => ({ uri: r.uri, cid: r.cid });

export function projectViewJson(p: ProjectView): Json {
  const channels: { [k: string]: Json } = {};
  for (const [k, c] of p.channels) {
    channels[k] = {
      version: c.version,
      uri: c.uri,
      cid: c.cid,
      state: c.state,
      availability: c.availability,
    };
  }
  return {
    uri: p.uri,
    cid: orNull(p.cid),
    did: p.did,
    handle: orNull(p.handle),
    name: p.name,
    sidecar: { uri: p.sidecar.uri, cid: orNull(p.sidecar.cid) },
    publication: {
      uri: p.publication.uri,
      cid: p.publication.cid,
      name: p.publication.name,
      description: orNull(p.publication.description),
      url: p.publication.url,
      icon: orNull(p.publication.icon),
    },
    pluginType: p.pluginType,
    keywords: [...p.keywords],
    authors: [...p.authors],
    security: [...p.security],
    channels,
    banner: p.banner
      ? {
          cid: p.banner.cid,
          width: p.banner.width,
          height: p.banner.height,
          alt: orNull(p.banner.alt),
        }
      : null,
    lifecycle: { state: p.lifecycle.state },
    indexedAt: p.indexedAt,
  };
}

export function versionViewJson(v: VersionView): Json {
  const l = v.lifecycle;
  return {
    uri: v.uri,
    cid: v.cid,
    did: v.did,
    name: v.name,
    version: v.version,
    manifest: refJson(v.manifest),
    artifact: v.artifact,
    changelog: v.changelog
      ? {
          uri: v.changelog.uri,
          title: v.changelog.title,
          markdown: v.changelog.markdown,
          fetchedAt: v.changelog.fetchedAt,
        }
      : null,
    availability: v.availability,
    suspect: v.suspect,
    lifecycle: {
      state: l.state,
      installable: l.installable,
      supersededBy: orNull(l.supersededBy),
      reason: orNull(l.reason),
      kind: orNull(l.kind),
      events: l.events.map((e) => ({
        uri: e.uri,
        status: e.status,
        kind: orNull(e.kind),
        reason: orNull(e.reason),
        supersededBy: orNull(e.supersededBy),
        withdrawnBy: orNull(e.withdrawnBy),
      })),
    },
    indexedAt: v.indexedAt,
  };
}

// --- the trait ---

export interface Registry {
  getProject(actor: string, name: string): Promise<ProjectView | null>;
  /** Every project matching the filters, across all pages. */
  searchProjects(pluginType: string | undefined, q: string | undefined): Promise<ProjectView[]>;
  /** Every version of a project, newest indexed first. */
  listVersions(did: string, name: string): Promise<VersionView[]>;
  getVersion(did: string, name: string, version: string): Promise<VersionView | null>;
  /** The version a channel points at. */
  resolveChannel(did: string, name: string, channel: string): Promise<VersionView | null>;
  /** The bytes of the blob with this CID, from the registry's copy. */
  getArtifact(cid: string): Promise<Uint8Array>;
  /** Checks a project against the gateway's rules and, unless `validateOnly`, writes it. */
  putProject(input: { [k: string]: Json }, validateOnly: boolean): Promise<PutProjectOut | null>;
  /** Checks a release against the gateway's rules and, unless `validateOnly`, writes it. */
  publishRelease(input: { [k: string]: Json }, validateOnly: boolean): Promise<PublishOut | null>;
  /** Republishes a version's artifact under a new version or channel. */
  promoteRelease(input: Json): Promise<PublishOut>;
  /** Records a lifecycle status against a project or version. */
  putStatus(input: Json): Promise<Ref>;
}

const NOT_FOUND = ["ProjectNotFound", "ActorNotFound", "VersionNotFound", "ChannelNotFound"];

/** The most a page can hold; fewer round trips for a long listing. */
const PAGE = "100";

const isObject = (v: unknown): v is { [k: string]: unknown } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** `serde_json::from_slice::<Value>(..).ok()`, boxed so a JSON `null` is told from none. */
function readJson(bytes: Uint8Array): { v: unknown } | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { v: toPlain(parseValue(text)) };
  } catch {
    return undefined;
  }
}

/** `XrpcErrorBody`: `error` and `message` when each is a string; anything else reads as none. */
function errorBody(parsed: unknown): { error?: string; message?: string } {
  const v = (parsed as { v?: unknown } | undefined)?.v;
  if (!isObject(v)) return {};
  // serde reads the whole body as XrpcErrorBody, so a non-string `error` fails it entirely.
  const e = v.error;
  const m = v.message;
  const okE = e === undefined || e === null || typeof e === "string";
  const okM = m === undefined || m === null || typeof m === "string";
  if (!okE || !okM) return {};
  return {
    ...(typeof e === "string" ? { error: e } : {}),
    ...(typeof m === "string" ? { message: m } : {}),
  };
}

function parse<T>(what: string, out: unknown, decoder: Decoder<T>): T {
  try {
    return fromValue(out, decoder);
  } catch (e) {
    throw AtprotoError.other(`${what} answered something unreadable: ${(e as Error).message}`);
  }
}

/** The registry's public XRPC queries, over plain HTTP. */
export class HttpRegistry implements Registry {
  readonly base: string;
  /** The signed-in session, for the procedures that write. */
  #session: { hv: HappyView; cred: Credential } | undefined;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  withSession(hv: HappyView, cred: Credential): HttpRegistry {
    this.#session = { hv, cred };
    return this;
  }

  /** A registry procedure as the signed-in user. */
  async #procedure(nsid: string, body: Json): Promise<Json> {
    if (!this.#session) throw AtprotoError.notLoggedIn();
    return this.#session.hv.procedure(this.#session.cred, nsid, body);
  }

  /** A procedure whose output is the records it wrote; a `validateOnly` call writes none. */
  async #write<T>(
    nsid: string,
    input: { [k: string]: Json },
    validateOnly: boolean,
    decoder: Decoder<T>,
  ): Promise<T | null> {
    const out = await this.#procedure(nsid, { ...input, validateOnly });
    if (validateOnly) return null;
    return parse(nsid, out, decoder);
  }

  async #get(method: string, params: [string, string][]): Promise<Response> {
    try {
      return await request(`${this.base}/xrpc/${method}`, { query: params });
    } catch (e) {
      throw AtprotoError.other(
        `could not reach the registry at ${this.base}: ${transportError(e)}`,
      );
    }
  }

  /** `null` for the registry's not-found errors. */
  async #query<T>(
    method: string,
    params: [string, string][],
    decoder: Decoder<T>,
  ): Promise<T | null> {
    const resp = await this.#get(method, params);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      throw AtprotoError.other(transportError(e));
    }
    // A Lua query's `{ error, message }` arrives with 200 OK, so a body carrying `error` is an
    // error whatever the status.
    const parsed = readJson(bytes);
    const failed = !resp.ok || (isObject(parsed?.v) && typeof parsed.v.error === "string");
    if (!failed) {
      if (parsed === undefined) {
        throw AtprotoError.other(`${method} answered something unreadable`);
      }
      return parse(method, parsed.v, decoder);
    }
    const err = errorBody(parsed);
    const name = err.error ?? `HTTP ${statusText(resp.status)}`;
    if (NOT_FOUND.includes(name)) return null;
    throw AtprotoError.xrpc(method, name, err.message);
  }

  async getProject(actor: string, name: string): Promise<ProjectView | null> {
    return this.#query(
      "at.happyproto.registry.getProject",
      [
        ["actor", actor],
        ["name", name],
      ],
      PROJECT_VIEW,
    );
  }

  async searchProjects(
    pluginType: string | undefined,
    q: string | undefined,
  ): Promise<ProjectView[]> {
    const out: ProjectView[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params: [string, string][] = [["limit", PAGE]];
      if (pluginType !== undefined) params.push(["pluginType", pluginType]);
      if (q !== undefined) params.push(["q", q]);
      if (cursor !== undefined) params.push(["cursor", cursor]);
      const page = await this.#query("at.happyproto.registry.searchProjects", params, PROJECTS);
      if (page === null) break;
      out.push(...page.projects);
      if (page.cursor !== undefined && page.cursor !== cursor) cursor = page.cursor;
      else break;
    }
    return out;
  }

  async listVersions(did: string, name: string): Promise<VersionView[]> {
    const out: VersionView[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params: [string, string][] = [
        ["did", did],
        ["name", name],
        ["limit", PAGE],
      ];
      if (cursor !== undefined) params.push(["cursor", cursor]);
      const page = await this.#query("at.happyproto.registry.listVersions", params, VERSIONS);
      if (page === null) break;
      out.push(...page.versions);
      if (page.cursor !== undefined && page.cursor !== cursor) cursor = page.cursor;
      else break;
    }
    return out;
  }

  async getVersion(did: string, name: string, version: string): Promise<VersionView | null> {
    return this.#query(
      "at.happyproto.registry.getVersion",
      [
        ["did", did],
        ["name", name],
        ["version", version],
      ],
      VERSION_VIEW,
    );
  }

  async resolveChannel(did: string, name: string, channel: string): Promise<VersionView | null> {
    return this.#query(
      "at.happyproto.registry.resolveChannel",
      [
        ["did", did],
        ["name", name],
        ["channel", channel],
      ],
      VERSION_VIEW,
    );
  }

  async getArtifact(cid: string): Promise<Uint8Array> {
    const METHOD = "at.happyproto.registry.getArtifact";
    const resp = await this.#get(METHOD, [["cid", cid]]);
    // A JSON body under 200 is an error envelope when it names an error, as a Lua query's
    // errors arrive; a manifest is JSON that names none.
    const json = (resp.headers.get("content-type") ?? "").startsWith("application/json");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      throw AtprotoError.other(transportError(e));
    }
    const err = json ? errorBody(readJson(bytes)) : {};
    if (resp.ok && err.error === undefined) return bytes;
    throw AtprotoError.xrpc(METHOD, err.error ?? `HTTP ${statusText(resp.status)}`, err.message);
  }

  async putProject(
    input: { [k: string]: Json },
    validateOnly: boolean,
  ): Promise<PutProjectOut | null> {
    return this.#write("at.happyproto.registry.putProject", input, validateOnly, PUT_PROJECT_OUT);
  }

  async publishRelease(
    input: { [k: string]: Json },
    validateOnly: boolean,
  ): Promise<PublishOut | null> {
    return this.#write("at.happyproto.registry.publishRelease", input, validateOnly, PUBLISH_OUT);
  }

  async promoteRelease(input: Json): Promise<PublishOut> {
    const NSID = "at.happyproto.registry.promoteRelease";
    return parse(NSID, await this.#procedure(NSID, input), PUBLISH_OUT);
  }

  async putStatus(input: Json): Promise<Ref> {
    const NSID = "at.happyproto.registry.putStatus";
    return parse(NSID, await this.#procedure(NSID, input), REF);
  }
}
