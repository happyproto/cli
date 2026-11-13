// src/core/similar.ts against similar 3.2.1's
// `TextDiff::from_lines(old, new).unified_diff().context_radius(3).header(a, b).to_string()`:
// test/fixtures/similar/oracle.json holds the Rust output for each input in
// test/support/similar-cases.ts, whole, or as its sha256 and UTF-16 length when it is long.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokenizeLines, unifiedDiff } from "../../src/core/similar.ts";
import { similarCases } from "../support/similar-cases.ts";

type Expected = string | { sha256: string; length: number };

const fixture: Record<string, Expected> = JSON.parse(
  readFileSync(new URL("../fixtures/similar/oracle.json", import.meta.url), "utf8"),
);
const cases = similarCases();

describe("unifiedDiff against the Rust oracle", () => {
  it("covers every case", () => {
    expect(Object.keys(fixture).sort()).toEqual(cases.map((c) => c.name).sort());
  });

  for (const c of cases) {
    it(`matches similar for ${c.name}`, () => {
      const want = fixture[c.name]!;
      const got = unifiedDiff(c.old, c.new, c.a, c.b);
      if (typeof want === "string") {
        expect(got).toBe(want);
      } else {
        expect(got.length).toBe(want.length);
        expect(createHash("sha256").update(got).digest("hex")).toBe(want.sha256);
      }
    });
  }
});

describe("tokenizeLines", () => {
  it("keeps each line's terminator, with \\r\\n as one", () => {
    expect(tokenizeLines("a\nb\r\nc\rd")).toEqual(["a\n", "b\r\n", "c\r", "d"]);
    expect(tokenizeLines("\n\r\n\r")).toEqual(["\n", "\r\n", "\r"]);
    expect(tokenizeLines("")).toEqual([]);
  });
});
