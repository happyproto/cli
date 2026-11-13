// A port of the `toml` 1.1.8 crate (with toml_parser 1.1.5, toml_datetime 1.1.2 and
// toml_writer 1.1.3) as the hpy CLI uses it, so that error text and serialized output are
// byte-identical to the Rust binary's:
//
// - `fromStr(text, decoder)` is `toml::from_str::<T>`. The decoders are serde-json.ts's
//   (`struct`, `field`, `optional`, `array`, `map`, ...), driven through serde's protocol by a
//   TOML deserializer, so a decoder written once per Rust struct decodes JSON and TOML alike.
// - `parseTable(text)` is `toml::from_str::<toml::Table>`, `tryInto(value, decoder)` is
//   `Table::try_into::<T>` / `Value::try_into::<T>`.
// - `toTomlString(value, encoder)` / `toTomlStringPretty` are `toml::to_string` /
//   `to_string_pretty`.
//
// Errors are `TomlError`, whose `message` is the crate's `Display`: `TOML parse error at line L,
// column C`, the source line with `^` carets under the span, and the description.
//
// The parser is a straight port of toml_parser's lexer, its error-recovering push parser and its
// decoders. Like the crate it parses the whole document before reporting, and reports the first
// error raised. Offsets are UTF-8 byte offsets, as in Rust.

import {
  compareKeys,
  custom,
  type Decoder,
  DeError,
  type Deserializer,
  type EnumAccess,
  invalidLength,
  invalidType,
  type MapAccess,
  type SeqAccess,
  serdeUnexpected,
  str,
  type VariantAccess,
  type Visitor,
  visitBool,
  visitEnum,
  visitF64,
  visitI64,
  visitMap,
  visitSeq,
  visitSome,
  visitStr,
  visitU64,
  visitUnit,
} from "./serde-json.ts";

// ---------------------------------------------------------------------------------------------
// Source text

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A byte range `[start, end)` into the UTF-8 source. */
export type Span = readonly [number, number];

/** The document as text and as UTF-8 bytes; every offset is into `bytes`. */
export class Source {
  readonly text: string;
  readonly bytes: Uint8Array;

  constructor(text: string) {
    this.text = text;
    this.bytes = encoder.encode(text);
  }

  str(start: number, end: number): string {
    return utf8.decode(this.bytes.subarray(start, end));
  }
}

const decode = (b: Uint8Array): string => utf8.decode(b);

// ---------------------------------------------------------------------------------------------
// Errors (toml_parser error.rs, toml de/error.rs; toml_edit's TomlError is the same type)

/** toml_parser's `Expected`: a literal (rendered in backticks) or a description. */
export type Expected = { lit: string } | { desc: string };

/** toml_parser's `ParseError`. Spans are relative to the document once reported. */
export interface ParseError {
  description: string;
  expected?: readonly Expected[];
  unexpected?: Span;
  context?: Span;
}

const lit = (s: string): Expected => ({ lit: s });
const desc = (s: string): Expected => ({ desc: s });

/** Collects parse errors; the first one is what `from_str` reports. */
export class ErrorSink {
  first: ParseError | undefined;

  report(e: ParseError): void {
    if (!this.first) this.first = e;
  }
}

function renderLiteral(literal: string): string {
  if (literal === "\n") return "newline";
  if (literal === "`") return "'`'";
  // No literal toml_parser expects is all ASCII control characters besides "\n".
  return `\`${literal}\``;
}

function parseErrorMessage(e: ParseError): string {
  let message = e.description;
  if (e.expected) {
    message += ", expected ";
    if (e.expected.length === 0) {
      message += "nothing";
    } else {
      message += e.expected.map((x) => ("lit" in x ? renderLiteral(x.lit) : x.desc)).join(", ");
    }
  }
  return message;
}

/**
 * `toml::de::Error` (and `toml_edit::TomlError`, which is identical). `message` is the Rust
 * `Display`; `description` is Rust's `message()`.
 */
export class TomlError extends Error {
  description: string;
  span: Span | undefined;
  keys: string[];
  private input: Source | undefined;

  constructor(description: string, span?: Span, input?: Source) {
    super(description);
    this.name = "TomlError";
    this.description = description;
    this.span = span;
    this.keys = [];
    this.input = input;
    this.refresh();
  }

  static fromParse(source: Source, e: ParseError): TomlError {
    return new TomlError(parseErrorMessage(e), e.unexpected, source);
  }

  setSpan(span: Span | undefined): void {
    this.span = span;
    this.refresh();
  }

  setInput(input: Source | undefined): void {
    this.input = input;
    this.refresh();
  }

  addKey(key: string): void {
    this.keys.unshift(key);
    this.refresh();
  }

  private refresh(): void {
    this.message = this.display();
  }

  private display(): string {
    let out = "";
    let context = false;
    if (this.input && this.span) {
      context = true;
      const [line, column] = translatePosition(this.input.bytes, this.span[0]);
      const lineNum = line + 1;
      const gutter = String(lineNum).length;
      const content = this.input.text.split("\n")[line] ?? "";
      const contentLen = encoder.encode(content).length;
      const highlight = Math.min(this.span[1] - this.span[0], Math.max(0, contentLen - column));
      out += `TOML parse error at line ${lineNum}, column ${column + 1}\n`;
      out += `${" ".repeat(gutter + 1)}|\n`;
      out += `${lineNum} | ${content}\n`;
      out += `${" ".repeat(gutter + 1)}|${" ".repeat(column + 1)}^${"^".repeat(Math.max(0, highlight - 1))}\n`;
    }
    out += `${this.description}\n`;
    if (!context && this.keys.length > 0) out += `in \`${this.keys.join(".")}\`\n`;
    return out;
  }
}

function translatePosition(input: Uint8Array, index: number): [number, number] {
  if (input.length === 0) return [0, index];
  const safe = Math.min(index, input.length - 1);
  const columnOffset = index - safe;
  let lineStart = 0;
  for (let i = safe - 1; i >= 0; i--) {
    if (input[i] === NL) {
      lineStart = i + 1;
      break;
    }
  }
  let line = 0;
  for (let i = 0; i < lineStart; i++) if (input[i] === NL) line++;
  let column: number;
  try {
    column = [...strictUtf8.decode(input.subarray(lineStart, safe + 1))].length - 1;
  } catch {
    column = safe - lineStart;
  }
  return [line, column + columnOffset];
}

/** A serde `DeError` as toml's error type (no span, no input yet). */
export function asTomlError(e: unknown): unknown {
  return e instanceof DeError ? new TomlError(e.render(serdeUnexpected)) : e;
}

function tomlCustom(message: string, span?: Span): TomlError {
  return new TomlError(message, span);
}

// ---------------------------------------------------------------------------------------------
// Lexer (toml_parser lexer/mod.rs)

const NL = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const QUOTE = 0x22;
const APOS = 0x27;
const BACKSLASH = 0x5c;

/** Token and event kinds share these names where they overlap. */
export type TokenKind =
  | "dot"
  | "equals"
  | "comma"
  | "lbracket"
  | "rbracket"
  | "lbrace"
  | "rbrace"
  | "ws"
  | "comment"
  | "newline"
  | "literal"
  | "basic"
  | "mlliteral"
  | "mlbasic"
  | "atom"
  | "eof";

/** A string token's (or scalar's) encoding; `null` is an unquoted atom. */
export type Encoding = "literal" | "basic" | "mlliteral" | "mlbasic" | null;

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

function tokenEncoding(kind: TokenKind): Encoding {
  switch (kind) {
    case "literal":
    case "basic":
    case "mlliteral":
    case "mlbasic":
      return kind;
    default:
      return null;
  }
}

