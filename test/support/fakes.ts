// crates/hpy/src/testing.rs: an in-memory `Repo` and `Registry` for command tests
// (`FakeRepo`, `FakeRegistry`, `project_view`, `version_view`, `RegistryFixture`,
// `interpreter_ext`, `library_ext`, `private_tempdir`).
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtprotoError } from "../../src/atproto/error.ts";
import type {
  Availability,
  ChannelView,
  ProjectView,
  PublishOut,
  PutProjectOut,
  Ref,
  Registry,
  VersionView,
} from "../../src/atproto/registry.ts";
import type { Repo, StoredRecord } from "../../src/atproto/repo.ts";
import { type Json, sortKeys } from "../../src/core/output.ts";
import { Version } from "../../src/core/semver.ts";
import { compareKeys } from "../../src/core/serde-json.ts";
import { MANIFEST_MIME, predictedBlob, WASM_MIME } from "../../src/plugin/artifact.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import {
  ARTIFACT_TYPE,
  CHANNEL_NSID,
  MANIFEST_NSID,
  PROJECT_NSID,
  PUBLICATION_NSID,
  SIDECAR_NSID,
  STATUS_NSID,
  TRACKS,
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

const keyOf = (did: string, name: string) => `${did} ${name}`;
const channelKey = (did: string, name: string, channel: string) => `${did} ${name} ${channel}`;

/** A registry holding many projects, for resolution and download tests (`RegistryFixture`). */
export class RegistryFixture implements Registry {
  readonly projects: ProjectView[] = [];
  /** Every version of each `did name`, in publication order. */
  readonly versions = new Map<string, VersionView[]>();
  /** Channel heads, `did name channel` → version. Kept up to date by `publish` unless set by hand. */
  readonly channels = new Map<string, string>();
  /** Blob bytes by CID. */
  readonly blobs = new Map<string, Uint8Array>();
  /** Every query answered, as `method name[@version]`. */
  readonly calls: string[] = [];

  /**
   * Publishes `version` of `did`'s `name` with the plugin fields `fields` (pluginType,
   * apiVersion, …), `requires`, and `wasm` as its module. Its shipped manifest is `{"id": name}`.
   */
  publish(
    did: string,
    name: string,
    version: string,
    fields: { [k: string]: Json },
    requires: Json,
    wasm: Uint8Array | string,
  ): void {
    this.publishWithManifest(
      did,
      name,
      version,
      fields,
      requires,
      wasm,
      JSON.stringify({ id: name }),
    );
  }

  publishWithManifest(
    did: string,
    name: string,
    version: string,
    fields: { [k: string]: Json },
    requires: Json,
    wasm: Uint8Array | string,
    manifest: Uint8Array | string,
  ): void {
    const w = typeof wasm === "string" ? bytes(wasm) : wasm;
    const m = typeof manifest === "string" ? bytes(manifest) : manifest;
    const artifact: { [k: string]: Json } = {
      $type: ARTIFACT_TYPE,
      package: predictedBlob(w, WASM_MIME),
      manifest: predictedBlob(m, MANIFEST_MIME),
      capabilities: [],
      license: "MIT",
      sections: { description: "A plugin." },
      requires,
    };
    for (const [k, v] of Object.entries(fields)) artifact[k] = structuredClone(v);
    const pluginType = typeof artifact.pluginType === "string" ? artifact.pluginType : "";
    this.blobs.set(rawCid(w), w);
    this.blobs.set(rawCid(m), m);
    const key = keyOf(did, name);
    const list = this.versions.get(key) ?? [];
    list.push(versionView(did, name, version, artifact));
    this.versions.set(key, list);
    if (!this.projects.some((p) => p.did === did && p.name === name)) {
      this.projects.push(projectView(did, name, pluginType));
    }
    this.#refreshChannels(did, name);
  }

  /** Marks a version no longer installable, as an `endOfDistribution` status does. */
  retire(did: string, name: string, version: string): void {
    for (const v of this.versions.get(keyOf(did, name)) ?? []) {
      if (v.version === version) {
        v.lifecycle.state = "unavailable";
        v.lifecycle.installable = false;
        v.lifecycle.reason = "withdrawn by its publisher";
      }
    }
    this.#refreshChannels(did, name);
  }

  setChannel(did: string, name: string, channel: string, version: string): void {
    this.channels.set(channelKey(did, name, channel), version);
  }

