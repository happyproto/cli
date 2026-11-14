// hpy-plugin/src/artifact.rs: `at.happyproto.plugin.v1`, the one entry in a
// `software.release.manifest`'s `artifacts` that makes a release a HappyView
// plugin, and the checks on the bytes it points at.
import { debugStr } from "../core/debug.ts";
import { blobSize, imageMime } from "../core/imagesize.ts";
import { type Json, sortKeys } from "../core/output.ts";
import {
  array,
  fromValue,
  map,
  optional,
  str,
  struct,
  u32,
  value,
  withDefault,
} from "../core/serde-json.ts";
import { rawCid } from "./checksum.ts";
import { effectiveExtensions, isFileExtension, type Manifest } from "./manifest.ts";
import { ARTIFACT_TYPE, PLUGIN_TYPES } from "./nsid.ts";
import { Problem } from "./problem.ts";
import { rangeProblem, requiresKeyProblem, tooLong } from "./validate.ts";

export { isFileExtension };

export const MAX_WASM_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_SCREENSHOTS = 8;
export const WASM_MIME = "application/wasm";
/** `manifest.json`, published beside the module it describes. */
export const MANIFEST_MIME = "application/json";
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];

const WASM_MAGIC = [0, 0x61, 0x73, 0x6d];

export function wasmProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 4 || WASM_MAGIC.some((b, i) => bytes[i] !== b))
    return "is not a WebAssembly module (no `\\0asm` header)";
  if (bytes.length > MAX_WASM_BYTES)
    return `is ${bytes.length} bytes; the registry accepts at most 16 MiB`;
  return null;
}

export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
}

/** The type and size of a presentation image; throws the reason as a string. SVG and anything else the registry does not accept is refused. */
export function inspectImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length > MAX_IMAGE_BYTES) throw `is ${bytes.length} bytes; images may be at most 1 MiB`;
  const mime = imageMime(bytes);
  if (mime === null) throw "must be PNG, JPEG, WebP, GIF or AVIF (SVG is not accepted)";
  let size: { width: number; height: number };
  try {
    size = blobSize(bytes);
  } catch (e) {
    throw `cannot read its dimensions: ${(e as Error).message}`;
  }
  // `as u32`: the dimensions wrap as Rust's cast does.
  return { mime, width: size.width >>> 0, height: size.height >>> 0 };
}

/**
 * The blob ref a PDS will answer an upload of these bytes with. Building the
 * artifact from it before uploading lets `--dry-run` show exactly what would be
 * published, and the upload is then checked against it.
 */
export function predictedBlob(bytes: Uint8Array, mime: string): Json {
  return { $type: "blob", ref: { $link: rawCid(bytes) }, mimeType: mime, size: bytes.length };
}

const at = (v: unknown, k: string): unknown =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)[k]
    : undefined;

/** `Value::as_u64`. */
function asU64(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return null;
}

/** Why `blob` is not a blob ref of one of `mimes` and at most `max` bytes. */
export function blobProblem(blob: unknown, mimes: readonly string[], max: number): string | null {
  const link = at(at(blob, "ref"), "$link");
  if (at(blob, "$type") !== "blob" || typeof link !== "string" || link === "")
    return "must be a blob uploaded to your PDS";
  const m = at(blob, "mimeType");
  const mime = typeof m === "string" ? m : "";
  if (!mimes.includes(mime)) return `is ${debugStr(mime)}; it must be ${mimes.join(", ")}`;
  const size = asU64(at(blob, "size"));
  if (size === null) return "has no size";
  if (size > BigInt(max)) return `is ${size} bytes; at most ${max} are accepted`;
  return null;
}

/** A banner or screenshot. */
export interface Image {
  /** Serialized as `image`. */
  blob: Json;
  width: number;
  height: number;
  alt?: string | undefined;
}

export interface Sections {
  description: string;
  installation?: string | undefined;
  security?: string | undefined;
}

export interface PluginArtifact {
  package: Json;
  /** The module's `manifest.json`; a module published as a blob has no directory beside it to hold one. */
  manifest: Json;
  banner?: Image | undefined;
  screenshots: Image[];
  pluginType: string;
  apiVersion: string;
  capabilities: string[];
  namespace?: string | undefined;
  languageId?: string | undefined;
  fileExtensions: string[];
  allowedHosts: string[];
  /** A BTreeMap: iterate it in sorted key order. */
  requires: Map<string, string>;
  license: string;
  sections: Sections;
}

/** `Image`: the blob is serialized as `image`, and is required. */
const IMAGE = struct("Image", {
  image: value,
  width: u32,
  height: u32,
  alt: withDefault(optional(str), undefined),
});

