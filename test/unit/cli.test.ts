// crates/hpy/src/cli.rs and main.rs tests: the command tree and its value parsers.
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { CHECKED_ROUTES } from "../../src/checks.ts";
import { parse as clapParse, didYouMean, jaro, type Outcome } from "../../src/clap.ts";
import { buildCli, checksForUpdates, type Invocation, ROUTES } from "../../src/cli.ts";
import { HANDLERS } from "../../src/commands/index.ts";
import { parseChannel, parseSubnet } from "../../src/values.ts";

/** Parses argv (without `hpy`) the way main does. */
function outcome(argv: string[]): Outcome {
  return clapParse(
    buildCli("0.0.0", () => {}),
    argv,
  );
}

/** The invocation argv names; throws clap's error text for anything else. */
async function parse(argv: string[]): Promise<Invocation> {
  const o = outcome(argv);
  if (o.kind !== "run") throw new Error(o.kind === "error" ? o.text : o.kind);
  return { route: o.route, args: o.args };
}

/** What commander makes of a valid command line: the shape `args` must keep. */
async function commanderParse(argv: string[]): Promise<Invocation> {
  let got: Invocation | undefined;
  const program = buildCli("0.0.0", (i) => {
    got = i;
  });
  const quiet = (c: Command) => {
    c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
    c.commands.forEach(quiet);
  };
  quiet(program);
  await program.parseAsync(argv, { from: "user" });
  if (!got) throw new Error(`no command ran for ${argv.join(" ")}`);
  return got;
}

function* commands(c: Command): Generator<Command> {
  yield c;
  for (const s of c.commands) yield* commands(s);
}

describe("cli.rs", () => {
  it("a_subnet_is_what_atmosphere_in_a_box_accepts", () => {
    for (const ok of ["10.40.0.0/24", "172.31.0.0/16", "192.168.7.16/28"]) {
      expect(parseSubnet(ok)).toBe(ok);
    }
    for (const [bad, says] of [
      ["10.40.0.0", "such as 10.40.0.0/24"],
      ["10.40.0/24", "such as 10.40.0.0/24"],
      ["10.40.0.0/15", "/16 to /28"],
      ["10.40.0.0/29", "/16 to /28"],
      ["172.32.0.0/24", "private"],
      ["8.8.8.0/24", "private"],
      ["10.40.0.1/24", "did you mean 10.40.0.0/24?"],
    ] as const) {
      let err = "";
      try {
        parseSubnet(bad);
      } catch (e) {
        err = String(e);
      }
      expect(err, bad).toContain(says);
    }
  });

  // clap's `debug_assert` has no commander counterpart; this checks what the
  // port relies on instead: unique names and aliases at each level, a route
  // on every leaf, and that every route with rules or a handler exists.
  it("command_tree_is_valid", () => {
    const root = buildCli("0.0.0", () => {});
    const routes = new Set<string>();
    for (const c of commands(root)) {
      const names = c.commands.flatMap((s) => [s.name(), ...s.aliases()]);
      expect(new Set(names).size, `duplicate names under ${c.name()}`).toBe(names.length);
      const longs = c.options.map((o) => o.long).filter((l) => l !== undefined);
      expect(new Set(longs).size, `duplicate options on ${c.name()}`).toBe(longs.length);
      if (c.commands.length === 0 && c !== root) {
        const route = ROUTES.get(c);
        expect(route, `${c.name()} has no route`).toBeDefined();
        expect(routes.has(route as string), `route ${route} is used twice`).toBe(false);
        routes.add(route as string);
      }
    }
    for (const r of [...CHECKED_ROUTES, ...Object.keys(HANDLERS)]) expect(routes).toContain(r);
  });
});

describe("main.rs", () => {
  it("happyview_commands_skip_the_update_check", async () => {
    expect(checksForUpdates((await parse(["hv", "check"])).route)).toBe(false);
    expect(checksForUpdates((await parse(["update"])).route)).toBe(false);
    expect(checksForUpdates((await parse(["registry", "whoami"])).route)).toBe(true);
  });

  // Withdrawing became a lifecycle status and the registry retries copies
  // itself, so neither command is kept as an alias.
  it("withdraw_and_retry_are_gone", async () => {
    for (const gone of ["withdraw", "retry"]) {
      const o = outcome(["registry", "plugin", gone, "1.0.0"]);
      expect(o.kind === "error" && o.text, gone).toContain(`unrecognized subcommand '${gone}'`);
    }
  });

  it("lifecycle_takes_a_version_and_an_event_or_the_project_and_one", async () => {
    let a = (await parse(["registry", "plugin", "lifecycle", "1.0.0", "endOfLife"])).args;
    expect([a.VERSION, a.EVENT, !!a.project]).toEqual(["1.0.0", "endOfLife", false]);
    a = (await parse(["registry", "plugin", "lifecycle", "--project", "endOfLife"])).args;
    expect([a.VERSION, !!a.project]).toEqual(["endOfLife", true]);
    a = (await parse(["registry", "plugin", "lifecycle", "--withdraw", "at://x"])).args;
    expect(a.withdraw).toBe("at://x");
  });
});

