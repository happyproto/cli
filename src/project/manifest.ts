// hpy-project/src/manifest.rs: a plugin's `manifest.json`, rebuilt from its registry version.
// The artifact carries the plugin fields the registry validated, the project its display name,
// and `requires` what the manifest's `dependencies` would. Type mapping as in ./config.ts.
import { type Json, sortKeys } from "../core/output.ts";
import { compareKeys } from "../core/serde-json.ts";
import type { PluginArtifact } from "../plugin/artifact.ts";
import { Problem } from "../plugin/problem.ts";
import { isProjectName, parseProjectUri } from "../plugin/validate.ts";

export function wasmFile(id: string): string {
  return `${id}.wasm`;
}

/** What a manifest is rebuilt from: one version of one project. */
export interface Published {
  did: string;
  name: string;
  version: string;
  artifact: PluginArtifact;
  /** The publication's name and description. */
  displayName?: string | undefined;
  description?: string | undefined;
  /** The `manifest.json` the publisher shipped beside the module. */
  manifest: Json;
}

/** `requires` entries that name other projects, as `[project URI, range]`, in key order. */
export function projectRequirements(artifact: PluginArtifact): [string, string][] {
  return [...artifact.requires]
    .sort(([a], [b]) => compareKeys(a, b))
    .filter(([key]) => parseProjectUri(key) !== null)
    .map(([key, range]) => [key, range]);
}

export function happyviewRequirement(artifact: PluginArtifact): string | undefined {
  return artifact.requires.get("env:happyview");
}

/** `synthesize`: the manifest HappyView loads for `p`, keys sorted as serde_json's `Value` holds them. Throws `Problem`. */
export function synthesize(p: Published): Json {
  // The name names a file in the plugin directory, so it has to be the registry's own grammar
  // rather than anything a record happens to carry.
  if (!isProjectName(p.name)) {
    throw new Problem("name", `\`${p.name}\` is not a project name`);
  }
  const a = p.artifact;
  if (a.pluginType === "interpreter" && a.fileExtensions.length === 0) {
    throw new Problem(
      `${p.name}@${p.version}`,
      "declares no file extensions, so no project file can name it; it predates project mode, so pick a later version",
    );
  }
  // HappyView refuses dependencies on an interpreter or an auth plugin, so only a library
  // carries them.
  const dependencies: Json[] =
    a.pluginType === "library"
      ? projectRequirements(a).flatMap(([uri, range]) => {
          const parsed = parseProjectUri(uri);
          return parsed === null ? [] : [{ id: parsed[1], version: range }];
        })
      : [];
  const m: Record<string, Json> = {
    id: p.name,
    name: p.displayName ?? p.name,
    version: p.version,
    api_version: a.apiVersion,
    plugin_type: a.pluginType,
    capabilities: [...a.capabilities],
    allowed_hosts: [...a.allowedHosts],
    dependencies,
    publisher: p.did,
    wasm_file: wasmFile(p.name),
  };
  if (p.description !== undefined) m.description = p.description;
  if (a.namespace !== undefined) m.namespace = a.namespace;
  if (a.languageId !== undefined) {
    m.language_id = a.languageId;
    m.monaco_language = a.languageId;
  }
  const first = a.fileExtensions[0];
  if (first !== undefined) {
    m.file_extension = first;
    m.extensions = [...a.fileExtensions];
  }
  // The artifact carries everything HappyView reads except an interpreter's
  // `supports_libraries`, which only the shipped manifest does. Left out, HappyView reads
  // `["*"]`.
  const shipped = p.manifest;
  if (
    shipped !== null &&
    typeof shipped === "object" &&
    !Array.isArray(shipped) &&
    Object.hasOwn(shipped, "supports_libraries")
  ) {
    m.supports_libraries = shipped.supports_libraries as Json;
  }
  return sortKeys(m);
}
