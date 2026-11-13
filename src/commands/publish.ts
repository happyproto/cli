// crates/hpy/src/commands/publish.rs: `hpy registry plugin publish`, a new version of the plugin
// in the current directory (or a promotion of a published one), through the registry's gateway.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AtprotoError } from "../atproto/error.ts";
import type { ProjectView, PublishOut, Registry } from "../atproto/registry.ts";
import type { Repo } from "../atproto/repo.ts";
import { missingBlobScopes, missingRepoScopes, PUBLISH_COLLECTIONS } from "../atproto/scope.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { ioErrorText } from "../core/io.ts";
import { type Json, toJson } from "../core/output.ts";
import { rustJoin } from "../core/paths.ts";
import { array, debugStr, fromValue } from "../core/serde-json.ts";
import { blockingStdio } from "../core/stdio.ts";
import {
  artifactFromManifest,
  artifactFromValue,
  artifactProblems,
  artifactToValue,
  type Image,
  inspectImage,
  MANIFEST_MIME,
  type PluginArtifact,
  predictedBlob,
  WASM_MIME,
  wasmProblem,
} from "../plugin/artifact.ts";
import { rawCid } from "../plugin/checksum.ts";
import {
  AUTHOR,
  CONTACT,
  hpyName,
  type ImageConfig,
  releaseChangelog,
  releaseConfig,
  releaseSections,
  toDetails,
} from "../plugin/config.ts";
import { locateWasm } from "../plugin/locate.ts";
import { loadManifest, manifestProblems } from "../plugin/manifest.ts";
import { TRACKS } from "../plugin/nsid.ts";
import { Problem } from "../plugin/problem.ts";
import { type ProjectDetails, projectInput, projectProblems } from "../plugin/project.ts";
import {
  isProjectName,
  rangeProblem,
  requiresKeyProblem,
  versionProblem,
} from "../plugin/validate.ts";
import { currentIcon, exitStatusText, linkOf, loadToml, manifestOk } from "./profile.ts";

export interface PrepareOptions {
  wasm?: string | undefined;
  version?: string | undefined;
  noBuild: boolean;
}

/** Bytes to upload, and the CID the artifact already names them by. */
export class Blob {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly cid: string;
  /** What it is, for progress and errors. */
  readonly what: string;

  constructor(bytes: Uint8Array, mime: string, what: string) {
    this.cid = rawCid(bytes);
    this.bytes = bytes;
    this.mime = mime;
    this.what = what;
  }
}

/** `Result<ProjectDetails, Vec<Problem>>`. */
export type Details = { ok: ProjectDetails } | { err: Problem[] };

export interface Prepared {
  name: string;
  version: string;
  /**
   * What `putProject` would send. A project the registry already has needs no `[project]`
   * table, so its absence is kept for later rather than refused here.
   */
  details: Details;
  /** The icon `details` names, uploaded only when the publication's differs. */
  icon: Blob | undefined;
  /** Built from blob refs predicted from the bytes, so a dry run shows exactly what would be published and each upload can be checked. */
  artifact: PluginArtifact;
  /** Every blob the artifact names: module, manifest, banner, screenshots. */
  blobs: Blob[];
  /** This version's entry in the `[release] changelog` file. */
  changelog: string | null;
  wasmPath: string;
}

export type Outcome = { dryRun: Json } | { published: Published };

export interface Published {
  uri: string;
  cid: string;
  createdProject: boolean;
  /** The gateway finished a version an earlier attempt left half-written. */
  resumed: boolean;
  /** This run sent a blob to the PDS, so it did some of the work itself. */
  uploaded: boolean;
}

/** The shape `--json` prints, which the plugin-publish action reads. */
export function publishedJson(p: Published, availability: string | null): Json {
  return {
    uri: p.uri,
    cid: p.cid,
    createdProject: p.createdProject,
    resumed: p.resumed,
    availability,
  };
}

export interface Ui {
  warn(msg: string): void;
  progress(msg: string): void;
  confirm(summary: string): Promise<boolean>;
}

