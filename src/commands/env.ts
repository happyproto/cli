// commands/happyview/env.rs: `hpy hv env push`: the project's `.env` to the deployed
// instance's script variables, one key at a time.
//
// A value is a secret. It is read from the file and goes out in the body of the request that
// sets it, and nowhere else: not in a prompt, a line of output, `--json` or an error. Keys are
// only ever read from the file, never from the process environment.
import type { Admin } from "../atproto/admin.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { readToString } from "../core/io.ts";
import type { Json } from "../core/output.ts";
import { rustJoin } from "../core/paths.ts";
import { projectRoot } from "../project/prepare.ts";
import type { Entry } from "./env/dotenv.ts";
import * as dotenv from "./env/dotenv.ts";
import * as instance from "./instance.ts";

/** What the instance has under a key. */
export type Existing = { kind: "new" } | { kind: "replaces"; unreadable: boolean };

const label = (e: Existing) => (e.kind === "new" ? "new" : "replaces existing");
const jsonStatus = (e: Existing) => (e.kind === "new" ? "new" : "replace");

/** A key to send, and what it would do on the instance. */
export interface Planned {
  entry: Entry;
  existing: Existing;
}

/** The question asked before a key is sent; the prompt adds `(y/N)`. */
export function question(p: Planned): string {
  const key = p.entry.key;
  if (p.existing.kind === "replaces" && p.existing.unreadable)
    return `send ${key} (replaces existing, whose value the instance can't read)?`;
  return `send ${key} (${label(p.existing)})?`;
}

/**
 * `text` with `secret` taken out, for an instance's answer that quotes what it was sent. A
 * value too short to be a secret could match by chance, and taking it out would only garble
 * the message.
 */
export function redact(text: string, secret: string): string {
  if ([...secret].length < 4) return text;
  return text.split(secret).join("[value hidden]");
}

/** Where the keys are read from: `--env-file`, else `.env` in the project. */
function envFile(ctx: Ctx, given: string | undefined): string {
  if (given !== undefined) return rustJoin(ctx.dir, given);
  return rustJoin(projectRoot(ctx), ".env");
}

/** The file's entries, the last of each key winning as it does in HappyView. */
function readEntries(path: string): Entry[] {
  let text: string;
  try {
    text = readToString(path);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT")
      throw Failure.usage(
        `there is no ${path}; write the keys to send there, or name another file with --env-file`,
      );
    throw Failure.runtime(`could not read ${path}: ${(e as Error).message}`);
  }
  let entries: Entry[];
  try {
    entries = dotenv.parse(text);
  } catch (e) {
    if (!(e instanceof dotenv.BadLines)) throw e;
    const lines = e.bad.map((b) => `  ${path}:${b.line}: ${b.why}`);
    throw Failure.usage(
      `${path} has lines HappyView can't read, so nothing was sent:\n${lines.join("\n")}`,
    );
  }
  const last = new Map<string, number>();
  for (const [i, e] of entries.entries()) last.set(e.key, i);
  return entries.filter((e, i) => last.get(e.key) === i);
}

/** The entries to send: every one, or the ones `named`, in the order named. */
export function select(entries: Entry[], named: string[], path: string): number[] {
  if (named.length === 0) return entries.map((_, i) => i);
  const chosen: number[] = [];
  const missing: string[] = [];
  for (const key of named) {
    if (!dotenv.validKey(key)) throw Failure.usage(`\`${key}\` is not a key: ${dotenv.KEY_RULE}`);
    const i = entries.findIndex((e) => e.key === key);
    if (i < 0) missing.push(key);
    else if (!chosen.includes(i)) chosen.push(i);
  }
  if (missing.length)
    throw Failure.usage(`${path} doesn't set ${missing.join(", ")}, so nothing was sent`);
  return chosen;
}

/** What became of each key. */
export interface Outcome {
  sent: string[];
  skipped: string[];
  /** Each with the instance's answer, values taken out. */
  failed: [string, string][];
}

/**
 * Asks `decide` about each key in turn and sends the ones it accepts, reporting a line for
 * each through `say`. A failed send is recorded and the rest go on.
 */
