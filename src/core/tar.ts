// The tar 0.4.46 crate's writer, as far as `Builder::append_data` with a `Header::new_ustar()`
// needs it: ustar headers (a path over 100 bytes split into prefix and name), the GNU
// `././@LongLink` entry when it can't be split, the crate's octal and checksum encodings, and
// `finish`'s two zero blocks. Paths follow Rust's Unix `Path` semantics. Errors carry the
// crate's `io::Error` text.

const BLOCK = 512;
const enc = new TextEncoder();

/** An `io::Error` from the tar crate; `message` is its Display. */
export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

// The fields of the old (v7) header, which ustar and GNU share.
const NAME = [0, 100] as const;
const MODE = [100, 8] as const;
const UID = [108, 8] as const;
const GID = [116, 8] as const;
const SIZE = [124, 12] as const;
const MTIME = [136, 12] as const;
const CKSUM = [148, 8] as const;
const TYPEFLAG = 156;
const MAGIC = 257;
const PREFIX = [345, 155] as const;

type Field = readonly [number, number];

/** `octal_into`: right-aligned octal, NUL-terminated, zero-padded, high digits dropped. */
function octalInto(dst: Uint8Array, val: number): void {
  const o = val.toString(8);
  dst[dst.length - 1] = 0;
  for (let i = dst.length - 2, j = o.length - 1; i >= 0; i--, j--) {
    dst[i] = j >= 0 ? o.charCodeAt(j) : 0x30;
  }
}

/** `num_field_wrapper_into`: octal, or the binary extension for values that don't fit. */
function numFieldInto(dst: Uint8Array, src: number): void {
  if (src >= 8589934592 || (src >= 2097152 && dst.length === 8)) {
    dst.fill(0);
    let v = BigInt(src);
    for (let i = dst.length - 1; i >= dst.length - 8; i--) {
      dst[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    dst[0]! |= 0x80;
  } else {
    octalInto(dst, src);
  }
}

interface Component {
  kind: "root" | "cur" | "parent" | "normal";
  text: string;
  /** Where the component ends in the path, for `parent`. */
  end: number;
}

/** `Path::components` on Unix. */
function components(path: string): Component[] {
  const out: Component[] = [];
  let i = 0;
  if (path.startsWith("/")) {
    out.push({ kind: "root", text: "/", end: 1 });
    i = 1;
  }
  let first = out.length === 0;
  while (i <= path.length) {
    let j = path.indexOf("/", i);
    if (j < 0) j = path.length;
    const part = path.slice(i, j);
    if (part === "." && first) out.push({ kind: "cur", text: ".", end: j });
    else if (part === "..") out.push({ kind: "parent", text: "..", end: j });
    else if (part !== "" && part !== ".") out.push({ kind: "normal", text: part, end: j });
    first = false;
    i = j + 1;
  }
  return out;
}

/** `Path::parent`. */
function parent(path: string): string | undefined {
  const comps = components(path);
  const last = comps[comps.length - 1];
  if (last === undefined || last.kind === "root") return undefined;
  const before = comps[comps.length - 2];
  return before === undefined ? "" : path.slice(0, before.end);
}

/** `copy_into`, writing into `slot` from `at`; returns the bytes written. */
function copyInto(slot: Uint8Array, at: number, bytes: Uint8Array): number {
  const room = slot.length - at;
  if (bytes.length > room) throw new TarError("provided value is too long");
  if (bytes.includes(0)) throw new TarError("provided value contains a nul byte");
  slot.set(bytes, at);
  if (bytes.length < room) slot[at + bytes.length] = 0;
  return bytes.length;
}

/** `copy_path_into_inner` for an entry name (not a link name), relative paths only. */
function copyPathInto(slot: Uint8Array, path: string, truncatedGnu: boolean): void {
  let at = 0;
  let emitted = false;
  let needsSlash = false;
  const comps = components(path);
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]!;
    if (c.kind === "root") throw new TarError("paths in archives must be relative");
    if (c.kind === "parent" && (!truncatedGnu || i + 1 < comps.length)) {
      throw new TarError("paths in archives must not have `..`");
    }
    if (c.kind === "cur" && comps.length !== 1) continue;
    if (needsSlash) at += copyInto(slot, at, enc.encode("/"));
    at += copyInto(slot, at, enc.encode(c.text));
    needsSlash = true;
    emitted = true;
  }
  if (!emitted) throw new TarError("paths in archives must have at least one component");
  if (path.endsWith("/")) copyInto(slot, at, enc.encode("/"));
}

const nulTrim = (b: Uint8Array) => {
  const i = b.indexOf(0);
  return i < 0 ? b : b.subarray(0, i);
};

/** A 512-byte header block. */
export class Header {
  readonly bytes = new Uint8Array(BLOCK);

  private field([at, len]: Field): Uint8Array {
    return this.bytes.subarray(at, at + len);
  }

  /** `Header::new_ustar()`. */
  static ustar(): Header {
    const h = new Header();
    h.bytes.set(enc.encode("ustar\u000000"), MAGIC);
    h.setMtime(0);
    return h;
  }

