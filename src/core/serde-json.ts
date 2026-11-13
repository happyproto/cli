// A port of serde_json 1.0.151's parser (src/de.rs, src/read.rs, src/error.rs) and of the
// serde 1.0.229 / serde_derive pieces the hpy CLI relies on, so that error messages are
// byte-identical to the Rust binary's: `EOF while parsing an object at line 1 column 1`,
// `missing field \`id\` at line 3 column 1`, `invalid type: integer \`5\`, expected a string`.
//
// The model is serde's own: a `Decoder<T>` is `Deserialize::deserialize`, a function of a
// `Deserializer`, and every decoder drives the streaming JSON deserializer through serde's
// visitor protocol. That keeps error *positions* identical to `serde_json::from_str::<T>`,
// which streams: a type error is reported where the stream stood when the visitor failed,
// before any later syntax error, and a `missing field` is reported after the struct's closing
// brace has been consumed.
//
// Numbers follow serde_json without `float_roundtrip` or `arbitrary_precision` (hpy enables
// neither): integers are u64 / i64 and are kept as `bigint` inside a `Node`; floats are f64,
// computed with serde_json's own significand-times-power-of-ten algorithm, so they are
// bit-identical to Rust's.

import { rustEscapesUnicode } from "./rust-str.ts";

// ---------------------------------------------------------------------------------------------
// Errors (src/error.rs)

/** serde_json::Error. `message` is its `Display`; `line` is 0 when serde_json has no position. */
export class SerdeJsonError extends Error {
  /** The message without the ` at line L column C` suffix (serde_json's `ErrorCode`). */
  readonly code: string;
  readonly line: number;
  readonly column: number;

  constructor(code: string, line: number, column: number) {
    super(line === 0 ? code : `${code} at line ${line} column ${column}`);
    this.name = "SerdeJsonError";
    this.code = code;
    this.line = line;
    this.column = column;
  }
}

const EOF_LIST = "EOF while parsing a list";
const EOF_OBJECT = "EOF while parsing an object";
const EOF_STRING = "EOF while parsing a string";
const EOF_VALUE = "EOF while parsing a value";
const EXPECTED_COLON = "expected `:`";
const EXPECTED_LIST_COMMA_OR_END = "expected `,` or `]`";
const EXPECTED_OBJECT_COMMA_OR_END = "expected `,` or `}`";
const EXPECTED_SOME_IDENT = "expected ident";
const EXPECTED_SOME_VALUE = "expected value";
const EXPECTED_DOUBLE_QUOTE = 'expected `"`';
const INVALID_ESCAPE = "invalid escape";
const INVALID_NUMBER = "invalid number";
const NUMBER_OUT_OF_RANGE = "number out of range";
const CONTROL_CHARACTER = "control character (\\u0000-\\u001F) found while parsing a string";
const KEY_MUST_BE_A_STRING = "key must be a string";
const EXPECTED_NUMERIC_KEY = "invalid value: expected key to be a number in quotes";
const LONE_LEADING_SURROGATE = "lone leading surrogate in hex escape";
const TRAILING_COMMA = "trailing comma";
const TRAILING_CHARACTERS = "trailing characters";
const UNEXPECTED_END_OF_HEX_ESCAPE = "unexpected end of hex escape";
const RECURSION_LIMIT_EXCEEDED = "recursion limit exceeded";

/**
 * An error raised by a decoder or visitor (serde's `de::Error::custom`, `invalid_type`, ...)
 * before any format has rendered it. Each format's error type renders serde's `Unexpected`
 * its own way (serde_json shows unit as `null`, toml as `unit value`), so the error keeps a
 * renderer and the deserializer that catches it turns it into its own error type, with a
 * position: `SerdeJsonError` here, `TomlError` in toml.ts.
 */
export class DeError extends Error {
  readonly render: (show: (u: Unexpected) => string) => string;

  constructor(render: (show: (u: Unexpected) => string) => string) {
    super(render(showUnexpected));
    this.name = "DeError";
    this.render = render;
  }
}

/** `de::Error::custom`. */
export function custom(message: string): DeError {
  return new DeError(() => message);
}

/**
 * serde_json's `make_error`: a message that already ends in ` at line L column C` has that
 * suffix parsed back into a position.
 */
function makeError(message: string): SerdeJsonError {
  const suffix = message.lastIndexOf(" at line ");
  if (suffix >= 0) {
    const match = /^ at line (\d+) column (\d+)$/.exec(message.slice(suffix));
    if (match) {
      return new SerdeJsonError(message.slice(0, suffix), Number(match[1]), Number(match[2]));
    }
  }
  return new SerdeJsonError(message, 0, 0);
}

/** A `DeError` as serde_json's error (position-less until a deserializer fixes it). */
function toJsonError(e: unknown): unknown {
  return e instanceof DeError ? makeError(e.render(showUnexpected)) : e;
}

function fail(error: Error): never {
  throw error;
}

/** serde's `Unexpected`. `other` is `Unexpected::Other`, shown as given. */
export type Unexpected =
  | { kind: "bool"; value: boolean }
  | { kind: "unsigned"; value: bigint }
  | { kind: "signed"; value: bigint }
  | { kind: "float"; value: number }
  | { kind: "str"; value: string }
  | { kind: "other"; value: string }
  | { kind: "unit" | "option" | "seq" | "map" | "enum" | "unitVariant" };

/** serde_json's `JsonUnexpected`: unit is `null`, floats use serde_json's float formatting. */
function showUnexpected(u: Unexpected): string {
  switch (u.kind) {
    case "bool":
      return `boolean \`${u.value}\``;
    case "unsigned":
    case "signed":
      return `integer \`${u.value}\``;
    case "float":
      return `floating point \`${formatF64(u.value)}\``;
    case "str":
      return `string ${debugStr(u.value)}`;
    case "other":
      return u.value;
    case "unit":
      return "null";
    case "option":
      return "Option value";
    case "seq":
      return "sequence";
    case "map":
      return "map";
    case "enum":
      return "enum";
    case "unitVariant":
      return "unit variant";
  }
}

/** serde's own `Display for Unexpected`, which formats without an override use (toml does). */
export function serdeUnexpected(u: Unexpected): string {
  switch (u.kind) {
    case "bool":
      return `boolean \`${u.value}\``;
    case "unsigned":
    case "signed":
      return `integer \`${u.value}\``;
    case "float":
      return `floating point \`${rustDisplayF64WithPoint(u.value)}\``;
    case "str":
      return `string ${debugStr(u.value)}`;
    case "other":
      return u.value;
    case "unit":
      return "unit value";
    case "option":
      return "Option value";
    case "seq":
      return "sequence";
    case "map":
      return "map";
    case "enum":
      return "enum";
    case "unitVariant":
      return "unit variant";
  }
}

/**
 * Rust's `Display for f64` (shortest round-trip digits, never an exponent), then serde's
 * `WithDecimalPoint`: `.0` is added to a finite value printed without a `.`.
 */
export function rustDisplayF64WithPoint(value: number): string {
  const s = rustDisplayF64(value);
  return Number.isFinite(value) && !s.includes(".") ? `${s}.0` : s;
}

/** Rust's `Display for f64`: `1e300` prints all 301 digits, `5e-324` as `0.000…5`. */
export function rustDisplayF64(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const [mantissa, exp] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const point = Number(exp) + 1;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function invalidType(u: Unexpected, expected: string): DeError {
  return new DeError((show) => `invalid type: ${show(u)}, expected ${expected}`);
}

export function invalidValue(u: Unexpected, expected: string): DeError {
  return new DeError((show) => `invalid value: ${show(u)}, expected ${expected}`);
}

export function invalidLength(length: number, expected: string): DeError {
  return custom(`invalid length ${length}, expected ${expected}`);
}

function oneOf(names: readonly string[]): string {
  if (names.length === 1) return `\`${names[0]}\``;
  if (names.length === 2) return `\`${names[0]}\` or \`${names[1]}\``;
  return `one of ${names.map((n) => `\`${n}\``).join(", ")}`;
}

export function unknownVariant(variant: string, expected: readonly string[]): DeError {
  return expected.length === 0
    ? custom(`unknown variant \`${variant}\`, there are no variants`)
    : custom(`unknown variant \`${variant}\`, expected ${oneOf(expected)}`);
}

export function unknownField(field: string, expected: readonly string[]): DeError {
  return expected.length === 0
    ? custom(`unknown field \`${field}\`, there are no fields`)
    : custom(`unknown field \`${field}\`, expected ${oneOf(expected)}`);
}

export function missingField(field: string): DeError {
  return custom(`missing field \`${field}\``);
}

export function duplicateField(field: string): DeError {
  return custom(`duplicate field \`${field}\``);
}

/** Rust's `<str as Debug>::fmt`: `"a\"b\n\u{7}"`. */
export function debugStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case "\0":
        out += "\\0";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      default:
        if (rustEscapesUnicode(ch.codePointAt(0)!)) {
          out += `\\u{${ch.codePointAt(0)!.toString(16)}}`;
        } else {
          out += ch;
        }
    }
  }
  return `${out}"`;
}

/**
 * serde_json's f64 formatting (the `zmij` crate): shortest round-trip digits, fixed notation
 * for decimal exponents -5..=15 (always with a `.`), otherwise `1.5e+16` / `1e-7`.
 */
