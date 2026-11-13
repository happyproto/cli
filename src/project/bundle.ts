// crates/hpy/src/project/bundle.rs: the project as `hpy happyview deploy` sends it:
// `happyview.toml`, every file under `src/`, and each `[modules]` build, as a gzipped tar that
// is byte-for-byte the same for the same files, so the instance can tell an unchanged project
// from a changed one. The bytes must equal Rust's, so the tar writer and the deflate
// compressor are ports of the crates hpy uses (src/core/tar.ts, src/core/deflate.ts).
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { GzipWriter } from "../core/deflate.ts";
import { Failure } from "../core/failure.ts";
import { ioErrorText } from "../core/io.ts";
import { rustJoin } from "../core/paths.ts";
import { Header, TarBuilder, TarError } from "../core/tar.ts";

// crates/hpy/src/project/modules.rs's BUILD_DIR. Defined here until modules.ts is ported;
// the integrator dedupes it.
const BUILD_DIR = ".happyview/build";

export interface Bundle {
  /** The gzipped tar. */
  bytes: Uint8Array;
  /** Its sha256, lowercase hex. */
  sha256: string;
  /** Every path in it, in archive order. */
  files: string[];
}

interface Entry {
  rel: string;
  relBytes: Buffer;
  /** The real path, as bytes, so a name that isn't UTF-8 still opens. */
  path: Buffer;
}

const lossy = (b: Uint8Array) => new TextDecoder().decode(b);
const SEP = Buffer.from(process.platform === "win32" ? "\\" : "/");

function entry(rel: string, path: Buffer): Entry {
  return { rel, relBytes: Buffer.from(rel), path };
}

/**
 * Every regular file under `dir`, as `/`-separated paths relative to the root. A symlink is
 * refused: following it could send a file from outside the project, and HappyView refuses one
 * in a bundle anyway.
 */
function walk(dir: Buffer, display: string, rel: string[], out: Entry[]): void {
  let names: Buffer[];
  try {
    names = readdirSync(dir, { encoding: "buffer" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw Failure.runtime(`reading ${display}: ${ioErrorText(e)}`);
  }
  for (const name of names) {
    const path = Buffer.concat([dir, SEP, name]);
    const parts = [...rel, lossy(name)];
    const r = parts.join("/");
    let meta: ReturnType<typeof lstatSync>;
    try {
      meta = lstatSync(path);
    } catch (e) {
      throw Failure.runtime(`reading ${r}: ${ioErrorText(e)}`);
    }
    if (meta.isSymbolicLink()) {
      throw Failure.usage(
        `${r} is a symlink; a deploy sends only regular files, so copy the file there instead`,
      );
    }
    if (meta.isDirectory()) walk(path, rustJoin(display, lossy(name)), parts, out);
    else if (meta.isFile()) out.push(entry(r, path));
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Rust's `(String, PathBuf)` order: the path string's UTF-8 bytes, then the real path. */
function compare(a: Entry, b: Entry): number {
  return Buffer.compare(a.relBytes, b.relBytes) || Buffer.compare(a.path, b.path);
}

/**
 * Bundles the project at `root` with the builds of `modules`, which must already be in
 * `.happyview/build/`.
 */
export function bundle(root: string, modules: readonly string[]): Bundle {
  const files: Entry[] = [entry("happyview.toml", Buffer.from(rustJoin(root, "happyview.toml")))];
  const src = rustJoin(root, "src");
  walk(Buffer.from(src), src, ["src"], files);
  for (const name of modules) {
    const rel = `${BUILD_DIR}/${name}.wasm`;
    const path = rustJoin(root, rel);
    if (!isFile(path)) {
      throw Failure.usage(`module \`${name}\` has no build at ${rel}; run \`hpy happyview build\``);
    }
    files.push(entry(rel, Buffer.from(path)));
  }
  files.sort(compare);

  // Fixed modes, owners and times, and none of the machine's names, so only the paths and
  // contents decide the bytes.
  const gz = new GzipWriter();
  const tar = new TarBuilder((chunk) => gz.write(chunk));
  for (const { rel, path } of files) {
    let body: Uint8Array;
    try {
      body = readFileSync(path);
    } catch (e) {
      throw Failure.runtime(`reading ${rel}: ${ioErrorText(e)}`);
    }
    const header = Header.ustar();
    header.setSize(body.length);
    header.setMode(0o644);
    header.setMtime(0);
    header.setUid(0);
    header.setGid(0);
    header.setEntryType(0x30 /* Regular */);
    try {
      tar.appendData(header, rel, body);
    } catch (e) {
      if (e instanceof TarError) throw Failure.runtime(`bundling ${rel}: ${e.message}`);
      throw e;
    }
  }
  tar.finish();
  const bytes = gz.finish();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, files: files.map((f) => f.rel) };
}
