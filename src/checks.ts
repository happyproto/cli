// clap's `conflicts_with`, `requires` and `value_parser`s that commander does
// not express the same way, with clap's own wording (exit 2).
import type { Args } from "./cli.ts";

type Rule =
  | { conflicts: [string, string] }
  | { requires: [string, string] }
  /** A positional and an option that cannot both be given. */
  | { conflictsArg: [string, string] };

/** What clap prints for an argument: `--name <VALUE>` for options, `--flag` for flags, `[NAME]` for positionals. */
const DISPLAY: Record<string, Record<string, string>> = {
  "plugin.lifecycle": {
    project: "--project",
    withdraw: "--withdraw <STATUS_URI>",
    supersededBy: "--superseded-by <VERSION>",
    kind: "--kind <KIND>",
  },
  "hv.pull": {
    diff: "--diff",
    dryRun: "--dry-run",
    apiKeyEnv: "--api-key-env <NAME>",
    legacy: "--legacy",
  },
  "hv.add": {
    interpreter: "--interpreter",
    library: "--library",
    channel: "--channel <CHANNEL>",
    version: "--version <VERSION>",
    project: "--project <AT-URI>",
    PLUGIN: "<PLUGIN>...",
  },
  "hv.login": { keyStdin: "--key-stdin", browser: "--no-browser", IDENTIFIER: "[IDENTIFIER]" },
};

const RULES: Record<string, Rule[]> = {
  "plugin.lifecycle": [
    { conflicts: ["withdraw", "project"] },
    { conflicts: ["withdraw", "supersededBy"] },
    { conflicts: ["withdraw", "kind"] },
  ],
  "hv.pull": [{ conflicts: ["diff", "dryRun"] }, { requires: ["apiKeyEnv", "legacy"] }],
  "hv.add": [
    { conflicts: ["interpreter", "library"] },
    { conflicts: ["channel", "version"] },
    { requires: ["channel", "PLUGIN"] },
    { requires: ["version", "PLUGIN"] },
    { requires: ["project", "PLUGIN"] },
  ],
  "hv.login": [
    { conflictsArg: ["keyStdin", "IDENTIFIER"] },
    { conflicts: ["keyStdin", "browser"] },
  ],
};

/** The routes that have rules, for the command-tree test. */
export const CHECKED_ROUTES = Object.keys(RULES);

function given(args: Args, key: string): boolean {
  const v = args[key];
  if (key === "browser") return v === false; // --no-browser
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== false;
}

/** Where on the command line an argument first appears, to name them in clap's order. */
function position(argv: string[], display: string): number {
  const flag = display.split(" ")[0] ?? display;
  if (!flag.startsWith("-")) return Number.MAX_SAFE_INTEGER;
  const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export interface Violation {
  message: string;
  /** clap's usage for the error: the arguments that were used, then the positionals. */
  used: string[];
  /** A positional left out of the usage's "used" set (the one that conflicted). */
  except?: string;
  /** A required positional that was left out: shown as required in the usage. */
  missing?: string;
  /** The argument that conflicted, which clap leaves out of the usage's "used" set. */
  excluded?: string;
}

/** The first violated rule, as clap's error line (without `error: `), or null. */
export function check(route: string, args: Args, argv: string[]): Violation | null {
  const shown = DISPLAY[route] ?? {};
  for (const rule of RULES[route] ?? []) {
    if ("requires" in rule) {
      const [a, b] = rule.requires;
      if (given(args, a) && !given(args, b))
        return {
          message: `the following required arguments were not provided:\n  ${shown[b] ?? b}`,
          // clap lists the missing argument first, then the one that needs it.
          used: [...(shown[b]?.startsWith("-") ? [shown[b] as string] : []), shown[a] ?? a],
          ...(shown[b]?.startsWith("-") ? {} : { missing: b }),
        };
      continue;
    }
    const [a, b] = "conflicts" in rule ? rule.conflicts : rule.conflictsArg;
    if (given(args, a) && given(args, b)) {
      const da = shown[a] ?? a;
      const db = shown[b] ?? b;
      const [first, second] = position(argv, da) <= position(argv, db) ? [da, db] : [db, da];
      const firstKey = first === da ? a : b;
      const isArg = (k: string) => !(shown[k] ?? "-").startsWith("-");
      return {
        message: `the argument '${first}' cannot be used with '${second}'`,
        used: isArg(firstKey) ? [] : [first],
        except: [a, b].find(isArg),
        excluded: second,
      };
    }
  }
  return null;
}

/** The arguments that the given ones `require`: clap shows them as required in a usage line. */
export function requiredBy(route: string, args: Args): string[] {
  const out: string[] = [];
  for (const rule of RULES[route] ?? []) {
    if ("requires" in rule && given(args, rule.requires[0])) out.push(rule.requires[1]);
  }
  return out;
}
