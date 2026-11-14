// src/core/deflate.ts against flate2 1.1.10 with miniz_oxide 0.9.1 (`Compression::default()`,
// `GzBuilder::new().mtime(0)`): test/fixtures/bundle/oracle.json holds the sha256 of the Rust
// output for each input in test/support/bundle-cases.ts, written whole and in chunks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Deflater, deflateRaw, GzipWriter, gzip } from "../../src/core/deflate.ts";
import { STREAM_CASES } from "../support/bundle-cases.ts";

interface Fixture {
  streams: Record<
    string,
    { len: number; gzip: string; gzipLen: number; deflate: string; chunked: Record<string, string> }
  >;
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/bundle/oracle.json", import.meta.url), "utf8"),
);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("deflate and gzip against the Rust oracle", () => {
  it("covers every stream case", () => {
    expect(Object.keys(fixture.streams).sort()).toEqual(STREAM_CASES.map((c) => c.name).sort());
  });

  for (const c of STREAM_CASES) {
    it(`matches flate2 for ${c.name}`, () => {
      const want = fixture.streams[c.name]!;
      const input = c.make();
      expect(input.length).toBe(want.len);
      const gz = gzip(input);
      expect(gz.length).toBe(want.gzipLen);
      expect(sha(gz)).toBe(want.gzip);
      expect(new Uint8Array(gunzipSync(gz))).toEqual(input);
      const raw = deflateRaw(input);
      expect(sha(raw)).toBe(want.deflate);
      expect(new Uint8Array(inflateRawSync(raw))).toEqual(input);
      for (const [n, hash] of Object.entries(want.chunked)) {
        const w = new GzipWriter();
        for (let i = 0; i < input.length; i += Number(n)) w.write(input.subarray(i, i + Number(n)));
        expect(sha(w.finish()), `chunks of ${n}`).toBe(hash);
      }
    });
  }

  it("ignores empty writes", () => {
    const d = new Deflater();
    d.write(new Uint8Array(0));
    d.write(new TextEncoder().encode("hello"));
    d.write(new Uint8Array(0));
    expect(d.finish()).toEqual(deflateRaw(new TextEncoder().encode("hello")));
  });
});
