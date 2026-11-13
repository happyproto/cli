// clap 4.6's command-line parser (clap_builder/src/parser/parser.rs and
// validator.rs), run over the commander tree in cli.ts. commander only
// describes the commands; this walks argv the way clap does, so every parse
// error has clap's wording, tips, usage line and precedence (an error is
// raised at the token clap raises it at, `-h` and `-V` act where they appear,
// a subcommand is parsed and checked before its parent's last option value).
// A valid command line becomes the leaf's route and its `args`, shaped as
// commander's `opts()` and `processedArgs` would be.
//
// Only what cli.rs uses is ported: every option takes exactly one value
// (`Set`, or `Append` for a `Vec`), flags are `SetTrue`, and no argument sets
// `last`, `allow_hyphen_values`, `require_equals` or a value delimiter.
import type { Argument, Command, Option } from "commander";
import { RULES, type Rule } from "./checks.ts";
import { type Args, isRepeatable, ROUTES } from "./cli.ts";
import { commandPath, usage as helpUsage } from "./help.ts";
import { ValueError } from "./values.ts";

/** What the command line asks for, when it does not name a command to run. */
export type Outcome =
  | { kind: "run"; route: string; leaf: Command; args: Args; globals: Globals }
  /** Help on stdout, exit 0: `-h`/`--help` (long for `--help`), or `help <command>`. */
  | { kind: "help"; cmd: Command; long: boolean }
  /** `help help`: the help subcommand's own help. */
  | { kind: "helpHelp"; parent: Command }
  | { kind: "version" }
  /** A group with nothing given: its short help on stderr, exit 2. */
  | { kind: "helpError"; cmd: Command }
  /** clap's error text for stderr, exit 2. */
  | { kind: "error"; text: string };

export type Globals = { json?: boolean; input?: boolean; C?: string };

class Stop {
  readonly outcome: Outcome;
  constructor(outcome: Outcome) {
    this.outcome = outcome;
  }
}

type Ident = "long" | "short" | "index";

interface Spec {
  id: string;
  long?: string;
  short?: string;
  takesValue: boolean;
  action: "set" | "append" | "setTrue" | "help" | "version";
  /** clap's `Arg` display: `--url <URL>`, `--yes`, `-C <DIR>`, `[VERSION]`, `<PLUGIN>...`. */
  display: string;
  option?: Option;
  argument?: Argument;
  global: boolean;
  required: boolean;
  multiple: boolean;
}

const valueName = (o: Option) => o.flags.match(/<([^>]+)>/)?.[1];

function optionSpec(o: Option, global: boolean): Spec {
  const v = valueName(o);
  const name = o.long ?? o.short ?? o.flags;
  const append = isRepeatable(o);
  return {
    id: global ? `global:${name}` : name,
    ...(o.long ? { long: o.long.slice(2) } : {}),
    ...(o.short ? { short: o.short.slice(1) } : {}),
    takesValue: v !== undefined,
    action: v === undefined ? "setTrue" : append ? "append" : "set",
    display: v === undefined ? name : `${name} <${v}>`,
    option: o,
    global,
    required: o.mandatory,
    multiple: append,
  };
}

function argumentSpec(a: Argument, i: number): Spec {
  const base = a.required ? `<${a.name()}>` : `[${a.name()}]`;
  return {
    id: `#${i}`,
    takesValue: true,
    action: a.variadic ? "append" : "set",
    display: a.variadic ? `${base}...` : base,
    argument: a,
    global: false,
    required: a.required,
    multiple: a.variadic,
  };
}

const HELP: Spec = {
  id: "help",
  long: "help",
  short: "h",
  takesValue: false,
  action: "help",
  display: "--help",
  global: false,
  required: false,
  multiple: false,
};
const VERSION: Spec = {
  ...HELP,
  id: "version",
  long: "version",
  short: "V",
  action: "version",
  display: "--version",
};

function rootOf(c: Command): Command {
  let r = c;
  while (r.parent) r = r.parent;
  return r;
}