export function formatF64(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const [mantissa, exp] = Math.abs(value).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const decExp = Number(exp);
  if (decExp >= -5 && decExp <= 15) {
    if (digits.length - 1 <= decExp) {
      return `${sign}${digits}${"0".repeat(decExp - (digits.length - 1))}.0`;
    }
    if (decExp >= 0) {
      return `${sign}${digits.slice(0, decExp + 1)}.${digits.slice(decExp + 1)}`;
    }
    return `${sign}0.${"0".repeat(-decExp - 1)}${digits}`;
  }
  const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
  return `${sign}${digits[0]}${fraction}e${decExp < 0 ? "-" : "+"}${Math.abs(decExp)}`;
}

// ---------------------------------------------------------------------------------------------
// The serde protocol, reduced to what JSON needs

/** serde's `Visitor`. A missing method rejects that input with serde's default `invalid type`. */
export interface Visitor<T> {
  /** serde's `expecting`: the noun phrase after "expected" in errors. */
  readonly expecting: string;
  visitBool?(value: boolean): T;
  visitU64?(value: bigint): T;
  visitI64?(value: bigint): T;
  visitF64?(value: number): T;
  visitStr?(value: string): T;
  visitUnit?(): T;
  visitNone?(): T;
  visitSome?(de: Deserializer): T;
  visitSeq?(seq: SeqAccess): T;
  visitMap?(map: MapAccess): T;
  visitEnum?(data: EnumAccess): T;
}

export interface SeqAccess {
  /** The next element decoded with `seed`, or `undefined` at the end of the sequence. */
  nextElement<T>(seed: Decoder<T>): { value: T } | undefined;
}

export interface MapAccess {
  nextKey<T>(seed: Decoder<T>): { value: T } | undefined;
  nextValue<T>(seed: Decoder<T>): T;
}

export interface EnumAccess {
  variant<T>(seed: Decoder<T>): [T, VariantAccess];
}

export interface VariantAccess {
  unitVariant(): void;
}

/** serde's `Deserializer`, with the methods serde_json implements differently. */
export interface Deserializer {
  deserializeAny<T>(visitor: Visitor<T>): T;
  deserializeBool<T>(visitor: Visitor<T>): T;
  /** Every integer and float type: serde_json's `deserialize_number`. */
  deserializeNumber<T>(visitor: Visitor<T>): T;
  deserializeStr<T>(visitor: Visitor<T>): T;
  deserializeOption<T>(visitor: Visitor<T>): T;
  deserializeUnit<T>(visitor: Visitor<T>): T;
  deserializeSeq<T>(visitor: Visitor<T>): T;
  deserializeMap<T>(visitor: Visitor<T>): T;
  deserializeStruct<T>(visitor: Visitor<T>): T;
  deserializeEnum<T>(visitor: Visitor<T>): T;
  deserializeIdentifier<T>(visitor: Visitor<T>): T;
  deserializeIgnoredAny<T>(visitor: Visitor<T>): T;
  /** Byte offset where the next value starts (after whitespace), or -1 without a source. */
  startOffset(): number;
  /** Byte offset just past the last consumed byte, or -1 without a source. */
  endOffset(): number;
}

/** serde's `Deserialize` (and `DeserializeSeed`): decode one value from a deserializer. */
export type Decoder<T> = (de: Deserializer) => T;

export function visitBool<T>(v: Visitor<T>, value: boolean): T {
  return v.visitBool ? v.visitBool(value) : fail(invalidType({ kind: "bool", value }, v.expecting));
}

export function visitU64<T>(v: Visitor<T>, value: bigint): T {
  return v.visitU64
    ? v.visitU64(value)
    : fail(invalidType({ kind: "unsigned", value }, v.expecting));
}

export function visitI64<T>(v: Visitor<T>, value: bigint): T {
  return v.visitI64 ? v.visitI64(value) : fail(invalidType({ kind: "signed", value }, v.expecting));
}

export function visitF64<T>(v: Visitor<T>, value: number): T {
  return v.visitF64 ? v.visitF64(value) : fail(invalidType({ kind: "float", value }, v.expecting));
}

export function visitStr<T>(v: Visitor<T>, value: string): T {
  return v.visitStr ? v.visitStr(value) : fail(invalidType({ kind: "str", value }, v.expecting));
}

export function visitUnit<T>(v: Visitor<T>): T {
  return v.visitUnit ? v.visitUnit() : fail(invalidType({ kind: "unit" }, v.expecting));
}

export function visitNone<T>(v: Visitor<T>): T {
  return v.visitNone ? v.visitNone() : fail(invalidType({ kind: "option" }, v.expecting));
}

export function visitSome<T>(v: Visitor<T>, de: Deserializer): T {
  return v.visitSome ? v.visitSome(de) : fail(invalidType({ kind: "option" }, v.expecting));
}

export function visitSeq<T>(v: Visitor<T>, seq: SeqAccess): T {
  return v.visitSeq ? v.visitSeq(seq) : fail(invalidType({ kind: "seq" }, v.expecting));
}

export function visitMap<T>(v: Visitor<T>, map: MapAccess): T {
  return v.visitMap ? v.visitMap(map) : fail(invalidType({ kind: "map" }, v.expecting));
}

export function visitEnum<T>(v: Visitor<T>, data: EnumAccess): T {
  return v.visitEnum ? v.visitEnum(data) : fail(invalidType({ kind: "enum" }, v.expecting));
}

// ---------------------------------------------------------------------------------------------
// The streaming JSON deserializer (src/de.rs over src/read.rs's SliceRead)

const U64_MAX = 18446744073709551615n;
const I64_MAX = 9223372036854775807n;
const I32_MAX = 2147483647;
const I32_MIN = -2147483648;
const POW10: readonly number[] = Array.from({ length: 309 }, (_, i) => Number(`1e${i}`));

const SPACE = 0x20;
const NL = 0x0a;
const TAB = 0x09;
const CR = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const LOWER_E = 0x65;
const UPPER_E = 0x45;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const EOF = -1;

const isDigit = (b: number): boolean => b >= ZERO && b <= NINE;

/** A significand: a plain number while small, a bigint beyond 2^53. */
type Significand = number | bigint;

/** `significand * 10 + digit`, or `null` when that overflows u64 (serde_json's `overflow!`). */
function mulAdd(s: Significand, digit: number): Significand | null {
  if (typeof s === "number") {
    if (s < 9e14) return s * 10 + digit;
    s = BigInt(s);
  }
  const next = s * 10n + BigInt(digit);
  return next > U64_MAX ? null : next;
}

type ParserNumber =
  | { kind: "u64"; value: bigint }
  | { kind: "i64"; value: bigint }
  | { kind: "f64"; value: number };

function visitNumber<T>(n: ParserNumber, v: Visitor<T>): T {
  switch (n.kind) {
    case "f64":
      return visitF64(v, n.value);
    case "u64":
      return visitU64(v, n.value);
    case "i64":
      return visitI64(v, n.value);
  }
}

function numberUnexpected(n: ParserNumber): Unexpected {
  switch (n.kind) {
    case "f64":
      return { kind: "float", value: n.value };
    case "u64":
      return { kind: "unsigned", value: n.value };
    case "i64":
      return { kind: "signed", value: n.value };
  }
}

