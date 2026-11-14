// commands/happyview/create.rs: `hpy happyview create`: a new project, with its
// happyview.toml resolved into happyview.lock before anything is written, and nothing
// downloaded.
import { readdirSync, realpathSync, statSync } from "node:fs";
import * as session from "../atproto/session.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import type { Json } from "../core/output.ts";
import { rustComponents, rustFileName, rustJoin } from "../core/paths.ts";
import { trim } from "../core/rust-str.ts";
import { Version } from "../core/semver.ts";
import { compareKeys } from "../core/serde-json.ts";
import { parseProjectUri } from "../plugin/validate.ts";
import { HOST_TARGET, httpClient, latestVersion, ReleaseSource } from "../project/binary.ts";
import {
  entryProjectUri,
  Pin,
  type PluginEntry,
  PluginKind,
  ProjectToml,
  sortedEntries,
} from "../project/config.ts";
import { editorFiles } from "../project/editor.ts";
import { LOCK_FILE, type Lockfile } from "../project/lock.ts";
import { chooseWithPrompter } from "../project/prepare.ts";
import { type Candidate, type Choose, candidates, resolveLock } from "../project/resolve.ts";
import { renderScaffold, starterHandler, writeNew } from "../project/scaffold.ts";
import { envVar } from "../update.ts";
import { who } from "./auth.ts";

const isAsciiAlphanumeric = (c: string) => /^[A-Za-z0-9]$/.test(c);

/** atproto's DID syntax, which HappyView checks `superadmin` against at boot. */
export function checkDid(s: string): string | null {
  const bad = `\`${s}\` is not a DID`;
  if (Buffer.byteLength(s, "utf8") > 2048) return bad;
  if (!s.startsWith("did:")) return bad;
  const rest = s.slice(4);
  const colon = rest.indexOf(":");
  if (colon < 0) return bad;
  const method = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  const methodOk = method !== "" && /^[a-z]+$/.test(method);
  const last = id.at(-1);
  const idOk =
    [...id].every((c) => isAsciiAlphanumeric(c) || ".-_:%".includes(c)) &&
    last !== undefined &&
    last !== ":" &&
    last !== "%";
  return methodOk && idOk ? null : bad;
}

function checkName(s: string): string | null {
  return trim(s) === "" ? "must not be empty" : null;
}

function checkVersion(s: string): string | null {
  try {
    Version.parse(s);
    return null;
  } catch (e) {
    return `\`${s}\` is not a version: ${(e as Error).message}`;
  }
}

/** Lua first, since it is preselected and its handler is the starter's, then the rest in name order. */
export function orderLanguages(found: readonly string[]): string[] {
  const rest = [...new Set(found.filter((l) => l !== "lua"))].sort(compareKeys);
  return [...(found.includes("lua") ? ["lua"] : []), ...rest];
}

/** A `BTreeMap<(PluginKind, String), String>` key. */
const pinKey = (kind: PluginKind, key: string) => `${kind}\u0000${key}`;
export type Pins = Map<string, string>;

/**
 * Which chosen key each `--project` answers. One that answers none, or a key two of them
 * answer, is refused rather than guessed at. Throws `Failure`.
 */
export function matchProjects(
  projects: readonly string[],
  chosen: readonly (readonly [PluginKind, readonly string[], readonly Candidate[]])[],
): Pins {
  const pins: Pins = new Map();
  for (const uri of projects) {
    let answered = false;
    for (const [kind, keys, found] of chosen) {
      for (const key of keys) {
        if (!found.some((c) => c.project === uri && c.answers(kind, key))) continue;
        answered = true;
        const k = pinKey(kind, key);
        const other = pins.get(k);
        pins.set(k, uri);
        if (other !== undefined)
          throw Failure.usage(`--project: ${other} and ${uri} both answer to \`${key}\`; pass one`);
      }
    }
    if (!answered)
      throw Failure.usage(
        `--project: ${uri} answers to none of the chosen interpreters or libraries`,
      );
  }
  return pins;
}

/**
 * The libraries to add: `--library` values, each a namespace or a project name as `add`
 * takes them, else a choice among the namespaces found.
 */
async function chooseLibraries(
  ctx: Ctx,
  given: string[],
  found: readonly Candidate[],
): Promise<string[]> {
  const keys = [...new Set(found.map((c) => c.key("library")))].sort(compareKeys);
  if (given.length === 0) return ctx.prompter.multi("--library", "Libraries:", given, keys, []);
  // With nothing found, resolution names the one nobody answers to.
  if (found.length > 0) {
    const bad = given.find((v) => !found.some((c) => c.answers("library", v)));
    if (bad !== undefined)
      throw Failure.usage(`--library: \`${bad}\` is not one of ${keys.join(", ")}`);
  }
  return given;
}

/** The entry each key gets: the project that answers to it, following its channel as `add` would. */
export async function pick(
  kind: PluginKind,
  keys: readonly string[],
  found: readonly Candidate[],
  pins: Pins,
  choose: Choose,
): Promise<Map<string, PluginEntry>> {
  const out = new Map<string, PluginEntry>();
  for (const key of keys) {
    const pinned = pins.get(pinKey(kind, key));
    const matches = found.filter(
      (c) => c.answers(kind, key) && (pinned === undefined || c.project === pinned),
    );
    let chosen: Candidate;
    if (matches.length === 0)
      throw Failure.usage(
        `no ${PluginKind.pluginType(kind)} in the registry answers to \`${key}\``,
      );
    else if (matches.length === 1) chosen = matches[0]!;
    else {
      const i = await choose(key, matches);
      const c = matches[i];
      if (c === undefined) throw new Error(`index ${i} out of bounds`);
      chosen = c;
    }
    out.set(key, { did: chosen.did, name: chosen.name, pin: Pin.channel(chosen.channel) });
  }
  return out;
}