  /** `latest` follows the highest installable stable version, `beta` and `alpha` the highest prerelease named so. */
  #refreshChannels(did: string, name: string): void {
    const versions = this.versions.get(keyOf(did, name)) ?? [];
    for (const channel of TRACKS) {
      let head: Version | undefined;
      for (const v of versions) {
        if (!v.lifecycle.installable) continue;
        let parsed: Version;
        try {
          parsed = Version.parse(v.version);
        } catch {
          continue;
        }
        const fits =
          channel === "latest"
            ? parsed.pre.isEmpty()
            : parsed.pre.asStr().split(".")[0] === channel;
        if (fits && (head === undefined || Version.compare(parsed, head) >= 0)) head = parsed;
      }
      const at = channelKey(did, name, channel);
      if (head !== undefined) this.channels.set(at, head.toString());
      else this.channels.delete(at);
    }
    const heads = new Map<string, ChannelView>();
    for (const c of TRACKS) {
      const version = this.channels.get(channelKey(did, name, c));
      if (version === undefined) continue;
      const v = versions.find((v) => v.version === version);
      if (v === undefined) continue;
      heads.set(c, {
        version,
        uri: v.uri,
        cid: v.cid,
        state: v.lifecycle.state,
        availability: v.availability,
      });
    }
    const p = this.projects.find((p) => p.did === did && p.name === name);
    if (p !== undefined) p.channels = new Map([...heads].sort(([a], [b]) => compareKeys(a, b)));
  }

  find(did: string, name: string, version: string): VersionView | undefined {
    const v = this.versions.get(keyOf(did, name))?.find((v) => v.version === version);
    return v === undefined ? undefined : structuredClone(v);
  }

  async getProject(actor: string, name: string): Promise<ProjectView | null> {
    this.calls.push(`getProject ${name}`);
    const p = this.projects.find((p) => (p.did === actor || p.handle === actor) && p.name === name);
    return p === undefined ? null : structuredClone(p);
  }

  async searchProjects(pluginType: string | undefined): Promise<ProjectView[]> {
    this.calls.push(`searchProjects ${pluginType ?? "*"}`);
    return this.projects
      .filter((p) => pluginType === undefined || p.pluginType === pluginType)
      .map((p) => structuredClone(p));
  }

  async listVersions(did: string, name: string): Promise<VersionView[]> {
    this.calls.push(`listVersions ${name}`);
    return (this.versions.get(keyOf(did, name)) ?? []).map((v) => structuredClone(v)).reverse();
  }

  async getVersion(did: string, name: string, version: string): Promise<VersionView | null> {
    this.calls.push(`getVersion ${name}@${version}`);
    return this.find(did, name, version) ?? null;
  }

  async resolveChannel(did: string, name: string, channel: string): Promise<VersionView | null> {
    this.calls.push(`resolveChannel ${name}@${channel}`);
    const v = this.channels.get(channelKey(did, name, channel));
    return v === undefined ? null : (this.find(did, name, v) ?? null);
  }

  async getArtifact(cid: string): Promise<Uint8Array> {
    this.calls.push(`getArtifact ${cid}`);
    const b = this.blobs.get(cid);
    if (b === undefined) {
      throw AtprotoError.xrpc("at.happyproto.registry.getArtifact", "ArtifactNotHeld", undefined);
    }
    return new Uint8Array(b);
  }

  async putProject(): Promise<PutProjectOut | null> {
    throw AtprotoError.other("RegistryFixture does not publish");
  }

  async publishRelease(): Promise<PublishOut | null> {
    throw AtprotoError.other("RegistryFixture does not publish");
  }

  async promoteRelease(): Promise<PublishOut> {
    throw AtprotoError.other("RegistryFixture does not publish");
  }

  async putStatus(): Promise<Ref> {
    throw AtprotoError.other("RegistryFixture does not publish");
  }
}

/** An interpreter's plugin fields. */
export function interpreterExt(language: string, extension: string): { [k: string]: Json } {
  return {
    pluginType: "interpreter",
    apiVersion: "2",
    languageId: language,
    fileExtensions: [extension],
    capabilities: ["script:host"],
  };
}

/** A library's plugin fields. */
export function libraryExt(namespace: string): { [k: string]: Json } {
  return { pluginType: "library", apiVersion: "2", namespace, capabilities: [] };
}

/** A temporary directory only this user can reach, as a cache root must be. */
export function privateTempdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hpy-private-"));
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  return dir;
}
