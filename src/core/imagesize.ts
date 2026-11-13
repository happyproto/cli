// A port of the part of the Rust `imagesize` crate, version 0.15.0 (default features), that hpy
// uses: `image_type` for PNG, JPEG, WebP, GIF and HEIF, and `blob_size` for those five types.
//
// hpy maps `image_type` to a MIME type and rejects everything else, then calls `blob_size`.
// `imageMime` reproduces that mapping. `blobSize` reproduces `blob_size` byte for byte for any
// input whose type is PNG, JPEG, WebP, GIF or HEIF (any compression), and for inputs shorter than
// the 12-byte header. For anything else it throws `UNSUPPORTED_BY_PORT`, because telling "another
// format the crate can size" from "no format at all" would mean porting the other 20 detectors.
//
// Sources: src/lib.rs, src/util.rs, src/formats/mod.rs (detection order),
// src/formats/{jpeg,png,gif,tiff,webp}.rs and src/container/heif.rs.

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif";

/** `heif::Compression`. */
export type HeifCompression = "Av1" | "Hevc" | "Jpeg" | "Unknown";

/**
 * The subset of `ImageType` this port detects. `Tiff` is detected only because it is checked
 * before WebP and HEIF; `Other` stands for every type checked after HEIF and for `NotSupported`.
 */
export type ImageType =
  | { kind: "Jpeg" }
  | { kind: "Png" }
  | { kind: "Gif" }
  | { kind: "Tiff" }
  | { kind: "Webp" }
  | { kind: "Heif"; compression: HeifCompression }
  | { kind: "Other" };

/** `ImageError`. `message` is the error's `Display`. */
export class ImageError extends Error {
  readonly kind: "NotSupported" | "CorruptedImage" | "IoError";

  constructor(kind: "NotSupported" | "CorruptedImage" | "IoError", message: string) {
    super(message);
    this.name = "ImageError";
    this.kind = kind;
  }
}

/** Thrown by `blobSize` for inputs whose type this port does not size (see the file header). */
export const UNSUPPORTED_BY_PORT =
  "imagesize port: blobSize supports only PNG, JPEG, WebP, GIF and HEIF input";

function corrupted(): ImageError {
  return new ImageError("CorruptedImage", "Hit end of file before finding size");
}

function ioError(message: string): ImageError {
  return new ImageError("IoError", message);
}

// std's messages for `Read::read_exact` past the end and for an invalid `Seek` on a `Cursor`.
const READ_EXACT_EOF = "failed to fill whole buffer";
const INVALID_SEEK = "invalid seek to a negative or overflowing position";

