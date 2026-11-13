// commands/happyview/pull/{mod,map,wire,codemod,diff}.rs tests.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { rewrite } from "../../src/commands/pull/codemod.ts";
import { diffTrees } from "../../src/commands/pull/diff.ts";
import { generation, type Remote, Report, source } from "../../src/commands/pull/index.ts";
import {
  defaultDir,
  derivedOutbound,
  envExample,
  extension,
  handlerPath,
  happyviewRequires,
  hasCodemodMarker,
  leadingDescription,
  lexiconSettings,
  parseTrigger,
  safeRelPath,
  safeSrcPath,
  scriptSettings,
} from "../../src/commands/pull/map.ts";
import { isNetwork, LEXICON, SCRIPT, type Script } from "../../src/commands/pull/wire.ts";
import { fromValue } from "../../src/core/serde-json.ts";
import { LexiconSettings } from "../../src/project/scaffold.ts";

const dirs: string[] = [];
const tempdir = () => {
  const d = mkdtempSync(join(tmpdir(), "hpy-pull-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fails = (f: () => unknown) => {
  try {
    f();
  } catch {
    return true;
  }
  return false;
};

// --- mod.rs

function script(id: string, language: string, modulePath?: string): Script {
  const v: Record<string, unknown> = { id, script_type: language, body: "return 1" };
  if (modulePath !== undefined) v.module = { module: "m", path: modulePath, handler: "h" };
  return fromValue(v, SCRIPT) as Script;
}

it("what_the_instance_names_stays_inside_the_project", async () => {
  const remote: Remote = {
    lexicons: [],
    network: [],
    scripts: [
      script("job.run:a", "x/../../../../../tmp/evil"),
      script("job.run:b", "lua"),
      script("job.run:c", "typescript"),
      script("job.run:d", "lua", "../../outside"),
      script("job.run:e", "lua", "modules/fine"),
    ],
    variables: [],
    plugins: [],
    appName: undefined,
    superadmin: undefined,
    labelers: [],
    modules: { ok: [] },
  };
  // The registry says Lua files take a hostile extension; TS is fine.
  const extensions = new Map([
    ["lua", "../../../tmp/evil"],
    ["typescript", "ts"],
  ]);
  const report = new Report();
  const out = await source(remote, "v3", undefined, extensions, report);
  expect([...out.files.keys()]).toEqual(["src/jobs/c.ts"]);
  for (const path of out.files.keys()) expect(safeSrcPath(path)).toBeDefined();
  expect(out.toml.modules.size, "only the module inside the project").toBe(1);
  const warned = report.warnings.join("\n");
  for (const id of ["job.run:a", "job.run:b"]) expect(warned).toContain(id);
  expect(warned).toContain("module `m` has a path outside the project");
});

it("two_and_below_is_v2", () => {
  expect(generation("2.17.0")).toBe("v2");
  expect(generation("v2.0.0-beta.3")).toBe("v2");
  expect(generation("3.0.0-alpha.12")).toBe("v3");
  expect(generation("dev")).toBeUndefined();
});

// --- map.rs

it("only_a_plain_extension_names_a_file", () => {
  const none = new Map<string, string>();
  expect(extension("lua", none)).toEqual(["lua", true]);
  expect(extension("python3", none)).toEqual(["python3", false]);
  for (const hostile of [
    "x/../../../../../tmp/evil",
    "../x",
    "a/b",
    "",
    ".lua",
    "Lua",
    "a b",
    "C:x",
  ]) {
    expect(extension(hostile, none), hostile).toBeUndefined();
    expect(extension("lua", new Map([["lua", hostile]])), `claimed ${hostile}`).toBeUndefined();
  }
});

it("a_relative_path_stays_in_the_project", () => {
  expect(safeRelPath("modules/registry")).toBe("modules/registry");
  for (const hostile of [
    "",
    "/etc",
    "../x",
    "modules/../../x",
    "a//b",
    "./a",
    "C:/x",
    "a\\..\\..\\x",
  ])
    expect(safeRelPath(hostile), hostile).toBeUndefined();
});

const place = (id: string, ext: string) => {
  const t = parseTrigger(id);
  if (!t) throw new Error(id);
  return [t.kind, handlerPath(t, ext)];
};

it("each_trigger_goes_where_layout_reads_it_back", () => {
  for (const [id, ext, kind, path] of [
    ["xrpc.query:com.example.listPosts", "lua", "query", "src/lexicons/com/example/listPosts.lua"],
    [
      "xrpc.procedure:com.example.createPost",
      "ts",
      "procedure",
      "src/lexicons/com/example/createPost.ts",
    ],
    ["record.create:com.example.post", "lua", "record", "src/lexicons/com/example/post.create.lua"],
    ["record.update:com.example.post", "lua", "record", "src/lexicons/com/example/post.update.lua"],
    ["record.delete:com.example.post", "js", "record", "src/lexicons/com/example/post.delete.js"],
    ["record.index:com.example.post", "lua", "record", "src/lexicons/com/example/post.index.lua"],
    ["job.run:nightly", "lua", "job", "src/jobs/nightly.lua"],
    ["job.run:reindex.posts", "lua", "job", "src/jobs/reindex.posts.lua"],
    ["labeler.apply:com.example.post", "lua", "label", "src/labels/com.example.post.lua"],
    ["labeler.apply:_actor", "lua", "label", "src/labels/_actor.lua"],
  ] as const)
    expect(place(id, ext), id).toEqual([kind, path]);
});

it("the_codemod_kinds_are_its_own_names", () => {
  const kinds = [
    "xrpc.query:a.b.c",
    "xrpc.procedure:a.b.c",
    "record.create:a.b.c",
    "job.run:x",
    "labeler.apply:_actor",
  ].map((id) => parseTrigger(id)?.kind);
  expect(kinds).toEqual(["query", "procedure", "record", "job", "label"]);
});

it("a_trigger_that_could_climb_out_has_no_path", () => {
  for (const id of [
    "xrpc.query:com..evil",
    "xrpc.query:com.example/../../x",
    "job.run:../../etc/passwd",
    "labeler.apply:.hidden",
    "record.create:com.example",
  ]) {
    const t = parseTrigger(id);
    if (!t) throw new Error(id);
    expect(
      fails(() => handlerPath(t, "lua")),
      id,
    ).toBe(true);
  }
  expect(parseTrigger("hook.before:x")).toBeUndefined();
  expect(parseTrigger("nocolon")).toBeUndefined();
  expect(safeSrcPath("src/lexicons/a/b.lua")).toBe("src/lexicons/a/b.lua");
  expect(safeSrcPath("../src/x.lua")).toBeUndefined();
  expect(safeSrcPath("src/../x.lua")).toBeUndefined();
  expect(safeSrcPath("/src/x.lua")).toBeUndefined();
});

it("the_extension_is_the_interpreters_else_the_usual_one", () => {
  const claimed = new Map([["typescript", "mts"]]);
  expect(extension("typescript", claimed)).toEqual(["mts", true]);
  expect(extension("lua", claimed)).toEqual(["lua", true]);
  expect(extension("javascript", new Map())).toEqual(["js", true]);
  expect(extension("python", new Map())).toEqual(["python", false]);
});

it("lexicon_defaults_are_left_out", () => {
  expect(LexiconSettings.isEmpty(lexiconSettings("record", false, undefined, true))).toBe(true);
  expect(LexiconSettings.isEmpty(lexiconSettings("record", false, undefined, undefined))).toBe(
    true,
  );
  const s = lexiconSettings("record", true, 2, false);
  expect([s.backfill, s.tokenCost, s.indexed]).toEqual([true, 2, false]);
  // A query has no collection to backfill or index; a cost it keeps.
  const q = lexiconSettings("query", true, 1, false);
  expect([q.backfill, q.tokenCost, q.indexed]).toEqual([undefined, 1, undefined]);
  expect(lexiconSettings(undefined, true, undefined, undefined).backfill).toBe(true);
});

it("the_env_example_names_keys_without_values", () => {
  const text = envExample(["API_TOKEN", "WEBHOOK"]);
  expect(text.endsWith("API_TOKEN=\nWEBHOOK=\n")).toBe(true);
  for (const line of text.split("\n").filter((l) => l !== "" && !l.startsWith("#")))
    expect(line.endsWith("=")).toBe(true);
});

it("only_what_the_body_does_not_say_is_kept", () => {
  const body =
    '-- Lists posts.\n-- Newest first.\n\nlocal x = xrpc.query("com.other.get")\n-- xrpc.query("com.commented.out")\n';
  expect(leadingDescription(body)).toBe("Lists posts. Newest first.");
  expect(derivedOutbound(body)).toEqual(["com.other.get"]);
  expect(scriptSettings(body, "Lists posts. Newest first.", ["com.other.get"])).toEqual({
    description: undefined,
    outboundXrpcs: undefined,
  });
  const other = scriptSettings(body, "Something else", ["com.x.y"]);
  expect(other.description).toBe("Something else");
  expect(other.outboundXrpcs).toEqual(["com.x.y"]);
  expect(scriptSettings(body, "Something else", undefined).outboundXrpcs).toBeUndefined();
  expect(leadingDescription("--[[\n  Block one.\n]]\nreturn 1")).toBe("Block one.");
  expect(leadingDescription("/**\n * Says hi.\n */\nexport function handle() {}")).toBe("Says hi.");
  expect(leadingDescription("local x = 1")).toBeUndefined();
});

it("happyview_requires_are_found_in_any_quoting", () => {
  expect(
    happyviewRequires(
      'local db = require("happyview.db")\nlocal r = require \'happyview.record\'\nlocal l = require("internal.logging")',
    ),
  ).toEqual(["happyview.db", "happyview.record"]);
});

it("markers_are_codemod_comment_lines", () => {
  expect(hasCodemodMarker("x\n  -- codemod: db.query has options\n")).toBe(true);
  expect(hasCodemodMarker("-- not a codemod: line\n")).toBe(false);
});

it("the_default_directory_is_the_host", () => {
  expect(defaultDir("https://api.example.com")).toBe("api.example.com");
  expect(defaultDir("http://127.0.0.1:8080")).toBe("127.0.0.1");
});

// --- wire.rs

it("reads_a_v2_lexicon", () => {
  const l = fromValue(
    {
      id: "com.example.listPosts",
      revision: 2,
      lexicon_json: { lexicon: 1, id: "com.example.listPosts" },
      lexicon_type: "query",
      backfill: true,
      action: null,
      target_collection: "com.example.post",
      source: "manual",
      authority_did: null,
      last_fetched_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      token_cost: null,
    },
    LEXICON,
  );
  expect(l.backfill).toBe(true);
  expect(l.target_collection).toBe("com.example.post");
  expect(isNetwork(l)).toBe(false);
  expect(l.lexicon_json).toBeDefined();
});

it("reads_a_v3_network_lexicon_by_its_layer", () => {
  const l = fromValue(
    {
      id: "com.other.post",
      revision: 1,
      lexicon_type: "record",
      backfill: false,
      source: "network",
      layer: "network",
      path: null,
      shadows_stored: false,
      declared: true,
      authority_did: "did:plc:o",
      last_fetched_at: null,
      created_at: null,
      updated_at: null,
      token_cost: null,
      indexed: true,
    },
    LEXICON,
  );
  expect(isNetwork(l)).toBe(true);
  expect(l.indexed).toBe(true);
});

it("a_v3_module_row_has_no_body", () => {
  const s = fromValue(
    {
      id: "xrpc.query:com.example.score",
      script_type: "rust",
      body: "",
      description: null,
      outbound_xrpcs: null,
      created_at: null,
      updated_at: null,
      layer: "project",
      path: "modules/scoring",
      shadows_stored: false,
      recreatable: true,
      needs_migration: [],
      runnable: true,
      module: { module: "scoring", path: "modules/scoring", handler: "score", hash: "ab" },
    },
    SCRIPT,
  );
  expect(s.module?.module).toBe("scoring");
});

// --- codemod.rs

function fakeCodemod(dir: string, body: string): string {
  const path = join(dir, `codemod-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

it.skipIf(process.platform === "win32")(
  "passes_kind_and_collection_and_reads_each_outcome",
  async () => {
    const dir = tempdir();
    const echo = fakeCodemod(dir, 'echo "$*"; cat\n');
    expect(await rewrite(echo, "body\n", "query", "com.example.post")).toEqual({
      kind: "clean",
      source: "--stdin --kind query --collection com.example.post\nbody\n",
    });
    const marked = fakeCodemod(dir, "cat; echo '-- codemod: fix me'; exit 2\n");
    const m = await rewrite(marked, "x\n", "job", undefined);
    expect(m.kind === "marked" && m.source.includes("-- codemod: fix me")).toBe(true);
    const broken = fakeCodemod(dir, "echo 'cannot parse' >&2; exit 1\n");
    expect(await rewrite(broken, "x", "label", undefined)).toEqual({
      kind: "failed",
      why: "cannot parse",
    });
  },
);

// --- diff.rs

it("shows_changed_added_and_removed_files_but_not_tests", () => {
  const project = tempdir();
  const pulled = tempdir();
  const write = (root: string, rel: string, body: string) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  write(project, "happyview.toml", "a = 1\n");
  write(pulled, "happyview.toml", "a = 2\n");
  write(project, "src/lexicons/x/y/z.json", "{}\n");
  write(pulled, "src/lexicons/x/y/z.json", "{}\n");
  write(pulled, "src/jobs/new.lua", "new\n");
  write(project, "src/jobs/gone.lua", "gone\n");
  write(project, "src/jobs/gone.test.lua", "test\n");
  const [text, changed] = diffTrees(project, pulled);
  expect(changed).toEqual(["happyview.toml", "src/jobs/gone.lua", "src/jobs/new.lua"]);
  expect(text).toContain("--- a/happyview.toml\n+++ b/happyview.toml\n");
  expect(text).toContain("-a = 1\n+a = 2\n");
  expect(text).toContain("--- /dev/null\n+++ b/src/jobs/new.lua");
  expect(text).toContain("--- a/src/jobs/gone.lua\n+++ /dev/null");
  expect(text).not.toContain("gone.test.lua");
  const [same, none] = diffTrees(pulled, pulled);
  expect(same).toBe("");
  expect(none).toEqual([]);
});
