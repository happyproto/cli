// hpy-project/src/handlers.rs tests, plus a check that the embedded templates are the files.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { samePath } from "../../src/core/paths.ts";
import {
  checkNsid,
  firstInterpreter,
  Lexicon,
  type LexiconKind,
  PLACEHOLDER,
  renderHandler,
  scan,
  templateText,
} from "../../src/project/handlers.ts";
import TEMPLATES from "../../src/project/templates.json" with { type: "json" };

const tpl = (name: string) =>
  readFileSync(new URL(`../../src/project/templates/${name}`, import.meta.url), "utf8");

function lexicon(kind: LexiconKind, hasParams: boolean, hasInput: boolean): Lexicon {
  return new Lexicon({
    nsid: "com.example.listNotes",
    kind,
    path: "src/lexicons/com/example/listNotes.json",
    hasParams,
    hasInput,
  });
}

it("templates.json holds the template files (rerun scripts/gen-templates.mjs)", () => {
  const dir = new URL("../../src/project/templates/", import.meta.url);
  const files = Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((n) => [n, tpl(n)]),
  );
  expect(TEMPLATES).toEqual(files);
  // While the Rust crate is in the tree, the files must be its own.
  const rust = new URL("../../crates/hpy-project/templates/", import.meta.url);
  if (existsSync(rust)) {
    for (const name of readdirSync(rust)) {
      expect(files[name], name).toBe(readFileSync(new URL(name, rust), "utf8"));
    }
    expect(readdirSync(rust).sort()).toEqual(Object.keys(files));
  }
});

it("the_lua_bodies_are_the_dashboards_with_the_collection_named", () => {
  const query = renderHandler("lua", lexicon("query", true, false), "com.example.note")!;
  expect(query).toBe(templateText("query.lua").replaceAll("COLLECTION", "com.example.note"));
  expect(query).toContain('return db.records("com.example.note")\n');
  expect(query).toContain('local db = require("happyview.db")');
  const procedure = renderHandler("lua", lexicon("procedure", false, true), "com.example.note")!;
  expect(procedure).toContain('record.create("com.example.note", input)');
  expect(procedure).not.toContain(PLACEHOLDER);
});

it("without_a_collection_the_placeholder_has_a_comment_above_it", () => {
  const query = renderHandler("lua", lexicon("query", true, false), undefined)!;
  expect(query).toContain(
    '  -- TODO: name the collection this reads\n  return db.records("COLLECTION")\n',
  );
  const ts = renderHandler("typescript", lexicon("procedure", false, true), undefined)!;
  expect(ts).toContain(
    '  // TODO: name the collection this writes\n  const ref = await record.create("COLLECTION", input);\n',
  );
});

it("typescript_imports_only_the_lexicon_types_that_exist", () => {
  const withTypes = renderHandler("typescript", lexicon("query", true, false), "com.example.note")!;
  expect(
    withTypes.startsWith(
      'import db from "happyview.db";\n' +
        'import type { Params } from "happyview:lexicons/com.example.listNotes";\n' +
        'import type { QueryCtx } from "happyview:ctx";\n',
    ),
  ).toBe(true);
  expect(withTypes).toContain("handle(input: Params & Query, ctx: QueryCtx)");
  const without = renderHandler("typescript", lexicon("query", false, false), "a.b.c")!;
  expect(without).not.toContain("happyview:lexicons");
  expect(without).toContain("handle(input: Query, ctx: QueryCtx)");
  const procedure = renderHandler("typescript", lexicon("procedure", false, true), "a.b.c")!;
  expect(procedure).toContain(
    'import type { Input } from "happyview:lexicons/com.example.listNotes";\n',
  );
  expect(procedure).toContain("handle(input: Input, ctx: ProcedureCtx)");
  for (const body of [withTypes, without, procedure]) {
    expect(body.includes("LEXICON_IMPORT") || body.includes("INPUT_TYPE"), body).toBe(false);
  }
});

