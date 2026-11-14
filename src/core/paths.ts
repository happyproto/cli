// etcetera's base strategy, as hpy uses it: XDG on every Unix (macOS included),
// the Known Folders on Windows.
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

const env = (k: string) => {
  const v = process.env[k];
  return v !== undefined && v !== "" ? v : undefined;
};

/** `$XDG_*` only counts when it is an absolute path, as in etcetera. */
const xdg = (k: string) => {
  const v = env(k);
  return v?.startsWith("/") ? v : undefined;
};

export function configBase(): string {
  if (process.platform === "win32") return env("APPDATA") ?? join(homedir(), "AppData", "Roaming");
  return xdg("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
}

export function cacheBase(): string {
  if (process.platform === "win32")
    return env("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local");
  return xdg("XDG_CACHE_HOME") ?? join(homedir(), ".cache");
}

export function dataBase(): string {
  if (process.platform === "win32") return env("APPDATA") ?? join(homedir(), "AppData", "Roaming");
  return xdg("XDG_DATA_HOME") ?? join(homedir(), ".local", "share");
}

/** `$XDG_CONFIG_HOME/hpy` or `~/.config/hpy` on every Unix, `%APPDATA%\hpy` on Windows. */
export function configDir(): string {
  return join(configBase(), "hpy");
}

/**
 * `Path::join` as Rust does it: an absolute `p` replaces `base`, nothing is
 * normalized, and one separator is added unless `base` already ends in one.
 * Messages print paths the Rust way, so `..` stays where the user wrote it.
 */
export function rustJoin(base: string, ...parts: string[]): string {
  let out = base;
  for (const p of parts) {
    if (isAbsolute(p)) out = p;
    else if (out === "" || out.endsWith(sep) || out.endsWith("/")) out += p;
    else out += sep + p;
  }
  return out;
}

// --- std::path, lexically ---
// Rust's `Path` methods work on components, not strings: repeated separators and interior `.`
// collapse, a trailing separator is ignored, and `..` is kept as written. These follow
// library/std/src/path.rs for Unix-style paths (and `\` as well on Windows); they never touch
// the file system.

const isSep = (c: string) => c === "/" || (process.platform === "win32" && c === "\\");

/** A path's components as `Path::components` yields them: `/` for the root, `.` only first. */
export function rustComponents(p: string): string[] {
  const out: string[] = [];
  let i = 0;
  if (p.length > 0 && isSep(p[0]!)) {
    out.push("/");
    while (i < p.length && isSep(p[i]!)) i++;
  }
  let first = true;
  while (i <= p.length) {
    let j = i;
    while (j < p.length && !isSep(p[j]!)) j++;
    const part = p.slice(i, j);
    if (part === "." && first && out.length === 0) out.push(".");
    else if (part !== "" && part !== ".") out.push(part);
    first = false;
    if (j >= p.length) break;
    i = j + 1;
  }
  return out;
}

/** `Path::file_name`: the last component when it is a name (not `..`, `.` or the root). */
export function rustFileName(p: string): string | undefined {
  const last = rustComponents(p).at(-1);
  return last === undefined || last === "/" || last === "." || last === ".." ? undefined : last;
}

/**
 * `Path::parent`: the path without its last component, `""` for a one-component relative
 * path, `undefined` for the root or the empty path. The result keeps the original spelling,
 * less trailing separators and `.` components, as `Components::as_path` trims them.
 */
export function rustParent(p: string): string | undefined {
  const last = rustComponents(p).at(-1);
  if (last === undefined || last === "/") return undefined;
  if (last === ".") return "";
  const min = isSep(p[0] ?? "") ? 1 : 0;
  const end = trimRight(p, p.length, min);
  let start = end;
  while (start > 0 && !isSep(p[start - 1]!)) start--;
  return p.slice(0, trimRight(p, start, min));
}

/** Drops trailing separators and `.` components from `p[..end]`, keeping a root of `min` bytes. */
function trimRight(p: string, end: number, min: number): number {
  for (;;) {
    while (end > min && isSep(p[end - 1]!)) end--;
    if (end - min >= 2 && p[end - 1] === "." && isSep(p[end - 2]!)) end--;
    else return end;
  }
}

/** `rsplit_file_at_dot`: `[before, after]` as std splits a file name for stem and extension. */
function splitAtDot(name: string): [string | undefined, string | undefined] {
  if (name === "..") return [name, undefined];
  const dot = name.lastIndexOf(".");
  if (dot === -1) return [undefined, name];
  const before = name.slice(0, dot);
  const after = name.slice(dot + 1);
  return before === "" ? [name, undefined] : [before, after];
}

/** `Path::file_stem`. */
export function rustFileStem(p: string): string | undefined {
  const name = rustFileName(p);
  if (name === undefined) return undefined;
  const [before, after] = splitAtDot(name);
  return before ?? after;
}

/** `Path::extension`. */
export function rustExtension(p: string): string | undefined {
  const name = rustFileName(p);
  if (name === undefined) return undefined;
  const [before, after] = splitAtDot(name);
  return before === undefined ? undefined : after;
}

/** `Path::with_file_name`. */
export function rustWithFileName(p: string, name: string): string {
  const parent = rustFileName(p) === undefined ? p : (rustParent(p) ?? "");
  return parent === "" ? name : rustJoin(parent, name);
}

/** `Path::with_extension`: replaces the extension, or adds one; `""` removes it. */
export function rustWithExtension(p: string, extension: string): string {
  const stem = rustFileStem(p);
  if (stem === undefined) return p;
  const name = extension === "" ? stem : `${stem}.${extension}`;
  return rustWithFileName(p, name);
}

/** `PathBuf`'s `Ord`: component by component, each by its bytes. */
export function comparePaths(a: string, b: string): number {
  const x = rustComponents(a);
  const y = rustComponents(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = compareBytes(x[i]!, y[i]!);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** `Path`'s `==`: the same components. */
export function samePath(a: string, b: string): boolean {
  return comparePaths(a, b) === 0;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
