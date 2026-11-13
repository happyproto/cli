// hpy-plugin/src/config.rs: `hpy.toml`, the registry metadata that lives in a plugin's repo
// beside `manifest.json`. `[project]` describes the plugin as a whole (its publication and
// sidecar), `[release]` what each published version carries.
import { join } from "node:path";
import { readToString, writeString } from "../core/io.ts";
import type { Json } from "../core/output.ts";
import { rustJoin } from "../core/paths.ts";
import {
  array,
  type Decoder,
  map,
  optional,
  str,
  struct,
  untagged,
  withDefault,
} from "../core/serde-json.ts";
import {
  type Encoder,
  encArray,
  encOption,
  encStr,
  encStruct,
  isEmpty,
  isNone,
  parseTable,
  TomlError,
  type TomlTable,
  get as tomlGet,
  tryInto,
} from "../core/toml.ts";
import { DocumentMut, Table, toDocument } from "../core/toml-edit.ts";
import type { Sections } from "./artifact.ts";
import { changelogEntry } from "./changelog.ts";
import type { Manifest } from "./manifest.ts";
import { Problem } from "./problem.ts";
import type { Author, Contact, ProjectDetails } from "./project.ts";

export const FILE_NAME = "hpy.toml";

/**
 * A table that an older `hpy` wrote and this one cannot map field for field, since its fields
 * now split between `[project]` and `[release]`.
 */
const RETIRED_PROFILE =
  "uses [profile], which the software.release registry replaced; move its fields to [project] and [release] (see hpy's README)";

export interface ImageConfig {
  path: string;
  alt?: string | undefined;
}

export interface ProjectConfig {
  /** The project name; the manifest's `id` when absent. */
  name?: string | undefined;
  /** The publication's name; the manifest's `name` when absent. */
  display_name?: string | undefined;
  /** The publication's description; the manifest's when absent. */
  description?: string | undefined;
  icon?: ImageConfig | undefined;
  keywords: string[];
  authors: Author[];
  security: Contact[];
}

/** A long-form section: a path to a Markdown file relative to `hpy.toml`, or the text inline. */
export type SectionSource = string | { text: string };

export interface SectionsConfig {
  description?: SectionSource | undefined;
  installation?: SectionSource | undefined;
  security?: SectionSource | undefined;
}

export interface ArtifactsConfig {
  banner?: ImageConfig | undefined;
  screenshots: ImageConfig[];
}

export interface ReleaseConfig {
  license?: string | undefined;
  /** A Markdown file whose entry for the version being published becomes its changelog. */
  changelog?: string | undefined;
  requires: Map<string, string>;
  sections: SectionsConfig;
  artifacts: ArtifactsConfig;
}

export interface BuildConfig {
  command?: string | undefined;
  wasm?: string | undefined;
}

export interface HpyToml {
  project?: ProjectConfig | undefined;
  release?: ReleaseConfig | undefined;
  build?: BuildConfig | undefined;
}

/** `ProjectConfig::default()` with some fields set. */
export function projectConfig(p: Partial<ProjectConfig> = {}): ProjectConfig {
  return { keywords: [], authors: [], security: [], ...p };
}

/** `ReleaseConfig::default()` with some fields set. */
export function releaseConfig(r: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return { requires: new Map(), sections: {}, artifacts: { screenshots: [] }, ...r };
}

// --- serde ---

const opt = <T>(d: Decoder<T>) => withDefault(optional(d), undefined);

