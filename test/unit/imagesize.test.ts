// Parity tests for the imagesize port against the Rust crate, version 0.15.0. The crate ships no
// test suite in its published package; its doc examples are ported below. The bulk of the checks
// replay fixtures/imagesize-oracle.json, which fixtures/make-fixture.mjs builds by running the
// real crate (oracle/) over every prefix of each corpus source and seeded byte-mutants of each.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  blobSize,
  ImageError,
  type ImageType,
  imageMime,
  imageType,
  UNSUPPORTED_BY_PORT,
} from "../../src/core/imagesize.ts";

interface Fixture {
  caseCount: number;
  sources: [string, string][];
  results: [string, string, string][];
  prefixRuns: [number, number, number, number][];
  mutants: [number, number[], number][];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/imagesize/imagesize-oracle.json", import.meta.url), "utf8"),
);
const sources = fixture.sources.map(
  ([name, b64]) => [name, new Uint8Array(Buffer.from(b64, "base64"))] as const,
);

interface Case {
  label: string;
  bytes: Uint8Array;
  result: [string, string, string];
}

function* cases(): Generator<Case> {
  for (const [src, from, to, r] of fixture.prefixRuns) {
    const [name, bytes] = sources[src]!;
    for (let len = from; len <= to; len++) {
      yield { label: `${name}[..${len}]`, bytes: bytes.slice(0, len), result: fixture.results[r]! };
    }
  }
  for (const [i, [src, edits, r]] of fixture.mutants.entries()) {
    const [name, original] = sources[src]!;
    const bytes = original.slice();
    for (let e = 0; e < edits.length; e += 2) {
      bytes[edits[e]!] = edits[e + 1]!;
    }
    yield {
      label: `${name} mutant #${i} ${JSON.stringify(edits)}`,
      bytes,
      result: fixture.results[r]!,
    };
  }
}

/** Rust's `{:?}` of the `ImageType`, reduced the way this port reduces it. */
function describeType(t: ImageType): string {
  return t.kind === "Heif" ? `Heif(${t.compression})` : t.kind;
}

function portedType(rustDebug: string): string {
  return /^(Jpeg|Png|Gif|Tiff|Webp|Heif\(\w+\))$/.test(rustDebug) ? rustDebug : "Other";
}

function attempt<T>(f: () => T, show: (v: T) => string): string {
  try {
    return show(f());
  } catch (err) {
    if (err instanceof ImageError) {
      return `ERR:${err.message}`;
    }
    if (err instanceof Error && err.message === UNSUPPORTED_BY_PORT) {
      return "UNSUPPORTED";
    }
    throw err;
  }
}

const NOT_SUPPORTED = "ERR:Could not decode image";
const SIZED = /^(Jpeg|Png|Gif|Webp|Heif\(\w+\))$/;

describe("oracle corpus", () => {
  const all = [...cases()];

  it("replays every case the oracle ran", () => {
    expect(all.length).toBe(fixture.caseCount);
  });

  it("imageMime matches hpy's match on image_type", () => {
    const bad = all
      .filter((c) => (imageMime(c.bytes) ?? "null") !== c.result[1])
      .map((c) => `${c.label}: got ${imageMime(c.bytes)}, Rust ${c.result[1]}`);
    expect(bad).toEqual([]);
  });

  it("imageType matches image_type up to HEIF, and its errors", () => {
    const bad: string[] = [];
    for (const c of all) {
      // The port stops at HEIF, so NotSupported is one of the types it reports as Other.
      const rust = c.result[0];
      const want =
        rust === NOT_SUPPORTED ? "Other" : rust.startsWith("ERR:") ? rust : portedType(rust);
      const got = attempt(() => imageType(c.bytes), describeType);
      if (got !== want) {
        bad.push(`${c.label}: got ${got}, Rust ${c.result[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("blobSize matches blob_size for PNG, JPEG, WebP, GIF, HEIF and short input", () => {
    const bad: string[] = [];
    let compared = 0;
    for (const c of all) {
      const [type, , size] = c.result;
      const got = attempt(
        () => blobSize(c.bytes),
        (s) => `${s.width}x${s.height}`,
      );
      // NotSupported and every type after HEIF look alike to the port, which does not size them.
      const sized = SIZED.test(type) || (type.startsWith("ERR:") && type !== NOT_SUPPORTED);
      const want = sized ? size : "UNSUPPORTED";
      if (want !== "UNSUPPORTED") {
        compared++;
      }
      if (got !== want) {
        bad.push(`${c.label}: got ${got}, Rust ${size} (${type})`);
      }
    }
    expect(bad).toEqual([]);
    expect(compared).toBeGreaterThan(5000);
  });

  it("covers each accepted type, HEIF with other compressions, and other formats", () => {
    const types = new Set(fixture.results.map((r) => r[0].replace(/^ERR:.*/, "ERR")));
    for (const t of ["Png", "Jpeg", "Webp", "Gif", "Heif(Av1)", "Heif(Hevc)", "Heif(Jpeg)"]) {
      expect(types).toContain(t);
    }
    for (const t of ["Heif(Unknown)", "Tiff", "Bmp", "Ico", "ERR"]) {
      expect(types).toContain(t);
    }
  });
});

// Doc examples from src/lib.rs.
describe("crate doc examples", () => {
  it("reader_size reads a PNG header as 123x321", () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x7b, 0x00, 0x00, 0x01, 0x41, 0x08, 0x06, 0x00, 0x00, 0x00, 0x9a,
      0x38, 0xc4,
    ]);
    expect(blobSize(png)).toEqual({ width: 123, height: 321 });
    expect(imageMime(png)).toBe("image/png");
  });

  it("blob_size rejects arbitrary data", () => {
    const data = Uint8Array.from([
      0x89, 0x89, 0x89, 0x89, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x7b, 0x01, 0x00, 0x01, 0x41, 0x08, 0x06, 0x00, 0x00, 0x00, 0x9a,
      0x38, 0xc4,
    ]);
    expect(() => blobSize(data)).toThrow();
    expect(imageMime(data)).toBeNull();
  });

  it("input shorter than 12 bytes is an IoError", () => {
    const err = attempt(
      () => blobSize(new Uint8Array(11)),
      () => "ok",
    );
    expect(err).toBe("ERR:failed to fill whole buffer");
  });
});