  /** `Header::new_gnu()`. */
  static gnu(): Header {
    const h = new Header();
    h.bytes.set(enc.encode("ustar  \u0000"), MAGIC);
    h.setMtime(0);
    return h;
  }

  private isUstar(): boolean {
    const m = this.bytes.subarray(MAGIC, MAGIC + 8);
    return m.every((b, i) => b === "ustar\u000000".charCodeAt(i));
  }

  setSize(size: number): void {
    numFieldInto(this.field(SIZE), size);
  }
  setMode(mode: number): void {
    octalInto(this.field(MODE), mode);
  }
  setUid(uid: number): void {
    numFieldInto(this.field(UID), uid);
  }
  setGid(gid: number): void {
    numFieldInto(this.field(GID), gid);
  }
  setMtime(mtime: number): void {
    numFieldInto(this.field(MTIME), mtime);
  }
  setEntryType(t: number): void {
    this.bytes[TYPEFLAG] = t;
  }

  /** `UstarHeader::path_bytes`, lossily, as the crate's error messages print it. */
  private pathLossy(): string {
    const name = this.field(NAME);
    const prefix = this.field(PREFIX);
    const dec = new TextDecoder();
    if (prefix[0] === 0 && !name.includes(0x5c)) return dec.decode(nulTrim(name));
    const p = nulTrim(prefix);
    return (p.length ? `${dec.decode(p)}/` : "") + dec.decode(nulTrim(name));
  }

  private mapped(f: () => void): void {
    try {
      f();
    } catch (e) {
      if (e instanceof TarError) {
        throw new TarError(`${e.message} when setting path for ${this.pathLossy()}`);
      }
      throw e;
    }
  }

  /** `Header::set_path` on a ustar header (`UstarHeader::_set_path`). */
  setPath(path: string): void {
    if (!this.isUstar()) throw new Error("only ustar headers are ported");
    const bytes = enc.encode(path);
    if (bytes.length <= NAME[1]) {
      this.mapped(() => copyPathInto(this.field(NAME), path, false));
      return;
    }
    let prefix = path;
    let prefixLen: number;
    for (;;) {
      const p = parent(prefix);
      if (p === undefined) {
        throw new TarError(`path cannot be split to be inserted into archive: ${path}`);
      }
      prefix = p;
      prefixLen = enc.encode(prefix).length;
      if (prefixLen <= PREFIX[1]) break;
    }
    this.mapped(() => copyPathInto(this.field(PREFIX), prefix, false));
    const rest = new TextDecoder().decode(bytes.subarray(prefixLen + 1));
    this.mapped(() => copyPathInto(this.field(NAME), rest, false));
  }

  /** `Header::set_cksum`: the byte sum with the checksum field read as spaces. */
  setCksum(): void {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      sum += i >= CKSUM[0] && i < CKSUM[0] + CKSUM[1] ? 0x20 : this.bytes[i]!;
    }
    octalInto(this.field(CKSUM), sum);
  }
}

/** The longest prefix of `data[..max]` that is valid UTF-8, as `str::from_utf8` finds it. */
function utf8Prefix(data: Uint8Array, max: number): string {
  const dec = new TextDecoder("utf-8", { fatal: true });
  for (let n = Math.min(max, data.length); n >= 0; n--) {
    try {
      return dec.decode(data.subarray(0, n));
    } catch {}
  }
  return "";
}

/** `tar::Builder` over a byte sink. */
export class TarBuilder {
  private readonly sink: (chunk: Uint8Array) => void;

  constructor(sink: (chunk: Uint8Array) => void) {
    this.sink = sink;
  }

  private append(header: Header, data: Uint8Array): void {
    this.sink(header.bytes);
    if (data.length) this.sink(data);
    const rem = BLOCK - (data.length % BLOCK);
    if (rem < BLOCK) this.sink(new Uint8Array(rem));
  }

  /** `Builder::append_data` (no absolute paths): sets the path and checksum, then appends. */
  appendData(header: Header, path: string, data: Uint8Array): void {
    this.prepareHeaderPath(header, path);
    header.setCksum();
    this.append(header, data);
  }

  /** `prepare_header_path`: the path in the header, or a GNU long-name entry before it. */
  private prepareHeaderPath(header: Header, path: string): void {
    try {
      header.setPath(path);
    } catch (e) {
      if (!(e instanceof TarError)) throw e;
      const data = enc.encode(path);
      const max = NAME[1];
      if (data.length < max) throw e;
      header.setPath(utf8Prefix(data, max));
      const long = Header.gnu();
      long.bytes.set(enc.encode("././@LongLink"), NAME[0]);
      long.setMode(0o644);
      long.setUid(0);
      long.setGid(0);
      long.setMtime(0);
      long.setSize(data.length + 1);
      long.setEntryType(0x4c /* L */);
      long.setCksum();
      const body = new Uint8Array(data.length + 1);
      body.set(data);
      this.append(long, body);
    }
  }

  /** `Builder::finish`: two zero blocks. */
  finish(): void {
    this.sink(new Uint8Array(2 * BLOCK));
  }
}
