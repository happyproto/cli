// hpy-plugin/src/manifest.rs: `manifest.json`, the file HappyView's loader
// reads. Its plugin fields are copied into the published artifact, so its
// problems are reported here, against the file an author edits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { debugOption } from "../core/debug.ts";
import { array, fromStr, optional, str, struct, withDefault } from "../core/serde-json.ts";
import { PLUGIN_TYPES } from "./nsid.ts";
import { Problem } from "./problem.ts";

export interface Manifest {
  id: string;
  name?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  api_version?: string | undefined;
  plugin_type?: string | undefined;
  namespace?: string | undefined;
  language_id?: string | undefined;
  capabilities?: string[] | undefined;
  allowed_hosts: string[];
  /** Interpreters only: the file extensions a project's scripts use, without the dot. */
  extensions: string[];
  /** The single-extension spelling older manifests use; read when `extensions` is empty. */
  file_extension?: string | undefined;
  wasm_file?: string | undefined;
}

export const MANIFEST = struct("Manifest", {
  id: str,
  name: withDefault(optional(str), undefined),
  version: withDefault(optional(str), undefined),
  description: withDefault(optional(str), undefined),
  api_version: withDefault(optional(str), undefined),
  plugin_type: withDefault(optional(str), undefined),
  namespace: withDefault(optional(str), undefined),
  language_id: withDefault(optional(str), undefined),
  capabilities: withDefault(optional(array(str)), undefined),
  allowed_hosts: withDefault(array(str), () => []),
  extensions: withDefault(array(str), () => []),
  file_extension: withDefault(optional(str), undefined),
  wasm_file: withDefault(optional(str), undefined),
});

/** `Manifest::default()` with some fields set, for tests and callers that build one. */
export function manifest(m: Partial<Manifest> & { id: string }): Manifest {
  return { allowed_hosts: [], extensions: [], ...m };
}

export function parseManifest(text: string): Manifest {
  return fromStr(text, MANIFEST);
}

export function loadManifest(dir: string): Manifest {
  let text: string;
  try {
    text = readFileSync(join(dir, "manifest.json"), "utf8");
  } catch {
    throw new Problem("manifest.json", `no manifest.json in ${dir}`);
  }
  try {
    return parseManifest(text);
  } catch (e) {
    throw new Problem("manifest.json", `is not valid: ${(e as Error).message}`);
  }
}

/** artifact.rs `is_file_extension`: 1 to 16 lowercase letters or digits, and not `json`. */
export function isFileExtension(e: string): boolean {
  return /^[a-z0-9]{1,16}$/.test(e) && e !== "json";
}

function isLanguageId(s: string): boolean {
  return s.length <= 64 && /^[a-z][a-z0-9_-]*$/.test(s);
}

/** `extensions`, else the lone `file_extension` an older manifest names. */
export function effectiveExtensions(m: Manifest): string[] {
  if (m.extensions.length > 0) return m.extensions;
  return m.file_extension !== undefined ? [m.file_extension] : [];
}

/** Everything the registry would refuse in the plugin fields, plus the loader's own `language_id` rule. */
export function manifestProblems(m: Manifest): Problem[] {
  const out: Problem[] = [];
  if (!(m.plugin_type !== undefined && (PLUGIN_TYPES as readonly string[]).includes(m.plugin_type)))
    out.push(
      new Problem(
        "manifest.plugin_type",
        `must be auth, library or interpreter (got ${debugOption(m.plugin_type)})`,
      ),
    );
  // `str::parse::<u32>` on the part before the first dot.
  const majorText = m.api_version?.split(".")[0];
  const major =
    majorText !== undefined && /^\+?[0-9]+$/.test(majorText)
      ? Number(majorText.replace("+", ""))
      : null;
  if (!(major !== null && major <= 0xffffffff && major >= 2))
    out.push(new Problem("manifest.api_version", 'must be "2" or later'));
  const max = (path: string, value: string, limit: number) => {
    if (Buffer.byteLength(value) > limit)
      out.push(new Problem(path, `is longer than ${limit} characters`));
  };
  if (m.api_version !== undefined) max("manifest.api_version", m.api_version, 16);
  if (m.namespace !== undefined) max("manifest.namespace", m.namespace, 256);
  for (const [i, c] of (m.capabilities ?? []).entries()) max(`manifest.capabilities[${i}]`, c, 128);
  for (const [i, h] of m.allowed_hosts.entries()) max(`manifest.allowed_hosts[${i}]`, h, 256);
  if (m.capabilities === undefined)
    out.push(new Problem("manifest.capabilities", "must be declared, even when empty"));
  if (m.plugin_type === "library" && m.namespace === undefined)
    out.push(new Problem("manifest.namespace", "a library must declare its namespace"));
  if (m.plugin_type === "interpreter") {
    if (m.language_id === undefined)
      out.push(new Problem("manifest.language_id", "an interpreter must declare its language_id"));
    else if (!isLanguageId(m.language_id))
      out.push(
        new Problem(
          "manifest.language_id",
          "must be lowercase letters, digits, `-` or `_`, starting with a letter",
        ),
      );
    const effective = effectiveExtensions(m);
    if (effective.length < 1 || effective.length > 8)
      out.push(
        new Problem("manifest.extensions", "an interpreter must claim 1 to 8 file extensions"),
      );
    effective.forEach((e, i) => {
      if (!isFileExtension(e))
        out.push(
          new Problem(
            `manifest.extensions[${i}]`,
            "must be 1 to 16 lowercase letters or digits, without the dot, and not `json`",
          ),
        );
      else if (effective.slice(0, i).includes(e))
        out.push(new Problem(`manifest.extensions[${i}]`, `\`${e}\` is listed twice`));
    });
  }
  return out;
}
