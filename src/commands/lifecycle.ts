// crates/hpy/src/commands/lifecycle.rs: `software.release.status` records, what a publisher
// says about a version's or the whole project's future, and the withdrawal of one said in error.
import type { Registry } from "../atproto/registry.ts";
import { type Repo, rkeyOf } from "../atproto/repo.ts";
import { missingRepoScopes } from "../atproto/scope.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import type { Json } from "../core/output.ts";
import { STATUS_NSID } from "../plugin/nsid.ts";
import { projectUri, versionProblem, versionUri } from "../plugin/validate.ts";
import { resolveName } from "./profile.ts";

/**
 * The ECMA-428 events the registry acts on. `withdrawn` is reached through `--withdraw`, since
 * it needs the status it cancels rather than a subject.
 */
export const EVENTS = [
  "endOfDevelopment",
  "endOfSupport",
  "supersededBy",
  "endOfDistribution",
  "endOfLife",
] as const;

/** What a status is about: the project, or one version. */
export type Subject = { project: true } | { version: string };

export interface Details {
  kind?: string | undefined;
  reason?: string | undefined;
  supersededBy?: string | undefined;
}

type Input = { [k: string]: Json };

/** The `putStatus` input for `event` against `subject`. */
export function statusInput(
  did: string,
  name: string,
  subject: Subject,
  event: string,
  details: Details,
): Input {
  if (event === "withdrawn") {
    throw Failure.usage("to withdraw a status, pass --withdraw <status at-uri>");
  }
  if (!(EVENTS as readonly string[]).includes(event)) {
    throw Failure.usage(`\`${event}\` is not a lifecycle event; use one of ${EVENTS.join(", ")}`);
  }
  let uri: string;
  if ("project" in subject) {
    uri = projectUri(did, name);
  } else {
    const p = versionProblem(subject.version);
    if (p !== null) throw Failure.usage(`version: ${p}`);
    uri = versionUri(did, name, subject.version);
  }
  const input: Input = { subject: uri, status: event };
  const by = details.supersededBy;
  if (event === "supersededBy") {
    if (by === undefined) {
      throw Failure.usage("supersededBy needs --superseded-by <version>, the version to move to");
    }
    const p = versionProblem(by);
    if (p !== null) throw Failure.usage(`--superseded-by: ${p}`);
    input.supersededBy = by;
  } else if (by !== undefined) {
    throw Failure.usage("--superseded-by goes only with the supersededBy event");
  }
  if (details.kind !== undefined) input.kind = details.kind;
  if (details.reason !== undefined) input.reason = details.reason;
  return input;
}

/**
 * The `putStatus` input that cancels the status at `uri`, about the same subject. The status
 * has to be the signed-in user's own.
 */
export async function withdrawInput(
  repo: Repo,
  uri: string,
  reason: string | undefined,
): Promise<Input> {
  let ours = false;
  if (uri.startsWith("at://")) {
    const rest = uri.slice(5);
    const i = rest.indexOf("/");
    if (i !== -1) {
      ours = rest.slice(0, i) === repo.did() && rest.slice(i + 1).startsWith(`${STATUS_NSID}/`);
    }
  }
  if (!ours) {
    throw Failure.usage(`--withdraw: \`${uri}\` is not one of your ${STATUS_NSID} records`);
  }
  let record: Awaited<ReturnType<Repo["getRecord"]>>;
  try {
    record = await repo.getRecord(STATUS_NSID, rkeyOf(uri));
  } catch (e) {
    throw Failure.from(e);
  }
  if (record === null) throw Failure.usage(`--withdraw: no status at ${uri}`);
  const v = record.value;
  const subject = v !== null && typeof v === "object" && !Array.isArray(v) ? v.subject : undefined;
  if (typeof subject !== "string") {
    throw Failure.runtime(`the status at ${uri} names no subject`);
  }
  const input: Input = { subject, status: "withdrawn", withdraws: uri };
  if (reason !== undefined) input.reason = reason;
  return input;
}

/** Refuses a session that cannot write status records, before asking the gateway to write one. */
export function checkGrant(repo: Repo): void {
  const granted = repo.grantedScopes();
  if (granted === null) return;
  if (missingRepoScopes(granted, [STATUS_NSID]).length === 0) return;
  throw Failure.usage(
    `recording a lifecycle event needs \`repo:${STATUS_NSID}\`, which this sign-in was not granted; run \`hpy registry login\` to sign in again`,
  );
}

export async function put(registry: Registry, input: Json): Promise<Json> {
  try {
    const written = await registry.putStatus(input);
    return { uri: written.uri, cid: written.cid };
  } catch (e) {
    throw Failure.from(e);
  }
}

const opt = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const session = await ctx.session();
  checkGrant(session.repo);
  const details: Details = {
    kind: opt(args.kind),
    reason: opt(args.reason),
    supersededBy: opt(args.supersededBy),
  };
  const withdraw = opt(args.withdraw);
  const project = !!args.project;
  const target = opt(args.VERSION);
  const event = opt(args.EVENT);
  let input: Input;
  if (withdraw !== undefined) {
    if (project || target !== undefined || event !== undefined) {
      throw Failure.usage("--withdraw takes the status to withdraw and nothing else");
    }
    input = await withdrawInput(session.repo, withdraw, details.reason);
  } else if (project && target !== undefined && event === undefined) {
    const name = resolveName(ctx.dir, opt(args.name));
    input = statusInput(session.repo.did(), name, { project: true }, target, details);
  } else if (!project && target !== undefined && event !== undefined) {
    const name = resolveName(ctx.dir, opt(args.name));
    input = statusInput(session.repo.did(), name, { version: target }, event, details);
  } else if (project) {
    throw Failure.usage("usage: hpy registry plugin lifecycle --project <EVENT>");
  } else {
    throw Failure.usage(
      "usage: hpy registry plugin lifecycle <VERSION> <EVENT>, or --project <EVENT>",
    );
  }
  if (
    !(await ctx.prompter.confirm(`Record \`${input.status}\` for ${input.subject}?`, !!args.yes))
  ) {
    throw Failure.runtime("cancelled");
  }
  const out = await put(session.registry(), input);
  const uri = (out as { uri: string }).uri;
  ctx.out.done(`Recorded ${uri}`, out);
}
