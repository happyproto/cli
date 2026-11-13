// crates/hpy/src/main.rs: parse, run, print a failure, exit with its code.

import { useEnvProxy } from "./atproto/http.ts";
import { loadSettings } from "./atproto/settings.ts";
import { parse } from "./clap.ts";
import { buildCli, checksForUpdates } from "./cli.ts";
import { HANDLERS } from "./commands/index.ts";
import { Ctx } from "./core/ctx.ts";
import { Failure } from "./core/failure.ts";
import { Output } from "./core/output.ts";
import { configDir } from "./core/paths.ts";
import { Prompter } from "./core/prompt.ts";
import { renderReport } from "./core/report.ts";
import { flushStdio } from "./core/stdio.ts";
import { VERSION } from "./core/version.ts";
import { renderHelp, renderHelpHelp } from "./help.ts";
import * as update from "./update.ts";

/** The daily update check, started once the command line parsed and finished after the command. */
let pending: update.Pending | undefined;

async function run(argv: string[]): Promise<number> {
  const program = buildCli(VERSION, () => {});
  const outcome = parse(program, argv);
  switch (outcome.kind) {
    case "version":
      process.stdout.write(`hpy ${VERSION}\n`);
      return 0;
    case "help":
      process.stdout.write(renderHelp(outcome.cmd, outcome.long));
      return 0;
    case "helpHelp":
      process.stdout.write(renderHelpHelp(outcome.parent));
      return 0;
    case "helpError":
      process.stderr.write(renderHelp(outcome.cmd, false));
      return 2;
    case "error":
      process.stderr.write(outcome.text);
      return 2;
  }
  const { route, args, globals: g } = outcome;
  if (checksForUpdates(route)) pending = update.start(configDir());
  const settings = loadSettings();
  let dir = process.cwd();
  // As given, like clap's PathBuf: messages print `-C`'s path the way it was written.
  if (g.C !== undefined) dir = g.C;
  const ctx = new Ctx(settings, new Prompter(g.input === false), new Output(!!g.json), dir);
  const handler = HANDLERS[route];
  if (!handler) throw Failure.runtime(`\`${route}\` is not ported to TypeScript yet`);
  await handler(ctx, args);
  return 0;
}

async function main(): Promise<void> {
  useEnvProxy();
  let code: number;
  try {
    code = await run(process.argv.slice(2));
  } catch (e) {
    const f = Failure.from(e);
    if (!f.quiet) process.stderr.write(`${renderReport(f.message)}\n`);
    code = f.code;
  }
  await update.finish(pending);
  // Rust's process ends when `main` returns, whatever is still in flight; so does this one. A
  // request a Ctrl-C abandoned would otherwise hold the event loop open until it gave up.
  await flushStdio();
  process.exit(code);
}

await main();
