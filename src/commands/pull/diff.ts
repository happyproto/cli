// commands/happyview/pull/diff.rs: `pull --diff`: what the instance holds against the project
// on disk, as a unified diff, file by file.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { compareKeys } from "../../core/serde-json.ts";
import { unifiedDiff } from "../../core/similar.ts";

/**
 * The files under `src/` a project keeps that an instance never holds: tests stay local, so
 * their absence from the pull is no difference.
 */
function localOnly(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const base = name.slice(0, dot);
  return Buffer.byteLength(base) > ".test".length && base.endsWith(".test");
}

function walk(root: string, dir: string, rel: string[], out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = `${dir}/${name}`;
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {}
    if (isDir) walk(root, path, [...rel, name], out);
    else out.push([...rel, name].join("/"));
  }
}

/** `fs::read_to_string(..).ok()`. */
function read(path: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch {
    return undefined;
  }
}

/**
 * The unified diff from `project` to `pulled`, over every file the pull wrote and every file
 * under the project's `src/` but its tests. Empty when they agree.
 */
export function diffTrees(project: string, pulled: string): [string, string[]] {
  const paths: string[] = [];
  walk(pulled, pulled, [], paths);
  const local: string[] = [];
  walk(project, `${project}/src`, ["src"], local);
  paths.push(...local.filter((p) => !localOnly(p)));
  const sorted = [...new Set(paths)].sort(compareKeys);
  let out = "";
  const changed: string[] = [];
  for (const rel of sorted) {
    const old = read(`${project}/${rel}`);
    const neu = read(`${pulled}/${rel}`);
    if (old === neu) continue;
    const a = old !== undefined ? `a/${rel}` : "/dev/null";
    const b = neu !== undefined ? `b/${rel}` : "/dev/null";
    out += unifiedDiff(old ?? "", neu ?? "", a, b);
    if (!out.endsWith("\n")) out += "\n";
    changed.push(rel);
  }
  return [out, changed];
}
