// crates/hpy/src/commands/status.rs: `hpy registry plugin status`, every version of a plugin
// in the user's repo or the registry.
import type { VersionView } from "../atproto/registry.ts";
import { rkeyOf, type StoredRecord } from "../atproto/repo.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import type { Json } from "../core/output.ts";
import { Version } from "../core/semver.ts";
import { compareKeys } from "../core/serde-json.ts";
import { VERSION_NSID } from "../plugin/nsid.ts";
import { resolveName } from "./profile.ts";

export interface Row {
  version: string;
  /**
   * The registry's `availability`, or `not indexed` for a version only the repo has, or
   * `unknown` when the registry could not be asked.
   */
  availability: string;
  state: string;
  installable: boolean;
  inRepo: boolean;
}

export const rowJson = (r: Row): Json => ({
  version: r.version,
  availability: r.availability,
  state: r.state,
  installable: r.installable,
  inRepo: r.inRepo,
});

/** The version in a record key `name.version`; `name:version` keys belong to older records. */
export function versionOf(name: string, uri: string): string | undefined {
  const key = rkeyOf(uri);
  if (!key.startsWith(name)) return undefined;
  const rest = key.slice(name.length);
  return rest.startsWith(".") ? rest.slice(1) : undefined;
}

function parseVersion(s: string): Version | undefined {
  try {
    return Version.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Every version of `name` in the user's repo or the registry, newest first. `registry` is the
 * registry's listing, or the error that stopped it.
 */
export function rows(
  name: string,
  mine: StoredRecord[],
  registry: VersionView[] | { error: unknown },
): Row[] {
  const reachable = Array.isArray(registry);
  const views = reachable ? registry : [];
  const out: Row[] = views.map((v) => ({
    version: v.version,
    availability: v.availability,
    state: v.lifecycle.state,
    installable: v.lifecycle.installable,
    inRepo: false,
  }));
  for (const r of mine) {
    const v = versionOf(name, r.uri);
    if (v === undefined) continue;
    const row = out.find((x) => x.version === v);
    if (row) row.inRepo = true;
    else
      out.push({
        version: v,
        availability: reachable ? "not indexed" : "unknown",
        state: "active",
        installable: false,
        inRepo: true,
      });
  }
  // A stable sort, as Rust's `sort_by` is.
  out.sort((a, b) => {
    const x = parseVersion(a.version);
    const y = parseVersion(b.version);
    if (x && y) return Version.compare(y, x);
    return compareKeys(b.version, a.version);
  });
  return out;
}

/** The `--json` answer, which the plugin-publish action reads. */
export function report(name: string, project: string | undefined, rs: Row[]): Json {
  return { name, project: project ?? null, versions: rs.map(rowJson) };
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));

export async function run(ctx: Ctx, args: Args): Promise<void> {
  const name = resolveName(ctx.dir, args.name as string | undefined);
  const session = await ctx.session();
  const registry = ctx.registry();
  const did = session.repo.did();
  const project = await registry.getProject(did, name).then(
    (p) => ({ ok: p }),
    (error: unknown) => ({ error }),
  );
  let mine: StoredRecord[];
  try {
    mine = await session.repo.listRecords(VERSION_NSID);
  } catch (e) {
    throw Failure.from(e);
  }
  const listing = await registry.listVersions(did, name).then(
    (v) => v,
    (error: unknown) => ({ error }),
  );
  let rs = rows(name, mine, listing);
  const wanted = args.VERSION as string | undefined;
  if (wanted !== undefined) {
    rs = rs.filter((r) => r.version === wanted);
    if (rs.length === 0) {
      throw Failure.usage(`${name} ${wanted} is neither in your repo nor in the registry`);
    }
  }
  let projectLine: string;
  if ("error" in project) {
    projectLine = `unknown (${(project.error as Error).message})`;
  } else if (project.ok) {
    const heads = [...project.ok.channels].map(([c, h]) => `${c} ${h.version}`);
    projectLine = `${project.ok.lifecycle.state} (${heads.length === 0 ? "no channels" : heads.join(", ")})`;
  } else {
    projectLine = "not indexed";
  }
  const human = [`${name}: ${projectLine}`];
  for (const r of rs) {
    let note = "";
    if (r.inRepo && r.availability === "not indexed") {
      note = "  ← the registry refused it or has not seen it yet";
    } else if (r.availability === "pending") {
      note = "  ← indexed; the registry has not copied its blobs yet";
    } else if (!r.inRepo) {
      note = "  (no longer in your repo)";
    }
    human.push(`  ${pad(r.version, 16)} ${pad(r.availability, 16)} ${pad(r.state, 12)}${note}`);
  }
  if (rs.length === 0) human.push("  no versions");
  const uri = "ok" in project && project.ok ? project.ok.uri : undefined;
  ctx.out.done(human.join("\n"), report(name, uri, rs));
}
