// crates/hpy/src/commands/profile.rs: a plugin's project as a whole, `[project]` in hpy.toml,
// and the project, publication and sidecar records `putProject` writes from it.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AtprotoError } from "../atproto/error.ts";
import type { ProjectView, Registry } from "../atproto/registry.ts";
import { projectViewJson } from "../atproto/registry.ts";
import type { Repo } from "../atproto/repo.ts";
import { missingBlobScopes, missingRepoScopes } from "../atproto/scope.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { ioErrorText } from "../core/io.ts";
import type { Json } from "../core/output.ts";
import { rustJoin } from "../core/paths.ts";
import {
  array,
  type Decoder,
  fromValue,
  optional,
  str,
  struct,
  withDefault,
} from "../core/serde-json.ts";
import {
  type Encoder,
  encArray,
  encOption,
  encStr,
  encStruct,
  isNone,
  fromStr as tomlFromStr,
  toTomlStringPretty,
} from "../core/toml.ts";
import { inspectImage, predictedBlob } from "../plugin/artifact.ts";
import {
  AUTHOR,
  CONTACT,
  encAuthor,
  encContact,
  FILE_NAME,
  type HpyToml,
  hpyName,
  loadHpyToml,
  type ProjectConfig,
  projectConfig,
  toDetails,
  writeProject,
} from "../plugin/config.ts";
import { loadManifest, type Manifest } from "../plugin/manifest.ts";
import { PROJECT_NSID, PUBLICATION_NSID, SIDECAR_NSID } from "../plugin/nsid.ts";
import {
  type Author,
  authorDisplay,
  type Contact,
  contactDisplay,
  type ProjectDetails,
  parseAuthor,
  parseContact,
  projectInput,
  projectProblems,
} from "../plugin/project.ts";
import { isProjectName } from "../plugin/validate.ts";
import { Blob } from "./publish.ts";

/** `Manifest::load(dir).ok()`. */
export function manifestOk(dir: string): Manifest | undefined {
  try {
    return loadManifest(dir);
  } catch {
    return undefined;
  }
}

/** `HpyToml::load(dir)?`: its `Problem` becomes a usage failure. */
export function loadToml(dir: string): HpyToml | null {
  try {
    return loadHpyToml(dir);
  } catch (e) {
    throw Failure.from(e);
  }
}

/** The project name: `--name`, else hpy.toml's `[project] name`, else the manifest's `id`. */
export function resolveName(dir: string, flag: string | undefined): string {
  let name: string;
  if (flag !== undefined) {
    name = flag;
  } else {
    const manifest = manifestOk(dir);
    const toml = loadToml(dir);
    const found = hpyName(toml ?? {}, manifest);
    if (found === undefined) {
      throw Failure.usage(
        "no project name: pass --name, or run in a directory with manifest.json or hpy.toml",
      );
    }
    name = found;
  }
  if (!isProjectName(name)) {
    throw Failure.usage(
      `\`${name}\` is not a project name: 1 to 64 lowercase letters, digits and interior \`-\``,
    );
  }
  return name;
}

const nonEmpty = (s: string): string | null => (s.trim() === "" ? "required" : null);

const checkName = (s: string): string | null =>
  isProjectName(s) ? null : "1 to 64 lowercase letters, digits and interior `-`";

/** A parser that throws its reason as a string, as `Prompter.list` takes it. */
function listParser<T>(parse: (s: string) => T): (s: string) => T | { error: string } {
  return (s) => {
    try {
      return parse(s);
    } catch (e) {
      if (typeof e === "string") return { error: e };
      throw e;
    }
  };
}

/** The icon `cfg` names, read and checked, for upload. */
function readIcon(dir: string, cfg: ProjectConfig): Blob | undefined {
  const icon = cfg.icon;
  if (icon === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(rustJoin(dir, icon.path));
  } catch (e) {
    throw Failure.usage(`project.icon: cannot read \`${icon.path}\`: ${ioErrorText(e)}`);
  }
  let mime: string;
  try {
    mime = inspectImage(bytes).mime;
  } catch (e) {
    throw Failure.usage(`project.icon: \`${icon.path}\` ${e}`);
  }
  return new Blob(bytes, mime, "icon");
}

