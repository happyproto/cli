// crates/hpy/src/main.rs: parse, run, print a failure, exit with its code.

import type { Command } from "commander";
import { CommanderError } from "commander";
import { useEnvProxy } from "./atproto/http.ts";
import { loadSettings } from "./atproto/settings.ts";
import { check, requiredBy } from "./checks.ts";
import { buildCli, checksForUpdates, type Invocation, UsageExit } from "./cli.ts";
import { HANDLERS } from "./commands/index.ts";
import { Ctx } from "./core/ctx.ts";
import { Failure } from "./core/failure.ts";
import { Output } from "./core/output.ts";
import { configDir } from "./core/paths.ts";
import { Prompter } from "./core/prompt.ts";
import { renderReport } from "./core/report.ts";
import { VERSION } from "./core/version.ts";
import { commandPath, renderHelp, usage } from "./help.ts";
import * as update from "./update.ts";
import { ValueError } from "./values.ts";

/** The daily update check, started once the command line parsed and finished after the command. */
let pending: update.Pending | undefined;

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
  // An unknown subcommand word is an error even beside --help, as in clap.
  const stray =
    target.commands.length > 0 &&
    argv.some((a, i) => !a.startsWith("-") && argv[i - 1] !== "-C" && !words.includes(a));
  if (helpIndex !== -1 && (dashdash === -1 || helpIndex < dashdash) && !stray) {
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
  program.helpOption(false);
  for (const sub of allCommands(program)) {
    // Help is answered above, in clap's layout; commander must not print its own.
    sub.helpOption(false);
    sub.exitOverride();
    sub.configureOutput({ writeErr: (s) => (errText += s) });
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof ValueError) {
      process.stderr.write(`error: ${e.message}\n\nFor more information, try '--help'.\n`);
      return 2;
    }
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
    const needed = requiredBy(invocation.route, args);
    const positionals = target.registeredArguments.map((a) => {
      const used =
        a.name() !== problem.except &&
        args[a.name()] !== undefined &&
        !(Array.isArray(args[a.name()]) && (args[a.name()] as unknown[]).length === 0);
      const open =
        used || a.required || a.name() === problem.missing || needed.includes(a.name()) ? "<" : "[";
      const close = open === "<" ? ">" : "]";
      return `${open}${a.name()}${close}${a.variadic ? "..." : ""}`;
    });
    const required = problem.message.startsWith("the following required");
    const shown = required ? positionals.filter((p) => !problem.used.includes(p)) : positionals;
    // clap's usage names every option the command line used, in the order given, but the one
    // that conflicted; a missing required option comes first.
    const given = usedOptions(target, argv).filter((d) => d !== problem.excluded);
    const lead = required
      ? problem.used.filter((u) => u.startsWith("-") && !given.includes(u))
      : [];
    const used = [...lead, ...given];
    const usageLine = [commandPath(target), ...used, ...shown].join(" ");
    process.stderr.write(
      `error: ${problem.message}\n\nUsage: ${usageLine}\n\nFor more information, try '--help'.\n`,
    );
    return 2;
  }
  if (checksForUpdates(invocation.route)) pending = update.start(configDir());
  const g = program.opts() as { json?: boolean; input?: boolean; C?: string };
  const settings = loadSettings();
  let dir = process.cwd();
  // As given, like clap's PathBuf: messages print `-C`'s path the way it was written.
  if (g.C !== undefined) dir = g.C;
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
  process.exitCode = code;
}

await main();

/**
 * The options of `cmd` itself that `argv` gives, as clap displays them in a usage line
 * (`--kind <KIND>`, `--yes`), in command-line order. Global options are left out: clap matches
 * them on the parent command.
 */
function usedOptions(cmd: Command, argv: string[]): string[] {
  const found: [number, string][] = [];
  for (const o of cmd.options) {
    const long = o.long;
    const short = o.short;
    const i = argv.findIndex(
      (a) =>
        (long !== undefined && (a === long || a.startsWith(`${long}=`))) ||
        (short !== undefined &&
          (a === short || (a.startsWith(short) && a.length > 2 && !a.startsWith("--")))),
    );
    if (i === -1) continue;
    const value = o.flags.match(/[<[]([^>\]]+)[>\]]/)?.[1];
    found.push([i, value !== undefined ? `${long} <${value}>` : `${long ?? short}`]);
  }
  return found.sort(([a], [b]) => a - b).map(([, d]) => d);
}