function startsWith(b: Uint8Array, at: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function findTriple(b: Uint8Array, from: number, c: number): number {
  for (let i = from; i + 2 < b.length; i++) {
    if (b[i] === c && b[i + 1] === c && b[i + 2] === c) return i;
  }
  return -1;
}

const ATOM_END = new Set([0x2e, 0x3d, 0x2c, 0x5b, 0x5d, 0x7b, 0x7d, SPACE, TAB, 0x23, CR, NL]);

export function lex(b: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let i = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  const single: Record<number, TokenKind> = {
    46: "dot",
    61: "equals",
    44: "comma",
    91: "lbracket",
    93: "rbracket",
    123: "lbrace",
    125: "rbrace",
    [NL]: "newline",
  };
  while (i < b.length) {
    const start = i;
    const c = b[i]!;
    let kind: TokenKind;
    if (single[c] !== undefined) {
      kind = single[c]!;
      i += 1;
    } else if (c === SPACE || c === TAB) {
      kind = "ws";
      while (i < b.length && (b[i] === SPACE || b[i] === TAB)) i++;
    } else if (c === 0x23) {
      kind = "comment";
      while (i < b.length && b[i] !== CR && b[i] !== NL) i++;
    } else if (c === CR) {
      kind = "newline";
      i += b[i + 1] === NL ? 2 : 1;
    } else if (c === APOS) {
      if (startsWith(b, i, "'''")) {
        kind = "mlliteral";
        const close = findTriple(b, i + 3, APOS);
        i = close < 0 ? b.length : close + 3;
        if (b[i] === APOS) {
          i++;
          if (b[i] === APOS) i++;
        }
      } else {
        kind = "literal";
        i += 1;
        while (i < b.length && b[i] !== APOS && b[i] !== NL) i++;
        if (i < b.length && b[i] === APOS) i++;
      }
    } else if (c === QUOTE) {
      if (startsWith(b, i, '"""')) {
        kind = "mlbasic";
        i += 3;
        for (;;) {
          let found = -1;
          for (let j = i; j < b.length; j++) {
            if (
              b[j] === BACKSLASH ||
              (b[j] === QUOTE && b[j + 1] === QUOTE && b[j + 2] === QUOTE)
            ) {
              found = j;
              break;
            }
          }
          if (found < 0) {
            i = b.length;
            break;
          }
          if (b[found] === QUOTE) {
            i = found + 3;
            break;
          }
          i = found + 1;
          if (b[i] === BACKSLASH || b[i] === QUOTE) i++;
        }
        if (b[i] === QUOTE) {
          i++;
          if (b[i] === QUOTE) i++;
        }
      } else {
        kind = "basic";
        i += 1;
        for (;;) {
          let j = i;
          while (j < b.length && b[j] !== QUOTE && b[j] !== BACKSLASH && b[j] !== NL) j++;
          if (j >= b.length) {
            i = b.length;
            break;
          }
          if (b[j] === QUOTE) {
            i = j + 1;
            break;
          }
          if (b[j] === BACKSLASH) {
            i = j + 1;
            if (b[i] === BACKSLASH || b[i] === QUOTE) i++;
            continue;
          }
          i = j;
          break;
        }
      }
    } else {
      kind = "atom";
      while (i < b.length && !ATOM_END.has(b[i]!)) i++;
    }
    tokens.push({ kind, start, end: i });
  }
  tokens.push({ kind: "eof", start: i, end: i });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser (toml_parser parser/document.rs): tokens to events, with error recovery

export type EventKind =
  | "stdTableOpen"
  | "stdTableClose"
  | "arrayTableOpen"
  | "arrayTableClose"
  | "inlineTableOpen"
  | "inlineTableClose"
  | "arrayOpen"
  | "arrayClose"
  | "simpleKey"
  | "keySep"
  | "keyValSep"
  | "scalar"
  | "valueSep"
  | "whitespace"
  | "comment"
  | "newline"
  | "error";

export interface Event {
  kind: EventKind;
  encoding: Encoding;
  start: number;
  end: number;
}

const LIMIT = 80;

/**
 * The event receiver the crates use: a `Vec<Event>` behind `ValidateWhitespace` (comments and
 * newlines are decoded, which can report errors) and `RecursionGuard` (depth 80).
 */
class Receiver {
  readonly events: Event[] = [];
  private depth = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  private push(kind: EventKind, s: Span, encoding: Encoding = null): void {
    this.events.push({ kind, encoding, start: s[0], end: s[1] });
  }

  stdTableOpen(s: Span): void {
    this.push("stdTableOpen", s);
  }
  stdTableClose(s: Span): void {
    this.push("stdTableClose", s);
  }
  arrayTableOpen(s: Span): void {
    this.push("arrayTableOpen", s);
  }
  arrayTableClose(s: Span): void {
    this.push("arrayTableClose", s);
  }
  private open(kind: EventKind, s: Span, err: ErrorSink): boolean {
    this.push(kind, s);
    this.depth += 1;
    if (this.depth > LIMIT) {
      err.report({ description: "cannot recurse further; max recursion depth met", unexpected: s });
      return false;
    }
    return true;
  }
  inlineTableOpen(s: Span, err: ErrorSink): boolean {
    return this.open("inlineTableOpen", s, err);
  }
  inlineTableClose(s: Span): void {
    this.depth -= 1;
    this.push("inlineTableClose", s);
  }
  arrayOpen(s: Span, err: ErrorSink): boolean {
    return this.open("arrayOpen", s, err);
  }
  arrayClose(s: Span): void {
    this.depth -= 1;
    this.push("arrayClose", s);
  }
  simpleKey(s: Span, encoding: Encoding): void {
    this.push("simpleKey", s, encoding);
  }
  keySep(s: Span): void {
    this.push("keySep", s);
  }
  keyValSep(s: Span): void {
    this.push("keyValSep", s);
  }
  scalar(s: Span, encoding: Encoding): void {
    this.push("scalar", s, encoding);
  }
  valueSep(s: Span): void {
    this.push("valueSep", s);
  }
  whitespace(s: Span): void {
    this.push("whitespace", s);
  }
  comment(s: Span, err: ErrorSink): void {
    decodeComment(this.bytes.subarray(s[0], s[1]), s[0], err);
    this.push("comment", s);
  }
  newline(s: Span, err: ErrorSink): void {
    if (s[1] - s[0] === 1 && this.bytes[s[0]] === CR) {
      err.report({
        description: "carriage return must be followed by newline",
        context: [s[0], s[1]],
        expected: [lit("\n")],
        unexpected: [s[1], s[1]],
      });
    }
    this.push("newline", s);
  }
  error(s: Span): void {
    this.push("error", s);
  }
}

/** winnow's `TokenSlice`: a cursor over a slice, keeping what was consumed. */
export class Cursor<T> {
  readonly items: readonly T[];
  pos = 0;

  constructor(items: readonly T[]) {
    this.items = items;
  }

  next(): T | undefined {
    return this.pos < this.items.length ? this.items[this.pos++] : undefined;
  }

  first(): T | undefined {
    return this.items[this.pos];
  }

  get(i: number): T | undefined {
    return this.items[this.pos + i];
  }

  /** The consumed items, most recent first. */
  *previous(): Generator<T> {
    for (let i = this.pos - 1; i >= 0; i--) yield this.items[i]!;
  }

  seek(offset: number): void {
    const next = this.pos + offset;
    this.pos = next < this.items.length ? Math.max(0, next) : this.items.length;
  }
}

type Tokens = Cursor<Token>;

const sp = (t: Token): Span => [t.start, t.end];
const before = (s: Span): Span => [s[0], s[0]];
const after = (s: Span): Span => [s[1], s[1]];
const join = (a: Span, b: Span): Span => [a[0], b[1]];

function nextIf(t: Tokens, kinds: readonly TokenKind[]): Token | undefined {
  const n = t.first();
  return n && kinds.includes(n.kind) ? t.next() : undefined;
}

function previousSpan(t: Tokens): Span {
  for (const p of t.previous()) {
    if (p.kind !== "ws" && p.kind !== "comment" && p.kind !== "newline" && p.kind !== "eof") {
      return sp(p);
    }
  }
  return [0, 0];
}

export function parseDocumentEvents(source: Source, err: ErrorSink): Event[] {
  const r = new Receiver(source.bytes);
  const t = new Cursor(lex(source.bytes));
  document(t, r, err);
  eof(t, r, err);
  return r.events;
}

function document(t: Tokens, r: Receiver, err: ErrorSink): void {
  for (let cur = t.next(); cur; cur = t.next()) {
    switch (cur.kind) {
      case "lbracket":
        onTable(t, cur, r, err);
        break;
      case "rbracket":
        onMissingStdTable(t, cur, r, err);
        break;
      case "literal":
      case "basic":
      case "mlliteral":
      case "mlbasic":
        onExpressionKey(t, cur, cur.kind, r, err);
        break;
      case "atom":
        onExpressionKey(t, cur, null, r, err);
        break;
      case "equals":
        r.simpleKey(before(sp(cur)), null);
        onExpressionKeyValSep(t, cur, r, err);
        break;
      case "dot":
        onExpressionDot(t, cur, r, err);
        break;
      case "comma":
      case "rbrace":
      case "lbrace":
        onMissingExpressionKey(t, cur, r, err);
        break;
      case "ws":
        r.whitespace(sp(cur));
        break;
      case "newline":
        r.newline(sp(cur), err);
        break;
      case "comment":
        onComment(t, cur, r, err);
        break;
      case "eof":
        return;
    }
  }
}

function onTable(t: Tokens, open: Token, r: Receiver, err: ErrorSink): void {
  const second = nextIf(t, ["lbracket"]);
  const isArray = second !== undefined;
  if (second) r.arrayTableOpen(join(sp(open), sp(second)));
  else r.stdTableOpen(sp(open));
  optWhitespace(t, r);
  const validKey = key(t, "invalid table", r, err);
  optWhitespace(t, r);
  let success = false;
  const close = nextIf(t, ["rbracket"]);
  if (close) {
    if (isArray) {
      const close2 = nextIf(t, ["rbracket"]);
      if (close2) {
        r.arrayTableClose(join(sp(close), sp(close2)));
        success = true;
      } else {
        err.report({
          description: "unclosed array table",
          context: join(sp(open), sp(close)),
          expected: [lit("]")],
          unexpected: after(sp(close)),
        });
      }
    } else {
      r.stdTableClose(sp(close));
      success = true;
    }
  } else if (validKey) {
    let last = open;
    for (const p of t.previous()) {
      if (p.kind !== "ws") {
        last = p;
        break;
      }
    }
    err.report({
      description: isArray ? "unclosed array table" : "unclosed table",
      context: join(sp(open), sp(last)),
      expected: [lit(isArray ? "]]" : "]")],
      unexpected: after(sp(last)),
    });
  }
  if (success) wsCommentNewline(t, r, err);
  else ignoreToNewline(t, r, err);
}

function key(t: Tokens, invalid: string, r: Receiver, err: ErrorSink): boolean {
  for (let cur = t.next(); cur; cur = t.next()) {
    switch (cur.kind) {
      case "rbracket":
      case "comment":
      case "equals":
      case "comma":
      case "lbracket":
      case "lbrace":
      case "rbrace":
      case "newline":
      case "eof":
        r.simpleKey(before(sp(cur)), null);
        t.seek(-1);
        return false;
      case "ws":
        r.whitespace(sp(cur));
        continue;
      case "dot":
        r.simpleKey(before(sp(cur)), null);
        r.keySep(sp(cur));
        continue;
      default:
        r.simpleKey(sp(cur), tokenEncoding(cur.kind));
        return optDotKeys(t, r, err);
    }
  }
  const prev = previousSpan(t);
  err.report({
    description: invalid,
    context: prev,
    expected: [desc("key")],
    unexpected: after(prev),
  });
  return false;
}

function onExpressionKey(
  t: Tokens,
  keyTok: Token,
  enc: Encoding,
  r: Receiver,
  err: ErrorSink,
): void {
  r.simpleKey(sp(keyTok), enc);
  optDotKeys(t, r, err);
  optWhitespace(t, r);
  const eq = nextIf(t, ["equals"]);
  if (!eq) {
    const peek = t.first();
    if (peek) {
      const s = before(sp(peek));
      err.report({
        description: "key with no value",
        context: s,
        expected: [lit("=")],
        unexpected: s,
      });
    }
    ignoreToNewline(t, r, err);
    return;
  }
  onExpressionKeyValSep(t, eq, r, err);
}

function onExpressionDot(t: Tokens, dot: Token, r: Receiver, err: ErrorSink): void {
  r.simpleKey(before(sp(dot)), null);
  t.seek(-1);
  optDotKeys(t, r, err);
  optWhitespace(t, r);
  const eq = nextIf(t, ["equals"]);
  if (!eq) {
    const peek = t.first();
    if (peek) {
      const s = before(sp(peek));
      err.report({
        description: "missing value for key",
        context: s,
        expected: [lit("=")],
        unexpected: s,
      });
    }
    ignoreToNewline(t, r, err);
    return;
  }
  onExpressionKeyValSep(t, eq, r, err);
}

function onExpressionKeyValSep(t: Tokens, eq: Token, r: Receiver, err: ErrorSink): void {
  r.keyValSep(sp(eq));
  optWhitespace(t, r);
  value(t, r, err);
  wsCommentNewline(t, r, err);
}

function optDotKeys(t: Tokens, r: Receiver, err: ErrorSink): boolean {
  optWhitespace(t, r);
  let success = true;
  dots: for (let dot = nextIf(t, ["dot"]); dot; dot = nextIf(t, ["dot"])) {
    r.keySep(sp(dot));
    let found = false;
    for (let cur = t.next(); cur; cur = t.next()) {
      switch (cur.kind) {
        case "equals":
        case "comma":
        case "lbracket":
        case "rbracket":
        case "lbrace":
        case "rbrace":
        case "comment":
        case "newline":
        case "eof":
          r.simpleKey(before(sp(cur)), null);
          t.seek(-1);
          success = false;
          break dots;
        case "ws":
          r.whitespace(sp(cur));
          continue;
        case "dot":
          r.simpleKey(before(sp(cur)), null);
          r.keySep(sp(cur));
          continue;
        default:
          r.simpleKey(sp(cur), tokenEncoding(cur.kind));
          optWhitespace(t, r);
          found = true;
      }
      if (found) break;
    }
    if (!found) r.simpleKey(after(sp(dot)), null);
  }
  void err;
  return success;
}

function value(t: Tokens, r: Receiver, err: ErrorSink): void {
  let cur: Token | undefined;
  for (;;) {
    cur = t.next();
    if (!cur) {
      const prev = previousSpan(t);
      err.report({
        description: "missing value",
        context: prev,
        expected: [desc("value")],
        unexpected: after(prev),
      });
      return;
    }
    if (cur.kind !== "equals") break;
    err.report({ description: "extra `=`", context: sp(cur), expected: [], unexpected: sp(cur) });
    r.error(sp(cur));
  }
  switch (cur.kind) {
    case "comment":
    case "comma":
    case "newline":
    case "eof":
    case "ws":
      r.scalar(before(sp(cur)), null);
      t.seek(-1);
      return;
    case "lbrace":
      onInlineTableOpen(t, cur, r, err);
      return;
    case "rbrace":
      err.report({
        description: "missing inline table opening",
        context: sp(cur),
        expected: [lit("{")],
        unexpected: before(sp(cur)),
      });
      r.inlineTableOpen(before(sp(cur)), err);
      r.inlineTableClose(sp(cur));
      return;
    case "lbracket":
      onArrayOpen(t, cur, r, err);
      return;
    case "rbracket":
      err.report({
        description: "missing array opening",
        context: sp(cur),
        expected: [lit("[")],
        unexpected: before(sp(cur)),
      });
      r.arrayOpen(before(sp(cur)), err);
      r.arrayClose(sp(cur));
      return;
    default:
      onScalar(t, cur, r);
  }
}

function onScalar(t: Tokens, scalar: Token, r: Receiver): void {
  let s: Span = sp(scalar);
  const enc = tokenEncoding(scalar.kind);
  if (scalar.kind === "dot" || scalar.kind === "atom") {
    for (let n = t.first(); n; n = t.first()) {
      if (n.kind === "ws") {
        const second = t.get(1);
        if (second && second.kind === "atom") {
          s = join(s, sp(second));
          t.seek(2);
          continue;
        }
        break;
      }
      if (n.kind === "dot" || n.kind === "atom") {
        s = join(s, sp(n));
        t.next();
        continue;
      }
      break;
    }
  }
  r.scalar(s, enc);
}

function missingComma(t: Tokens, open: Token, cur: Token, r: Receiver, err: ErrorSink): void {
  err.report({
    description: "missing comma between array elements",
    context: sp(open),
    expected: [lit(",")],
    unexpected: before(sp(cur)),
  });
  r.valueSep(before(sp(cur)));
  void t;
}

function onArrayOpen(t: Tokens, open: Token, r: Receiver, err: ErrorSink): void {
  if (!r.arrayOpen(sp(open), err)) {
    ignoreToValueClose(t, "rbracket", r, err);
    return;
  }
  let needsValue = true;
  for (let cur = t.next(); cur; cur = t.next()) {
    switch (cur.kind) {
      case "comment":
        onComment(t, cur, r, err);
        break;
      case "ws":
        r.whitespace(sp(cur));
        break;
      case "newline":
        r.newline(sp(cur), err);
        break;
      case "eof":
        break;
      case "comma":
        if (needsValue) {
          err.report({
            description: "extra comma in array",
            context: sp(open),
            expected: [desc("value")],
            unexpected: sp(cur),
          });
          r.error(sp(cur));
        } else {
          r.valueSep(sp(cur));
          needsValue = true;
        }
        break;
      case "equals":
        err.report({
          description: "unexpected `=` in array",
          context: sp(open),
          expected: [desc("value"), lit("]")],
          unexpected: sp(cur),
        });
        r.error(sp(cur));
        break;
      case "lbrace":
        if (!needsValue) missingComma(t, open, cur, r, err);
        onInlineTableOpen(t, cur, r, err);
        needsValue = false;
        break;
      case "rbrace":
        if (!needsValue) missingComma(t, open, cur, r, err);
        err.report({
          description: "missing inline table opening",
          context: sp(cur),
          expected: [lit("{")],
          unexpected: before(sp(cur)),
        });
        r.inlineTableOpen(before(sp(cur)), err);
        r.inlineTableClose(sp(cur));
        needsValue = false;
        break;
      case "lbracket":
        if (!needsValue) missingComma(t, open, cur, r, err);
        onArrayOpen(t, cur, r, err);
        needsValue = false;
        break;
      case "rbracket":
        r.arrayClose(sp(cur));
        return;
      default:
        if (!needsValue) missingComma(t, open, cur, r, err);
        onScalar(t, cur, r);
        needsValue = false;
    }
    if (cur.kind === "eof") break;
  }
  const prev = previousSpan(t);
  err.report({
    description: "unclosed array",
    context: sp(open),
    expected: [lit("]")],
    unexpected: after(prev),
  });
  r.arrayClose(after(prev));
}

type InlineState = "key" | "equals" | "value" | "comma";
const INLINE_EXPECTED: Record<InlineState, Expected[]> = {
  key: [desc("key")],
  equals: [lit("=")],
  value: [desc("value")],
  comma: [lit(",")],
};

function onInlineTableOpen(t: Tokens, open: Token, r: Receiver, err: ErrorSink): void {
  if (!r.inlineTableOpen(sp(open), err)) {
    ignoreToValueClose(t, "rbrace", r, err);
    return;
  }
  let state: InlineState = "key";
  const report = (description: string, cur: Token): void =>
    err.report({
      description,
      context: sp(open),
      expected: INLINE_EXPECTED[state],
      unexpected: before(sp(cur)),
    });
  const startKey = (cur: Token): InlineState => {
    if (cur.kind === "dot") {
      r.simpleKey(before(sp(cur)), null);
      t.seek(-1);
    } else {
      r.simpleKey(sp(cur), tokenEncoding(cur.kind));
    }
    optDotKeys(t, r, err);
    return "equals";
  };
  loop: for (let cur = t.next(); cur; cur = t.next()) {
    switch (cur.kind) {
      case "comment":
        onComment(t, cur, r, err);
        break;
      case "ws":
        r.whitespace(sp(cur));
        break;
      case "newline":
        r.newline(sp(cur), err);
        break;
      case "eof":
        break loop;
      case "comma":
        if (state === "comma") {
          r.valueSep(sp(cur));
          state = "key";
        } else {
          report("extra comma in inline table", cur);
          r.error(sp(cur));
        }
        break;
      case "equals":
        if (state === "key") {
          r.simpleKey(before(sp(cur)), null);
          r.keyValSep(sp(cur));
          state = "value";
        } else if (state === "equals") {
          r.keyValSep(sp(cur));
          state = "value";
        } else {
          report("extra assignment between key-value pairs", cur);
          r.error(sp(cur));
        }
        break;
      case "lbrace":
        if (state === "key" || state === "comma") {
          report("missing key for inline table element", cur);
          r.error(sp(cur));
          ignoreToValueClose(t, "rbrace", r, err);
        } else {
          if (state === "equals") report("missing assignment between key-value pairs", cur);
          onInlineTableOpen(t, cur, r, err);
          state = "comma";
        }
        break;
      case "rbrace":
        if (state === "equals") {
          r.keyValSep(before(sp(cur)));
          r.scalar(before(sp(cur)), "literal");
        } else if (state === "value") {
          r.scalar(before(sp(cur)), "literal");
        }
        r.inlineTableClose(sp(cur));
        return;
      case "lbracket":
        if (state === "key" || state === "comma") {
          report("missing key for inline table element", cur);
          r.error(sp(cur));
          ignoreToValueClose(t, "rbracket", r, err);
        } else {
          if (state === "equals") report("missing assignment between key-value pairs", cur);
          onArrayOpen(t, cur, r, err);
          state = "comma";
        }
        break;
      case "rbracket":
        if (state === "value") {
          err.report({
            description: "missing array opening",
            context: sp(cur),
            expected: [lit("[")],
            unexpected: before(sp(cur)),
          });
          r.arrayOpen(before(sp(cur)), err);
          r.arrayClose(sp(cur));
          state = "comma";
        } else {
          report("invalid inline table element", cur);
          r.error(sp(cur));
        }
        break;
      default:
        if (state === "key") {
          state = startKey(cur);
        } else if (state === "equals") {
          report("missing assignment between key-value pairs", cur);
          onScalar(t, cur, r);
          state = "comma";
        } else if (state === "value") {
          onScalar(t, cur, r);
          state = "comma";
        } else {
          report("missing comma between key-value pairs", cur);
          state = startKey(cur);
        }
    }
  }
  const prev = previousSpan(t);
  if (state === "equals") {
    r.keyValSep(after(prev));
    r.scalar(after(prev), "literal");
  } else if (state === "value") {
    r.scalar(after(prev), "literal");
  }
  err.report({
    description: "unclosed inline table",
    context: sp(open),
    expected: [lit("}")],
    unexpected: after(prev),
  });
  r.inlineTableClose(after(prev));
}

function optWhitespace(t: Tokens, r: Receiver): void {
  const ws = nextIf(t, ["ws"]);
  if (ws) r.whitespace(sp(ws));
}

function wsCommentNewline(t: Tokens, r: Receiver, err: ErrorSink): void {
  let first: Span | undefined;
  for (let cur = t.next(); cur; cur = t.next()) {
    first ??= sp(cur);
    switch (cur.kind) {
      case "comment":
        onComment(t, cur, r, err);
        return;
      case "ws":
        r.whitespace(sp(cur));
        continue;
      case "newline":
        r.newline(sp(cur), err);
        return;
      case "eof":
        return;
      default:
        err.report({
          description: "unexpected key or value",
          context: join(first, sp(cur)),
          expected: [lit("\n"), lit("#")],
          unexpected: before(sp(cur)),
        });
        r.error(sp(cur));
        ignoreToNewline(t, r, err);
        return;
    }
  }
}

function onComment(t: Tokens, comment: Token, r: Receiver, err: ErrorSink): void {
  r.comment(sp(comment), err);
  const cur = t.next();
  if (!cur) return;
  if (cur.kind === "newline") {
    r.newline(sp(cur), err);
  } else if (cur.kind !== "eof") {
    err.report({
      description: "unexpected content between comment and newline",
      context: join(sp(comment), sp(cur)),
      expected: [lit("\n")],
      unexpected: before(sp(cur)),
    });
    r.error(sp(cur));
    ignoreToNewline(t, r, err);
  }
}

function eof(t: Tokens, r: Receiver, err: ErrorSink): void {
  const cur = t.next();
  if (!cur || cur.kind === "eof") return;
  err.report({
    description: "unexpected content",
    context: sp(cur),
    expected: [],
    unexpected: before(sp(cur)),
  });
  r.error(sp(cur));
  for (let c = t.next(); c; c = t.next()) {
    if (c.kind !== "eof") r.error(sp(c));
  }
}

function ignoreToNewline(t: Tokens, r: Receiver, err: ErrorSink): void {
  for (let cur = t.next(); cur; cur = t.next()) {
    switch (cur.kind) {
      case "comment":
        onComment(t, cur, r, err);
        return;
      case "ws":
        r.whitespace(sp(cur));
        break;
      case "newline":
        r.newline(sp(cur), err);
        return;
      case "eof":
        return;
      default:
        r.error(sp(cur));
    }
  }
}

function ignoreToValueClose(t: Tokens, closing: TokenKind, r: Receiver, err: ErrorSink): void {
  let arrays = 0;
  let tables = 0;
  for (let cur = t.next(); cur; cur = t.next()) {
    switch (cur.kind) {
      case "comment":
        onComment(t, cur, r, err);
        break;
      case "ws":
        r.whitespace(sp(cur));
        break;
      case "newline":
        r.newline(sp(cur), err);
        break;
      case "lbracket":
        r.error(sp(cur));
        arrays += 1;
        break;
      case "rbracket":
        if (arrays === 0 && closing === "rbracket") {
          r.arrayClose(sp(cur));
          return;
        }
        r.error(sp(cur));
        arrays = Math.max(0, arrays - 1);
        break;
      case "lbrace":
        r.error(sp(cur));
        tables += 1;
        break;
      case "rbrace":
        if (tables === 0 && closing === "rbrace") {
          r.inlineTableClose(sp(cur));
          return;
        }
        r.error(sp(cur));
        tables = Math.max(0, tables - 1);
        break;
      case "eof":
        return;
      default:
        r.error(sp(cur));
    }
  }
}

function onMissingExpressionKey(t: Tokens, tok: Token, r: Receiver, err: ErrorSink): void {
  err.report({
    description: "invalid key-value pair",
    context: sp(tok),
    expected: [desc("key")],
    unexpected: before(sp(tok)),
  });
  r.error(sp(tok));
  ignoreToNewline(t, r, err);
}

function onMissingStdTable(t: Tokens, tok: Token, r: Receiver, err: ErrorSink): void {
  err.report({
    description: "missing table open",
    context: sp(tok),
    expected: [lit("[")],
    unexpected: before(sp(tok)),
  });
  r.error(sp(tok));
  ignoreToNewline(t, r, err);
}

// ---------------------------------------------------------------------------------------------
// Decoders (toml_parser decoder/*.rs). Offsets in errors are relative to the raw token until
// rebased by `base`.

class Report {
  private readonly err: ErrorSink;
  private readonly base: number;
  private readonly len: number;

  constructor(err: ErrorSink, base: number, len: number) {
    this.err = err;
    this.base = base;
    this.len = len;
  }

  /** An error whose context is the whole raw token, as almost all decoder errors have. */
  at(description: string, unexpected: Span, expected?: readonly Expected[]): void {
    const e: ParseError = {
      description,
      context: [this.base, this.base + this.len],
      unexpected: [unexpected[0] + this.base, unexpected[1] + this.base],
    };
    if (expected) e.expected = expected;
    this.err.report(e);
  }
}

function decodeComment(raw: Uint8Array, base: number, err: ErrorSink): void {
  const rep = new Report(err, base, raw.length);
  if (raw[0] !== 0x23) rep.at("missing comment start", [0, 0], [lit("#")]);
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    if (!(b === TAB || (b >= 0x20 && b <= 0x7e) || b >= 0x80)) {
      rep.at("invalid comment character", [i, i], [desc("printable characters")]);
    }
  }
}

const isLiteralChar = (b: number): boolean =>
  b === TAB || (b >= 0x20 && b <= 0x26) || (b >= 0x28 && b <= 0x7e) || b >= 0x80;
const isBasicUnescaped = (b: number): boolean =>
  b === SPACE ||
  b === TAB ||
  b === 0x21 ||
  (b >= 0x23 && b <= 0x5b) ||
  (b >= 0x5d && b <= 0x7e) ||
  b >= 0x80;
const isDigit = (b: number | undefined): boolean => b !== undefined && b >= 0x30 && b <= 0x39;
const isHex = (b: number | undefined): boolean =>
  b !== undefined && (isDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66));