function loadImage(
  dir: string,
  cfg: ImageConfig,
  path: string,
  problems: Problem[],
): [Image, Blob] | undefined {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(rustJoin(dir, cfg.path));
  } catch (e) {
    problems.push(new Problem(path, `cannot read \`${cfg.path}\`: ${ioErrorText(e)}`));
    return undefined;
  }
  try {
    const info = inspectImage(bytes);
    const image: Image = {
      blob: predictedBlob(bytes, info.mime),
      width: info.width,
      height: info.height,
      alt: cfg.alt,
    };
    return [image, new Blob(bytes, info.mime, path)];
  } catch (e) {
    problems.push(new Problem(path, `\`${cfg.path}\` ${e}`));
    return undefined;
  }
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A BTreeMap's iteration order. */
const sortedMap = (m: Map<string, string>) => new Map([...m].sort(([a], [b]) => byKey(a, b)));

/** Reads and validates everything locally. Every problem is reported at once. */
export function prepare(dir: string, opts: PrepareOptions, build: (cmd: string) => void): Prepared {
  let manifest: ReturnType<typeof loadManifest>;
  try {
    manifest = loadManifest(dir);
  } catch (e) {
    throw Failure.from(e);
  }
  // The bytes, not the parse: a release serves the file the author wrote.
  let manifestJson: Uint8Array;
  try {
    manifestJson = readFileSync(rustJoin(dir, "manifest.json"));
  } catch (e) {
    throw Failure.runtime(`could not read manifest.json: ${ioErrorText(e)}`);
  }
  const toml = loadToml(dir) ?? {};
  const releaseCfg = toml.release ?? releaseConfig();
  const problems = manifestProblems(manifest);

  const name = hpyName(toml, manifest) ?? "";
  if (!isProjectName(name)) {
    problems.push(
      new Problem(
        "name",
        `\`${name}\` must be 1 to 64 lowercase letters, digits and interior \`-\``,
      ),
    );
  }
  let version: string;
  const given = opts.version ?? manifest.version;
  if (given !== undefined) {
    const p = versionProblem(given);
    if (p !== null) problems.push(new Problem("version", p));
    version = given;
  } else {
    problems.push(
      new Problem("version", "none given: pass --version or set `version` in manifest.json"),
    );
    version = "";
  }
  // Checked with the rest of hpy.toml, so one run reports them alongside every other problem
  // rather than after a build.
  for (const [key, range] of sortedMap(releaseCfg.requires)) {
    const path = `release.requires[${debugStr(key)}]`;
    const k = requiresKeyProblem(key);
    if (k !== null) problems.push(new Problem(path, k));
    const r = rangeProblem(range);
    if (r !== null) problems.push(new Problem(path, r));
  }
  const [sections, sectionProblems] = releaseSections(releaseCfg, dir);
  problems.push(...sectionProblems);
  let changelog: string | null;
  try {
    changelog = releaseChangelog(releaseCfg, dir, version);
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    problems.push(e);
    changelog = null;
  }

  const blobs: Blob[] = [];
  const a = releaseCfg.artifacts;
  const banner =
    a.banner !== undefined
      ? loadImage(dir, a.banner, "release.artifacts.banner", problems)
      : undefined;
  const screenshots: [Image, Blob][] = [];
  for (const [i, c] of a.screenshots.entries()) {
    const s = loadImage(dir, c, `release.artifacts.screenshots[${i}]`, problems);
    if (s !== undefined) screenshots.push(s);
  }
  const projectCfg = toml.project;
  const iconCfg = projectCfg?.icon;
  const icon =
    iconCfg !== undefined ? loadImage(dir, iconCfg, "project.icon", problems)?.[1] : undefined;

  if (problems.length > 0) throw Failure.problems("cannot publish:", problems);

  const buildCfg = toml.build ?? {};
  if (buildCfg.command !== undefined && !opts.noBuild) {
    const cmd = buildCfg.command;
    try {
      build(cmd);
    } catch (e) {
      throw Failure.runtime(`build command \`${cmd}\` failed: ${e}`);
    }
  }
  let wasmPath: string;
  try {
    wasmPath = locateWasm(dir, opts.wasm, buildCfg.wasm, manifest);
  } catch (e) {
    if (typeof e === "string") throw Failure.usage(e);
    throw e;
  }
  let wasm: Uint8Array;
  try {
    wasm = readFileSync(wasmPath);
  } catch (e) {
    throw Failure.runtime(`cannot read ${wasmPath}: ${ioErrorText(e)}`);
  }
  const wp = wasmProblem(wasm);
  if (wp !== null) throw Failure.usage(`${wasmPath} ${wp}`);

  const artifact = artifactFromManifest(
    manifest,
    predictedBlob(wasm, WASM_MIME),
    predictedBlob(manifestJson, MANIFEST_MIME),
    releaseCfg.license ?? "",
    sections,
  );
  artifact.requires = sortedMap(releaseCfg.requires);
  blobs.push(new Blob(wasm, WASM_MIME, "module"));
  blobs.push(new Blob(manifestJson, MANIFEST_MIME, "manifest.json"));
  if (banner !== undefined) {
    artifact.banner = banner[0];
    blobs.push(banner[1]);
  }
  for (const [image, blob] of screenshots) {
    artifact.screenshots.push(image);
    blobs.push(blob);
  }
  const later = artifactProblems(artifact);

  let details: Details;
  if (projectCfg !== undefined) {
    const iconBlob = icon ? predictedBlob(icon.bytes, icon.mime) : undefined;
    const d = toDetails(projectCfg, name, manifest, iconBlob);
    // A `[project]` table the author wrote is checked now; one left out is only needed if the
    // registry has no project.
    later.push(...projectProblems(d));
    details = { ok: d };
  } else {
    details = { err: [new Problem("hpy.toml", "has no [project] table")] };
  }
  if (later.length > 0) throw Failure.problems("cannot publish:", later);
  return { name, version, details, icon, artifact, blobs, changelog, wasmPath };
}