export const IMAGE_CONFIG = struct("ImageConfig", { path: str, alt: opt(str) });
export const AUTHOR = struct("Author", { name: str, url: opt(str), email: opt(str) });
export const CONTACT = struct("Contact", { url: opt(str), email: opt(str) });
export const PROJECT_CONFIG: Decoder<ProjectConfig> = struct("ProjectConfig", {
  name: opt(str),
  display_name: opt(str),
  description: opt(str),
  icon: opt(IMAGE_CONFIG),
  keywords: withDefault(array(str), () => []),
  authors: withDefault(array(AUTHOR), () => []),
  security: withDefault(array(CONTACT), () => []),
});
const SECTION_SOURCE = untagged<SectionSource>("SectionSource", [
  str,
  struct("Inline", { text: str }),
]);
const SECTIONS_CONFIG: Decoder<SectionsConfig> = struct("SectionsConfig", {
  description: opt(SECTION_SOURCE),
  installation: opt(SECTION_SOURCE),
  security: opt(SECTION_SOURCE),
});
const ARTIFACTS_CONFIG: Decoder<ArtifactsConfig> = struct("ArtifactsConfig", {
  banner: opt(IMAGE_CONFIG),
  screenshots: withDefault(array(IMAGE_CONFIG), () => []),
});
const RELEASE_CONFIG: Decoder<ReleaseConfig> = struct("ReleaseConfig", {
  license: opt(str),
  changelog: opt(str),
  requires: withDefault(map(str), () => new Map<string, string>()),
  sections: withDefault(SECTIONS_CONFIG, () => ({})),
  artifacts: withDefault(ARTIFACTS_CONFIG, () => ({ screenshots: [] })),
});
const BUILD_CONFIG: Decoder<BuildConfig> = struct("BuildConfig", {
  command: opt(str),
  wasm: opt(str),
});
export const HPY_TOML: Decoder<HpyToml> = struct("HpyToml", {
  project: opt(PROJECT_CONFIG),
  release: opt(RELEASE_CONFIG),
  build: opt(BUILD_CONFIG),
});

export const encImageConfig = encStruct<ImageConfig>("ImageConfig", {
  path: encStr,
  alt: { enc: encOption(encStr), skipIf: isNone },
});
export const encAuthor = encStruct<Author>("Author", {
  name: encStr,
  url: { enc: encOption(encStr), skipIf: isNone },
  email: { enc: encOption(encStr), skipIf: isNone },
});
export const encContact = encStruct<Contact>("Contact", {
  url: { enc: encOption(encStr), skipIf: isNone },
  email: { enc: encOption(encStr), skipIf: isNone },
});
export const encProjectConfig: Encoder<ProjectConfig> = encStruct<ProjectConfig>("ProjectConfig", {
  name: { enc: encOption(encStr), skipIf: isNone },
  display_name: { enc: encOption(encStr), skipIf: isNone },
  description: { enc: encOption(encStr), skipIf: isNone },
  icon: { enc: encOption(encImageConfig), skipIf: isNone },
  keywords: { enc: encArray(encStr), skipIf: isEmpty },
  authors: { enc: encArray(encAuthor), skipIf: isEmpty },
  security: { enc: encArray(encContact), skipIf: isEmpty },
});

// --- HpyToml ---

/** `HpyToml::load`: `null` when there is no `hpy.toml`. Throws a `Problem`. */
export function loadHpyToml(dir: string): HpyToml | null {
  let text: string;
  try {
    text = readToString(join(dir, FILE_NAME));
  } catch {
    return null;
  }
  const invalid = (e: unknown) => {
    if (e instanceof TomlError) return new Problem(FILE_NAME, `is not valid: ${e.message}`);
    return e;
  };
  let table: TomlTable;
  try {
    table = parseTable(text);
  } catch (e) {
    throw invalid(e);
  }
  // Ignoring it would publish without the license, authors and sections it holds, so it is
  // refused until moved.
  if (table.has("profile")) throw new Problem(FILE_NAME, RETIRED_PROFILE);
  // The icon now belongs to the project, not each release; ignoring it here would publish a
  // plugin without one.
  if (tomlGet(tomlGet(table.get("release"), "artifacts"), "icon") !== undefined) {
    throw new Problem(
      "release.artifacts.icon",
      "moved to [project] icon, since the icon belongs to the plugin rather than a release",
    );
  }
  try {
    return tryInto(table, HPY_TOML);
  } catch (e) {
    throw invalid(e);
  }
}

