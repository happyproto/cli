// Port of the Rust `semver` crate, version 1.0.28 (https://docs.rs/semver/1.0.28).
//
// Behaviour, including every error message, matches the crate. The layout follows the crate's
// modules so a reviewer can diff them side by side:
//   error.rs     -> SemverError, ErrorKind, Position, quotedChar
//   lib.rs       -> Version, VersionReq, Comparator, Op, Prerelease, BuildMetadata
//   parse.rs     -> *FromStr, numericIdentifier, wildcard, dot, prereleaseIdentifier,
//                   buildIdentifier, identifier, op, comparator, versionReq
//   eval.rs      -> matchesReq, matchesComparator, matches*, preIsCompatible
//   impls.rs     -> Prerelease.compare, BuildMetadata.compare
//   display.rs   -> toString methods, pad, digits
//   identifier.rs is a small-string optimisation of `&str`; a JS string replaces it.
//
// Not ported: serde.rs, Hash, Debug, Send/Sync.

import { rustEscapesUnicode } from "./rust-str.ts";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

export type Ordering = -1 | 0 | 1;

function cmpBigint(a: bigint, b: bigint): Ordering {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpNumber(a: number, b: number): Ordering {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Rust's `Ord for str` compares bytes. Identifiers are ASCII, so UTF-16 code unit order is the
// same thing.
function cmpStr(a: string, b: string): Ordering {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertU64(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new RangeError(`${name} must be a bigint in 0..=u64::MAX`);
  }
}

// ---------------------------------------------------------------------------------------------
// error.rs

type Position = "Major" | "Minor" | "Patch" | "Pre" | "Build";

type ErrorKind =
  | { type: "Empty" }
  | { type: "UnexpectedEnd"; pos: Position }
  | { type: "UnexpectedChar"; pos: Position; ch: string }
  | { type: "UnexpectedCharAfter"; pos: Position; ch: string }
  | { type: "ExpectedCommaFound"; pos: Position; ch: string }
  | { type: "LeadingZero"; pos: Position }
  | { type: "Overflow"; pos: Position }
  | { type: "EmptySegment"; pos: Position }
  | { type: "IllegalCharacter"; pos: Position }
  | { type: "WildcardNotTheOnlyComparator"; ch: string }
  | { type: "UnexpectedAfterWildcard" }
  | { type: "ExcessiveComparators" };

function displayPosition(pos: Position): string {
  switch (pos) {
    case "Major":
      return "major version number";
    case "Minor":
      return "minor version number";
    case "Patch":
      return "patch version number";
    case "Pre":
      return "pre-release identifier";
    case "Build":
      return "build metadata";
  }
}

function displayErrorKind(kind: ErrorKind): string {
  switch (kind.type) {
    case "Empty":
      return "empty string, expected a semver version";
    case "UnexpectedEnd":
      return `unexpected end of input while parsing ${displayPosition(kind.pos)}`;
    case "UnexpectedChar":
      return `unexpected character ${quotedChar(kind.ch)} while parsing ${displayPosition(kind.pos)}`;
    case "UnexpectedCharAfter":
      return `unexpected character ${quotedChar(kind.ch)} after ${displayPosition(kind.pos)}`;
    case "ExpectedCommaFound":
      return `expected comma after ${displayPosition(kind.pos)}, found ${quotedChar(kind.ch)}`;
    case "LeadingZero":
      return `invalid leading zero in ${displayPosition(kind.pos)}`;
    case "Overflow":
      return `value of ${displayPosition(kind.pos)} exceeds u64::MAX`;
    case "EmptySegment":
      return `empty identifier segment in ${displayPosition(kind.pos)}`;
    case "IllegalCharacter":
      return `unexpected character in ${displayPosition(kind.pos)}`;
    case "WildcardNotTheOnlyComparator":
      return `wildcard req (${kind.ch}) must be the only comparator in the version req`;
    case "UnexpectedAfterWildcard":
      return "unexpected character after wildcard in version req";
    case "ExcessiveComparators":
      return "excessive number of version comparators";
  }
}

/** Error parsing a SemVer version or version requirement. `message` is the crate's Display. */
export class SemverError extends Error {
  #kind: ErrorKind;

  constructor(kind: ErrorKind) {
    super(displayErrorKind(kind));
    this.name = "SemverError";
    this.#kind = kind;
  }

  /** Mirrors `version_req`'s in-place `error.kind = ...` rewrite. */
  setKind(kind: ErrorKind): void {
    this.#kind = kind;
    this.message = displayErrorKind(kind);
  }

  get kind(): string {
    return this.#kind.type;
  }
}

// QuotedChar: `'\0'` for NUL, otherwise Rust's `<char as Debug>::fmt`.
function quotedChar(ch: string): string {
  if (ch === "\0") {
    return "'\\0'";
  }
  return `'${charEscapeDebug(ch)}'`;
}

// `char::escape_debug_ext` with escape_grapheme_extended and escape_single_quote set, and
// escape_double_quote unset, which is what `<char as Debug>::fmt` uses.
// Which code points take `\u{…}` comes from Rust's tables (rust-escape-table.ts).

function charEscapeDebug(ch: string): string {
  switch (ch) {
    case "\0":
      return "\\0";
    case "\t":
      return "\\t";
    case "\r":
      return "\\r";
    case "\n":
      return "\\n";
    case "\\":
      return "\\\\";
    case "'":
      return "\\'";
  }
  const cp = ch.codePointAt(0)!;
  if (rustEscapesUnicode(cp)) {
    return `\\u{${cp.toString(16)}}`;
  }
  return ch;
}

/** `str::chars().next()`: the first code point, or undefined at end of input. */
function firstChar(text: string): string | undefined {
  const cp = text.codePointAt(0);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

// ---------------------------------------------------------------------------------------------
// lib.rs

/** SemVer version as defined by https://semver.org. */
export class Version {
  major: bigint;
  minor: bigint;
  patch: bigint;
  pre: Prerelease;
  build: BuildMetadata;

  /** `Version::new`, or the struct literal when `pre` and `build` are given. */
  constructor(
    major: bigint,
    minor: bigint,
    patch: bigint,
    pre: Prerelease = Prerelease.EMPTY,
    build: BuildMetadata = BuildMetadata.EMPTY,
  ) {
    assertU64("major", major);
    assertU64("minor", minor);
    assertU64("patch", patch);
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.pre = pre;
    this.build = build;
  }

  /** Throws SemverError. */
  static parse(text: string): Version {
    return versionFromStr(text);
  }

  /**
   * Compare the major, minor, patch, and pre-release value of two versions, disregarding build
   * metadata. Versions that differ only in build metadata are considered equal.
   */
  static cmpPrecedence(a: Version, b: Version): Ordering {
    return (
      cmpBigint(a.major, b.major) ||
      cmpBigint(a.minor, b.minor) ||
      cmpBigint(a.patch, b.patch) ||
      Prerelease.compare(a.pre, b.pre)
    );
  }

  cmpPrecedence(other: Version): Ordering {
    return Version.cmpPrecedence(this, other);
  }

  /** The derived `Ord`: major, minor, patch, pre, then build. */
  static compare(a: Version, b: Version): Ordering {
    return Version.cmpPrecedence(a, b) || BuildMetadata.compare(a.build, b.build);
  }

  /** The derived `PartialEq` (build metadata included). */
  equals(other: Version): boolean {
    return (
      this.major === other.major &&
      this.minor === other.minor &&
      this.patch === other.patch &&
      this.pre.equals(other.pre) &&
      this.build.equals(other.build)
    );
  }

  /**
   * Display. With no argument this is `format!("{}", v)`. With a width it is `{:w}`, `{:<w}`,
   * `{:^w}`, `{:>w}` (and an optional fill char, as in `{:*^w}`). Alignment defaults to left.
   */
  toString(format?: DisplayFormat): string {
    const doDisplay = (): string => {
      let out = `${this.major}.${this.minor}.${this.patch}`;
      if (!this.pre.isEmpty()) {
        out += `-${this.pre}`;
      }
      if (!this.build.isEmpty()) {
        out += `+${this.build}`;
      }
      return out;
    };

    const doLen = (): number =>
      digits(this.major) +
      1 +
      digits(this.minor) +
      1 +
      digits(this.patch) +
      (!this.pre.isEmpty() ? 1 : 0) +
      this.pre.asStr().length +
      (!this.build.isEmpty() ? 1 : 0) +
      this.build.asStr().length;

    return pad(format, doDisplay, doLen);
  }
}

export type DisplayFormat = {
  width?: number;
  /** "<" left, "^" center, ">" right. */
  align?: "<" | "^" | ">";
  /** A single char; defaults to a space. */
  fill?: string;
};

/** SemVer version requirement describing the intersection of some version comparators. */
export class VersionReq {
  comparators: Comparator[];

  /** `VersionReq { comparators }`. With no argument this is `VersionReq::default()` (STAR). */
  constructor(comparators: Comparator[] = []) {
    this.comparators = comparators;
  }

  /** A `VersionReq` with no constraint on the version numbers it matches. Frozen. */
  static readonly STAR: VersionReq = Object.freeze(
    new VersionReq(Object.freeze([]) as unknown as Comparator[]),
  );

  /** Throws SemverError. */
  static parse(text: string): VersionReq {
    return versionReqFromStr(text);
  }

  matches(version: Version): boolean {
    return matchesReq(this, version);
  }

  equals(other: VersionReq): boolean {
    return (
      this.comparators.length === other.comparators.length &&
      this.comparators.every((c, i) => c.equals(other.comparators[i]!))
    );
  }

  toString(): string {
    if (this.comparators.length === 0) {
      return "*";
    }
    return this.comparators.map((c) => c.toString()).join(", ");
  }
}

/** A pair of comparison operator and partial version, such as `>=1.2`. */
export class Comparator {
  op: Op;
  major: bigint;
  minor?: bigint;
  /** Patch is only allowed if minor is Some. */
  patch?: bigint;
  /** Non-empty pre-release is only allowed if patch is Some. */
  pre: Prerelease;

  constructor(fields: {
    op: Op;
    major: bigint;
    minor?: bigint | undefined;
    patch?: bigint | undefined;
    pre?: Prerelease;
  }) {
    assertU64("major", fields.major);
    if (fields.minor !== undefined) assertU64("minor", fields.minor);
    if (fields.patch !== undefined) assertU64("patch", fields.patch);
    this.op = fields.op;
    this.major = fields.major;
    this.minor = fields.minor;
    this.patch = fields.patch;
    this.pre = fields.pre ?? Prerelease.EMPTY;
  }

  /** Throws SemverError. */
  static parse(text: string): Comparator {
    return comparatorFromStr(text);
  }

  matches(version: Version): boolean {
    return matchesComparator(this, version);
  }

  equals(other: Comparator): boolean {
    return (
      this.op === other.op &&
      this.major === other.major &&
      this.minor === other.minor &&
      this.patch === other.patch &&
      this.pre.equals(other.pre)
    );
  }

  toString(): string {
    const ops: Record<Op, string> = {
      Exact: "=",
      Greater: ">",
      GreaterEq: ">=",
      Less: "<",
      LessEq: "<=",
      Tilde: "~",
      Caret: "^",
      Wildcard: "",
    };
    let out = ops[this.op];
    out += `${this.major}`;
    if (this.minor !== undefined) {
      out += `.${this.minor}`;
      if (this.patch !== undefined) {
        out += `.${this.patch}`;
        if (!this.pre.isEmpty()) {
          out += `-${this.pre}`;
        }
      } else if (this.op === "Wildcard") {
        out += ".*";
      }
    } else if (this.op === "Wildcard") {
      out += ".*";
    }
    return out;
  }
}

/** SemVer comparison operator: `=`, `>`, `>=`, `<`, `<=`, `~`, `^`, `*`. */
export type Op =
  | "Exact"
  | "Greater"
  | "GreaterEq"
  | "Less"
  | "LessEq"
  | "Tilde"
  | "Caret"
  | "Wildcard";

// Gate on the constructors standing in for the crate's private fields: outside this module the
// only ways to get a Prerelease or BuildMetadata are `new` (which validates), `parse`, and EMPTY.
const UNCHECKED: unique symbol = Symbol("semver.unchecked");

/** Optional pre-release identifier on a version string. */
export class Prerelease {
  readonly #identifier: string;

  /** Internal; use `Prerelease.new`. */
  constructor(token: typeof UNCHECKED, identifier: string) {
    if (token !== UNCHECKED) {
      throw new TypeError("use Prerelease.new");
    }
    this.#identifier = identifier;
  }

  static readonly EMPTY: Prerelease = new Prerelease(UNCHECKED, "");

  /** `Prerelease::new`. Throws SemverError. */
  static new(text: string): Prerelease {
    return prereleaseFromStr(text);
  }

  asStr(): string {
    return this.#identifier;
  }

  isEmpty(): boolean {
    return this.#identifier === "";
  }

  equals(other: Prerelease): boolean {
    return this.#identifier === other.#identifier;
  }

  toString(): string {
    return this.#identifier;
  }

  /** impls.rs `Ord for Prerelease`. An empty pre-release is greater than any non-empty one. */
  static compare(self: Prerelease, rhs: Prerelease): Ordering {
    // Stands in for Identifier::ptr_eq, which holds for two empty identifiers.
    if (self.#identifier === rhs.#identifier) {
      return 0;
    }

    if (self.isEmpty()) {
      // A real release compares greater than prerelease.
      return 1;
    } else if (rhs.isEmpty()) {
      // Prerelease compares less than the real release.
      return -1;
    }

    const lhsParts = self.asStr().split(".");
    const rhsParts = rhs.asStr().split(".");
    let r = 0;

    for (const lhs of lhsParts) {
      if (r >= rhsParts.length) {
        // Spec: "A larger set of pre-release fields has a higher precedence than a smaller set,
        // if all of the preceding identifiers are equal."
        return 1;
      }
      const rhsPart = rhsParts[r++]!;

      const lhsDigits = isAllAsciiDigits(lhs);
      const rhsDigits = isAllAsciiDigits(rhsPart);
      let ordering: Ordering;
      if (lhsDigits && rhsDigits) {
        // Respect numeric ordering, for example 99 < 100. Spec says: "Identifiers consisting of
        // only digits are compared numerically."
        ordering = cmpNumber(lhs.length, rhsPart.length) || cmpStr(lhs, rhsPart);
      } else if (lhsDigits && !rhsDigits) {
        // Spec: "Numeric identifiers always have lower precedence than non-numeric identifiers."
        return -1;
      } else if (!lhsDigits && rhsDigits) {
        return 1;
      } else {
        // Spec: "Identifiers with letters or hyphens are compared lexically in ASCII sort order."
        ordering = cmpStr(lhs, rhsPart);
      }

      if (ordering !== 0) {
        return ordering;
      }
    }

    return r >= rhsParts.length ? 0 : -1;
  }
}

/** Optional build metadata identifier. */
export class BuildMetadata {
  readonly #identifier: string;

  /** Internal; use `BuildMetadata.new`. */
  constructor(token: typeof UNCHECKED, identifier: string) {
    if (token !== UNCHECKED) {
      throw new TypeError("use BuildMetadata.new");
    }
    this.#identifier = identifier;
  }

  static readonly EMPTY: BuildMetadata = new BuildMetadata(UNCHECKED, "");

  /** `BuildMetadata::new`. Throws SemverError. */
  static new(text: string): BuildMetadata {
    return buildMetadataFromStr(text);
  }

  asStr(): string {
    return this.#identifier;
  }

  isEmpty(): boolean {
    return this.#identifier === "";
  }

  equals(other: BuildMetadata): boolean {
    return this.#identifier === other.#identifier;
  }

  toString(): string {
    return this.#identifier;
  }

  /**
   * impls.rs `Ord for BuildMetadata`. Numeric segments order 0 < 00 < 1 < 01 < 001 < 2 < 02 <
   * 002 < 10; the empty build metadata sorts before any non-empty one.
   */
  static compare(self: BuildMetadata, rhs: BuildMetadata): Ordering {
    if (self.#identifier === rhs.#identifier) {
      return 0;
    }

    const lhsParts = self.asStr().split(".");
    const rhsParts = rhs.asStr().split(".");
    let r = 0;

    for (const lhs of lhsParts) {
      if (r >= rhsParts.length) {
        return 1;
      }
      const rhsPart = rhsParts[r++]!;

      const lhsDigits = isAllAsciiDigits(lhs);
      const rhsDigits = isAllAsciiDigits(rhsPart);
      let ordering: Ordering;
      if (lhsDigits && rhsDigits) {
        // 0 < 00 < 1 < 01 < 001 < 2 < 02 < 002 < 10
        const lhval = trimStartMatches(lhs, "0");
        const rhval = trimStartMatches(rhsPart, "0");
        ordering =
          cmpNumber(lhval.length, rhval.length) ||
          cmpStr(lhval, rhval) ||
          cmpNumber(lhs.length, rhsPart.length);
      } else if (lhsDigits && !rhsDigits) {
        return -1;
      } else if (!lhsDigits && rhsDigits) {
        return 1;
      } else {
        ordering = cmpStr(lhs, rhsPart);
      }

      if (ordering !== 0) {
        return ordering;
      }
    }

    return r >= rhsParts.length ? 0 : -1;
  }
}

/** `s.bytes().all(|b| b.is_ascii_digit())`; true for the empty string. */
function isAllAsciiDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      return false;
    }
  }
  return true;
}