/**
 * The track a version publishes to: `--track`, else `latest` for a stable version and the
 * prerelease's own name for a beta or an alpha. Any other prerelease has no channel of its own,
 * so it needs saying.
 */
export function trackFor(version: string, flag: string | undefined): string {
  if (flag !== undefined) {
    if (!(TRACKS as readonly string[]).includes(flag)) {
      throw Failure.usage(`--track: \`${flag}\` is not one of latest, beta or alpha`);
    }
    return flag;
  }
  const dash = version.indexOf("-");
  if (dash === -1) return "latest";
  const id = version.slice(dash + 1).split(".")[0] as string;
  if (id === "beta" || id === "alpha") return id;
  throw Failure.usage(
    `${version} is a \`${id}\` prerelease, which no channel is named after; pass --track latest, beta or alpha`,
  );
}

export function summary(p: Prepared, track: string): string {
  const a = p.artifact;
  const blob = (b: Blob) => `${b.cid} (${b.bytes.length} bytes)`;
  const lines = [
    `Publishing ${p.name} ${p.version} to ${track}`,
    `  module:       ${p.wasmPath}`,
    `  package:      ${blob(p.blobs[0] as Blob)}`,
    `  manifest:     ${blob(p.blobs[1] as Blob)}`,
    `  type:         ${a.pluginType} (api ${a.apiVersion})`,
    `  capabilities: ${a.capabilities.length === 0 ? "none" : a.capabilities.join(", ")}`,
  ];
  if (a.requires.size > 0) {
    const reqs = [...sortedMap(a.requires)].map(([k, v]) => `${k} ${v}`);
    lines.push(`  requires:     ${reqs.join(", ")}`);
  }
  for (const b of p.blobs.slice(2)) lines.push(`  image:        ${b.what} ${b.cid}`);
  if (p.changelog !== null) lines.push("  changelog:    from [release] changelog");
  lines.push("Versions are immutable: this one can never be changed or reused.");
  return lines.join("\n");
}

