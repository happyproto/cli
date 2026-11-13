// commands/happyview/deploy.rs: `hpy hv deploy`, which makes an instance match the project:
// its plugins from happyview.lock, then its lexicons, scripts and modules.
import {
  type DeployedProject,
  deployEmpty,
  type ProjectDeploy,
  problemText,
} from "../atproto/admin.ts";
import { AtprotoError } from "../atproto/error.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import type { Json } from "../core/output.ts";
import { type Bundle, bundle } from "../project/bundle.ts";
import { ProjectToml } from "../project/config.ts";
import {
  type PluginPlan,
  type PluginStep,
  planPlugins,
  stepText,
  type Target,
} from "../project/deploy.ts";
import { LOCK_FILE, Lockfile } from "../project/lock.ts";
import { buildAll, Toolchain } from "../project/modules.ts";
import { projectRoot } from "../project/prepare.ts";
import * as instance from "./instance.ts";

/**
 * The lock as committed. A deploy installs exactly what it pins, so one that no longer matches
 * `happyview.toml` is refused, never re-resolved.
 */
function committedLock(ctx: Ctx): Lockfile {
  const root = projectRoot(ctx);
  let config: ProjectToml;
  let lock: Lockfile | null;
  try {
    config = ProjectToml.load(root);
    lock = Lockfile.load(root);
  } catch (e) {
    throw Failure.from(e);
  }
  if (!lock)
    throw Failure.usage(
      `there is no ${LOCK_FILE}; run \`hpy hv check\` to write it, and commit it`,
    );
  const drift = lock.drift(config);
  if (drift.length)
    throw Failure.usage(
      `${LOCK_FILE} does not match happyview.toml; run \`hpy hv add\` to update it:\n  ${drift.join("\n  ")}`,
    );
  return lock;
}

/** The target a step acts on, for the steps that grant capabilities. */
function target(step: PluginStep): Target | undefined {
  return step.kind === "remove" ? undefined : step.target;
}

/**
 * What a step grants, under it, so the capabilities are on screen before the prompt that
 * accepts them.
 *
 * A move or a replace also names the ones the installed version did not declare: that
 * difference is what an operator who already agreed to the old version is being asked to
 * agree to now. A fresh install names none of them separately, since every capability it
 * grants is new.
 */
export function capabilityLines(step: PluginStep): string[] {
  const t = target(step);
  if (!t) return [];
  const declared = t.capabilities ?? [];
  const lines = [
    declared.length === 0
      ? "      capabilities: none"
      : `      capabilities: ${declared.join(", ")}`,
  ];
  if (step.kind !== "install" && t.new_capabilities.length)
    lines.push(`      new: ${t.new_capabilities.join(", ")}`);
  return lines;
}

/**
 * A deploy accepts each plugin's capabilities on the operator's behalf, so a lock that does
 * not record them cannot be deployed: the set would have to come from whatever the registry
 * serves now, and holding it still is what the lock is for.
 */
export function capabilitiesRecorded(plan: PluginPlan): void {
  const missing = plan.steps
    .map(target)
    .filter((t): t is Target => t !== undefined && t.capabilities === undefined)
    .map((t) => t.id);
  if (missing.length === 0) return;
  throw Failure.usage(
    `${LOCK_FILE} records no capabilities for ${missing.join(", ")}, so this deploy cannot accept them for you. It was written by an hpy from before a deploy accepted them. To fix it, run:\n\n    hpy happyview check\n\nThat rewrites ${LOCK_FILE} without moving any version it pins; commit the change and deploy again`,
  );
}

function show(ctx: Ctx, plan: PluginPlan): void {
  if (plan.steps.length === 0) {
    ctx.out.status(`Plugins: up to date (${plan.unchanged.length} from ${LOCK_FILE})`);
  } else {
    const steps: string[] = [];
    for (const step of plan.steps) {
      steps.push(`  • ${stepText(step)}`);
      steps.push(...capabilityLines(step));
    }
    ctx.out.status(`Plugins:\n${steps.join("\n")}`);
  }
  if (plan.kept.length)
    ctx.out.status(
      `Kept, though ${LOCK_FILE} doesn't list them: ${plan.kept.join(", ")} (uninstall them with --prune-plugins)`,
    );
}

const labels = (steps: PluginStep[]) => steps.map(stepText);

/** A kind of change in the instance's answer, as one thing of that kind is called. */
function singular(kind: string): string {
  switch (kind) {
    case "lexicons":
      return "lexicon";
    case "scripts":
      return "script";
    case "modules":
      return "module";
    case "network_lexicons":
      return "network lexicon";
    case "labelers":
      return "labeler";
    default:
      return kind.replaceAll("_", " ");
  }
}

function showProject(ctx: Ctx, preview: ProjectDeploy): void {
  const lines: string[] = [];
  for (const [kind, changes] of Object.entries(preview.changes)) {
    const what = singular(kind);
    // A declaration dropped from happyview.toml leaves its row behind.
    const kept = kind === "network_lexicons" || kind === "labelers";
    lines.push(...changes.added.map((id) => `  + ${what} ${id}`));
    lines.push(...changes.changed.map((id) => `  ~ ${what} ${id}`));
    lines.push(
      ...changes.removed.map((id) =>
        kept
          ? `  - ${what} ${id} (no longer declared; kept as a dashboard row)`
          : `  - ${what} ${id}`,
      ),
    );
  }
  lines.push(...preview.backfills.map((nsid) => `  backfill ${nsid}, from the whole network`));
  if (lines.length === 0) ctx.out.status("Project: up to date");
  else ctx.out.status(`Project:\n${lines.join("\n")}`);
  for (const w of preview.warnings) ctx.out.status(`warning: ${problemText(w)}`);
}

