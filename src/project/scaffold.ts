// hpy-project/src/scaffold.rs: a new project: `happyview.toml`, the ignore and example env
// files, and one query lexicon with its handler in the first interpreter chosen. Type mapping as
// in ./config.ts.
import { randomBytes } from "node:crypto";
import {
  type Dirent,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createDirAll, toIoError, writeString } from "../core/io.ts";
import { rustComponents, rustFileName, rustJoin, rustParent } from "../core/paths.ts";
import { DocumentMut, Table, TomlArray, value } from "../core/toml-edit.ts";
import { Problem } from "../plugin/problem.ts";
import { entryValue, type PluginEntry, sortedEntries } from "./config.ts";
import { templateText } from "./handlers.ts";

export const STARTER_NSID = "com.example.hello";
const LEXICON_DIR = "src/lexicons/com/example";

export interface Scaffold {
  appName: string;
  superadmin: string;
  happyviewVersion: string;
  interpreters: Map<string, PluginEntry>;
  libraries: Map<string, PluginEntry>;
  handlerLanguage?: string | undefined;
}

/** `starter_handler`: the starter handler's file name and text in `language`. */
export function starterHandler(language: string): [string, string] | undefined {
  switch (language) {
    case "lua":
      return ["hello.lua", templateText("hello.lua")];
    case "javascript":
      return ["hello.js", templateText("hello.js")];
    case "typescript":
      return ["hello.ts", templateText("hello.ts")];
    default:
      return undefined;
  }
}

const HEADER =
  "# A HappyView project. `hpy happyview dev` runs it; happyview.lock pins\n" +
  "# the exact plugin versions, and `hpy happyview add` edits both files.\n\n";

/** `base_doc`: `[happyview]`, `[instance]` and the plugin tables, which every project `hpy` writes has. */
function baseDoc(
  version: string,
  appName: string | undefined,
  superadmin: string | undefined,
  interpreters: Map<string, PluginEntry>,
  libraries: Map<string, PluginEntry>,
): DocumentMut {
  const doc = new DocumentMut();
  const happyview = new Table();
  happyview.insert("version", value(version));
  doc.insert("happyview", happyview);
  const instance = new Table();
  if (appName !== undefined) instance.insert("app_name", value(appName));
  if (superadmin !== undefined) instance.insert("superadmin", value(superadmin));
  doc.insert("instance", instance);
  for (const [name, entries] of [
    ["interpreters", interpreters],
    ["libraries", libraries],
  ] as const) {
    const table = new Table();
    for (const [k, entry] of sortedEntries(entries)) table.insert(k, entryValue(entry));
    doc.insert(name, table);
  }
  return doc;
}

function devTable(doc: DocumentMut): void {
  const dev = new Table();
  dev.insert("backfill", value(false));
  doc.insert("dev", dev);
}

function happyviewToml(s: Scaffold): string {
  const doc = baseDoc(s.happyviewVersion, s.appName, s.superadmin, s.interpreters, s.libraries);
  devTable(doc);
  return `${HEADER}${doc}`;
}

/**
 * `[lexicons."<nsid>"]`: only the settings that differ from a project lexicon's defaults (no
 * backfill, indexed, no token cost).
 */
export interface LexiconSettings {
  backfill?: boolean | undefined;
  /** An `i64`. */
  tokenCost?: bigint | number | undefined;
  indexed?: boolean | undefined;
}

export const LexiconSettings = {
  isEmpty(l: LexiconSettings): boolean {
    return l.backfill === undefined && l.tokenCost === undefined && l.indexed === undefined;
  },
} as const;

/** `[scripts."<trigger>"]`: what the file cannot say about itself. */
export interface ScriptSettings {
  description?: string | undefined;
  outboundXrpcs?: string[] | undefined;
}

/** `[modules.<name>]`: a compiled module's crate. */
export interface ModuleSettings {
  language: string;
  path: string;
}

