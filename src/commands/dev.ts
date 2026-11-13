// crates/hpy/src/commands/happyview/dev.rs: `hpy hv dev` on the real network. `--network local`
// is network.rs's (M5).
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { readModules, Snapshot } from "../project/modules.ts";
import { PrepareOptions, prepare } from "../project/prepare.ts";
import { finish, firstBuild, runRebuildingModules } from "../project/run.ts";
import { pointEditorsAtTypes } from "./check.ts";

export async function run(ctx: Ctx, args: Args): Promise<void> {
  if (args.network === "local") {
    if (process.platform === "win32") {
      // Nothing here has been verified on Windows, and Docker Desktop's path translation for
      // the project's bind mount is untested.
      throw Failure.usage("--network local runs on macOS and Linux only for now");
    }
    throw Failure.runtime("`hv.dev --network local` is not ported to TypeScript yet");
  }
  // clap's `requires` cannot name a value of `--network`.
  if (args.reset) throw Failure.usage("--reset applies only to --network local");
  if (args.subnet !== undefined) throw Failure.usage("--subnet applies only to --network local");
  const p = await prepare(ctx, PrepareOptions.native(!!args.locked));
  // HappyView's dev server writes the types themselves, after every build.
  pointEditorsAtTypes(ctx, p.root);
  const specs = readModules(p.root);
  // Before the first build, so a save made while it runs is rebuilt.
  const from = Snapshot.take(p.root, specs);
  await firstBuild(p.root, from.modules());
  finish(await runRebuildingModules(p.binary, ["dev", "."], p.root, from));
}