/** Refuses a session whose grant cannot write the records `putProject` writes, or upload the icon, before anything is sent. */
function checkGrant(repo: Repo, icon: Blob | undefined, name: string): void {
  const granted = repo.grantedScopes();
  if (granted === null) return;
  const missing = missingBlobScopes(granted, icon ? [icon.mime] : []);
  missing.push(...missingRepoScopes(granted, [PROJECT_NSID, PUBLICATION_NSID, SIDECAR_NSID]));
  if (missing.length === 0) return;
  const needed = missing.map((s) => `\`${s}\``).join(", ");
  throw Failure.usage(
    `writing the ${name} project needs ${needed}, which this sign-in was not granted. A session's scopes are fixed when it is created: run \`hpy registry login\` to sign in again, then try again. Nothing was written.`,
  );
}

/** The CID a blob ref names: `stored["ref"]["$link"].as_str().unwrap_or_default()`. */
export function linkOf(stored: Json | undefined): string {
  const ref = (stored as { ref?: { $link?: unknown } } | null)?.ref;
  const link = ref !== null && typeof ref === "object" ? ref.$link : undefined;
  return typeof link === "string" ? link : "";
}

/**
 * Asks the gateway to check the project, uploads its icon, then writes it. Answers the project
 * record's URI and whether it was new.
 */
export async function putProject(
  registry: Registry,
  repo: Repo,
  details: ProjectDetails,
  icon: Blob | undefined,
  swapCid: string | undefined,
): Promise<[string, boolean]> {
  checkGrant(repo, icon, details.name);
  const input = projectInput(details) as { [k: string]: Json };
  if (swapCid !== undefined) input.swapCid = swapCid;
  try {
    await registry.putProject(structuredClone(input), true);
  } catch (e) {
    throw putError(e);
  }
  if (icon !== undefined) {
    let stored: Json;
    try {
      stored = await repo.uploadBlob(icon.bytes, icon.mime);
    } catch (e) {
      throw Failure.from(e);
    }
    const cid = linkOf(stored);
    if (cid !== icon.cid) {
      throw Failure.runtime(
        `your PDS stored the icon as ${cid}, but its bytes hash to ${icon.cid}; nothing was written`,
      );
    }
  }
  let written: Awaited<ReturnType<Registry["putProject"]>>;
  try {
    written = await registry.putProject(input, false);
  } catch (e) {
    throw putError(e);
  }
  if (written === null) throw Failure.runtime("putProject answered something unreadable");
  return [written.project.uri, written.created];
}

/** A swap conflict means someone changed the project mid-edit; say so. */
export function putError(e: unknown): Failure {
  if (e instanceof AtprotoError) {
    const d = e.detail;
    const swap =
      d.kind === "Xrpc" ? d.name.includes("InvalidSwap") : e.registryName() === "InvalidSwap";
    if (swap) {
      return Failure.runtime(
        "the project changed in your repo while you were editing; run the edit again",
      );
    }
  }
  return Failure.from(e);
}

/** A `Vec<String>` flag commander collected, or none. */
const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
const opt = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** clap's `ProfileFields`. */
export interface ProfileFields {
  displayName?: string | undefined;
  description?: string | undefined;
  authors: string[];
  security: string[];
  keywords: string[];
}

function fieldsOf(args: Args): ProfileFields {
  return {
    displayName: opt(args.displayName),
    description: opt(args.description),
    authors: list(args.author),
    security: list(args.security),
    keywords: list(args.keyword),
  };
}

