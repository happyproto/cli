// The hpy functions that edit TOML, on toml-edit.ts, line for line with the Rust:
// crates/hpy-plugin/src/config.rs `write_project`, crates/hpy-project/src/config.rs
// `entry_value` / `set_plugin` / `check_entry`, crates/hpy-project/src/scaffold.rs `base_doc` /
// `happyview_toml` / `ProjectFile::render`, crates/hpy-project/src/handlers.rs
// `first_interpreter`. File I/O is left to the caller.

import { compareKeys } from "../../../src/core/serde-json.ts";
import { TomlError } from "../../../src/core/toml.ts";
import {
  asTableLike,
  DocumentMut,
  InlineTable,
  type Item,
  isValue,
  Table,
  TomlArray,
  tableLikeInsert,
  toDocument,
  value,
} from "../../../src/core/toml-edit.ts";
import { encProjectConfig, type ProjectConfig } from "./decoders.ts";

/** hpy's `Problem`, displayed as `path: message` (or the message alone). */
export class Problem extends Error {
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(path === "" ? detail : `${path}: ${detail}`);
    this.path = path;
    this.detail = detail;
  }
}

// --- hpy-plugin config.rs ---

/**
 * `write_project`: `existing` is `hpy.toml`'s text (`undefined` when absent); returns the text
 * to write. Throws an `Error` whose message is the Rust `io::Error`'s.
 */
export function writeProject(existing: string | undefined, cfg: ProjectConfig): string {
  let doc: DocumentMut;
  try {
    doc = DocumentMut.parse(existing ?? "");
  } catch (e) {
    if (e instanceof TomlError) throw new Error(`hpy.toml: ${e.message}`);
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

// --- hpy-project config.rs ---

export type PluginKind = "interpreter" | "library";
export interface PluginEntry {
  did: string;
  name: string;
  pin: { channel: string } | { version: string };
}

const TABLE: Record<PluginKind, string> = { interpreter: "interpreters", library: "libraries" };

/** `entry_value`: the inline table `happyview.toml` holds for `entry`. */
export function entryValue(entry: PluginEntry): InlineTable {
  const table = new InlineTable();
  table.insert("did", entry.did);
  table.insert("name", entry.name);
  if ("channel" in entry.pin) table.insert("channel", entry.pin.channel);
  else table.insert("version", entry.pin.version);
  return table;
}

function checkEntry(kind: PluginKind, key: string): void {
  const path = `${TABLE[kind]}.${key}`;
  if (kind === "interpreter") {
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
      throw new Problem(
        path,
        `'${key}' must be lowercase letters, digits, '-' or '_', starting with a letter`,
      );
    }
  } else if (key.trim() === "") {
    throw new Problem(path, "key must not be empty");
  }
}

/** `set_plugin`: `text` with the entry set and nothing else changed. Throws `Problem`. */
export function setPlugin(text: string, kind: PluginKind, key: string, entry: PluginEntry): string {
  checkEntry(kind, key);
  let doc: DocumentMut;
  try {
    doc = DocumentMut.parse(text);
  } catch (e) {
    if (e instanceof TomlError) throw new Problem("happyview.toml", e.message);
    throw e;
  }
  const item = doc.orInsertWith(TABLE[kind], () => new Table());
  const table = asTableLike(item);
  if (!table) throw new Problem(TABLE[kind], "must be a table");
  const v = entryValue(entry);
  const old = table.get(key);
  if (isValue(old)) {
    v.decor = old.decor.clone();
    replaceValue(table, key, v);
  } else {
    tableLikeInsert(table, key, v);
  }
  return doc.toString();
}

/** `*old = value` through `get_mut`: the key keeps its formatting. */
function replaceValue(table: Table | InlineTable, key: string, v: Item): void {
  const entry = table.items.get(key)!;
  entry.item = v;
}

// --- hpy-project handlers.rs ---

/** `first_interpreter`: the first `[interpreters]` key as written. */
export function firstInterpreter(text: string): string | undefined {
  let doc: DocumentMut;
  try {
    doc = DocumentMut.parse(text);
  } catch {
    return undefined;
  }
  const table = asTableLike(doc.get("interpreters"));
  return table?.iter()[0]?.[0];
}

// --- hpy-project scaffold.rs ---

const HEADER =
  "# A HappyView project. `hpy happyview dev` runs it; happyview.lock pins\n" +
  "# the exact plugin versions, and `hpy happyview add` edits both files.\n\n";

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
    for (const [k, entry] of sorted(entries)) table.insert(k, entryValue(entry));
    doc.insert(name, table);
  }
  return doc;
}

function devTable(doc: DocumentMut): void {
  const dev = new Table();
  dev.insert("backfill", value(false));
  doc.insert("dev", dev);
}

/** A `BTreeMap`'s iteration order (Rust `String` order, which is UTF-8 byte order). */
function sorted<T>(m: Map<string, T>): [string, T][] {
  return [...m].sort(([a], [b]) => compareKeys(a, b));
}

export interface Scaffold {
  appName: string;
  superadmin: string;
  happyviewVersion: string;
  interpreters: Map<string, PluginEntry>;
  libraries: Map<string, PluginEntry>;
}

/** `happyview_toml`: the scaffold's `happyview.toml`. */
export function happyviewToml(s: Scaffold): string {
  const doc = baseDoc(s.happyviewVersion, s.appName, s.superadmin, s.interpreters, s.libraries);
  devTable(doc);
  return `${HEADER}${doc}`;
}

export interface ProjectFile {
  happyviewVersion: string;
  appName?: string | undefined;
  superadmin?: string | undefined;
  interpreters: Map<string, PluginEntry>;
  libraries: Map<string, PluginEntry>;
  networkLexicons: string[];
  labels: string[];
  lexicons: Map<string, { backfill?: boolean; tokenCost?: bigint | number; indexed?: boolean }>;
  scripts: Map<string, { description?: string; outboundXrpcs?: string[] }>;
  modules: Map<string, { language: string; path: string }>;
}

function stringArray(items: string[]): TomlArray {
  const array = new TomlArray();
  for (const item of items) array.push(item);
  return array;
}

/** `ProjectFile::render`. */
export function renderProjectFile(f: ProjectFile): string {
  const doc = baseDoc(f.happyviewVersion, f.appName, f.superadmin, f.interpreters, f.libraries);
  devTable(doc);
  if (f.networkLexicons.length > 0) {
    const t = new Table();
    t.insert("include", value(stringArray(f.networkLexicons)));
    doc.insert("network_lexicons", t);
  }
  if (f.labels.length > 0) {
    const t = new Table();
    t.insert("subscribe", value(stringArray(f.labels)));
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
    sorted(f.lexicons)
      .filter(
        ([, l]) => l.backfill !== undefined || l.tokenCost !== undefined || l.indexed !== undefined,
      )
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
    sorted(f.scripts)
      .filter(([, s]) => s.description !== undefined || s.outboundXrpcs !== undefined)
      .map(([trigger, s]) => {
        const t = new Table();
        if (s.description !== undefined) t.insert("description", value(s.description));
        if (s.outboundXrpcs !== undefined)
          t.insert("outbound_xrpcs", value(stringArray(s.outboundXrpcs)));
        return [trigger, t];
      }),
  );
  keyed(
    "modules",
    sorted(f.modules).map(([name, m]) => {
      const t = new Table();
      t.insert("language", value(m.language));
      t.insert("path", value(m.path));
      return [name, t];
    }),
  );
  return `${HEADER}${doc}`;
}