/** `str::trim_start_matches(ch)` for a single ASCII char. */
function trimStartMatches(s: string, ch: string): string {
  let i = 0;
  while (s[i] === ch) {
    i++;
  }
  return s.slice(i);
}

// ---------------------------------------------------------------------------------------------
// parse.rs

function error(kind: ErrorKind): SemverError {
  return new SemverError(kind);
}

// impl FromStr for Version
function versionFromStr(text: string): Version {
  if (text === "") {
    throw error({ type: "Empty" });
  }

  let pos: Position = "Major";
  let major: bigint;
  [major, text] = numericIdentifier(text, pos);
  text = dot(text, pos);

  pos = "Minor";
  let minor: bigint;
  [minor, text] = numericIdentifier(text, pos);
  text = dot(text, pos);

  pos = "Patch";
  let patch: bigint;
  [patch, text] = numericIdentifier(text, pos);

  if (text === "") {
    return new Version(major, minor, patch);
  }

  let pre: Prerelease;
  if (text.startsWith("-")) {
    text = text.slice(1);
    pos = "Pre";
    [pre, text] = prereleaseIdentifier(text);
    if (pre.isEmpty()) {
      throw error({ type: "EmptySegment", pos });
    }
  } else {
    pre = Prerelease.EMPTY;
  }

  let build: BuildMetadata;
  if (text.startsWith("+")) {
    text = text.slice(1);
    pos = "Build";
    [build, text] = buildIdentifier(text);
    if (build.isEmpty()) {
      throw error({ type: "EmptySegment", pos });
    }
  } else {
    build = BuildMetadata.EMPTY;
  }

  const unexpected = firstChar(text);
  if (unexpected !== undefined) {
    throw error({ type: "UnexpectedCharAfter", pos, ch: unexpected });
  }

  return new Version(major, minor, patch, pre, build);
}

