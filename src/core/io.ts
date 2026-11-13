// std::io's error text, for messages that print an `io::Error` with `{e}`:
// `No such file or directory (os error 2)`. Rust's Display is the C library's strerror for the
// errno, then ` (os error N)`; Windows prints FormatMessage's text instead.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rustParent } from "./paths.ts";

/** An I/O failure whose `message` is the Rust `io::Error`'s Display. */
export class IoError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "IoError";
    this.code = code;
  }
}

// strerror(3) on macOS and glibc agree for these; their errno values agree too.
const UNIX: Record<string, [number, string]> = {
  EPERM: [1, "Operation not permitted"],
  ENOENT: [2, "No such file or directory"],
  EIO: [5, "Input/output error"],
  ENOEXEC: [8, "Exec format error"],
  EBADF: [9, "Bad file descriptor"],
  EACCES: [13, "Permission denied"],
  EEXIST: [17, "File exists"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  EINVAL: [22, "Invalid argument"],
  EMFILE: [24, "Too many open files"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
};

// No ENOEXEC: Windows reports a bad executable as ERROR_BAD_EXE_FORMAT, which libuv names
// EFTYPE, and HappyView, the program `hpy` starts, has no Windows build to run.
const WINDOWS: Record<string, [number, string]> = {
  ENOENT: [2, "The system cannot find the file specified."],
  EACCES: [5, "Access is denied."],
  EPERM: [5, "Access is denied."],
  EEXIST: [80, "The file exists."],
};

/** Rust's Display for the `io::Error` behind a Node fs error. */
export function ioErrorText(e: unknown): string {
  if (e instanceof IoError) return e.message;
  const err = e as NodeJS.ErrnoException;
  const code = err?.code;
  const table = process.platform === "win32" ? WINDOWS : UNIX;
  const known = code !== undefined ? table[code] : undefined;
  if (known) return `${known[1]} (os error ${known[0]})`;
  if (typeof err?.errno === "number") {
    const n = Math.abs(err.errno);
    const text = err.message?.replace(/^[A-Z]+: /, "").replace(/, .*$/, "") ?? "unknown error";
    return `${text} (os error ${n})`;
  }
  return String(err?.message ?? e);
}

export function toIoError(e: unknown): IoError {
  if (e instanceof IoError) return e;
  return new IoError(ioErrorText(e), (e as NodeJS.ErrnoException)?.code);
}

/** `std::fs::read_to_string`: throws an `IoError`, including on invalid UTF-8. */
export function readToString(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw toIoError(e);
  }
  try {
    // Rust keeps a byte-order mark; so does a non-stripping decoder.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new IoError("stream did not contain valid UTF-8", "InvalidData");
  }
}

/** `std::fs::write`. */
export function writeString(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch (e) {
    throw toIoError(e);
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `std::fs::create_dir_all` (or `DirBuilder::new().recursive(true)` with `mode`, which every
 * directory it creates gets, less the umask). Node's `mkdirSync({ recursive })` reports a
 * file in the way differently, so this follows std's own walk: `mkdir`, then the parent and
 * `mkdir` again when it was missing, and success whenever a directory ends up there.
 */
export function createDirAll(path: string, mode?: number): void {
  const mkdir = (p: string): void => {
    mkdirSync(p, mode === undefined ? undefined : { mode });
  };
  const walk = (p: string): void => {
    if (p === "") return;
    try {
      mkdir(p);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        if (isDir(p)) return;
        throw toIoError(e);
      }
    }
    const parent = rustParent(p);
    if (parent === undefined) throw new IoError("failed to create whole tree", "Uncategorized");
    walk(parent);
    try {
      mkdir(p);
    } catch (e) {
      if (!isDir(p)) throw toIoError(e);
    }
  };
  walk(path);
}
