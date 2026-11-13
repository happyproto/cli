// crates/hpy/src/commands/happyview/dev.rs: `hpy happyview dev`. The `--network local` branch
// is `network.ts`'s `runLocal`; the native branch is M4's.
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { type DevArgs, runLocal } from "./network.ts";

/** cli.rs `DevArgs`, from commander's parse. */
export function devArgs(args: Args): DevArgs & { network: string } {
  return {
    network: (args.network as string | undefined) ?? "real",
    locked: args.locked === true,
    reset: args.reset === true,
    subnet: args.subnet as string | undefined,
    yes: args.yes === true,
  };
}

export async function run(ctx: Ctx, raw: Args): Promise<void> {
  const args = devArgs(raw);
  if (args.network === "local") {
    // Nothing here has been verified on Windows, and Docker Desktop's path translation for the
    // project's bind mount is untested.
    if (process.platform === "win32")
      throw Failure.usage("--network local runs on macOS and Linux only for now");
    return runLocal(ctx, args);
  }
  // clap's `requires` cannot name a value of `--network`.
  if (args.reset) throw Failure.usage("--reset applies only to --network local");
  if (args.subnet !== undefined) throw Failure.usage("--subnet applies only to --network local");
  throw Failure.runtime("`hv.dev` is not ported to TypeScript yet");
}