const SECTIONS = struct("Sections", {
  description: str,
  installation: withDefault(optional(str), undefined),
  security: withDefault(optional(str), undefined),
});

const ARTIFACT = struct("PluginArtifact", {
  package: value,
  manifest: value,
  banner: withDefault(optional(IMAGE), undefined),
  screenshots: withDefault(array(IMAGE), () => []),
  pluginType: str,
  apiVersion: str,
  capabilities: array(str),
  namespace: withDefault(optional(str), undefined),
  languageId: withDefault(optional(str), undefined),
  fileExtensions: withDefault(array(str), () => []),
  allowedHosts: withDefault(array(str), () => []),
  requires: withDefault(map(str), () => new Map<string, string>()),
  license: str,
  sections: SECTIONS,
});

/**
 * The artifact for a module and its manifest, with the plugin fields copied
 * from the manifest. Banner, screenshots and `requires` start empty for the
 * caller to fill.
 */
export function artifactFromManifest(
  m: Manifest,
  pkg: Json,
  manifestBlob: Json,
  license: string,
  sections: Sections,
): PluginArtifact {
  const interpreter = m.plugin_type === "interpreter";
  return {
    package: pkg,
    manifest: manifestBlob,
    banner: undefined,
    screenshots: [],
    pluginType: m.plugin_type ?? "",
    apiVersion: m.api_version ?? "",
    capabilities: [...(m.capabilities ?? [])],
    namespace: m.namespace,
    languageId: m.language_id,
    // Only an interpreter claims extensions; anything else listing them would compete for scripts it cannot run.
    fileExtensions: interpreter ? [...effectiveExtensions(m)] : [],
    allowedHosts: [...m.allowed_hosts],
    requires: new Map(),
    license,
    sections,
  };
}

function imageJson(i: Image): Json {
  const o: Record<string, Json> = { image: i.blob, width: i.width, height: i.height };
  if (i.alt !== undefined) o.alt = i.alt;
  return o;
}

/** `PluginArtifact::to_value`: serde's form with `$type`, blank optional strings dropped, keys sorted. */
export function artifactToValue(a: PluginArtifact): Json {
  const o: Record<string, Json> = {
    $type: ARTIFACT_TYPE,
    package: a.package,
    manifest: a.manifest,
    pluginType: a.pluginType,
    apiVersion: a.apiVersion,
    capabilities: a.capabilities,
    license: a.license,
  };
  if (a.banner !== undefined) o.banner = imageJson(a.banner);
  if (a.screenshots.length > 0) o.screenshots = a.screenshots.map(imageJson);
  // Validation counts a blank value as absent, so none is sent.
  if (a.namespace !== undefined && a.namespace.trim() !== "") o.namespace = a.namespace;
  if (a.languageId !== undefined && a.languageId.trim() !== "") o.languageId = a.languageId;
  if (a.fileExtensions.length > 0) o.fileExtensions = a.fileExtensions;
  if (a.allowedHosts.length > 0) o.allowedHosts = a.allowedHosts;
  if (a.requires.size > 0) o.requires = Object.fromEntries(a.requires);
  const sections: Record<string, Json> = { description: a.sections.description };
  for (const k of ["installation", "security"] as const) {
    const v = a.sections[k];
    if (v !== undefined && v.trim() !== "") sections[k] = v;
  }
  o.sections = sections;
  return sortKeys(o);
}