export async function sendEach(
  admin: Admin,
  plan: Planned[],
  decide: (p: Planned) => Promise<boolean>,
  say: (line: string) => void,
): Promise<Outcome> {
  const out: Outcome = { sent: [], skipped: [], failed: [] };
  for (const p of plan) {
    const key = p.entry.key;
    if (!(await decide(p))) {
      say(`skipped ${key}`);
      out.skipped.push(key);
      continue;
    }
    try {
      await admin.setScriptVariable(key, p.entry.value);
      say(`sent ${key}`);
      out.sent.push(key);
    } catch (e) {
      const why = redact((e as Error).message, p.entry.value);
      say(`failed ${key}: ${why}`);
      out.failed.push([key, why]);
    }
  }
  return out;
}

const count = (n: number) => (n === 1 ? "1 key" : `${n} keys`);

export async function push(ctx: Ctx, args: Args): Promise<void> {
  const dryRun = args.dryRun === true;
  const yes = args.yes === true;
  const path = envFile(ctx, args.envFile as string | undefined);
  const entries = readEntries(path);
  const chosen = select(entries, (args.KEY as string[] | undefined) ?? [], path);
  // Before anything is read from the instance, so a run that can't ask touches nothing.
  if (!dryRun && !yes && !ctx.prompter.isInteractive())
    throw Failure.usage(
      "hpy asks before sending each key, and can't ask here (no terminal, or --no-input); pass --yes to send them without asking. Nothing was sent",
    );
  const admin = await instance.admin(ctx, args.url as string | undefined);
  const url = admin.base;
  const file = path;
  if (chosen.length === 0) {
    ctx.out.done(`${file} sets no keys; nothing to send`, {
      instance: url,
      file,
      dryRun,
      keys: [],
    });
    return;
  }

  let listed: { key: string; unreadable: boolean }[];
  try {
    listed = await admin.scriptVariables();
  } catch (e) {
    throw Failure.from(e);
  }
  // BTreeMap::from_iter: the last of a repeated key wins.
  const existing = new Map(listed.map((v) => [v.key, v.unreadable] as const));
  const plan: Planned[] = chosen.map((i) => {
    const entry = entries[i] as Entry;
    const unreadable = existing.get(entry.key);
    return {
      entry,
      existing: unreadable === undefined ? { kind: "new" } : { kind: "replaces", unreadable },
    };
  });
  for (const p of plan) {
    if (p.entry.unset.length) {
      const names = p.entry.unset.map((n) => `$${n}`);
      ctx.out.status(
        `warning: ${file}:${p.entry.line}: ${p.entry.key}'s value uses ${names.join(", ")}, which no line above it sets; hpy fills it with nothing and never reads your shell's`,
      );
    }
  }

  if (dryRun) {
    ctx.out.status(`Would send to ${url}, from ${file}:`);
    for (const p of plan) ctx.out.status(`  ${label(p.existing)} ${p.entry.key}`);
    ctx.out.status(
      'The instance shows values masked, so whether a value would change can\'t be known: "replaces existing" may resend the value it already has.',
    );
    const keys: Json[] = plan.map((p) => ({ key: p.entry.key, status: jsonStatus(p.existing) }));
    ctx.out.done("Dry run: nothing was sent.", { instance: url, file, dryRun: true, keys });
    return;
  }

  ctx.out.status(`Sending to ${url}, from ${file}`);
  const outcome = await sendEach(
    admin,
    plan,
    (p) => ctx.prompter.confirm(question(p), yes),
    (line) => ctx.out.status(line),
  );

  const summary = `Sent ${count(outcome.sent.length)} to ${url}; skipped ${outcome.skipped.length}, failed ${outcome.failed.length}`;
  ctx.out.done(summary, {
    instance: url,
    file,
    dryRun: false,
    sent: outcome.sent,
    skipped: outcome.skipped,
    failed: outcome.failed.map(([key, error]) => ({ key, error })),
  });
  if (outcome.failed.length) {
    const keys = outcome.failed.map(([k]) => k);
    throw Failure.runtime(`${count(keys.length)} not sent: ${keys.join(", ")}`);
  }
}
