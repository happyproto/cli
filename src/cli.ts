// crates/hpy/src/cli.rs: the command tree, with clap's help text, conflicts and
// requirements, in commander. Each leaf names its handler in `route`; main.ts
// dispatches on it. Positional arguments land in `args` under their clap names.
import { Argument, Command, Option } from "commander";
import { parseChannel, parseSubnet, valueParser } from "./values.ts";

export type Args = Record<string, unknown>;
export type Invocation = { route: string; args: Args };

/** Each leaf's route, for checks over the whole tree. */
export const ROUTES = new WeakMap<Command, string>();

/**
 * main.rs `checks_for_updates`: whether the daily update check runs around
 * this route. `update` and `channel` do it themselves, and say so. `happyview`
 * ends by becoming the HappyView binary, so a check started there would record
 * the day as checked and then be lost with its notice.
 */
export function checksForUpdates(route: string): boolean {
  return !(route === "update" || route === "channel" || route.startsWith("hv."));
}

function leaf(
  parent: Command,
  name: string,
  about: string,
  route: string,
  sink: (i: Invocation) => void,
): Command {
  const c = parent.command(name).description(about);
  ROUTES.set(c, route);
  c.action((...xs: unknown[]) => {
    const cmd = xs[xs.length - 1] as Command;
    const args: Args = { ...cmd.opts() };
    cmd.registeredArguments.forEach((a, i) => {
      args[a.name()] = cmd.processedArgs[i];
    });
    sink({ route, args });
  });
  return c;
}

/** A command that only groups others: without a subcommand it prints its help to stderr, exit 2. */
function group(parent: Command, name: string, about: string): Command {
  // No action: commander prints the help to stderr and fails (`commander.help`),
  // and an unknown word is `commander.unknownCommand`, as clap does.
  return parent.command(name).description(about);
}

export class UsageExit extends Error {}

const yes = () => new Option("-y, --yes", "Do not ask for confirmation.");
const nameOpt = () =>
  new Option(
    "--name <NAME>",
    "Project name (default: hpy.toml [project] name, then manifest.json id).",
  );
const urlOpt = () =>
  new Option(
    "--url <URL>",
    "The instance, e.g. https://api.example.com (default: HPY_HV_URL, else the only one you are signed in to).",
  );
const collect = (v: string, prev: string[] = []) => [...prev, v];

function profileFields(c: Command): Command {
  return c
    .option("--display-name <DISPLAY_NAME>", "The name people see (the publication's name).")
    .option("--description <DESCRIPTION>", "One-line description.")
    .option("--author <AUTHOR>", "Author as `Name <email> (url)`; repeatable.", collect, [])
    .option("--security <CONTACT>", "Security contact (email or URL); repeatable.", collect, [])
    .option("--keyword <KEYWORD>", "Keyword; repeatable.", collect, []);
}

const runArgs = (c: Command) =>
  c.option(
    "--locked",
    "Fail rather than update happyview.lock when it no longer matches happyview.toml.",
  );