/** Every argument clap knows on `cmd`, in its keymap's order: its own, the propagated globals, help, version. */
function specsOf(cmd: Command): { flags: Spec[]; positionals: Spec[] } {
  const root = rootOf(cmd);
  const own = cmd === root ? [] : cmd.options.map((o) => optionSpec(o, false));
  const globals = root.options.map((o) => optionSpec(o, true));
  const flags = [...own, ...globals, HELP, ...(cmd === root ? [VERSION] : [])];
  return { flags, positionals: cmd.registeredArguments.map(argumentSpec) };
}

function findSubcommand(cmd: Command, name: string): Command | "help" | undefined {
  const sub = cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
  if (sub) return sub;
  return cmd.commands.length > 0 && name === "help" ? "help" : undefined;
}

/** clap's `all_subcommand_names`: each name then its aliases, the help subcommand last. */
function allSubcommandNames(cmd: Command): string[] {
  if (cmd.commands.length === 0) return [];
  return [...cmd.commands.flatMap((c) => [c.name(), ...c.aliases()]), "help"];
}

/** strsim 0.11 `jaro`. */
export function jaro(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0 && y.length === 0) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const xf = new Array<boolean>(x.length).fill(false);
  const yf = new Array<boolean>(y.length).fill(false);
  let matches = 0;
  for (let i = 0; i < x.length; i++) {
    const lo = i > range ? i - range : 0;
    const hi = Math.min(y.length, i + range + 1);
    for (let j = 0; j < hi; j++) {
      if (lo <= j && x[i] === y[j] && !yf[j]) {
        xf[i] = true;
        yf[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    if (!xf[i]) continue;
    while (!yf[k]) k++;
    if (x[i] !== y[k]) t++;
    k++;
  }
  t = Math.floor(t / 2);
  return (matches / x.length + matches / y.length + (matches - t) / matches) / 3;
}

/** clap's `did_you_mean`: candidates above 0.7, least similar first. */
export function didYouMean(v: string, candidates: string[]): string[] {
  const out: [number, string][] = [];
  for (const c of candidates) {
    const conf = jaro(v, c);
    if (conf > 0.7) {
      let pos = 0;
      while (pos < out.length && !((out[pos] as [number, string])[0] > conf)) pos++;
      out.splice(pos, 0, [conf, c]);
    }
  }
  return out.map(([, c]) => c);
}

interface Rich {
  /** The help subcommand has no `--help` to point at: clap ends its errors there. */
  noHelpFlag?: boolean;
  suggestedSubcommand?: string[];
  suggestedArg?: string;
  suggestedValue?: string;
  tips?: string[];
  usage?: string;
}

/** clap's RichFormatter, without colour. */
function format(message: string, rich: Rich = {}): string {
  let s = `error: ${message}`;
  let suggested = false;
  const tip = (context: string, values: string[]) => {
    s += "\n";
    if (!suggested) {
      s += "\n";
      suggested = true;
    }
    s +=
      values.length === 1
        ? `  tip: a similar ${context} exists: '${values[0]}'`
        : `  tip: some similar ${context}s exist: ${values.map((v) => `'${v}'`).join(", ")}`;
  };
  if (rich.suggestedSubcommand) tip("subcommand", rich.suggestedSubcommand);
  if (rich.suggestedArg !== undefined) tip("argument", [rich.suggestedArg]);
  if (rich.suggestedValue !== undefined) tip("value", [rich.suggestedValue]);
  if (rich.tips) {
    if (!suggested) s += "\n";
    for (const t of rich.tips) s += `\n  tip: ${t}`;
  }
  if (rich.usage !== undefined) s += `\n\nUsage: ${rich.usage}`;
  return rich.noHelpFlag ? `${s}\n` : `${s}\n\nFor more information, try '--help'.\n`;
}

const fail = (message: string, rich?: Rich): Stop =>
  new Stop({ kind: "error", text: format(message, rich) });

interface Matched {
  spec: Spec;
  raw: string[];
}

interface Pending {
  spec: Spec;
  ident: Ident;
  raw: string[];
}

/** One command's parse: clap's `Parser` with its `ArgMatcher`. */
class Level {
  readonly flags: Spec[];
  readonly positionals: Spec[];
  readonly matched = new Map<string, Matched>();
  pending: Pending | null = null;

  readonly cmd: Command;

  constructor(cmd: Command) {
    this.cmd = cmd;
    const s = specsOf(cmd);
    this.flags = s.flags;
    this.positionals = s.positionals;
  }

  /** clap's `create_usage_with_title`: the help usage when nothing is used, else the "smart" one. */
  usage(used: string[] = [], required: string[] = this.mandatory()): string {
    if (used.length === 0) return helpUsage(this.cmd);
    const opts: string[] = [];
    for (const id of [...required, ...used]) {
      const a = this.byId(id);
      if (a.argument || opts.includes(a.display)) continue;
      opts.push(a.display);
    }
    const positionals = this.positionals.map((p) => {
      const name = p.argument?.name() as string;
      const req = p.required || used.includes(p.id) || required.includes(p.id);
      return `${req ? `<${name}>` : `[${name}]`}${p.multiple ? "..." : ""}`;
    });
    const parts = [commandPath(this.cmd), ...opts, ...positionals];
    if (this.cmd.commands.length > 0) parts.push("<COMMAND>");
    return parts.join(" ");
  }

  present(): string[] {
    return [...this.matched.keys()];
  }

  byId(id: string): Spec {
    return [...this.flags, ...this.positionals].find((a) => a.id === id) as Spec;
  }

  /** The required options: clap's `required_graph` before any `requires` is gathered. */
  mandatory(): string[] {
    return this.flags.filter((f) => f.required).map((f) => f.id);
  }

  resolvePending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.react(p.ident, p.spec, p.raw);
  }

  /** resolve_pending whose error clap drops (`let _ =`) before raising another. */
  resolvePendingQuietly(): void {
    try {
      this.resolvePending();
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
    }
  }

  react(ident: Ident | null, spec: Spec, raw: string[]): void {
    this.resolvePending();
    if (spec.takesValue && raw.length === 0) {
      const values = spec.option?.argChoices ?? [];
      throw fail(
        `a value is required for '${spec.display}' but none was supplied${valuesList(values)}`,
      );
    }
    switch (spec.action) {
      case "help":
        throw new Stop({ kind: "help", cmd: this.cmd, long: ident !== "short" });
      case "version":
        throw new Stop({ kind: "version" });
      case "set":
      case "setTrue":
        if (this.matched.has(spec.id)) {
          this.matched.delete(spec.id);
          throw fail(`the argument '${spec.display}' cannot be used multiple times`, {
            usage: this.usage(),
          });
        }
        this.matched.set(spec.id, { spec, raw: [] });
        break;
      case "append":
        if (!this.matched.has(spec.id)) this.matched.set(spec.id, { spec, raw: [] });
        break;
    }
    const m = this.matched.get(spec.id) as Matched;
    for (const v of raw) {
      checkValue(spec, v);
      m.raw.push(v);
    }
  }

  /** parse_opt_value (no `require_equals`): an attached value is taken now, else the next token is. */
  optValue(ident: Ident, spec: Spec, attached: string | undefined): boolean {
    if (attached !== undefined) {
      this.react(ident, spec, [attached]);
      return false;
    }
    this.resolvePending();
    this.pending = { spec, ident, raw: [] };
    return true;
  }

  /** The leaf's values, as commander's `opts()` and `processedArgs` hold them. */
  args(): Args {
    const args: Args = {};
    const options = this.cmd.options;
    for (const o of options) {
      const name = o.attributeName();
      if (o.defaultValue !== undefined) args[name] = o.defaultValue;
      else if (o.negate && o.long) {
        const positive = o.long.replace(/^--no-/, "--");
        if (!options.some((p) => p.long === positive)) args[name] = true;
      }
    }
    for (const m of this.matched.values()) {
      const o = m.spec.option;
      if (!o || m.spec.global) continue;
      const name = o.attributeName();
      if (!m.spec.takesValue) args[name] = !o.negate;
      else for (const v of m.raw) args[name] = o.parseArg ? o.parseArg(v, args[name] as never) : v;
    }
    this.cmd.registeredArguments.forEach((a, i) => {
      const raw = this.matched.get(`#${i}`)?.raw ?? [];
      let value: unknown = a.defaultValue;
      const parse = a.parseArg as ((v: string, prev: unknown) => unknown) | undefined;
      if (a.variadic) {
        if (raw.length > 0) value = parse ? raw.reduce((p, v) => parse(v, p), a.defaultValue) : raw;
        else if (value === undefined) value = [];
      } else if (raw.length > 0) {
        value = parse ? parse(raw[0] as string, a.defaultValue) : raw[0];
      }
      args[a.name()] = value;
    });
    return args;
  }
}

function valuesList(values: readonly string[]): string {
  return values.length > 0 ? `\n  [possible values: ${values.join(", ")}]` : "";
}

/** The value parser, run as each value is taken: possible values, then cli.rs's own parsers. */
function checkValue(spec: Spec, v: string): void {
  const choices = spec.option?.argChoices;
  if (choices) {
    if (!choices.includes(v)) {
      const near = didYouMean(v, choices).pop();
      const what =
        v === ""
          ? `a value is required for '${spec.display}' but none was supplied`
          : `invalid value '${v}' for '${spec.display}'`;
      throw fail(`${what}${valuesList(choices)}`, {
        ...(near !== undefined ? { suggestedValue: near } : {}),
      });
    }
    return;
  }
  const parse = (spec.option?.parseArg ?? spec.argument?.parseArg) as
    | ((v: string, prev: unknown) => unknown)
    | undefined;
  if (!parse || (spec.option && isRepeatable(spec.option))) return;
  try {
    parse(v, undefined);
  } catch (e) {
    if (e instanceof ValueError) throw new Stop({ kind: "error", text: format(e.message) });
    throw e;
  }
}

const isLong = (a: string) => a.startsWith("--") && a.length > 2;
const isShort = (a: string) => a.startsWith("-") && !a.startsWith("--") && a.length > 1;

interface Walk {
  levels: Level[];
  argv: string[];
}

/** clap's `Parser::parse` for one command, then its subcommand, then the command's own validation. */
function parseLevel(w: Walk, cmd: Command, start: number): void {
  const lv = new Level(cmd);
  w.levels.push(lv);
  const argv = w.argv;
  let state: "done" | "opt" | "pos" = "done";
  let posCounter = 1;
  let trailing = false;
  let sub: Command | undefined;
  let i = start;
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!trailing) {
      if (state === "done") {
        const sc = findSubcommand(cmd, a);
        if (sc === "help") helpSubcommand(cmd, argv.slice(i + 1));
        if (sc) {
          sub = sc as Command;
          break;
        }
      }
      if (a === "--") {
        trailing = true;
        continue;
      }
      if (isLong(a)) {
        const body = a.slice(2);
        const eq = body.indexOf("=");
        const name = eq === -1 ? body : body.slice(0, eq);
        const value = eq === -1 ? undefined : body.slice(eq + 1);
        const spec = lv.flags.find((f) => f.long === name);
        if (!spec) {
          lv.resolvePendingQuietly();
          throw unknownLong(lv, name, argv.slice(i + 1), trailing);
        }
        if (spec.takesValue) {
          state = lv.optValue("long", spec, value) ? "opt" : "done";
        } else if (value !== undefined) {
          lv.resolvePendingQuietly();
          const required = lv.mandatory();
          const used = [...lv.present().filter((id) => !required.includes(id)), spec.id];
          throw fail(
            `unexpected value '${value}' for '${spec.display}' found; no more were expected`,
            { usage: lv.usage(used) },
          );
        } else {
          lv.react("long", spec, []);
          state = "done";
        }
        continue;
      }
      if (isShort(a)) {
        const chars = Array.from(a.slice(1));
        let next: "done" | "opt" = "done";
        for (let j = 0; j < chars.length; j++) {
          const c = chars[j] as string;
          const spec = lv.flags.find((f) => f.short === c);
          if (!spec) {
            lv.resolvePendingQuietly();
            const tips =
              !trailing && lv.positionals.length > 0
                ? [`to pass '-${c}' as a value, use '-- -${c}'`]
                : [];
            throw fail(`unexpected argument '-${c}' found`, {
              ...(tips.length > 0 ? { tips } : {}),
              usage: lv.usage(),
            });
          }
          if (!spec.takesValue) {
            lv.react("short", spec, []);
            continue;
          }
          let rest: string | undefined = chars.slice(j + 1).join("");
          if (rest === "") rest = undefined;
          else if (rest.startsWith("=")) rest = rest.slice(1);
          next = lv.optValue("short", spec, rest) ? "opt" : "done";
          break;
        }
        state = next;
        continue;
      }
      if (state === "opt") {
        (lv.pending as Pending).raw.push(a);
        state = "done";
        continue;
      }
    }
    const pos = lv.positionals[posCounter - 1];
    if (!pos) {
      lv.resolvePendingQuietly();
      throw argError(lv, a, trailing);
    }
    if (lv.pending?.spec !== pos || !pos.multiple) lv.resolvePending();
    if (!lv.pending) lv.pending = { spec: pos, ident: "index", raw: [] };
    lv.pending.raw.push(a);
    if (pos.multiple) state = "pos";
    else {
      posCounter++;
      state = "done";
    }
  }
  if (sub) parseLevel(w, sub, i + 1);
  lv.resolvePending();
  if (sub) return;
  // validator.rs
  if (cmd.commands.length > 0) {
    if (lv.matched.size === 0) throw new Stop({ kind: "helpError", cmd });
    throw fail(
      `'${commandPath(cmd)}' requires a subcommand but one was not provided\n  [subcommands: ${allSubcommandNames(cmd).join(", ")}]`,
      { usage: lv.usage() },
    );
  }
  validate(lv, RULES[ROUTES.get(cmd) as string] ?? []);
}