/** The `--json` answer. */
export function report(dir: string, version: string, toml: ProjectToml, lock: Lockfile): Json {
  const entries = (table: Map<string, PluginEntry>): Json => {
    const out: { [key: string]: Json } = {};
    for (const [key, e] of sortedEntries(table)) {
      out[key] =
        e.pin.kind === "channel"
          ? { project: entryProjectUri(e), channel: e.pin.channel }
          : { project: entryProjectUri(e), version: e.pin.version };
    }
    return out;
  };
  return {
    dir,
    happyview: version,
    interpreters: entries(toml.interpreters),
    libraries: entries(toml.libraries),
    plugins: lock.plugins.map((p) => ({ id: p.id, version: p.version })),
  };
}

function isNonDirectory(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isNonEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

async function signedIn(ctx: Ctx): Promise<[string, string | undefined] | undefined> {
  try {
    const s = await session.current(ctx.settings, await ctx.keystore());
    return s === null ? undefined : [s.credential.did, s.credential.handle ?? undefined];
  } catch {
    return undefined;
  }
}

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const name = args.name as string;
  const projects = (args.project as string[] | undefined) ?? [];
  const dir = rustJoin(ctx.dir, name);
  if (isNonDirectory(dir)) throw Failure.usage(`${dir} already exists and is not a directory`);
  if (isNonEmptyDirectory(dir)) throw Failure.usage(`${dir} already exists and is not empty`);
  const badUri = projects.find((u) => parseProjectUri(u) === null);
  if (badUri !== undefined)
    throw Failure.usage(
      `--project: \`${badUri}\` is not an at://<did>/software.release.project/<name> URI`,
    );
  const me = await signedIn(ctx);
  const help = me && `${who(me[0], me[1])}, the account \`hpy registry login\` holds`;
  const superadmin = await ctx.prompter.requiredWithHelp(
    "--superadmin",
    "Superadmin DID:",
    args.superadmin as string | undefined,
    me?.[0],
    help,
    checkDid,
  );
  // Only the signed-in account's handle is known without asking the network.
  const superadminHandle = me !== undefined && me[0] === superadmin ? me[1] : undefined;
  const registry = ctx.registry();
  const interpretersFound = await candidates(registry, "interpreter");
  const languages = orderLanguages(interpretersFound.map((c) => c.key("interpreter")));
  const interpreters = await ctx.prompter.multi(
    "--interpreter",
    "Interpreters:",
    (args.interpreter as string[] | undefined) ?? [],
    languages,
    ["lua"],
  );
  if (interpreters.length === 0)
    throw Failure.usage("choose at least one interpreter: without one, no script can run");
  const librariesFound = await candidates(registry, "library");
  const libraries = await chooseLibraries(
    ctx,
    (args.library as string[] | undefined) ?? [],
    librariesFound,
  );
  // `--name .` names the directory it is run in.
  let canonical = dir;
  try {
    canonical = realpathSync(dir);
  } catch {}
  const appName = await ctx.prompter.required(
    "--app-name",
    "App name:",
    args.appName as string | undefined,
    rustFileName(canonical),
    checkName,
  );
  let version: string;
  const given = args.happyviewVersion as string | undefined;
  if (given !== undefined) {
    const e = checkVersion(given);
    if (e !== null) throw Failure.usage(`--happyview-version: ${e}`);
    version = given;
  } else {
    version = await latestVersion(httpClient(), ReleaseSource.fromEnv(envVar), HOST_TARGET);
  }

  // Resolve before writing, so a refusal leaves no half-made project behind.
  const pins = matchProjects(projects, [
    ["interpreter", interpreters, interpretersFound],
    ["library", libraries, librariesFound],
  ]);
  const choose = chooseWithPrompter(ctx);
  const interpreterEntries = await pick(
    "interpreter",
    interpreters,
    interpretersFound,
    pins,
    choose,
  );
  const libraryEntries = await pick("library", libraries, librariesFound, pins, choose);
  const wanted = new ProjectToml({
    happyview: { version },
    interpreters: interpreterEntries,
    libraries: libraryEntries,
  });
  const lock = await resolveLock(
    { registry, warn: (m) => ctx.out.status(`warning: ${m}`) },
    wanted,
    null,
  );
  const handlerLanguage = interpreters[0];
  const files = renderScaffold({
    appName,
    superadmin,
    happyviewVersion: version,
    interpreters: interpreterEntries,
    libraries: libraryEntries,
    handlerLanguage,
  });
  files.push([LOCK_FILE, lock.render()]);
  files.push(...editorFiles(interpreters));
  // The directory was checked as absent or empty above, so a failure here is the disk's
  // rather than the user's.
  try {
    writeNew(dir, files);
  } catch (e) {
    throw Failure.runtime(String(e));
  }
  if (handlerLanguage !== undefined && starterHandler(handlerLanguage) === undefined)
    ctx.out.status(
      `hpy has no starter handler for \`${handlerLanguage}\`; add one beside src/lexicons/com/example/hello.json`,
    );
  let human = `created ${dir}\n  superadmin: ${who(superadmin, superadminHandle)}`;
  for (const [key, e] of [...sortedEntries(interpreterEntries), ...sortedEntries(libraryEntries)]) {
    if (e.pin.kind === "channel" && e.pin.channel !== "latest")
      human += `\n  \`${key}\` has no latest channel, so happyview.toml follows its ${e.pin.channel} channel`;
  }
  human += "\n\n";
  const components = rustComponents(name);
  if (!(components.length === 1 && components[0] === ".")) human += `  cd ${name}\n`;
  human += "  hpy happyview dev";
  ctx.out.done(human, report(dir, version, wanted, lock));
}