// impl FromStr for VersionReq
function versionReqFromStr(text: string): VersionReq {
  text = trimStartMatches(text, " ");
  const wc = wildcard(text);
  if (wc !== undefined) {
    const [ch, afterWildcard] = wc;
    const rest = trimStartMatches(afterWildcard, " ");
    if (rest === "") {
      // A fresh value, like Rust's copy of the STAR const; STAR itself is frozen.
      return new VersionReq([]);
    } else if (rest.startsWith(",")) {
      throw error({ type: "WildcardNotTheOnlyComparator", ch });
    } else {
      throw error({ type: "UnexpectedAfterWildcard" });
    }
  }

  const depth = 0;
  const comparators: Comparator[] = [];
  const len = versionReq(text, comparators, depth);
  comparators.length = len;
  return new VersionReq(comparators);
}

// impl FromStr for Comparator
function comparatorFromStr(text: string): Comparator {
  text = trimStartMatches(text, " ");
  const [cmp, pos, rest] = comparator(text);
  if (rest !== "") {
    const unexpected = firstChar(rest)!;
    throw error({ type: "UnexpectedCharAfter", pos, ch: unexpected });
  }
  return cmp;
}

// impl FromStr for Prerelease
function prereleaseFromStr(text: string): Prerelease {
  const [pre, rest] = prereleaseIdentifier(text);
  if (rest !== "") {
    throw error({ type: "IllegalCharacter", pos: "Pre" });
  }
  return pre;
}