/** validator.rs for a leaf: conflicts, then required arguments (required options and `requires`). */
function validate(lv: Level, rules: Rule[]): void {
  const idOf = (key: string): string | undefined =>
    [...lv.flags, ...lv.positionals].find(
      (s) => !s.global && (s.option?.attributeName() === key || s.argument?.name() === key),
    )?.id;
  const pairs = (kind: "conflicts" | "requires") =>
    rules.flatMap((r) => {
      if (!(kind in r)) return [];
      const [a, b] = (r as Record<string, [string, string]>)[kind] as [string, string];
      const [x, y] = [idOf(a), idOf(b)];
      return x && y ? [[x, y] as const] : [];
    });
  const conflicts = pairs("conflicts");
  const requires = pairs("requires");
  const present = lv.present();
  const conflicting = (id: string) =>
    present.filter(
      (o) => o !== id && conflicts.some(([a, b]) => (a === id && b === o) || (a === o && b === id)),
    );
  for (const id of present) {
    const others = conflicting(id);
    if (others.length === 0) continue;
    const shown = others.map((o) => lv.byId(o).display);
    const message =
      shown.length === 1
        ? `the argument '${lv.byId(id).display}' cannot be used with '${shown[0]}'`
        : `the argument '${lv.byId(id).display}' cannot be used with:${shown.map((o) => `\n  ${o}`).join("")}`;
    const used = present.filter((k) => !others.includes(k));
    const needed = used.flatMap((k) =>
      requires
        .filter(([a, b]) => a === k && !used.includes(b) && !others.includes(b))
        .map(([, b]) => b),
    );
    throw fail(message, { usage: lv.usage([...needed, ...used]) });
  }
  const required = lv.mandatory();
  for (const id of present)
    for (const [a, b] of requires) if (a === id && !required.includes(b)) required.push(b);
  const missing = required.filter((r) => !present.includes(r) && conflicting(r).length === 0);
  if (missing.length === 0) return;
  const listed = required.filter((r) => !present.includes(r));
  const opts = listed.filter((r) => !lv.byId(r).argument);
  const positionals = lv.positionals.filter((p) => listed.includes(p.id)).map((p) => p.id);
  const show = (id: string) => {
    const s = lv.byId(id);
    return s.argument ? `<${s.argument.name()}>${s.multiple ? "..." : ""}` : s.display;
  };
  const message = `the following required arguments were not provided:${[...opts, ...positionals].map((r) => `\n  ${show(r)}`).join("")}`;
  throw fail(message, { usage: lv.usage([...present, ...missing], required) });
}