/** Uploads `blob`, refusing an answer under any CID but the one the artifact already names it by. */
async function uploadChecked(repo: Repo, blob: Blob): Promise<void> {
  let stored: Json;
  try {
    stored = await repo.uploadBlob(blob.bytes, blob.mime);
  } catch (e) {
    throw Failure.from(e);
  }
  const cid = linkOf(stored);
  if (cid !== blob.cid) {
    throw Failure.runtime(
      `your PDS stored the ${blob.what} as ${cid}, but its bytes hash to ${blob.cid}; nothing was published`,
    );
  }
}

/** Every blob CID a record names, wherever it sits. */
export function blobCids(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) blobCids(v, out);
  } else if (value !== null && typeof value === "object") {
    const map = value as Record<string, unknown>;
    const ref = map.ref;
    if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
      const link = (ref as Record<string, unknown>).$link;
      if (typeof link === "string") out.add(link);
    }
    for (const v of Object.values(map)) blobCids(v, out);
  }
}

/** Structural equality, as serde_json's `Value` and derived `PartialEq` compare; an `undefined` field is an absent one. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      kb.includes(k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Read back as the types hpy writes, so `null` and an absent field are the same author. */
function readAs<T>(v: Json[], decoder: Parameters<typeof array<T>>[0]): T[] | undefined {
  try {
    return fromValue(v, array(decoder));
  } catch {
    return undefined;
  }
}

/** Whether `putProject` would change anything the registry shows. */
export function differs(details: ProjectDetails, view: ProjectView): boolean {
  // No icon in `[project]` means the publication keeps the one it has, not that it should lose it.
  const icon = details.publication.icon;
  const named = (icon as { ref?: { $link?: unknown } } | null | undefined)?.ref?.$link;
  const iconDiffers =
    icon !== undefined && view.publication.icon !== (typeof named === "string" ? named : undefined);
  const authors = readAs(view.authors, AUTHOR);
  const security = readAs(view.security, CONTACT);
  return (
    view.publication.name !== details.publication.name ||
    view.publication.description !== details.publication.description ||
    iconDiffers ||
    view.pluginType !== details.pluginType ||
    !deepEqual(view.keywords, details.keywords) ||
    authors === undefined ||
    !deepEqual(authors, details.authors) ||
    security === undefined ||
    !deepEqual(security, details.security)
  );
}

/** The error name, as `match e { Xrpc { name, .. } => name, e => e.registry_name() }` reads it. */
function errorName(e: unknown): string {
  if (!(e instanceof AtprotoError)) return "";
  if (e.detail.kind === "Xrpc") return e.detail.name;
  return e.registryName() ?? "";
}

/** Whether a publish failed because the PDS no longer has a blob the release names, which happens when a skipped upload's blob was deleted. */
export function isMissingBlob(e: unknown): boolean {
  const named = errorName(e);
  const text = e instanceof Error ? e.message : String(e);
  return (
    named === "Upstream" ||
    named === "BlobNotFound" ||
    text.toLowerCase().includes("blob not found")
  );
}

/** Refuses a session whose grant cannot write every record a publish writes or upload every blob in `mimes`. */
function checkGrant(repo: Repo, mimes: string[], name: string, version: string): void {
  const granted = repo.grantedScopes();
  if (granted === null) return;
  const missing = missingBlobScopes(granted, mimes);
  missing.push(...missingRepoScopes(granted, PUBLISH_COLLECTIONS));
  if (missing.length === 0) return;
  const needed = missing.map((s) => `\`${s}\``).join(", ");
  throw Failure.usage(
    `publishing ${name} ${version} needs ${needed}, which this sign-in was not granted. A session's scopes are fixed when it is created, so publishing again cannot add them: run \`hpy registry login\` to sign in again, then publish. Nothing was uploaded.`,
  );
}

const isProjectMissing = (e: unknown) =>
  e instanceof AtprotoError && e.registryName() === "ProjectMissing";

/** `registry_call().await?`. */
async function call<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw Failure.from(e);
  }
}

