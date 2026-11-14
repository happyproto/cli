// A port of `toml_edit` 0.25.17's format-preserving document (the part the hpy CLI uses):
// `DocumentMut` parsing (with `TomlError`'s exact text), `to_string()` byte for byte, the
// table / inline-table / array / item model with decor and positions, and
// `toml_edit::ser::to_document`.
//
// Like the crate, a parsed document keeps every comment and blank line as decor on the nearest
// key, value or table header, and `toString()` writes `\n` after each key-value and header line
// and drops every `\r` from decor (so a CRLF document comes back with LF line ends, except
// inside multi-line string values, whose raw text is kept).

import {
  Cursor,
  type Datetime,
  decodeKey,
  decodeScalar,
  ErrorSink,
  type Event,
  parseDatetime,
  parseDocumentEvents,
  type Ser,
  Source,
  type Span,
  TomlError,
  TomlSerError,
  tomlFloat,
  tomlKey,
  tomlString,
} from "./toml.ts";

// ---------------------------------------------------------------------------------------------
// Decor and keys (repr.rs, key.rs)

/** Whitespace and comments around an element. `undefined` means "use the default". */
export class Decor {
  prefix: string | undefined;
  suffix: string | undefined;

  constructor(prefix?: string, suffix?: string) {
    this.prefix = prefix;
    this.suffix = suffix;
  }

  clone(): Decor {
    return new Decor(this.prefix, this.suffix);
  }

  clear(): void {
    this.prefix = undefined;
    this.suffix = undefined;
  }
}

/** A key, with its source text (`repr`) and the decor around it. */
export class Key {
  readonly key: string;
  repr: string | undefined;
  leafDecor = new Decor();
  dottedDecor = new Decor();
  span: Span | undefined;

  constructor(key: string) {
    this.key = key;
  }

  /** `Key::fmt`: forget the source formatting. */
  fmt(): void {
    this.repr = undefined;
    this.leafDecor.clear();
    this.dottedDecor.clear();
  }

  clone(): Key {
    const k = new Key(this.key);
    k.repr = this.repr;
    k.leafDecor = this.leafDecor.clone();
    k.dottedDecor = this.dottedDecor.clone();
    k.span = this.span;
    return k;
  }

  displayRepr(): string {
    return this.repr ?? tomlKey(this.key);
  }
}

// ---------------------------------------------------------------------------------------------
// Values and items (value.rs, array.rs, inline_table.rs, table.rs, item.rs)

export type ScalarType = "string" | "integer" | "float" | "boolean" | "datetime";

/** `Formatted<T>`: a scalar with its source text and decor. */
export class Formatted {
  readonly type: ScalarType;
  value: string | bigint | number | boolean | Datetime;
  repr: string | undefined;
  decor = new Decor();
  span: Span | undefined;

  constructor(type: ScalarType, value: string | bigint | number | boolean | Datetime) {
    this.type = type;
    this.value = value;
  }

  static string(v: string): Formatted {
    return new Formatted("string", v);
  }
  static integer(v: bigint | number): Formatted {
    return new Formatted("integer", BigInt(v));
  }
  static float(v: number): Formatted {
    return new Formatted("float", v);
  }
  static boolean(v: boolean): Formatted {
    return new Formatted("boolean", v);
  }
  static datetime(v: Datetime): Formatted {
    return new Formatted("datetime", v);
  }

  defaultRepr(): string {
    switch (this.type) {
      case "string":
        return tomlString(this.value as string);
      case "integer":
        return (this.value as bigint).toString();
      case "float":
        return tomlFloat(this.value as number);
      case "boolean":
        return String(this.value);
      case "datetime":
        return (this.value as Datetime).toString();
    }
  }

  displayRepr(): string {
    return this.repr ?? this.defaultRepr();
  }

  clone(): Formatted {
    const f = new Formatted(this.type, this.value);
    f.repr = this.repr;
    f.decor = this.decor.clone();
    f.span = this.span;
    return f;
  }
}

/** `toml_edit::Array`. */
export class TomlArray {
  values: Value[] = [];
  trailing = "";
  trailingComma = false;
  decor = new Decor();
  span: Span | undefined;

  /** `TomlArray::push`: appended with default formatting. */
  push(v: Value | string | boolean | bigint | number): void {
    this.values.push(toValue(v));
  }

  get length(): number {
    return this.values.length;
  }

  clone(): TomlArray {
    const a = new TomlArray();
    a.values = this.values.map(cloneValue);
    a.trailing = this.trailing;
    a.trailingComma = this.trailingComma;
    a.decor = this.decor.clone();
    a.span = this.span;
    return a;
  }
}

interface KeyItem<I> {
  key: Key;
  item: I;
}

/** The `Item::None` placeholder `doc["k"]` inserts before assignment. */
export const NONE = Object.freeze({ none: true as const });
export type ItemNone = typeof NONE;