function endsWith(raw: Uint8Array, s: string): boolean {
  return raw.length >= s.length && startsWith(raw, raw.length - s.length, s);
}

function decodeLiteralString(raw: Uint8Array, rep: Report): string {
  const INVALID = "invalid literal string";
  let s = 0;
  let e = raw.length;
  if (raw[0] === APOS) s = 1;
  else rep.at(INVALID, [0, 0], [lit("'")]);
  if (e > s && raw[e - 1] === APOS) e -= 1;
  else rep.at(INVALID, [raw.length, raw.length], [lit("'")]);
  for (let i = s; i < e; i++) {
    if (!isLiteralChar(raw[i]!))
      rep.at(INVALID, [i, i], [desc("non-single-quote visible characters")]);
  }
  return decode(raw.subarray(s, e));
}

function stripStartNewline(raw: Uint8Array, s: number): number {
  if (raw[s] === NL) return s + 1;
  if (raw[s] === CR && raw[s + 1] === NL) return s + 2;
  return s;
}

function decodeMlLiteralString(raw: Uint8Array, rep: Report): string {
  const INVALID = "invalid multi-line literal string";
  let s = 0;
  let e = raw.length;
  if (startsWith(raw, 0, "'''")) s = 3;
  else rep.at(INVALID, [0, 0], [lit("'")]);
  s = stripStartNewline(raw, s);
  if (e - s >= 3 && endsWith(raw.subarray(s, e), "'''")) {
    e -= 3;
  } else {
    rep.at(INVALID, [raw.length, raw.length], [lit("'")]);
    while (e > s && raw[e - 1] === APOS) e--;
  }
  for (let i = s; i < e; i++) {
    const b = raw[i]!;
    if (b === APOS || b === NL) continue;
    if (b === CR) {
      if (raw[i + 1] !== NL || i + 1 >= e) {
        rep.at("carriage return must be followed by newline", [i + 1, i + 1], [lit("\n")]);
      }
    } else if (!isLiteralChar(b)) {
      rep.at(INVALID, [i, i], [desc("non-single-quote characters")]);
    }
  }
  return decode(raw.subarray(s, e));
}

const ESCAPES: readonly Expected[] = ["b", "e", "f", "n", "r", "\\", '"', "x", "u", "U"].map(lit);

/** `escape_seq_char`: `p` is just past the backslash. Returns the char and the new position. */
function escapeSeqChar(raw: Uint8Array, p: number, end: number, rep: Report): [string, number] {
  if (p >= end) {
    rep.at("missing escaped value", [p, p], ESCAPES);
    return ["\\", p];
  }
  const id = raw[p]!;
  const simple: Record<number, string> = {
    98: "\b",
    101: "\u001b",
    102: "\f",
    110: "\n",
    114: "\r",
    116: "\t",
    92: "\\",
    34: '"',
  };
  if (simple[id] !== undefined) return [simple[id]!, p + 1];
  const digits = id === 0x78 ? 2 : id === 0x75 ? 4 : id === 0x55 ? 8 : 0;
  if (digits === 0) {
    rep.at("missing escaped value", [p, p], ESCAPES);
    return ["\\", p];
  }
  const start = p + 1;
  let q = start;
  while (q < end && q - start < digits && isHex(raw[q])) q++;
  if (q - start !== digits) {
    rep.at("too few unicode value digits", [q, q], [desc("unicode hexadecimal value")]);
    return ["�", q];
  }
  const code = Number.parseInt(decode(raw.subarray(start, q)), 16);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    rep.at("invalid value", [start, start], [desc("unicode hexadecimal value")]);
    return ["�", q];
  }
  return [String.fromCodePoint(code), q];
}

function decodeBasicString(raw: Uint8Array, rep: Report): string {
  const INVALID = "invalid basic string";
  let s = 0;
  let e = raw.length;
  if (raw[0] === QUOTE) s = 1;
  else rep.at(INVALID, [0, 0], [lit('"')]);
  if (e > s && raw[e - 1] === QUOTE) e -= 1;
  else rep.at(INVALID, [raw.length, raw.length], [lit('"')]);
  let out = "";
  let p = s;
  const unescaped = (): void => {
    const q0 = p;
    while (p < e && isBasicUnescaped(raw[p]!)) p++;
    out += decode(raw.subarray(q0, p));
  };
  unescaped();
  while (p < e) {
    if (raw[p] === BACKSLASH) {
      const [c, q] = escapeSeqChar(raw, p + 1, e, rep);
      out += c;
      p = q;
    } else {
      const q0 = p;
      while (p < e && !isBasicUnescaped(raw[p]!) && raw[p] !== BACKSLASH) p++;
      rep.at(INVALID, [q0, p], [desc("non-double-quote visible characters"), lit("\\")]);
      out += decode(raw.subarray(q0, p));
    }
    unescaped();
  }
  return out;
}