export async function init(ctx: Ctx, args: Args): Promise<void> {
  const manifest = manifestOk(ctx.dir);
  const existing = loadToml(ctx.dir)?.project ?? projectConfig();
  const p = ctx.prompter;
  const f = fieldsOf(args);

  const defaultName = existing.name ?? manifest?.id;
  const name = await p.required("--name", "Project name:", opt(args.name), defaultName, checkName);
  const displayName = await p.required(
    "--display-name",
    "Display name:",
    f.displayName,
    existing.display_name ?? manifest?.name,
    nonEmpty,
  );
  const description = await p.optional(
    "One-line description:",
    f.description,
    existing.description ?? manifest?.description,
  );
  const authors = await p.list(
    "--author",
    "Author (Name <email> (url)):",
    f.authors,
    existing.authors.map((a) => ({ ...a })),
    listParser(parseAuthor),
    1,
  );
  const security = await p.list(
    "--security",
    "Security contact (email or URL):",
    f.security,
    existing.security.map((c) => ({ ...c })),
    listParser(parseContact),
    1,
  );
  let keywords: string[];
  if (f.keywords.length > 0) {
    keywords = f.keywords;
  } else if (p.isInteractive() && existing.keywords.length === 0) {
    const s = await p.optional("Keywords (comma-separated):", undefined, undefined);
    keywords =
      s === undefined
        ? []
        : s
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k !== "");
  } else {
    keywords = [...existing.keywords];
  }

  // The name is written only when it differs from what hpy.toml would fall back to, so a
  // renamed manifest id is not shadowed by a copy.
  const fallback = manifest?.id;
  const cfg: ProjectConfig = {
    name: fallback !== name || existing.name !== undefined ? name : undefined,
    display_name: displayName,
    description,
    icon: existing.icon,
    keywords,
    authors,
    security,
  };
  const icon = readIcon(ctx.dir, cfg);
  const details = toDetails(
    cfg,
    name,
    manifest,
    icon ? predictedBlob(icon.bytes, icon.mime) : undefined,
  );
  const problems = projectProblems(details);
  if (problems.length > 0) throw Failure.problems("the project is not valid:", problems);
  write(ctx.dir, cfg);
  ctx.out.status(`Wrote ${rustJoin(ctx.dir, FILE_NAME)}`);

  if (args.localOnly) {
    ctx.out.done("", { name, created: false, localOnly: true });
    return;
  }
  const session = await ctx.session();
  const registry = session.registry();
  let found: ProjectView | null;
  try {
    found = await registry.getProject(session.repo.did(), name);
  } catch (e) {
    throw Failure.from(e);
  }
  if (found !== null) {
    throw Failure.usage(
      `the registry already has a \`${name}\` project of yours; use \`hpy registry plugin edit\` or \`hpy registry plugin pull\``,
    );
  }
  if (!(await ctx.prompter.confirm(`Create the \`${name}\` project?`, !!args.yes))) {
    throw Failure.runtime("cancelled");
  }
  const [uri, created] = await putProject(registry, session.repo, details, icon, undefined);
  ctx.out.done(`Created ${uri}`, { name, uri, created });
}

/** `config::write_project(..).map_err(Failure::runtime)`. */
function write(dir: string, cfg: ProjectConfig): void {
  try {
    writeProject(dir, cfg);
  } catch (e) {
    throw Failure.runtime(e);
  }
}

/** The parts of a project an edit can change, as the editor shows them. */
export interface Editable {
  display_name: string;
  description?: string | undefined;
  keywords: string[];
  authors: Author[];
  security: Contact[];
}

export const EDITABLE: Decoder<Editable> = struct("Editable", {
  display_name: str,
  description: withDefault(optional(str), undefined),
  keywords: withDefault(array(str), () => []),
  authors: withDefault(array(AUTHOR), () => []),
  security: withDefault(array(CONTACT), () => []),
});

export const encEditable: Encoder<Editable> = encStruct<Editable>("Editable", {
  display_name: encStr,
  description: { enc: encOption(encStr), skipIf: isNone },
  keywords: encArray(encStr),
  authors: encArray(encAuthor),
  security: encArray(encContact),
});

function readList<T>(view: ProjectView, what: string, v: Json[], decoder: Decoder<T>): T[] {
  try {
    return fromValue(v, array(decoder));
  } catch (e) {
    throw Failure.runtime(
      `the registry's ${what} for \`${view.name}\` are unreadable: ${(e as Error).message}`,
    );
  }
}

/** `Editable::from_view`. */
export function editableFromView(view: ProjectView): Editable {
  return {
    display_name: view.publication.name,
    description: view.publication.description,
    keywords: [...view.keywords],
    authors: readList(view, "authors", view.authors, AUTHOR),
    security: readList(view, "security contacts", view.security, CONTACT),
  };
}

/** `Editable::to_details`. */
export function editableToDetails(
  e: Editable,
  name: string,
  pluginType: string,
  icon: Json | undefined,
): ProjectDetails {
  return {
    name,
    publication: { name: e.display_name, description: e.description, icon },
    pluginType,
    keywords: [...e.keywords],
    authors: e.authors.map((a) => ({ ...a })),
    security: e.security.map((c) => ({ ...c })),
  };
}

/** Rust's `{:<9}`: pads to 9 characters. */
const padRight = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));

function summary(view: ProjectView): string {
  const lines = [`${view.publication.name} (${view.name})`];
  if (view.publication.description !== undefined) lines.push(view.publication.description);
  lines.push(`type:     ${view.pluginType}`);
  let e: Editable | undefined;
  try {
    e = editableFromView(view);
  } catch {
    e = undefined;
  }
  if (e !== undefined) {
    lines.push(`authors:  ${e.authors.map(authorDisplay).join(", ")}`);
    lines.push(`security: ${e.security.map(contactDisplay).join(", ")}`);
  }
  if (view.keywords.length > 0) lines.push(`keywords: ${view.keywords.join(", ")}`);
  const channels = [...view.channels.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const channel of channels) {
    lines.push(`${padRight(channel, 9)} ${view.channels.get(channel)?.version}`);
  }
  lines.push(view.uri);
  return lines.join("\n");
}