function hexValue(b: number): number {
  if (b >= ZERO && b <= NINE) return b - ZERO;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

// ignoreBOM keeps a leading U+FEFF inside a string segment instead of stripping it.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const SOURCES = new WeakMap<Node, Uint8Array>();

class JsonDeserializer implements Deserializer {
  readonly bytes: Uint8Array;
  index: number;
  private remainingDepth = 128;

  constructor(bytes: Uint8Array, index = 0) {
    this.bytes = bytes;
    this.index = index;
  }

  // --- reading (read.rs) ---

  peek(): number {
    return this.index < this.bytes.length ? this.bytes[this.index]! : EOF;
  }

  eat(): void {
    this.index += 1;
  }

  next(): number {
    return this.index < this.bytes.length ? this.bytes[this.index++]! : EOF;
  }

  /** read.rs `position_of_index`: 1-based line, byte column counted from the line start. */
  private positionOfIndex(i: number): [number, number] {
    const startOfLine = i === 0 ? 0 : this.bytes.lastIndexOf(NL, i - 1) + 1;
    let line = 1;
    for (let j = 0; j < startOfLine; j++) if (this.bytes[j] === NL) line++;
    return [line, i - startOfLine];
  }

  /** Error caused by a byte from `next()`: positioned at the current index. */
  error(code: string): SerdeJsonError {
    const [line, column] = this.positionOfIndex(this.index);
    return new SerdeJsonError(code, line, column);
  }

  /** Error caused by a byte from `peek()`: positioned one byte further. */
  peekError(code: string): SerdeJsonError {
    const [line, column] = this.positionOfIndex(Math.min(this.bytes.length, this.index + 1));
    return new SerdeJsonError(code, line, column);
  }

  /** serde_json's `fix_position`: give a position-less error the current position. */
  fixPosition(e: unknown): unknown {
    const j = toJsonError(e);
    return j instanceof SerdeJsonError && j.line === 0 ? this.error(j.code) : j;
  }

  private fixing<T>(body: () => T): T {
    try {
      return body();
    } catch (e) {
      throw this.fixPosition(e);
    }
  }

  parseWhitespace(): number {
    for (;;) {
      const b = this.peek();
      if (b === SPACE || b === NL || b === TAB || b === CR) this.eat();
      else return b;
    }
  }

  startOffset(): number {
    this.parseWhitespace();
    return this.index;
  }

  endOffset(): number {
    return this.index;
  }

  end(): void {
    if (this.parseWhitespace() !== EOF) throw this.peekError(TRAILING_CHARACTERS);
  }

  // --- strings (read.rs SliceRead) ---

  private decodeHexEscape(): number {
    if (this.index + 4 <= this.bytes.length) {
      const b = this.bytes;
      const i = this.index;
      this.index += 4;
      const a = hexValue(b[i]!);
      const c = hexValue(b[i + 1]!);
      const d = hexValue(b[i + 2]!);
      const e = hexValue(b[i + 3]!);
      if (a < 0 || c < 0 || d < 0 || e < 0) throw this.error(INVALID_ESCAPE);
      return (a << 12) | (c << 8) | (d << 4) | e;
    }
    this.index = this.bytes.length;
    throw this.error(EOF_STRING);
  }

  private nextOrEof(): number {
    const b = this.next();
    if (b === EOF) throw this.error(EOF_STRING);
    return b;
  }

  private peekOrEof(): number {
    const b = this.peek();
    if (b === EOF) throw this.error(EOF_STRING);
    return b;
  }

  private parseUnicodeEscape(): string {
    const n = this.decodeHexEscape();
    if (n >= 0xdc00 && n <= 0xdfff) throw this.error(LONE_LEADING_SURROGATE);
    if (n < 0xd800 || n > 0xdbff) return String.fromCharCode(n);
    if (this.peekOrEof() === BACKSLASH) {
      this.eat();
    } else {
      this.eat();
      throw this.error(UNEXPECTED_END_OF_HEX_ESCAPE);
    }
    if (this.peekOrEof() === 0x75) {
      this.eat();
    } else {
      this.eat();
      throw this.error(UNEXPECTED_END_OF_HEX_ESCAPE);
    }
    const n2 = this.decodeHexEscape();
    if (n2 < 0xdc00 || n2 > 0xdfff) throw this.error(LONE_LEADING_SURROGATE);
    return String.fromCharCode(n, n2);
  }

  private parseEscape(): string {
    const ch = this.nextOrEof();
    switch (ch) {
      case QUOTE:
        return '"';
      case BACKSLASH:
        return "\\";
      case 0x2f:
        return "/";
      case 0x62:
        return "\b";
      case 0x66:
        return "\f";
      case 0x6e:
        return "\n";
      case 0x72:
        return "\r";
      case 0x74:
        return "\t";
      case 0x75:
        return this.parseUnicodeEscape();
      default:
        throw this.error(INVALID_ESCAPE);
    }
  }

  /** read.rs `parse_str`: the opening quote has been consumed. */
  parseStr(): string {
    const b = this.bytes;
    let start = this.index;
    let out = "";
    for (;;) {
      while (this.index < b.length) {
        const c = b[this.index]!;
        if (c === QUOTE || c === BACKSLASH || c < 0x20) break;
        this.index += 1;
      }
      if (this.index === b.length) throw this.error(EOF_STRING);
      const c = b[this.index]!;
      if (c === QUOTE) {
        out += utf8.decode(b.subarray(start, this.index));
        this.index += 1;
        return out;
      }
      if (c === BACKSLASH) {
        out += utf8.decode(b.subarray(start, this.index));
        this.index += 1;
        out += this.parseEscape();
        start = this.index;
      } else {
        this.index += 1;
        throw this.error(CONTROL_CHARACTER);
      }
    }
  }

  /** read.rs `ignore_str`: like `parse_str`, but `\u` escapes are not validated. */
  private ignoreStr(): void {
    const b = this.bytes;
    for (;;) {
      while (this.index < b.length) {
        const c = b[this.index]!;
        if (c === QUOTE || c === BACKSLASH || c < 0x20) break;
        this.index += 1;
      }
      if (this.index === b.length) throw this.error(EOF_STRING);
      const c = b[this.index]!;
      if (c === QUOTE) {
        this.index += 1;
        return;
      }
      if (c !== BACKSLASH) throw this.error(CONTROL_CHARACTER);
      this.index += 1;
      const ch = this.nextOrEof();
      if (ch === 0x75) {
        this.decodeHexEscape();
      } else if (![QUOTE, BACKSLASH, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(ch)) {
        throw this.error(INVALID_ESCAPE);
      }
    }
  }

  // --- identifiers and numbers (de.rs) ---

  parseIdent(rest: string): void {
    for (let i = 0; i < rest.length; i++) {
      const b = this.next();
      if (b === EOF) throw this.error(EOF_VALUE);
      if (b !== rest.charCodeAt(i)) throw this.error(EXPECTED_SOME_IDENT);
    }
  }

  private parseInteger(positive: boolean): ParserNumber {
    const next = this.next();
    if (next === EOF) throw this.error(EOF_VALUE);
    if (next === ZERO) {
      if (isDigit(this.peek())) throw this.peekError(INVALID_NUMBER);
      return this.parseNumber(positive, 0);
    }
    if (next > ZERO && next <= NINE) {
      let significand: Significand = next - ZERO;
      for (;;) {
        const c = this.peek();
        if (!isDigit(c)) return this.parseNumber(positive, significand);
        const grown = mulAdd(significand, c - ZERO);
        if (grown === null) {
          return { kind: "f64", value: this.parseLongInteger(positive, significand) };
        }
        this.eat();
        significand = grown;
      }
    }
    throw this.error(INVALID_NUMBER);
  }

  private parseNumber(positive: boolean, significand: Significand): ParserNumber {
    const c = this.peek();
    if (c === DOT) return { kind: "f64", value: this.parseDecimal(positive, significand, 0) };
    if (c === LOWER_E || c === UPPER_E) {
      return { kind: "f64", value: this.parseExponent(positive, significand, 0) };
    }
    const big = BigInt(significand);
    if (positive) return { kind: "u64", value: big };
    // `(significand as i64).wrapping_neg()`; a float on underflow or on `-0`.
    if (big === 0n || big > I64_MAX + 1n) return { kind: "f64", value: -Number(significand) };
    return { kind: "i64", value: -big };
  }

  private parseDecimal(positive: boolean, significand: Significand, expBefore: number): number {
    this.eat();
    let expAfter = 0;
    for (;;) {
      const c = this.peek();
      if (!isDigit(c)) break;
      const grown = mulAdd(significand, c - ZERO);
      if (grown === null) {
        return this.parseDecimalOverflow(positive, significand, expBefore + expAfter);
      }
      this.eat();
      significand = grown;
      expAfter -= 1;
    }
    if (expAfter === 0) {
      throw this.peekError(this.peek() === EOF ? EOF_VALUE : INVALID_NUMBER);
    }
    const exponent = expBefore + expAfter;
    const c = this.peek();
    if (c === LOWER_E || c === UPPER_E) return this.parseExponent(positive, significand, exponent);
    return this.f64FromParts(positive, significand, exponent);
  }

  private parseExponent(positive: boolean, significand: Significand, startingExp: number): number {
    this.eat();
    let positiveExp = true;
    const sign = this.peek();
    if (sign === PLUS) {
      this.eat();
    } else if (sign === MINUS) {
      this.eat();
      positiveExp = false;
    }
    const next = this.next();
    if (next === EOF) throw this.error(EOF_VALUE);
    if (!isDigit(next)) throw this.error(INVALID_NUMBER);
    let exp = next - ZERO;
    for (;;) {
      const c = this.peek();
      if (!isDigit(c)) break;
      this.eat();
      const digit = c - ZERO;
      if (exp * 10 + digit > I32_MAX) {
        return this.parseExponentOverflow(positive, Number(significand) === 0, positiveExp);
      }
      exp = exp * 10 + digit;
    }
    const finalExp = positiveExp
      ? Math.min(I32_MAX, startingExp + exp)
      : Math.max(I32_MIN, startingExp - exp);
    return this.f64FromParts(positive, significand, finalExp);
  }

  private f64FromParts(positive: boolean, significand: Significand, exponent: number): number {
    let f = Number(significand);
    for (;;) {
      // `exponent.wrapping_abs()`: i32::MIN stays negative and misses the table.
      const pow = exponent === I32_MIN ? undefined : POW10[Math.abs(exponent)];
      if (pow !== undefined) {
        if (exponent >= 0) {
          f *= pow;
          if (!Number.isFinite(f)) throw this.error(NUMBER_OUT_OF_RANGE);
        } else {
          f /= pow;
        }
        break;
      }
      if (f === 0) break;
      if (exponent >= 0) throw this.error(NUMBER_OUT_OF_RANGE);
      f /= 1e308;
      exponent += 308;
    }
    return positive ? f : -f;
  }

  private parseLongInteger(positive: boolean, significand: Significand): number {
    let exponent = 0;
    for (;;) {
      const c = this.peek();
      if (isDigit(c)) {
        this.eat();
        exponent += 1;
      } else if (c === DOT) {
        return this.parseDecimal(positive, significand, exponent);
      } else if (c === LOWER_E || c === UPPER_E) {
        return this.parseExponent(positive, significand, exponent);
      } else {
        return this.f64FromParts(positive, significand, exponent);
      }
    }
  }

  private parseDecimalOverflow(
    positive: boolean,
    significand: Significand,
    exponent: number,
  ): number {
    while (isDigit(this.peek())) this.eat();
    const c = this.peek();
    if (c === LOWER_E || c === UPPER_E) return this.parseExponent(positive, significand, exponent);
    return this.f64FromParts(positive, significand, exponent);
  }

  private parseExponentOverflow(
    positive: boolean,
    zeroSignificand: boolean,
    positiveExp: boolean,
  ): number {
    if (!zeroSignificand && positiveExp) throw this.error(NUMBER_OUT_OF_RANGE);
    while (isDigit(this.peek())) this.eat();
    return positive ? 0 : -0;
  }

  // --- ignoring values (de.rs `ignore_value`) ---

  private ignoreInteger(): void {
    const b = this.next();
    if (b === ZERO) {
      if (isDigit(this.peek())) throw this.peekError(INVALID_NUMBER);
    } else if (b > ZERO && b <= NINE) {
      while (isDigit(this.peek())) this.eat();
    } else {
      throw this.error(INVALID_NUMBER);
    }
    const c = this.peek();
    if (c === DOT) this.ignoreDecimal();
    else if (c === LOWER_E || c === UPPER_E) this.ignoreExponent();
  }

  private ignoreDecimal(): void {
    this.eat();
    let atLeastOneDigit = false;
    while (isDigit(this.peek())) {
      this.eat();
      atLeastOneDigit = true;
    }
    if (!atLeastOneDigit) throw this.peekError(INVALID_NUMBER);
    const c = this.peek();
    if (c === LOWER_E || c === UPPER_E) this.ignoreExponent();
  }

  private ignoreExponent(): void {
    this.eat();
    const sign = this.peek();
    if (sign === PLUS || sign === MINUS) this.eat();
    if (!isDigit(this.next())) throw this.error(INVALID_NUMBER);
    while (isDigit(this.peek())) this.eat();
  }

  ignoreValue(): void {
    const stack: number[] = [];
    let enclosing: number | undefined;
    for (;;) {
      const peek = this.parseWhitespace();
      let frame: number | undefined;
      switch (peek) {
        case EOF:
          throw this.peekError(EOF_VALUE);
        case 0x6e:
          this.eat();
          this.parseIdent("ull");
          break;
        case 0x74:
          this.eat();
          this.parseIdent("rue");
          break;
        case 0x66:
          this.eat();
          this.parseIdent("alse");
          break;
        case MINUS:
          this.eat();
          this.ignoreInteger();
          break;
        case QUOTE:
          this.eat();
          this.ignoreStr();
          break;
        case OPEN_BRACKET:
        case OPEN_BRACE:
          if (enclosing !== undefined) stack.push(enclosing);
          enclosing = undefined;
          this.eat();
          frame = peek;
          break;
        default:
          if (!isDigit(peek)) throw this.peekError(EXPECTED_SOME_VALUE);
          this.ignoreInteger();
      }

      let acceptComma: boolean;
      let current: number;
      if (frame !== undefined) {
        acceptComma = false;
        current = frame;
      } else if (enclosing !== undefined) {
        acceptComma = true;
        current = enclosing;
        enclosing = undefined;
      } else {
        const popped = stack.pop();
        if (popped === undefined) return;
        acceptComma = true;
        current = popped;
      }

      for (;;) {
        const b = this.parseWhitespace();
        if (b === COMMA && acceptComma) {
          this.eat();
          break;
        }
        const closes =
          (b === CLOSE_BRACKET && current === OPEN_BRACKET) ||
          (b === CLOSE_BRACE && current === OPEN_BRACE);
        if (!closes) {
          if (b === EOF) {
            throw this.peekError(current === OPEN_BRACKET ? EOF_LIST : EOF_OBJECT);
          }
          if (acceptComma) {
            throw this.peekError(
              current === OPEN_BRACKET ? EXPECTED_LIST_COMMA_OR_END : EXPECTED_OBJECT_COMMA_OR_END,
            );
          }
          break;
        }
        this.eat();
        const popped = stack.pop();
        if (popped === undefined) return;
        current = popped;
        acceptComma = true;
      }

      if (current === OPEN_BRACE) {
        const q = this.parseWhitespace();
        if (q === EOF) throw this.peekError(EOF_OBJECT);
        if (q !== QUOTE) throw this.peekError(KEY_MUST_BE_A_STRING);
        this.eat();
        this.ignoreStr();
        const colon = this.parseWhitespace();
        if (colon === EOF) throw this.peekError(EOF_OBJECT);
        if (colon !== COLON) throw this.peekError(EXPECTED_COLON);
        this.eat();
      }
      enclosing = current;
    }
  }

  // --- the Deserializer impl (de.rs) ---

  /** de.rs `peek_invalid_type`: consume the offending scalar and describe it. */
  private peekInvalidType(expected: string): unknown {
    let err: Error;
    const b = this.peek();
    try {
      switch (b) {
        case 0x6e:
          this.eat();
          this.parseIdent("ull");
          err = invalidType({ kind: "unit" }, expected);
          break;
        case 0x74:
          this.eat();
          this.parseIdent("rue");
          err = invalidType({ kind: "bool", value: true }, expected);
          break;
        case 0x66:
          this.eat();
          this.parseIdent("alse");
          err = invalidType({ kind: "bool", value: false }, expected);
          break;
        case MINUS:
          this.eat();
          err = invalidType(numberUnexpected(this.parseInteger(false)), expected);
          break;
        case QUOTE:
          this.eat();
          err = invalidType({ kind: "str", value: this.parseStr() }, expected);
          break;
        case OPEN_BRACKET:
          err = invalidType({ kind: "seq" }, expected);
          break;
        case OPEN_BRACE:
          err = invalidType({ kind: "map" }, expected);
          break;
        default:
          if (isDigit(b)) {
            err = invalidType(numberUnexpected(this.parseInteger(true)), expected);
          } else {
            err = this.peekError(EXPECTED_SOME_VALUE);
          }
      }
    } catch (e) {
      return e;
    }
    return this.fixPosition(err);
  }

  private peekOrEofValue(): number {
    const b = this.parseWhitespace();
    if (b === EOF) throw this.peekError(EOF_VALUE);
    return b;
  }

  /** `check_recursion!` around a container, then `end_seq` / `end_map` even on failure. */
  private container<T>(open: number, body: () => T): T {
    this.remainingDepth -= 1;
    if (this.remainingDepth === 0) throw this.peekError(RECURSION_LIMIT_EXCEEDED);
    this.eat();
    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = body();
    } catch (e) {
      failed = true;
      failure = e;
    }
    this.remainingDepth += 1;
    let endFailure: unknown;
    try {
      if (open === OPEN_BRACKET) this.endSeq();
      else this.endMap();
    } catch (e) {
      endFailure = e;
    }
    if (failed) throw failure;
    if (endFailure !== undefined) throw endFailure;
    return result as T;
  }

  private endSeq(): void {
    const b = this.parseWhitespace();
    if (b === CLOSE_BRACKET) {
      this.eat();
      return;
    }
    if (b === COMMA) {
      this.eat();
      throw this.peekError(
        this.parseWhitespace() === CLOSE_BRACKET ? TRAILING_COMMA : TRAILING_CHARACTERS,
      );
    }
    throw this.peekError(b === EOF ? EOF_LIST : TRAILING_CHARACTERS);
  }

  private endMap(): void {
    const b = this.parseWhitespace();
    if (b === CLOSE_BRACE) {
      this.eat();
      return;
    }
    if (b === COMMA) throw this.peekError(TRAILING_COMMA);
    throw this.peekError(b === EOF ? EOF_OBJECT : TRAILING_CHARACTERS);
  }

  parseObjectColon(): void {
    const b = this.parseWhitespace();
    if (b === COLON) {
      this.eat();
      return;
    }
    throw this.peekError(b === EOF ? EOF_OBJECT : EXPECTED_COLON);
  }

  deserializeAny<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      switch (peek) {
        case 0x6e:
          this.eat();
          this.parseIdent("ull");
          return visitUnit(v);
        case 0x74:
          this.eat();
          this.parseIdent("rue");
          return visitBool(v, true);
        case 0x66:
          this.eat();
          this.parseIdent("alse");
          return visitBool(v, false);
        case MINUS:
          this.eat();
          return visitNumber(this.parseInteger(false), v);
        case QUOTE:
          this.eat();
          return visitStr(v, this.parseStr());
        case OPEN_BRACKET:
          return this.container(peek, () => visitSeq(v, new JsonSeqAccess(this)));
        case OPEN_BRACE:
          return this.container(peek, () => visitMap(v, new JsonMapAccess(this)));
        default:
          if (isDigit(peek)) return visitNumber(this.parseInteger(true), v);
          throw this.peekError(EXPECTED_SOME_VALUE);
      }
    });
  }

  deserializeBool<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      if (peek === 0x74) {
        this.eat();
        this.parseIdent("rue");
        return visitBool(v, true);
      }
      if (peek === 0x66) {
        this.eat();
        this.parseIdent("alse");
        return visitBool(v, false);
      }
      throw this.peekInvalidType(v.expecting);
    });
  }

  deserializeNumber<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      if (peek === MINUS) {
        this.eat();
        return visitNumber(this.parseInteger(false), v);
      }
      if (isDigit(peek)) return visitNumber(this.parseInteger(true), v);
      throw this.peekInvalidType(v.expecting);
    });
  }

  deserializeStr<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      if (peek === QUOTE) {
        this.eat();
        return visitStr(v, this.parseStr());
      }
      throw this.peekInvalidType(v.expecting);
    });
  }

  deserializeOption<T>(v: Visitor<T>): T {
    if (this.parseWhitespace() === 0x6e) {
      this.eat();
      this.parseIdent("ull");
      return visitNone(v);
    }
    return visitSome(v, this);
  }

  deserializeUnit<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      if (peek === 0x6e) {
        this.eat();
        this.parseIdent("ull");
        return visitUnit(v);
      }
      throw this.peekInvalidType(v.expecting);
    });
  }

  deserializeSeq<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      if (peek === OPEN_BRACKET) {
        return this.container(peek, () => visitSeq(v, new JsonSeqAccess(this)));
      }
      throw this.peekInvalidType(v.expecting);
    });
  }

  deserializeMap<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      if (peek === OPEN_BRACE) {
        return this.container(peek, () => visitMap(v, new JsonMapAccess(this)));
      }
      throw this.peekInvalidType(v.expecting);
    });
  }

  deserializeStruct<T>(v: Visitor<T>): T {
    const peek = this.peekOrEofValue();
    return this.fixing(() => {
      if (peek === OPEN_BRACKET) {
        return this.container(peek, () => visitSeq(v, new JsonSeqAccess(this)));
      }
      if (peek === OPEN_BRACE) {
        return this.container(peek, () => visitMap(v, new JsonMapAccess(this)));
      }
      throw this.peekInvalidType(v.expecting);
    });
  }

  deserializeEnum<T>(v: Visitor<T>): T {
    const peek = this.parseWhitespace();
    if (peek === OPEN_BRACE) {
      this.remainingDepth -= 1;
      if (this.remainingDepth === 0) throw this.peekError(RECURSION_LIMIT_EXCEEDED);
      this.eat();
      const value = visitEnum(v, new JsonVariantAccess(this));
      this.remainingDepth += 1;
      const b = this.parseWhitespace();
      if (b === CLOSE_BRACE) {
        this.eat();
        return value;
      }
      throw this.error(b === EOF ? EOF_OBJECT : EXPECTED_SOME_VALUE);
    }
    if (peek === QUOTE) return visitEnum(v, new JsonUnitVariantAccess(this));
    throw this.peekError(peek === EOF ? EOF_VALUE : EXPECTED_SOME_VALUE);
  }

  deserializeIdentifier<T>(v: Visitor<T>): T {
    return this.deserializeStr(v);
  }

  deserializeIgnoredAny<T>(v: Visitor<T>): T {
    this.ignoreValue();
    return visitUnit(v);
  }
}