export interface ProjectFileFields {
  happyviewVersion: string;
  appName?: string | undefined;
  superadmin?: string | undefined;
  interpreters: Map<string, PluginEntry>;
  libraries: Map<string, PluginEntry>;
  networkLexicons: string[];
  labels: string[];
  lexicons: Map<string, LexiconSettings>;
  scripts: Map<string, ScriptSettings>;
  modules: Map<string, ModuleSettings>;
}

function stringArray(items: readonly string[]): TomlArray {
  const array = new TomlArray();
  for (const item of items) array.push(item);
  return array;
}

/**
 * A whole `happyview.toml`, as `hpy happyview pull` writes one from an instance: the scaffold's
 * tables, and the ones an instance can fill in.
 */
export class ProjectFile implements ProjectFileFields {
  happyviewVersion: string;
  appName?: string | undefined;
  superadmin?: string | undefined;
  interpreters: Map<string, PluginEntry>;
  libraries: Map<string, PluginEntry>;
  networkLexicons: string[];
  labels: string[];
  lexicons: Map<string, LexiconSettings>;
  scripts: Map<string, ScriptSettings>;
  modules: Map<string, ModuleSettings>;

  /** `ProjectFile::default()`, with any fields given. */
  constructor(fields: Partial<ProjectFileFields> = {}) {
    this.happyviewVersion = fields.happyviewVersion ?? "";
    this.appName = fields.appName;
    this.superadmin = fields.superadmin;
    this.interpreters = fields.interpreters ?? new Map();
    this.libraries = fields.libraries ?? new Map();
    this.networkLexicons = fields.networkLexicons ?? [];
    this.labels = fields.labels ?? [];
    this.lexicons = fields.lexicons ?? new Map();
    this.scripts = fields.scripts ?? new Map();
    this.modules = fields.modules ?? new Map();
  }

  render(): string {
    const doc = baseDoc(
      this.happyviewVersion,
      this.appName,
      this.superadmin,
      this.interpreters,
      this.libraries,
    );
    devTable(doc);
    if (this.networkLexicons.length > 0) {
      const t = new Table();
      t.insert("include", value(stringArray(this.networkLexicons)));
      doc.insert("network_lexicons", t);
    }
    if (this.labels.length > 0) {
      const t = new Table();
      t.insert("subscribe", value(stringArray(this.labels)));
      doc.insert("labels", t);
    }
    const keyed = (name: string, rows: [string, Table][]): void => {
      if (rows.length === 0) return;
      const outer = new Table();
      // Only the per-key tables are written, never an empty `[name]`.
      outer.setImplicit(true);
      for (const [key, table] of rows) outer.insert(key, table);
      doc.insert(name, outer);
    };
    keyed(
      "lexicons",
      sortedEntries(this.lexicons)
        .filter(([, l]) => !LexiconSettings.isEmpty(l))
        .map(([nsid, l]) => {
          const t = new Table();
          if (l.backfill !== undefined) t.insert("backfill", value(l.backfill));
          if (l.tokenCost !== undefined) t.insert("token_cost", value(BigInt(l.tokenCost)));
          if (l.indexed !== undefined) t.insert("indexed", value(l.indexed));
          return [nsid, t];
        }),
    );
    keyed(
      "scripts",
      sortedEntries(this.scripts)
        .filter(([, s]) => s.description !== undefined || s.outboundXrpcs !== undefined)
        .map(([trigger, s]) => {
          const t = new Table();
          if (s.description !== undefined) t.insert("description", value(s.description));
          if (s.outboundXrpcs !== undefined) {
            t.insert("outbound_xrpcs", value(stringArray(s.outboundXrpcs)));
          }
          return [trigger, t];
        }),
    );
    keyed(
      "modules",
      sortedEntries(this.modules).map(([name, m]) => {
        const t = new Table();
        t.insert("language", value(m.language));
        t.insert("path", value(m.path));
        return [name, t];
      }),
    );
    return `${HEADER}${doc}`;
  }
}

/** The `.gitignore` every project gets. */
export const GITIGNORE: string = templateText("gitignore");