function decodeMlBasicString(raw: Uint8Array, rep: Report): string {
  const INVALID = "invalid multi-line basic string";
  let s = 0;
  let e = raw.length;
  if (startsWith(raw, 0, '"""')) s = 3;
  else rep.at(INVALID, [0, 0], [lit('"')]);
  s = stripStartNewline(raw, s);
  if (e - s >= 3 && endsWith(raw.subarray(s, e), '"""')) e -= 3;
  else rep.at(INVALID, [raw.length, raw.length], [lit('"')]);
  let out = "";
  let p = s;
  const isMlb = (b: number): boolean => isBasicUnescaped(b) || b === QUOTE || b === NL;
  const unescaped = (): void => {
    const q0 = p;
    while (p < e && isMlb(raw[p]!)) p++;
    out += decode(raw.subarray(q0, p));
  };
  const crNewline = (): void => {
    let n = 1;
    if (raw[p + 1] === NL && p + 1 < e) n = 2;
    else rep.at("carriage return must be followed by newline", [p + 1, p + 1], [lit("\n")]);
    p += n;
  };
  unescaped();
  while (p < e) {
    if (raw[p] === BACKSLASH) {
      p += 1;
      const b = raw[p];
      if (p < e && (b === SPACE || b === TAB || b === CR || b === NL)) {
        // mlb_escaped_nl
        while (p < e && (raw[p] === SPACE || raw[p] === TAB)) p++;
        if (p < e && raw[p] === NL) {
          p++;
        } else if (p < e && raw[p] === CR) {
          p++;
          if (p < e && raw[p] === NL) p++;
          else rep.at("carriage return must be followed by newline", [p, p], [lit("\n")]);
        } else {
          rep.at(INVALID, [p, p], [lit("\n")]);
        }
        for (;;) {
          const startOffset = p;
          while (p < e && (raw[p] === SPACE || raw[p] === TAB || raw[p] === NL)) p++;
          if (p < e && raw[p] === CR) {
            if (raw[p + 1] === NL && p + 1 < e) p += 2;
            else {
              rep.at("carriage return must be followed by newline", [p + 1, p + 1], [lit("\n")]);
              p += 1;
            }
          }
          if (startOffset === p) break;
        }
      } else {
        const [c, q] = escapeSeqChar(raw, p, e, rep);
        out += c;
        p = q;
      }
    } else if (raw[p] === CR) {
      const q0 = p;
      crNewline();
      out += decode(raw.subarray(q0, p));
    } else {
      const q0 = p;
      while (p < e && !isMlb(raw[p]!) && raw[p] !== BACKSLASH && raw[p] !== CR) p++;
      rep.at(INVALID, [q0, p], [lit("\\"), desc("characters")]);
      out += decode(raw.subarray(q0, p));
    }
    unescaped();
  }
  return out;
}