export function buildCli(version: string, sink: (i: Invocation) => void): Command {
  const hpy = new Command("hpy")
    .description("The HappyProto command line")
    .helpOption("-h, --help", "Print help")
    .option("--json", "Print the result as JSON on stdout.")
    .option(
      "--no-input",
      "Never prompt; fail when a value is missing. Irreversible actions still need --yes. Implied without a terminal.",
    )
    .option("-C <DIR>", "Run as if started in DIR.")
    .showSuggestionAfterError(false);

  // registry
  const registry = group(hpy, "registry", "Work with the HappyProto plugin registry.");
  leaf(
    registry,
    "login",
    "Sign in to the registry with your atproto account.",
    "registry.login",
    sink,
  )
    .argument("[IDENTIFIER]", "Your handle or DID.")
    .option(
      "--export",
      "Sign in for CI: print a credential to store as the HPY_CREDENTIAL secret instead of saving it here. It is its own session, revocable on its own.",
    )
    .option("--no-browser", "Print the authorization URL instead of opening a browser.");
  leaf(
    registry,
    "logout",
    "Sign out of the registry and forget stored credentials.",
    "registry.logout",
    sink,
  );
  leaf(
    registry,
    "whoami",
    "Show who you are signed in to the registry as.",
    "registry.whoami",
    sink,
  );

  const plugin = group(registry, "plugin", "Manage your HappyView plugins in the registry.");
  profileFields(
    leaf(
      plugin,
      "init",
      "Write hpy.toml's [project] and create the plugin's project in the registry.",
      "plugin.init",
      sink,
    ).addOption(nameOpt()),
  )
    .option("--local-only", "Only write hpy.toml; do not create the project.")
    .addOption(yes());
  leaf(
    plugin,
    "show",
    "Show the plugin's project as the registry has it.",
    "plugin.show",
    sink,
  ).addOption(nameOpt());
  profileFields(
    leaf(
      plugin,
      "edit",
      "Edit the plugin's project in the registry.",
      "plugin.edit",
      sink,
    ).addOption(nameOpt()),
  ).option("--remove-keyword <KEYWORD>", "Remove a keyword; repeatable.", collect, []);
  leaf(
    plugin,
    "pull",
    "Copy the plugin's project from the registry into hpy.toml's [project].",
    "plugin.pull",
    sink,
  ).addOption(nameOpt());
  leaf(
    plugin,
    "publish",
    "Publish the plugin in the current directory as a new version.",
    "plugin.publish",
    sink,
  )
    .option(
      "--wasm <WASM>",
      "Path to the built .wasm module, relative to the plugin's directory (-C).",
    )
    .option("--version <VERSION>", "Version to publish (default: manifest.json version).")
    .option(
      "--track <TRACK>",
      "The channel to move to this version: latest, beta or alpha (default: latest for a stable version, else the prerelease's name).",
    )
    .option(
      "--promote <FROM_VERSION>",
      "Publish an already published version's artifact as --version instead of building one.",
    )
    .option("--dry-run", "Validate and print what would be published without publishing.")
    .option("--no-build", "Skip hpy.toml [build] command.")
    .option("--wait", "Wait until the registry has copied the version's blobs.")
    .addOption(yes());
  leaf(
    plugin,
    "status",
    "Show what the registry knows about this plugin's versions.",
    "plugin.status",
    sink,
  )
    .argument("[VERSION]", "A single version to inspect.")
    .addOption(nameOpt());
  leaf(
    plugin,
    "lifecycle",
    "Record a lifecycle event (end of support, end of life, …) for a version or the whole project.",
    "plugin.lifecycle",
    sink,
  )
    .argument("[VERSION]", "The version the event is about; with --project, the event itself.")
    .argument(
      "[EVENT]",
      "endOfDevelopment, endOfSupport, supersededBy, endOfDistribution or endOfLife.",
    )
    .option("--project", "The event is about the whole project rather than one version.")
    .option("--kind <KIND>", "What kind of event it is, in your own words (e.g. security).")
    .option("--reason <REASON>", "Why, for the people running it.")
    .option("--superseded-by <VERSION>", "The version to move to (with supersededBy).")
    .addOption(
      new Option(
        "--withdraw <STATUS_URI>",
        "Withdraw a status recorded in error, by its at:// URI.",
      ),
    )
    .addOption(nameOpt())
    .addOption(yes());

  // update, channel
  leaf(hpy, "update", "Update hpy to the newest release on your channel.", "update", sink);
  leaf(hpy, "channel", "Show or choose the release channel hpy updates from.", "channel", sink)
    .addArgument(
      new Argument(
        "[CHANNEL]",
        "stable (also `main`), beta or alpha. Shows the current channel when omitted.",
      ).argParser(valueParser("[CHANNEL]", parseChannel)),
    )
    .addOption(yes());

  // happyview
  const hv = group(
    hpy,
    "happyview",
    "Build HappyView apps: a project directory, run and tested locally.",
  ).alias("hv");
  leaf(hv, "create", "Scaffold a new HappyView project.", "hv.create", sink)
    .requiredOption("--name <DIR>", "Directory to create, relative to the current one.")
    .option(
      "--superadmin <DID>",
      "The superadmin's DID (default: the account `hpy registry login` holds).",
    )
    .option(
      "--interpreter <LANGUAGE>",
      "Interpreter language id; repeatable (default: lua).",
      collect,
      [],
    )
    .option("--library <LIBRARY>", "Library namespace or project name; repeatable.", collect, [])
    .option(
      "--project <AT-URI>",
      "The registry project to use for the interpreter or library it answers to, when several do; repeatable.",
      collect,
      [],
    )
    .option("--app-name <APP_NAME>", "The app's display name (default: the directory name).")
    .option(
      "--happyview-version <VERSION>",
      "HappyView version to pin (default: the newest with a binary for this machine).",
    );
  runArgs(
    leaf(
      hv,
      "dev",
      "Run the project with its pinned HappyView; a saved file is live on the next request.",
      "hv.dev",
      sink,
    ),
  )
    .addOption(
      new Option("--network <NETWORK>", "Which atproto network to run against.")
        .choices(["real", "local"])
        .default("real"),
    )
    .option(
      "--reset",
      "Discard the local network's accounts, records and database, then start fresh.",
    )
    .option(
      "--subnet <CIDR>",
      "The private IPv4 network the local network is created on, when the one derived from the project's path is taken. Kept until another is given.",
      valueParser("--subnet <CIDR>", parseSubnet),
    )
    .addOption(yes());
  leaf(
    hv,
    "add",
    "Add plugins to happyview.toml and happyview.lock and download them; with none, bring the lock up to date and download it.",
    "hv.add",
    sink,
  )
    .alias("install")
    .argument(
      "[PLUGIN...]",
      "A language id (interpreters) or a namespace or project name (libraries).",
    )
    .addOption(new Option("--interpreter", "Treat every PLUGIN as an interpreter."))
    .option("--library", "Treat every PLUGIN as a library.")
    .addOption(
      new Option(
        "--channel <CHANNEL>",
        "Follow this channel: latest, beta or alpha (default: latest, else the only channel there is).",
      ),
    )
    .option("--version <VERSION>", "Pin this exact version instead of following a channel.")
    .option("--project <AT-URI>", "The registry project to use, when several answer to one name.");
  leaf(
    hv,
    "scaffold",
    "Write a starter handler beside each query or procedure lexicon under src/ that has none.",
    "hv.scaffold",
    sink,
  )
    .argument(
      "[NSID...]",
      "Only these query or procedure lexicons (default: every one without a handler).",
    )
    .option(
      "--collection <NSID>",
      "The collection every handler written reads or writes (default: asked for each, else the placeholder COLLECTION).",
    );
  leaf(
    hv,
    "build",
    "Build every compiled script module in happyview.toml into .happyview/build/.",
    "hv.build",
    sink,
  );
  runArgs(
    leaf(
      hv,
      "check",
      "Build the project's snapshot without serving it; exits non-zero on any error.",
      "hv.check",
      sink,
    ),
  );
  runArgs(leaf(hv, "test", "Run the project's tests.", "hv.test", sink))
    .option("--watch", "Rerun the affected tests whenever the project changes.")
    .argument("[FILTER]", "Only run test files whose path contains this.");
  runArgs(
    leaf(
      hv,
      "types",
      "Write editor types for the project into .happyview/types/, and the tsconfig.json or .luarc.json that points editors at them.",
      "hv.types",
      sink,
    ),
  );
  leaf(
    hv,
    "login",
    "Sign in to a HappyView instance through your browser, to deploy to it.",
    "hv.login",
    sink,
  )
    .argument(
      "[IDENTIFIER]",
      "Your handle or DID (default: the account `hpy registry login` holds).",
    )
    .option("--url <URL>", "The instance, e.g. https://api.example.com.")
    .option("--no-browser", "Print the authorization URL instead of opening a browser.")
    .addOption(
      new Option(
        "--key-stdin",
        "For CI: sign in with an API key from the instance's dashboard, read from standard input, instead of through the browser.",
      ),
    );
  leaf(hv, "logout", "Sign out of an instance.", "hv.logout", sink).addOption(urlOpt());
  leaf(hv, "whoami", "Show the instances you are signed in to.", "hv.whoami", sink);
  leaf(
    hv,
    "deploy",
    "Make an instance match the project: its plugins from happyview.lock, then its lexicons, scripts and modules.",
    "hv.deploy",
    sink,
  )
    .addOption(urlOpt())
    .option("--dry-run", "Show what would change on the instance without changing it.")
    .option(
      "--prune-plugins",
      "Also uninstall interpreters and libraries that happyview.lock doesn't list.",
    )
    .addOption(yes());
  const env = group(
    hv,
    "env",
    "Work with the deployed instance's script variables, which scripts read as `ctx.env`.",
  );
  leaf(
    env,
    "push",
    "Send keys from the project's .env to the instance's script variables, asking before each.",
    "hv.env.push",
    sink,
  )
    .argument("[KEY...]", "Only these keys; each must be in the file (default: every key in it).")
    .addOption(urlOpt())
    .option(
      "--env-file <PATH>",
      "Read the keys from this file instead of .env in the project root.",
    )
    .option("--dry-run", "List each key as new or replacing an existing one, and send nothing.")
    .addOption(new Option("-y, --yes", "Send every key without asking."));
  leaf(
    hv,
    "pull",
    "Build a project from what an instance serves: its lexicons, scripts, plugins and settings.",
    "hv.pull",
    sink,
  )
    .argument(
      "[DIR]",
      "Directory to create, relative to the current one (default: one named after the instance's host).",
    )
    .addOption(urlOpt())
    .option(
      "--legacy",
      "The instance runs HappyView v2: sign in with an API key and rewrite each script for v3.",
    )
    .option(
      "--api-key-env <NAME>",
      "With --legacy, the environment variable holding the v2 API key (default: HAPPYVIEW_API_KEY); without it, the key is asked for.",
    )
    .addOption(
      new Option(
        "--diff",
        "Compare the instance with the project in DIR and print a unified diff; writes nothing.",
      ),
    )
    .option(
      "--dry-run",
      "Print the files and the happyview.toml a pull would write, and write nothing.",
    );

  return hpy;
}