describe("clap", () => {
  // The leaf's args keep the shape commander gave them (defaults, `--no-*`, repeatable
  // options, variadic and parsed positionals), which the handlers read.
  it("args_match_what_commander_made_of_them", async () => {
    const lines = [
      ["registry", "whoami"],
      ["registry", "login", "alice.test", "--no-browser"],
      ["registry", "login", "--export"],
      [
        "--json",
        "registry",
        "plugin",
        "init",
        "--name",
        "x",
        "--author",
        "A",
        "--author",
        "B",
        "-y",
      ],
      ["registry", "plugin", "edit", "--keyword", "k", "--remove-keyword", "j", "--name=x"],
      ["registry", "plugin", "publish", "--version", "1.0.0", "--no-build", "--dry-run", "--wait"],
      ["registry", "plugin", "status", "1.0.0"],
      ["registry", "plugin", "lifecycle", "1.0.0", "endOfLife", "--reason", "r", "--kind", "k"],
      ["channel"],
      ["channel", "main", "--yes"],
      [
        "hv",
        "create",
        "--name",
        "d",
        "--interpreter",
        "lua",
        "--interpreter",
        "js",
        "--library",
        "l",
      ],
      ["hv", "dev"],
      ["hv", "dev", "--network", "local", "--reset", "--subnet", "10.40.0.0/24", "--locked"],
      ["hv", "add"],
      ["hv", "install", "lua", "js", "--channel", "beta", "--interpreter"],
      ["hv", "scaffold", "a.b.c", "--collection", "x.y.z"],
      ["hv", "test", "--watch", "f"],
      ["hv", "login", "--url", "https://x", "--no-browser"],
      ["hv", "deploy", "--dry-run", "--prune-plugins", "-y"],
      ["hv", "env", "push", "A", "B", "--env-file", ".env.x"],
      ["hv", "env", "push", "--", "--dry-run"],
      ["hv", "pull", "out", "--legacy", "--api-key-env", "K", "--diff"],
      ["-C", "dir", "--no-input", "hv", "whoami"],
    ];
    for (const argv of lines)
      expect(await parse(argv), argv.join(" ")).toEqual(await commanderParse(argv));
  });

  it("globals_take_the_deepest_occurrence", () => {
    const o = outcome(["-C", "a", "--json", "registry", "whoami", "-C", "b", "--no-input"]);
    expect(o.kind === "run" && o.globals).toEqual({ C: "b", json: true, input: false });
    const bare = outcome(["registry", "whoami"]);
    expect(bare.kind === "run" && bare.globals).toEqual({ input: true });
  });

  it("jaro_matches_strsim", () => {
    expect(jaro("", "")).toBe(1);
    expect(jaro("", "a")).toBe(0);
    expect(jaro("martha", "marhta")).toBeCloseTo(0.944, 3);
    expect(jaro("dixon", "dicksonx")).toBeCloseTo(0.767, 3);
    expect(didYouMean("publ", ["pull", "publish", "status"])).toEqual(["pull", "publish"]);
    expect(didYouMean("tst", ["test", "possible", "values"])).toEqual(["test"]);
  });

  it("errors_and_help_are_clap_s", () => {
    const err = (argv: string[]) => {
      const o = outcome(argv);
      return o.kind === "error" ? o.text : o.kind;
    };
    expect(err(["hv", "deploy", "--url", "a", "--url", "b"])).toBe(
      "error: the argument '--url <URL>' cannot be used multiple times\n\nUsage: hpy happyview deploy [OPTIONS]\n\nFor more information, try '--help'.\n",
    );
    expect(err(["help", "nope"])).toContain("error: unrecognized subcommand 'nope'");
    expect(err(["-hV"])).toBe("help");
    expect(err(["-Vh"])).toBe("version");
    expect(err(["help", "help"])).toBe("helpHelp");
    expect(err(["registry"])).toBe("helpError");
    expect(err(["hv", "who"])).toContain("tip: a similar subcommand exists: 'whoami'");
  });
});

describe("channel.rs", () => {
  it("parses_channel_names_and_main_means_stable", () => {
    expect(parseChannel("stable")).toBe("stable");
    expect(parseChannel("main")).toBe("stable");
    expect(parseChannel("beta")).toBe("beta");
    expect(parseChannel("alpha")).toBe("alpha");
    expect(() => parseChannel("nightly")).toThrow();
  });
});