const UNQUOTED_EXPECTED: readonly Expected[] = [
  desc("letters"),
  desc("numbers"),
  lit("-"),
  lit("_"),
];
const isUnquotedChar = (b: number): boolean =>
  (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || isDigit(b) || b === 0x2d || b === 0x5f;

function decodeUnquotedKey(raw: Uint8Array, rep: Report): string {
  if (raw.length === 0) rep.at("unquoted keys cannot be empty", [0, 0], UNQUOTED_EXPECTED);
  let span: [number, number] | undefined;
  for (let i = 0; i < raw.length; i++) {
    if (isUnquotedChar(raw[i]!)) continue;
    if (span && i === span[1]) {
      span = [span[0], i + 1];
    } else {
      if (span) rep.at("invalid unquoted key", span, UNQUOTED_EXPECTED);
      span = [i, i + 1];
    }
  }
  if (span) rep.at("invalid unquoted key", span, UNQUOTED_EXPECTED);
  return decode(raw);
}

/** `Raw::decode_key`. */
export function decodeKey(source: Source, s: Span, enc: Encoding, err: ErrorSink): string {
  const raw = source.bytes.subarray(s[0], s[1]);
  const rep = new Report(err, s[0], raw.length);
  const ML_KEY: readonly Expected[] = [desc("basic string"), desc("literal string")];
  switch (enc) {
    case "literal":
      return decodeLiteralString(raw, rep);
    case "basic":
      return decodeBasicString(raw, rep);
    case "mlliteral":
      rep.at("keys cannot be multi-line literal strings", [0, raw.length], ML_KEY);
      return decodeMlLiteralString(raw, rep);
    case "mlbasic":
      rep.at("keys cannot be multi-line basic strings", [0, raw.length], ML_KEY);
      return decodeMlBasicString(raw, rep);
    default:
      return decodeUnquotedKey(raw, rep);
  }
}

/** toml_parser's `ScalarKind`. */
export type ScalarKind =
  | { t: "string" }
  | { t: "boolean"; value: boolean }
  | { t: "datetime" }
  | { t: "float" }
  | { t: "integer"; radix: 2 | 8 | 10 | 16 };

const FLOAT: ScalarKind = { t: "float" };
const RADIX_INVALID: Record<number, string> = {
  10: "invalid integer number",
  16: "invalid hexadecimal number",
  8: "invalid octal number",
  2: "invalid binary number",
};

function invalidDescription(kind: ScalarKind): string {
  switch (kind.t) {
    case "string":
      return "invalid string";
    case "boolean":
      return "invalid boolean";
    case "datetime":
      return "invalid date-time";
    case "float":
      return "invalid float";
    case "integer":
      return RADIX_INVALID[kind.radix]!;
  }
}

/** `Raw::decode_scalar`: the kind and the decoded text (digits without `_`, or the string). */
export function decodeScalar(
  source: Source,
  s: Span,
  enc: Encoding,
  err: ErrorSink,
): [ScalarKind, string] {
  const raw = source.bytes.subarray(s[0], s[1]);
  const rep = new Report(err, s[0], raw.length);
  switch (enc) {
    case "literal":
      return [{ t: "string" }, decodeLiteralString(raw, rep)];
    case "basic":
      return [{ t: "string" }, decodeBasicString(raw, rep)];
    case "mlliteral":
      return [{ t: "string" }, decodeMlLiteralString(raw, rep)];
    case "mlbasic":
      return [{ t: "string" }, decodeMlBasicString(raw, rep)];
    default:
      return new UnquotedScalar(raw, rep).decode();
  }
}

/** decoder/scalar.rs. `v` positions are offsets into `raw`; every `value` is a suffix of it. */
class UnquotedScalar {
  private readonly raw: Uint8Array;
  private readonly rep: Report;
  private readonly len: number;

  constructor(raw: Uint8Array, rep: Report) {
    this.raw = raw;
    this.rep = rep;
    this.len = raw.length;
  }

  private has(from: number, c: number): boolean {
    for (let i = from; i < this.len; i++) if (this.raw[i] === c) return true;
    return false;
  }

  private text(from = 0): string {
    return decode(this.raw.subarray(from));
  }

  decode(): [ScalarKind, string] {
    const raw = this.raw;
    if (this.len === 0) return this.invalid();
    const first = raw[0]!;
    if (!isDigit(first) && this.has(0, SPACE)) return this.invalid();
    switch (first) {
      case 0x2b:
      case 0x2d:
        return this.signPrefix(1);
      case 0x5f:
        return this.datetimeFloatInteger(0);
      case 0x30:
        return this.zeroPrefix(0, false);
      case 0x2e:
        return this.ensureFloat(0) ? this.floatOrInteger(0, FLOAT) : [FLOAT, ""];
      case 0x74:
      case 0x54:
        return this.symbol("true", { t: "boolean", value: true });
      case 0x66:
      case 0x46:
        return this.symbol("false", { t: "boolean", value: false });
      case 0x69:
      case 0x49:
        return this.symbol("inf", FLOAT);
      case 0x6e:
      case 0x4e:
        return this.symbol("nan", FLOAT);
      default:
        if (isDigit(first)) return this.datetimeFloatInteger(0);
        return this.invalid();
    }
  }

  private symbol(symbol: string, kind: ScalarKind): [ScalarKind, string] {
    if (this.text() !== symbol) {
      if (this.has(0, SPACE)) return this.invalid();
      this.rep.at(invalidDescription(kind), [0, this.len], [lit(symbol)]);
    }
    return [kind, symbol];
  }

  private signPrefix(start: number): [ScalarKind, string] {
    let v = start;
    let first: number;
    for (;;) {
      if (v >= this.len) return this.invalid();
      first = this.raw[v]!;
      if (first !== 0x2b && first !== 0x2d) break;
      this.rep.at("redundant numeric sign", [v, v + 1], []);
      v += 1;
    }
    switch (first) {
      case 0x5f:
        return this.datetimeFloatInteger(v);
      case 0x30:
        return this.zeroPrefix(v, true);
      case 0x2e:
        return this.ensureFloat(0) ? this.floatOrInteger(0, FLOAT) : [FLOAT, ""];
      case 0x69:
      case 0x49:
      case 0x6e:
      case 0x4e: {
        const symbol = first === 0x69 || first === 0x49 ? "inf" : "nan";
        if (this.text(v) !== symbol) {
          this.rep.at("invalid float", [v, this.len], [lit(symbol)]);
          return [FLOAT, symbol];
        }
        return [FLOAT, this.text()];
      }
      default:
        if (isDigit(first)) return this.datetimeFloatInteger(v);
        return this.invalid();
    }
  }

  private zeroPrefix(v: number, signed: boolean): [ScalarKind, string] {
    if (this.len - v === 1) return this.floatOrInteger(0, { t: "integer", radix: 10 });
    const radixByte = this.raw[v + 1]!;
    const radixes: Record<number, [2 | 8 | 16, string, boolean]> = {
      120: [16, "0x", false],
      88: [16, "0x", true],
      111: [8, "0o", false],
      79: [8, "0o", true],
      98: [2, "0b", false],
      66: [2, "0b", true],
    };
    const r = radixes[radixByte];
    if (r || radixByte === 0x64 || radixByte === 0x44) {
      if (this.has(v, SPACE)) return this.invalid();
      if (signed) this.rep.at("integers with a radix cannot be signed", [0, 1], []);
      let radix: 2 | 8 | 10 | 16 = 10;
      if (r) {
        radix = r[0];
        if (r[2]) this.rep.at("radix must be lowercase", [v, v + 2], [lit(r[1])]);
      } else {
        this.rep.at("redundant integer number prefix", [0, 2], []);
      }
      const kind: ScalarKind = { t: "integer", radix };
      return this.ensureRadixed(v + 2, radix) ? this.floatOrInteger(v + 2, kind) : [kind, ""];
    }
    return this.datetimeFloatInteger(v);
  }

  private datetimeFloatInteger(v: number): [ScalarKind, string] {
    let digitEnd = v;
    while (digitEnd < this.len && isDigit(this.raw[digitEnd])) digitEnd++;
    const integer: ScalarKind = { t: "integer", radix: 10 };
    if (digitEnd === this.len) {
      return this.ensureNoLeadingZero(v) ? this.floatOrInteger(0, integer) : [integer, ""];
    }
    const rest = this.raw[digitEnd];
    if (rest === 0x2d || rest === 0x3a) return [{ t: "datetime" }, this.text()];
    if (this.has(digitEnd, SPACE)) return this.invalid();
    if (this.has(digitEnd, 0x2e) || this.has(digitEnd, 0x65) || this.has(digitEnd, 0x45)) {
      return this.ensureFloat(v) ? this.floatOrInteger(0, FLOAT) : [FLOAT, ""];
    }
    if (rest === 0x5f) {
      return this.ensureNoLeadingZero(v) ? this.floatOrInteger(0, integer) : [integer, ""];
    }
    return this.invalid();
  }

  private ensureFloat(v: number): boolean {
    const pos = { p: v };
    let valid = this.ensureDecUint(pos, false, "invalid mantissa");
    if (this.raw[pos.p] === 0x2e) {
      pos.p++;
      valid = this.ensureDecUint(pos, true, "invalid fraction") && valid;
    }
    if (this.raw[pos.p] === 0x65 || this.raw[pos.p] === 0x45) {
      pos.p++;
      if (this.raw[pos.p] === 0x2b || this.raw[pos.p] === 0x2d) pos.p++;
      valid = this.ensureDecUint(pos, true, "invalid exponent") && valid;
    }
    if (pos.p < this.len) {
      this.rep.at("invalid float", [pos.p, this.len], []);
      valid = false;
    }
    return valid;
  }

  private ensureDecUint(pos: { p: number }, zeroPrefix: boolean, description: string): boolean {
    const start = pos.p;
    let count = 0;
    while (pos.p < this.len) {
      const c = this.raw[pos.p]!;
      if (isDigit(c)) count++;
      else if (c !== 0x5f) break;
      pos.p++;
    }
    if (count === 0) {
      this.rep.at(description, [start, start], [desc("digits")]);
      return false;
    }
    if (count > 1 && this.raw[start] === 0x30 && !zeroPrefix) {
      this.rep.at("unexpected leading zero", [start, start + 1], []);
      return false;
    }
    return true;
  }

  private ensureNoLeadingZero(v: number): boolean {
    if (this.raw[v] === 0x30) {
      this.rep.at("unexpected leading zero", [v, v + 1], []);
      return false;
    }
    return true;
  }

  private ensureRadixed(v: number, radix: 2 | 8 | 10 | 16): boolean {
    let valid = true;
    let p = v;
    if (this.raw[p] === 0x2b || this.raw[p] === 0x2d) {
      let pos = 0;
      while (this.raw[pos] !== 0x2b && this.raw[pos] !== 0x2d) pos++;
      this.rep.at("unexpected sign", [pos, pos + 1], []);
      valid = false;
      p++;
    }
    const ok = (b: number): boolean =>
      radix === 16
        ? isHex(b)
        : radix === 10
          ? isDigit(b)
          : radix === 8
            ? b >= 0x30 && b <= 0x37
            : b === 0x30 || b === 0x31;
    for (let i = p; i < this.len; i++) {
      const b = this.raw[i]!;
      if (b >= 0x80 && b < 0xc0) continue; // a UTF-8 continuation byte, not a char start
      if (!ok(b) && b !== 0x5f) {
        this.rep.at(RADIX_INVALID[radix]!, [i, i]);
        valid = false;
      }
    }
    return valid;
  }

  private floatOrInteger(v: number, kind: ScalarKind): [ScalarKind, string] {
    const raw = this.raw;
    const anyDigit = (b: number | undefined): boolean =>
      b !== undefined && (kind.t === "float" ? isDigit(b) : isHex(b));
    let out = "";
    let p = v;
    while (p < this.len) {
      let sep = -1;
      for (let i = p; i < this.len; i++) {
        if (raw[i] === 0x5f) {
          sep = i;
          break;
        }
      }
      const partStart = p;
      const partEnd = sep >= 0 ? sep : this.len;
      out += decode(raw.subarray(partStart, partEnd));
      p = partEnd;
      if (sep >= 0) {
        p += 1;
        let invalid = false;
        if (partEnd > partStart) {
          if (!anyDigit(raw[partEnd - 1])) invalid = true;
        } else if (partStart === v) {
          invalid = true;
        }
        if (p < this.len) {
          if (!anyDigit(raw[p])) invalid = true;
        } else {
          invalid = true;
        }
        if (invalid) this.rep.at("`_` may only go between digits", [partEnd, partEnd + 1], []);
      }
    }
    return [kind, out];
  }

  private invalid(): [ScalarKind, string] {
    const raw = this.raw;
    const quote = (expected: string): void =>
      this.rep.at("missing opening quote", [0, 0], [lit(expected)]);
    if (endsWith(raw, "'''")) quote("'''");
    else if (endsWith(raw, '"""')) quote('"""');
    else if (endsWith(raw, "'")) quote("'");
    else if (endsWith(raw, '"')) quote('"');
    else this.rep.at("string values must be quoted", [0, this.len], [desc("literal string")]);
    return [{ t: "string" }, this.text()];
  }
}

// ---------------------------------------------------------------------------------------------
// Datetimes (toml_datetime datetime.rs)

export interface TomlDate {
  year: number;
  month: number;
  day: number;
}

export interface TomlTime {
  hour: number;
  minute: number;
  second: number | undefined;
  nanosecond: number | undefined;
}

/** `toml_datetime::Datetime`. `offset` is `"Z"` or minutes east of UTC. */
export class Datetime {
  date: TomlDate | undefined;
  time: TomlTime | undefined;
  offset: "Z" | number | undefined;

  constructor(date?: TomlDate, time?: TomlTime, offset?: "Z" | number) {
    this.date = date;
    this.time = time;
    this.offset = offset;
  }

  toString(): string {
    const pad = (n: number, w: number): string => String(n).padStart(w, "0");
    let out = "";
    if (this.date)
      out += `${pad(this.date.year, 4)}-${pad(this.date.month, 2)}-${pad(this.date.day, 2)}`;
    if (this.time) {
      if (this.date) out += "T";
      const t = this.time;
      out += `${pad(t.hour, 2)}:${pad(t.minute, 2)}`;
      const second = t.second ?? (t.nanosecond !== undefined ? 0 : undefined);
      if (second !== undefined) out += `:${pad(second, 2)}`;
      if (t.nanosecond !== undefined) {
        let s = pad(t.nanosecond, 9).replace(/0+$/, "");
        if (s === "") s = "0";
        out += `.${s}`;
      }
    }
    if (this.offset !== undefined) {
      if (this.offset === "Z") {
        out += "Z";
      } else {
        const sign = this.offset < 0 ? "-" : "+";
        const m = Math.abs(this.offset);
        out += `${sign}${pad(Math.trunc(m / 60), 2)}:${pad(m % 60, 2)}`;
      }
    }
    return out;
  }
}

class DatetimeParseError extends Error {
  constructor(what?: string, expected?: string) {
    super(
      `${what ? `invalid ${what}` : "invalid datetime"}${expected ? `, expected ${expected}` : ""}`,
    );
  }
}

type DtToken = {
  kind: "digits" | "dash" | "colon" | "dot" | "t" | "space" | "z" | "plus" | "unknown";
  raw: string;
};

class DtLexer {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
  clone(): DtLexer {
    return new DtLexer(this.s);
  }
  next(): DtToken | undefined {
    if (this.s.length === 0) return undefined;
    const c = this.s.charCodeAt(0);
    let kind: DtToken["kind"];
    let end = 1;
    if (c >= 0x30 && c <= 0x39) {
      kind = "digits";
      while (end < this.s.length && isDigit(this.s.charCodeAt(end))) end++;
    } else {
      const map: Record<string, DtToken["kind"]> = {
        "-": "dash",
        ":": "colon",
        T: "t",
        t: "t",
        " ": "space",
        Z: "z",
        z: "z",
        "+": "plus",
        ".": "dot",
      };
      kind = map[this.s[0]!] ?? "unknown";
      if (kind === "unknown") end = this.s.length;
    }
    const raw = this.s.slice(0, end);
    this.s = this.s.slice(end);
    return { kind, raw };
  }
}

/** `Datetime::from_str`. Throws `DatetimeParseError` with toml_datetime's message. */
export function parseDatetime(input: string): Datetime {
  const E = (what?: string, expected?: string): DatetimeParseError =>
    new DatetimeParseError(what, expected);
  const result = new Datetime();
  let lexer = new DtLexer(input);
  const expect = (
    tok: DtToken | undefined,
    kind: DtToken["kind"],
    what: string | undefined,
    expected: string,
  ): DtToken => {
    if (!tok || tok.kind !== kind) throw E(what, expected);
    return tok;
  };
  const digits = expect(lexer.next(), "digits", undefined, "year or hour");
  const sep = lexer.next();
  if (!sep) throw E(undefined, "`-` (YYYY-MM) or `:` (HH:MM)");
  if (sep.kind === "dash") {
    const month = expect(lexer.next(), "digits", "date", "month");
    expect(lexer.next(), "dash", "date", "`-` (MM-DD)");
    const day = expect(lexer.next(), "digits", "date", "day");
    if (digits.raw.length !== 4) throw E("date", "a four-digit year (YYYY)");
    if (month.raw.length !== 2) throw E("date", "a two-digit month (MM)");
    if (day.raw.length !== 2) throw E("date", "a two-digit day (DD)");
    const date = { year: Number(digits.raw), month: Number(month.raw), day: Number(day.raw) };
    if (date.month < 1 || date.month > 12) throw E("date", "month between 01 and 12");
    const leap = date.year % 4 === 0 && (date.year % 100 !== 0 || date.year % 400 === 0);
    const [max, expected] =
      date.month === 2
        ? leap
          ? [29, "day between 01 and 29"]
          : [28, "day between 01 and 28"]
        : [4, 6, 9, 11].includes(date.month)
          ? [30, "day between 01 and 30"]
          : [31, "day between 01 and 31"];
    if (date.day < 1 || date.day > max) throw E("date", expected);
    result.date = date;
  } else if (sep.kind === "colon") {
    lexer = new DtLexer(input);
  } else {
    throw E(undefined, "`-` (YYYY-MM) or `:` (HH:MM)");
  }
  let partialTime: boolean;
  if (result.date) {
    const s = lexer.next();
    if (s && (s.kind === "t" || s.kind === "space")) partialTime = true;
    else if (s) throw E("date-time", "`T` between date and time");
    else partialTime = false;
  } else {
    partialTime = true;
  }
  if (partialTime) {
    const hour = expect(lexer.next(), "digits", "time", "hour");
    expect(lexer.next(), "colon", "time", "`:` (HH:MM)");
    const minute = expect(lexer.next(), "digits", "time", "minute");
    let second: DtToken | undefined;
    if (lexer.clone().next()?.kind === "colon") {
      lexer.next();
      second = expect(lexer.next(), "digits", "time", "second");
    }
    let nanosecond: DtToken | undefined;
    if (second && lexer.clone().next()?.kind === "dot") {
      lexer.next();
      nanosecond = expect(lexer.next(), "digits", "time", "nanosecond");
    }
    if (hour.raw.length !== 2) throw E("time", "a two-digit hour (HH)");
    if (minute.raw.length !== 2) throw E("time", "a two-digit minute (MM)");
    if (second && second.raw.length !== 2) throw E("time", "a two-digit second (SS)");
    let nanos: number | undefined;
    if (nanosecond) {
      nanos = 0;
      for (let i = 0; i < nanosecond.raw.length && i < 9; i++) {
        nanos += 10 ** (8 - i) * (nanosecond.raw.charCodeAt(i) - 0x30);
      }
    }
    const time: TomlTime = {
      hour: Number(hour.raw),
      minute: Number(minute.raw),
      second: second ? Number(second.raw) : undefined,
      nanosecond: nanos,
    };
    if (time.hour > 23) throw E("time", "hour between 00 and 23");
    if (time.minute > 59) throw E("time", "minute between 00 and 59");
    if ((time.second ?? 0) > 60) throw E("time", "second between 00 and 60");
    result.time = time;
  }
  if (result.date && result.time) {
    const tok = lexer.next();
    if (tok?.kind === "z") {
      result.offset = "Z";
    } else if (tok && (tok.kind === "plus" || tok.kind === "dash")) {
      const sign = tok.kind === "plus" ? 1 : -1;
      const hours = expect(lexer.next(), "digits", "offset", "hour");
      expect(lexer.next(), "colon", "offset", "`:` (HH:MM)");
      const minutes = expect(lexer.next(), "digits", "offset", "minute");
      if (hours.raw.length !== 2) throw E("offset", "a two-digit hour (HH)");
      if (minutes.raw.length !== 2) throw E("offset", "a two-digit minute (MM)");
      const h = Number(hours.raw);
      const m = Number(minutes.raw);
      if (h > 23) throw E("offset", "hours between 00 and 23");
      if (m > 59) throw E("offset", "minutes between 00 and 59");
      result.offset = sign * (h * 60 + m);
    } else if (tok) {
      throw E("offset", "`Z`, +OFFSET, -OFFSET");
    }
  }
  if (lexer.s.length > 0) throw E();
  return result;
}

// ---------------------------------------------------------------------------------------------
// The parsed document as toml's de builds it (de/parser/*.rs)

/** toml's `DeValue`. Integers and floats keep their decoded text, as the crate does. */
export type DeValue =
  | { t: "string"; v: string }
  | { t: "integer"; v: string; radix: number }
  | { t: "float"; v: string }
  | { t: "boolean"; v: boolean }
  | { t: "datetime"; v: Datetime }
  | { t: "array"; v: Spanned[]; aot: boolean }
  | { t: "table"; v: DeTable };

export interface Spanned {
  span: Span;
  value: DeValue;
}

interface DeKey {
  key: string;
  span: Span;
}

interface DeEntry {
  key: DeKey;
  value: Spanned;
}

/** toml's `DeTable`: a `BTreeMap` (iterates sorted), plus the parser's flags. */
export class DeTable {
  readonly map = new Map<string, DeEntry>();
  implicit = false;
  dotted = false;
  inline = false;

  entries(): DeEntry[] {
    return [...this.map.values()].sort((a, b) => compareKeys(a.key.key, b.key.key));
  }
}

function typeStr(v: DeValue): string {
  return v.t === "table" ? "table" : v.t;
}

class DeBuilder {
  private readonly source: Source;
  private readonly err: ErrorSink;
  private readonly input: Cursor<Event>;

  constructor(source: Source, events: Event[], err: ErrorSink) {
    this.source = source;
    this.err = err;
    this.input = new Cursor(events);
  }

  document(): DeTable {
    let root = new DeTable();
    let current = new DeTable();
    let header: TableHeader | undefined;
    const input = this.input;
    const finishTable = (): void => {
      const prev = current;
      current = new DeTable();
      if (!header) {
        root = prev;
        return;
      }
      const h = header;
      header = undefined;
      if (!h.key) return;
      const prevValue: Spanned = { span: h.span, value: { t: "table", v: prev } };
      const parent = this.descendPath(root, h.path, false);
      if (!parent) return;
      if (h.isArray) {
        let entry = parent.map.get(h.key.key);
        if (!entry) {
          entry = { key: h.key, value: { span: h.span, value: { t: "array", v: [], aot: true } } };
          parent.map.set(h.key.key, entry);
        }
        const array = entry.value.value;
        if (array.t !== "array" || !array.aot) {
          this.err.report({
            description: "duplicate key",
            unexpected: h.key.span,
            context: entry.value.span,
          });
          return;
        }
        array.v.push(prevValue);
      } else {
        parent.map.set(h.key.key, { key: h.key, value: prevValue });
      }
    };
    const startTable = (h: TableHeader): void => {
      if (!h.isArray) {
        const parent = this.descendPath(root, h.path, false);
        if (parent && h.key) {
          const old = parent.map.get(h.key.key);
          if (old) {
            parent.map.delete(h.key.key);
            const v = old.value.value;
            if (v.t === "table" && v.v.implicit && !v.v.dotted) {
              current = v.v;
            } else {
              this.err.report({
                description: "duplicate key",
                unexpected: h.key.span,
                context: old.key.span,
              });
              if (v.t === "table") current = v.v;
            }
          }
        }
      }
      current.implicit = false;
      current.dotted = false;
      header = h;
    };
    events: for (let event = input.next(); event; event = input.next()) {
      switch (event.kind) {
        case "stdTableOpen":
        case "arrayTableOpen":
          finishTable();
          startTable(this.onTable(event));
          break;
        case "simpleKey": {
          const [path, key] = this.onKey(event);
          if (!key) break events;
          let next = input.next();
          if (next?.kind === "whitespace") next = input.next();
          if (next?.kind !== "keyValSep") break events;
          if (input.first()?.kind === "whitespace") input.next();
          const value = this.value();
          this.captureKeyValue(current, path, key, value);
          break;
        }
        default:
          break;
      }
    }
    finishTable();
    return root;
  }

  private captureKeyValue(current: DeTable, path: DeKey[], key: DeKey, value: Spanned): void {
    const dotted = path.length > 0;
    const parent = this.descendPath(current, path, dotted);
    if (!parent) return;
    if (dotted && !parent.implicit) {
      this.err.report({ description: "duplicate key", unexpected: key.span });
      return;
    }
    const existing = parent.map.get(key.key);
    if (existing) {
      this.err.report({
        description: "duplicate key",
        unexpected: key.span,
        context: existing.key.span,
      });
    } else {
      parent.map.set(key.key, { key, value });
    }
  }

  private descendPath(table: DeTable, path: DeKey[], dotted: boolean): DeTable | undefined {
    let t = table;
    for (const key of path) {
      const entry = t.map.get(key.key);
      if (!entry) {
        const nt = new DeTable();
        nt.implicit = true;
        nt.dotted = dotted;
        t.map.set(key.key, { key, value: { span: key.span, value: { t: "table", v: nt } } });
        t = nt;
        continue;
      }
      const v = entry.value.value;
      if (v.t === "array") {
        if (!v.aot) {
          this.err.report({
            description: "cannot extend value of type array with a dotted key",
            unexpected: key.span,
            context: entry.value.span,
          });
          return undefined;
        }
        const last = v.v[v.v.length - 1]!.value;
        if (last.t !== "table") {
          this.err.report({
            description: `cannot extend value of type ${typeStr(last)} with a dotted key`,
            unexpected: key.span,
            context: entry.value.span,
          });
          return undefined;
        }
        t = last.v;
      } else if (v.t === "table") {
        if (v.v.inline) {
          this.err.report({
            description: "cannot extend value of type inline table with a dotted key",
            unexpected: key.span,
          });
          return undefined;
        }
        if (dotted && v.v.implicit) v.v.dotted = true;
        if (dotted && !v.v.implicit) {
          this.err.report({ description: "duplicate key", unexpected: key.span });
          return undefined;
        }
        t = v.v;
      } else {
        this.err.report({
          description: `cannot extend value of type ${typeStr(v)} with a dotted key`,
          unexpected: key.span,
          context: entry.value.span,
        });
        return undefined;
      }
    }
    return t;
  }

  private onTable(open: Event): TableHeader {
    const isArray = open.kind === "arrayTableOpen";
    let path: DeKey[] = [];
    let key: DeKey | undefined;
    let span: Span = [open.start, open.end];
    for (let event = this.input.next(); event; event = this.input.next()) {
      if (event.kind === "arrayTableClose" || event.kind === "stdTableClose") {
        span = [span[0], event.end];
        break;
      }
      if (event.kind === "simpleKey") [path, key] = this.onKey(event);
    }
    return { path, key, span, isArray };
  }

  /** key.rs `on_key`: a dotted key's path and last key. */
  onKey(first: Event): [DeKey[], DeKey | undefined] {
    const path: DeKey[] = [];
    let last: DeKey | undefined;
    let current: Event | undefined = first;
    const input = this.input;
    const more = (): boolean => {
      const a = input.get(0)?.kind;
      return a === "keySep" || (a === "whitespace" && input.get(1)?.kind === "keySep");
    };
    const close = (): void => {
      if (!current) return;
      const k = current;
      current = undefined;
      const decoded = decodeKey(this.source, [k.start, k.end], k.encoding, this.err);
      if (last) path.push(last);
      last = { key: decoded, span: [k.start, k.end] };
    };
    if (more()) {
      for (let event = input.next(); event; event = input.next()) {
        if (event.kind === "simpleKey") {
          current = event;
          if (!more()) break;
        } else if (event.kind === "keySep") {
          close();
        }
      }
    }
    close();
    if (LIMIT <= path.length) {
      this.err.report({ description: "recursion limit" });
      return [[], undefined];
    }
    return [path, last];
  }

  value(): Spanned {
    const event = this.input.next();
    if (event) {
      switch (event.kind) {
        case "inlineTableOpen":
          return this.onInlineTable(event);
        case "arrayOpen":
          return this.onArray(event);
        case "scalar":
          return this.onScalar(event);
        default:
          break;
      }
    }
    return { span: [0, 0], value: { t: "integer", v: "0", radix: 10 } };
  }

  private onScalar(event: Event): Spanned {
    const span: Span = [event.start, event.end];
    const [kind, decoded] = decodeScalar(this.source, span, event.encoding, this.err);
    switch (kind.t) {
      case "string":
        return { span, value: { t: "string", v: decoded } };
      case "boolean":
        return { span, value: { t: "boolean", v: kind.value } };
      case "datetime": {
        let dt: Datetime;
        try {
          dt = parseDatetime(decoded);
        } catch (e) {
          this.err.report({ description: (e as Error).message, unexpected: span });
          dt = new Datetime();
        }
        return { span, value: { t: "datetime", v: dt } };
      }
      case "float":
        return { span, value: { t: "float", v: decoded } };
      case "integer":
        return { span, value: { t: "integer", v: decoded, radix: kind.radix } };
    }
  }

  private onArray(open: Event): Spanned {
    const result: Spanned[] = [];
    let close = open;
    let current: Spanned | undefined;
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
        case "inlineTableOpen":
          current = this.onInlineTable(event);
          break;
        case "arrayOpen":
          current = this.onArray(event);
          break;
        case "scalar":
          current = this.onScalar(event);
          break;
        case "valueSep":
          if (current) result.push(current);
          current = undefined;
          break;
        case "arrayClose":
          if (current) result.push(current);
          current = undefined;
          stop = true;
          break;
        default:
          break;
      }
      if (stop) break;
    }
    return { span: [open.start, close.end], value: { t: "array", v: result, aot: false } };
  }

  private onInlineTable(open: Event): Spanned {
    const result = new DeTable();
    result.inline = true;
    let close = open;
    let currentKey: [DeKey[], DeKey] | undefined;
    let currentValue: Spanned | undefined;
    const finishValue = (): void => {
      const k = currentKey;
      const v = currentValue;
      currentKey = undefined;
      currentValue = undefined;
      if (!k || !v) return;
      const [path, key] = k;
      const table = this.descendInline(result, path);
      if (!table) return;
      if (table.dotted === (path.length === 0)) {
        this.err.report({ description: "duplicate key", unexpected: key.span });
        return;
      }
      const existing = table.map.get(key.key);
      if (existing) {
        this.err.report({
          description: "duplicate key",
          unexpected: key.span,
          context: existing.key.span,
        });
      } else {
        table.map.set(key.key, { key, value: v });
      }
    };
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
        case "simpleKey": {
          const [path, key] = this.onKey(event);
          if (key) currentKey = [path, key];
          break;
        }
        case "inlineTableOpen":
          currentValue = this.onInlineTable(event);
          break;
        case "arrayOpen":
          currentValue = this.onArray(event);
          break;
        case "scalar":
          currentValue = this.onScalar(event);
          break;
        case "valueSep":
          finishValue();
          break;
        case "inlineTableClose":
          finishValue();
          stop = true;
          break;
        default:
          break;
      }
      if (stop) break;
    }
    return { span: [open.start, close.end], value: { t: "table", v: result } };
  }

  private descendInline(table: DeTable, path: DeKey[]): DeTable | undefined {
    let t = table;
    for (const key of path) {
      const entry = t.map.get(key.key);
      if (!entry) {
        const nt = new DeTable();
        nt.implicit = true;
        nt.dotted = true;
        nt.inline = true;
        t.map.set(key.key, { key, value: { span: key.span, value: { t: "table", v: nt } } });
        t = nt;
        continue;
      }
      const v = entry.value.value;
      if (v.t === "table") {
        if (!v.v.implicit) {
          this.err.report({ description: "duplicate key", unexpected: key.span });
          return undefined;
        }
        t = v.v;
      } else {
        this.err.report({
          description: `cannot extend value of type ${typeStr(v)} with a dotted key`,
          unexpected: key.span,
          context: entry.value.span,
        });
        return undefined;
      }
    }
    return t;
  }
}

