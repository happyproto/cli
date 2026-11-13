// crates/hpy/src/project/cache.rs: `~/.cache/hpy`, HappyView binaries and plugins, shared by
// every project. Everything is written beside its final name and renamed into place, so a
// reader (another `hpy`, a running HappyView) sees the old entry or the new one, never half of
// one. The cache holds code that gets executed, so its directories are private to the user.
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { Failure } from "../core/failure.ts";
import { IoError, toIoError } from "../core/io.ts";
import { cacheBase, rustJoin } from "../core/paths.ts";
import { BINARY_NAME, HOST_TARGET } from "./binary.ts";

const UNIX = process.platform !== "win32";

/** `HPY_CACHE_DIR`, or `$XDG_CACHE_HOME/hpy`; checked (and created) before it is returned. */
export function cacheRoot(): string {
  const named = process.env.HPY_CACHE_DIR;
  const [root, origin]: [string, RootOrigin] =
    named !== undefined && named !== ""
      ? [named, "named"]
      : [rustJoin(cacheBase(), "hpy"), "default"];
  try {
    prepareRoot(root, origin);
  } catch (e) {
    throw Failure.runtime(`the cache directory ${root} cannot be trusted: ${toIoError(e).message}`);
  }
  return root;
}

export function pluginDir(root: string, id: string, version: string): string {
  return rustJoin(root, "plugins", id, version);
}

/**
 * Where the HappyView binary for `version` lives. A binary for another machine than this one
 * sits one level deeper, under its triple, so both can be cached side by side.
 */
export function binaryPath(root: string, version: string, target: string): string {
  let dir = rustJoin(root, "happyview", version);
  if (target !== HOST_TARGET) dir = rustJoin(dir, target);
  return rustJoin(dir, BINARY_NAME);
}

/** `Path::with_file_name`. */
export function withFileName(path: string, name: string): string {
  const parent = parentOf(path);
  return parent === "" ? name : rustJoin(parent, name);
}

/** `Path::parent`, with `""` for a bare name, as Rust has. */
function parentOf(path: string): string {
  const base = basename(path);
  if (base === "" || base === path) return "";
  const parent = dirname(path);
  return parent === "." && !path.startsWith("./") && !path.startsWith(".\\") ? "" : parent;
}

/**
 * Creates `path` and any missing parents, 0700 on unix, so nothing another user could swap a
 * module into is ever world-writable.
 */
function createPrivateDirs(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw toIoError(e);
  }
}

function createPrivateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    throw toIoError(e);
  }
}

/**
 * Whether a cache root is one the user named (`HPY_CACHE_DIR`), whose mode is theirs to decide,
 * or hpy's own default, which hpy may tighten.
 */
export type RootOrigin = "named" | "default";

function refuse(why: string): IoError {
  return new IoError(why, "EACCES");
}

function lstat(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (e) {
    throw toIoError(e);
  }
}

/**
 * Makes sure the cache root and its `plugins/` and `happyview/` directories exist and are this
 * user's alone. The cache holds code that gets executed, so a directory another user owns, a
 * symlink that could be repointed, or anything that is not a directory is refused before
 * anything is created inside it. A loose mode is tightened to 0700 only on a directory hpy
 * owns: one it just created, its default root, or the two beneath the root. A root the user
 * named with a loose mode is refused instead, since its mode is theirs. Throws an `IoError`.
 */
export function prepareRoot(root: string, origin: RootOrigin): void {
  const rootCreated = prepareDir(root, true);
  const tightenRoot = rootCreated || origin === "default";
  checkPrivate(root, tightenRoot);
  for (const sub of ["plugins", "happyview"]) {
    const dir = rustJoin(root, sub);
    prepareDir(dir, false);
    checkPrivate(dir, true);
  }
}

/**
 * Creates `dir` 0700 when it is absent, and refuses a symlink or anything that is not a
 * directory. Answers whether it was created.
 */
function prepareDir(dir: string, withParents: boolean): boolean {
  let meta: Stats;
  try {
    meta = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw toIoError(e);
    if (withParents) createPrivateDirs(dir);
    else createPrivateDir(dir);
    // Someone else may have put a link there in between.
    prepareDir(dir, false);
    return true;
  }
  if (meta.isSymbolicLink()) throw refuse(`${dir} is a symlink`);
  if (!meta.isDirectory()) throw refuse(`${dir} is not a directory`);
  return false;
}

function checkPrivate(dir: string, mayTighten: boolean): void {
  if (!UNIX) return;
  const meta = lstat(dir);
  const euid = process.geteuid!();
  if (meta.uid !== euid) throw refuse(`${dir} is owned by uid ${meta.uid}, not by this user`);
  const mode = meta.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    if (!mayTighten)
      throw refuse(
        `${dir} has mode ${mode.toString(8)}, so other users can reach the code hpy keeps there; ` +
          "hpy does not change the mode of a directory you named, so run " +
          `\`chmod 700 ${dir}\` or point HPY_CACHE_DIR somewhere private`,
      );
    try {
      // chmod(2) follows a link, as Rust's set_permissions does.
      chmodSync(dir, 0o700);
    } catch (e) {
      throw toIoError(e);
    }
  }
}

