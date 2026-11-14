// hpy-plugin/src/locate.rs tests.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { cargoCandidates, locateWasm, sameFile } from "../../src/plugin/locate.ts";
import { manifest } from "../../src/plugin/manifest.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "hpy-locate-"));
function touch(p: string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
}
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected an error");
};
const hasCargo = spawnSync("cargo", ["--version"]).status === 0;

it("explicit_and_configured_win", () => {
  const dir = tmp();
  touch(join(dir, "a.wasm"));
  touch(join(dir, "b.wasm"));
  const m = manifest({ id: "x", wasm_file: "b.wasm" });
  expect(locateWasm(dir, join(dir, "a.wasm"), undefined, m)).toBe(join(dir, "a.wasm"));
  expect(locateWasm(dir, undefined, "a.wasm", m)).toBe(join(dir, "a.wasm"));
  expect(locateWasm(dir, undefined, undefined, m)).toBe(join(dir, "b.wasm"));
  expect(err(() => locateWasm(dir, undefined, "missing.wasm", m))).toContain("missing.wasm");
});

it("a_relative_explicit_path_is_relative_to_the_plugin_dir", () => {
  const dir = tmp();
  touch(join(dir, "mine.wasm"));
  expect(locateWasm(dir, "mine.wasm", undefined, manifest({ id: "x" }))).toBe(
    join(dir, "mine.wasm"),
  );
});

it("cargo_candidates_finds_each_target", () => {
  const target = tmp();
  touch(join(target, "wasm32-unknown-unknown/release/my_plugin.wasm"));
  touch(join(target, "wasm32-wasip1/release/my_plugin.wasm"));
  touch(join(target, "wasm32-wasip1/debug/my_plugin.wasm"));
  expect(cargoCandidates(target, "my-plugin").length).toBe(2);
});

it.skipIf(!hasCargo)("ambiguous_cargo_build_lists_candidates", () => {
  const dir = tmp();
  writeFileSync(
    join(dir, "Cargo.toml"),
    '[package]\nname = "my-plugin"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib"]\n',
  );
  touch(join(dir, "src/lib.rs"));
  touch(join(dir, "target/wasm32-unknown-unknown/release/my_plugin.wasm"));
  touch(join(dir, "target/wasm32-wasip1/release/my_plugin.wasm"));
  const e = err(() => locateWasm(dir, undefined, undefined, manifest({ id: "my-plugin" })));
  expect(e).toContain("wasm32-unknown-unknown");
  expect(e).toContain("wasm32-wasip1");
  expect(e).toContain("--wasm");
});

it("nothing_found_says_what_was_tried", () => {
  expect(err(() => locateWasm(tmp(), undefined, undefined, manifest({ id: "x" })))).toContain(
    "--wasm",
  );
});

it.skipIf(process.platform === "win32")("same_file_sees_through_symlinks", () => {
  const real = tmp();
  touch(join(real, "Cargo.toml"));
  const link = join(tmp(), "link");
  symlinkSync(real, link);
  expect(sameFile(join(link, "Cargo.toml"), join(real, "Cargo.toml"))).toBe(true);
  expect(sameFile(join(link, "Cargo.toml"), join(real, "other.toml"))).toBe(false);
});
