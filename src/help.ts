// clap's help, as the Rust hpy printed it: `-h` is the summary and `--help` the
// long form, which differs only for commands with a long description or an
// argument with long help (then every argument's help goes on its own line).
// Text wraps at the terminal's width (COLUMNS, else 100, without a terminal).
import type { Argument, Command, Option } from "commander";
import { terminalWidth } from "./core/terminal.ts";
import ORDER from "./help-order.json" with { type: "json" };

/** cli.rs doc comments beyond their first line: clap's `long_about`. */
const LONG_ABOUT: Record<string, string> = {
  "hpy happyview dev":
    "Run the project with its pinned HappyView; a saved file is live on the next request.\n\nA compiled module is rebuilt when a file under its own directory changes. A path dependency outside that directory, or a workspace's Cargo.lock above it, is not watched: after changing one, save a file in the module to rebuild it.",
  "hpy happyview scaffold":
    "Write a starter handler beside each query or procedure lexicon under src/ that has none.\n\nThe handler is in the language of the first [interpreters] entry and names its collection: --collection's, else one chosen at a prompt, else the placeholder COLLECTION under a TODO comment. An existing handler, in any language, is never replaced.",
  "hpy happyview env push":
    "Send keys from the project's .env to the instance's script variables, asking before each.\n\nValues are never shown: not in the questions, the output, --json or an error. Keys are read from the file only, never from your shell's environment. The instance shows values masked, so a key it already has is replaced without knowing whether the value differs.",
  "hpy happyview pull":
    "Build a project from what an instance serves: its lexicons, scripts, plugins and settings.\n\nThe project is read from the instance's live state, so dashboard edits are kept. A v3 instance is read with your `hpy hv login` sign-in. A v2 instance needs --legacy and an API key with lexicons:read, scripts:read, script-variables:read, plugins:read, labelers:read, users:read and settings:manage (revoke it afterwards); each script is rewritten for v3 by the pinned HappyView's happyview-codemod, and v2 plugins without an official registry project are left out. Script variable values and plugin secrets are never pulled: the variables' keys go to .env.example, and the secrets a plugin needs are listed. Ends by running `hpy hv check` on the new project, which is written either way.",
};

/** clap's `ValueEnum` doc comments: shown as a list in the long help. */
const POSSIBLE_VALUE_HELP: Record<string, [string, string][]> = {
  "--network": [
    ["real", "The real atproto network; writes reach your real PDS"],
    [
      "local",
      "A private network on this computer (Atmosphere in a Box; needs Docker and Deno 2.8)",
    ],
  ],
};

/**
 * clap's `term_w` with `wrap_help` and no `max_term_width`: the terminal's
 * width, else `COLUMNS`, else 100. There is no upper bound.
 */
export function helpWidth(): number {
  const cols = terminalWidth();
  if (cols !== undefined) return cols;
  const env = process.env.COLUMNS;
  if (env !== undefined && /^\+?[0-9]+$/.test(env) && Number(env) > 0) return Number(env);
  return 100;
}

/** clap drops a one-paragraph doc comment's final period. */
const trimPeriod = (s: string) => s.replace(/\.$/, "");

export function commandPath(c: Command): string {
  const names: string[] = [];
  for (let x: Command | null = c; x; x = x.parent) names.unshift(x.name());
  return names.join(" ");
}

function wrap(text: string, width: number, indent: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let cur = "";
    for (const w of para.split(" ")) {
      if (cur === "") cur = w;
      else if (indent + cur.length + 1 + w.length <= width) cur += ` ${w}`;
      else {
        out.push(cur);
        cur = w;
      }
    }
    out.push(cur);
  }
  return out;
}

interface Row {
  name: string;
  key?: string;
  help: string;
  /** Long-help extras: the possible values list and the default. */
  long?: string;
}

function argDisplay(a: Argument): string {
  const n = a.name();
  const base = a.required ? `<${n}>` : `[${n}]`;
  return a.variadic ? `${base}...` : base;
}

function optionKey(o: Option): string {
  return o.long ?? o.short ?? o.flags;
}

function optionDisplay(o: Option): string {
  const value = o.flags.match(/<[^>]+>/)?.[0];
  const names =
    o.short && o.long ? `${o.short}, ${o.long}` : o.long ? `    ${o.long}` : `${o.short}`;
  return value ? `${names} ${value}` : names;
}

function optionRow(o: Option, _globals: boolean): Row {
  let help = trimPeriod(o.description);
  const def = o.defaultValue;
  const choices = o.argChoices;
  if (def !== undefined && typeof def === "string") help += ` [default: ${def}]`;
  if (choices) help += ` [possible values: ${choices.join(", ")}]`;
  const pv = o.long ? POSSIBLE_VALUE_HELP[o.long] : undefined;
  let long: string | undefined;
  if (pv) {
    const w = Math.max(...pv.map(([n]) => n.length));
    long = `Possible values:\n${pv.map(([n, h]) => `- ${`${n}:`.padEnd(w + 1)} ${h}`).join("\n")}\n\n[default: ${def}]`;
  }
  return { name: optionDisplay(o), key: optionKey(o), help, ...(long ? { long } : {}) };
}