/** `toml_edit::Item`. */
export type Item = Value | Table | ArrayOfTables | ItemNone;
/** `toml_edit::Value`. */
export type Value = Formatted | TomlArray | InlineTable;

/** `toml_edit::InlineTable`. Its entries are `Item`s like a table's, as in the crate. */
export class InlineTable {
  items = new Map<string, KeyItem<Item>>();
  trailing = "";
  trailingComma = false;
  decor = new Decor();
  implicit = false;
  dotted = false;
  span: Span | undefined;

  get(key: string): Item | undefined {
    const e = this.items.get(key);
    return e && e.item !== NONE ? e.item : undefined;
  }

  /** `InlineTable::insert`: an existing key keeps its place but loses its formatting. */
  insert(key: string, value: Value | string | boolean | bigint | number): Value | undefined {
    const v = toValue(value);
    const existing = this.items.get(key);
    if (existing) {
      existing.key.fmt();
      const old = existing.item;
      existing.item = v;
      return isValue(old) ? old : undefined;
    }
    this.items.set(key, { key: new Key(key), item: v });
    return undefined;
  }

  iter(): [string, Item][] {
    return [...this.items.values()].filter((e) => e.item !== NONE).map((e) => [e.key.key, e.item]);
  }

  get size(): number {
    return this.iter().length;
  }

  /** `get_values`: the key paths and values, dotted tables flattened. */
  getValues(): [Key[], Value][] {
    const out: [Key[], Value][] = [];
    appendInlineValues(this, [], out);
    return out;
  }

  clone(): InlineTable {
    const t = new InlineTable();
    for (const [k, e] of this.items)
      t.items.set(k, { key: e.key.clone(), item: cloneItem(e.item) });
    t.trailing = this.trailing;
    t.trailingComma = this.trailingComma;
    t.decor = this.decor.clone();
    t.implicit = this.implicit;
    t.dotted = this.dotted;
    t.span = this.span;
    return t;
  }

  /** `InlineTable::into_table`. */
  intoTable(): Table {
    const t = new Table();
    t.items = this.items;
    t.fmt();
    return t;
  }
}

/** `toml_edit::Table`. */
export class Table {
  items = new Map<string, KeyItem<Item>>();
  decor = new Decor();
  implicit = false;
  dotted = false;
  position: number | undefined;
  span: Span | undefined;

  get(key: string): Item | undefined {
    const e = this.items.get(key);
    return e && e.item !== NONE ? e.item : undefined;
  }

  containsKey(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** `Table::insert`: an existing key keeps its place but loses its formatting. */
  insert(key: string, item: Item): Item | undefined {
    const existing = this.items.get(key);
    if (existing) {
      existing.key.fmt();
      const old = existing.item;
      existing.item = item;
      return old;
    }
    this.items.set(key, { key: new Key(key), item });
    return undefined;
  }

  /** `table.entry(key).or_insert_with(f)`. */
  orInsertWith(key: string, make: () => Item): Item {
    const existing = this.items.get(key);
    if (existing) return existing.item;
    const item = make();
    this.items.set(key, { key: new Key(key), item });
    return item;
  }

  /** `table[key] = item` (`IndexMut`): an existing key keeps its place and formatting. */
  set(key: string, item: Item): void {
    const existing = this.items.get(key);
    if (existing) existing.item = item;
    else this.items.set(key, { key: new Key(key), item });
  }

  remove(key: string): Item | undefined {
    const e = this.items.get(key);
    this.items.delete(key);
    return e?.item;
  }

  iter(): [string, Item][] {
    return [...this.items.values()].filter((e) => e.item !== NONE).map((e) => [e.key.key, e.item]);
  }

  get size(): number {
    return this.iter().length;
  }

  setImplicit(yes: boolean): void {
    this.implicit = yes;
  }

  setPosition(position: number | undefined): void {
    this.position = position;
  }

  /** `Table::fmt`: forget the formatting of every key-value. */
  fmt(): void {
    for (const e of this.items.values()) {
      if (isValue(e.item)) {
        e.key.leafDecor.clear();
        e.key.dottedDecor.clear();
        e.item.decor.clear();
      }
    }
  }

  getValues(): [Key[], Value][] {
    const out: [Key[], Value][] = [];
    appendTableValues(this, [], out);
    return out;
  }

  clone(): Table {
    const t = new Table();
    for (const [k, e] of this.items)
      t.items.set(k, { key: e.key.clone(), item: cloneItem(e.item) });
    t.decor = this.decor.clone();
    t.implicit = this.implicit;
    t.dotted = this.dotted;
    t.position = this.position;
    t.span = this.span;
    return t;
  }
}

/** `toml_edit::ArrayOfTables`. */
export class ArrayOfTables {
  values: Table[] = [];
  span: Span | undefined;