// impl FromStr for BuildMetadata
function buildMetadataFromStr(text: string): BuildMetadata {
  const [build, rest] = buildIdentifier(text);
  if (rest !== "") {
    throw error({ type: "IllegalCharacter", pos: "Build" });
  }
  return build;
}

// impl Op { const DEFAULT }
const OP_DEFAULT: Op = "Caret";

function numericIdentifier(input: string, pos: Position): [bigint, string] {
  let len = 0;
  let value = 0n;

  while (len < input.length) {
    const digit = input.charCodeAt(len);
    if (digit < 0x30 || digit > 0x39) {
      break;
    }
    if (value === 0n && len > 0) {
      throw error({ type: "LeadingZero", pos });
    }
    const sum = value * 10n + BigInt(digit - 0x30);
    if (sum > U64_MAX) {
      throw error({ type: "Overflow", pos });
    }
    value = sum;
    len += 1;
  }

  if (len > 0) {
    return [value, input.slice(len)];
  }
  const unexpected = firstChar(input.slice(len));
  if (unexpected !== undefined) {
    throw error({ type: "UnexpectedChar", pos, ch: unexpected });
  }
  throw error({ type: "UnexpectedEnd", pos });
}

function wildcard(input: string): [string, string] | undefined {
  if (input.startsWith("*")) {
    return ["*", input.slice(1)];
  } else if (input.startsWith("x")) {
    return ["x", input.slice(1)];
  } else if (input.startsWith("X")) {
    return ["X", input.slice(1)];
  } else {
    return undefined;
  }
}

