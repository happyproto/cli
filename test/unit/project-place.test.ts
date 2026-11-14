// hpy-project/src/place.rs tests.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PLUGINS_DIR, type PlaceMode, placedMode, placePlugins } from "../../src/project/place.ts";

const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-project-place-"));
const unix = process.platform !== "win32";
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

function cached(root: string, id: string, version: string): string {
  const dir = join(root, id, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `{"id":"${id}"}`);
  writeFileSync(join(dir, `${id}.wasm`), "\0asm");
  return dir;
}

function error(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected an error");
}

it("places_exactly_the_given_plugins", () => {
  const cache = tempdir();
  const project = tempdir();
  const lua = cached(cache, "happyview-lua", "1.4.2");
  const stray = join(project, PLUGINS_DIR, "removed-plugin");
  mkdirSync(stray, { recursive: true });
  for (const mode of ["link", "copy"] as PlaceMode[]) {
    placePlugins(project, [{ id: "happyview-lua", source: lua }], mode);
    const placed = join(project, PLUGINS_DIR, "happyview-lua");
    expect(isFile(join(placed, "manifest.json")), mode).toBe(true);
    expect(existsSync(stray), mode).toBe(false);
    expect(readdirSync(join(project, PLUGINS_DIR)), mode).toHaveLength(1);
  }
});

it("a_new_version_replaces_the_old_one", () => {
  const cache = tempdir();
  const project = tempdir();
  const old = cached(cache, "happyview-lua", "1.4.2");
  const fresh = cached(cache, "happyview-lua", "1.5.0");
  writeFileSync(join(fresh, "marker"), "new");
  for (const source of [old, fresh]) {
    placePlugins(project, [{ id: "happyview-lua", source }], "link");
  }
  const placed = join(project, PLUGINS_DIR, "happyview-lua");
  expect(readFileSync(join(placed, "marker"), "utf8")).toBe("new");
  expect(existsSync(join(old, "marker"))).toBe(false);
  expect(isFile(join(old, "happyview-lua.wasm"))).toBe(true);
});

it("pruning_a_link_leaves_the_cache_alone", () => {
  const cache = tempdir();
  const project = tempdir();
  const lua = cached(cache, "happyview-lua", "1.4.2");
  placePlugins(project, [{ id: "happyview-lua", source: lua }], "link");
  placePlugins(project, [], "link");
  expect(existsSync(join(project, PLUGINS_DIR, "happyview-lua"))).toBe(false);
  expect(isFile(join(lua, "happyview-lua.wasm"))).toBe(true);
});

it("a_copy_is_renamed_into_place_and_leaves_no_staging_copy", () => {
  const cache = tempdir();
  const project = tempdir();
  const lua = cached(cache, "happyview-lua", "1.4.2");
  placePlugins(project, [{ id: "happyview-lua", source: lua }], "copy");
  const placed = join(project, PLUGINS_DIR, "happyview-lua");
  expect(isFile(join(placed, "manifest.json"))).toBe(true);
  expect(isFile(join(placed, "happyview-lua.wasm"))).toBe(true);
  expect(readdirSync(join(project, ".happyview/.plugins-staging"))).toHaveLength(0);
});

it("placed_mode_keeps_to_what_is_there", () => {
  const cache = tempdir();
  const project = tempdir();
  expect(placedMode(project)).toBeUndefined();
  mkdirSync(join(project, PLUGINS_DIR), { recursive: true });
  expect(placedMode(project)).toBe("link");
  const lua = cached(cache, "happyview-lua", "1.4.2");
  const plugins = [{ id: "happyview-lua", source: lua }];
  placePlugins(project, plugins, "copy");
  expect(placedMode(project)).toBe("copy");
  if (unix) {
    placePlugins(project, plugins, "link");
    expect(placedMode(project)).toBe("link");
  }
});

it("switching_to_copies_replaces_links_without_touching_the_cache", () => {
  const cache = tempdir();
  const project = tempdir();
  const lua = cached(cache, "happyview-lua", "1.4.2");
  const plugins = [{ id: "happyview-lua", source: lua }];
  placePlugins(project, plugins, "link");
  placePlugins(project, plugins, "copy");
  const placed = join(project, PLUGINS_DIR, "happyview-lua");
  expect(lstatSync(placed).isSymbolicLink()).toBe(false);
  expect(isFile(join(lua, "happyview-lua.wasm"))).toBe(true);
});

it.skipIf(!unix)("a_foreign_symlink_is_removed_not_followed", () => {
  const outside = tempdir();
  const project = tempdir();
  writeFileSync(join(outside, "keep"), "x");
  const plugins = join(project, PLUGINS_DIR);
  mkdirSync(plugins, { recursive: true });
  symlinkSync(outside, join(plugins, "stray"));
  placePlugins(project, [], "copy");
  expect(() => lstatSync(plugins)).not.toThrow();
  expect(() => lstatSync(join(plugins, "stray"))).toThrow();
  expect(isFile(join(outside, "keep"))).toBe(true);
});

it.skipIf(!unix)("a_created_happyview_directory_is_owner_only", () => {
  const project = tempdir();
  placePlugins(project, [], "copy");
  expect(statSync(join(project, ".happyview")).mode & 0o777).toBe(0o700);
});

it.skipIf(!unix)("a_symlink_at_either_level_is_refused_and_nothing_behind_it_is_touched", () => {
  for (const [linkAt, setupInner] of [
    [".happyview", false],
    [PLUGINS_DIR, true],
  ] as const) {
    const outside = tempdir();
    const project = tempdir();
    writeFileSync(join(outside, "keep"), "x");
    if (setupInner) mkdirSync(join(project, ".happyview"));
    symlinkSync(outside, join(project, linkAt));
    const err = error(() => placePlugins(project, [], "copy"));
    expect(err.message, linkAt).toContain("is a symlink");
    expect(err.message, linkAt).toContain(linkAt);
    expect(isFile(join(outside, "keep")), linkAt).toBe(true);
  }
});

it.skipIf(!unix)("a_dangling_symlink_is_refused", () => {
  const project = tempdir();
  symlinkSync("/nonexistent/target", join(project, ".happyview"));
  const err = error(() => placePlugins(project, [], "copy"));
  expect(err.message).toContain("is a symlink");
});

it("a_file_where_a_directory_belongs_is_refused", () => {
  const project = tempdir();
  writeFileSync(join(project, ".happyview"), "x");
  const err = error(() => placePlugins(project, [], "copy"));
  expect(err.message).toContain("is not a directory");
});

it("an_id_that_could_escape_the_plugins_directory_is_refused", () => {
  const cache = tempdir();
  const project = tempdir();
  const src = cached(cache, "x", "1");
  for (const id of ["", ".", "..", "../evil", "a/b", "a\\b"]) {
    const err = error(() => placePlugins(project, [{ id, source: src }], "copy"));
    expect(err.message, JSON.stringify(id)).toContain("cannot name");
  }
  expect(existsSync(join(project, ".happyview"))).toBe(false);
});
