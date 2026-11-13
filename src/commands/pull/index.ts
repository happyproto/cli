// commands/happyview/pull/mod.rs: `hpy happyview pull`: a v3 project built from what an
// instance serves.
//
// The source is the instance's live state, read through its admin API, not the bundle
// `GET /admin/project` last deployed: an edit made in the dashboard since would otherwise be
// lost. A v2 instance (`--legacy`) is read the same way, with an API key, and each of its
// scripts rewritten for v3 by the `happyview-codemod` of the HappyView the project pins.
//
// Never pulled: script variable values (only their keys, as empty lines in `.env.example`),
// plugin secrets (`/plugins/{id}/secrets` is never called; the names they need are listed),
// and the sign-in itself.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { Admin } from "../../atproto/admin.ts";
import { AtprotoError } from "../../atproto/error.ts";
import { checkKey, normalizeUrl } from "../../atproto/instance.ts";
import type { Registry, VersionView } from "../../atproto/registry.ts";
import type { Args } from "../../cli.ts";
import type { Ctx } from "../../core/ctx.ts";
import { Failure } from "../../core/failure.ts";
import { ioErrorText } from "../../core/io.ts";
import type { Json } from "../../core/output.ts";
import { rustJoin } from "../../core/paths.ts";
import { trim, trimEnd } from "../../core/rust-str.ts";
import { Version } from "../../core/semver.ts";
import {
  array,
  compareKeys,
  type Decoder,
  fromValueNode,
  type Node,
  toStringPretty,
} from "../../core/serde-json.ts";
import { artifactFromValue, type PluginArtifact } from "../../plugin/artifact.ts";
import {
  ensureCodemod,
  HOST_TARGET,
  httpClient,
  latestVersion,
  ReleaseSource,
} from "../../project/binary.ts";
import { bundle } from "../../project/bundle.ts";
import { cacheRoot } from "../../project/cache.ts";
import {
  CONFIG_FILE,
  Pin,
  type PluginEntry,
  type PluginKind,
  ProjectToml,
} from "../../project/config.ts";
import { editorFiles } from "../../project/editor.ts";
import { LOCK_FILE } from "../../project/lock.ts";
import { buildAll, Toolchain } from "../../project/modules.ts";
import {
  chooseWithPrompter,
  PrepareOptions,
  prepareAt,
  REMOVED_ENV,
} from "../../project/prepare.ts";
import { type Candidate, candidates, resolveLock } from "../../project/resolve.ts";
import {
  GITIGNORE,
  type LexiconSettings,
  type ModuleSettings,
  ProjectFile,
  type ScriptSettings,
  writeNew,
} from "../../project/scaffold.ts";
import * as instance from "../instance.ts";
import { missingHandlerWarnings } from "../scaffold.ts";
import { rewrite } from "./codemod.ts";
import { diffTrees } from "./diff.ts";
import * as map from "./map.ts";
import * as wire from "./wire.ts";

/**
 * The publisher HappyView treats as official (`plugin/official_registry.rs`,
 * `OFFICIAL_PUBLISHER_DID`). A v2 plugin was a URL install offered by it, so its registry
 * project is this DID's project of the same name.
 */
export const OFFICIAL_PUBLISHER_DID = "did:plc:mo7vq4jbioxwafy5zkcc3eux";

/** Where `--legacy` reads the v2 API key when `--api-key-env` names none. */
export const DEFAULT_KEY_VAR = "HAPPYVIEW_API_KEY";

/** What a v2 key needs for a whole pull, in v2's own names. Network lexicons are read under `lexicons:read`. */
export const LEGACY_PERMISSIONS =
  "lexicons:read, scripts:read, script-variables:read, plugins:read, labelers:read, users:read and settings:manage";

export type Generation = "v2" | "v3";

/** `trim().trim_start_matches('v')`. */
function bare(version: string): string {
  let v = trim(version);
  while (v.startsWith("v")) v = v.slice(1);
  return v;
}

/** The major version `/config` reports: 2 and below are v2. */
export function generation(version: string): Generation | undefined {
  let v: Version;
  try {
    v = Version.parse(bare(version));
  } catch {
    return undefined;
  }
  return v.major < 3n ? "v2" : "v3";
}