/** match_arg_error: a word where no positional or subcommand fits. */
function argError(lv: Level, a: string, trailing: boolean): Stop {
  const cmd = lv.cmd;
  if (trailing && findSubcommand(cmd, a)) {
    return fail(`unexpected argument '${a}' found`, {
      tips: [`subcommand '${a}' exists; to use it, remove the '--' before it`],
      usage: lv.usage(),
    });
  }
  const trailingTip = !trailing && lv.positionals.length > 0 && (isLong(a) || isShort(a));
  if (cmd.commands.length > 0) {
    const candidates = didYouMean(a, allSubcommandNames(cmd));
    if (candidates.length > 0) {
      return fail(`unrecognized subcommand '${a}'`, {
        suggestedSubcommand: candidates,
        ...(trailingTip
          ? { tips: [`to pass '${a}' as a value, use '${commandPath(cmd)} -- ${a}'`] }
          : {}),
        usage: lv.usage(),
      });
    }
    if (lv.positionals.length === 0)
      return fail(`unrecognized subcommand '${a}'`, { usage: lv.usage() });
  }
  return fail(`unexpected argument '${a}' found`, {
    ...(trailingTip ? { tips: [`to pass '${a}' as a value, use '-- ${a}'`] } : {}),
    usage: lv.usage(),
  });
}

