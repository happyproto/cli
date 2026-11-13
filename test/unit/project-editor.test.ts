// crates/hpy/src/project/editor.rs tests.
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
import { editorFiles, languages, writeEditorConfig } from "../../src/project/editor.ts";

const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-editor-"));
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

it("each_language_gets_its_settings_once", () => {
  const dir = tempdir();
  const lines = writeEditorConfig(dir, ["lua", "typescript"]);
  expect(lines).toEqual([
    "wrote tsconfig.json, which points editors at .happyview/types/typescript",
    "wrote .luarc.json, which points editors at .happyview/types/lua",
  ]);
  const ts = readJson(join(dir, "tsconfig.json"));
  expect(ts.include).toEqual(["src", ".happyview/types/typescript"]);
  expect(ts.compilerOptions.checkJs).toBe(false);
  const lua = readJson(join(dir, ".luarc.json"));
  expect(lua["workspace.library"]).toEqual([".happyview/types/lua"]);

  // A second run finds both naming their directory and says nothing.
  expect(writeEditorConfig(dir, ["lua", "typescript"])).toEqual([]);
});

it("javascript_alone_checks_javascript", () => {
  const dir = tempdir();
  writeEditorConfig(dir, ["javascript"]);
  const ts = readJson(join(dir, "tsconfig.json"));
  expect(ts.include).toEqual(["src", ".happyview/types/javascript"]);
  expect(ts.compilerOptions.checkJs).toBe(true);
  expect(existsSync(join(dir, ".luarc.json"))).toBe(false);
});

it("an_existing_file_is_left_alone_and_named", () => {
  const dir = tempdir();
  writeFileSync(join(dir, "tsconfig.json"), '{"include": ["lib"]}\n');
  const lines = writeEditorConfig(dir, ["typescript"]);
  expect(lines).toEqual([
    "tsconfig.json does not name .happyview/types/typescript; add it to its include for editor types",
  ]);
  expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toBe('{"include": ["lib"]}\n');
});

it("a_new_project_starts_with_the_same_files", () => {
  const files = editorFiles(["lua"]);
  expect(files.length).toBe(1);
  expect(files[0]![0]).toBe(".luarc.json");
  expect(files[0]![1]).toContain(".happyview/types/lua");
  // serde_json's pretty printer, keys sorted as its `Value` keeps them.
  expect(files[0]![1]).toBe(
    `{
  "$schema": "https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json",
  "diagnostics.globals": [
    "handle",
    "describe",
    "it",
    "pending",
    "before_each",
    "after_each",
    "test"
  ],
  "runtime.version": "Lua 5.4",
  "workspace.ignoreDir": [
    ".happyview"
  ],
  "workspace.library": [
    ".happyview/types/lua"
  ]
}
`,
  );
});

it("no_interpreter_means_no_settings", () => {
  const dir = tempdir();
  expect(writeEditorConfig(dir, [])).toEqual([]);
  expect(readdirSync(dir).length).toBe(0);
});

it("languages_come_from_the_placed_interpreters", () => {
  const dir = tempdir();
  for (const [id, manifest] of [
    ["lua", { plugin_type: "interpreter", language_id: "lua" }],
    ["db", { plugin_type: "library", namespace: "happyview.db" }],
    ["ts", { plugin_type: "interpreter", language_id: "typescript" }],
  ] as const) {
    const plugin = join(dir, ".happyview/plugins", id);
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "manifest.json"), JSON.stringify(manifest));
  }
  expect(languages(dir)).toEqual(["lua", "typescript"]);
  expect(languages(join(dir, "missing"))).toEqual([]);
});