/** The HappyView version an instance runs, from its public `/config`, which v2 and v3 both serve with a `version`. */
async function servedVersion(url: string): Promise<string | undefined> {
  try {
    const resp = await httpClient().request(`${url}/config`, { timeout: 30 });
    if (!resp.ok) return undefined;
    const config = (await resp.json()) as unknown;
    const v =
      config !== null && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>).version
        : undefined;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Everything read from the instance. */
export interface Remote {
  lexicons: wire.Lexicon[];
  network: string[];
  scripts: wire.Script[];
  variables: string[];
  plugins: wire.Plugin[];
  /** Undefined when the sign-in may not read settings; `{ name: undefined }` when there is none. */
  appName: { name: string | undefined } | undefined;
  superadmin: string | undefined;
  labelers: string[];
  /** The files scripts import, or why the instance didn't give them. */
  modules: { ok: wire.ModuleSource[] } | { err: string };
}

function parse<T>(base: string, what: string, v: Node, decoder: Decoder<T>): T {
  try {
    return fromValueNode(v, decoder);
  } catch (e) {
    throw Failure.runtime(`${base} answered ${what} unreadably: ${(e as Error).message}`);
  }
}

async function get<T>(admin: Admin, what: string, path: string, decoder: Decoder<T>): Promise<T> {
  let v: Node;
  try {
    v = await admin.getNode(what, path);
  } catch (e) {
    throw Failure.from(e);
  }
  return parse(admin.base, what, v, decoder);
}

/**
 * The interpreter modules a v3 instance serves (`GET /admin/scripts/modules`), or the warning
 * to give when it serves none: an older HappyView has no such route, and a sign-in without
 * `scripts:read` may not read it.
 */
async function readModules(admin: Admin): Promise<Remote["modules"]> {
  const what = "listing interpreter modules";
  let got: Awaited<ReturnType<Admin["getNodeOptional"]>>;
  try {
    got = await admin.getNodeOptional(what, "/scripts/modules");
  } catch (e) {
    throw Failure.from(e);
  }
  switch (got.kind) {
    case "read":
      return { ok: parse(admin.base, what, got.value, array(wire.MODULE_SOURCE)) };
    case "notServed":
      return {
        err: "this HappyView doesn't serve interpreter module source, so files scripts import (such as src/lib/…) aren't pulled; copy them in by hand",
      };
    case "notPermitted":
      return {
        err: "the sign-in can't read interpreter module source (that needs scripts:read), so files scripts import (such as src/lib/…) aren't pulled",
      };
  }
}

/** `Vec::sort` then `dedup` of strings. */
const sortedUnique = (xs: string[]) =>
  xs
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .filter((x, i, all) => i === 0 || all[i - 1] !== x);

async function read(admin: Admin, gen: Generation): Promise<Remote> {
  const lexicons = await get(admin, "listing lexicons", "/lexicons", array(wire.LEXICON));
  for (const l of lexicons) {
    if (wire.isNetwork(l)) continue;
    // An id that can't be a path is never asked for; it's reported later.
    try {
      map.lexiconPath(l.id);
    } catch {
      continue;
    }
    const full = await get(admin, `reading lexicon ${l.id}`, `/lexicons/${l.id}`, wire.LEXICON);
    l.lexicon_json = full.lexicon_json;
    l.target_collection = full.target_collection ?? l.target_collection;
  }
  const network = sortedUnique([
    ...(
      await get(admin, "listing network lexicons", "/network-lexicons", array(wire.NETWORK_LEXICON))
    ).map((n) => n.nsid),
    ...lexicons.filter(wire.isNetwork).map((l) => l.id),
  ]);
  const scripts = await get(admin, "listing scripts", "/scripts", array(wire.SCRIPT));
  const variables = (
    await get(admin, "listing script variables", "/script-variables", array(wire.VARIABLE))
  )
    .map((v) => v.key)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const plugins = (await get(admin, "listing plugins", "/plugins", wire.PLUGIN_LIST)).plugins;
  let settings: Node | undefined;
  try {
    settings = await admin.getNodeIfPermitted("reading settings", "/settings");
  } catch (e) {
    throw Failure.from(e);
  }
  let appName: Remote["appName"];
  if (settings !== undefined) {
    const found = parse(admin.base, "reading settings", settings, array(wire.SETTING)).find(
      (s) => s.key === "app_name",
    );
    appName = { name: found && trim(found.value) !== "" ? found.value : undefined };
  }
  const superadmin = (await get(admin, "listing users", "/users", array(wire.USER))).find(
    (u) => u.is_super,
  )?.did;
  const labelers = (await get(admin, "listing labelers", "/labelers", array(wire.LABELER)))
    .filter((l) => l.status === "active")
    .map((l) => l.did);
  // v2 has no project, so nothing for scripts to import.
  const modules = gen === "v3" ? await readModules(admin) : { ok: [] };
  return { lexicons, network, scripts, variables, plugins, appName, superadmin, labelers, modules };
}

/** What pull says beside the files it writes. */
export class Report {
  warnings: string[] = [];
  /** Files a person has to finish: the codemod marked them or refused them. */
  handEdits: string[] = [];
  /** `plugin: KEY, KEY`, to set once the project is deployed. */
  secrets: string[] = [];
  /** Compiled modules, whose source the instance doesn't hold. */
  modules: string[] = [];

  warn(m: string): void {
    this.warnings.push(m);
  }
}

/** The plugin tables, and the extension each interpreter's files take. */
class Plugins {
  interpreters = new Map<string, PluginEntry>();
  libraries = new Map<string, PluginEntry>();
  extensions = new Map<string, string>();

  add(kind: PluginKind, key: string, entry: PluginEntry, a: PluginArtifact | undefined): void {
    const ext = a?.fileExtensions[0];
    if (kind === "interpreter" && ext !== undefined) this.extensions.set(key, ext);
    (kind === "interpreter" ? this.interpreters : this.libraries).set(key, entry);
  }
}

function pluginKind(t: string): PluginKind | undefined {
  return t === "interpreter" || t === "library" ? t : undefined;
}

function artifact(view: VersionView | null): PluginArtifact | undefined {
  if (!view) return undefined;
  try {
    return artifactFromValue(view.artifact);
  } catch {
    return undefined;
  }
}

function secretsLine(pl: wire.Plugin): string | undefined {
  if (pl.required_secrets.length === 0) return undefined;
  return `${pl.id}: ${pl.required_secrets.map((s) => s.key).join(", ")}`;
}

const failing = async <T>(body: () => Promise<T>): Promise<T> => {
  try {
    return await body();
  } catch (e) {
    throw Failure.from(e);
  }
};

/**
 * A v3 instance's plugins, as the registry projects they were installed from. A URL or file
 * install with no project has no place in `happyview.toml`, and is left out with a warning.
 */
async function v3Plugins(reg: Registry, list: wire.Plugin[], report: Report): Promise<Plugins> {
  const out = new Plugins();
  for (const pl of list) {
    const r = pl.registry;
    if (!r || r.did === undefined || r.name === undefined) {
      report.warn(
        `plugin \`${pl.id}\` was installed from a ${pl.source ?? "URL"} that no registry project matches; happyview.toml names only registry projects, so it is left out`,
      );
      continue;
    }
    const { did, name, channel } = { did: r.did, name: r.name, channel: r.channel };
    const kind = pl.plugin_type === undefined ? undefined : pluginKind(pl.plugin_type);
    if (kind === undefined) {
      report.warn(
        `plugin \`${pl.id}\` is a ${pl.plugin_type ?? "untyped"} plugin, which happyview.toml has no table for; it is left out`,
      );
      continue;
    }
    const pin = channel !== undefined ? Pin.channel(channel) : Pin.version(pl.version);
    const view = await failing(() =>
      pin.kind === "channel"
        ? reg.resolveChannel(did, name, pin.channel)
        : reg.getVersion(did, name, pin.version),
    );
    const a = artifact(view);
    const key = kind === "interpreter" ? a?.languageId : (pl.namespace ?? a?.namespace ?? name);
    if (key === undefined) {
      report.warn(
        `the registry doesn't say which language interpreter \`${pl.id}\` runs (${did}/${name}), so it is left out`,
      );
      continue;
    }
    const line = secretsLine(pl);
    if (line !== undefined) report.secrets.push(line);
    out.add(kind, key, { did, name, pin }, a);
  }
  return out;
}

/** One project answering `key`: the official publisher's when it has one, else the only one, else the one the user picks. */
async function pick(
  ctx: Ctx,
  kind: PluginKind,
  key: string,
  found: Candidate[],
): Promise<Candidate | undefined> {
  const matches = found.filter((c) => c.answers(kind, key));
  const official = matches.find((c) => c.did === OFFICIAL_PUBLISHER_DID);
  if (official) return official;
  if (matches.length <= 1) return matches[0];
  const i = await chooseWithPrompter(ctx)(key, matches);
  return matches[i];
}

const entry = (c: Candidate): PluginEntry => ({
  did: c.did,
  name: c.name,
  pin: Pin.channel(c.channel),
});

/**
 * A v2 instance's plugins in v3 terms: Lua, every v2 plugin the official publisher has a
 * project for (on its beta channel), and the libraries the rewritten scripts require.
 */
async function v2Plugins(
  ctx: Ctx,
  reg: Registry,
  list: wire.Plugin[],
  requires: string[],
  report: Report,
): Promise<Plugins> {
  const out = new Plugins();
  const interpreters = await candidates(reg, "interpreter");
  const lua = await pick(ctx, "interpreter", "lua", interpreters);
  if (!lua)
    throw Failure.usage(
      "no interpreter in the registry answers to `lua`, which every v2 script is written in",
    );
  out.interpreters.set("lua", entry(lua));
  for (const pl of list) {
    const view = await failing(() => reg.resolveChannel(OFFICIAL_PUBLISHER_DID, pl.id, "beta"));
    const a = artifact(view);
    const kind = a ? pluginKind(a.pluginType) : undefined;
    if (!a || kind === undefined) {
      report.warn(
        `v2 plugin \`${pl.id}\` has no official registry project to install it from, so it is left out`,
      );
      continue;
    }
    const key = kind === "interpreter" ? (a.languageId ?? pl.id) : (a.namespace ?? pl.id);
    const line = secretsLine(pl);
    if (line !== undefined) report.secrets.push(line);
    out.add(kind, key, { did: OFFICIAL_PUBLISHER_DID, name: pl.id, pin: Pin.channel("beta") }, a);
  }
  if (requires.length) {
    const libraries = await candidates(reg, "library");
    for (const ns of requires) {
      if (out.libraries.has(ns)) continue;
      const c = await pick(ctx, "library", ns, libraries);
      if (c) out.libraries.set(ns, entry(c));
      else report.warn(`a script requires \`${ns}\`, but no library in the registry answers to it`);
    }
  }
  return out;
}

/** The files of `src/` and the tables of `happyview.toml` that come from lexicons and scripts. */
export interface Source {
  files: Map<string, string>;
  toml: ProjectFile;
  /** `happyview.*` libraries the rewritten v2 scripts require, sorted. */
  requires: string[];
  lexicons: number;
  scripts: number;
  modules: number;
}

/** Rust's `{:?}` of a string. */
const debug = (s: string) => JSON.stringify(s);

export async function source(
  remote: Remote,
  gen: Generation,
  codemod: string | undefined,
  extensions: ReadonlyMap<string, string>,
  report: Report,
): Promise<Source> {
  const out: Source = {
    files: new Map(),
    toml: new ProjectFile(),
    requires: [],
    lexicons: 0,
    scripts: 0,
    modules: 0,
  };
  const requires = new Set<string>();
  const onInstance = new Set<string>();
  for (const l of remote.lexicons) {
    if (wire.isNetwork(l)) continue;
    let path: string;
    try {
      path = map.lexiconPath(l.id);
    } catch (e) {
      report.warn(`lexicon ${e}, so it is left out`);
      continue;
    }
    if (l.lexicon_json === undefined) {
      report.warn(`the instance answered no JSON for lexicon ${l.id}, so it is left out`);
      continue;
    }
    out.files.set(path, `${toStringPretty(l.lexicon_json)}\n`);
    const settings: LexiconSettings = map.lexiconSettings(
      l.lexicon_type,
      l.backfill,
      l.token_cost,
      l.indexed,
    );
    if (
      settings.backfill !== undefined ||
      settings.tokenCost !== undefined ||
      settings.indexed !== undefined
    )
      out.toml.lexicons.set(l.id, settings);
    onInstance.add(l.id);
    out.lexicons++;
  }
  out.toml.networkLexicons = [...remote.network];
  // BTreeMap::from_iter: the last of a repeated id wins.
  const collections = new Map<string, string>();
  for (const l of remote.lexicons)
    if (l.target_collection !== undefined) collections.set(l.id, l.target_collection);

  for (const s of remote.scripts) {
    if (s.module) {
      const m = s.module;
      const modulePath = map.safeRelPath(m.path);
      if (modulePath === undefined) {
        report.warn(
          `module \`${m.module}\` has a path outside the project (${debug(m.path)}), so it is left out`,
        );
        continue;
      }
      const ms: ModuleSettings = { language: s.script_type, path: modulePath };
      out.toml.modules.set(m.module, ms);
      report.modules.push(`${m.module} (${modulePath}, \`${m.handler}\` handles ${s.id})`);
      continue;
    }
    const trigger = map.parseTrigger(s.id);
    if (!trigger) {
      report.warn(`script \`${s.id}\` has a trigger pull doesn't know, so it is left out`);
      continue;
    }
    const ext = map.extension(s.script_type, extensions);
    if (!ext) {
      report.warn(
        `script ${s.id} is in a language whose extension can't name a file (${debug(s.script_type)}), so it is left out`,
      );
      continue;
    }
    const [extension, known] = ext;
    if (!known)
      report.warn(
        `no interpreter says which extension \`${s.script_type}\` files take, so ${s.id} is written as .${extension}`,
      );
    const given = gen === "v3" && s.path !== undefined ? map.safeSrcPath(s.path) : undefined;
    let path: string;
    try {
      const pth = given ?? map.handlerPath(trigger, extension);
      const safe = map.safeSrcPath(pth);
      if (safe === undefined) throw `${debug(pth)} isn't a path under src/`;
      path = safe;
    } catch (e) {
      report.warn(`script ${s.id}: ${e}, so it is left out`);
      continue;
    }
    const nsid = map.triggerLexicon(trigger);
    if (nsid !== undefined && !onInstance.has(nsid))
      report.warn(
        `${s.id} handles ${nsid}, which isn't a lexicon file on the instance; \`hpy hv check\` will flag ${path}`,
      );
    let body: string;
    let outbound: string[] | undefined;
    if (codemod !== undefined && gen === "v2") {
      const collection =
        trigger.kind === "query" || trigger.kind === "procedure"
          ? collections.get(trigger.target)
          : undefined;
      const r = await rewrite(codemod, s.body, trigger.kind, collection);
      if (r.kind === "clean") body = r.source;
      else if (r.kind === "marked") {
        report.handEdits.push(
          `${path}: the codemod left \`-- codemod:\` markers to finish by hand`,
        );
        body = r.source;
      } else {
        report.handEdits.push(
          `${path}: the codemod couldn't rewrite it (${r.why}), so it is still v2 code`,
        );
        body = s.body;
      }
      for (const ns of map.happyviewRequires(body)) requires.add(ns);
      // v2 derived its list from a body that no longer exists.
      outbound = undefined;
    } else {
      body = s.body;
      outbound = s.outbound_xrpcs;
    }
    const settings: ScriptSettings = map.scriptSettings(body, s.description, outbound);
    if (settings.description !== undefined || settings.outboundXrpcs !== undefined)
      out.toml.scripts.set(s.id, settings);
    const had = out.files.has(path);
    out.files.set(path, body);
    if (had)
      report.warn(`two things on the instance belong at ${path}; the later, ${s.id}, was kept`);
    out.scripts++;
  }

  if ("ok" in remote.modules) {
    for (const m of remote.modules.ok) {
      // HappyView reads modules only from under `src/` (`project/walk.rs`), so a path anywhere
      // else isn't one.
      const path = map.safeSrcPath(m.path);
      if (path === undefined) {
        report.warn(
          `module ${m.id} has a path that isn't under src/ (${debug(m.path)}), so it is left out`,
        );
        continue;
      }
      if (out.files.has(path)) {
        report.warn(
          `module ${m.id} belongs at ${path}, where a script already is; the script was kept`,
        );
        continue;
      }
      out.files.set(path, m.source);
      out.modules++;
    }
  } else {
    report.warn(remote.modules.err);
  }
  out.requires = [...requires].sort(compareKeys);
  return out;
}

/** The project a pull writes, with what it says about it. */
interface Pulled {
  files: [string, string][];
  toml: string;
  happyview: string;
  lexicons: number;
  scripts: number;
  modules: number;
  network: number;
  variables: string[];
  report: Report;
}

const envVar = (k: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? undefined : v;
};

/** The v2 API key: from `var`, else asked for without echo. It is held only in memory and never written anywhere. */
async function legacyKey(ctx: Ctx, name: string): Promise<string> {
  const key = process.env[name];
  if (key !== undefined && trim(key) !== "") return trim(key);
  if (!ctx.prompter.isInteractive())
    throw Failure.usage(
      `--legacy reads the v2 instance's API key from ${name}; set it to a key with ${LEGACY_PERMISSIONS}, or run in a terminal to be asked for it`,
    );
  const given = await p.password({ output: process.stderr, message: "v2 API key:", mask: "" });
  if (p.isCancel(given)) throw Failure.runtime("cancelled");
  return trim(given);
}

/** The admin API to read, and which HappyView it runs, refused when it is not the one the flags expect. */
async function connect(ctx: Ctx, args: Args): Promise<[Admin, Generation, string | undefined]> {
  const legacy = args.legacy === true;
  const given = args.url as string | undefined;
  // Signed in as `deploy` is, so the instance is the one it would use.
  let signedIn: Admin | undefined;
  if (!legacy) {
    try {
      signedIn = await instance.admin(ctx, given);
    } catch (e) {
      throw Failure.from(e);
    }
  }
  let url: string;
  if (signedIn) url = signedIn.base;
  else {
    if (given === undefined)
      throw Failure.usage("--legacy needs --url <instance>: a v2 instance has no `hpy hv login`");
    try {
      url = normalizeUrl(given);
    } catch (e) {
      throw Failure.from(e);
    }
  }
  const version = await servedVersion(url);
  const found = version === undefined ? undefined : generation(version);
  if (found === "v2" && !legacy)
    throw Failure.usage(
      `${url} is a v2 instance (HappyView ${version}); add --legacy to pull it into a v3 project`,
    );
  if (found === "v3" && legacy)
    throw Failure.usage(`${url} is a v3 instance (HappyView ${version}); pull it without --legacy`);
  if (found === undefined)
    ctx.out.status(
      `warning: ${url}/config doesn't say which HappyView it runs; reading it as ${legacy ? "v2, as --legacy says" : "v3"}`,
    );
  const gen: Generation = legacy ? "v2" : "v3";
  let admin: Admin;
  if (signedIn) admin = signedIn;
  else {
    // Asked for only once the instance is known to be a v2 one.
    const name = (args.apiKeyEnv as string | undefined) ?? DEFAULT_KEY_VAR;
    const key = await legacyKey(ctx, name);
    const bad = checkKey(key);
    if (bad !== null) throw Failure.usage(`${name}: ${bad}`);
    admin = Admin.withKey(url, key);
  }
  return [admin, gen, version];
}

/**
 * The HappyView version the project pins: the instance's own for v3, so the project runs what
 * it came from; the newest with a binary for this machine for v2, whose own version can't run
 * a v3 project.
 */
async function pinnedVersion(
  ctx: Ctx,
  gen: Generation,
  served: string | undefined,
): Promise<string> {
  if (gen === "v3" && served !== undefined) {
    const v = bare(served);
    try {
      Version.parse(v);
      return v;
    } catch {}
  }
  if (gen === "v3")
    ctx.out.status(
      "warning: the instance's HappyView version is unknown, so the project pins the newest release",
    );
  return latestVersion(httpClient(), ReleaseSource.fromEnv(envVar), HOST_TARGET);
}

async function pull(
  ctx: Ctx,
  admin: Admin,
  gen: Generation,
  served: string | undefined,
): Promise<Pulled> {
  const url = admin.base;
  let remote: Remote;
  try {
    remote = await read(admin, gen);
  } catch (e) {
    const f = Failure.from(e);
    if (gen === "v2" && f.code === 3)
      throw Failure.from(
        AtprotoError.loginRequired(
          `${url} refused the v2 API key; create one in its dashboard with ${LEGACY_PERMISSIONS}, and revoke it after the pull`,
        ),
      );
    throw f;
  }
  const happyview = await pinnedVersion(ctx, gen, served);
  const registry = ctx.registry();
  const report = new Report();

  let plugins: Plugins;
  let src: Source;
  if (gen === "v3") {
    plugins = await v3Plugins(registry, remote.plugins, report);
    src = await source(remote, gen, undefined, plugins.extensions, report);
  } else {
    const codemod = await ensureCodemod(
      httpClient(),
      ReleaseSource.fromEnv(envVar),
      cacheRoot(),
      happyview,
      HOST_TARGET,
      (m) => ctx.out.status(m),
    );
    src = await source(remote, gen, codemod, new Map(), report);
    plugins = await v2Plugins(ctx, registry, remote.plugins, src.requires, report);
  }

  if (remote.appName === undefined)
    report.warn(
      "the sign-in can't read the instance's settings (that needs settings:manage), so [instance] app_name is left out",
    );
  else if (remote.appName.name === undefined)
    report.warn("the instance has no app name set, so [instance] app_name is left out");
  if (remote.superadmin === undefined)
    report.warn("the instance lists no superadmin, so [instance] superadmin is left out");

  const file = src.toml;
  file.happyviewVersion = happyview;
  file.appName = remote.appName?.name;
  file.superadmin = remote.superadmin;
  file.interpreters = new Map(plugins.interpreters);
  file.libraries = new Map(plugins.libraries);
  file.labels = [...remote.labelers];
  const toml = file.render();
  // Read back as hpy and HappyView will, so a file pull can't parse is never written.
  let config: ProjectToml;
  try {
    config = ProjectToml.parse(toml);
  } catch (e) {
    throw Failure.runtime(`pull wrote a ${CONFIG_FILE} it can't read back: ${e}`);
  }
  const warn = (m: string) => ctx.out.status(`warning: ${m}`);
  const lock = await resolveLock({ registry, warn }, config, null);

  const files: [string, string][] = [
    [CONFIG_FILE, toml],
    [LOCK_FILE, lock.render()],
    [".gitignore", GITIGNORE],
    [".env.example", map.envExample(remote.variables)],
  ];
  const sorted = [...src.files].sort(([a], [b]) => compareKeys(a, b));
  files.push(...sorted);
  const languages = [...plugins.interpreters.keys()].sort(compareKeys);
  files.push(...editorFiles(languages));
  return {
    files,
    toml,
    happyview,
    lexicons: src.lexicons,
    scripts: src.scripts,
    modules: src.modules,
    network: remote.network.length,
    variables: remote.variables,
    report,
  };
}

/**
 * `happyview check` on the new project, as `hpy hv check` runs it, but as a child: the summary
 * is already out, and the exit code is pull's to give.
 */
async function check(ctx: Ctx, root: string): Promise<number> {
  for (const line of missingHandlerWarnings(root)) ctx.out.status(line);
  await buildAll(Toolchain.fromEnv(), root);
  const prepared = await prepareAt(ctx, root, PrepareOptions.native(false));
  const env = { ...process.env };
  for (const k of REMOVED_ENV) delete env[k];
  // stdout is pull's result; HappyView's report goes with the rest of what pull says.
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.binary, ["check", "."], {
      cwd: prepared.root,
      env,
      stdio: ["ignore", process.stderr, "inherit"],
    });
    child.on("error", (e) =>
      reject(Failure.runtime(`could not run ${prepared.binary}: ${ioErrorText(e)}`)),
    );
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Says whether the project matches what `hpy happyview deploy` last sent. Only ever a comparison: the live state is what was pulled. */
async function compareWithDeploy(ctx: Ctx, admin: Admin, root: string): Promise<void> {
  let deployed: Awaited<ReturnType<Admin["project"]>>;
  try {
    deployed = await admin.project();
  } catch {
    return;
  }
  if (!deployed) {
    ctx.out.status(
      "Nothing was deployed there with `hpy happyview deploy`; the project is what it serves.",
    );
    return;
  }
  const short = [...deployed.sha256].slice(0, 12).join("");
  let b: ReturnType<typeof bundle>;
  try {
    b = bundle(root, []);
  } catch {
    return;
  }
  if (b.sha256 === deployed.sha256) ctx.out.status(`It matches the last deploy, ${short}.`);
  // A regenerated happyview.toml rarely matches the deployed one byte for byte, so a different
  // hash says little: name the deploy only.
  else
    ctx.out.status(
      `Last deployed with \`hpy happyview deploy\` as ${short}${deployed.deployed_at !== null ? ` (${deployed.deployed_at})` : ""}; the project is what the instance serves now.`,
    );
}

function summary(url: string, dir: string, pl: Pulled): string {
  const out = [
    `Pulled ${url} into ${dir}`,
    `  ${pl.lexicons} lexicons, ${pl.scripts} scripts, ${pl.modules} interpreter modules, ${pl.network} network lexicons; HappyView ${pl.happyview}`,
  ];
  const r = pl.report;
  if (r.handEdits.length) {
    out.push("To finish by hand:");
    out.push(...r.handEdits.map((h) => `  • ${h}`));
  }
  if (r.modules.length) {
    out.push(
      "Compiled modules, whose source the instance doesn't hold (only their build); copy each crate to its path:",
    );
    out.push(...r.modules.map((m) => `  • ${m}`));
  }
  if (pl.variables.length)
    out.push(`Script variables, in .env.example without their values: ${pl.variables.join(", ")}`);
  if (r.secrets.length) {
    out.push("Plugin secrets to set after deploying (none were pulled):");
    out.push(...r.secrets.map((s) => `  • ${s}`));
  }
  out.push(
    "[jetstream] is left at its defaults: an instance's JETSTREAM_* settings are environment variables, which pull can't read.",
  );
  return out.join("\n");
}

const slashes = (f: string) => f.replaceAll("\\", "/");

function reportJson(url: string, dir: string, pl: Pulled): { [k: string]: Json } {
  return {
    instance: url,
    dir,
    happyview: pl.happyview,
    files: pl.files.map(([f]) => slashes(f)),
    warnings: pl.report.warnings,
    handEdits: pl.report.handEdits,
    modules: pl.report.modules,
    variables: pl.variables,
    secrets: pl.report.secrets,
  };
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `write_new(..).map_err(Failure::runtime)`. */
function write(dir: string, files: [string, string][]): void {
  try {
    writeNew(dir, files);
  } catch (e) {
    throw Failure.runtime(String(e));
  }
}

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const [admin, gen, served] = await connect(ctx, args);
  const url = admin.base;
  const dir = rustJoin(ctx.dir, (args.DIR as string | undefined) ?? map.defaultDir(url));
  const existing = isFile(rustJoin(dir, CONFIG_FILE));
  const diff = args.diff === true;
  if (diff && !existing)
    throw Failure.usage(`--diff compares with a project, and ${dir} has no ${CONFIG_FILE}`);
  if (existing && !diff)
    throw Failure.usage(
      `${dir} is already a project; use --diff to see how the instance differs, or pull into an empty directory`,
    );

  const pulled = await pull(ctx, admin, gen, served);
  for (const w of pulled.report.warnings) ctx.out.status(`warning: ${w}`);

  if (args.dryRun === true) {
    let human = `Would write ${dir}:\n`;
    for (const [f] of pulled.files) human += `  ${slashes(f)}\n`;
    human += `\n${CONFIG_FILE}:\n${pulled.toml}`;
    const out = reportJson(url, dir, pulled);
    out.dryRun = true;
    out.happyviewToml = pulled.toml;
    ctx.out.done(human, out);
    return;
  }

  if (diff) {
    const tmp = mkdtempSync(join(tmpdir(), ".tmp"));
    try {
      const into = rustJoin(tmp, "pulled");
      write(into, pulled.files);
      const [text, changed] = diffTrees(dir, into);
      const human = changed.length === 0 ? `${dir} matches ${url}` : trimEnd(text);
      const out = reportJson(url, dir, pulled);
      out.changed = changed;
      out.diff = text;
      ctx.out.done(human, out);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  write(dir, pulled.files);
  if (gen === "v3") await compareWithDeploy(ctx, admin, dir);
  ctx.out.done(summary(url, dir, pulled), reportJson(url, dir, pulled));

  const written = (why: string, code: number) =>
    new Failure(
      Math.max(code, 1),
      `${dir} was written, but ${why}; fix what it reports, then run \`hpy happyview check\` in it`,
    );
  let code: number;
  try {
    code = await check(ctx, dir);
  } catch (e) {
    const f = Failure.from(e);
    throw written(`\`hpy happyview check\` couldn't run on it: ${f.message}`, f.code);
  }
  if (code !== 0)
    throw written("`hpy happyview check` fails on it (above)", code >= 0 && code <= 255 ? code : 1);
}