it("javascript_names_the_types_in_jsdoc", () => {
  const js = renderHandler("javascript", lexicon("query", true, false), "a.b.c")!;
  expect(js).toContain(
    ' * @param {import("happyview:lexicons/com.example.listNotes").Params & Query} input\n',
  );
  const procedure = renderHandler("javascript", lexicon("procedure", false, false), "a.b.c")!;
  expect(procedure).toContain(" * @param {{ [key: string]: unknown }} input\n");
  expect(renderHandler("python", lexicon("query", true, false), undefined)).toBeUndefined();
  expect(renderHandler("lua", lexicon("record", false, false), undefined)).toBeUndefined();
});

it("a_lexicon_is_read_for_its_kind_and_declared_types", () => {
  const q = Lexicon.parse(
    "a.json",
    `{"lexicon":1,"id":"com.example.q","defs":{"main":{"type":"query",
        "parameters":{"type":"params","properties":{"limit":{"type":"integer"}}}}}}`,
  )!;
  expect([q.kind, q.hasParams, q.hasInput]).toEqual(["query", true, false]);
  const p = Lexicon.parse(
    "b.json",
    `{"lexicon":1,"id":"com.example.p","defs":{"main":{"type":"procedure",
        "input":{"encoding":"application/json","schema":{"type":"object"}}}}}`,
  )!;
  expect([p.kind, p.hasParams, p.hasInput]).toEqual(["procedure", false, true]);
  expect(Lexicon.parse("c.json", '{"name":"not a lexicon"}')).toBeUndefined();
  expect(Lexicon.parse("d.json", "not json")).toBeUndefined();
});

it("scan_finds_lexicons_and_their_handlers_under_src", () => {
  const dir = mkdtempSync(join(tmpdir(), "hpy-project-handlers-"));
  const lex = join(dir, "src/lexicons/com/example");
  mkdirSync(lex, { recursive: true });
  const doc = (id: string, ty: string) =>
    `{"lexicon":1,"id":"${id}","defs":{"main":{"type":"${ty}"}}}`;
  writeFileSync(join(lex, "listNotes.json"), doc("com.example.listNotes", "query"));
  writeFileSync(join(lex, "note.json"), doc("com.example.note", "record"));
  writeFileSync(join(lex, "hello.json"), doc("com.example.hello", "query"));
  writeFileSync(join(lex, "hello.ts"), "");
  writeFileSync(join(lex, "listNotes.test.lua"), "");
  writeFileSync(join(dir, "src/tsconfig.json"), "{}");
  const found = scan(dir);
  expect(found.map((l) => l.nsid)).toEqual([
    "com.example.hello",
    "com.example.listNotes",
    "com.example.note",
  ]);
  expect(samePath(found[0]!.existingHandler(dir)!, "src/lexicons/com/example/hello.ts")).toBe(true);
  // A test file beside it is not its handler.
  expect(found[1]!.existingHandler(dir)).toBeUndefined();
  expect(samePath(found[1]!.handlerPath("lua"), "src/lexicons/com/example/listNotes.lua")).toBe(
    true,
  );
  expect(scan(join(dir, "nowhere"))).toEqual([]);
});

it("the_first_interpreter_is_the_first_written", () => {
  const text =
    '[happyview]\nversion = "3.0.0"\n\n[interpreters]\n' +
    'typescript = { did = "did:plc:a", name = "ts", channel = "latest" }\n' +
    'lua = { did = "did:plc:a", name = "lua", channel = "latest" }\n';
  expect(firstInterpreter(text)).toBe("typescript");
  expect(firstInterpreter("[happyview]\n")).toBeUndefined();
  expect(firstInterpreter("[interpreters]\n")).toBeUndefined();
});

it("nsids_follow_the_atproto_grammar", () => {
  for (const ok of ["com.example.note", "app.bsky.feed.post", "a-b.c.d1"]) {
    expect(() => checkNsid(ok), ok).not.toThrow();
  }
  for (const bad of [
    "com.example",
    "com..note",
    "com.example.1note",
    "com.example.no-te",
    "-a.b.c",
    "",
  ]) {
    expect(() => checkNsid(bad), bad).toThrow();
  }
});
