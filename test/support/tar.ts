// crate::testing::tar_xz and binary.rs's raw_tar_xz: `.tar.xz` archives written with GNU
// headers, as `tar::Builder` writes them, compressed at xz2's level 6.
import { xz } from "@napi-rs/lzma";

export type EntryKind = "regular" | "symlink" | "hardlink";

const TYPE: Record<EntryKind, number> = { regular: 0x30, symlink: 0x32, hardlink: 0x31 };

function octal(h: Buffer, off: number, len: number, n: number): void {
  h.write(`${n.toString(8).padStart(len - 1, "0")}\0`, off, len, "latin1");
}

function header(name: Buffer, kind: EntryKind, size: number, mode: number, link?: string): Buffer {
  const h = Buffer.alloc(512);
  name.copy(h, 0, 0, Math.min(name.length, 100));
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, 0);
  h[156] = TYPE[kind];
  if (link) h.write(link, 157, 100, "latin1");
  h.write("ustar  \0", 257, 8, "latin1");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return h;
}

function entry(name: Buffer, kind: EntryKind, bytes: Uint8Array, mode: number): Buffer[] {
  const out: Buffer[] = [];
  const link = kind === "symlink" ? "/etc/passwd" : undefined;
  out.push(header(name, kind, bytes.length, mode, link));
  out.push(Buffer.from(bytes));
  const pad = (512 - (bytes.length % 512)) % 512;
  out.push(Buffer.alloc(pad));
  return out;
}

function finish(parts: Buffer[]): Uint8Array {
  return new Uint8Array(xz.compressSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
}

/** `tar_xz`: regular files with their modes. */
export function tarXz(
  files: readonly (readonly [string, string | Uint8Array, number])[],
): Uint8Array {
  return finish(
    files.flatMap(([path, bytes, mode]) =>
      entry(
        Buffer.from(path),
        "regular",
        typeof bytes === "string" ? Buffer.from(bytes) : bytes,
        mode,
      ),
    ),
  );
}

/** `raw_tar_xz`: names written into the header as given, and any entry type. */
export function rawTarXz(
  entries: readonly (readonly [string, EntryKind, string | Uint8Array])[],
): Uint8Array {
  return finish(
    entries.flatMap(([name, kind, bytes]) =>
      entry(Buffer.from(name), kind, typeof bytes === "string" ? Buffer.from(bytes) : bytes, 0o755),
    ),
  );
}
