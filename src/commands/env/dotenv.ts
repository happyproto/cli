// commands/happyview/env/dotenv.rs: a project's `.env`, read the way HappyView reads it for
// `ctx.env` (with dotenvy 0.15, whose syntax this follows), so `hpy hv env push` sends what
// `hpy hv dev` would give a script.
//
// One difference: a `$NAME` in a value is filled only from the keys set above it in the file,
// never from the process environment, so what is sent does not depend on the shell `hpy` runs
// in. A name the file does not set is filled with nothing, and reported, so the caller can say
// so.
//
// Nothing here prints, and no error carries text from the file: a line that does not parse is
// usually a secret, so it is named by its number only.
//
// Indices are JS string indices throughout; Rust's are byte offsets, but they are only ever
// used to slice the same string, so the results agree.
import {
  isAlphanumeric,
  isAsciiAlphabetic,
  isAsciiAlphanumeric,
  isWhitespace,
  trimEnd,
  trimStart,
} from "../../core/rust-str.ts";

/** One `KEY=VALUE`. */
export class Entry {
  readonly key: string;
  readonly value: string;
  /** The 1-based line it starts on. */
  readonly line: number;
  /** The `$NAME`s in its value that no key above it sets. */
  readonly unset: string[];

  constructor(key: string, value: string, line: number, unset: string[]) {
    this.key = key;
    this.value = value;
    this.line = line;
    this.unset = unset;
  }