/** `std::io::Cursor<&[u8]>`: the position may sit past the end; reads there fail. */
class Cursor {
  readonly data: Uint8Array;
  pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readExact(n: number): Uint8Array {
    if (this.pos > this.data.length || this.data.length - this.pos < n) {
      throw ioError(READ_EXACT_EOF);
    }
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  seekStart(n: number): void {
    this.pos = n;
  }

  seekCurrent(offset: number): void {
    const next = this.pos + offset;
    if (next < 0) {
      throw ioError(INVALID_SEEK);
    }
    this.pos = next;
  }
}

type Endian = "little" | "big";

function readU8(r: Cursor): number {
  return r.readExact(1)[0]!;
}

function readU16(r: Cursor, e: Endian): number {
  const b = r.readExact(2);
  return e === "little" ? b[0]! | (b[1]! << 8) : (b[0]! << 8) | b[1]!;
}

function readU24(r: Cursor, e: Endian): number {
  const b = r.readExact(3);
  return e === "little"
    ? (b[2]! << 16) | (b[1]! << 8) | b[0]!
    : (b[0]! << 16) | (b[1]! << 8) | b[2]!;
}

function readU32(r: Cursor, e: Endian): number {
  const b = r.readExact(4);
  const v =
    e === "little"
      ? b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)
      : (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!;
  return v >>> 0;
}

/** `util::read_tag`: a big-endian u32 size, then a 4-byte tag. */
function readTag(r: Cursor): { tag: Uint8Array; size: number } {
  const size = readU32(r, "big");
  const tag = r.readExact(4);
  return { tag, size };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((b, i) => bytes[i] === b);
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function equalsAscii(bytes: Uint8Array, text: string): boolean {
  return bytes.length === text.length && startsWith(bytes, ascii(text));
}

// --- detection (formats/mod.rs) ---------------------------------------------------------------

function jpegMatches(header: Uint8Array): boolean {
  return startsWith(header, [0xff, 0xd8, 0xff]);
}

function pngMatches(header: Uint8Array): boolean {
  return startsWith(header, [0x89, ...ascii("PNG")]);
}

function gifMatches(header: Uint8Array): boolean {
  return startsWith(header, ascii("GIF8"));
}

function tiffMatches(header: Uint8Array): boolean {
  const marker = (b: number | undefined) => b === 0x2a || b === 0x2b;
  return (
    (startsWith(header, ascii("II")) && marker(header[2]) && header[3] === 0) ||
    (startsWith(header, [...ascii("MM"), 0]) && marker(header[3]))
  );
}

function webpMatches(header: Uint8Array): boolean {
  return (
    header.length >= 12 &&
    equalsAscii(header.subarray(0, 4), "RIFF") &&
    equalsAscii(header.subarray(8, 12), "WEBP")
  );
}

const HEVC_BRANDS = ["heic", "heix", "heis", "hevs", "heim", "hevm", "hevc", "hevx"];
const AV1_BRANDS = ["avif", "avio", "avis", "MA1A", "MA1B"];
const JPEG_BRANDS = ["jpeg", "jpgs"];
const HEIF_BRANDS = ["mif1", "msf1", "mif2", "miaf"];

function brandIn(brand: Uint8Array, list: readonly string[]): boolean {
  return list.some((b) => equalsAscii(brand, b));
}

function heifInnerMatches(brand: Uint8Array): HeifCompression | null {
  if (brandIn(brand, HEVC_BRANDS)) {
    return "Hevc";
  }
  if (brandIn(brand, AV1_BRANDS)) {
    return "Av1";
  }
  if (brandIn(brand, JPEG_BRANDS)) {
    return "Jpeg";
  }
  return null;
}

/** `heif::matches`. Reads the 12 bytes after the header from `reader` for `mif1`-style brands. */
function heifMatches(header: Uint8Array, reader: Cursor): HeifCompression | null {
  if (header.length < 12 || !equalsAscii(header.subarray(4, 8), "ftyp")) {
    return null;
  }
  const brand = header.subarray(8, 12);
  const direct = heifInnerMatches(brand);
  if (direct !== null) {
    return direct;
  }
  if (brandIn(brand, HEIF_BRANDS)) {
    let buf: Uint8Array;
    try {
      buf = reader.readExact(12);
    } catch {
      return "Unknown";
    }
    const brand2 = buf.subarray(4, 8);
    const second = heifInnerMatches(brand2);
    if (second !== null) {
      return second;
    }
    if (brandIn(brand2, HEIF_BRANDS)) {
      const third = heifInnerMatches(buf.subarray(8, 12));
      if (third !== null) {
        return third;
      }
    }
  }
  return "Unknown";
}

/** `formats::image_type`, as far as HEIF; everything after it is `Other`. */
function detect(reader: Cursor): ImageType {
  const header = reader.readExact(12);
  if (jpegMatches(header)) {
    return { kind: "Jpeg" };
  }
  if (pngMatches(header)) {
    return { kind: "Png" };
  }
  if (gifMatches(header)) {
    return { kind: "Gif" };
  }
  if (tiffMatches(header)) {
    return { kind: "Tiff" };
  }
  if (webpMatches(header)) {
    return { kind: "Webp" };
  }
  const compression = heifMatches(header, reader);
  if (compression !== null) {
    return { kind: "Heif", compression };
  }
  return { kind: "Other" };
}

/** `imagesize::image_type`, reduced to this port's `ImageType`. Throws `ImageError` like Rust. */
export function imageType(bytes: Uint8Array): ImageType {
  return detect(new Cursor(bytes));
}

/** hpy's match on `image_type`: the MIME type, or null where hpy's match falls to `_`. */
export function imageMime(bytes: Uint8Array): ImageMime | null {
  let type: ImageType;
  try {
    type = imageType(bytes);
  } catch {
    return null;
  }
  switch (type.kind) {
    case "Png":
      return "image/png";
    case "Jpeg":
      return "image/jpeg";
    case "Webp":
      return "image/webp";
    case "Gif":
      return "image/gif";
    case "Heif":
      return type.compression === "Av1" ? "image/avif" : null;
    default:
      return null;
  }
}

// --- sizes ------------------------------------------------------------------------------------

export interface ImageSize {
  width: number;
  height: number;
}

function pngSize(r: Cursor): ImageSize {
  r.seekStart(0x10);
  const width = readU32(r, "big");
  const height = readU32(r, "big");
  return { width, height };
}

function gifSize(r: Cursor): ImageSize {
  r.seekStart(6);
  const width = readU16(r, "little");
  const height = readU16(r, "little");
  return { width, height };
}

function jpegSize(r: Cursor): ImageSize {
  let depth = 0;
  r.seekStart(2);
  for (;;) {
    const marker = r.readExact(2);
    if (marker[0] !== 0xff) {
      throw corrupted();
    }
    const page = marker[1]!;
    if (
      (page >= 0xc0 && page <= 0xc3) ||
      (page >= 0xc5 && page <= 0xc7) ||
      (page >= 0xc9 && page <= 0xcb) ||
      (page >= 0xcd && page <= 0xcf)
    ) {
      if (depth === 0) {
        r.seekCurrent(3);
        break;
      }
    } else if (page === 0xd8) {
      depth += 1;
    } else if (page === 0xd9) {
      depth -= 1;
      if (depth < 0) {
        throw corrupted();
      }
    }
    const pageSize = readU16(r, "big");
    r.seekCurrent(pageSize - 2);
  }
  const height = readU16(r, "big");
  const width = readU16(r, "big");
  return { width, height };
}

/** `webp::size`. Reads the chunk tag at the position `image_type` left (just past the header). */
function webpSize(r: Cursor): ImageSize {
  const buffer = r.readExact(4);
  const last = buffer[3];
  if (last === 0x20) {
    r.seekStart(0x1a);
    const width = readU16(r, "little");
    const height = readU16(r, "little");
    return { width, height };
  }
  if (last === 0x4c) {
    r.seekStart(0x15);
    const dims = readU32(r, "little");
    return { width: (dims & 0x3fff) + 1, height: ((dims >>> 14) & 0x3fff) + 1 };
  }
  if (last === 0x58) {
    r.seekStart(0x18);
    const width = readU24(r, "little") + 1;
    const height = readU24(r, "little") + 1;
    return { width, height };
  }
  throw ioError("Invalid VP8 Tag");
}

function skipToTag(r: Cursor, tag: string): number {
  for (;;) {
    const size = readU32(r, "big");
    const found = r.readExact(4);
    if (equalsAscii(found, tag)) {
      return size;
    }
    if (size >= 8) {
      r.seekCurrent(size - 8);
    } else {
      throw ioError(`Invalid heif box size: ${size}`);
    }
  }
}

function heifSize(r: Cursor): ImageSize {
  r.seekStart(0);
  const ftypSize = readU32(r, "big");
  r.seekStart(ftypSize);
  skipToTag(r, "meta");
  readU32(r, "big");
  skipToTag(r, "iprp");
  let ipcoSize = skipToTag(r, "ipco");

  let maxWidth = 0;
  let maxHeight = 0;
  let foundIspe = false;
  let rotation = 0;

  for (;;) {
    let tag: Uint8Array;
    let size: number;
    try {
      ({ tag, size } = readTag(r));
    } catch {
      break;
    }
    if (size < 8) {
      if (equalsAscii(tag, "mdat")) {
        break;
      }
      throw corrupted();
    }
    if (equalsAscii(tag, "ispe")) {
      foundIspe = true;
      readU32(r, "big");
      const width = readU32(r, "big");
      const height = readU32(r, "big");
      // usize arithmetic on 64-bit: the products of two u32s are exact only as BigInt.
      if (BigInt(width) * BigInt(height) > BigInt(maxWidth) * BigInt(maxHeight)) {
        maxWidth = width;
        maxHeight = height;
      }
    } else if (equalsAscii(tag, "irot")) {
      rotation = readU8(r);
    } else if (size >= ipcoSize) {
      break;
    } else {
      ipcoSize -= size;
      r.seekCurrent(size - 8);
    }
  }

  if (!foundIspe) {
    throw ioError("Not enough data");
  }
  if (rotation === 1 || rotation === 3) {
    [maxWidth, maxHeight] = [maxHeight, maxWidth];
  }
  return { width: maxWidth, height: maxHeight };
}

/** `imagesize::blob_size` for PNG, JPEG, WebP, GIF and HEIF input. Throws `ImageError` like Rust. */
export function blobSize(bytes: Uint8Array): ImageSize {
  const reader = new Cursor(bytes);
  const type = detect(reader);
  switch (type.kind) {
    case "Png":
      return pngSize(reader);
    case "Jpeg":
      return jpegSize(reader);
    case "Webp":
      return webpSize(reader);
    case "Gif":
      return gifSize(reader);
    case "Heif":
      return heifSize(reader);
    default:
      throw new Error(UNSUPPORTED_BY_PORT);
  }
}