interface TableHeader {
  path: DeKey[];
  key: DeKey | undefined;
  span: Span;
  isArray: boolean;
}

/** `DeTable::parse`: the document, or the first error. */
export function parseDeTable(source: Source): DeTable {
  const err = new ErrorSink();
  const events = parseDocumentEvents(source, err);
  const builder = new DeBuilder(source, events, err);
  const root = builder.document();
  if (err.first) throw TomlError.fromParse(source, err.first);
  return root;
}

// ---------------------------------------------------------------------------------------------
// The serde Deserializer over a parsed document (de/deserializer/*.rs)

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const U128_MAX = 2n ** 128n - 1n;
const DATETIME_FIELD = "$__toml_private_datetime";

/** `from_str_radix` over the decoded digits (a sign is allowed, `_` already removed). */
function parseInteger(text: string, radix: number): bigint | undefined {
  let sign = 1n;
  let digits = text;
  if (digits.startsWith("+") || digits.startsWith("-")) {
    if (digits[0] === "-") sign = -1n;
    digits = digits.slice(1);
  }
  if (digits.length === 0) return undefined;
  const prefix = radix === 16 ? "0x" : radix === 8 ? "0o" : radix === 2 ? "0b" : "";
  try {
    return sign * BigInt(prefix + digits);
  } catch {
    return undefined;
  }
}

/** `DeFloat::to_f64`: Rust's `f64::from_str`, refusing an overflow to infinity. */
function parseFloat64(text: string): number | undefined {
  const unsigned = text.replace(/^[+-]/, "");
  const negative = text.startsWith("-");
  let f: number;
  if (unsigned === "inf") f = negative ? -Infinity : Infinity;
  else if (unsigned === "nan") f = Number.NaN;
  else f = Number(text);
  if (!Number.isFinite(f) && !Number.isNaN(f) && !text.includes("inf")) return undefined;
  return f;
}

function withSpan(e: unknown, span: Span): unknown {
  const t = asTomlError(e);
  if (t instanceof TomlError && t.span === undefined) t.setSpan(span);
  return t;
}

const UNIT_ONLY: VariantAccess = { unitVariant: () => {} };

/**
 * serde's `IgnoredAny` visitor. toml forwards `deserialize_ignored_any` to `deserialize_any`,
 * so an unknown field is walked (and an overflowing integer in it still fails).
 */
const IGNORE: Visitor<void> = {
  expecting: "anything at all",
  visitBool: () => {},
  visitI64: () => {},
  visitU64: () => {},
  visitF64: () => {},
  visitStr: () => {},
  visitUnit: () => {},
  visitNone: () => {},
  visitSome: (de) => ignoreAny(de),
  visitSeq: (seq) => {
    while (seq.nextElement(ignoreAny));
  },
  visitMap: (map) => {
    while (map.nextKey(ignoreAny)) map.nextValue(ignoreAny);
  },
};
const ignoreAny: Decoder<void> = (de) => de.deserializeAny(IGNORE);

function ignoreThenUnit<T>(de: Deserializer, v: Visitor<T>): T {
  de.deserializeAny(IGNORE);
  return visitUnit(v);
}

/** serde's `StrDeserializer` / `StringDeserializer`: a string, or a unit variant by name. */
class StrDeserializer implements Deserializer {
  private readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  deserializeAny<T>(v: Visitor<T>): T {
    return visitStr(v, this.value);
  }
  deserializeBool = this.deserializeAny;
  deserializeNumber = this.deserializeAny;
  deserializeStr = this.deserializeAny;
  deserializeOption = this.deserializeAny;
  deserializeUnit = this.deserializeAny;
  deserializeSeq = this.deserializeAny;
  deserializeMap = this.deserializeAny;
  deserializeStruct = this.deserializeAny;
  deserializeIdentifier = this.deserializeAny;
  deserializeIgnoredAny<T>(v: Visitor<T>): T {
    return ignoreThenUnit(this, v);
  }
  deserializeEnum<T>(v: Visitor<T>): T {
    const access: EnumAccess = { variant: (seed) => [seed(this), UNIT_ONLY] };
    return visitEnum(v, access);
  }
  startOffset(): number {
    return -1;
  }
  endOffset(): number {
    return -1;
  }
}

/** de/deserializer/key.rs `KeyDeserializer`. */
class KeyDeserializer extends StrDeserializer {
  private readonly key: string;

  constructor(key: string) {
    super(key);
    this.key = key;
  }

  override deserializeBool = <T>(v: Visitor<T>): T => {
    if (this.key === "true" || this.key === "false") return visitBool(v, this.key === "true");
    throw custom("provided string was not `true` or `false`");
  };
}

function visitInteger<T>(v: Visitor<T>, text: string, radix: number): T {
  const n = parseInteger(text, radix);
  if (n !== undefined) {
    if (v === (IGNORE as Visitor<unknown>) && n >= I128_MIN && n <= U128_MAX) return undefined as T;
    if (n >= I64_MIN && n <= I64_MAX) return visitI64(v, n);
    if (n >= 0n && n <= U64_MAX) return visitU64(v, n);
    if (n >= I128_MIN && n <= I128_MAX) {
      throw invalidType({ kind: "other", value: `integer \`${n}\` as i128` }, v.expecting);
    }
    if (n >= 0n && n <= U128_MAX) {
      throw invalidType({ kind: "other", value: `integer \`${n}\` as u128` }, v.expecting);
    }
  }
  throw tomlCustom("integer number overflowed");
}

