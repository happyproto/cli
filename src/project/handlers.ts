// hpy-project/src/handlers.rs: handlers for a project's queries and procedures: which lexicons
// have none, and the starter `hpy happyview scaffold` writes beside one.
//
// HappyView answers a query lexicon that has no handler only for `?uri=`, and refuses
// everything else with `501 MethodNotImplemented`; a procedure with none is refused outright.
// Neither is told which collection it serves, so a handler names its collection itself.
// Type mapping as in ./config.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { toIoError } from "../core/io.ts";
import {
  comparePaths,
  rustExtension,
  rustFileStem,
  rustJoin,
  rustParent,
  rustWithExtension,
} from "../core/paths.ts";
import { get, type Node, parseValue } from "../core/serde-json.ts";
import { asTableLike, DocumentMut } from "../core/toml-edit.ts";
import { Problem } from "../plugin/problem.ts";
import TEMPLATES from "./templates.json" with { type: "json" };

/** Stands in the templates for the collection a handler reads or writes. */
export const PLACEHOLDER = "COLLECTION";

/** The templates hpy-project embedded with `include_str!`, by file name (src/project/templates). */
export function templateText(name: keyof typeof TEMPLATES): string {
  return TEMPLATES[name];
}

export type LexiconKind = "query" | "procedure" | "record" | "other";

export const LexiconKind = {
  /** `LexiconKind::of`: the kind for a main def's `type`. */
  of(mainType: string): LexiconKind {
    return mainType === "query" || mainType === "procedure" || mainType === "record"
      ? mainType
      : "other";
  },
  /** Whether HappyView runs a handler for it. */
  isMethod(kind: LexiconKind): boolean {
    return kind === "query" || kind === "procedure";
  },
  label(kind: LexiconKind): string {
    return kind === "other" ? "lexicon" : kind;
  },
  /** The library a starter handler of this kind calls. */
  library(kind: LexiconKind): string | undefined {
    if (kind === "query") return "happyview.db";
    if (kind === "procedure") return "happyview.record";
    return undefined;
  },
  /** What a handler of this kind does with its collection, for prompts and the placeholder's comment. */
  verb(kind: LexiconKind): string {
    return kind === "procedure" ? "writes" : "reads";
  },
} as const;

export interface LexiconFields {
  nsid: string;
  kind: LexiconKind;
  /** Relative to the project root. */
  path: string;
  /** Whether its main def declares query parameters, so HappyView's types export a `Params` for it. */
  hasParams: boolean;
  /** Whether its main def declares an input schema, so the types export an `Input`. */
  hasInput: boolean;
}

/** One lexicon file under `src/`. */
export class Lexicon implements LexiconFields {
  nsid: string;
  kind: LexiconKind;
  path: string;
  hasParams: boolean;
  hasInput: boolean;

  constructor(fields: LexiconFields) {
    this.nsid = fields.nsid;
    this.kind = fields.kind;
    this.path = fields.path;
    this.hasParams = fields.hasParams;
    this.hasInput = fields.hasInput;
  }

  /** Reads a lexicon document; `undefined` for JSON that is not one. */
  static parse(path: string, text: string): Lexicon | undefined {
    let doc: Node;
    try {
      doc = parseValue(text);
    } catch {
      return undefined;
    }
    const id = get(doc, "id");
    if (id?.kind !== "string") return undefined;
    const defs = get(doc, "defs");
    const main = defs && get(defs, "main");
    if (main === undefined) return undefined;
    const type = get(main, "type");
    if (type?.kind !== "string") return undefined;
    // As HappyView decides (src/project/declarations/lexicon.rs): a `parameters` block, even an
    // empty one, exports `Params`. `Input` is imported only for a schema, though any `input`
    // exports one, since only a schema's types fit a record.
    const input = get(main, "input");
    return new Lexicon({
      nsid: id.value,
      kind: LexiconKind.of(type.value),
      path,
      hasParams: get(main, "parameters") !== undefined,
      hasInput: input !== undefined && get(input, "schema") !== undefined,
    });
  }

  /** The file beside it, with its basename, that a handler with `extension` would be. */
  handlerPath(extension: string): string {
    return rustWithExtension(this.path, extension);
  }

  /**
   * A handler already beside it, in any language: a file sharing its basename with any
   * extension but `.json`.
   */
  existingHandler(root: string): string | undefined {
    const stem = rustFileStem(this.path);
    if (stem === undefined) return undefined;
    const dir = rustParent(this.path) ?? "";
    let names: string[];
    try {
      names = readdirSync(rustJoin(root, dir));
    } catch {
      return undefined;
    }
    const found = names
      .filter((name) => {
        const p = rustJoin(root, dir, name);
        const ext = rustExtension(p);
        return rustFileStem(p) === stem && ext !== undefined && ext !== "json" && !isDir(p);
      })
      .map((name) => rustJoin(dir, name))
      .sort(comparePaths);
    return found[0];
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `scan`: every lexicon under `root/src`, in path order. JSON that is not a lexicon is passed
 * over: `happyview check` is what reports a broken one. Throws `Problem`.
 */
export function scan(root: string): Lexicon[] {
  const out: Lexicon[] = [];
  const src = rustJoin(root, "src");
  if (isDir(src)) walk(src, "src", out);
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

/** `walk`, carrying each path relative to the root beside it (Rust strips the root's prefix). */
function walk(dir: string, rel: string, out: Lexicon[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    throw new Problem(rel, `reading it: ${toIoError(e).message}`);
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = rustJoin(dir, name);
    const relPath = rustJoin(rel, name);
    if (isDir(path)) {
      walk(path, relPath, out);
    } else if (rustExtension(path) === "json") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          readFileSync(path),
        );
      } catch {
        continue;
      }
      const lexicon = Lexicon.parse(relPath, text);
      if (lexicon !== undefined) out.push(lexicon);
    }
  }
}