function dot(input: string, pos: Position): string {
  if (input.startsWith(".")) {
    return input.slice(1);
  }
  const unexpected = firstChar(input);
  if (unexpected !== undefined) {
    throw error({ type: "UnexpectedCharAfter", pos, ch: unexpected });
  }
  throw error({ type: "UnexpectedEnd", pos });
}

function prereleaseIdentifier(input: string): [Prerelease, string] {
  const [string, rest] = identifier(input, "Pre");
  return [new Prerelease(UNCHECKED, string), rest];
}

function buildIdentifier(input: string): [BuildMetadata, string] {
  const [string, rest] = identifier(input, "Build");
  return [new BuildMetadata(UNCHECKED, string), rest];
}

const DOT = 0x2e;

function identifier(input: string, pos: Position): [string, string] {
  let accumulatedLen = 0;
  let segmentLen = 0;
  let segmentHasNondigit = false;

  for (;;) {
    const i = accumulatedLen + segmentLen;
    // `input.as_bytes().get(i)`; undefined past the end. Only ASCII values are matched below, so
    // reading UTF-16 code units instead of UTF-8 bytes gives the same result.
    const b = i < input.length ? input.charCodeAt(i) : undefined;
    if (
      b !== undefined &&
      ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d) // A-Z a-z -
    ) {
      segmentLen += 1;
      segmentHasNondigit = true;
    } else if (b !== undefined && b >= 0x30 && b <= 0x39) {
      segmentLen += 1;
    } else {
      const boundary = b;
      if (segmentLen === 0) {
        if (accumulatedLen === 0 && boundary !== DOT) {
          return ["", input];
        } else {
          throw error({ type: "EmptySegment", pos });
        }
      }
      if (
        pos === "Pre" &&
        segmentLen > 1 &&
        !segmentHasNondigit &&
        input.slice(accumulatedLen).startsWith("0")
      ) {
        throw error({ type: "LeadingZero", pos });
      }
      accumulatedLen += segmentLen;
      if (boundary === DOT) {
        accumulatedLen += 1;
        segmentLen = 0;
        segmentHasNondigit = false;
      } else {
        return [input.slice(0, accumulatedLen), input.slice(accumulatedLen)];
      }
    }
  }
}

