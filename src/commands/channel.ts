// crates/hpy/src/commands/channel.rs: `hpy channel [CHANNEL]`.
import * as channel from "../channel.ts";
import { type Channel, type Release, Version } from "../channel.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import * as update from "../update.ts";
import { install, staleReceipt } from "./update.ts";

/** What switching to a channel would install, and what to warn about first. */
export interface Plan {
  target: Version;
  warnings: string[];
}

export function plan(current: Version, to: Channel, releases: readonly Release[]): Plan {
  const target = channel.latestOn(to, releases);
  if (target === undefined) throw Failure.runtime(`no ${to} releases have been published yet`);
  const warnings: string[] = [];
  if (channel.isPrerelease(to))
    warnings.push(
      `The ${to} channel gets prereleases. They can be unstable: commands and their output may change or break from one release to the next.`,
    );
  if (Version.compare(target, current) < 0)
    warnings.push(
      `The newest ${to} release, ${target}, is older than the hpy you have (${current}). Switching installs the older version.`,
    );
  return { target, warnings };
}

function record(file: string, to: Channel): void {
  try {
    channel.write(file, to);
  } catch (e) {
    throw Failure.runtime(
      `could not save the channel to ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const file = update.channelFile(ctx.settings.configDir);
  const chosen = channel.read(file);
  const current = update.current();
  const from = channel.effective(chosen, current);
  const to = args.CHANNEL as Channel | undefined;

  if (to === undefined) {
    const how =
      chosen !== undefined
        ? "chosen with `hpy channel`"
        : "the channel this version of hpy came from";
    ctx.out.done(`${from} (${how})`, {
      channel: from,
      chosen: chosen !== undefined,
      version: current.toString(),
    });
    return;
  }

  if (to === from) {
    // Recorded anyway, so the choice outlives a reinstall from elsewhere.
    record(file, to);
    ctx.out.done(`Already on the ${to} channel.`, { channel: to, switched: false });
    return;
  }

  const releases = await update.releases().catch((e) => {
    throw Failure.runtime(e);
  });
  const p = plan(current, to, releases);
  for (const warning of p.warnings) ctx.out.status(`warning: ${warning}`);
  if (
    p.warnings.length > 0 &&
    !(await ctx.prompter.confirm(`Switch to the ${to} channel?`, !!args.yes))
  )
    throw Failure.runtime("cancelled");
  record(file, to);

  const target = p.target;
  if (target.equals(current)) {
    ctx.out.done(`Switched to the ${to} channel. hpy ${current} is already its newest release.`, {
      channel: to,
      switched: true,
      version: target.toString(),
      installed: false,
    });
    return;
  }
  const outcome = await install(ctx, target, (i) => update.switchHint(i, from, to, target));
  if (outcome.kind === "installed") {
    const note = staleReceipt(outcome.install);
    if (note !== undefined) ctx.out.status(note);
    ctx.out.done(`Switched to the ${to} channel and installed hpy ${target}.`, {
      channel: to,
      switched: true,
      version: target.toString(),
      installed: true,
    });
    return;
  }
  ctx.out.done(
    `Switched to the ${to} channel. Something else owns this copy of hpy; to install hpy ${target} from the ${to} channel:\n\n  ${outcome.hint}`,
    {
      channel: to,
      switched: true,
      version: target.toString(),
      installed: false,
      hint: outcome.hint,
    },
  );
}