export async function execute(
  p: Prepared,
  repo: Repo,
  registry: Registry,
  ui: Ui,
  track: string,
  dryRun: boolean,
): Promise<Outcome> {
  const did = repo.did();
  try {
    const view = await registry.getVersion(did, p.name, p.version);
    if (view !== null) {
      let theirs: PluginArtifact;
      try {
        theirs = artifactFromValue(view.artifact);
      } catch (e) {
        throw Failure.runtime(`the registry's artifact for ${p.name} ${p.version} ${e}`);
      }
      if (!deepEqual(theirs, p.artifact)) {
        throw Failure.usage(
          `the registry already holds ${p.name} ${p.version} with a different artifact (manifest ${view.manifest.cid}); versions are immutable, so bump the version`,
        );
      }
      // The same artifact: an earlier publish got this far, and the gateway finishes whatever
      // it left unwritten.
    }
  } catch (e) {
    if (e instanceof Failure) throw e;
    ui.warn(`could not check the registry (${e instanceof Error ? e.message : e}); continuing`);
  }
  // The gateway writes several records and every artifact is a separate upload, so a grant
  // that covers some and not others fails partway. The whole set is checked before the first
  // upload.
  const mimes = p.blobs.map((b) => b.mime);
  if (p.icon !== undefined) mimes.push(p.icon.mime);
  checkGrant(repo, mimes, p.name, p.version);
  const project = await call(registry.getProject(did, p.name));
  let put: ProjectDetails | undefined;
  if (project === null) {
    if ("err" in p.details) {
      throw Failure.problems(
        `the registry has no \`${p.name}\` project, and hpy.toml cannot create one; run \`hpy registry plugin init\`:`,
        p.details.err,
      );
    }
    put = p.details.ok;
  } else if ("ok" in p.details && differs(p.details.ok, project)) {
    put = p.details.ok;
  }
  const release: { [k: string]: Json } = {
    name: p.name,
    version: p.version,
    track,
    artifact: artifactToValue(p.artifact),
  };
  if (p.changelog !== null) release.changelog = p.changelog;
  let projectInputJson: { [k: string]: Json } | null = null;
  if (put !== undefined) {
    const input = projectInput(put) as { [k: string]: Json };
    if (project !== null) {
      if (put.publication.icon === undefined) {
        const icon = await currentIcon(repo, p.name);
        if (icon !== undefined) (input.publication as { [k: string]: Json }).icon = icon;
      }
      // The gateway swaps on the sidecar, the record hpy's own fields live in, so a concurrent
      // edit there is not overwritten.
      if (project.sidecar.cid !== undefined) input.swapCid = project.sidecar.cid;
    }
    projectInputJson = input;
  }

  // The gateway's verdict, before anything is written or uploaded. A release for a project not
  // written yet answers ProjectMissing once its own rules pass, so that is no refusal here.
  if (projectInputJson !== null)
    await call(registry.putProject(structuredClone(projectInputJson), true));
  try {
    await registry.publishRelease(structuredClone(release), true);
  } catch (e) {
    if (!(isProjectMissing(e) && project === null)) throw Failure.from(e);
  }

  if (dryRun) {
    return {
      dryRun: { dryRun: true, project: projectInputJson, artifact: artifactToValue(p.artifact) },
    };
  }
  let text = summary(p, track);
  if (put !== undefined) {
    text += `\nThe \`${p.name}\` project will be ${project !== null ? "updated" : "created"} from hpy.toml.`;
  }
  if (!(await ui.confirm(text))) throw Failure.runtime("cancelled");

  let createdProject = false;
  if (projectInputJson !== null) {
    const current = project?.publication.icon;
    if (p.icon !== undefined && current !== p.icon.cid) {
      ui.progress("Uploading icon…");
      await uploadChecked(repo, p.icon);
    }
    const out = await call(registry.putProject(projectInputJson, false));
    if (out === null) throw Failure.runtime("putProject answered something unreadable");
    createdProject = out.created;
  }

  // A blob the previous version or the publication already names is on the PDS and held by the
  // registry, so sending it again is only traffic. A version deleted at its source may have
  // taken its blobs with it. The registry trait answers every page of versions; a project has
  // few, and asking for one page would widen the trait for this alone.
  const held = new Set<string>();
  let versions: Awaited<ReturnType<Registry["listVersions"]>> = [];
  try {
    versions = await registry.listVersions(did, p.name);
  } catch {
    versions = [];
  }
  const newest = versions.find((v) => v.availability !== "deletedAtSource");
  if (newest !== undefined) blobCids(newest.artifact, held);
  if (project?.publication.icon !== undefined) held.add(project.publication.icon);
  let uploaded = false;
  const skipped: Blob[] = [];
  for (const blob of p.blobs) {
    if (held.has(blob.cid)) {
      skipped.push(blob);
      continue;
    }
    uploaded = true;
    ui.progress(`Uploading ${blob.what}…`);
    await uploadChecked(repo, blob);
  }

  let out: PublishOut | null;
  try {
    out = await registry.publishRelease(structuredClone(release), false);
  } catch (e) {
    // A skipped blob the PDS has lost: send them all, and try once more.
    if (!(isMissingBlob(e) && skipped.length > 0)) throw Failure.from(e);
    uploaded = true;
    for (const blob of skipped) {
      ui.progress(`Uploading ${blob.what}…`);
      await uploadChecked(repo, blob);
    }
    out = await call(registry.publishRelease(release, false));
  }
  if (out === null) throw Failure.runtime("publishRelease answered something unreadable");
  return {
    published: {
      uri: out.version.uri,
      cid: out.version.cid,
      createdProject,
      resumed: out.resumed,
      uploaded,
    },
  };
}