function op(input: string): [Op, string] {
  const first = input[0];
  if (first === "=") {
    return ["Exact", input.slice(1)];
  } else if (first === ">") {
    if (input[1] === "=") {
      return ["GreaterEq", input.slice(2)];
    } else {
      return ["Greater", input.slice(1)];
    }
  } else if (first === "<") {
    if (input[1] === "=") {
      return ["LessEq", input.slice(2)];
    } else {
      return ["Less", input.slice(1)];
    }
  } else if (first === "~") {
    return ["Tilde", input.slice(1)];
  } else if (first === "^") {
    return ["Caret", input.slice(1)];
  } else {
    return [OP_DEFAULT, input];
  }
}

function comparator(input: string): [Comparator, Position, string] {
  let [cmpOp, text] = op(input);
  const defaultOp = input.length === text.length;
  text = trimStartMatches(text, " ");

  let pos: Position = "Major";
  let major: bigint;
  [major, text] = numericIdentifier(text, pos);
  let hasWildcard = false;

  let minor: bigint | undefined;
  if (text.startsWith(".")) {
    text = text.slice(1);
    pos = "Minor";
    const wc = wildcard(text);
    if (wc !== undefined) {
      hasWildcard = true;
      if (defaultOp) {
        cmpOp = "Wildcard";
      }
      minor = undefined;
      text = wc[1];
    } else {
      [minor, text] = numericIdentifier(text, pos);
    }
  } else {
    minor = undefined;
  }

  let patch: bigint | undefined;
  if (text.startsWith(".")) {
    text = text.slice(1);
    pos = "Patch";
    const wc = wildcard(text);
    if (wc !== undefined) {
      if (defaultOp) {
        cmpOp = "Wildcard";
      }
      patch = undefined;
      text = wc[1];
    } else if (hasWildcard) {
      throw error({ type: "UnexpectedAfterWildcard" });
    } else {
      [patch, text] = numericIdentifier(text, pos);
    }
  } else {
    patch = undefined;
  }

  let pre: Prerelease;
  if (patch !== undefined && text.startsWith("-")) {
    pos = "Pre";
    text = text.slice(1);
    [pre, text] = prereleaseIdentifier(text);
    if (pre.isEmpty()) {
      throw error({ type: "EmptySegment", pos });
    }
  } else {
    pre = Prerelease.EMPTY;
  }

  if (patch !== undefined && text.startsWith("+")) {
    pos = "Build";
    text = text.slice(1);
    let build: BuildMetadata;
    [build, text] = buildIdentifier(text);
    if (build.isEmpty()) {
      throw error({ type: "EmptySegment", pos });
    }
  }

  text = trimStartMatches(text, " ");

  const cmp = new Comparator({ op: cmpOp, major, minor, patch, pre });

  return [cmp, pos, text];
}