function keyWithSpan<T>(seed: Decoder<T>, key: DeKey): T {
  try {
    return seed(new KeyDeserializer(key.key));
  } catch (e) {
    throw withSpan(e, key.span);
  }
}

/** de/deserializer/value.rs `ValueDeserializer` (and the table, array and datetime ones). */
class TomlDeserializer implements Deserializer {
  private readonly value: DeValue;
  private readonly span: Span;

  constructor(value: DeValue, span: Span) {
    this.value = value;
    this.span = span;
  }

  private wrap<T>(body: () => T): T {
    try {
      return body();
    } catch (e) {
      throw withSpan(e, this.span);
    }
  }

  deserializeAny<T>(v: Visitor<T>): T {
    return this.wrap(() => {
      const val = this.value;
      switch (val.t) {
        case "string":
          return visitStr(v, val.v);
        case "integer":
          return visitInteger(v, val.v, val.radix);
        case "float": {
          const f = parseFloat64(val.v);
          if (f === undefined) throw tomlCustom("floating-point number overflowed");
          return visitF64(v, f);
        }
        case "boolean":
          return visitBool(v, val.v);
        case "datetime":
          return visitMap(v, datetimeAccess(val.v));
        case "array": {
          let i = 0;
          const items = val.v;
          const seq: SeqAccess = {
            nextElement: (seed) => {
              if (i >= items.length) return undefined;
              const item = items[i++]!;
              return { value: seed(new TomlDeserializer(item.value, item.span)) };
            },
          };
          return visitSeq(v, seq);
        }
        case "table":
          return visitMap(v, new TableMapAccess(val.v));
      }
    });
  }

  deserializeBool = this.deserializeAny;
  deserializeNumber = this.deserializeAny;
  deserializeStr = this.deserializeAny;
  deserializeUnit = this.deserializeAny;
  deserializeSeq = this.deserializeAny;
  deserializeMap = this.deserializeAny;
  deserializeStruct = this.deserializeAny;
  deserializeIdentifier = this.deserializeAny;

  deserializeIgnoredAny<T>(v: Visitor<T>): T {
    return ignoreThenUnit(this, v);
  }

  deserializeOption<T>(v: Visitor<T>): T {
    return this.wrap(() => visitSome(v, this));
  }

  deserializeEnum<T>(v: Visitor<T>): T {
    return this.wrap(() => {
      const val = this.value;
      if (val.t === "string") return new StrDeserializer(val.v).deserializeEnum(v);
      if (val.t !== "table") throw tomlCustom("wanted string or table", this.span);
      const entries = val.v.entries();
      if (entries.length === 0)
        throw tomlCustom("wanted exactly 1 element, found 0 elements", this.span);
      if (entries.length !== 1)
        throw tomlCustom("wanted exactly 1 element, more than 1 element", this.span);
      const entry = entries[0]!;
      const access: EnumAccess = {
        variant: (seed) => {
          const key = keyWithSpan(seed, entry.key);
          const value = entry.value;
          const variant: VariantAccess = {
            unitVariant: () => {
              const inner = value.value;
              if (inner.t === "array") {
                if (inner.v.length > 0) throw tomlCustom("expected empty array", value.span);
              } else if (inner.t === "table") {
                if (inner.v.map.size > 0) throw tomlCustom("expected empty table", value.span);
              } else {
                throw tomlCustom(`expected table, found ${typeStr(inner)}`, value.span);
              }
            },
          };
          return [key, variant];
        },
      };
      return visitEnum(v, access);
    });
  }

  startOffset(): number {
    return -1;
  }
  endOffset(): number {
    return -1;
  }
}

/** toml_datetime's `DatetimeDeserializer`: a datetime is a one-entry map to its string. */
function datetimeAccess(dt: Datetime): MapAccess {
  let date: Datetime | undefined = dt;
  return {
    nextKey: (seed) => (date ? { value: seed(new StrDeserializer(DATETIME_FIELD)) } : undefined),
    nextValue: (seed) => {
      const d = date!;
      date = undefined;
      return seed(new StrDeserializer(d.toString()));
    },
  };
}

class TableMapAccess implements MapAccess {
  private readonly entries: DeEntry[];
  private i = 0;
  private pending: DeEntry | undefined;

  constructor(table: DeTable) {
    this.entries = table.entries();
  }

  nextKey<T>(seed: Decoder<T>): { value: T } | undefined {
    if (this.i >= this.entries.length) return undefined;
    const entry = this.entries[this.i++]!;
    this.pending = entry;
    try {
      return { value: seed(new KeyDeserializer(entry.key.key)) };
    } catch (e) {
      throw withSpan(e, entry.key.span);
    }
  }

  nextValue<T>(seed: Decoder<T>): T {
    const entry = this.pending!;
    this.pending = undefined;
    try {
      return seed(new TomlDeserializer(entry.value.value, entry.value.span));
    } catch (e) {
      const t = withSpan(e, entry.value.span);
      if (t instanceof TomlError) t.addKey(entry.key.key);
      throw t;
    }
  }
}

/** `toml::from_str::<T>`: parse `text`, then decode it. Throws `TomlError`. */
export function fromStr<T>(text: string, decoder: Decoder<T>): T {
  const source = new Source(text);
  const root = parseDeTable(source);
  try {
    return decoder(new TomlDeserializer({ t: "table", v: root }, [0, 0]));
  } catch (e) {
    const t = asTomlError(e);
    if (t instanceof TomlError) t.setInput(source);
    throw t;
  }
}

// ---------------------------------------------------------------------------------------------
// toml::Value and toml::Table (value.rs, table.rs)

/** `toml::Value`. Integers are i64, as `bigint`. */
export type TomlValue =
  | { type: "string"; value: string }
  | { type: "integer"; value: bigint }
  | { type: "float"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "datetime"; value: Datetime }
  | { type: "array"; value: TomlValue[] }
  | { type: "table"; value: TomlTable };

/** `toml::Table`: a `BTreeMap<String, Value>`, so it iterates in key order. */
export type TomlTable = Map<string, TomlValue>;

/** `Value::type_str`. */
export function valueTypeStr(v: TomlValue): string {
  return v.type;
}

/** `value.get(key)`: the entry of a table, `undefined` for anything else. */
export function get(v: TomlValue | TomlTable | undefined, key: string): TomlValue | undefined {
  if (v === undefined) return undefined;
  if (v instanceof Map) return v.get(key);
  return v.type === "table" ? v.value.get(key) : undefined;
}

function sortedTable(entries: Iterable<[string, TomlValue]>): TomlTable {
  return new Map([...entries].sort(([a], [b]) => compareKeys(a, b)));
}

function readTableEntries(access: MapAccess, first?: [string, TomlValue]): TomlTable {
  const values = new Map<string, TomlValue>();
  if (first) values.set(first[0], first[1]);
  for (let k = access.nextKey(str); k; k = access.nextKey(str)) {
    if (values.has(k.value)) throw custom(`duplicate key: \`${k.value}\``);
    values.set(k.value, access.nextValue(tomlValue));
  }
  return sortedTable(values);
}

const VALUE_VISITOR: Visitor<TomlValue> = {
  expecting: "any valid TOML value",
  visitBool: (value) => ({ type: "boolean", value }),
  visitI64: (value) => ({ type: "integer", value }),
  visitU64: (value) => {
    if (value > I64_MAX) throw custom("u64 value was too large");
    return { type: "integer", value };
  },
  visitF64: (value) => ({ type: "float", value }),
  visitStr: (value) => ({ type: "string", value }),
  visitSome: (de) => tomlValue(de),
  visitSeq: (seq) => {
    const value: TomlValue[] = [];
    for (let el = seq.nextElement(tomlValue); el; el = seq.nextElement(tomlValue))
      value.push(el.value);
    return { type: "array", value };
  },
  visitMap: (access) => {
    const first = access.nextKey(str);
    if (!first) return { type: "table", value: new Map() };
    if (first.value === DATETIME_FIELD) {
      const text = access.nextValue(str);
      try {
        return { type: "datetime", value: parseDatetime(text) };
      } catch (e) {
        throw custom((e as Error).message);
      }
    }
    const value = access.nextValue(tomlValue);
    return { type: "table", value: readTableEntries(access, [first.value, value]) };
  },
};

/** `toml::Value` as a decoder. */
export const tomlValue: Decoder<TomlValue> = (de) => de.deserializeAny(VALUE_VISITOR);

/** `toml::Table` as a decoder. */
export const tomlTable: Decoder<TomlTable> = (de) =>
  de.deserializeMap({
    expecting: "a map",
    visitUnit: () => new Map(),
    visitMap: (access) => readTableEntries(access),
  });

/** `toml::from_str::<toml::Table>`. */
export function parseTable(text: string): TomlTable {
  return fromStr(text, tomlTable);
}

/** The serde Deserializer `toml::Value` (and `Table`) implement, for `try_into`. */
class ValueDeserializer implements Deserializer {
  private readonly value: TomlValue;

  constructor(value: TomlValue) {
    this.value = value;
  }

  deserializeAny<T>(v: Visitor<T>): T {
    const val = this.value;
    switch (val.type) {
      case "boolean":
        return visitBool(v, val.value);
      case "integer":
        return visitI64(v, val.value);
      case "float":
        return visitF64(v, val.value);
      case "string":
        return visitStr(v, val.value);
      case "datetime":
        return visitStr(v, val.value.toString());
      case "array": {
        const items = val.value;
        let i = 0;
        const seq: SeqAccess = {
          nextElement: (seed) =>
            i < items.length ? { value: seed(new ValueDeserializer(items[i++]!)) } : undefined,
        };
        const out = visitSeq(v, seq);
        if (i < items.length) throw invalidLength(items.length, "fewer elements in array");
        return out;
      }
      case "table": {
        const entries = [...val.value];
        let i = 0;
        let pending: [string, TomlValue] | undefined;
        const map: MapAccess = {
          nextKey: (seed) => {
            if (i >= entries.length) return undefined;
            pending = entries[i++]!;
            return { value: seed(new ValueDeserializer({ type: "string", value: pending[0] })) };
          },
          nextValue: (seed) => {
            const [key, value] = pending!;
            pending = undefined;
            try {
              return seed(new ValueDeserializer(value));
            } catch (e) {
              const t = asTomlError(e);
              if (t instanceof TomlError) t.addKey(key);
              throw t;
            }
          },
        };
        const out = visitMap(v, map);
        if (i < entries.length) throw invalidLength(entries.length, "fewer elements in map");
        return out;
      }
    }
  }

  deserializeBool = this.deserializeAny;
  deserializeNumber = this.deserializeAny;
  deserializeStr = this.deserializeAny;
  deserializeUnit = this.deserializeAny;
  deserializeSeq = this.deserializeAny;
  deserializeMap = this.deserializeAny;
  deserializeStruct = this.deserializeAny;
  deserializeIdentifier = this.deserializeAny;

  deserializeIgnoredAny<T>(v: Visitor<T>): T {
    return ignoreThenUnit(this, v);
  }

  deserializeOption<T>(v: Visitor<T>): T {
    return visitSome(v, this);
  }

  deserializeEnum<T>(v: Visitor<T>): T {
    const val = this.value;
    if (val.type === "string") return new StrDeserializer(val.value).deserializeEnum(v);
    if (val.type !== "table") throw invalidType({ kind: "unitVariant" }, "string only");
    if (val.value.size === 0) throw tomlCustom("wanted exactly 1 element, found 0 elements");
    if (val.value.size !== 1) throw tomlCustom("wanted exactly 1 element, more than 1 element");
    const [key, inner] = [...val.value][0]!;
    const access: EnumAccess = {
      variant: (seed) => [
        seed(new StrDeserializer(key)),
        {
          unitVariant: () => {
            if (inner.type === "array") {
              if (inner.value.length > 0) throw tomlCustom("expected empty array");
            } else if (inner.type === "table") {
              if (inner.value.size > 0) throw tomlCustom("expected empty table");
            } else {
              throw tomlCustom(`expected table, found ${inner.type}`);
            }
          },
        },
      ],
    };
    return visitEnum(v, access);
  }

  startOffset(): number {
    return -1;
  }
  endOffset(): number {
    return -1;
  }
}

