// commands/happyview/pull/map.rs: where each thing an instance holds goes in a project, decided
// from the thing alone: no network, no disk.
import { lines, trim, trimStart } from "../../core/rust-str.ts";
import type { LexiconSettings, ScriptSettings } from "../../project/scaffold.ts";

/** What a script handles, as the codemod's `--kind` names it. */
export type Kind = "query" | "procedure" | "record" | "job" | "label";

/** A trigger id split into what it fires on. */
export interface Trigger {
  kind: Kind;
  /** `create`, `update`, `delete` or `index` for a record trigger. */
  event: string | undefined;
  /** The NSID, job type or `_actor` after the colon. */
  target: string;
}

/** The lexicon a trigger needs on the instance, for the kinds that have one. */
export function triggerLexicon(t: Trigger): string | undefined {
  return t.kind === "job" || t.kind === "label" ? undefined : t.target;
}

const PREFIXES: Record<string, [Kind, string | undefined]> = {
  "xrpc.query": ["query", undefined],
  "xrpc.procedure": ["procedure", undefined],
  "record.create": ["record", "create"],
  "record.update": ["record", "update"],
  "record.delete": ["record", "delete"],
  "record.index": ["record", "index"],
  "job.run": ["job", undefined],
  "labeler.apply": ["label", undefined],
};

/** The prefixes HappyView's `ParsedTrigger::parse` takes, in v2 and v3 alike. */
export function parseTrigger(id: string): Trigger | undefined {
  const i = id.indexOf(":");
  if (i < 0) return undefined;
  const found = Object.hasOwn(PREFIXES, id.slice(0, i)) ? PREFIXES[id.slice(0, i)] : undefined;
  if (!found) return undefined;
  return { kind: found[0], event: found[1], target: id.slice(i + 1) };
}

/**
 * An NSID that can be a path under `src/lexicons/`: dot-separated segments of letters, digits
 * and `-`, nothing that could climb out.
 */
function nsidOk(nsid: string): boolean {
  const parts = nsid.split(".");
  return parts.length >= 3 && parts.every((s) => /^[A-Za-z0-9-]+$/.test(s));
}

/** A whole file name under `src/jobs/` or `src/labels/`. */
function nameOk(name: string): boolean {
  return (
    name !== "" && !name.startsWith(".") && !name.includes("..") && /^[A-Za-z0-9._-]+$/.test(name)
  );
}

/** `src/lexicons/com/example/hello.json` for `com.example.hello`; throws the reason as a string. */
export function lexiconPath(nsid: string): string {
  if (!nsidOk(nsid)) throw `\`${nsid}\` is not an NSID a file can be named by`;
  return `src/lexicons/${nsid.replaceAll(".", "/")}.json`;
}

/** `trim_end_matches(".json")`. */
const stripJson = (p: string) => {
  let s = p;
  while (s.endsWith(".json")) s = s.slice(0, -5);
  return s;
};

/**
 * Where a trigger's handler goes, as HappyView's `project/layout.rs` reads it back. Throws the
 * reason as a string.
 */
export function handlerPath(t: Trigger, ext: string): string {
  switch (t.kind) {
    case "query":
    case "procedure":
      return `${stripJson(lexiconPath(t.target))}.${ext}`;
    case "record":
      if (t.event === undefined) throw "a record trigger without its event";
      return `${stripJson(lexiconPath(t.target))}.${t.event}.${ext}`;
    case "job":
    case "label": {
      if (!nameOk(t.target)) throw `\`${t.target}\` cannot be a file name`;
      return `src/${t.kind === "job" ? "jobs" : "labels"}/${t.target}.${ext}`;
    }
  }
}

/** A path the instance gave, if it is one a project can hold: relative, under `src/`, with nothing that climbs out. */
export function safeSrcPath(given: string): string | undefined {
  const path = given.replaceAll("\\", "/");
  const ok =
    path.startsWith("src/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  return ok ? path : undefined;
}

/** `[a-z0-9][a-z0-9_-]*`. */
const plainExtension = (ext: string) => /^[a-z0-9][a-z0-9_-]*$/.test(ext);

/**
 * The extension a language's files take: the one its interpreter claims first, else the usual
 * one, else (`false`) the language id itself. Undefined when that isn't a plain extension:
 * both the claim and the id come from the instance, and either ends up in a file name.
 */
export function extension(
  language: string,
  claimed: ReadonlyMap<string, string>,
): [string, boolean] | undefined {
  let found: [string, boolean];
  const c = claimed.get(language);
  if (c !== undefined) found = [c, true];
  else if (language === "lua") found = ["lua", true];
  else if (language === "typescript") found = ["ts", true];
  else if (language === "javascript") found = ["js", true];
  else found = [language, false];
  return plainExtension(found[0]) ? found : undefined;
}

/**
 * A project-relative path the instance gave, if a project can hold it: relative, with no empty,
 * `.` or `..` part. Unlike `safeSrcPath` it needn't be under `src/` (a compiled module's crate
 * isn't).
 */
export function safeRelPath(given: string): string | undefined {
  const path = given.replaceAll("\\", "/");
  const ok =
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes(":") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  return ok ? path : undefined;
}

/**
 * `[lexicons."<nsid>"]` with only what differs from a project lexicon's defaults: no backfill,
 * no token cost, indexed (`project/lexicons.rs`). Backfill and indexing are about a collection,
 * so they are kept only for a record lexicon (or one whose type the instance didn't say): v2
 * sets backfill on every lexicon it stores.
 */
export function lexiconSettings(
  lexiconType: string | undefined,
  backfill: boolean,
  tokenCost: number | bigint | undefined,
  indexed: boolean | undefined,
): LexiconSettings {
  const collection = lexiconType === undefined || lexiconType === "record";
  return {
    backfill: collection && backfill ? true : undefined,
    tokenCost,
    indexed: indexed !== undefined && collection && !indexed ? indexed : undefined,
  };
}

/** `.env.example`: each script variable's key with no value. Values never leave the instance. */
export function envExample(keys: readonly string[]): string {
  let out =
    "# The script variables the instance has. `hpy happyview pull` copies\n# their names, never their values: copy this file to .env and fill them in.\n";
  for (const key of keys) out += `${key}=\n`;
  return out;
}

// Rust's regex `\s` is Unicode White_Space.
const XRPC_CALL =
  /xrpc\.(?:query|procedure)\(\p{White_Space}*["']([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)["']/gu;
const LINE_COMMENT = /^\p{White_Space}*--/u;
const BLOCK_COMMENT = /--\[\[[\s\S]*?\]\]/gu;

/**
 * The XRPC methods a script calls, as HappyView derives them when nothing overrides them
 * (`lua_analysis::extract_outbound_xrpcs`, copied exactly), so a list that only repeats it is
 * left out of `happyview.toml`.
 */
export function derivedOutbound(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stripped = source.replace(BLOCK_COMMENT, "");
  for (const line of lines(stripped)) {
    if (LINE_COMMENT.test(line)) continue;
    for (const cap of line.matchAll(XRPC_CALL)) {
      const method = cap[1] as string;
      if (!seen.has(method)) {
        seen.add(method);
        out.push(method);
      }
    }
  }
  return out;
}

/** `trim_start_matches(chars)`. */
function trimStartMatches(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i] as string)) i++;
  return s.slice(i);
}