function versionReq(input: string, out: Comparator[], depth: number): number {
  let cmp: Comparator;
  let pos: Position;
  let text: string;
  try {
    [cmp, pos, text] = comparator(input);
  } catch (err) {
    if (err instanceof SemverError) {
      const wc = wildcard(input);
      if (wc !== undefined) {
        const [ch] = wc;
        const rest = trimStartMatches(wc[1], " ");
        if (rest === "" || rest.startsWith(",")) {
          err.setKind({ type: "WildcardNotTheOnlyComparator", ch });
        }
      }
    }
    throw err;
  }

  if (text === "") {
    out[depth] = cmp;
    return depth + 1;
  }

  if (text.startsWith(",")) {
    text = trimStartMatches(text.slice(1), " ");
  } else {
    const unexpected = firstChar(text)!;
    throw error({ type: "ExpectedCommaFound", pos, ch: unexpected });
  }

  const MAX_COMPARATORS = 32;
  if (depth + 1 === MAX_COMPARATORS) {
    throw error({ type: "ExcessiveComparators" });
  }

  // Recurse to collect parsed Comparator objects, as the crate does.
  const len = versionReq(text, out, depth + 1);
  out[depth] = cmp;
  return len;
}

// ---------------------------------------------------------------------------------------------
// eval.rs

function matchesReq(req: VersionReq, ver: Version): boolean {
  for (const cmp of req.comparators) {
    if (!matchesImpl(cmp, ver)) {
      return false;
    }
  }

  if (ver.pre.isEmpty()) {
    return true;
  }

  // If a version has a prerelease tag (for example, 1.2.3-alpha.3) then it will only be allowed
  // to satisfy req if at least one comparator with the same major.minor.patch also has a
  // prerelease tag.
  for (const cmp of req.comparators) {
    if (preIsCompatible(cmp, ver)) {
      return true;
    }
  }

  return false;
}

function matchesComparator(cmp: Comparator, ver: Version): boolean {
  return matchesImpl(cmp, ver) && (ver.pre.isEmpty() || preIsCompatible(cmp, ver));
}

function matchesImpl(cmp: Comparator, ver: Version): boolean {
  switch (cmp.op) {
    case "Exact":
    case "Wildcard":
      return matchesExact(cmp, ver);
    case "Greater":
      return matchesGreater(cmp, ver);
    case "GreaterEq":
      return matchesExact(cmp, ver) || matchesGreater(cmp, ver);
    case "Less":
      return matchesLess(cmp, ver);
    case "LessEq":
      return matchesExact(cmp, ver) || matchesLess(cmp, ver);
    case "Tilde":
      return matchesTilde(cmp, ver);
    case "Caret":
      return matchesCaret(cmp, ver);
  }
}