class JsonSeqAccess implements SeqAccess {
  private readonly de: JsonDeserializer;
  private first = true;

  constructor(de: JsonDeserializer) {
    this.de = de;
  }

  nextElement<T>(seed: Decoder<T>): { value: T } | undefined {
    const de = this.de;
    const peek = de.parseWhitespace();
    if (peek === EOF) throw de.peekError(EOF_LIST);
    if (peek === CLOSE_BRACKET) return undefined;
    if (this.first) {
      this.first = false;
    } else if (peek === COMMA) {
      de.eat();
      const b = de.parseWhitespace();
      if (b === CLOSE_BRACKET) throw de.peekError(TRAILING_COMMA);
      if (b === EOF) throw de.peekError(EOF_VALUE);
    } else {
      throw de.peekError(EXPECTED_LIST_COMMA_OR_END);
    }
    return { value: seed(de) };
  }
}

class JsonMapAccess implements MapAccess {
  private readonly de: JsonDeserializer;
  private first = true;

  constructor(de: JsonDeserializer) {
    this.de = de;
  }

  nextKey<T>(seed: Decoder<T>): { value: T } | undefined {
    const de = this.de;
    const peek = de.parseWhitespace();
    if (peek === EOF) throw de.peekError(EOF_OBJECT);
    if (peek === CLOSE_BRACE) return undefined;
    if (this.first) {
      this.first = false;
      if (peek !== QUOTE) throw de.peekError(KEY_MUST_BE_A_STRING);
    } else if (peek === COMMA) {
      de.eat();
      const b = de.parseWhitespace();
      if (b === CLOSE_BRACE) throw de.peekError(TRAILING_COMMA);
      if (b === EOF) throw de.peekError(EOF_VALUE);
      if (b !== QUOTE) throw de.peekError(KEY_MUST_BE_A_STRING);
    } else {
      throw de.peekError(EXPECTED_OBJECT_COMMA_OR_END);
    }
    return { value: seed(new MapKey(de)) };
  }