/** Republishes `from`'s artifact as `version` on `track`. */
export async function promote(
  registry: Registry,
  name: string,
  from: string,
  version: string,
  track: string,
  changelog: string | null,
): Promise<Published> {
  const input: { [k: string]: Json } = { name, fromVersion: from, version, track };
  if (changelog !== null) input.changelog = changelog;
  const out = await call(registry.promoteRelease(input));
  return {
    uri: out.version.uri,
    cid: out.version.cid,
    createdProject: false,
    resumed: out.resumed,
    uploaded: false,
  };
}

/** How long to wait for the registry to copy a version's blobs, in milliseconds. */
export interface Timing {
  poll: number;
  limit: number;
}

export const DEFAULT_TIMING: Timing = { poll: 3000, limit: 120_000 };

/**
 * Polls the registry until the version is `available` or `timing.limit` passes, reporting each
 * change. Answers the last availability seen, or `null` when the registry never showed the
 * version.
 */
export async function waitForAvailable(
  registry: Registry,
  did: string,
  name: string,
  version: string,
  timing: Timing,
  status: (msg: string) => void,
): Promise<string | null> {
  const deadline = Date.now() + timing.limit;
  let last: string | null = null;
  for (;;) {
    let view: Awaited<ReturnType<Registry["getVersion"]>> = null;
    try {
      view = await registry.getVersion(did, name, version);
    } catch {
      view = null;
    }
    if (view !== null) {
      const now = view.availability;
      if (last !== now) {
        status(`registry: ${now}`);
        last = now;
      }
      if (last === "available") return last;
    }
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, timing.poll));
  }
  status("not available yet; check later with `hpy registry plugin status`");
  return last;
}

class TerminalUi implements Ui {
  readonly #ctx: Ctx;
  readonly #yes: boolean;

  constructor(ctx: Ctx, yes: boolean) {
    this.#ctx = ctx;
    this.#yes = yes;
  }

  warn(msg: string): void {
    this.#ctx.out.status(`warning: ${msg}`);
  }

  progress(msg: string): void {
    this.#ctx.out.status(msg);
  }

  async confirm(summary: string): Promise<boolean> {
    this.#ctx.out.status(summary);
    return this.#ctx.prompter.confirm("Publish?", this.#yes);
  }
}

