// crates/hpy/tests/happyview.rs: the `add_*` tests, `hpy hv add` against a fake registry.
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mountRegistry, Plugin, Stack, says } from "../support/hv-stack.ts";

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

const mountLua = (stack: Stack) =>
  mountRegistry(stack, [Plugin.interpreter("happyview-lua", "lua", "\0asm lua")]);

const LUA_ENTRY = 'lua = { did = "did:plc:hv", name = "happyview-lua", channel = "latest" }';

it("add_validates_the_project_before_touching_the_network", async () => {
  const stack = await newStack();
  const r = await stack.hpy(["hv", "add", "lua", "--project", "not-a-uri"]);
  expect(r.code).toBe(2);
  expect(says(r.stderr, "--project")).toBe(true);
  expect(read(join(stack.project, "happyview.toml"))).not.toContain("lua");
  expect(stack.server.requests).toEqual([]);
});

it("add_writes_the_entry_and_the_lock_and_downloads", async () => {
  const stack = await newStack();
  mountLua(stack);
  const r = await stack.hpy(["hv", "add", "lua", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  expect(says(r.stdout, '"channel": "latest"')).toBe(true);
  expect(says(r.stdout, '"version": "1.4.2"')).toBe(true);
  const toml = read(join(stack.project, "happyview.toml"));
  expect(toml).toContain(LUA_ENTRY);
  const lock = read(join(stack.project, "happyview.lock"));
  expect(lock).toContain("version = 2");
  expect(lock).toContain('project = "at://did:plc:hv/software.release.project/happyview-lua"');
  expect(
    lstatSync(join(stack.cache, "plugins/happyview-lua/1.4.2/happyview-lua.wasm")).isFile(),
  ).toBe(true);
});

it("add_places_the_plugins_where_dev_already_has", async () => {
  const stack = await newStack();
  mountLua(stack);
  const plugins = join(stack.project, ".happyview/plugins");
  // A plugin dev placed before, and no longer locked.
  mkdirSync(join(plugins, "happyview-gone"), { recursive: true });
  const r = await stack.hpy(["hv", "add", "lua"]);
  expect(r.code, r.stderr).toBe(0);
  const placed = join(plugins, "happyview-lua");
  expect(lstatSync(join(placed, "happyview-lua.wasm")).isFile()).toBe(true);
  // The directory held a copy, not a link, so add keeps to copies.
  expect(lstatSync(placed).isSymbolicLink()).toBe(false);
  expect(existsSync(join(plugins, "happyview-gone"))).toBe(false);
});

it("add_places_nothing_before_dev_has_run", async () => {
  const stack = await newStack();
  mountLua(stack);
  const r = await stack.hpy(["hv", "add", "lua"]);
  expect(r.code, r.stderr).toBe(0);
  expect(existsSync(join(stack.project, ".happyview/plugins"))).toBe(false);
});
