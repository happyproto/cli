// crates/hpy/src/commands/happyview/scaffold.rs tests.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { targets, writeNewFile } from "../../src/commands/scaffold.ts";
import { Failure } from "../../src/core/failure.ts";
import { Lexicon, type LexiconKind } from "../../src/project/handlers.ts";

const lexicon = (nsid: string, kind: LexiconKind) =>
  new Lexicon({ nsid, kind, path: `src/${nsid}.json`, hasParams: false, hasInput: false });

function failureOf(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(Failure);
    return e as Failure;
  }
  throw new Error("expected a failure");
}

it("named_lexicons_must_be_queries_or_procedures_here", () => {
  const all = [
    lexicon("com.example.list", "query"),
    lexicon("com.example.note", "record"),
    lexicon("com.example.save", "procedure"),
  ];
  expect(targets(all, []).map((l) => l.nsid)).toEqual(["com.example.list", "com.example.save"]);
  expect(targets(all, ["com.example.save", "com.example.save"])).toHaveLength(1);
  const record = failureOf(() => targets(all, ["com.example.note"]));
  expect(record.code).toBe(2);
  expect(record.message).toContain("is a record lexicon");
  const absent = failureOf(() => targets(all, ["com.example.gone"]));
  expect(absent.message).toContain("not a lexicon under src/");
});

it("a_file_made_since_the_scan_is_kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "hpy-scaffold-"));
  const path = join(dir, "h.lua");
  expect(writeNewFile(path, "new")).toBe(true);
  expect(writeNewFile(path, "newer")).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("new");
});