/** `PluginArtifact::from_value`; throws the reason as a string. */
export function artifactFromValue(v: unknown): PluginArtifact {
  const t = at(v, "$type");
  if (t !== ARTIFACT_TYPE)
    throw `is not an ${ARTIFACT_TYPE} (its $type is ${JSON.stringify(t === undefined ? null : t)})`;
  let d: ReturnType<typeof ARTIFACT>;
  try {
    d = fromValue(v, ARTIFACT);
  } catch (e) {
    throw `is not readable: ${(e as Error).message}`;
  }
  const image = (i: {
    image: unknown;
    width: number;
    height: number;
    alt?: string | undefined;
  }): Image => ({
    blob: i.image as Json,
    width: i.width,
    height: i.height,
    alt: i.alt,
  });
  return {
    package: d.package as Json,
    manifest: d.manifest as Json,
    banner: d.banner === undefined ? undefined : image(d.banner),
    screenshots: d.screenshots.map(image),
    pluginType: d.pluginType,
    apiVersion: d.apiVersion,
    capabilities: d.capabilities,
    namespace: d.namespace,
    languageId: d.languageId,
    fileExtensions: d.fileExtensions,
    allowedHosts: d.allowedHosts,
    requires: new Map([...d.requires].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    license: d.license,
    sections: d.sections,
  };
}

/** Everything the registry would refuse, so a publish fails here with every reason at once. */
export function artifactProblems(a: PluginArtifact): Problem[] {
  const out: Problem[] = [];
  const blob = (path: string, v: unknown, mimes: readonly string[], max: number) => {
    const p = blobProblem(v, mimes, max);
    if (p !== null) out.push(new Problem(path, p));
  };
  blob("artifact.package", a.package, [WASM_MIME], MAX_WASM_BYTES);
  blob("artifact.manifest", a.manifest, [MANIFEST_MIME], MAX_MANIFEST_BYTES);
  const images: [string, Image][] = [
    ...(a.banner !== undefined ? [["artifact.banner", a.banner] as [string, Image]] : []),
    ...a.screenshots.map((i, n) => [`artifact.screenshots[${n}]`, i] as [string, Image]),
  ];
  for (const [path, image] of images) {
    blob(`${path}.image`, image.blob, IMAGE_MIMES, MAX_IMAGE_BYTES);
    if (image.alt !== undefined) tooLong(out, `${path}.alt`, image.alt, 300, 3000);
  }
  if (a.screenshots.length > MAX_SCREENSHOTS)
    out.push(new Problem("artifact.screenshots", `has more than ${MAX_SCREENSHOTS} screenshots`));
  const max = (path: string, v: string, limit: number) => {
    if (Buffer.byteLength(v) > limit)
      out.push(new Problem(path, `is longer than ${limit} characters`));
  };
  if (!(PLUGIN_TYPES as readonly string[]).includes(a.pluginType))
    out.push(
      new Problem(
        "artifact.pluginType",
        `must be auth, library or interpreter (got ${debugStr(a.pluginType)})`,
      ),
    );
  const majorText = a.apiVersion.split(".")[0] ?? "";
  const major = /^\+?[0-9]+$/.test(majorText) ? Number(majorText.replace("+", "")) : null;
  if (Buffer.byteLength(a.apiVersion) > 16) max("artifact.apiVersion", a.apiVersion, 16);
  else if (!(major !== null && major <= 0xffffffff && major >= 2))
    out.push(new Problem("artifact.apiVersion", 'must be "2" or later'));
  for (const [i, c] of a.capabilities.entries()) max(`artifact.capabilities[${i}]`, c, 128);
  const ns = a.namespace !== undefined && a.namespace.trim() !== "" ? a.namespace : undefined;
  if (ns !== undefined) max("artifact.namespace", ns, 256);
  else if (a.pluginType === "library")
    out.push(new Problem("artifact.namespace", "a library must declare its namespace"));
  if (a.pluginType === "interpreter") interpreterProblems(a, out);
  for (const [i, h] of a.allowedHosts.entries()) max(`artifact.allowedHosts[${i}]`, h, 256);
  for (const key of [...a.requires.keys()].sort()) {
    const range = a.requires.get(key) as string;
    const path = `artifact.requires[${debugStr(key)}]`;
    const k = requiresKeyProblem(key);
    if (k !== null) out.push(new Problem(path, k));
    const r = rangeProblem(range);
    if (r !== null) out.push(new Problem(path, r));
  }
  if (a.license.trim() === "")
    out.push(new Problem("artifact.license", 'is required (an SPDX expression, or "proprietary")'));
  else max("artifact.license", a.license, 256);
  if (a.sections.description.trim() === "")
    out.push(new Problem("artifact.sections.description", "is required"));
  for (const name of ["description", "installation", "security"] as const) {
    const text = a.sections[name];
    if (text !== undefined) tooLong(out, `artifact.sections.${name}`, text, 2000, 20000);
  }
  return out;
}

function interpreterProblems(a: PluginArtifact, out: Problem[]): void {
  if (a.languageId === undefined || a.languageId.trim() === "")
    out.push(new Problem("artifact.languageId", "an interpreter must declare its language_id"));
  if (a.fileExtensions.length < 1 || a.fileExtensions.length > 8)
    out.push(
      new Problem("artifact.fileExtensions", "an interpreter must claim 1 to 8 file extensions"),
    );
  for (const [i, e] of a.fileExtensions.entries()) {
    const path = `artifact.fileExtensions[${i}]`;
    if (!isFileExtension(e))
      out.push(
        new Problem(
          path,
          "must be 1 to 16 lowercase letters or digits, without the dot, and not `json`",
        ),
      );
    else if (a.fileExtensions.slice(0, i).includes(e))
      out.push(new Problem(path, `\`${e}\` is listed twice`));
  }
}