  nextValue<T>(seed: Decoder<T>): T {
    this.de.parseObjectColon();
    return seed(this.de);
  }
}

class JsonVariantAccess implements EnumAccess, VariantAccess {
  private readonly de: JsonDeserializer;

  constructor(de: JsonDeserializer) {
    this.de = de;
  }

  variant<T>(seed: Decoder<T>): [T, VariantAccess] {
    const de = this.de;
    const b = de.parseWhitespace();
    if (b === CLOSE_BRACE) throw de.peekError(EXPECTED_SOME_VALUE);
    if (b === EOF) throw de.peekError(EOF_OBJECT);
    if (b !== QUOTE) throw de.peekError(KEY_MUST_BE_A_STRING);
    let value: T;
    try {
      value = seed(new MapKey(de));
    } catch (e) {
      throw de.fixPosition(e);
    }
    de.parseObjectColon();
    return [value, this];
  }

  unitVariant(): void {
    unit(this.de);
  }
}

class JsonUnitVariantAccess implements EnumAccess, VariantAccess {
  private readonly de: JsonDeserializer;

  constructor(de: JsonDeserializer) {
    this.de = de;
  }

  variant<T>(seed: Decoder<T>): [T, VariantAccess] {
    return [seed(this.de), this];
  }

  unitVariant(): void {}
}

/** de.rs `MapKey`: an object key; every request reads the quoted string. */
class MapKey implements Deserializer {
  private readonly de: JsonDeserializer;

  constructor(de: JsonDeserializer) {
    this.de = de;
  }

  deserializeAny<T>(v: Visitor<T>): T {
    this.de.eat();
    return visitStr(v, this.de.parseStr());
  }

  deserializeNumber<T>(v: Visitor<T>): T {
    const de = this.de;
    de.eat();
    const b = de.peek();
    if (!(isDigit(b) || b === MINUS)) throw de.error(EXPECTED_NUMERIC_KEY);
    const value = de.deserializeNumber(v);
    if (de.peek() !== QUOTE) throw de.peekError(EXPECTED_DOUBLE_QUOTE);
    de.eat();
    return value;
  }

  deserializeOption<T>(v: Visitor<T>): T {
    return visitSome(v, this);
  }

  deserializeEnum<T>(v: Visitor<T>): T {
    return this.de.deserializeEnum(v);
  }

  deserializeBool<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  deserializeStr<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  deserializeUnit<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  deserializeSeq<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  deserializeMap<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  deserializeStruct<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  deserializeIdentifier<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  deserializeIgnoredAny<T>(v: Visitor<T>): T {
    return this.deserializeAny(v);
  }

  startOffset(): number {
    return this.de.index;
  }

  endOffset(): number {
    return this.de.index;
  }
}

/** serde's private `missing_field`: `None` for an `Option`, `missing field` for anything else. */
class MissingFieldDeserializer implements Deserializer {
  private readonly field: string;

  constructor(field: string) {
    this.field = field;
  }

  deserializeOption<T>(v: Visitor<T>): T {
    return visitNone(v);
  }

  deserializeAny<T>(): T {
    throw missingField(this.field);
  }

  deserializeBool = this.deserializeAny;
  deserializeNumber = this.deserializeAny;
  deserializeStr = this.deserializeAny;
  deserializeUnit = this.deserializeAny;
  deserializeSeq = this.deserializeAny;
  deserializeMap = this.deserializeAny;
  deserializeStruct = this.deserializeAny;
  deserializeEnum = this.deserializeAny;
  deserializeIdentifier = this.deserializeAny;
  deserializeIgnoredAny = this.deserializeAny;

  startOffset(): number {
    return -1;
  }

  endOffset(): number {
    return -1;
  }
}

// ---------------------------------------------------------------------------------------------
// Nodes: parsed values with positions, which also serve as serde's buffered `Content`

/** A parsed JSON value. `start`/`end` are UTF-8 byte offsets into the source (end exclusive). */
export type Node =
  | { kind: "null"; value: null; start: number; end: number }
  | { kind: "bool"; value: boolean; start: number; end: number }
  | {
      kind: "number";
      /** serde_json's representation: u64, i64 (negative integers only), or f64. */
      type: "u64" | "i64" | "f64";
      /** A bigint for u64 / i64, a number for f64. */
      value: bigint | number;
      start: number;
      end: number;
    }
  | { kind: "string"; value: string; start: number; end: number }
  | { kind: "array"; children: Node[]; start: number; end: number }
  | {
      kind: "object";
      /** Every entry in source order, duplicates included (see `get` and `toPlain`). */
      entries: NodeEntry[];
      start: number;
      end: number;
    };

export interface NodeEntry {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: Node;
}

const STRING_VISITOR: Visitor<string> = { expecting: "a string", visitStr: (s) => s };

const keyEntry: Decoder<Omit<NodeEntry, "value">> = (de) => {
  const keyStart = de.startOffset();
  const key = de.deserializeStr(STRING_VISITOR);
  return { key, keyStart, keyEnd: de.endOffset() };
};