let next = 0;

/** A name no other process, or task in this one, is using. */
function partial(path: string): string {
  const name = basename(path);
  const nanos = Number(process.hrtime.bigint() % 1_000_000_000n);
  return withFileName(path, `.${name}.partial-${process.pid}-${next++}-${nanos.toString(16)}`);
}

/** `std::fs::remove_dir_all`: a symlink is unlinked, a directory removed whole, a file kept. */
function removeDirAll(path: string): void {
  try {
    const meta = lstatSync(path);
    if (meta.isSymbolicLink()) unlinkSync(path);
    else if (meta.isDirectory()) rmSync(path, { recursive: true, force: true });
  } catch {
    // Every caller ignores the outcome.
  }
}

/**
 * Removes leftovers of installs that were killed before they could rename. An hour is far
 * longer than any download, so a live install is never hit.
 */
function sweepStale(parent: string): void {
  const cutoff = 3600 * 1000;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!(name.startsWith(".") && name.includes(".partial-"))) continue;
    const path = rustJoin(parent, name);
    let old = false;
    try {
      const age = Date.now() - lstatSync(path).mtimeMs;
      old = age >= 0 && age > cutoff;
    } catch {
      old = false;
    }
    if (old) removeDirAll(path);
  }
}

/** Whether `dir` holds exactly `files`, byte for byte. */
export function holds(dir: string, files: readonly (readonly [string, Uint8Array])[]): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return (
    names.length === files.length &&
    files.every(([name, bytes]) => {
      try {
        return Buffer.from(bytes).equals(readFileSync(rustJoin(dir, name)));
      } catch {
        return false;
      }
    })
  );
}

/**
 * `OpenOptions::new().write(true).create_new(true).mode(mode)`: refuses anything already at
 * `path`, a symlink included. Answers the file descriptor; throws an `IoError`.
 */
export function createNew(path: string, mode: number): number {
  try {
    return openSync(path, "wx", UNIX ? mode : undefined);
  } catch (e) {
    throw toIoError(e);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  } catch (e) {
    throw toIoError(e);
  } finally {
    closeSync(fd);
  }
}

/** Whether `name` is a single path component naming itself, as Rust judges it. */
function isPlainName(name: string): boolean {
  const seps = UNIX ? /\// : /[\\/]/;
  if (name === "" || name === "." || name === ".." || seps.test(name)) return false;
  if (!UNIX && /^[A-Za-z]:/.test(name)) return false;
  return true;
}

/**
 * Makes `dir` a directory holding exactly `files`. Each name must be a plain file name: nothing
 * is written outside `dir`.
 *
 * The finished directory is renamed straight onto `dir`, so a reader sees the old entry or the
 * new one. When `dir` already exists the entry is either what a concurrent install just wrote
 * (kept, ours discarded) or something else, which is moved aside whole before ours takes its
 * place. Throws an `IoError`.
 */
export function installDir(dir: string, files: readonly (readonly [string, Uint8Array])[]): void {
  const parent = parentOf(dir) || ".";
  createPrivateDirs(parent);
  sweepStale(parent);
  const tmp = partial(dir);
  createPrivateDir(tmp);
  try {
    for (const [name, bytes] of files) {
      if (!isPlainName(name)) throw new IoError(`\`${name}\` is not a plain file name`, "EINVAL");
      writeAll(createNew(rustJoin(tmp, name), 0o600), bytes);
    }
  } catch (e) {
    removeDirAll(tmp);
    throw toIoError(e);
  }
  let last: IoError | undefined;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, dir);
      return;
    } catch (e) {
      last = toIoError(e);
      if (!existsSync(dir)) continue;
    }
    if (holds(dir, files)) {
      removeDirAll(tmp);
      return;
    }
    const aside = partial(dir);
    try {
      renameSync(dir, aside);
      removeDirAll(aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") last = toIoError(e);
    }
  }
  removeDirAll(tmp);
  throw last ?? new IoError("could not install the directory");
}

/** Writes `bytes` beside `path` and renames it into place; 0755 when `executable`. */
export function installFile(path: string, bytes: Uint8Array, executable: boolean): void {
  const parent = parentOf(path) || ".";
  createPrivateDirs(parent);
  sweepStale(parent);
  const tmp = partial(path);
  const mode = executable ? 0o755 : 0o600;
  try {
    writeAll(createNew(tmp, mode), bytes);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw toIoError(e);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw toIoError(e);
  }
}

/** `Path::is_file`: follows links. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