/**
 * `first_interpreter`: the first `[interpreters]` key in `happyview.toml` as written, which is
 * the language `scaffold` writes handlers in.
 */
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

/** The extension of a handler in `language`, when hpy has a template in it. */
export function handlerExtension(language: string): string | undefined {
  switch (language) {
    case "lua":
      return "lua";
    case "typescript":
      return "ts";
    case "javascript":
      return "js";
    default:
      return undefined;
  }
}

const EXTENSIONS: Record<string, string> = { lua: "lua", typescript: "ts", javascript: "js" };

function template(language: string, kind: LexiconKind): string | undefined {
  const ext = EXTENSIONS[language];
  if (ext === undefined || (kind !== "query" && kind !== "procedure")) return undefined;
  return templateText(`${kind}.${ext}` as keyof typeof TEMPLATES);
}

/**
 * `input_type`: the lexicon type a TypeScript or JavaScript handler's input is declared as, and
 * the import TypeScript needs for it. HappyView's types export `Params` and `Input` only for a
 * lexicon that declares them, so one that does not gets a plain type instead.
 */
function inputType(language: string, lexicon: Lexicon): [string, string] {
  const module = `happyview:lexicons/${lexicon.nsid}`;
  const [name, declared, fallback] =
    lexicon.kind === "query"
      ? ["Params", lexicon.hasParams, "Query"]
      : ["Input", lexicon.hasInput, "{ [key: string]: unknown }"];
  // A query's handler reads `uri`, `did`, `limit` and `cursor` whatever the lexicon declares,
  // so its input is the lexicon's params and those.
  const extra = lexicon.kind === "query" ? " & Query" : "";
  if (!declared) return ["", fallback];
  if (language === "typescript") {
    return [`import type { ${name} } from "${module}";\n`, `${name}${extra}`];
  }
  return ["", `import("${module}").${name}${extra}`];
}

/** `str::replace`: every occurrence, with no `$` patterns in the replacement. */
const replaceAll = (s: string, from: string, to: string) => s.split(from).join(to);

/** `char::is_whitespace`: Unicode `White_Space`. */
const LEADING_WHITESPACE = /^\p{White_Space}*/u;

/**
 * `render_handler`: a starter handler for `lexicon` in `language`, naming `collection`, or the
 * placeholder under a comment saying to replace it when there is none.
 */
export function renderHandler(
  language: string,
  lexicon: Lexicon,
  collection: string | undefined,
): string | undefined {
  const raw = template(language, lexicon.kind);
  if (raw === undefined) return undefined;
  const [imports, input] = inputType(language, lexicon);
  const body = replaceAll(replaceAll(raw, "LEXICON_IMPORT", imports), "INPUT_TYPE", input);
  const quoted = `"${PLACEHOLDER}"`;
  if (collection !== undefined) return replaceAll(body, quoted, `"${collection}"`);
  const comment = language === "lua" ? "--" : "//";
  let out = "";
  for (const line of body.split(/(?<=\n)/)) {
    if (line.includes(quoted)) {
      const indent = LEADING_WHITESPACE.exec(line)![0];
      out += `${indent}${comment} TODO: name the collection this ${LexiconKind.verb(lexicon.kind)}\n`;
    }
    out += line;
  }
  return out;
}

/**
 * `check_nsid`: an NSID as atproto writes one: at least three dot-separated segments, the
 * domain ones letters, digits and `-`, the last letters and digits. Throws the reason as a
 * string, as the Rust `Result<(), String>` returns it.
 */
export function checkNsid(s: string): void {
  const bad = `\`${s}\` is not an NSID, such as com.example.note`;
  const parts = s.split(".");
  if (Buffer.byteLength(s) > 317 || parts.length < 3) throw bad;
  const name = parts.at(-1)!;
  const domain = parts.slice(0, -1);
  const domainOk = domain.every(
    (p) =>
      p !== "" &&
      Buffer.byteLength(p) <= 63 &&
      /^[A-Za-z0-9-]*$/.test(p) &&
      !p.startsWith("-") &&
      !p.endsWith("-"),
  );
  const nameOk = Buffer.byteLength(name) <= 63 && /^[A-Za-z][A-Za-z0-9]*$/.test(name);
  if (!(domainOk && nameOk)) throw bad;
}