const NODE_VISITOR: Visitor<Node> = {
  expecting: "any valid JSON value",
  visitUnit: () => ({ kind: "null", value: null, start: -1, end: -1 }),
  visitBool: (value) => ({ kind: "bool", value, start: -1, end: -1 }),
  visitU64: (value) => ({ kind: "number", type: "u64", value, start: -1, end: -1 }),
  visitI64: (value) => ({ kind: "number", type: "i64", value, start: -1, end: -1 }),
  visitF64: (value) => ({ kind: "number", type: "f64", value, start: -1, end: -1 }),
  visitStr: (value) => ({ kind: "string", value, start: -1, end: -1 }),
  visitSeq: (seq) => {
    const children: Node[] = [];
    for (let el = seq.nextElement(node); el; el = seq.nextElement(node)) children.push(el.value);
    return { kind: "array", children, start: -1, end: -1 };
  },
  visitMap: (map) => {
    const entries: NodeEntry[] = [];
    for (let k = map.nextKey(keyEntry); k; k = map.nextKey(keyEntry)) {
      entries.push({ ...k.value, value: map.nextValue(node) });
    }
    return { kind: "object", entries, start: -1, end: -1 };
  },
};

/** Decodes any value into a `Node` (serde_json's `Value`, keeping positions and duplicates). */
export const node: Decoder<Node> = (de) => {
  const start = de.startOffset();
  const n = de.deserializeAny(NODE_VISITOR);
  n.start = start;
  n.end = de.endOffset();
  if (de instanceof JsonDeserializer) SOURCES.set(n, de.bytes);
  return n;
};

function nodeUnexpected(n: Node): Unexpected {
  switch (n.kind) {
    case "null":
      return { kind: "unit" };
    case "bool":
      return { kind: "bool", value: n.value };
    case "number":
      if (n.type === "f64") return { kind: "float", value: n.value as number };
      return { kind: n.type === "u64" ? "unsigned" : "signed", value: n.value as bigint };
    case "string":
      return { kind: "str", value: n.value };
    case "array":
      return { kind: "seq" };
    case "object":
      return { kind: "map" };
  }
}

function visitNodeNumber<T>(n: Node & { kind: "number" }, v: Visitor<T>): T {
  if (n.type === "f64") return visitF64(v, n.value as number);
  return n.type === "u64" ? visitU64(v, n.value as bigint) : visitI64(v, n.value as bigint);
}

/** serde's private `ContentDeserializer`: decodes a buffered value; errors carry no position. */
class ContentDeserializer implements Deserializer {
  private readonly content: Node;

  constructor(content: Node) {
    this.content = content;
  }

  private invalidType(v: Visitor<unknown>): DeError {
    return invalidType(nodeUnexpected(this.content), v.expecting);
  }

  deserializeAny<T>(v: Visitor<T>): T {
    const c = this.content;
    switch (c.kind) {
      case "null":
        return visitUnit(v);
      case "bool":
        return visitBool(v, c.value);
      case "number":
        return visitNodeNumber(c, v);
      case "string":
        return visitStr(v, c.value);
      case "array":
        return visitContentSeq(c.children, v);
      case "object":
        return visitContentMap(c.entries, v);
    }
  }

  deserializeBool<T>(v: Visitor<T>): T {
    if (this.content.kind === "bool") return visitBool(v, this.content.value);
    throw this.invalidType(v);
  }

  deserializeNumber<T>(v: Visitor<T>): T {
    if (this.content.kind === "number") return visitNodeNumber(this.content, v);
    throw this.invalidType(v);
  }

  deserializeStr<T>(v: Visitor<T>): T {
    if (this.content.kind === "string") return visitStr(v, this.content.value);
    throw this.invalidType(v);
  }

  deserializeOption<T>(v: Visitor<T>): T {
    return this.content.kind === "null" ? visitUnit(v) : visitSome(v, this);
  }

  deserializeUnit<T>(v: Visitor<T>): T {
    const c = this.content;
    if (c.kind === "null" || (c.kind === "object" && c.entries.length === 0)) return visitUnit(v);
    throw this.invalidType(v);
  }

  deserializeSeq<T>(v: Visitor<T>): T {
    if (this.content.kind === "array") return visitContentSeq(this.content.children, v);
    throw this.invalidType(v);
  }

  deserializeMap<T>(v: Visitor<T>): T {
    if (this.content.kind === "object") return visitContentMap(this.content.entries, v);
    throw this.invalidType(v);
  }

  deserializeStruct<T>(v: Visitor<T>): T {
    const c = this.content;
    if (c.kind === "array") return visitContentSeq(c.children, v);
    if (c.kind === "object") return visitContentMap(c.entries, v);
    throw this.invalidType(v);
  }

  deserializeEnum<T>(v: Visitor<T>): T {
    const c = this.content;
    let variant: Node;
    let value: Node | undefined;
    if (c.kind === "object") {
      if (c.entries.length !== 1) {
        throw invalidValue({ kind: "map" }, "map with a single key");
      }
      const entry = c.entries[0]!;
      variant = { kind: "string", value: entry.key, start: -1, end: -1 };
      value = entry.value;
    } else if (c.kind === "string") {
      variant = c;
    } else {
      throw invalidType(nodeUnexpected(c), "string or map");
    }
    const access: EnumAccess & VariantAccess = {
      variant: (seed) => [seed(new ContentDeserializer(variant)), access],
      unitVariant: () => {
        if (value) unit(new ContentDeserializer(value));
      },
    };
    return visitEnum(v, access);
  }

  deserializeIdentifier<T>(v: Visitor<T>): T {
    const c = this.content;
    if (c.kind === "string") return visitStr(v, c.value);
    if (c.kind === "number" && c.type === "u64") return visitU64(v, c.value as bigint);
    throw this.invalidType(v);
  }

  deserializeIgnoredAny<T>(v: Visitor<T>): T {
    return visitUnit(v);
  }

  startOffset(): number {
    return -1;
  }

  endOffset(): number {
    return -1;
  }
}

function visitContentSeq<T>(children: Node[], v: Visitor<T>): T {
  let i = 0;
  const seq: SeqAccess = {
    nextElement: (seed) =>
      i < children.length ? { value: seed(new ContentDeserializer(children[i++]!)) } : undefined,
  };
  const value = visitSeq(v, seq);
  const remaining = children.length - i;
  if (remaining > 0) {
    throw invalidLength(
      i + remaining,
      i === 1 ? "1 element in sequence" : `${i} elements in sequence`,
    );
  }
  return value;
}

function visitContentMap<T>(entries: NodeEntry[], v: Visitor<T>): T {
  let i = 0;
  let pending: Node | undefined;
  const map: MapAccess = {
    nextKey: (seed) => {
      if (i >= entries.length) return undefined;
      const entry = entries[i++]!;
      pending = entry.value;
      return { value: seed(new ContentDeserializer(stringNode(entry.key))) };
    },
    nextValue: (seed) => {
      const value = pending!;
      pending = undefined;
      return seed(new ContentDeserializer(value));
    },
  };
  const value = visitMap(v, map);
  const remaining = entries.length - i;
  if (remaining > 0) {
    throw invalidLength(i + remaining, i === 1 ? "1 element in map" : `${i} elements in map`);
  }
  return value;
}

function stringNode(value: string): Node {
  return { kind: "string", value, start: -1, end: -1 };
}

// ---------------------------------------------------------------------------------------------
// Entry points

const encoder = new TextEncoder();

/** `serde_json::from_str::<T>`: decode the whole document, then reject trailing characters. */
export function fromStr<T>(text: string, decoder: Decoder<T>): T {
  const de = new JsonDeserializer(encoder.encode(text));
  const value = jsonErrors(() => decoder(de));
  de.end();
  return value;
}

/**
 * `serde_json::from_slice::<T>`. Invalid UTF-8 inside a string is decoded lossily rather than
 * refused as serde_json does; positions count bytes, as serde_json's do.
 */
export function fromSlice<T>(bytes: Uint8Array, decoder: Decoder<T>): T {
  const de = new JsonDeserializer(bytes);
  const value = jsonErrors(() => decoder(de));
  de.end();
  return value;
}

/** Runs `body`, turning a `DeError` that no deserializer positioned into a `SerdeJsonError`. */
function jsonErrors<T>(body: () => T): T {
  try {
    return body();
  } catch (e) {
    throw toJsonError(e);
  }
}

/** `serde_json::from_str::<Value>`, keeping each value's byte offsets. */
export function parseValue(text: string): Node {
  return fromStr(text, node);
}

/**
 * Decodes a parsed node by replaying its source text through the streaming deserializer, so
 * errors and positions are what `from_str::<T>` would report for that (valid) value. A node
 * without a source (built by hand) is decoded the way serde decodes buffered content: no
 * positions.
 */
export function decode<T>(n: Node, decoder: Decoder<T>): T {
  const source = SOURCES.get(n);
  return jsonErrors(() =>
    decoder(source ? new JsonDeserializer(source, n.start) : new ContentDeserializer(n)),
  );
}

/** The last entry for `key` (serde_json's `Value` keeps the last of duplicate keys). */
export function get(n: Node, key: string): Node | undefined {
  if (n.kind !== "object") return undefined;
  for (let i = n.entries.length - 1; i >= 0; i--) {
    if (n.entries[i]!.key === key) return n.entries[i]!.value;
  }
  return undefined;
}

