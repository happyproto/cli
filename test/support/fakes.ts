// crates/hpy/src/testing.rs: an in-memory `Repo` and `Registry` for command tests
// (`FakeRepo`, `FakeRegistry`, `project_view`, `version_view`).
import { AtprotoError } from "../../src/atproto/error.ts";
import type {
  Availability,
  ProjectView,
  PublishOut,
  PutProjectOut,
  Ref,
  Registry,
  VersionView,
} from "../../src/atproto/registry.ts";
import type { Repo, StoredRecord } from "../../src/atproto/repo.ts";
import { type Json, sortKeys } from "../../src/core/output.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import {
  CHANNEL_NSID,
  MANIFEST_NSID,
  PROJECT_NSID,
  PUBLICATION_NSID,
  SIDECAR_NSID,
  STATUS_NSID,
} from "../../src/plugin/nsid.ts";
import { projectUri, versionUri } from "../../src/plugin/validate.ts";

export const DID = "did:plc:testuser";

const bytes = (s: string) => new TextEncoder().encode(s);
const uri = (c: string, k: string) => `at://${DID}/${c}/${k}`;
const at = (v: unknown, k: string): unknown =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)[k]
    : undefined;
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class FakeRepo implements Repo {
  /** `(collection, rkey)` as `${collection} ${rkey}` → `[value, cid]`. */
  readonly records = new Map<string, [Json, string]>();
  readonly blobs: [Uint8Array, string][] = [];
  /** When set, uploads answer this CID instead of the true one. */
  wrongCid: string | undefined;
  /** The grant a publish pre-checks. `null` is a repo that does not know its scopes. */
  scopes: string | null;

  constructor(o: { wrongCid?: string; scopes?: string } = {}) {
    this.wrongCid = o.wrongCid;
    this.scopes = o.scopes ?? null;
  }

  static with(records: [string, string, Json][]): FakeRepo {
    const repo = new FakeRepo();
    for (const [c, k, v] of records) repo.records.set(`${c} ${k}`, [v, "bafyold"]);
    return repo;
  }

  did(): string {
    return DID;
  }

  grantedScopes(): string | null {
    return this.scopes;
  }

  async getRecord(c: string, k: string): Promise<StoredRecord | null> {
    const r = this.records.get(`${c} ${k}`);
    return r ? { uri: uri(c, k), cid: r[1], value: structuredClone(r[0]) } : null;
  }

  async listRecords(c: string): Promise<StoredRecord[]> {
    return [...this.records]
      .filter(([key]) => key.split(" ")[0] === c)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, [v, cid]]) => ({ uri: uri(c, key.split(" ")[1] as string), cid, value: v }));
  }

  async uploadBlob(b: Uint8Array, mime: string): Promise<Json> {
    const cid = this.wrongCid ?? rawCid(b);
    this.blobs.push([b, mime]);
    return { $type: "blob", ref: { $link: cid }, mimeType: mime, size: b.length };
  }
}

/** A stand-in for the manifest record's CID: the same artifact always gets the same one. */
export function manifestCid(artifact: Json): string {
  return rawCid(bytes(JSON.stringify(sortKeys(artifact))));
}

/** A view of `version` of `did`'s `name`, available and installable, with `artifact` as published. */
export function versionView(
  did: string,
  name: string,
  version: string,
  artifact: Json,
): VersionView {
  return {
    uri: versionUri(did, name, version),
    cid: rawCid(bytes(`version ${did} ${name} ${version}`)),
    did,
    name,
    version,
    manifest: { uri: `at://${did}/${MANIFEST_NSID}/3l${version}`, cid: manifestCid(artifact) },
    artifact,
    changelog: undefined,
    availability: "available",
    suspect: false,
    lifecycle: {
      state: "active",
      installable: true,
      supersededBy: undefined,
      reason: undefined,
      kind: undefined,
      events: [],
    },
    indexedAt: "2026-10-23T00:00:00Z",
  };
}

/** A project as the registry indexes it. */
export function projectView(did: string, name: string, pluginType: string): ProjectView {
  return {
    uri: projectUri(did, name),
    cid: "bafyproject",
    did,
    handle: undefined,
    name,
    sidecar: { uri: `at://${did}/${SIDECAR_NSID}/${name}`, cid: undefined },
    publication: {
      uri: `at://${did}/${PUBLICATION_NSID}/${name}`,
      cid: "bafypublication",
      name,
      description: undefined,
      url: `https://happyproto.at/plugins/${did}/${name}`,
      icon: undefined,
    },
    pluginType,
    keywords: [],
    authors: [],
    security: [],
    channels: new Map(),
    banner: undefined,
    lifecycle: { state: "active" },
    indexedAt: "2026-10-23T00:00:00Z",
  };
}

function refusal(r: [string, string] | undefined): void {
  if (r) throw AtprotoError.registry(r[0], r[1]);
}

const refs = (c: string, k: string, cid: string): Ref => ({ uri: uri(c, k), cid });

/** The gateway and read API for one signed-in publisher's project. */
export class FakeRegistry implements Registry {
  /** What `getProject` answers; `putProject` fills it in. */
  project: ProjectView | null = null;
  /** What `getVersion` answers, by version; `publishRelease` adds to it. */
  readonly versions = new Map<string, VersionView>();
  unreachable = false;
  /** What the gateway was asked: ["project"|"release", validateOnly]. */
  readonly calls: [string, boolean][] = [];
  /** `putProject` inputs that wrote. */
  readonly putProjects: { [k: string]: Json }[] = [];
  /** `publishRelease` inputs that wrote. */
  readonly published: { [k: string]: Json }[] = [];
  readonly promoted: Json[] = [];
  readonly statuses: Json[] = [];
  rejectProject: [string, string] | undefined;
  rejectRelease: [string, string] | undefined;
  /** The next `publishRelease` that writes fails as if the network dropped after the gateway wrote the manifest. */
  failNextPublish = false;
  /** Versions a failed publish left half-written, which the next publish of the same version resumes. */
  readonly halfWritten: string[] = [];
  /** The next `publishRelease` that writes fails as the gateway does when the PDS has lost a blob the release names. */
  missingBlobOnce = false;
  /** Answer `publishRelease` without a `manifest`, as the gateway may on a resumed publish. */
  omitManifest = false;