interface Fetched {
  name: string;
  session: Awaited<ReturnType<Ctx["session"]>>;
  view: ProjectView;
}

async function fetch(ctx: Ctx, nameFlag: string | undefined): Promise<Fetched> {
  const name = resolveName(ctx.dir, nameFlag);
  const session = await ctx.session();
  let view: ProjectView | null;
  try {
    view = await session.registry().getProject(session.repo.did(), name);
  } catch (e) {
    throw Failure.from(e);
  }
  if (view === null) {
    throw Failure.usage(
      `the registry has no \`${name}\` project of yours; run \`hpy registry plugin init\``,
    );
  }
  return { name, session, view };
}

export async function show(ctx: Ctx, args: Args): Promise<void> {
  const f = await fetch(ctx, opt(args.name));
  ctx.out.done(summary(f.view), projectViewJson(f.view));
}

export function applyEdits(p: Editable, f: ProfileFields, removeKeywords: string[]): void {
  if (f.displayName !== undefined) p.display_name = f.displayName;
  if (f.description !== undefined) p.description = f.description;
  for (const a of f.authors) {
    try {
      p.authors.push(parseAuthor(a));
    } catch (e) {
      throw Failure.usage(`--author: ${e}`);
    }
  }
  for (const c of f.security) {
    try {
      p.security.push(parseContact(c));
    } catch (e) {
      throw Failure.usage(`--security: ${e}`);
    }
  }
  p.keywords = p.keywords.filter((k) => !removeKeywords.includes(k));
  for (const k of f.keywords) if (!p.keywords.includes(k)) p.keywords.push(k);
}

export function toEditable(name: string, p: Editable): string {
  let toml: string;
  try {
    toml = toTomlStringPretty(p, encEditable);
  } catch (e) {
    throw Failure.runtime(e);
  }
  return `# Editing the \`${name}\` project. Save and close to publish the change;\n# empty the file to cancel.\n\n${toml}`;
}

/** Throws the reason as a string, as the Rust `Err(String)`. */
export function fromEditable(text: string): Editable {
  try {
    return tomlFromStr(text, EDITABLE);
  } catch (e) {
    throw (e as Error).message;
  }
}

/** Rust's `ExitStatus` Display on unix: `exit status: N`, or `signal: N (SIGNAME)`. */
export function exitStatusText(status: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    const n = (
      {
        SIGHUP: 1,
        SIGINT: 2,
        SIGQUIT: 3,
        SIGABRT: 6,
        SIGKILL: 9,
        SIGSEGV: 11,
        SIGPIPE: 13,
        SIGTERM: 15,
      } as Record<string, number>
    )[signal];
    return n !== undefined ? `signal: ${n} (${signal})` : `signal: ${signal}`;
  }
  return process.platform === "win32" ? `exit code: ${status}` : `exit status: ${status}`;
}

function runEditor(path: string): void {
  const editor =
    process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");
  const r =
    process.platform === "win32"
      ? spawnSync(editor, [path], { stdio: "inherit" })
      : spawnSync("sh", ["-c", `${editor} "$1"`, "sh", path], { stdio: "inherit" });
  if (r.error) throw Failure.runtime(`could not start \`${editor}\`: ${ioErrorText(r.error)}`);
  if (r.status !== 0) {
    throw Failure.runtime(`\`${editor}\` exited with ${exitStatusText(r.status, r.signal)}`);
  }
}

/** Opens the project in `$VISUAL`/`$EDITOR` until it is valid or abandoned. */
async function editInEditor(ctx: Ctx, view: ProjectView, editable: Editable): Promise<Editable> {
  const path = rustJoin(tmpdir(), `hpy-project-${view.name}-${process.pid}.toml`);
  try {
    writeFileSync(path, toEditable(view.name, editable));
  } catch (e) {
    throw Failure.runtime(ioErrorText(e));
  }
  try {
    for (;;) {
      runEditor(path);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        throw Failure.runtime(ioErrorText(e));
      }
      const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
      if (lines.every((l) => l.trim() === "" || l.trimStart().startsWith("#"))) {
        throw Failure.runtime("cancelled");
      }
      let problems: string[];
      try {
        const e = fromEditable(text);
        const found = projectProblems(editableToDetails(e, view.name, view.pluginType, undefined));
        if (found.length === 0) return e;
        problems = found.map((p) => p.toString());
      } catch (e) {
        if (typeof e !== "string") throw e;
        problems = [e];
      }
      for (const p of problems) process.stderr.write(`  • ${p}\n`);
      if (!(await ctx.prompter.confirm("The project is not valid. Edit again?", false))) {
        throw Failure.runtime("cancelled");
      }
    }
  } finally {
    try {
      rmSync(path);
    } catch {}
  }
}

