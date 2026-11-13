// crates/hpy/src/commands/happyview/scaffold.rs: `hpy happyview scaffold`, a starter handler
// beside each query or procedure lexicon that has none, naming the collection it serves, since
// HappyView no longer infers one. `check` and `pull` use `hint` and `missingHandlerWarnings`.
import { closeSync, openSync, writeSync } from "node:fs";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { readToString, toIoError } from "../core/io.ts";
import type { Json } from "../core/output.ts";
import { rustComponents, rustJoin } from "../core/paths.ts";
import { cacheRoot } from "../project/cache.ts";
import { CONFIG_FILE, ProjectToml } from "../project/config.ts";
import {
  checkNsid,
  firstInterpreter,
  handlerExtension,
  type Lexicon,
  LexiconKind,
  renderHandler,
  scan,
} from "../project/handlers.ts";
import { chooseWithPrompter, projectRoot } from "../project/prepare.ts";
import { type Addition, addedLine, addIn, additionToJson } from "./add.ts";

/** A project-relative path, `/`-separated whatever the platform. */
function shown(path: string): string {
  return rustComponents(path).join("/");
}

/** The command that writes a handler for `nsid`, for messages that point at it. */
export function hint(nsid: string): string {
  return `run \`hpy hv scaffold ${nsid}\``;
}

/**
 * One line per query or procedure lexicon under `root/src` with no handler beside it, for
 * `check` to warn with. A project it cannot read has none: HappyView's own check reports what
 * is wrong with it.
 */
export function missingHandlerWarnings(root: string): string[] {
  let lexicons: ReturnType<typeof scan>;
  try {
    lexicons = scan(root);
  } catch {
    return [];
  }
  return lexicons
    .filter((l) => LexiconKind.isMethod(l.kind) && l.existingHandler(root) === undefined)
    .map((l) => {
      const answer =
        l.kind === "query"
          ? "HappyView answers it only for ?uri="
          : "HappyView refuses every call to it";
      return `warning: ${LexiconKind.label(l.kind)} ${l.nsid} has no handler beside ${shown(l.path)}, so ${answer}; ${hint(l.nsid)}`;
    });
}

/** `check_nsid` as a prompt check: the reason, or `null`. */
function nsidCheck(s: string): string | null {
  try {
    checkNsid(s);
    return null;
  } catch (e) {
    return String(e);
  }
}

/**
 * The lexicons this run is about: every query and procedure, or the ones named, each of which
 * must be one. Throws `Failure`.
 */
export function targets(lexicons: readonly Lexicon[], nsids: readonly string[]): Lexicon[] {
  if (nsids.length === 0) return lexicons.filter((l) => LexiconKind.isMethod(l.kind));
  const out: Lexicon[] = [];
  for (const nsid of nsids) {
    const lexicon = lexicons.find((l) => l.nsid === nsid);
    if (lexicon === undefined) throw Failure.usage(`\`${nsid}\` is not a lexicon under src/`);
    if (!LexiconKind.isMethod(lexicon.kind)) {
      throw Failure.usage(
        `\`${nsid}\` is a ${LexiconKind.label(lexicon.kind)} lexicon (${shown(lexicon.path)}); only queries and procedures have handlers`,
      );
    }
    if (!out.some((l) => l.nsid === lexicon.nsid)) out.push(lexicon);
  }
  return out;
}

/**
 * The collection a handler names: `--collection`'s, else one chosen among the project's record
 * lexicons or typed, else none.
 */
async function collectionFor(
  ctx: Ctx,
  lexicon: Lexicon,
  given: string | undefined,
  records: readonly string[],
): Promise<string | undefined> {
  if (given !== undefined) return given;
  if (!ctx.prompter.isInteractive()) return undefined;
  const verb = LexiconKind.verb(lexicon.kind).replace(/s+$/, "");
  const label = `Which collection does ${lexicon.nsid} ${verb}?`;
  const typed = (label: string) =>
    ctx.prompter.required("--collection", label, undefined, undefined, nsidCheck);
  if (records.length === 0) return typed(label);
  const options = [...records, "Another collection…"];
  const i = await ctx.prompter.choose("--collection", label, options);
  if (i < records.length) return records[i];
  return typed("Collection NSID:");
}

/**
 * Writes `body` at `path` only if nothing is there, so a handler made since the scan is not
 * replaced either. Throws `Failure`.
 */
export function writeNewFile(path: string, body: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o666);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw Failure.runtime(`writing ${path}: ${toIoError(e).message}`);
  }
  try {
    const bytes = Buffer.from(body);
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off);
  } catch (e) {
    throw Failure.runtime(`writing ${path}: ${toIoError(e).message}`);
  } finally {
    closeSync(fd);
  }
  return true;
}