/** `HpyToml::name`: `[project] name`, else the manifest's `id`. */
export function hpyName(cfg: HpyToml, manifest: Manifest | undefined): string | undefined {
  return cfg.project?.name ?? manifest?.id;
}

/**
 * `ProjectConfig::to_details`: what `putProject` sends for this config, with the manifest's
 * `name`, `description` and `plugin_type` filling in. `icon` is the blob of the config's icon
 * file, which the caller reads and uploads. Check the result with `projectProblems`.
 */
export function toDetails(
  cfg: ProjectConfig,
  name: string,
  manifest: Manifest | undefined,
  icon: Json | undefined,
): ProjectDetails {
  return {
    name,
    publication: {
      name: cfg.display_name ?? manifest?.name ?? "",
      description: cfg.description ?? manifest?.description,
      icon,
    },
    pluginType: manifest?.plugin_type ?? "",
    keywords: [...cfg.keywords],
    authors: cfg.authors.map((a) => ({ ...a })),
    security: cfg.security.map((c) => ({ ...c })),
  };
}

/**
 * `ReleaseConfig::sections`: the artifact's sections, read from their files, plus a problem for
 * each file that cannot be read. A missing description is left empty for `artifactProblems`.
 */
export function releaseSections(cfg: ReleaseConfig, dir: string): [Sections, Problem[]] {
  const problems: Problem[] = [];
  const s = cfg.sections;
  const sections: Sections = {
    description: readSection(dir, "description", s.description, problems) ?? "",
    installation: readSection(dir, "installation", s.installation, problems),
    security: readSection(dir, "security", s.security, problems),
  };
  return [sections, problems];
}

/**
 * `ReleaseConfig::changelog`: the entry for `version`, or `null` when no changelog is configured
 * or it has no entry for that version. Throws a `Problem` when the file cannot be read.
 */
export function releaseChangelog(cfg: ReleaseConfig, dir: string, version: string): string | null {
  const path = cfg.changelog;
  if (path === undefined) return null;
  let text: string;
  try {
    text = readToString(rustJoin(dir, path));
  } catch (e) {
    throw new Problem("release.changelog", `cannot read \`${path}\`: ${(e as Error).message}`);
  }
  return changelogEntry(text, version);
}

function readSection(
  dir: string,
  name: string,
  source: SectionSource | undefined,
  out: Problem[],
): string | undefined {
  if (source === undefined) return undefined;
  if (typeof source !== "string") return source.text;
  try {
    return readToString(rustJoin(dir, source));
  } catch (e) {
    out.push(
      new Problem(`release.sections.${name}`, `cannot read \`${source}\`: ${(e as Error).message}`),
    );
    return undefined;
  }
}

/**
 * `write_project`: replaces the `[project]` table of `dir/hpy.toml`, creating the file if needed
 * and leaving every other table and comment alone. Throws an `IoError`-like `Error` whose
 * message is the Rust `io::Error`'s.
 */
export function writeProject(dir: string, cfg: ProjectConfig): void {
  const path = join(dir, FILE_NAME);
  let existing = "";
  try {
    existing = readToString(path);
  } catch {
    existing = "";
  }
  writeString(path, projectText(existing, cfg));
}

/** The text `write_project` writes over `existing`. */
export function projectText(existing: string, cfg: ProjectConfig): string {
  let doc: DocumentMut;
  try {
    doc = DocumentMut.parse(existing);
  } catch (e) {
    if (e instanceof TomlError) throw new Error(`${FILE_NAME}: ${e.message}`);
    throw e;
  }
  const fresh = toDocument(encProjectConfig(cfg)).root.clone();
  // Comments above `[project]` belong to its header; keep them, and keep the table where the
  // author put it.
  const old = doc.get("project");
  if (old instanceof Table) {
    fresh.decor = old.decor.clone();
    fresh.setPosition(old.position);
  }
  doc.set("project", fresh);
  return doc.toString();
}
