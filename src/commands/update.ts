// crates/hpy/src/commands/update.rs: `hpy update`, and the installing `hpy channel` shares.

import type { Version } from "../channel.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import type { Install } from "../update.ts";
import * as update from "../update.ts";

export type Outcome =
  /**
   * The new version was put in place of this one, where it was installed from — which the
   * caller reports, since `cargo install` has a receipt that a replaced binary leaves out of
   * date.
   */
  | { kind: "installed"; install: Install }
  /** Something else owns this copy; this is how to install it there. */
  | { kind: "hint"; hint: string };

/**
 * What a package manager still believes after a self-update replaced the binary it put there.
 * Only `cargo install` keeps a receipt we can go behind: the managers that would notice never
 * reach a self-update.
 */
export function staleReceipt(install: Install): string | undefined {
  return install === "cargo"
    ? "`cargo install` still records the version it built, so installing hpy with cargo again will rebuild from source over this binary."
    : undefined;
}

/** Installs `target` over this copy of hpy when the installer put it here, and otherwise answers how to install it with what did. */
export async function install(
  ctx: Ctx,
  target: Version,
  hint: (i: Install) => string,
): Promise<Outcome> {
  const self = update.thisInstall();
  if (self === undefined)
    throw Failure.runtime("could not tell where this copy of hpy is installed");
  if (self.prefix === undefined) return { kind: "hint", hint: hint(self.install) };
  ctx.out.status(`Installing hpy ${target} into ${self.prefix}…`);
  try {
    await update.selfUpdate(target, self.prefix, "ask");
  } catch (e) {
    const err =
      e instanceof update.SelfUpdateError
        ? e
        : new update.SelfUpdateError("failed", e instanceof Error ? e.message : String(e));
    // Printed as it is rather than as an error report, which would wrap the command it gives
    // across lines.
    if (err.kind === "needsRoot") {
      ctx.out.status(update.selfUpdateFailed(target, err));
      throw Failure.exit(1);
    }
    throw Failure.runtime(update.selfUpdateFailed(target, err));
  }
  return { kind: "installed", install: self.install };
}

export async function run(ctx: Ctx): Promise<void> {
  const channel = update.following(ctx.settings.configDir);
  const current = update.current();
  const releases = await update.releases().catch((e) => {
    throw Failure.runtime(e);
  });
  const latest = update.available(current, channel, releases);
  if (latest === undefined) {
    ctx.out.done(`hpy ${current} is the newest release on the ${channel} channel.`, {
      channel,
      version: current.toString(),
      updated: false,
    });
    return;
  }
  const outcome = await install(ctx, latest, (i) => update.upgradeHint(i, channel, latest));
  if (outcome.kind === "installed") {
    const note = staleReceipt(outcome.install);
    if (note !== undefined) ctx.out.status(note);
    ctx.out.done(`Updated hpy ${current} → ${latest}.`, {
      channel,
      version: latest.toString(),
      updated: true,
    });
    return;
  }
  ctx.out.done(
    `hpy ${latest} is available on the ${channel} channel (you have ${current}). Something else owns this copy of hpy; to upgrade:\n\n  ${outcome.hint}`,
    { channel, version: latest.toString(), updated: false, hint: outcome.hint },
  );
}