function lineComments(text: string): string[] {
  const out: string[] = [];
  for (const raw of lines(text)) {
    const line = trimStart(raw);
    const rest = line.startsWith("--") || line.startsWith("//") ? line.slice(2) : undefined;
    if (rest === undefined) break;
    out.push(trim(trimStartMatches(rest, "-/!")));
  }
  return out;
}

/**
 * The first paragraph of the comment a file opens with, which HappyView reads as its
 * description (`project/describe.rs`, `leading_description`).
 */
export function leadingDescription(source: string): string | undefined {
  let text = source;
  if (text.startsWith("#!")) {
    const i = text.indexOf("\n");
    text = i < 0 ? "" : text.slice(i + 1);
  }
  text = trimStart(text);
  const blockLine = (l: string) => trim(trimStartMatches(trim(l), "*"));
  let ls: string[];
  if (text.startsWith("--[")) {
    const rest = text.slice(3);
    const level = rest.length - trimStartMatches(rest, "=").length;
    const after = rest.slice(level);
    if (after.startsWith("[")) {
      const body0 = after.slice(1);
      const close = `]${"=".repeat(level)}]`;
      const j = body0.indexOf(close);
      ls = lines(j < 0 ? body0 : body0.slice(0, j)).map(blockLine);
    } else {
      ls = lineComments(text);
    }
  } else if (text.startsWith("/*")) {
    const rest = text.slice(2);
    const j = rest.indexOf("*/");
    ls = lines(j < 0 ? rest : rest.slice(0, j)).map(blockLine);
  } else {
    ls = lineComments(text);
  }
  const trimmed = ls.map(trim);
  let start = 0;
  while (start < trimmed.length && trimmed[start] === "") start++;
  const paragraph: string[] = [];
  for (let i = start; i < trimmed.length && trimmed[i] !== ""; i++)
    paragraph.push(trimmed[i] as string);
  return paragraph.length ? paragraph.join(" ") : undefined;
}

/**
 * `[scripts."<trigger>"]` with only what the body doesn't already say: a description other
 * than its leading comment's, and calls other than the ones HappyView finds in it. `outbound`
 * is undefined for a script the codemod rewrote, whose v2 list was derived from a body that no
 * longer exists.
 */
export function scriptSettings(
  body: string,
  description: string | undefined,
  outbound: readonly string[] | undefined,
): ScriptSettings {
  let d = description === undefined ? undefined : trim(description);
  if (d === "" || (d !== undefined && leadingDescription(body) === d)) d = undefined;
  let o: string[] | undefined;
  if (outbound !== undefined && outbound.length > 0) {
    const derived = derivedOutbound(body);
    const same = derived.length === outbound.length && derived.every((x, i) => x === outbound[i]);
    if (!same) o = [...outbound];
  }
  return { description: d, outboundXrpcs: o };
}

const HAPPYVIEW_REQUIRE =
  /require\p{White_Space}*\(?\p{White_Space}*["'](happyview\.[A-Za-z0-9_.]+)["']/gu;

/** The `happyview.*` libraries a script requires, which v3 provides as library plugins under those namespaces; sorted. */
export function happyviewRequires(source: string): string[] {
  const found = new Set<string>();
  for (const c of source.matchAll(HAPPYVIEW_REQUIRE)) found.add(c[1] as string);
  return [...found].sort();
}

/** A rewrite the codemod left a `-- codemod:` marker in, for a person to finish. */
export function hasCodemodMarker(source: string): boolean {
  return lines(source).some((l) => trimStart(l).startsWith("-- codemod:"));
}

/** The directory `pull` creates when none is named: the instance's host. */
export function defaultDir(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "happyview-project";
  }
  let h = host;
  while (h.startsWith("[")) h = h.slice(1);
  while (h.endsWith("]")) h = h.slice(0, -1);
  h = h.replaceAll(":", "-");
  return h === "" ? "happyview-project" : h;
}
