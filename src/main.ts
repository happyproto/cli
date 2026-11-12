// crates/hpy/src/main.rs: parse, run, print a failure, exit with its code.
import { CommanderError } from "commander";
import { loadSettings } from "./atproto/settings.ts";
import { check } from "./checks.ts";
import { buildCli, type Invocation, UsageExit } from "./cli.ts";
import { HANDLERS } from "./commands/index.ts";
import { Ctx } from "./core/ctx.ts";
import { Failure } from "./core/failure.ts";
import { Output } from "./core/output.ts";
import { Prompter } from "./core/prompt.ts";
import { renderReport } from "./core/report.ts";
import { VERSION } from "./core/version.ts";

/** commander's parse errors in clap's words: `error: …`, exit 2. */
function clapMessage(e: CommanderError): string {
  const m = e.message.replace(/^error: /, "");
  const rules: [RegExp, (r: RegExpMatchArray) => string][] = [
    [/^unknown command '(.+)'/, (r) => `unrecognized subcommand '${r[1]}'`],
    [/^unknown option '(.+)'/, (r) => `unexpected argument '${r[1]}' found`],
    [/^too many arguments/, () => "unexpected argument found"],
    [
      /^option '(.+)' argument missing/,
      (r) => `a value is required for '${r[1]}' but none was supplied`,
    ],
    [
      /^required option '(.+)' not specified/,
      (r) => `the following required arguments were not provided:\n  ${r[1]}`,
    ],
    [
      /^option '(.+)' argument '(.*)' is invalid\. Allowed choices are (.+)\./,
      (r) => `invalid value '${r[2]}' for '${r[1]}'\n  [possible values: ${r[3]}]`,
    ],
  ];
  for (const [re, f] of rules) {
    const r = m.match(re);
    if (r) return f(r);
  }
  return m;
}

async function run(argv: string[]): Promise<number> {
  // The root's -V/--version, before any subcommand word.
  for (const a of argv) {
    if (a === "-V" || a === "--version") {
      process.stdout.write(`hpy ${VERSION}\n`);
      return 0;
    }
    if (!a.startsWith("-")) break;
  }
  let invocation: Invocation | undefined;
  const program = buildCli(VERSION, (i) => {
    invocation = i;
  });
  let errText = "";
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => (errText += s) });
  for (const sub of allCommands(program)) {
    sub.exitOverride();
    sub.configureOutput({ writeErr: (s) => (errText += s) });
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof UsageExit) {
      process.stderr.write(errText);
      return 2;
    }
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return 0;
      if (e.code === "commander.help") {
        process.stderr.write(errText);
        return 2;
      }
      process.stderr.write(`error: ${clapMessage(e)}\n\nFor more information, try '--help'.\n`);
      return 2;
    }
    throw e;
  }
  if (!invocation) return 0;
  const problem = check(invocation.route, invocation.args, argv);
  if (problem !== null) {
    process.stderr.write(`error: ${problem}\n\nFor more information, try '--help'.\n`);
    return 2;
  }
  const g = program.opts() as { json?: boolean; input?: boolean; C?: string };
  const settings = loadSettings();
  let dir = process.cwd();
  if (g.C !== undefined) dir = (await import("node:path")).resolve(g.C);
  const ctx = new Ctx(settings, new Prompter(g.input === false), new Output(!!g.json), dir);
  const handler = HANDLERS[invocation.route];
  if (!handler) throw Failure.runtime(`\`${invocation.route}\` is not ported to TypeScript yet`);
  await handler(ctx, invocation.args);
  return 0;
}

function* allCommands(c: import("commander").Command): Generator<import("commander").Command> {
  for (const sub of c.commands) {
    yield sub;
    yield* allCommands(sub);
  }
}

async function main(): Promise<void> {
  let code: number;
  try {
    code = await run(process.argv.slice(2));
  } catch (e) {
    const f = Failure.from(e);
    if (!f.quiet) process.stderr.write(`${renderReport(f.message)}\n`);
    code = f.code;
  }
  process.exitCode = code;
}

await main();