  clone(): ArrayOfTables {
    const a = new ArrayOfTables();
    a.values = this.values.map((t) => t.clone());
    a.span = this.span;
    return a;
  }
}

export function isValue(item: Item | undefined): item is Value {
  return item instanceof Formatted || item instanceof TomlArray || item instanceof InlineTable;
}

/** `Item::as_table_like`: a table or an inline table. */
export function asTableLike(item: Item | undefined): Table | InlineTable | undefined {
  return item instanceof Table || item instanceof InlineTable ? item : undefined;
}

/** `TableLike::insert` for either kind (an inline table can only hold values). */
export function tableLikeInsert(t: Table | InlineTable, key: string, item: Item): Item | undefined {
  if (t instanceof Table) return t.insert(key, item);
  const v = intoValue(item);
  if (!v) throw new Error("an inline table holds only values");
  return t.insert(key, v);
}

/** `Item::into_value`. */
function intoValue(item: Item): Value | undefined {
  if (isValue(item)) return item;
  if (item instanceof Table) return tableIntoInline(item);
  if (item instanceof ArrayOfTables) {
    const a = new TomlArray();
    for (const t of item.values) a.values.push(tableIntoInline(t));
    return a;
  }
  return undefined;
}

function tableIntoInline(t: Table): InlineTable {
  const it = new InlineTable();
  for (const [k, e] of t.items) {
    const v = intoValue(e.item);
    it.items.set(k, { key: e.key, item: v ?? NONE });
  }
  for (const e of it.items.values()) {
    if (isValue(e.item)) {
      e.key.leafDecor.clear();
      e.key.dottedDecor.clear();
      e.item.decor.clear();
    }
  }
  return it;
}

function cloneValue(v: Value): Value {
  return v.clone();
}

function isNone(i: Item | undefined): i is ItemNone {
  return i === NONE;
}

function cloneItem(i: Item): Item {
  return isNone(i) ? NONE : i.clone();
}

function toValue(v: Value | string | boolean | bigint | number): Value {
  if (typeof v === "string") return Formatted.string(v);
  if (typeof v === "boolean") return Formatted.boolean(v);
  if (typeof v === "bigint") return Formatted.integer(v);
  if (typeof v === "number") return Number.isInteger(v) ? Formatted.integer(v) : Formatted.float(v);
  return v;
}

/** `toml_edit::value(v)`: an `Item::Value`. A JS integer `number` becomes an i64. */
export function value(v: Value | string | boolean | bigint | number): Item {
  return toValue(v);
}

function appendTableValues(t: Table, path: Key[], out: [Key[], Value][]): void {
  for (const e of t.items.values()) {
    path.push(e.key);
    const item = e.item;
    if (item instanceof Table && item.dotted) {
      appendTableValues(item, path, out);
    } else if (isValue(item)) {
      if (item instanceof InlineTable && item.dotted) appendInlineValues(item, path, out);
      else out.push([[...path], item]);
    }
    path.pop();
  }
}

function appendAllValues(t: Table, path: Key[], out: [Key[], Value][]): void {
  for (const e of t.items.values()) {
    path.push(e.key);
    const item = e.item;
    if (item instanceof Table) {
      appendAllValues(item, path, out);
    } else if (isValue(item)) {
      if (item instanceof InlineTable && item.dotted) appendInlineValues(item, path, out);
      else out.push([[...path], item]);
    }
    path.pop();
  }
}

function appendInlineValues(t: InlineTable, path: Key[], out: [Key[], Value][]): void {
  for (const e of t.items.values()) {
    path.push(e.key);
    const item = e.item;
    if (item instanceof InlineTable && item.dotted) appendInlineValues(item, path, out);
    else if (isValue(item)) out.push([[...path], item]);
    else if (item instanceof Table) appendAllValues(item, path, out);
    path.pop();
  }
}

// ---------------------------------------------------------------------------------------------
// DocumentMut (document.rs) and its Display (encode.rs)

const DEFAULT_KEY_DECOR: [string, string] = ["", " "];
const DEFAULT_TABLE_DECOR: [string, string] = ["\n", ""];
const DEFAULT_KEY_PATH_DECOR: [string, string] = ["", ""];
const DEFAULT_INLINE_KEY_DECOR: [string, string] = [" ", " "];
const DEFAULT_VALUE_DECOR: [string, string] = [" ", ""];
const DEFAULT_TRAILING_VALUE_DECOR: [string, string] = [" ", " "];
const DEFAULT_LEADING_VALUE_DECOR: [string, string] = ["", ""];

/** `RawString::encode_with_default`: every `\r` is dropped. */
const raw = (s: string): string => s.replaceAll("\r", "");
const prefixOf = (d: Decor, def: string): string => (d.prefix === undefined ? def : raw(d.prefix));
const suffixOf = (d: Decor, def: string): string => (d.suffix === undefined ? def : raw(d.suffix));

function encodeKeyPath(keys: Key[], def: [string, string], leaf: Decor): string {
  let out = "";
  keys.forEach((key, i) => {
    const last = i + 1 === keys.length;
    if (i === 0) out += prefixOf(leaf, def[0]);
    else out += `.${prefixOf(key.dottedDecor, DEFAULT_KEY_PATH_DECOR[0])}`;
    out += key.displayRepr();
    out += last ? suffixOf(leaf, def[1]) : suffixOf(key.dottedDecor, DEFAULT_KEY_PATH_DECOR[1]);
  });
  return out;
}

export function encodeValue(v: Value, def: [string, string]): string {
  let out = prefixOf(v.decor, def[0]);
  if (v instanceof Formatted) {
    out += v.displayRepr();
  } else if (v instanceof TomlArray) {
    out += "[";
    v.values.forEach((el, i) => {
      if (i > 0) out += ",";
      out += encodeValue(el, i === 0 ? DEFAULT_LEADING_VALUE_DECOR : DEFAULT_VALUE_DECOR);
    });
    if (v.trailingComma && v.values.length > 0) out += ",";
    out += `${raw(v.trailing)}]`;
  } else {
    out += "{";
    const children = v.getValues();
    children.forEach(([path, value], i) => {
      if (i > 0) out += ",";
      const inner = i === children.length - 1 ? DEFAULT_TRAILING_VALUE_DECOR : DEFAULT_VALUE_DECOR;
      out += encodeKeyPath(path, DEFAULT_INLINE_KEY_DECOR, path[path.length - 1]!.leafDecor);
      out += `=${encodeValue(value, inner)}`;
    });
    if (v.trailingComma && v.items.size > 0) out += ",";
    out += `${raw(v.trailing)}}`;
  }
  return out + suffixOf(v.decor, def[1]);
}

/** `toml_edit::DocumentMut`. */
export class DocumentMut {
  root: Table;
  trailing = "";