  constructor(o: { rejectProject?: [string, string]; rejectRelease?: [string, string] } = {}) {
    this.rejectProject = o.rejectProject;
    this.rejectRelease = o.rejectRelease;
  }

  /** A registry that already indexes `version` of the project, published with `artifact`. */
  static withVersion(name: string, version: string, artifact: Json): FakeRegistry {
    const reg = new FakeRegistry();
    reg.versions.set(version, versionView(DID, name, version, artifact));
    return reg;
  }

  #check(): void {
    if (this.unreachable) throw AtprotoError.other("could not reach the registry");
  }

  async getProject(): Promise<ProjectView | null> {
    this.#check();
    return this.project ? structuredClone(this.project) : null;
  }

  async searchProjects(): Promise<ProjectView[]> {
    this.#check();
    return this.project ? [structuredClone(this.project)] : [];
  }

  /** Newest first, as the registry answers (BTreeMap order, reversed). */
  async listVersions(): Promise<VersionView[]> {
    this.#check();
    return [...this.versions]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .reverse()
      .map(([, v]) => structuredClone(v));
  }

  async getVersion(_did: string, _name: string, version: string): Promise<VersionView | null> {
    this.#check();
    const v = this.versions.get(version);
    return v ? structuredClone(v) : null;
  }

  async resolveChannel(): Promise<VersionView | null> {
    this.#check();
    return null;
  }

  async getArtifact(): Promise<Uint8Array> {
    this.#check();
    throw AtprotoError.other("FakeRegistry holds no artifacts");
  }

  async putProject(
    input: { [k: string]: Json },
    validateOnly: boolean,
  ): Promise<PutProjectOut | null> {
    this.calls.push(["project", validateOnly]);
    refusal(this.rejectProject);
    if (validateOnly) return null;
    const name = asStr(input.name) ?? "";
    const created = this.project === null;
    const project = at(input, "project");
    const publication = at(input, "publication");
    const view = projectView(DID, name, asStr(at(project, "pluginType")) ?? "");
    view.publication.name = asStr(at(publication, "name")) ?? "";
    view.publication.description = asStr(at(publication, "description"));
    view.publication.icon = asStr(at(at(at(publication, "icon"), "ref"), "$link"));
    const strings = (v: unknown) =>
      Array.isArray(v) && v.every((s) => typeof s === "string") ? [...v] : [];
    const values = (v: unknown) => (Array.isArray(v) ? (structuredClone(v) as Json[]) : []);
    view.keywords = strings(at(project, "keywords"));
    view.authors = values(at(project, "authors"));
    view.security = values(at(project, "security"));
    this.project = view;
    this.putProjects.push(structuredClone(input));
    return {
      created,
      project: refs(PROJECT_NSID, name, "bafyproject"),
      publication: refs(PUBLICATION_NSID, name, "bafypublication"),
      sidecar: refs(SIDECAR_NSID, name, "bafysidecar"),
    };
  }

  async publishRelease(
    input: { [k: string]: Json },
    validateOnly: boolean,
  ): Promise<PublishOut | null> {
    this.calls.push(["release", validateOnly]);
    refusal(this.rejectRelease);
    if (validateOnly) return null;
    const name = asStr(input.name) ?? "";
    const version = asStr(input.version) ?? "";
    if (this.failNextPublish) {
      this.failNextPublish = false;
      this.halfWritten.push(version);
      throw AtprotoError.other("network went away");
    }
    if (this.missingBlobOnce) {
      this.missingBlobOnce = false;
      throw AtprotoError.registry("Upstream", "the PDS answered: blob not found");
    }
    // A version already written with this artifact is finished again rather than refused, as
    // the gateway does.
    const existing = this.versions.get(version);
    const finished =
      existing !== undefined &&
      JSON.stringify(sortKeys(existing.artifact)) ===
        JSON.stringify(sortKeys(input.artifact as Json));
    const resumed = finished || this.halfWritten.includes(version);
    const view = versionView(DID, name, version, structuredClone(input.artifact as Json));
    view.availability = "pending" satisfies Availability;
    const out: PublishOut = {
      resumed,
      manifest: this.omitManifest ? undefined : { ...view.manifest },
      version: { uri: view.uri, cid: view.cid },
      channel: refs(CHANNEL_NSID, `${name}.${asStr(input.track) ?? ""}`, "bafychannel"),
      changelog: undefined,
    };
    this.versions.set(version, view);
    this.published.push(structuredClone(input));
    return out;
  }

  async promoteRelease(input: Json): Promise<PublishOut> {
    this.#check();
    const name = asStr(at(input, "name")) ?? "";
    const version = asStr(at(input, "version")) ?? "";
    this.promoted.push(structuredClone(input));
    return {
      resumed: false,
      manifest: undefined,
      version: { uri: versionUri(DID, name, version), cid: "bafypromoted" },
      channel: undefined,
      changelog: undefined,
    };
  }

  async putStatus(input: Json): Promise<Ref> {
    this.#check();
    this.statuses.push(structuredClone(input));
    return refs(STATUS_NSID, "3lstatus", "bafystatus");
  }
}
