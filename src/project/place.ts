// hpy-project/src/place.rs: `.happyview/plugins/`, where `happyview dev` loads plugins from.
// The directory belongs to `hpy`: after a placement it holds exactly the locked plugins and
// nothing else. Every function throws `IoError` (src/core/io.ts) where Rust returns an
// `io::Error`.
import {
  copyFileSync,
  type Dirent,
  lstatSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createDirAll, IoError, toIoError } from "../core/io.ts";
import { rustFileName, rustJoin, rustParent, rustWithFileName, samePath } from "../core/paths.ts";
import { compareKeys } from "../core/serde-json.ts";

export const PLUGINS_DIR = ".happyview/plugins";

/**
 * `"link"`: a symlink into the shared cache; copies on Windows, where creating one needs a
 * privilege most accounts lack. `"copy"`: a real copy, for a reader that cannot follow a link
 * into the host's cache, such as a container.
 */
export type PlaceMode = "link" | "copy";

export interface Placement {
  id: string;
  source: string;
}

const io = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    throw toIoError(e);
  }
};

const invalidInput = (message: string) => new IoError(message, "InvalidInput");

/** `place_plugins`: makes `root/.happyview/plugins` hold exactly `plugins`. */
export function placePlugins(root: string, plugins: readonly Placement[], mode: PlaceMode): void {
  for (const plugin of plugins) checkId(plugin.id);
  const dir = rustJoin(root, PLUGINS_DIR);
  createPrivateParent(dir);
  requireRealDir(dir);
  createDirAll(dir);
  // A BTreeMap: the last placement of an id wins, and they are placed in id order.
  const wanted = new Map<string, string>();
  for (const p of plugins) wanted.set(p.id, p.source);
  for (const entry of readDir(dir)) {
    const path = rustJoin(dir, entry.name);
    const source = wanted.get(entry.name);
    const keep = source !== undefined && mode === "link" && pointsAt(path, source);
    if (!keep) remove(path);
  }
  for (const [id, source] of [...wanted].sort(([a], [b]) => compareKeys(a, b))) {
    const dest = rustJoin(dir, id);
    if (exists(dest)) continue;
    if (mode === "link") link(source, dest);
    else copyIntoPlace(source, dest);
  }
}

/**
 * `placed_mode`: how the plugins already in `.happyview/plugins/` were placed, so a later
 * placement can keep to it; `undefined` when nothing has placed any yet. A container's network
 * places copies, and a directory with no links in it is taken as one of those. An empty
 * directory gets the default, links.
 */
export function placedMode(root: string): PlaceMode | undefined {
  const dir = rustJoin(root, PLUGINS_DIR);
  if (!requireRealDir(dir)) return undefined;
  let any = false;
  for (const entry of readDir(dir)) {
    if (io(() => lstatSync(rustJoin(dir, entry.name))).isSymbolicLink()) return "link";
    any = true;
  }
  return any ? "copy" : "link";
}

function readDir(dir: string): Dirent[] {
  return io(() => readdirSync(dir, { withFileTypes: true }));
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `create_private_parent`: makes `.happyview` owner-only when this call creates it, so a
 * command that never tightens permissions afterwards does not leave it world-readable.
 */
function createPrivateParent(dir: string): void {
  const parent = rustParent(dir);
  if (parent === undefined) return;
  if (requireRealDir(parent)) return;
  createDirAll(parent, process.platform === "win32" ? undefined : 0o700);
}

/**
 * `require_real_dir`: whether `path` exists as a real directory. A link or a file there is
 * refused, a dangling link included: pruning through one would delete whatever it points at.
 */
function requireRealDir(path: string): boolean {
  let meta: ReturnType<typeof lstatSync>;
  try {
    meta = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw toIoError(e);
  }
  if (meta.isSymbolicLink()) {
    throw invalidInput(`${path} is a symlink; replace it with a real directory`);
  }
  if (!meta.isDirectory()) throw invalidInput(`${path} is not a directory`);
  return true;
}

/** `check_id`: a plugin id becomes one path segment under `plugins/`. */
function checkId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    throw invalidInput(`\`${id}\` cannot name a plugin directory`);
  }
}

function pointsAt(path: string, source: string): boolean {
  try {
    return samePath(readlinkSync(path), source);
  } catch {
    return false;
  }
}

/** Removes a link as a link: following it would delete the cached plugin every other project shares. */
function remove(path: string): void {
  const meta = io(() => lstatSync(path));
  if (meta.isSymbolicLink() || !meta.isDirectory()) io(() => unlinkSync(path));
  else io(() => rmSync(path, { recursive: true, force: false }));
}

function link(source: string, dest: string): void {
  if (process.platform === "win32") copyIntoPlace(source, dest);
  else io(() => symlinkSync(source, dest));
}

/**
 * `copy_into_place`: copies beside the plugins directory, then renames into it, so a running
 * `dev` watching it never sees a plugin with its manifest but not its module.
 */
function copyIntoPlace(source: string, dest: string): void {
  const plugins = rustParent(dest);
  const name = rustFileName(dest);
  if (plugins === undefined || name === undefined) {
    copyDir(source, dest);
    return;
  }
  const staging = rustWithFileName(plugins, ".plugins-staging");
  createDirAll(staging);
  const tmp = rustJoin(staging, name);
  if (exists(tmp)) remove(tmp);
  copyDir(source, tmp);
  io(() => renameSync(tmp, dest));
}

function copyDir(source: string, dest: string): void {
  createDirAll(dest);
  for (const entry of readDir(source)) {
    const from = rustJoin(source, entry.name);
    const to = rustJoin(dest, entry.name);
    // `DirEntry::file_type` does not follow a link; `fs::copy` then copies what it points at.
    if (entry.isDirectory()) copyDir(from, to);
    else io(() => copyFileSync(from, to));
  }
}