/** did_you_mean_error: an unknown `--long`, with a similar flag here or on a subcommand named later. */
function unknownLong(lv: Level, name: string, remaining: string[], trailing: boolean): Stop {
  const longs = lv.flags.flatMap((f) => (f.long ? [f.long] : []));
  let flag: string | undefined = didYouMean(name, longs).pop();
  let inSub: string | undefined;
  if (flag !== undefined) {
    const spec = lv.flags.find((f) => f.long === flag) as Spec;
    if (!lv.matched.has(spec.id)) lv.matched.set(spec.id, { spec, raw: [] });
  } else {
    let best = Number.MAX_SAFE_INTEGER;
    for (const sub of lv.cmd.commands) {
      const subLongs = specsOf(sub).flags.flatMap((f) => (f.long ? [f.long] : []));
      const candidate = didYouMean(name, subLongs).pop();
      if (candidate === undefined) continue;
      const score = remaining.indexOf(sub.name());
      if (score === -1 || score >= best) continue;
      best = score;
      flag = candidate;
      inSub = sub.name();
    }
  }
  const tips: string[] = [];
  const trailingTip = flag === undefined && !trailing && lv.positionals.length > 0;
  if (trailingTip) tips.push(`to pass '--${name}' as a value, use '-- --${name}'`);
  if (flag !== undefined && inSub !== undefined) tips.push(`'${inSub} --${flag}' exists`);
  return fail(`unexpected argument '--${name}' found`, {
    ...(flag !== undefined && inSub === undefined ? { suggestedArg: `--${flag}` } : {}),
    ...(tips.length > 0 ? { tips } : {}),
    usage: lv.usage(lv.present()),
  });
}

