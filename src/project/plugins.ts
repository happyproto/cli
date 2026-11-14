// crates/hpy/src/project/plugins.rs: the cache entry for each locked plugin: its module and
// shipped `manifest.json` downloaded from the registry and checked against the CIDs
// `happyview.lock` records, beside the `manifest.json` HappyView loads.
import { readFileSync } from "node:fs";
import type { Registry } from "../atproto/registry.ts";
import { Failure } from "../core/failure.ts";
import { toIoError } from "../core/io.ts";
import { type Json, toJson } from "../core/output.ts";
import { rustJoin } from "../core/paths.ts";
import { Version } from "../core/semver.ts";
import { fromSlice, value } from "../core/serde-json.ts";
import { rawCid } from "../plugin/checksum.ts";
import { isProjectName, parseProjectUri } from "../plugin/validate.ts";
import { installDir, pluginDir, prepareRoot } from "./cache.ts";
import type { LockedPlugin } from "./lock.ts";
import { synthesize, wasmFile } from "./manifest.ts";
import { artifactOf, blobLink } from "./resolve.ts";

/** The `manifest.json` the publisher shipped, kept beside the one `hpy` writes so a hit can check it against the lock's CID. */
export const PUBLISHED_MANIFEST = ".manifest.published.json";
/** The CID of the `manifest.json` `hpy` wrote, so a hit can tell the manifest HappyView will read is still that one. */
export const MANIFEST_CID = ".manifest.cid";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Whether `dir` holds exactly what a verified install wrote. A hit is re-hashed every time: it
 * costs milliseconds and catches accidental edits and corruption. The sidecar is not a MAC, so
 * it is no defence against someone who can write the directory; the cache's 0700 permissions
 * are.
 */
function isIntact(dir: string, wasm: string, p: LockedPlugin): boolean {
  try {
    const cidOf = (name: string) => rawCid(readFileSync(rustJoin(dir, name)));
    const module = cidOf(wasm);
    const published = cidOf(PUBLISHED_MANIFEST);
    const manifest = cidOf("manifest.json");
    const recorded = utf8.decode(readFileSync(rustJoin(dir, MANIFEST_CID)));
    return (
      module === p.package_cid && published === p.manifest_blob_cid && manifest === recorded.trim()
    );
  } catch {
    return false;
  }
}

/** The blob with this CID, refused unless its bytes hash to it. */
async function verifiedBlob(
  reg: Registry,
  p: LockedPlugin,
  what: string,
  cid: string,
): Promise<Uint8Array> {
  const bytes = await reg.getArtifact(cid);
  const got = rawCid(bytes);
  if (got !== cid) {
    throw Failure.runtime(
      `the ${what} of ${p.id}@${p.version} downloaded as ${got}, but happyview.lock records ${cid}; nothing was installed`,
    );
  }
  return bytes;
}

function isVersion(s: string): boolean {
  try {
    Version.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** The cache directory holding this plugin, downloaded and verified on a miss. Throws `Failure`. */
export async function ensurePlugin(reg: Registry, root: string, p: LockedPlugin): Promise<string> {
  try {
    return await ensure(reg, root, p);
  } catch (e) {
    throw Failure.from(e);
  }
}

async function ensure(reg: Registry, root: string, p: LockedPlugin): Promise<string> {
  // The id and version become path components of the cache, and the lock is a file anyone
  // can edit.
  if (!isProjectName(p.id) || !isVersion(p.version)) {
    throw Failure.usage(
      `happyview.lock: \`${p.id}@${p.version}\` is not a plugin id and version hpy can cache`,
    );
  }
  // `root` came from `cacheRoot`, which has already tightened a default root, so a loose one
  // here is refused rather than changed.
  try {
    prepareRoot(root, "named");
  } catch (e) {
    throw Failure.runtime(`the cache directory ${root} cannot be trusted: ${toIoError(e).message}`);
  }
  const dir = pluginDir(root, p.id, p.version);
  const wasm = wasmFile(p.id);
  if (isIntact(dir, wasm, p)) return dir;
  const parsed = parseProjectUri(p.project);
  if (parsed === null) {
    throw Failure.usage(`happyview.lock: \`${p.project}\` is not a software.release.project URI`);
  }
  const [did, name] = parsed;
  const view = await reg.getVersion(did, name, p.version);
  if (view === null) {
    throw Failure.runtime(`the registry no longer has ${p.id}@${p.version}; pick another version`);
  }
  const artifact = artifactOf(view);
  const names = (blob: Json, cid: string) => blobLink(blob) === cid;
  if (
    view.manifest.cid !== p.manifest_cid ||
    !names(artifact.package, p.package_cid) ||
    !names(artifact.manifest, p.manifest_blob_cid)
  ) {
    throw Failure.runtime(`the registry's ${p.id} ${p.version} no longer matches happyview.lock`);
  }
  const module = await verifiedBlob(reg, p, "module", p.package_cid);
  const published = await verifiedBlob(reg, p, "manifest.json", p.manifest_blob_cid);
  let shipped: Json;
  try {
    shipped = fromSlice(published, value) as Json;
  } catch (e) {
    throw Failure.runtime(
      `the manifest.json of ${p.id}@${p.version} is not JSON: ${(e as Error).message}`,
    );
  }
  const project = await reg.getProject(did, name);
  const manifest = synthesize({
    did,
    name,
    version: p.version,
    artifact,
    displayName: project?.publication.name,
    description: project?.publication.description,
    manifest: shipped,
  });
  const bytes = new TextEncoder().encode(toJson(manifest));
  const manifestCid = rawCid(bytes);
  try {
    installDir(dir, [
      ["manifest.json", bytes],
      [MANIFEST_CID, new TextEncoder().encode(manifestCid)],
      [PUBLISHED_MANIFEST, published],
      [wasm, module],
    ]);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  return dir;
}