  constructor(root?: Table) {
    if (root) {
      this.root = root;
    } else {
      this.root = new Table();
      this.root.position = 0;
    }
  }

  /** `text.parse::<DocumentMut>()`. Throws `TomlError`. */
  static parse(text: string): DocumentMut {
    return parseDocument(text);
  }

  get(key: string): Item | undefined {
    return this.root.get(key);
  }

  insert(key: string, item: Item): Item | undefined {
    return this.root.insert(key, item);
  }

  orInsertWith(key: string, make: () => Item): Item {
    return this.root.orInsertWith(key, make);
  }

  /** `doc[key] = item`. */
  set(key: string, item: Item): void {
    this.root.set(key, item);
  }

  toString(): string {
    let out = prefixOf(this.root.decor, "");
    const tables: [number, Table, Key[], boolean][] = [];
    let lastPosition = 0;
    const visit = (t: Table, path: Key[], isArray: boolean): void => {
      if (!t.dotted) {
        if (t.position !== undefined) lastPosition = t.position;
        tables.push([lastPosition, t, [...path], isArray]);
      }
      for (const e of t.items.values()) {
        if (e.item instanceof Table) {
          path.push(e.key);
          visit(e.item, path, false);
          path.pop();
        } else if (e.item instanceof ArrayOfTables) {
          for (const at of e.item.values) {
            path.push(e.key);
            visit(at, path, true);
            path.pop();
          }
        }
      }
    };
    visit(this.root, [], false);
    const order = tables.map((t, i) => [t, i] as const);
    order.sort(([a, ai], [b, bi]) => {
      const ka = a[2].length > 0 ? 1 : 0;
      const kb = b[2].length > 0 ? 1 : 0;
      return ka - kb || a[0] - b[0] || ai - bi;
    });
    let first = true;
    for (const [[, table, path, isArray]] of order) {
      const children = table.getValues();
      const visible = !(table.implicit && children.length === 0);
      if (path.length === 0) {
        if (children.length > 0) first = false;
      } else if (isArray || visible) {
        const def: [string, string] = first ? ["", DEFAULT_TABLE_DECOR[1]] : DEFAULT_TABLE_DECOR;
        first = false;
        const leaf = path[path.length - 1]!.leafDecor;
        const extract = leaf.prefix?.includes("\n") === true;
        if (extract) out += prefixOf(leaf, DEFAULT_KEY_PATH_DECOR[0]);
        out += prefixOf(table.decor, def[0]);
        out += isArray ? "[[" : "[";
        out += encodeKeyPath(path, DEFAULT_KEY_PATH_DECOR, extract ? new Decor() : leaf);
        out += isArray ? "]]" : "]";
        out += `${suffixOf(table.decor, def[1])}\n`;
      }
      for (const [keys, v] of children) {
        out += encodeKeyPath(keys, DEFAULT_KEY_DECOR, keys[keys.length - 1]!.leafDecor);
        out += `=${encodeValue(v, DEFAULT_VALUE_DECOR)}\n`;
      }
    }
    out += suffixOf(this.root.decor, "");
    return out + raw(this.trailing);
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing (toml_edit parser/*.rs)

interface Header {
  path: Key[];
  key: Key | undefined;
  span: Span;
  isArray: boolean;
}

class EditBuilder {
  private readonly source: Source;
  private readonly err: ErrorSink;
  private readonly input: Cursor<Event>;

  constructor(source: Source, events: Event[], err: ErrorSink) {
    this.source = source;
    this.err = err;
    this.input = new Cursor(events);
  }

  private str(s: Span | undefined): string {
    return s ? this.source.str(s[0], s[1]) : "";
  }

  document(): DocumentMut {
    const input = this.input;
    let root = new Table();
    let current = new Table();
    let trailing: Span | undefined;
    let header: Header | undefined;
    let position = 0;
    const takeTrailing = (): string => {
      const t = trailing;
      trailing = undefined;
      return this.str(t);
    };
    const finishTable = (): void => {
      const prev = current;
      current = new Table();
      if (!header) {
        prev.span = [0, 0];
        root = prev;
        return;
      }
      const h = header;
      header = undefined;
      if (!h.key) return;
      prev.span = h.span;
      const parent = this.descend(root, h.path, false);
      if (!parent) return;
      if (h.isArray) {
        let entry = parent.items.get(h.key.key);
        if (!entry) {
          entry = { key: h.key, item: new ArrayOfTables() };
          parent.items.set(h.key.key, entry);
        }
        const aot = entry.item;
        if (!(aot instanceof ArrayOfTables)) {
          this.err.report({
            description: "duplicate key",
            unexpected: h.key.span!,
            context: itemSpan(aot) ?? [0, 0],
          });
          return;
        }
        aot.values.push(prev);
      } else {
        const existing = parent.items.get(h.key.key);
        if (existing) existing.item = prev;
        else parent.items.set(h.key.key, { key: h.key, item: prev });
      }
    };
    const startTable = (h: Header, decor: Decor): void => {
      if (!h.isArray) {
        const parent = this.descend(root, h.path, false);
        if (parent && h.key) {
          const old = parent.items.get(h.key.key);
          if (old) {
            parent.items.delete(h.key.key);
            const v = old.item;
            if (v instanceof Table && v.implicit && !v.dotted) {
              current = v;
            } else {
              this.err.report({
                description: "duplicate key",
                unexpected: h.key.span!,
                context: old.key.span!,
              });
              if (v instanceof Table) current = v;
            }
          }
        }
      }
      position += 1;
      current.decor = decor;
      current.implicit = false;
      current.dotted = false;
      current.position = position;
      current.span = h.span;
      header = h;
    };
    events: for (let event = input.next(); event; event = input.next()) {
      switch (event.kind) {
        case "stdTableOpen":
        case "arrayTableOpen": {
          finishTable();
          const prefix = takeTrailing();
          const h = this.onTable(event);
          const suffix = this.str(this.wsCommentNewline());
          startTable(h, new Decor(prefix, suffix));
          break;
        }
        case "simpleKey": {
          const keyPrefix = takeTrailing();
          const [path, key] = this.onKey(event);
          if (!key) break events;
          let next = input.next();
          if (!next) break events;
          let keySuffix: Event | undefined;
          if (next.kind === "whitespace") {
            keySuffix = next;
            next = input.next();
            if (!next) break events;
          }
          if (next.kind !== "keyValSep") break events;
          key.leafDecor = new Decor(
            keyPrefix,
            keySuffix ? this.str([keySuffix.start, keySuffix.end]) : "",
          );
          let valuePrefix = "";
          if (input.first()?.kind === "whitespace") {
            const ws = input.next()!;
            valuePrefix = this.str([ws.start, ws.end]);
          }
          const v = this.value();
          const valueSuffix = this.str(this.wsCommentNewline());
          v.decor = new Decor(valuePrefix, valueSuffix);
          this.captureKeyValue(current, path, key, v);
          break;
        }
        case "whitespace":
        case "comment":
        case "newline":
          trailing = trailing ? [trailing[0], event.end] : [event.start, event.end];
          break;
        default:
          break;
      }
    }
    finishTable();
    const doc = new DocumentMut(root);
    doc.trailing = takeTrailing();
    return doc;
  }

  private wsCommentNewline(): Span | undefined {
    let span: Span | undefined;
    for (let event = this.input.next(); event; event = this.input.next()) {
      if (event.kind === "whitespace" || event.kind === "comment") {
        span = span ? [span[0], event.end] : [event.start, event.end];
      } else if (event.kind === "newline") {
        break;
      }
    }
    return span;
  }

  private onTable(open: Event): Header {
    const isArray = open.kind === "arrayTableOpen";
    let path: Key[] = [];
    let key: Key | undefined;
    let span: Span = [open.start, open.end];
    let prefix: Span | undefined;
    let suffix: Span | undefined;
    for (let event = this.input.next(); event; event = this.input.next()) {
      if (event.kind === "arrayTableClose" || event.kind === "stdTableClose") {
        span = [span[0], event.end];
        break;
      }
      if (event.kind === "simpleKey") {
        prefix ??= [event.start, event.start];
        [path, key] = this.onKey(event);
        suffix ??= [event.end, event.end];
      } else if (event.kind === "whitespace") {
        if (key) suffix = [event.start, event.end];
        else prefix = [event.start, event.end];
      }
    }
    if (key) key.leafDecor = new Decor(this.str(prefix), this.str(suffix));
    return { path, key, span, isArray };
  }

  /** parser/key.rs `on_key`. */
  private onKey(first: Event): [Key[], Key | undefined] {
    const input = this.input;
    const path: Key[] = [];
    let last: Key | undefined;
    let current: Event | undefined = first;
    let prefix: Span | undefined;
    let suffix: Span | undefined;
    const more = (): boolean => {
      const a = input.get(0)?.kind;
      return a === "keySep" || (a === "whitespace" && input.get(1)?.kind === "keySep");
    };
    const close = (): void => {
      if (!current) return;
      const k = current;
      current = undefined;
      const p = prefix ?? [k.start, k.start];
      const s = suffix ?? [k.end, k.end];
      prefix = undefined;
      suffix = undefined;
      const decoded = decodeKey(this.source, [k.start, k.end], k.encoding, this.err);
      const key = new Key(decoded);
      key.repr = this.str([k.start, k.end]);
      key.span = [k.start, k.end];
      key.dottedDecor = new Decor(this.str(p), this.str(s));
      if (last) path.push(last);
      last = key;
    };
    if (more()) {
      for (let event = input.next(); event; event = input.next()) {
        if (event.kind === "simpleKey") {
          current = event;
          if (!more()) break;
        } else if (event.kind === "whitespace") {
          if (current) suffix = [event.start, event.end];
          else prefix = [event.start, event.end];
        } else if (event.kind === "keySep") {
          close();
        }
      }
    }
    close();
    if (80 <= path.length) {
      this.err.report({ description: "recursion limit" });
      return [[], undefined];
    }
    return [path, last];
  }

  private captureKeyValue(current: Table, path: Key[], key: Key, v: Value): void {
    const dotted = path.length > 0;
    const parent = this.descend(current, path, dotted);
    if (!parent) return;
    if (dotted && !parent.implicit) {
      this.err.report({ description: "duplicate key", unexpected: key.span! });
      return;
    }
    const existing = parent.items.get(key.key);
    if (existing) {
      this.err.report({
        description: "duplicate key",
        unexpected: key.span!,
        context: existing.key.span!,
      });
    } else {
      parent.items.set(key.key, { key, item: v });
    }
  }

  private descend(table: Table, path: Key[], dotted: boolean): Table | undefined {
    let t = table;
    for (const key of path) {
      const entry = t.items.get(key.key);
      if (!entry) {
        const nt = new Table();
        nt.span = key.span;
        nt.implicit = true;
        nt.dotted = dotted;
        t.items.set(key.key, { key: key.clone(), item: nt });
        t = nt;
        continue;
      }
      const item = entry.item;
      if (item instanceof ArrayOfTables) {
        t = item.values[item.values.length - 1]!;
      } else if (item instanceof Table) {
        if (dotted && item.implicit) item.dotted = true;
        if (dotted && !item.implicit) {
          this.err.report({ description: "duplicate key", unexpected: key.span! });
          return undefined;
        }
        t = item;
      } else if (isValue(item)) {
        this.err.report({
          description: `cannot extend value of type ${valueTypeName(item)} with a dotted key`,
          unexpected: key.span!,
          context: item.span ?? [0, 0],
        });
        return undefined;
      } else {
        return undefined;
      }
    }
    return t;
  }

  private value(): Value {
    const event = this.input.next();
    if (event) {
      if (event.kind === "inlineTableOpen") return this.onInlineTable(event);
      if (event.kind === "arrayOpen") return this.onArray(event);
      if (event.kind === "scalar") return this.onScalar(event);
    }
    const f = Formatted.integer(0);
    f.repr = "";
    f.span = [0, 0];
    return f;
  }

  private onScalar(event: Event): Value {
    const span: Span = [event.start, event.end];
    const [kind, decoded] = decodeScalar(this.source, span, event.encoding, this.err);
    let f: Formatted;
    switch (kind.t) {
      case "string":
        f = Formatted.string(decoded);
        break;
      case "boolean":
        f = Formatted.boolean(kind.value);
        break;
      case "datetime":
        try {
          f = Formatted.datetime(parseDatetime(decoded));
        } catch (e) {
          this.err.report({ description: (e as Error).message, unexpected: span });
          f = Formatted.datetime(parseDatetime("00:00"));
        }
        break;
      case "float": {
        const unsigned = decoded.replace(/^[+-]/, "");
        let n: number;
        if (unsigned === "inf") n = decoded.startsWith("-") ? -Infinity : Infinity;
        else if (unsigned === "nan") n = Number.NaN;
        else
          n = /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(decoded)
            ? Number(decoded)
            : Number.NaN;
        if (Number.isNaN(n) && unsigned !== "nan") {
          this.err.report({ description: "invalid float", unexpected: span });
        } else if (!Number.isFinite(n) && !Number.isNaN(n) && !/^[a-zA-Z]*$/.test(unsigned)) {
          this.err.report({ description: "floating-point number overflowed", unexpected: span });
        }
        f = Formatted.float(n);
        break;
      }
      case "integer": {
        let n: bigint | undefined;
        let digits = decoded;
        let sign = 1n;
        if (digits.startsWith("+") || digits.startsWith("-")) {
          if (digits[0] === "-") sign = -1n;
          digits = digits.slice(1);
        }
        try {
          const prefix =
            kind.radix === 16 ? "0x" : kind.radix === 8 ? "0o" : kind.radix === 2 ? "0b" : "";
          if (digits.length > 0) n = sign * BigInt(prefix + digits);
        } catch {
          n = undefined;
        }
        if (n === undefined || n < -(2n ** 63n) || n > 2n ** 63n - 1n) {
          this.err.report({ description: "integer number overflowed", unexpected: span });
          n = 2n ** 63n - 1n;
        }
        f = Formatted.integer(n);
        break;
      }
    }
    f.repr = this.str(span);
    f.span = span;
    return f;
  }

  private onArray(open: Event): Value {
    const result = new TomlArray();
    let close = open;
    let prefix: Span | undefined;
    let suffix: Span | undefined;
    let current: Value | undefined;
    let trailingStart: number | undefined = open.end;
    const capture = (event: Event, v: Value): void => {
      trailingStart = undefined;
      prefix ??= [event.start, event.start];
      current = v;
    };
    const finish = (event: Event): void => {
      if (!current) return;
      const v = current;
      current = undefined;
      const p = prefix!;
      const s = suffix ?? [event.start, event.start];
      prefix = undefined;
      suffix = undefined;
      v.decor = new Decor(this.str(p), this.str(s));
      result.values.push(v);
    };
    let closed = false;
    for (let event = this.input.next(); event; event = this.input.next()) {
      close = event;
      let stop = false;
      switch (event.kind) {
        case "stdTableOpen":
        case "arrayTableOpen":
        case "inlineTableClose":
        case "simpleKey":
        case "keySep":
        case "keyValSep":
        case "stdTableClose":
        case "arrayTableClose":
          stop = true;
          break;
        case "error":
          break;
        case "inlineTableOpen":
          capture(event, this.onInlineTable(event));
          break;
        case "arrayOpen":
          capture(event, this.onArray(event));
          break;
        case "scalar":
          capture(event, this.onScalar(event));
          break;
        case "valueSep":
          finish(event);
          trailingStart = event.end;
          break;
        case "whitespace":
        case "comment":
        case "newline":
          if (current === undefined)
            prefix = prefix ? [prefix[0], event.end] : [event.start, event.end];
          else suffix = suffix ? [suffix[0], event.end] : [event.start, event.end];
          break;
        case "arrayClose":
          finish(event);
          result.trailingComma = trailingStart !== undefined && result.values.length > 0;
          result.trailing = this.str([trailingStart ?? event.start, event.start]);
          result.span = [open.start, event.end];
          closed = true;
          stop = true;
          break;
      }
      if (stop) break;
    }
    if (!closed) result.span = [open.start, close.end];
    return result;
  }

  private onInlineTable(open: Event): Value {
    const result = new InlineTable();
    let close = open;
    let prefix: Span | undefined;
    let suffix: Span | undefined;
    let currentKey: [Key[], Key] | undefined;
    let seenSep = false;
    let currentValue: Value | undefined;
    let trailingStart: number | undefined = open.end;
    const isPrefix = (): boolean =>
      seenSep ? currentValue === undefined : currentKey === undefined;
    const finishValue = (event: Event): void => {
      seenSep = false;
      const k = currentKey;
      const v = currentValue;
      currentKey = undefined;
      currentValue = undefined;
      if (!k || !v) return;
      const p = prefix!;
      const s = suffix ?? [event.start, event.start];
      prefix = undefined;
      suffix = undefined;
      const [path, key] = k;
      const table = this.descendInline(result, path);
      if (!table) return;
      v.decor = new Decor(this.str(p), this.str(s));
      if (table.dotted === (path.length === 0)) {
        this.err.report({
          description: "duplicate key",
          unexpected: key.span ?? [event.start, event.end],
        });
        return;
      }
      const existing = table.items.get(key.key);
      if (existing) {
        this.err.report({
          description: "duplicate key",
          unexpected: key.span ?? [event.start, event.end],
          context: existing.key.span ?? [event.start, event.end],
        });
      } else {
        table.items.set(key.key, { key, item: v });
      }
    };
    let closed = false;
    for (let event = this.input.next(); event; event = this.input.next()) {
      close = event;
      let stop = false;
      switch (event.kind) {
        case "stdTableOpen":
        case "arrayTableOpen":
        case "stdTableClose":
        case "arrayClose":
        case "arrayTableClose":
        case "keySep":
          stop = true;
          break;
        case "error":
          break;
        case "simpleKey": {
          const [path, key] = this.onKey(event);
          trailingStart = undefined;
          prefix ??= [event.start, event.start];
          if (key) currentKey = [path, key];
          break;
        }
        case "keyValSep":
          seenSep = true;
          if (currentKey) {
            const p = prefix!;
            const s = suffix ?? [event.start, event.start];
            prefix = undefined;
            suffix = undefined;
            currentKey[1].leafDecor = new Decor(this.str(p), this.str(s));
          }
          break;
        case "inlineTableOpen":
        case "arrayOpen":
        case "scalar": {
          const v =
            event.kind === "inlineTableOpen"
              ? this.onInlineTable(event)
              : event.kind === "arrayOpen"
                ? this.onArray(event)
                : this.onScalar(event);
          prefix ??= [event.start, event.start];
          currentValue = v;
          break;
        }
        case "valueSep":
          finishValue(event);
          trailingStart = event.end;
          break;
        case "whitespace":
        case "comment":
        case "newline":
          if (isPrefix()) prefix = prefix ? [prefix[0], event.end] : [event.start, event.end];
          else suffix = suffix ? [suffix[0], event.end] : [event.start, event.end];
          break;
        case "inlineTableClose":
          finishValue(event);
          result.trailingComma = trailingStart !== undefined && result.items.size > 0;
          result.trailing = this.str([trailingStart ?? event.start, event.start]);
          result.span = [open.start, event.end];
          closed = true;
          stop = true;
          break;
      }
      if (stop) break;
    }
    if (!closed) result.span = [open.start, close.end];
    return result;
  }

  private descendInline(table: InlineTable, path: Key[]): InlineTable | undefined {
    let t = table;
    for (const key of path) {
      const entry = t.items.get(key.key);
      if (!entry) {
        const nt = new InlineTable();
        nt.span = key.span;
        nt.implicit = true;
        nt.dotted = true;
        t.items.set(key.key, { key: key.clone(), item: nt });
        t = nt;
        continue;
      }
      const item = entry.item;
      if (item instanceof InlineTable) {
        if (!item.implicit) {
          this.err.report({ description: "duplicate key", unexpected: key.span! });
          return undefined;
        }
        t = item;
      } else {
        this.err.report({
          description: `cannot extend value of type ${isValue(item) ? valueTypeName(item) : "table"} with a dotted key`,
          unexpected: key.span!,
        });
        return undefined;
      }
    }
    return t;
  }
}

function itemSpan(item: Item): Span | undefined {
  if (isNone(item)) return undefined;
  if (item instanceof ArrayOfTables) {
    const first = item.values[0]?.span;
    const last = item.values[item.values.length - 1]?.span;
    return first && last ? [first[0], last[1]] : undefined;
  }
  return item.span;
}

/** `Value::type_name`. */
export function valueTypeName(v: Value): string {
  if (v instanceof TomlArray) return "array";
  if (v instanceof InlineTable) return "inline table";
  return v.type;
}

function parseDocument(text: string): DocumentMut {
  const source = new Source(text);
  const err = new ErrorSink();
  const events = parseDocumentEvents(source, err);
  const doc = new EditBuilder(source, events, err).document();
  if (err.first) throw TomlError.fromParse(source, err.first);
  return doc;
}

// ---------------------------------------------------------------------------------------------
// toml_edit::ser::to_document (ser/*.rs)

function serValue(v: Ser): Value | undefined {
  switch (v.k) {
    case "none":
      return undefined;
    case "bool":
      return Formatted.boolean(v.v);
    case "int":
      return Formatted.integer(v.v);
    case "float":
      return Formatted.float(v.v);
    case "str":
    case "unitVariant":
      return Formatted.string(v.v);
    case "datetime":
      return Formatted.datetime(v.v);
    case "seq": {
      const a = new TomlArray();
      for (const el of v.v) {
        const x = serValue(el);
        if (!x) throw new TomlSerError("unsupported None value");
        a.values.push(x);
      }
      return a;
    }
    case "map":
    case "struct": {
      const t = new InlineTable();
      for (const [key, el] of v.v) {
        const x = serValue(el);
        if (x) t.items.set(key, { key: new Key(key), item: x });
      }
      return t;
    }
  }
}

/** `toml_edit::ser::to_document`: a struct or map becomes the root table, values inline. */
export function toDocument(v: Ser): DocumentMut {
  const value = serValue(v);
  if (!value) throw new TomlSerError("unsupported None value");
  if (!(value instanceof InlineTable)) throw new TomlSerError("unsupported rust type");
  return new DocumentMut(value.intoTable());
}