/** `Value::try_into::<T>` / `Table::try_into::<T>`. Errors carry no position, only keys. */
export function tryInto<T>(value: TomlValue | TomlTable, decoder: Decoder<T>): T {
  const v: TomlValue = value instanceof Map ? { type: "table", value } : value;
  try {
    return decoder(new ValueDeserializer(v));
  } catch (e) {
    throw asTomlError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Serialization: serde's data model, as typed encoders build it

/**
 * A value in serde's data model, as `Serialize` would hand it to a serializer. Encoders build
 * it from typed values (see `encStruct`); `toTomlString` serializes it as toml does.
 */
export type Ser =
  | { k: "bool"; v: boolean }
  | { k: "int"; v: bigint }
  | { k: "float"; v: number }
  | { k: "str"; v: string }
  | { k: "none" }
  | { k: "unitVariant"; v: string }
  | { k: "seq"; v: Ser[] }
  | { k: "map"; v: [string, Ser][] }
  | { k: "struct"; name: string; v: [string, Ser][] }
  | { k: "datetime"; v: Datetime };

/** serde's `Serialize`, for one type. */
export type Encoder<T> = (value: T) => Ser;

export const encStr: Encoder<string> = (v) => ({ k: "str", v });
export const encBool: Encoder<boolean> = (v) => ({ k: "bool", v });
/** Any Rust integer type (the value is written in decimal). */
export const encInt: Encoder<number | bigint> = (v) => ({ k: "int", v: BigInt(v) });
export const encFloat: Encoder<number> = (v) => ({ k: "float", v });
export const encDatetime: Encoder<Datetime> = (v) => ({ k: "datetime", v });
/** A unit variant, by its serialized name (e.g. `#[serde(rename_all = "lowercase")]`). */
export const encUnitVariant: Encoder<string> = (v) => ({ k: "unitVariant", v });

/** `Option<T>`: `undefined` or `null` is `None`. */
export function encOption<T>(inner: Encoder<T>): Encoder<T | undefined | null> {
  return (v) => (v === undefined || v === null ? { k: "none" } : inner(v));
}

/** `Vec<T>`. */
export function encArray<T>(inner: Encoder<T>): Encoder<readonly T[]> {
  return (v) => ({ k: "seq", v: v.map(inner) });
}

/** `BTreeMap<String, T>`: entries in key order. */
export function encMap<T>(
  inner: Encoder<T>,
): Encoder<ReadonlyMap<string, T> | Readonly<Record<string, T>>> {
  return (v) => {
    const entries: [string, T][] =
      v instanceof Map ? [...v] : Object.entries(v as Record<string, T>);
    entries.sort(([a], [b]) => compareKeys(a, b));
    return { k: "map", v: entries.map(([key, value]) => [key, inner(value)]) };
  };
}

/** A struct field with attributes: `#[serde(rename = "…", skip_serializing_if = "…")]`. */
export interface EncField<V> {
  enc: Encoder<V>;
  rename?: string;
  skipIf?: (value: V) => boolean;
}

/** `skip_serializing_if = "Option::is_none"`. */
export const isNone = (v: unknown): boolean => v === undefined || v === null;
/** `skip_serializing_if = "Vec::is_empty"` / `"BTreeMap::is_empty"`. */
export const isEmpty = (v: unknown): boolean =>
  v instanceof Map
    ? v.size === 0
    : Array.isArray(v)
      ? v.length === 0
      : Object.keys(v as object).length === 0;

/**
 * A `#[derive(Serialize)] struct`, fields in declaration order (the object's key order). Each
 * field is an encoder or an `EncField` with attributes.
 */
export function encStruct<T>(
  name: string,
  fields: { [K in keyof T]: Encoder<T[K]> | EncField<T[K]> },
): Encoder<T> {
  const compiled = Object.entries(fields).map(([key, f]) => {
    const spec = (typeof f === "function" ? { enc: f } : f) as EncField<unknown>;
    return { key, name: spec.rename ?? key, enc: spec.enc, skipIf: spec.skipIf };
  });
  return (value) => {
    const v: [string, Ser][] = [];
    for (const f of compiled) {
      const fieldValue = (value as Record<string, unknown>)[f.key];
      if (f.skipIf?.(fieldValue)) continue;
      v.push([f.name, f.enc(fieldValue)]);
    }
    return { k: "struct", name, v };
  };
}

/** `toml::Value`'s `Serialize`. */
export const encTomlValue: Encoder<TomlValue> = (v) => {
  switch (v.type) {
    case "string":
      return { k: "str", v: v.value };
    case "integer":
      return { k: "int", v: v.value };
    case "float":
      return { k: "float", v: v.value };
    case "boolean":
      return { k: "bool", v: v.value };
    case "datetime":
      return { k: "datetime", v: v.value };
    case "array":
      return { k: "seq", v: v.value.map(encTomlValue) };
    case "table":
      return encTomlTable(v.value);
  }
};

/** `toml::Table`'s `Serialize`. */
export const encTomlTable: Encoder<TomlTable> = (t) => ({
  k: "map",
  v: [...t].map(([key, value]) => [key, encTomlValue(value)]),
});

// ---------------------------------------------------------------------------------------------
// toml_writer: how strings, keys and floats are written

interface StringMetrics {
  maxSingle: number;
  maxDouble: number;
  escapeCodes: boolean;
  escape: boolean;
  newline: boolean;
}

function stringMetrics(b: Uint8Array): StringMetrics {
  const m: StringMetrics = {
    maxSingle: 0,
    maxDouble: 0,
    escapeCodes: false,
    escape: false,
    newline: false,
  };
  let single = 0;
  let double = 0;
  for (const byte of b) {
    single = byte === APOS ? Math.min(255, single + 1) : 0;
    m.maxSingle = Math.max(m.maxSingle, single);
    double = byte === QUOTE ? Math.min(255, double + 1) : 0;
    m.maxDouble = Math.max(m.maxDouble, double);
    if (byte === BACKSLASH) m.escape = true;
    else if (byte === TAB) {
      // always allowed
    } else if (byte === NL) m.newline = true;
    else if (byte <= 0x1f || byte === 0x7f) m.escapeCodes = true;
  }
  return m;
}

/** toml_writer's `write_toml_value` for one encoding. */
function writeEncoded(decoded: string, enc: Encoding, newline: boolean): string {
  const delimiter =
    enc === "literal"
      ? "'"
      : enc === "basic"
        ? '"'
        : enc === "mlliteral"
          ? "'''"
          : enc === "mlbasic"
            ? '"""'
            : "";
  const escaped = enc === "basic" || enc === "mlbasic";
  const ml = enc === "mlliteral" || enc === "mlbasic";
  let out = delimiter;
  if (newline && ml) out += "\n";
  if (!escaped) return `${out}${decoded}${delimiter}`;
  const maxDouble = ml ? 2 : 0;
  const b = encoder.encode(decoded);
  let i = 0;
  while (i < b.length) {
    let end = i;
    let esc: string | undefined;
    let double = 0;
    for (; end < b.length; end++) {
      const c = b[end]!;
      if (c === QUOTE) {
        double += 1;
        if (maxDouble < double) {
          esc = '\\"';
          break;
        }
      } else {
        double = 0;
      }
      if (c === 0x08) esc = "\\b";
      else if (c === TAB) esc = "\\t";
      else if (c === NL && !ml) esc = "\\n";
      else if (c === 0x0c) esc = "\\f";
      else if (c === CR) esc = "\\r";
      else if (c === BACKSLASH) esc = "\\\\";
      else if ((c <= 0x1f && c !== NL) || c === 0x7f) break;
      if (esc) break;
    }
    out += decode(b.subarray(i, end));
    i = end;
    if (esc) {
      out += esc;
      i += 1;
    } else if (i < b.length) {
      out += `\\u${b[i]!.toString(16).toUpperCase().padStart(4, "0")}`;
      i += 1;
    }
  }
  return out + delimiter;
}

/** `TomlStringBuilder::new(s).as_default()`, written. */
export function tomlString(s: string): string {
  const m = stringMetrics(encoder.encode(s));
  if (!m.escapeCodes && !m.escape && m.maxDouble === 0 && !m.newline)
    return writeEncoded(s, "basic", m.newline);
  if (!m.escapeCodes && m.maxSingle === 0 && !m.newline)
    return writeEncoded(s, "literal", m.newline);
  if (!m.escapeCodes && !m.escape && m.maxDouble <= 2) return writeEncoded(s, "mlbasic", m.newline);
  if (!m.escapeCodes && m.maxSingle <= 2) return writeEncoded(s, "mlliteral", m.newline);
  return writeEncoded(s, m.newline ? "mlbasic" : "basic", m.newline);
}

/** `TomlKeyBuilder::new(s).as_default()`, written. */
export function tomlKey(s: string): string {
  const b = encoder.encode(s);
  let unquoted = b.length > 0;
  let single = false;
  let double = false;
  let escapeCodes = false;
  let backslash = false;
  for (const byte of b) {
    if (!isUnquotedChar(byte)) unquoted = false;
    if (byte === APOS) single = true;
    else if (byte === QUOTE) double = true;
    else if (byte === BACKSLASH) backslash = true;
    else if (byte !== TAB && (byte <= 0x1f || byte === 0x7f)) escapeCodes = true;
  }
  if (unquoted) return s;
  if (!escapeCodes && !backslash && !double) return writeEncoded(s, "basic", false);
  if (!escapeCodes && !single) return writeEncoded(s, "literal", false);
  return writeEncoded(s, "basic", false);
}

/** toml_writer's f64: `nan`, `-0.0`, integral values with `.0`, else Rust's `Display`. */
export function tomlFloat(f: number): string {
  if (Number.isNaN(f)) return "nan";
  if (f === 0) return Object.is(f, -0) ? "-0.0" : "0.0";
  if (!Number.isFinite(f)) return f > 0 ? "inf" : "-inf";
  const s = rustDisplay(f);
  return f % 1 === 0 ? `${s}.0` : s;
}

function rustDisplay(value: number): string {
  const sign = value < 0 ? "-" : "";
  const [mantissa, exp] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const point = Number(exp) + 1;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// ---------------------------------------------------------------------------------------------
// toml's serializer (ser/document/*.rs, ser/value/*.rs)

/** `toml::ser::Error`. */
export class TomlSerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlSerError";
  }
}

const UNSUPPORTED_NONE = "unsupported None value";

interface SerTable {
  key: string[] | null;
  body: string;
  hasChildren: boolean;
  array: boolean;
  pos: number;
}

class SerBuffer {
  private readonly tables: (SerTable | null)[] = [];

  newTable(key: string[] | null): SerTable {
    const t: SerTable = {
      key,
      body: "",
      hasChildren: false,
      array: false,
      pos: this.tables.length,
    };
    this.tables.push(null);
    return t;
  }

  child(parent: SerTable, key: string): SerTable {
    parent.hasChildren = true;
    return this.newTable([...(parent.key ?? []), key]);
  }

  element(parent: SerTable, key: string): SerTable {
    const t = this.child(parent, key);
    t.array = true;
    return t;
  }

  push(t: SerTable): void {
    this.tables[t.pos] = t;
  }

  toString(): string {
    const shown = this.tables.filter(
      (t): t is SerTable =>
        t !== null &&
        (t.key === null ? t.body.length > 0 : t.array || t.body.length > 0 || !t.hasChildren),
    );
    return shown
      .map((t) => {
        if (!t.key) return t.body;
        const [open, close] = t.array ? ["[[", "]]"] : ["[", "]"];
        return `${open}${t.key.join(".")}${close}\n${t.body}`;
      })
      .join("\n");
  }
}

type Strategy = "value" | "table" | "aot" | "skip";

function strategy(v: Ser): Strategy {
  switch (v.k) {
    case "none":
      return "skip";
    case "seq":
      if (v.v.length === 0) return "value";
      return v.v.every((el) => strategy(el) === "table") ? "aot" : "value";
    case "map":
    case "struct":
      return "table";
    default:
      return "value";
  }
}

function unsupportedType(v: Ser): string {
  const names: Record<string, string> = {
    bool: "bool",
    int: "i64",
    float: "f64",
    str: "str",
    seq: "array",
  };
  return `unsupported ${v.k === "unitVariant" ? v.v : (names[v.k] ?? "rust")} type`;
}

function serializeDocument(buf: SerBuffer, table: SerTable, v: Ser, pretty: boolean): void {
  if (v.k === "none") throw new TomlSerError(UNSUPPORTED_NONE);
  if (v.k !== "map" && v.k !== "struct") throw new TomlSerError(unsupportedType(v));
  for (const [rawKey, value] of v.v) {
    const key = tomlKey(rawKey);
    switch (strategy(value)) {
      case "value":
        table.body += `${key} = ${serializeValue(value, pretty)}\n`;
        break;
      case "aot": {
        table.hasChildren = true;
        const parent = { ...table };
        for (const el of (value as Ser & { k: "seq" }).v) {
          serializeDocument(buf, buf.element(parent, key), el, pretty);
        }
        break;
      }
      case "table":
        serializeDocument(buf, buf.child(table, key), value, pretty);
        break;
      case "skip":
        break;
    }
  }
  buf.push(table);
}

function serializeValue(v: Ser, pretty: boolean): string {
  switch (v.k) {
    case "bool":
      return String(v.v);
    case "int":
      return v.v.toString();
    case "float":
      return tomlFloat(Number.isNaN(v.v) ? Number.NaN : v.v);
    case "str":
    case "unitVariant":
      return tomlString(v.v);
    case "datetime":
      return v.v.toString();
    case "none":
      throw new TomlSerError(UNSUPPORTED_NONE);
    case "seq": {
      const multiline = pretty && v.v.length >= 2;
      let out = "[";
      v.v.forEach((el, i) => {
        if (multiline) out += "\n    ";
        else if (i > 0) out += ", ";
        out += serializeValue(el, pretty);
        if (multiline) out += ",";
      });
      if (multiline && v.v.length > 0) out += "\n";
      return `${out}]`;
    }
    case "map":
    case "struct": {
      let out = "{";
      let seen = false;
      for (const [key, value] of v.v) {
        if (value.k === "none") continue;
        const encoded = serializeValue(value, pretty);
        if (seen) out += ",";
        seen = true;
        out += ` ${tomlKey(key)} = ${encoded}`;
      }
      if (seen) out += " ";
      return `${out}}`;
    }
  }
}

function serializeRoot(value: Ser, pretty: boolean): string {
  const buf = new SerBuffer();
  serializeDocument(buf, buf.newTable(null), value, pretty);
  return buf.toString();
}

/** `toml::to_string`. Throws `TomlSerError`. */
export function toTomlString<T>(value: T, enc: Encoder<T>): string {
  return serializeRoot(enc(value), false);
}

/** `toml::to_string_pretty`: arrays of two or more elements go one element per line. */
export function toTomlStringPretty<T>(value: T, enc: Encoder<T>): string {
  return serializeRoot(enc(value), true);
}