/** Runs hpy.toml's `[build] command` in the plugin's directory; throws the reason as a string. */
function runBuild(dir: string): (cmd: string) => void {
  return (cmd) => {
    process.stderr.write(`$ ${cmd}\n`);
    blockingStdio();
    const r =
      process.platform === "win32"
        ? spawnSync("cmd", ["/C", cmd], { cwd: dir, stdio: "inherit" })
        : spawnSync("sh", ["-c", cmd], { cwd: dir, stdio: "inherit" });
    if (r.error) throw ioErrorText(r.error);
    if (r.status !== 0) throw `exited with ${exitStatusText(r.status, r.signal)}`;
  };
}

/** The name and version a promotion publishes, read as `prepare` reads them but without building or reading the module, which a promotion reuses. */
function promotionTarget(
  dir: string,
  version: string | undefined,
): [string, string, string | null] {
  const manifest = manifestOk(dir);
  const toml = loadToml(dir) ?? {};
  const name = hpyName(toml, manifest);
  if (name === undefined) {
    throw Failure.usage("no project name: run in a directory with manifest.json or hpy.toml");
  }
  if (!isProjectName(name)) {
    throw Failure.usage(`\`${name}\` must be 1 to 64 lowercase letters, digits and interior \`-\``);
  }
  const v = version ?? manifest?.version;
  if (v === undefined) throw Failure.usage("no version: pass --version");
  const p = versionProblem(v);
  if (p !== null) throw Failure.usage(`--version: ${p}`);
  let changelog: string | null = null;
  if (toml.release !== undefined) {
    try {
      changelog = releaseChangelog(toml.release, dir, v);
    } catch (e) {
      throw Failure.from(e);
    }
  }
  return [name, v, changelog];
}

const opt = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const from = opt(args.promote);
  const yes = !!args.yes;
  let name: string;
  let version: string;
  let session: Awaited<ReturnType<Ctx["session"]>>;
  let out: Published;
  if (from !== undefined) {
    let changelog: string | null;
    [name, version, changelog] = promotionTarget(ctx.dir, opt(args.version));
    const track = trackFor(version, opt(args.track));
    if (args.dryRun) {
      ctx.out.done(`would promote ${name} ${from} to ${version} on ${track}`, {
        dryRun: true,
        name,
        fromVersion: from,
        version,
        track,
      });
      return;
    }
    session = await ctx.session();
    checkGrant(session.repo, [], name, version);
    if (!(await ctx.prompter.confirm(`Promote ${name} ${from} to ${version} on ${track}?`, yes))) {
      throw Failure.runtime("cancelled");
    }
    out = await promote(session.registry(), name, from, version, track, changelog);
  } else {
    const opts: PrepareOptions = {
      wasm: opt(args.wasm),
      version: opt(args.version),
      noBuild: args.build === false,
    };
    const prepared = prepare(ctx.dir, opts, runBuild(ctx.dir));
    const track = trackFor(prepared.version, opt(args.track));
    session = await ctx.session();
    const registry = session.registry();
    const ui = new TerminalUi(ctx, yes);
    const outcome = await execute(prepared, session.repo, registry, ui, track, !!args.dryRun);
    if ("dryRun" in outcome) {
      ctx.out.status(summary(prepared, track));
      ctx.out.done(toJson(outcome.dryRun), outcome.dryRun);
      return;
    }
    out = outcome.published;
    if (out.createdProject) ctx.out.status(`Created the \`${prepared.name}\` project`);
    if (out.resumed) ctx.out.status(resumedStatus(out, prepared.name, prepared.version));
    name = prepared.name;
    version = prepared.version;
  }
  ctx.out.status(`Published ${out.uri}`);
  let availability: string | null = null;
  if (args.wait) {
    availability = await waitForAvailable(
      session.registry(),
      session.repo.did(),
      name,
      version,
      DEFAULT_TIMING,
      (msg) => ctx.out.status(msg),
    );
  }
  ctx.out.done(`${name} ${version} published`, publishedJson(out, availability));
}

/** What to say of a publish the gateway answered as resumed: it finished an earlier attempt only if this run wrote something toward it. */
export function resumedStatus(out: Published, name: string, version: string): string {
  if (out.uploaded || out.createdProject) {
    return "Finished a publish an earlier attempt left incomplete";
  }
  return `${name} ${version} was already published`;
}