  /** The value is a secret; never print it. */
  toString(): string {
    return `Entry { key: ${JSON.stringify(this.key)}, line: ${this.line}, .. }`;
  }
  toJSON(): unknown {
    return { key: this.key, line: this.line };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** A line that is not a `KEY=VALUE` HappyView can read. */
export interface BadLine {
  line: number;
  why: string;
}

export const KEY_RULE = "a key starts with a letter or _, and has only letters, digits, _ and .";

const keyStart = (c: string) => isAsciiAlphabetic(c) || c === "_";
const keyChar = (c: string) => isAsciiAlphanumeric(c) || c === "_" || c === ".";

/**
 * Whether `key` is one HappyView's `.env` reader accepts. The admin API itself takes any
 * string, so this is the rule a key has to meet to be the same key in `.env` and on the
 * instance.
 */
export function validKey(key: string): boolean {
  const chars = [...key];
  return chars.length > 0 && keyStart(chars[0] as string) && chars.slice(1).every(keyChar);
}

/** Thrown by `parse` with every line that doesn't parse. */
export class BadLines extends Error {
  readonly bad: BadLine[];

  constructor(bad: BadLine[]) {
    super("bad .env lines");
    this.bad = bad;
  }
}

/** Every entry in `text`, in order; throws `BadLines` with every line that doesn't parse. */
export function parse(input: string): Entry[] {
  // A Windows editor's byte-order mark would otherwise begin the first key.
  const text = input.startsWith("\u{feff}") ? input.slice(1) : input;
  const entries: Entry[] = [];
  const bad: BadLine[] = [];
  const known = new Map<string, string | null>();
  for (const logical of logicalLines(text)) {
    if ("why" in logical) {
      bad.push(logical);
      continue;
    }
    const [line, body] = logical.ok;
    let parsed: Parsed;
    try {
      parsed = parseLine(body, known);
    } catch (e) {
      if (typeof e !== "string") throw e;
      bad.push({ line, why: e });
      continue;
    }
    if (parsed) entries.push(new Entry(parsed[0], parsed[1], line, parsed[2]));
  }
  if (bad.length) throw new BadLines(bad);
  return entries;
}

type State =
  | "Complete"
  | "Escape"
  | "StrongOpen"
  | "StrongOpenEscape"
  | "WeakOpen"
  | "WeakOpenEscape"
  | "Comment"
  | "WhiteSpace";

/** Where a physical line leaves a logical one, and where a trailing comment starts. */
function endState(from: State, buf: string): [number, State] {
  let state = from;
  let at = 0;
  let pos = 0;
  for (const c of buf) {
    at = pos;
    pos += c.length;
    switch (state) {
      case "WhiteSpace":
        if (c === "#") return [at, "Comment"];
        state =
          c === "\\" ? "Escape" : c === '"' ? "WeakOpen" : c === "'" ? "StrongOpen" : "Complete";
        break;
      case "Escape":
        state = "Complete";
        break;
      case "Complete":
        if (isWhitespace(c) && c !== "\n" && c !== "\r") state = "WhiteSpace";
        else
          state =
            c === "\\" ? "Escape" : c === '"' ? "WeakOpen" : c === "'" ? "StrongOpen" : "Complete";
        break;
      case "WeakOpen":
        state = c === "\\" ? "WeakOpenEscape" : c === '"' ? "Complete" : "WeakOpen";
        break;
      case "WeakOpenEscape":
        state = "WeakOpen";
        break;
      case "StrongOpen":
        state = c === "\\" ? "StrongOpenEscape" : c === "'" ? "Complete" : "StrongOpen";
        break;
      case "StrongOpenEscape":
        state = "StrongOpen";
        break;
      case "Comment":
        throw new Error("unreachable: returned as it was found");
    }
  }
  return [at, state];
}

/** `str::split_inclusive('\n')`. */
function splitInclusive(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const i = text.indexOf("\n", start);
    if (i < 0) break;
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** The file's logical lines, each with the line it starts on: a quoted value may run over several. */
function logicalLines(text: string): ({ ok: [number, string] } | BadLine)[] {
  const out: ({ ok: [number, string] } | BadLine)[] = [];
  const physical = splitInclusive(text);
  let next = 0;
  logical: for (;;) {
    let buf = "";
    let state: State = "Complete";
    let start = 0;
    for (;;) {
      if (next >= physical.length) {
        if (state === "WhiteSpace") {
          // Trailing blanks on a last line with no newline.
          out.push({ ok: [start, buf] });
        } else if (state !== "Complete") {
          out.push({ line: start, why: "a quote is never closed" });
        }
        break logical;
      }
      const i = next;
      const line = physical[next++] as string;
      if (buf === "") start = i + 1;
      const from = buf.length;
      buf += line;
      if (trimStart(buf).startsWith("#")) continue logical;
      const [at, s] = endState(state, buf.slice(from));
      state = s;
      if (state === "Complete") {
        if (buf.endsWith("\n")) {
          buf = buf.slice(0, -1);
          if (buf.endsWith("\r")) buf = buf.slice(0, -1);
        }
        out.push({ ok: [start, buf] });
        continue logical;
      }
      if (state === "Comment") {
        buf = buf.slice(0, from + at);
        out.push({ ok: [start, buf] });
        continue logical;
      }
    }
  }
  return out;
}

type Parsed = [string, string, string[]] | null;

/** Throws the reason as a bare string. */
function parseLine(line: string, known: Map<string, string | null>): Parsed {
  let rest = trimStart(trimEnd(line));
  if (rest === "" || rest.startsWith("#")) return null;
  let key: string;
  [key, rest] = takeKey(rest);
  rest = trimStart(rest);
  // `export` is either a prefix or a key of its own.
  if (key === "export" && !rest.startsWith("=")) {
    [key, rest] = takeKey(rest);
    rest = trimStart(rest);
  }
  if (!rest.startsWith("=")) throw rest.includes("=") ? KEY_RULE : "expected KEY=VALUE";
  rest = trimStart(rest.slice(1));
  if (rest === "" || rest.startsWith("#")) {
    known.set(key, null);
    return [key, "", []];
  }
  const [value, unset] = parseValue(rest, known);
  known.set(key, value);
  return [key, value, unset];
}

function takeKey(rest: string): [string, string] {
  const first = [...rest][0];
  if (first === undefined || !keyStart(first)) throw KEY_RULE;
  let end = 0;
  for (const c of rest) {
    if (!keyChar(c)) break;
    end += c.length;
  }
  return [rest.slice(0, end), rest.slice(end)];
}

type Sub = "None" | "Block" | "Braced";

function parseValue(input: string, known: Map<string, string | null>): [string, string[]] {
  let strong = false;
  let weak = false;
  let escaped = false;
  let expectingEnd = false;
  let out = "";
  const unset: string[] = [];
  let sub: Sub = "None";
  let name = "";
  const fill = () => {
    const n = name;
    name = "";
    if (known.has(n)) out += known.get(n) ?? "";
    else if (n !== "" && !unset.includes(n)) unset.push(n);
  };

  for (const c of input) {
    if (expectingEnd) {
      if (c === " " || c === "\t") continue;
      if (c === "#") break;
      throw "the value has a space in it; quote it";
    } else if (escaped) {
      if (c === "\\" || c === "'" || c === '"' || c === "$" || c === " ") out += c;
      else if (c === "n") out += "\n";
      else throw "the value has a \\ escape .env doesn't support";
      escaped = false;
    } else if (strong) {
      if (c === "'") strong = false;
      else out += c;
    } else if (sub !== "None") {
      if (isAlphanumeric(c)) {
        name += c;
      } else if (sub === "Block") {
        if (c === "{" && name === "") {
          sub = "Braced";
        } else {
          fill();
          if (c === "$") {
            sub = "Block";
          } else {
            sub = "None";
            out += c;
          }
        }
      } else if (c === "}") {
        sub = "None";
        fill();
      } else {
        name += c;
      }
    } else if (c === "$") {
      sub = "Block";
    } else if (weak) {
      if (c === '"') weak = false;
      else if (c === "\\") escaped = true;
      else out += c;
    } else if (c === "'") {
      strong = true;
    } else if (c === '"') {
      weak = true;
    } else if (c === "\\") {
      escaped = true;
    } else if (c === " " || c === "\t") {
      expectingEnd = true;
    } else {
      out += c;
    }
  }
  if (sub === "Braced") throw "a ${ is never closed";
  if (strong || weak) throw "a quote is never closed";
  fill();
  return [out, unset];
}
