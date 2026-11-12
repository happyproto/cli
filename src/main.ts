// crates/hpy/src/main.rs: parse, run, print a failure, exit with its code.

import type { Command } from "commander";
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
import { commandPath, renderHelp, usage } from "./help.ts";

/** commander's parse errors in clap's words: `error: …`, exit 2. */
function clapMessage(e: CommanderError, extra?: string): string {
  const m = e.message.replace(/^error: /, "");
  const rules: [RegExp, (r: RegExpMatchArray) => string][] = [
    [/^unknown command '(.+)'/, (r) => `unrecognized subcommand '${r[1]}'`],
    [/^unknown option '(.+)'/, (r) => `unexpected argument '${r[1]}' found`],
    [/^too many arguments/, () => `unexpected argument '${extra}' found`],
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
  // clap's help: `-h` the summary, `--help` the long form, `help <command>` the long form.
  const { target, words } = resolveCommand(program, argv);
  const helpIndex = argv.findIndex((a) => a === "-h" || a === "--help");
  const dashdash = argv.indexOf("--");
  if (helpIndex !== -1 && (dashdash === -1 || helpIndex < dashdash)) {
    process.stdout.write(renderHelp(target, argv[helpIndex] === "--help"));
    return 0;
  }
  if (words[words.length - 1] === "help" && target.commands.length > 0) {
    const rest = argv.slice(argv.indexOf("help") + 1).filter((a) => !a.startsWith("-"));
    const inner = resolveCommand(target, rest).target;
    process.stdout.write(renderHelp(inner, true));
    return 0;
  }
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
        process.stderr.write(renderHelp(target, false));
        return 2;
      }
      const msg = clapMessage(e, excessArgument(errTarget(program, argv), argv));
      // clap adds a usage line except where the value itself was wrong.
      const bare = /^(invalid value|a value is required)/.test(msg);
      const usageLine = msg.startsWith("the following required arguments")
        ? `${commandPath(errTarget(program, argv))} ${msg.split("\n  ")[1]}`
        : usage(errTarget(program, argv));
      process.stderr.write(
        `error: ${msg}\n\n${bare ? "" : `Usage: ${usageLine}\n\n`}For more information, try '--help'.\n`,
      );
      return 2;
    }
    throw e;
  }
  if (!invocation) return 0;
  const problem = check(invocation.route, invocation.args, argv);
  if (problem !== null) {
    const args = invocation.args;
    const positionals = target.registeredArguments.map((a) => {
      const used =
        a.name() !== problem.except &&
        args[a.name()] !== undefined &&
        !(Array.isArray(args[a.name()]) && (args[a.name()] as unknown[]).length === 0);
      const open = used || a.required || a.name() === problem.missing ? "<" : "[";
      const close = open === "<" ? ">" : "]";
      return `${open}${a.name()}${close}${a.variadic ? "..." : ""}`;
    });
    const required = problem.message.startsWith("the following required");
    const shown = required ? positionals.filter((p) => !problem.used.includes(p)) : positionals;
    const usageLine = [commandPath(target), ...problem.used, ...shown].join(" ");
    process.stderr.write(
      `error: ${problem.message}\n\nUsage: ${usageLine}\n\nFor more information, try '--help'.\n`,
    );
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

/** The first positional past what the command takes, for clap's "unexpected argument 'x'". */
function excessArgument(target: Command, argv: string[]): string | undefined {
  const { words } = resolveCommand(target.parent ? rootOf(target) : target, argv);
  const rest: string[] = [];
  let skipped = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("-")) {
      const takesValue = [...target.options, ...rootOf(target).options].find(
        (o) => (o.long === a || o.short === a) && /<[^>]+>/.test(o.flags),
      );
      if (takesValue) i++;
      continue;
    }
    if (skipped < words.length) {
      skipped++;
      continue;
    }
    rest.push(a);
  }
  return rest[target.registeredArguments.length];
}

function rootOf(c: Command): Command {
  let r = c;
  while (r.parent) r = r.parent;
  return r;
}

/** The command a parse error is about: the deepest one named, even past unknown words. */
function errTarget(program: Command, argv: string[]): Command {
  return resolveCommand(program, argv).target;
}

/** The deepest command the leading words of argv name, and those words; `help` stops the walk. */
function resolveCommand(root: Command, argv: string[]): { target: Command; words: string[] } {
  let target = root;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (a === "-C") i++;
      continue;
    }
    if (a === "help" && target.commands.length > 0) {
      words.push(a);
      break;
    }
    const next = target.commands.find((c) => c.name() === a || c.aliases().includes(a));
    if (!next) break;
    target = next;
    words.push(a);
  }
  return { target, words };
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