/** The publication's icon blob as the repo holds it, so an edit that does not touch the icon keeps it. */
export async function currentIcon(repo: Repo, name: string): Promise<Json | undefined> {
  let r: Awaited<ReturnType<Repo["getRecord"]>>;
  try {
    r = await repo.getRecord(PUBLICATION_NSID, name);
  } catch (e) {
    throw Failure.from(e);
  }
  if (r === null) return undefined;
  const v = r.value;
  const icon = v !== null && typeof v === "object" && !Array.isArray(v) ? v.icon : undefined;
  return icon === undefined || icon === null ? undefined : icon;
}

export async function edit(ctx: Ctx, args: Args): Promise<void> {
  const { name, session, view } = await fetch(ctx, opt(args.name));
  let editable = editableFromView(view);
  const f = fieldsOf(args);
  const removeKeywords = list(args.removeKeyword);
  const hasFlags =
    f.displayName !== undefined ||
    f.description !== undefined ||
    f.authors.length > 0 ||
    f.security.length > 0 ||
    f.keywords.length > 0 ||
    removeKeywords.length > 0;
  if (hasFlags) {
    applyEdits(editable, f, removeKeywords);
  } else if (ctx.prompter.isInteractive()) {
    editable = await editInEditor(ctx, view, editable);
  } else {
    throw Failure.usage(
      "pass field flags (e.g. --display-name, --author) to edit without a terminal",
    );
  }
  const uri = await applyEdit(ctx.dir, session.registry(), session.repo, view, editable);
  ctx.out.done(`Updated ${uri}`, { name, uri });
}

/**
 * Writes an edit to the registry, keeping the publication's icon, and to `[project]` in hpy.toml
 * when there is one, so the next publish does not put the old values back. Answers the
 * project's URI.
 */
export async function applyEdit(
  dir: string,
  registry: Registry,
  repo: Repo,
  view: ProjectView,
  editable: Editable,
): Promise<string> {
  const icon = await currentIcon(repo, view.name);
  const details = editableToDetails(editable, view.name, view.pluginType, icon);
  const problems = projectProblems(details);
  if (problems.length > 0) throw Failure.problems("the edited project is not valid:", problems);
  // The gateway swaps on the sidecar, which holds the fields an edit changes besides the
  // publication's.
  const [uri] = await putProject(registry, repo, details, undefined, view.sidecar.cid);
  // Only the hpy.toml this project is described by takes the edit; a `--name` for another
  // project must leave this directory's file alone.
  const toml = loadToml(dir);
  const manifest = manifestOk(dir);
  const belongs = toml !== null && hpyName(toml, manifest) === view.name;
  const existing = toml?.project;
  if (belongs && existing !== undefined) {
    write(dir, {
      ...existing,
      display_name: editable.display_name,
      description: editable.description,
      keywords: [...editable.keywords],
      authors: editable.authors.map((a) => ({ ...a })),
      security: editable.security.map((c) => ({ ...c })),
    });
  }
  return uri;
}

/**
 * `[project]` as the registry has it, keeping the icon path hpy.toml already names, since the
 * registry holds the icon's bytes, not its path.
 */
export function pulledConfig(
  view: ProjectView,
  existing: ProjectConfig | undefined,
): ProjectConfig {
  const e = editableFromView(view);
  return {
    name: view.name,
    display_name: e.display_name,
    description: e.description,
    icon: existing?.icon,
    keywords: e.keywords,
    authors: e.authors,
    security: e.security,
  };
}

export async function pull(ctx: Ctx, args: Args): Promise<void> {
  const { name, view } = await fetch(ctx, opt(args.name));
  const existing = loadToml(ctx.dir)?.project;
  const cfg = pulledConfig(view, existing);
  write(ctx.dir, cfg);
  const path = rustJoin(ctx.dir, FILE_NAME);
  ctx.out.done(`Wrote the \`${name}\` project to ${path}`, { name, path });
}