/** `render`: the files of a new project, as `[path relative to it, text]`. */
export function renderScaffold(s: Scaffold): [string, string][] {
  const files: [string, string][] = [
    ["happyview.toml", happyviewToml(s)],
    [".gitignore", GITIGNORE],
    [".env.example", templateText("env.example")],
    [rustJoin(LEXICON_DIR, "hello.json"), templateText("hello.json")],
  ];
  const starter = s.handlerLanguage === undefined ? undefined : starterHandler(s.handlerLanguage);
  if (starter !== undefined) files.push([rustJoin(LEXICON_DIR, starter[0]), starter[1]]);
  return files;
}

/** `Problem::new`'s message from a thrown string or error. */
const why = (e: unknown): string => (typeof e === "string" ? e : toIoError(e).message);

/**
 * `write_new`: writes a project into a directory that is absent or empty, so `create` never
 * mixes its files into someone else's, and a failure leaves `dir` as it was so a retry starts
 * clean. Throws `Problem`.
 *
 * An empty directory is filled where it is, so it keeps its owner, mode and place (it may be
 * the working directory or a mount point), and is emptied again on failure. An absent one is
 * filled as a sibling and renamed into place once complete.
 */
export function writeNew(dir: string, files: readonly [string, string][]): void {
  const path = dir;
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      writeAbsent(dir, files);
      return;
    }
    throw new Problem(path, `reading it: ${why(e)}`);
  }
  if (!isDirectory) throw new Problem(path, "already exists and is not a directory");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    throw new Problem(path, `reading it: ${why(e)}`);
  }
  if (entries.length > 0) throw new Problem(path, "already exists and is not empty");
  try {
    fill(dir, files);
  } catch (e) {
    // It was empty on entry, so everything in it is ours.
    emptyOut(dir);
    throw new Problem(path, why(e));
  }
}

function writeAbsent(dir: string, files: readonly [string, string][]): void {
  const path = dir;
  const name = rustFileName(dir);
  if (name === undefined) throw new Problem(path, "names no directory to create");
  const p = rustParent(dir);
  const parent = p === undefined || p === "" ? "." : p;
  try {
    createDirAll(parent);
  } catch (e) {
    throw new Problem(path, `creating ${parent}: ${why(e)}`);
  }
  const partial = rustJoin(
    parent,
    `.${name}.partial-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    mkdirSync(partial);
  } catch (e) {
    throw new Problem(path, `creating ${partial}: ${why(e)}`);
  }
  try {
    fill(partial, files);
    try {
      renameSync(partial, dir);
    } catch (e) {
      throw `moving ${partial} into place: ${why(e)}`;
    }
  } catch (e) {
    try {
      rmSync(partial, { recursive: true, force: true });
    } catch {
      // Best effort, as Rust's `let _ =`.
    }
    throw new Problem(path, why(e));
  }
}

function emptyOut(dir: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = rustJoin(dir, entry.name);
    try {
      if (entry.isDirectory()) rmSync(p, { recursive: true, force: true });
      else unlinkSync(p);
    } catch {
      // Best effort, as Rust's `let _ =`.
    }
  }
}

/** `fill`: writes `files` under `root`; throws the reason as a string. */
function fill(root: string, files: readonly [string, string][]): void {
  // Every path is checked before anything is written, so a bad one leaves nothing half done.
  for (const [rel] of files) {
    const comps = rustComponents(rel);
    const plain = rel !== "" && comps.every((c) => c !== "/" && c !== "." && c !== "..");
    if (!plain) throw `${rel} isn't a plain path inside the project, so nothing was written`;
  }
  for (const [rel, body] of files) {
    const target = rustJoin(root, rel);
    const parent = rustParent(target);
    if (parent !== undefined) {
      try {
        createDirAll(parent);
      } catch (e) {
        throw `creating ${rel}: ${why(e)}`;
      }
    }
    try {
      writeString(target, body);
    } catch (e) {
      throw `writing ${rel}: ${why(e)}`;
    }
  }
}
