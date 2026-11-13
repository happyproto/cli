// crates/hpy/src/commands/happyview/check.rs: `hpy hv check`, `test` and `types`, each the
// pinned HappyView binary run on the project once it is built and prepared.
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { languages, writeEditorConfig } from "../project/editor.ts";
import { readModules, Snapshot } from "../project/modules.ts";
import { PrepareOptions, prepare, projectRoot, REMOVED_ENV } from "../project/prepare.ts";
import { finish, runForeground, runRebuildingModules } from "../project/run.ts";
import { buildModules } from "./build.ts";
import { missingHandlerWarnings } from "./scaffold.ts";

/**
 * Point editors at the types HappyView writes, for the interpreters the project has, reporting
 * each settings file written or left to the author.
 */
export function pointEditorsAtTypes(ctx: Ctx, root: string): void {
  let lines: string[];
  try {
    lines = writeEditorConfig(root, languages(root));
  } catch (e) {
    throw Failure.from(e);
  }
  for (const line of lines) ctx.out.status(line);
}

// `happyview check` reads a `.env` from its working directory, which is the project root here.
export async function check(ctx: Ctx, args: Args): Promise<void> {
  const root = projectRoot(ctx);
  // Before the binary, which replaces hpy on unix. Warnings only: the exit code is HappyView's.
  for (const line of missingHandlerWarnings(root)) ctx.out.status(line);
  // HappyView reads the modules from their build files, so they are built first; one that
  // does not compile fails before anything is fetched.
  await buildModules(root);
  const p = await prepare(ctx, PrepareOptions.native(!!args.locked));
  // HappyView's report is the result, so under --json it is the JSON.
  const argv = ["check", "."];
  if (ctx.out.isJson()) argv.push("--json");
  finish(await runForeground(p.binary, argv, p.root, [], REMOVED_ENV));
}

export async function test(ctx: Ctx, args: Args): Promise<void> {
  const root = projectRoot(ctx);
  // Before the build, so a save made while it runs is rebuilt.
  const from = args.watch ? Snapshot.take(root, readModules(root)) : undefined;
  // A run against a stale build would test code other than the source.
  await buildModules(root);
  const p = await prepare(ctx, PrepareOptions.native(!!args.locked));
  const argv = ["test", "."];
  if (args.watch) argv.push("--watch");
  if (typeof args.FILTER === "string") argv.push(args.FILTER);
  if (from === undefined) {
    finish(await runForeground(p.binary, argv, p.root, [], REMOVED_ENV));
    return;
  }
  // HappyView re-runs the tests when a module's build file changes, so keeping the builds
  // current is what makes a source edit re-run them.
  finish(await runRebuildingModules(p.binary, argv, p.root, from));
}

export async function types(ctx: Ctx, args: Args): Promise<void> {
  // The build reads the modules' build files, as `check`'s does.
  await buildModules(projectRoot(ctx));
  const p = await prepare(ctx, PrepareOptions.native(!!args.locked));
  // Before the binary, which replaces hpy on unix; the settings name the directories, not
  // what is in them.
  pointEditorsAtTypes(ctx, p.root);
  finish(await runForeground(p.binary, ["types", "."], p.root, [], REMOVED_ENV));
}