function rowsShort(rows: Row[], width: number): string[] {
  const col = Math.max(...rows.map((r) => r.name.length));
  const lines: string[] = [];
  for (const r of rows) {
    const lead = `  ${r.name.padEnd(col)}  `;
    const body = wrap(r.help, width, lead.length);
    lines.push(`${lead}${body[0] ?? ""}`.trimEnd());
    for (const b of body.slice(1)) lines.push(`${" ".repeat(lead.length)}${b}`);
  }
  return lines;
}

function rowsLong(rows: Row[], width: number): string[] {
  const lines: string[] = [];
  rows.forEach((r, i) => {
    lines.push(`  ${r.name}`);
    for (const b of wrap(r.help, width, 10)) lines.push(b === "" ? "" : `          ${b}`);
    if (r.long) {
      lines.push("");
      for (const para of r.long.split("\n")) {
        if (para === "") {
          lines.push("          ");
          continue;
        }
        const bullet = para.startsWith("- ");
        const body = wrap(para, width, 10);
        lines.push(`          ${body[0]}`);
        for (const b of body.slice(1)) lines.push(`${" ".repeat(bullet ? 12 : 10)}${b}`);
      }
    }
    if (i < rows.length - 1) lines.push("");
  });
  return lines;
}

/** Every option the command shows, the globals included, in clap's order. */
function options(c: Command): Option[] {
  const all: Option[] = [...c.options];
  for (let p = c.parent; p; p = p.parent) if (!p.parent) all.push(...p.options);
  const order = (ORDER as Record<string, string[]>)[commandPath(c)] ?? [];
  const at = (o: Option) => {
    const i = order.indexOf(optionKey(o));
    return i === -1 ? order.length : i;
  };
  return all
    .filter((o) => order.length === 0 || order.includes(optionKey(o)))
    .sort((a, b) => at(a) - at(b));
}

export function usage(c: Command): string {
  const parts = [commandPath(c), "[OPTIONS]"];
  for (const o of c.options) if (o.mandatory) parts.push(o.flags.replace(/^-\w, /, ""));
  for (const a of c.registeredArguments) parts.push(argDisplay(a));
  if (c.commands.length > 0) parts.push("<COMMAND>");
  return parts.join(" ");
}

export function renderHelp(c: Command, long: boolean, width = helpWidth()): string {
  const path = commandPath(c);
  const about = trimPeriod(c.description());
  const longAbout = LONG_ABOUT[path];
  const opts = options(c);
  const hasLong =
    longAbout !== undefined || opts.some((o) => o.long && POSSIBLE_VALUE_HELP[o.long]);
  const nextLine = long && hasLong;
  const out: string[] = [];
  out.push(...wrap(nextLine && longAbout ? longAbout : about, width, 0));
  out.push("", `Usage: ${usage(c)}`, "");
  if (c.commands.length > 0) {
    const rows: Row[] = c.commands.map((s) => ({
      name: s.name(),
      help: trimPeriod(s.description()),
    }));
    rows.push({ name: "help", help: "Print this message or the help of the given subcommand(s)" });
    out.push("Commands:", ...rowsShort(rows, width), "");
  }
  if (c.registeredArguments.length > 0) {
    const rows = c.registeredArguments.map((a) => ({
      name: argDisplay(a),
      help: trimPeriod(a.description),
    }));
    out.push("Arguments:", ...(nextLine ? rowsLong(rows, width) : rowsShort(rows, width)), "");
  }
  const rows = opts.map((o) => {
    const r = optionRow(o, false);
    if (nextLine && o.long && POSSIBLE_VALUE_HELP[o.long]) r.help = trimPeriod(o.description);
    return r;
  });
  const helpText = hasLong
    ? long
      ? "Print help (see a summary with '-h')"
      : "Print help (see more with '--help')"
    : "Print help";
  const order = (ORDER as Record<string, string[]>)[path] ?? [];
  const merged: Row[] = [...rows, { name: "-h, --help", key: "--help", help: helpText }];
  if (!c.parent) merged.push({ name: "-V, --version", key: "--version", help: "Print version" });
  const at = (r: Row) => {
    const i = order.indexOf(r.key ?? "");
    return i === -1 ? order.length : i;
  };
  merged.sort((a, b) => at(a) - at(b));
  if (!nextLine) for (const r of merged) delete r.long;
  out.push("Options:", ...(nextLine ? rowsLong(merged, width) : rowsShort(merged, width)));
  return `${out.join("\n")}\n`;
}

/** The help of clap's `help` subcommand (`hpy help help`). */
export function renderHelpHelp(parent: Command): string {
  return `Print this message or the help of the given subcommand(s)

Usage: ${commandPath(parent)} help [COMMAND]...

Arguments:
  [COMMAND]...  Print help for the subcommand(s)
`;
}