/** parse_help_subcommand: `help [COMMAND]...` names commands; anything else is unrecognized. */
function helpSubcommand(cmd: Command, words: string[]): never {
  let target: Command | { helpOf: Command } = cmd;
  for (const w of words) {
    const at: Command | "help" | undefined =
      "helpOf" in target ? undefined : findSubcommand(target, w);
    if (at === undefined) {
      const usage =
        "helpOf" in target ? `${commandPath(target.helpOf)} help [COMMAND]...` : helpUsage(target);
      throw fail(`unrecognized subcommand '${w}'`, { usage, noHelpFlag: "helpOf" in target });
    }
    target = at === "help" ? { helpOf: target as Command } : at;
  }
  if ("helpOf" in target) throw new Stop({ kind: "helpHelp", parent: target.helpOf });
  throw new Stop({ kind: "help", cmd: target, long: true });
}

/** Parses argv (without the binary's name) against the tree whose root is `root`. */
export function parse(root: Command, argv: string[]): Outcome {
  const w: Walk = { levels: [], argv };
  try {
    parseLevel(w, root, 0);
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    throw e;
  }
  const leafLevel = w.levels[w.levels.length - 1] as Level;
  const globals: Globals = { input: true };
  for (const lv of w.levels) {
    for (const m of lv.matched.values()) {
      if (!m.spec.global) continue;
      const o = m.spec.option as Option;
      const name = o.attributeName() as keyof Globals;
      (globals as Record<string, unknown>)[name] = m.spec.takesValue
        ? m.raw[m.raw.length - 1]
        : !o.negate;
    }
  }
  return {
    kind: "run",
    route: ROUTES.get(leafLevel.cmd) as string,
    leaf: leafLevel.cmd,
    args: leafLevel.args(),
    globals,
  };
}