/** Compares strings by code point, which is the UTF-8 byte order Rust's `String` sorts by. */
export function compareKeys(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

/** Object entries as serde_json's `Map` holds them: last duplicate wins, sorted by key. */
export function objectEntries(n: Node & { kind: "object" }): [string, Node][] {
  const byKey = new Map<string, Node>();
  for (const entry of n.entries) byKey.set(entry.key, entry.value);
  return [...byKey].sort(([a], [b]) => compareKeys(a, b));
}

export type JsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Plain JS values. Integers within ±(2^53 - 1) become numbers and larger ones bigints, so no
 * u64 / i64 loses precision; floats are numbers. Objects follow serde_json's `Value`: the last
 * duplicate key wins and keys are inserted in sorted order (JS still enumerates integer-like
 * keys first).
 */
export function toPlain(n: Node): JsonValue {
  switch (n.kind) {
    case "null":
    case "bool":
    case "string":
      return n.value;
    case "number":
      if (typeof n.value === "number") return n.value;
      return n.value <= MAX_SAFE && n.value >= -MAX_SAFE ? Number(n.value) : n.value;
    case "array":
      return n.children.map(toPlain);
    case "object": {
      const out: { [key: string]: JsonValue } = {};
      for (const [key, value] of objectEntries(n)) {
        Object.defineProperty(out, key, {
          value: toPlain(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Decoders for serde's built-in types

export const str: Decoder<string> = (de) => de.deserializeStr(STRING_VISITOR);

export const bool: Decoder<boolean> = (de) =>
  de.deserializeBool({ expecting: "a boolean", visitBool: (b) => b });

function unsigned<T>(name: string, max: bigint, convert: (v: bigint) => T): Decoder<T> {
  const v: Visitor<T> = {
    expecting: name,
    visitU64: (value) =>
      value <= max ? convert(value) : fail(invalidValue({ kind: "unsigned", value }, name)),
    visitI64: (value) =>
      value >= 0n && value <= max
        ? convert(value)
        : fail(invalidValue({ kind: "signed", value }, name)),
  };
  return (de) => de.deserializeNumber(v);
}

function signed<T>(name: string, min: bigint, max: bigint, convert: (v: bigint) => T): Decoder<T> {
  const v: Visitor<T> = {
    expecting: name,
    visitI64: (value) =>
      value >= min && value <= max
        ? convert(value)
        : fail(invalidValue({ kind: "signed", value }, name)),
    visitU64: (value) =>
      value <= max ? convert(value) : fail(invalidValue({ kind: "unsigned", value }, name)),
  };
  return (de) => de.deserializeNumber(v);
}

/** A u64 / i64 as a number when it is a safe integer, else as a bigint. */
function wide(v: bigint): number | bigint {
  return v <= MAX_SAFE && v >= -MAX_SAFE ? Number(v) : v;
}

export const u8: Decoder<number> = unsigned("u8", 255n, Number);
export const u16: Decoder<number> = unsigned("u16", 65535n, Number);
export const u32: Decoder<number> = unsigned("u32", 4294967295n, Number);
export const u64: Decoder<number | bigint> = unsigned("u64", U64_MAX, wide);
export const i8: Decoder<number> = signed("i8", -128n, 127n, Number);
export const i16: Decoder<number> = signed("i16", -32768n, 32767n, Number);
export const i32: Decoder<number> = signed("i32", -2147483648n, 2147483647n, Number);
export const i64: Decoder<number | bigint> = signed("i64", -I64_MAX - 1n, I64_MAX, wide);

export const f64: Decoder<number> = (de) =>
  de.deserializeNumber({
    expecting: "f64",
    visitF64: (v) => v,
    visitU64: (v) => Number(v),
    visitI64: (v) => Number(v),
  });

/** `()`, as `unit_variant` reads it. */
const unit: Decoder<void> = (de) => de.deserializeUnit({ expecting: "unit", visitUnit: () => {} });

/** serde's `IgnoredAny`. */
export const ignored: Decoder<void> = (de) =>
  de.deserializeIgnoredAny({ expecting: "anything at all", visitUnit: () => {} });

/** `serde_json::Value`, as plain JS values (see `toPlain`). */
export const value: Decoder<JsonValue> = (de) => toPlain(node(de));

/** `Option<T>`: `null` is `undefined`. A missing struct field is also `undefined`. */
export function optional<T>(inner: Decoder<T>): Decoder<T | undefined> {
  const v: Visitor<T | undefined> = {
    expecting: "option",
    visitNone: () => undefined,
    visitUnit: () => undefined,
    visitSome: (de) => inner(de),
  };
  return (de) => de.deserializeOption(v);
}

/** `Vec<T>`. */
export function array<T>(element: Decoder<T>): Decoder<T[]> {
  const v: Visitor<T[]> = {
    expecting: "a sequence",
    visitSeq: (seq) => {
      const out: T[] = [];
      for (let el = seq.nextElement(element); el; el = seq.nextElement(element)) out.push(el.value);
      return out;
    },
  };
  return (de) => de.deserializeSeq(v);
}

/** `BTreeMap<String, T>`: the last duplicate wins, and the map iterates in key order. */
export function map<T>(valueDecoder: Decoder<T>): Decoder<Map<string, T>> {
  const v: Visitor<Map<string, T>> = {
    expecting: "a map",
    visitMap: (access) => {
      const out = new Map<string, T>();
      for (let k = access.nextKey(str); k; k = access.nextKey(str)) {
        out.set(k.value, access.nextValue(valueDecoder));
      }
      return new Map([...out].sort(([a], [b]) => compareKeys(a, b)));
    },
  };
  return (de) => de.deserializeMap(v);
}

/** The derive's variant identifier: a variant name, or a variant index. */
function variantIdentifier(names: readonly string[]): Decoder<number> {
  const v: Visitor<number> = {
    expecting: "variant identifier",
    visitStr: (s) => {
      const i = names.indexOf(s);
      return i >= 0 ? i : fail(unknownVariant(s, names));
    },
    visitU64: (value) =>
      value < BigInt(names.length)
        ? Number(value)
        : fail(invalidValue({ kind: "unsigned", value }, `variant index 0 <= i < ${names.length}`)),
  };
  return (de) => de.deserializeIdentifier(v);
}

/**
 * An externally tagged enum of unit variants, e.g. `#[serde(rename_all = "lowercase")] enum
 * Channel { Stable, Beta }`, given as `"beta"` (or `{"beta": null}`). `name` is the Rust type
 * name; `variants` are the serialized names.
 */
export function unitEnum<const V extends string>(name: string, variants: readonly V[]): Decoder<V> {
  const id = variantIdentifier(variants);
  const v: Visitor<V> = {
    expecting: `enum ${name}`,
    visitEnum: (data) => {
      const [index, variant] = data.variant(id);
      variant.unitVariant();
      return variants[index]!;
    },
  };
  return (de) => de.deserializeEnum(v);
}

// ---------------------------------------------------------------------------------------------
// #[derive(Deserialize)] structs

const FIELD = Symbol("field");

/** A struct field with attributes: `#[serde(rename = "…")]`, `#[serde(default)]`. */
export interface Field<T> {
  readonly [FIELD]: true;
  readonly decoder: Decoder<T>;
  readonly rename: string | undefined;
  readonly default: (() => T) | undefined;
}

export interface FieldOptions<T> {
  /** `#[serde(rename = "…")]`: the JSON key. */
  rename?: string;
  /** `#[serde(default)]` / `#[serde(default = "path")]`: a value (cloned) or a factory. */
  default?: T | (() => T);
}

export type FieldSpec<T> = Decoder<T> | Field<T>;
export type FieldsSpec = Record<string, FieldSpec<unknown>>;
export type Decoded<S extends FieldsSpec> = {
  [K in keyof S]: S[K] extends FieldSpec<infer T> ? T : never;
};

export function field<T>(decoder: Decoder<T>, options: FieldOptions<T> = {}): Field<T> {
  const def = options.default;
  let makeDefault: (() => T) | undefined;
  if ("default" in options) {
    makeDefault = typeof def === "function" ? (def as () => T) : () => structuredClone(def as T);
  }
  return { [FIELD]: true, decoder, rename: options.rename, default: makeDefault };
}

/** A `#[serde(default)]` field: `withDefault(array(str), [])`. */
export function withDefault<T>(
  decoder: Decoder<T>,
  def: T | (() => T),
  options: Omit<FieldOptions<T>, "default"> = {},
): Field<T> {
  return field(decoder, { ...options, default: def });
}

export interface StructOptions {
  /** `#[serde(deny_unknown_fields)]`. */
  denyUnknownFields?: boolean;
}

interface CompiledField {
  key: string;
  jsonName: string;
  decoder: Decoder<unknown>;
  default: (() => unknown) | undefined;
}

function structVisitor<S extends FieldsSpec>(
  expecting: string,
  spec: S,
  options: StructOptions,
): Visitor<Decoded<S>> {
  const fields: CompiledField[] = Object.entries(spec).map(([key, s]) =>
    typeof s === "function"
      ? { key, jsonName: key, decoder: s, default: undefined }
      : { key, jsonName: s.rename ?? key, decoder: s.decoder, default: s.default },
  );
  const names = fields.map((f) => f.jsonName);
  const deny = options.denyUnknownFields === true;
  const count = fields.length;
  const fieldId: Decoder<number> = (de) =>
    de.deserializeIdentifier({
      expecting: "field identifier",
      visitStr: (s) => {
        const i = names.indexOf(s);
        if (i >= 0) return i;
        return deny ? fail(unknownField(s, names)) : -1;
      },
      visitU64: (value) => {
        if (value < BigInt(count)) return Number(value);
        if (!deny) return -1;
        throw invalidValue({ kind: "unsigned", value }, `field index 0 <= i < ${count}`);
      },
    });
  const seqExpecting = `${expecting} with ${count === 1 ? "1 element" : `${count} elements`}`;

  return {
    expecting,
    visitSeq: (seq) => {
      const out: Record<string, unknown> = {};
      fields.forEach((f, i) => {
        const el = seq.nextElement(f.decoder);
        if (el) out[f.key] = el.value;
        else if (f.default) out[f.key] = f.default();
        else throw invalidLength(i, seqExpecting);
      });
      return out as Decoded<S>;
    },
    visitMap: (access) => {
      const values = new Map<number, unknown>();
      for (let k = access.nextKey(fieldId); k; k = access.nextKey(fieldId)) {
        const i = k.value;
        if (i < 0) {
          access.nextValue(ignored);
          continue;
        }
        const f = fields[i]!;
        if (values.has(i)) throw duplicateField(f.jsonName);
        values.set(i, access.nextValue(f.decoder));
      }
      const out: Record<string, unknown> = {};
      fields.forEach((f, i) => {
        if (values.has(i)) out[f.key] = values.get(i);
        else if (f.default) out[f.key] = f.default();
        else out[f.key] = f.decoder(new MissingFieldDeserializer(f.jsonName));
      });
      return out as Decoded<S>;
    },
  };
}

/**
 * A `#[derive(Deserialize)] struct`. `name` is the Rust type name (it appears in errors such as
 * `expected struct Manifest`); `spec` maps each Rust field name to its decoder, or to a
 * `field(...)` / `withDefault(...)` carrying attributes. Unknown keys are ignored unless
 * `denyUnknownFields` is set. Like the derive, it also accepts a JSON array of the fields.
 */
export function struct<S extends FieldsSpec>(
  name: string,
  spec: S,
  options: StructOptions = {},
): Decoder<Decoded<S>> {
  const v = structVisitor(`struct ${name}`, spec, options);
  return (de) => de.deserializeStruct(v);
}

// ---------------------------------------------------------------------------------------------
// #[serde(tag = "…")] enums

export interface TaggedVariant {
  /** The Rust variant name, used in `expected struct variant Enum::Variant`. */
  readonly ident: string;
  /** The variant's fields; `undefined` for a unit variant. */
  readonly fields: FieldsSpec | undefined;
  readonly options: StructOptions;
}

/** A struct variant of an internally tagged enum. */
export function variant<S extends FieldsSpec>(
  ident: string,
  fields: S,
  options: StructOptions = {},
): TaggedVariant & { readonly fields: S } {
  return { ident, fields, options };
}

/** A unit variant of an internally tagged enum. */
export function unitVariant(ident: string): TaggedVariant & { readonly fields: undefined } {
  return { ident, fields: undefined, options: {} };
}

type VariantValue<Tag extends string, K, V> = { [P in Tag]: K } & (V extends {
  fields: infer S extends FieldsSpec;
}
  ? Decoded<S>
  : unknown);

export type TaggedDecoded<Tag extends string, V extends Record<string, TaggedVariant>> = {
  [K in keyof V]: VariantValue<Tag, K, V[K]>;
}[keyof V];

const TAG = Symbol("tag");

/**
 * An internally tagged enum, `#[serde(tag = "kind")]`, whose `variants` map each serialized
 * variant name to `variant(...)` or `unitVariant(...)`. Decodes to the variant's fields plus the
 * tag. As in serde, the object is buffered first, so errors inside a variant carry no position
 * of their own (`from_str` adds the position of the enclosing struct, if any).
 */
export function taggedEnum<Tag extends string, V extends Record<string, TaggedVariant>>(
  name: string,
  tag: Tag,
  variants: V,
): Decoder<TaggedDecoded<Tag, V>> {
  const names = Object.keys(variants);
  const tagId = variantIdentifier(names);
  const tagOrContent: Decoder<typeof TAG | string> = (de) =>
    de.deserializeAny({ expecting: "a string", visitStr: (s) => (s === tag ? TAG : s) });
  const tagged: Visitor<[number, Node]> = {
    expecting: `internally tagged enum ${name}`,
    visitSeq: (seq) => {
      const first = seq.nextElement(tagId);
      if (!first) throw missingField(tag);
      const children: Node[] = [];
      for (let el = seq.nextElement(node); el; el = seq.nextElement(node)) children.push(el.value);
      return [first.value, { kind: "array", children, start: -1, end: -1 }];
    },
    visitMap: (access) => {
      let index: number | undefined;
      const entries: NodeEntry[] = [];
      for (let k = access.nextKey(tagOrContent); k; k = access.nextKey(tagOrContent)) {
        if (k.value === TAG) {
          if (index !== undefined) throw duplicateField(tag);
          index = access.nextValue(tagId);
        } else {
          entries.push({ key: k.value, keyStart: -1, keyEnd: -1, value: access.nextValue(node) });
        }
      }
      if (index === undefined) throw missingField(tag);
      return [index, { kind: "object", entries, start: -1, end: -1 }];
    },
  };
  const compiled = names.map((variantName) => {
    const spec = variants[variantName]!;
    return {
      variantName,
      spec,
      visitor: spec.fields
        ? structVisitor(`struct variant ${name}::${spec.ident}`, spec.fields, spec.options)
        : undefined,
      unitVisitor: {
        expecting: `unit variant ${name}::${spec.ident}`,
        visitSeq: () => {},
        visitMap: (access: MapAccess) => {
          while (access.nextKey(ignored)) access.nextValue(ignored);
        },
      } satisfies Visitor<void>,
    };
  });
  return (de) => {
    const [index, content] = de.deserializeAny(tagged);
    const c = compiled[index]!;
    const cd = new ContentDeserializer(content);
    if (!c.visitor) {
      cd.deserializeAny(c.unitVisitor);
      return { [tag]: c.variantName } as TaggedDecoded<Tag, V>;
    }
    const fields = cd.deserializeAny(c.visitor);
    return { [tag]: c.variantName, ...fields } as TaggedDecoded<Tag, V>;
  };
}

// ---------------------------------------------------------------------------------------------
// #[serde(untagged)] enums

/**
 * An untagged enum, `#[serde(untagged)]`: the value is buffered (serde's `Content`), then each
 * variant decoder is tried in order against the buffer; the first that succeeds wins. Errors
 * from the attempts are discarded, as in serde, and the failure is the derive's
 * `data did not match any variant of untagged enum Name`.
 */
export function untagged<T>(name: string, variants: readonly Decoder<T>[]): Decoder<T> {
  return (de) => {
    const content = node(de);
    for (const variant of variants) {
      try {
        return variant(new ContentDeserializer(content));
      } catch {
        // serde tries the next variant.
      }
    }
    throw custom(`data did not match any variant of untagged enum ${name}`);
  };
}

/** A node for a plain JS value, as `serde_json::to_value` would hold it (no source, so no positions). */
export function fromPlain(v: unknown): Node {
  const at = { start: 0, end: 0 };
  if (v === null || v === undefined) return { kind: "null", value: null, ...at };
  if (typeof v === "boolean") return { kind: "bool", value: v, ...at };
  if (typeof v === "bigint")
    return { kind: "number", type: v < 0n ? "i64" : "u64", value: v, ...at };
  if (typeof v === "number") {
    if (Number.isInteger(v))
      return { kind: "number", type: v < 0 ? "i64" : "u64", value: BigInt(v), ...at };
    return { kind: "number", type: "f64", value: v, ...at };
  }
  if (typeof v === "string") return { kind: "string", value: v, ...at };
  if (Array.isArray(v)) return { kind: "array", children: v.map(fromPlain), ...at };
  const o = v as Record<string, unknown>;
  return {
    kind: "object",
    // A `Value` object is a BTreeMap: its keys come out sorted.
    entries: Object.keys(o)
      .sort(compareKeys)
      .map((key) => ({ key, keyStart: 0, keyEnd: 0, value: fromPlain(o[key]) })),
    ...at,
  };
}

/** `serde_json::from_value::<T>`: errors carry no position. */
export function fromValue<T>(v: unknown, decoder: Decoder<T>): T {
  return decode(fromPlain(v), decoder);
}

/**
 * A parsed node as a `serde_json::Value` holds it: duplicate keys collapsed to the last, keys
 * sorted, and no source text, so decoding it reports what `from_value` would (no positions).
 */
export function asValue(n: Node): Node {
  const at = { start: 0, end: 0 };
  switch (n.kind) {
    case "array":
      return { kind: "array", children: n.children.map(asValue), ...at };
    case "object":
      return {
        kind: "object",
        entries: objectEntries(n).map(([key, value]) => ({
          key,
          keyStart: 0,
          keyEnd: 0,
          value: asValue(value),
        })),
        ...at,
      };
    default:
      return { ...n, ...at };
  }
}

/** `serde_json::from_value::<T>` of a parsed `Value`: errors carry no position. */
export function fromValueNode<T>(n: Node, decoder: Decoder<T>): T {
  return decode(asValue(n), decoder);
}

/** `serde_json::to_string_pretty` of a `Value`: two-space indent, keys sorted. */
export function toStringPretty(n: Node): string {
  const write = (v: Node, indent: string): string => {
    switch (v.kind) {
      case "null":
        return "null";
      case "bool":
        return v.value ? "true" : "false";
      case "number":
        return typeof v.value === "bigint" ? v.value.toString() : formatF64(v.value);
      case "string":
        return JSON.stringify(v.value);
      case "array": {
        if (v.children.length === 0) return "[]";
        const inner = `${indent}  `;
        return `[\n${v.children.map((c) => inner + write(c, inner)).join(",\n")}\n${indent}]`;
      }
      case "object": {
        const entries = objectEntries(v);
        if (entries.length === 0) return "{}";
        const inner = `${indent}  `;
        return `{\n${entries.map(([k, c]) => `${inner}${JSON.stringify(k)}: ${write(c, inner)}`).join(",\n")}\n${indent}}`;
      }
    }
  };
  return write(n, "");
}