function projectJson(p: ProjectDeploy): Json {
  const changes: { [k: string]: Json } = {};
  for (const [kind, c] of Object.entries(p.changes))
    changes[kind] = { added: c.added, changed: c.changed, removed: c.removed };
  return {
    sha256: p.sha256,
    deployedAt: p.deployed_at,
    changes,
    backfills: p.backfills,
    warnings: p.warnings.map(problemText),
  };
}

/** The project as it is sent: its compiled modules built first. */
async function projectBundle(ctx: Ctx): Promise<Bundle> {
  const root = projectRoot(ctx);
  const built = await buildAll(Toolchain.fromEnv(), root);
  return bundle(
    root,
    built.map(([name]) => name),
  );
}

const asFailure = (e: unknown) => Failure.from(e);

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const dryRun = args.dryRun === true;
  const lock = committedLock(ctx);
  const b = await projectBundle(ctx);
  try {
    await deploy(ctx, args, lock, b, dryRun);
  } catch (e) {
    throw asFailure(e);
  }
}

async function deploy(
  ctx: Ctx,
  args: Args,
  lock: Lockfile,
  b: Bundle,
  dryRun: boolean,
): Promise<void> {
  const admin = await instance.admin(ctx, args.url as string | undefined);
  const url = admin.base;
  const installed = await admin.plugins();
  const plan = planPlugins(lock.plugins, installed, args.prunePlugins === true);
  capabilitiesRecorded(plan);
  const deployed: DeployedProject | null = await admin.project();
  const seen = deployed?.sha256 ?? null;

  ctx.out.status(`Deploying to ${url}`);
  if (deployed && deployed.problems.length) {
    const problems = deployed.problems.map((p) => `  • ${problemText(p)}`);
    ctx.out.status(
      `warning: ${url} is serving no project: the one deployed there didn't build when it last started:\n${problems.join("\n")}`,
    );
  }
  show(ctx, plan);

  // The instance checks the project against the plugins it has now. A pending install may be
  // what the project needs, so with one pending a refusal waits for the deploy itself, after
  // the plugins.
  const pluginsPending = plan.steps.some((s) => s.kind !== "remove");
  let preview: ProjectDeploy | null;
  try {
    preview = await admin.deployProject(b.bytes, true, seen);
    showProject(ctx, preview);
  } catch (e) {
    if (!(pluginsPending && e instanceof AtprotoError && e.isUsage())) throw e;
    ctx.out.status(
      `Project: the instance can't check it until the plugins above are installed; it is checked again when deployed, after the plugins. As it stands:\n${e.message}`,
    );
    preview = null;
  }

  if (dryRun) {
    ctx.out.done("Dry run: nothing was changed.", {
      instance: url,
      dryRun: true,
      plugins: { planned: labels(plan.steps), unchanged: plan.unchanged, kept: plan.kept },
      project: preview ? projectJson(preview) : null,
    });
    return;
  }
  // Unchanged only when the instance already serves these exact bytes: an empty diff alone
  // may be a first deploy, or a change only to tests.
  const projectUnchanged = preview !== null && deployEmpty(preview) && seen === preview.sha256;
  if (plan.steps.length === 0 && projectUnchanged) {
    ctx.out.done(`${url} is up to date`, {
      instance: url,
      dryRun: false,
      plugins: { applied: [], unchanged: plan.unchanged, kept: plan.kept },
      project: preview ? projectJson(preview) : null,
    });
    return;
  }
  if (!(await ctx.prompter.confirm(`Apply these changes to ${url}?`, args.yes === true)))
    throw Failure.runtime("cancelled");

  const applied: PluginStep[] = [];
  const stopped = (e: unknown) => {
    const done = applied.length === 0 ? "nothing" : labels(applied).join(", ");
    const f = Failure.from(e);
    return new Failure(f.code, `${f.message}\nDone before it stopped: ${done}`, f.quiet);
  };
  for (const step of plan.steps) {
    try {
      switch (step.kind) {
        case "install":
        case "replace": {
          const t = step.target;
          await admin.install(t.did, t.name, t.version, t.capabilities ?? []);
          break;
        }
        case "move":
          await admin.reload(step.target.id, step.target.version, step.target.capabilities ?? []);
          break;
        case "remove":
          await admin.remove(step.id);
          break;
      }
    } catch (e) {
      throw stopped(e);
    }
    ctx.out.status(`  ✓ ${stepText(step)}`);
    applied.push(step);
  }
  let project: ProjectDeploy | null;
  if (projectUnchanged) {
    project = preview;
  } else {
    let done: ProjectDeploy;
    try {
      done = await admin.deployProject(b.bytes, false, seen);
    } catch (e) {
      throw stopped(e);
    }
    if (preview === null) showProject(ctx, done);
    const short = [...done.sha256].slice(0, 12).join("");
    ctx.out.status(`  ✓ project ${short}`);
    project = done;
  }
  ctx.out.done(`Deployed to ${url}`, {
    instance: url,
    dryRun: false,
    plugins: { applied: labels(applied), unchanged: plan.unchanged, kept: plan.kept },
    project: project ? projectJson(project) : null,
  });
}