function matchesExact(cmp: Comparator, ver: Version): boolean {
  if (ver.major !== cmp.major) {
    return false;
  }

  if (cmp.minor !== undefined) {
    if (ver.minor !== cmp.minor) {
      return false;
    }
  }

  if (cmp.patch !== undefined) {
    if (ver.patch !== cmp.patch) {
      return false;
    }
  }

  return ver.pre.equals(cmp.pre);
}

function matchesGreater(cmp: Comparator, ver: Version): boolean {
  if (ver.major !== cmp.major) {
    return ver.major > cmp.major;
  }

  if (cmp.minor === undefined) {
    return false;
  } else if (ver.minor !== cmp.minor) {
    return ver.minor > cmp.minor;
  }

  if (cmp.patch === undefined) {
    return false;
  } else if (ver.patch !== cmp.patch) {
    return ver.patch > cmp.patch;
  }

  return Prerelease.compare(ver.pre, cmp.pre) > 0;
}

function matchesLess(cmp: Comparator, ver: Version): boolean {
  if (ver.major !== cmp.major) {
    return ver.major < cmp.major;
  }

  if (cmp.minor === undefined) {
    return false;
  } else if (ver.minor !== cmp.minor) {
    return ver.minor < cmp.minor;
  }

  if (cmp.patch === undefined) {
    return false;
  } else if (ver.patch !== cmp.patch) {
    return ver.patch < cmp.patch;
  }

  return Prerelease.compare(ver.pre, cmp.pre) < 0;
}

function matchesTilde(cmp: Comparator, ver: Version): boolean {
  if (ver.major !== cmp.major) {
    return false;
  }

  if (cmp.minor !== undefined) {
    if (ver.minor !== cmp.minor) {
      return false;
    }
  }

  if (cmp.patch !== undefined) {
    if (ver.patch !== cmp.patch) {
      return ver.patch > cmp.patch;
    }
  }

  return Prerelease.compare(ver.pre, cmp.pre) >= 0;
}

function matchesCaret(cmp: Comparator, ver: Version): boolean {
  if (ver.major !== cmp.major) {
    return false;
  }

  const minor = cmp.minor;
  if (minor === undefined) {
    return true;
  }

  const patch = cmp.patch;
  if (patch === undefined) {
    if (cmp.major > 0n) {
      return ver.minor >= minor;
    } else {
      return ver.minor === minor;
    }
  }

  if (cmp.major > 0n) {
    if (ver.minor !== minor) {
      return ver.minor > minor;
    } else if (ver.patch !== patch) {
      return ver.patch > patch;
    }
  } else if (minor > 0n) {
    if (ver.minor !== minor) {
      return false;
    } else if (ver.patch !== patch) {
      return ver.patch > patch;
    }
  } else if (ver.minor !== minor || ver.patch !== patch) {
    return false;
  }

  return Prerelease.compare(ver.pre, cmp.pre) >= 0;
}

function preIsCompatible(cmp: Comparator, ver: Version): boolean {
  return (
    cmp.major === ver.major &&
    cmp.minor === ver.minor &&
    cmp.patch === ver.patch &&
    !cmp.pre.isEmpty()
  );
}

// ---------------------------------------------------------------------------------------------
// display.rs

function pad(
  format: DisplayFormat | undefined,
  doDisplay: () => string,
  doLen: () => number,
): string {
  const minWidth = format?.width;
  if (minWidth === undefined) {
    return doDisplay();
  }

  const len = doLen();
  if (len >= minWidth) {
    return doDisplay();
  }

  const align = format?.align ?? "<";
  const padding = minWidth - len;
  let prePad: number;
  let postPad: number;
  switch (align) {
    case "<":
      [prePad, postPad] = [0, padding];
      break;
    case ">":
      [prePad, postPad] = [padding, 0];
      break;
    case "^":
      [prePad, postPad] = [Math.floor(padding / 2), Math.floor((padding + 1) / 2)];
      break;
  }

  const fill = format?.fill ?? " ";
  return fill.repeat(prePad) + doDisplay() + fill.repeat(postPad);
}

function digits(val: bigint): number {
  if (val < 10n) {
    return 1;
  } else {
    return 1 + digits(val / 10n);
  }
}