interface Written {
  nsid: string;
  path: string;
  kind: LexiconKind;
  collection: string | undefined;
}

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const nsids = (args.NSID as string[] | undefined) ?? [];
  const given = args.collection as string | undefined;
  const root = projectRoot(ctx);
  if (given !== undefined) {
    const problem = nsidCheck(given);
    if (problem !== null) throw Failure.usage(`--collection: ${problem}`);
  }
  let text: string;
  try {
    text = readToString(rustJoin(root, CONFIG_FILE));
  } catch (e) {
    throw Failure.runtime(e);
  }
  let config: ProjectToml;
  try {
    config = ProjectToml.parse(text);
  } catch (e) {
    throw Failure.from(e);
  }
  const language = firstInterpreter(text);
  if (language === undefined) {
    throw Failure.usage(
      `${CONFIG_FILE} has no [interpreters], so there is no language to write a handler in; add one with \`hpy hv add lua\``,
    );
  }
  const extension = handlerExtension(language);
  if (extension === undefined) {
    throw Failure.usage(
      `hpy has no handler template for \`${language}\`, the first of [interpreters] in ${CONFIG_FILE}`,
    );
  }
  let lexicons: Lexicon[];
  try {
    lexicons = scan(root);
  } catch (e) {
    throw Failure.from(e);
  }
  const chosen = targets(lexicons, nsids);
  const records = lexicons.filter((l) => l.kind === "record").map((l) => l.nsid);

  const written: Written[] = [];
  const skipped: [string, string][] = [];
  for (const lexicon of chosen) {
    const existing = lexicon.existingHandler(root);
    if (existing !== undefined) {
      skipped.push([lexicon.nsid, existing]);
      continue;
    }
    const collection = await collectionFor(ctx, lexicon, given, records);
    const body = renderHandler(language, lexicon, collection);
    if (body === undefined) throw new Error("a template for every language with an extension");
    const path = lexicon.handlerPath(extension);
    if (!writeNewFile(rustJoin(root, path), body)) {
      skipped.push([lexicon.nsid, path]);
      continue;
    }
    if (collection === undefined) {
      ctx.out.status(
        `warning: ${shown(path)} names no collection yet; replace COLLECTION in it with the NSID it ${LexiconKind.verb(lexicon.kind)}`,
      );
    }
    written.push({ nsid: lexicon.nsid, path, kind: lexicon.kind, collection });
  }

  // The libraries the written handlers call that the project lacks.
  let missing: string[] = [];
  for (const w of written) {
    const lib = LexiconKind.library(w.kind);
    if (lib !== undefined && !config.libraries.has(lib) && !missing.includes(lib)) {
      missing.push(lib);
    }
  }
  const command = `hpy hv add ${missing.join(" ")}`;
  let added: Addition[] = [];
  let declined = false;
  if (missing.length > 0) {
    const them = missing.length === 1 ? "it" : "them";
    const question = `The new handlers call ${missing.join(" and ")}, which ${CONFIG_FILE} doesn't declare. Add ${them}?`;
    const answer = await ctx.prompter.offer(question);
    if (answer === true) {
      const cache = cacheRoot();
      const registry = ctx.registry();
      const choose = chooseWithPrompter(ctx);
      const warn = (m: string) => ctx.out.status(`warning: ${m}`);
      const add = {
        plugins: [...missing],
        interpreter: false,
        library: true,
        channel: undefined,
        version: undefined,
        project: undefined,
      };
      [added] = await addIn(root, registry, cache, add, choose, warn);
      missing = [];
    } else if (answer === false) {
      declined = true;
    } else {
      ctx.out.status(
        `warning: the new handlers call ${missing.join(" and ")}, which ${CONFIG_FILE} doesn't declare; add ${them} with \`${command}\``,
      );
    }
  }

  const lines: string[] = [];
  for (const w of written) {
    const names =
      w.collection !== undefined
        ? `${LexiconKind.verb(w.kind)} ${w.collection}`
        : "collection still to name";
    lines.push(`wrote ${shown(w.path)} (${names})`);
  }
  for (const [nsid, path] of skipped) lines.push(`skipped ${nsid}: ${shown(path)} is its handler`);
  for (const a of added) lines.push(addedLine(a, true));
  // Without a terminal the warning above already gave the command.
  if (declined) lines.push(`not added: ${missing.join(", ")} (\`${command}\`)`);
  if (lines.length === 0) lines.push("no query or procedure lexicons under src/");
  const report: Json = {
    language,
    written: written.map((w) => ({
      nsid: w.nsid,
      path: shown(w.path),
      collection: w.collection ?? null,
    })),
    skipped: skipped.map(([nsid, path]) => ({ nsid, handler: shown(path) })),
    added: added.map(additionToJson),
    missing_libraries: missing,
  };
  ctx.out.done(lines.join("\n"), report);
}
