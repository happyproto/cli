// hpy-project/src/config.rs: the parts of `happyview.toml` that `hpy` reads and writes: the
// HappyView version and the plugins. HappyView reads the whole file; everything else in it
// passes through `hpy` untouched.
//
// How the Rust types map (the rest of src/project follows the same rules):
// - Unit-only enums are string unions: `PluginKind` is "interpreter" | "library", which is also
//   its serde form. Its methods are on the `PluginKind` object (`PluginKind.table(kind)`).
// - `Pin` is a tagged object: `{ kind: "channel", channel }` or `{ kind: "version", version }`;
//   `Pin.channel(c)` and `Pin.version(v)` build one.
// - Structs serde reads or writes keep their Rust field names (snake_case); the others are
//   camelCased. A `BTreeMap` is a `Map`, iterated in Rust's key order wherever order matters.
// - Where Rust returns `Problem`, these throw `Problem` (src/plugin/problem.ts); an
//   `io::Result` throws `IoError` (src/core/io.ts), whose message is Rust's `io::Error` Display.
import {
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { IoError, readToString, toIoError } from "../core/io.ts";
import { rustFileName, rustJoin, rustParent, rustWithFileName } from "../core/paths.ts";
import { Version, VersionReq } from "../core/semver.ts";
import {
  bool,
  compareKeys,
  type Decoder,
  map,
  optional,
  str,
  struct,
  withDefault,
} from "../core/serde-json.ts";
import { fromStr, TomlError, type TomlValue, tomlValue } from "../core/toml.ts";
import {
  asTableLike,
  DocumentMut,
  InlineTable,
  type Item,
  isValue,
  Table,
  tableLikeInsert,
} from "../core/toml-edit.ts";
import { TRACKS } from "../plugin/nsid.ts";
import { Problem } from "../plugin/problem.ts";
import { isDid, isProjectName, projectUri, versionProblem } from "../plugin/validate.ts";

export const CONFIG_FILE = "happyview.toml";

export type PluginKind = "interpreter" | "library";

export const PluginKind = {
  /** The `happyview.toml` table that lists this kind. */
  table(kind: PluginKind): "interpreters" | "libraries" {
    return kind === "interpreter" ? "interpreters" : "libraries";
  },
  /** The registry's `pluginType` for this kind. */
  pluginType(kind: PluginKind): "interpreter" | "library" {
    return kind;
  },
  /** `Ord`: interpreters before libraries. */
  compare(a: PluginKind, b: PluginKind): number {
    return a === b ? 0 : a === "interpreter" ? -1 : 1;
  },
} as const;

/** How an entry chooses its version: a channel the publisher moves, or one exact version. */
export type Pin = { kind: "channel"; channel: string } | { kind: "version"; version: string };

export const Pin = {
  channel: (channel: string): Pin => ({ kind: "channel", channel }),
  version: (version: string): Pin => ({ kind: "version", version }),
} as const;

/**
 * One `[interpreters]` or `[libraries]` entry: the project that provides it, by its publisher's
 * DID so that no handle change can swap it, and which of its versions to run.
 */
export interface PluginEntry {
  did: string;
  name: string;
  pin: Pin;
}

/** `PluginEntry::project_uri`. */
export function entryProjectUri(entry: PluginEntry): string {
  return projectUri(entry.did, entry.name);
}

/** `PluginEntry::pin_label`: `channel latest` or `version 1.2.0`, for messages. */
export function pinLabel(entry: PluginEntry): string {
  return entry.pin.kind === "channel"
    ? `channel ${entry.pin.channel}`
    : `version ${entry.pin.version}`;
}

export interface HappyviewTable {
  version?: string | undefined;
}

/** `[dev]`: HappyView reads all of it; `hpy` reads `backfill` to pass it on to an instance it runs itself. */
export interface DevTable {
  backfill: boolean;
}

export interface Requirement {
  kind: PluginKind;
  key: string;
  entry: PluginEntry;
}

// --- serde ---

/** `RawToml`: the file as written, before its plugin entries are checked one by one. */
export interface RawToml {
  happyview: HappyviewTable;
  interpreters: Map<string, TomlValue>;
  libraries: Map<string, TomlValue>;
  dev: DevTable;
}

const HAPPYVIEW_TABLE: Decoder<HappyviewTable> = struct("HappyviewTable", {
  version: optional(str),
});
const DEV_TABLE: Decoder<DevTable> = struct("DevTable", { backfill: withDefault(bool, false) });

export const RAW_TOML: Decoder<RawToml> = struct("RawToml", {
  happyview: withDefault(HAPPYVIEW_TABLE, () => ({ version: undefined })),
  interpreters: withDefault(map(tomlValue), () => new Map<string, TomlValue>()),
  libraries: withDefault(map(tomlValue), () => new Map<string, TomlValue>()),
  dev: withDefault(DEV_TABLE, () => ({ backfill: false })),
});

/** The table form, as `hpy happyview add` writes it. */
const ENTRY_FORM =
  '{ did = "did:plc:…", name = "<project>", channel = "latest" } (or version = "1.2.0" in place of channel)';

/** `parse_entry`: reads one entry, naming it in every refusal so the author can find it. */
function parseEntry(kind: PluginKind, key: string, value: TomlValue): PluginEntry {
  const path = `${PluginKind.table(kind)}.${key}`;
  const problem = (m: string) => new Problem(path, m);
  if (value.type === "string") {
    // The version strings an older hpy wrote resolved by name through a registry that no
    // longer exists, so they cannot be read as before.
    throw problem(
      `is a version string, which the software.release registry replaced; write it as ${key} = ${ENTRY_FORM}`,
    );
  }
  if (value.type !== "table") throw problem(`must be a table: ${key} = ${ENTRY_FORM}`);
  const table = value.value;
  const text = (field: string): string | undefined => {
    const v = table.get(field);
    if (v === undefined) return undefined;
    if (v.type === "string") return v.value;
    throw problem(`\`${field}\` must be a string`);
  };
  // A `toml::Table` iterates in key order, so the first unknown key is the first sorted.
  for (const k of table.keys()) {
    if (!["did", "name", "channel", "version"].includes(k)) {
      throw problem(`has \`${k}\`, which is not one of did, name, channel or version`);
    }
  }
  const did = text("did");
  if (did === undefined) throw problem("needs `did`, the publisher's DID");
  if (!isDid(did)) throw problem(`\`did\`: \`${did}\` is not a DID`);
  const name = text("name");
  if (name === undefined) throw problem("needs `name`, the project's name");
  if (!isProjectName(name)) {
    throw problem(
      `\`name\`: \`${name}\` is not a project name (lowercase letters, digits and interior \`-\`)`,
    );
  }
  const channel = text("channel");
  const version = text("version");
  let pin: Pin;
  if (channel !== undefined && version !== undefined) {
    throw problem("sets both `channel` and `version`; keep the one that should choose the version");
  } else if (channel === undefined && version === undefined) {
    throw problem("needs `channel` (latest, beta or alpha) or an exact `version`");
  } else if (channel !== undefined) {
    if (!(TRACKS as readonly string[]).includes(channel)) {
      throw problem(`\`channel\`: \`${channel}\` is not one of ${TRACKS.join(", ")}`);
    }
    pin = Pin.channel(channel);
  } else {
    const p = versionProblem(version!);
    if (p !== null) throw problem(`\`version\`: ${p}`);
    pin = Pin.version(version!);
  }
  return { did, name, pin };
}

/** A toml error as the `Problem` Rust maps it to; anything else is a bug and is rethrown. */
export function tomlProblem(path: string, e: unknown): unknown {
  return e instanceof TomlError ? new Problem(path, e.message) : e;
}

export class ProjectToml {
  happyview: HappyviewTable;
  interpreters: Map<string, PluginEntry>;
  libraries: Map<string, PluginEntry>;
  dev: DevTable;

  /** `ProjectToml::default()`, with any fields given. */
  constructor(fields: Partial<ProjectToml> = {}) {
    this.happyview = fields.happyview ?? { version: undefined };
    this.interpreters = fields.interpreters ?? new Map();
    this.libraries = fields.libraries ?? new Map();
    this.dev = fields.dev ?? { backfill: false };
  }

  /** Throws `Problem`. */
  static parse(text: string): ProjectToml {
    let raw: RawToml;
    try {
      raw = fromStr(text, RAW_TOML);
    } catch (e) {
      throw tomlProblem(CONFIG_FILE, e);
    }
    const entries = (kind: PluginKind, table: Map<string, TomlValue>) =>
      new Map([...table].map(([key, value]) => [key, parseEntry(kind, key, value)] as const));
    return new ProjectToml({
      interpreters: entries("interpreter", raw.interpreters),
      libraries: entries("library", raw.libraries),
      happyview: raw.happyview,
      dev: raw.dev,
    });
  }

  /** Throws `Problem`. */
  static load(root: string): ProjectToml {
    let text: string;
    try {
      text = readToString(rustJoin(root, CONFIG_FILE));
    } catch (e) {
      throw new Problem(CONFIG_FILE, `cannot be read: ${toIoError(e).message}`);
    }
    return ProjectToml.parse(text);
  }

  /** Throws `Problem` when `[happyview] version` is missing. */
  happyviewVersion(): string {
    const v = this.happyview.version;
    if (v === undefined) {
      throw new Problem(
        "happyview.version",
        'is required, e.g. `[happyview]` then `version = "3.0.0"`',
      );
    }
    return v;
  }

  /** Interpreters first, then libraries, each in key order. */
  requirements(): Requirement[] {
    const out: Requirement[] = [];
    for (const [kind, table] of [
      ["interpreter", this.interpreters],
      ["library", this.libraries],
    ] as const) {
      for (const [key, entry] of sortedEntries(table)) {
        out.push({ kind, key, entry: clonePluginEntry(entry) });
      }
    }
    return out;
  }
}

function clonePluginEntry(e: PluginEntry): PluginEntry {
  return { did: e.did, name: e.name, pin: { ...e.pin } };
}

/** A `BTreeMap<String, _>`'s order: Rust `String` order, which is UTF-8 byte order. */
export function sortedEntries<T>(m: Map<string, T>): [string, T][] {
  return [...m].sort(([a], [b]) => compareKeys(a, b));
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * `find_root`: the nearest directory at or above `start` holding `happyview.toml`, so a
 * command run from inside `src/` still finds its project. Lexical, as `Path::ancestors` is.
 */
export function findRoot(start: string): string | undefined {
  for (let dir: string | undefined = start; dir !== undefined; dir = rustParent(dir)) {
    if (isFile(rustJoin(dir, CONFIG_FILE))) return dir;
  }
  return undefined;
}

/**
 * `write_if_changed`: replaces `path` with `text` through a temporary file and a rename, so an
 * interrupted write cannot leave a truncated file, and leaves it alone when it already holds
 * `text`, so a watcher sees no change that is not one. A symlinked `path` is written where it
 * points, so the link survives, and the file keeps its mode. Returns whether it wrote; throws
 * `IoError`.
 */
export function writeIfChanged(path: string, text: string): boolean {
  const bytes = Buffer.from(text);
  try {
    if (readFileSync(path).equals(bytes)) return false;
  } catch {
    // Unreadable or absent: write it.
  }
  let target: string;
  let mode: number | undefined;
  try {
    target = realpathSync.native(path);
    try {
      mode = statSync(target).mode;
    } catch (e) {
      throw toIoError(e);
    }
  } catch (e) {
    if (e instanceof IoError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw toIoError(e);
    let link = false;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch {
      link = false;
    }
    if (link) throw new IoError(`${path} is a symlink to a file that does not exist`, "Other");
    target = path;
  }
  const [tmp, fd] = createTempBeside(target, mode);
  try {
    try {
      writeAll(fd, bytes);
      // The umask may have narrowed the mode the file was opened with.
      if (mode !== undefined && process.platform !== "win32") fchmodSync(fd, mode & 0o7777);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw toIoError(e);
  }
  return true;
}

function writeAll(fd: number, bytes: Buffer): void {
  let off = 0;
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
}

/**
 * `create_temp_beside`: a new file beside `target`, under a name nobody else is using, opened
 * so that nothing already at that name (a link included) is followed.
 */
function createTempBeside(target: string, mode: number | undefined): [string, number] {
  const name = rustFileName(target);
  if (name === undefined) throw new IoError(`${target} names no file`, "Other");
  let last: unknown;
  for (let attempt = 0; attempt < 16; attempt++) {
    // `subsec_nanos` of the clock: only the name's uniqueness matters.
    const nanos = Number(process.hrtime.bigint() % 1_000_000_000n);
    const tmp = rustWithFileName(
      target,
      `.${name}.${process.pid}-${attempt}-${nanos.toString(16)}`,
    );
    try {
      const fd = openSync(tmp, "wx", mode === undefined ? 0o666 : mode & 0o7777);
      return [tmp, fd];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") last = e;
      else throw toIoError(e);
    }
  }
  throw last === undefined ? new IoError("no free temporary name", "Other") : toIoError(last);
}

/** `entry_value`: the inline table `happyview.toml` holds for `entry`. */
export function entryValue(entry: PluginEntry): InlineTable {
  const table = new InlineTable();
  table.insert("did", entry.did);
  table.insert("name", entry.name);
  if (entry.pin.kind === "channel") table.insert("channel", entry.pin.channel);
  else table.insert("version", entry.pin.version);
  return table;
}

/**
 * `set_plugin`: `text` with `key = { did, name, channel|version }` in the kind's table and
 * nothing else changed: comments, ordering and a replaced value's trailing comment all survive.
 * Throws `Problem`.
 */
export function setPlugin(text: string, kind: PluginKind, key: string, entry: PluginEntry): string {
  checkEntry(kind, key);
  let doc: DocumentMut;
  try {
    doc = DocumentMut.parse(text);
  } catch (e) {
    throw tomlProblem(CONFIG_FILE, e);
  }
  const name = PluginKind.table(kind);
  const item = doc.orInsertWith(name, () => new Table());
  const table = asTableLike(item);
  if (!table) throw new Problem(name, "must be a table");
  const value = entryValue(entry);
  const old = table.get(key);
  if (isValue(old)) {
    value.decor = old.decor.clone();
    replaceValue(table, key, value);
  } else {
    tableLikeInsert(table, key, value);
  }
  return doc.toString();
}

/** `*old = value` through `get_mut`: the key keeps its formatting. */
function replaceValue(table: Table | InlineTable, key: string, value: Item): void {
  const entry = table.items.get(key)!;
  entry.item = value;
}

/**
 * `check_entry`: HappyView refuses a `happyview.toml` at boot whose `[interpreters]` key is not
 * a language id or whose value is blank, so the rule is mirrored here and no writer can
 * produce a file HappyView rejects. Its source (`config/project.rs`, `IdentifierRule` and
 * `NonEmptyRule`, over `plugin::loader::is_valid_language_id`): an interpreter key is
 * lowercase ASCII letters, digits, `-` or `_` starting with a letter; a library key must be
 * non-empty after trimming.
 */
function checkEntry(kind: PluginKind, key: string): void {
  const path = `${PluginKind.table(kind)}.${key}`;
  if (kind === "interpreter") {
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
      throw new Problem(
        path,
        `'${key}' must be lowercase letters, digits, '-' or '_', starting with a letter`,
      );
    }
  } else if (rustTrim(key) === "") {
    throw new Problem(path, "key must not be empty");
  }
}

/** `str::trim`: Unicode `White_Space`, which `String.prototype.trim` widens with U+FEFF. */
function rustTrim(s: string): string {
  return s.replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
}

/**
 * `version_matches`: whether `version` satisfies `req` in Cargo's dialect, which is the one
 * HappyView's dependency graph and the registry both use. A prerelease matches only a range
 * that itself names a prerelease of the same version, `*` included, so asking for "any"
 * version never lands on an alpha.
 */
export function versionMatches(req: string, version: string): boolean {
  let v: Version;
  try {
    v = Version.parse(version);
  } catch {
    return false;
  }
  try {
    return VersionReq.parse(req).matches(v);
  } catch {
    return false;
  }
}
