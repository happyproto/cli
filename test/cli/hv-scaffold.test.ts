// crates/hpy/tests/happyview.rs: the `scaffold_*` tests, `hpy hv scaffold` writing starter
// handlers beside a project's lexicons.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HV_DID, Stack, says, VERSION } from "../support/hv-stack.ts";

let stacks: Stack[] = [];
afterEach(async () => {
  for (const s of stacks) await s.dispose();
  stacks = [];
});
const newStack = async () => {
  const s = await Stack.start();
  stacks.push(s);
  return s;
};

const read = (p: string) => readFileSync(p, "utf8");

const LUA_ENTRY = 'lua = { did = "did:plc:hv", name = "happyview-lua", channel = "latest" }';

/**
 * A project with `interpreter` first in `[interpreters]`, a record lexicon, and a query and a
 * procedure lexicon with no handlers.
 */
function scaffoldProject(stack: Stack, interpreter: string): string {
  const root = stack.project;
  // A second interpreter after the first, so only order can decide.
  const second = interpreter === "lua" ? "" : LUA_ENTRY;
  writeFileSync(
    join(root, "happyview.toml"),
    `[happyview]\nversion = "${VERSION}"\n\n[interpreters]\n${interpreter} = { did = "${HV_DID}", name = "happyview-${interpreter}", channel = "latest" }\n${second}\n`,
  );
  const lex = join(root, "src/lexicons/com/example");
  mkdirSync(lex, { recursive: true });
  const write = (name: string, body: unknown) =>
    writeFileSync(join(lex, name), JSON.stringify(body));
  write("note.json", {
    lexicon: 1,
    id: "com.example.note",
    defs: {
      main: {
        type: "record",
        key: "tid",
        record: { type: "object", properties: { text: { type: "string" } } },
      },
    },
  });
  write("listNotes.json", {
    lexicon: 1,
    id: "com.example.listNotes",
    defs: {
      main: {
        type: "query",
        parameters: { type: "params", properties: { limit: { type: "integer" } } },
      },
    },
  });
  write("saveNote.json", {
    lexicon: 1,
    id: "com.example.saveNote",
    defs: {
      main: {
        type: "procedure",
        input: { encoding: "application/json", schema: { type: "object" } },
      },
    },
  });
  return lex;
}

it("scaffold_writes_lua_handlers_naming_the_collection", async () => {
  const stack = await newStack();
  const lex = scaffoldProject(stack, "lua");
  const r = await stack.hpy(["hv", "scaffold", "--collection", "com.example.note"]);
  expect(r.code, r.stderr).toBe(0);
  expect(
    says(r.stdout, "wrote src/lexicons/com/example/listNotes.lua (reads com.example.note)"),
  ).toBe(true);
  expect(
    says(r.stdout, "wrote src/lexicons/com/example/saveNote.lua (writes com.example.note)"),
  ).toBe(true);
  // Without a terminal hpy says how to add the libraries, and adds none.
  expect(says(r.stderr, "`hpy hv add happyview.db happyview.record`")).toBe(true);
  const query = read(join(lex, "listNotes.lua"));
  expect(
    query.startsWith(
      'local log = require("internal.logging")\nlocal db = require("happyview.db")\n',
    ),
    query,
  ).toBe(true);
  expect(query).toContain("    local entry = db.get(input.uri)\n");
  expect(query).toContain(
    '  return db.records("com.example.note")\n    :did(input.did)\n    :limit(tonumber(input.limit))\n    :cursor(input.cursor)\n    :run()\n',
  );
  expect(query).not.toContain("COLLECTION");
  expect(query).not.toContain("TODO");
  const procedure = read(join(lex, "saveNote.lua"));
  expect(procedure).toContain('local record = require("happyview.record")\n');
  expect(procedure).toContain('  local ref = record.create("com.example.note", input)\n');
  expect(procedure).toContain("  return { uri = ref.uri, cid = ref.cid }\n");
  expect(existsSync(join(lex, "note.lua")), "a record lexicon got a handler").toBe(false);
  expect(read(join(stack.project, "happyview.toml"))).not.toContain("happyview.db");
});

it("scaffold_never_replaces_a_handler_in_any_language", async () => {
  const stack = await newStack();
  const lex = scaffoldProject(stack, "lua");
  writeFileSync(join(lex, "listNotes.ts"), "mine");
  const r = await stack.hpy([
    "hv",
    "scaffold",
    "com.example.listNotes",
    "--collection",
    "com.example.note",
  ]);
  expect(r.code, r.stderr).toBe(0);
  expect(
    says(
      r.stdout,
      "skipped com.example.listNotes: src/lexicons/com/example/listNotes.ts is its handler",
    ),
  ).toBe(true);
  expect(read(join(lex, "listNotes.ts"))).toBe("mine");
  expect(existsSync(join(lex, "listNotes.lua"))).toBe(false);
  // Only the named lexicon was considered.
  expect(existsSync(join(lex, "saveNote.lua"))).toBe(false);
});

it("scaffold_without_a_terminal_or_collection_leaves_a_marked_placeholder", async () => {
  const stack = await newStack();
  const lex = scaffoldProject(stack, "lua");
  const r = await stack.hpy(["hv", "scaffold", "com.example.listNotes", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  expect(
    says(r.stderr, "warning: src/lexicons/com/example/listNotes.lua names no collection yet"),
  ).toBe(true);
  expect(says(r.stdout, '"collection": null')).toBe(true);
  expect(read(join(lex, "listNotes.lua"))).toContain(
    '  -- TODO: name the collection this reads\n  return db.records("COLLECTION")\n',
  );
});

it("scaffold_refuses_a_lexicon_that_is_not_a_query_or_procedure", async () => {
  const stack = await newStack();
  const lex = scaffoldProject(stack, "lua");
  let r = await stack.hpy(["hv", "scaffold", "com.example.note"]);
  expect(r.code).toBe(2);
  expect(says(r.stderr, "`com.example.note` is a record lexicon")).toBe(true);
  r = await stack.hpy(["hv", "scaffold", "com.example.nowhere"]);
  expect(r.code).toBe(2);
  expect(says(r.stderr, "not a lexicon under src/")).toBe(true);
  r = await stack.hpy(["hv", "scaffold", "--collection", "notes"]);
  expect(r.code).toBe(2);
  expect(says(r.stderr, "--collection: `notes` is not an NSID")).toBe(true);
  expect(existsSync(join(lex, "listNotes.lua"))).toBe(false);
});

it("scaffold_writes_typescript_when_it_is_the_first_interpreter", async () => {
  const stack = await newStack();
  const lex = scaffoldProject(stack, "typescript");
  const r = await stack.hpy(["hv", "scaffold", "--collection", "com.example.note"]);
  expect(r.code, r.stderr).toBe(0);
  const query = read(join(lex, "listNotes.ts"));
  expect(
    query.startsWith(
      'import db from "happyview.db";\nimport type { Params } from "happyview:lexicons/com.example.listNotes";\nimport type { QueryCtx } from "happyview:ctx";\n',
    ),
    query,
  ).toBe(true);
  expect(query).toContain(
    "export default async function handle(input: Params & Query, ctx: QueryCtx) {\n",
  );
  expect(query).toContain('  return db.records("com.example.note")\n');
  const procedure = read(join(lex, "saveNote.ts"));
  expect(procedure).toContain(
    'import type { Input } from "happyview:lexicons/com.example.saveNote";\n',
  );
  expect(procedure).toContain('  const ref = await record.create("com.example.note", input);\n');
  expect(existsSync(join(lex, "listNotes.lua"))).toBe(false);
});
