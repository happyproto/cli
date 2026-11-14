// crates/hpy/src/project/cache.rs tests.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { createNew, holds, installDir, installFile, prepareRoot } from "../../src/project/cache.ts";

const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-cache-"));
const b = (s: string) => Buffer.from(s);
const mode = (d: string) => statSync(d).mode & 0o777;
const UNIX = process.platform !== "win32";

it("install_dir_replaces_a_directory_whole", () => {
  const root = tempdir();
  const dir = join(root, "plugins/x/1.0.0");
  installDir(dir, [
    ["a", b("one")],
    ["b", b("two")],
  ]);
  installDir(dir, [["a", b("three")]]);
  expect(readFileSync(join(dir, "a")).toString()).toBe("three");
  expect(existsSync(join(dir, "b"))).toBe(false);
  expect(readdirSync(dirname(dir))).toEqual(["1.0.0"]);
});

it("install_dir_refuses_a_name_that_leaves_the_directory", () => {
  const root = tempdir();
  const dir = join(root, "plugins/x/1.0.0");
  expect(() => installDir(dir, [["../escape", b("x")]])).toThrow();
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(join(root, "plugins/x/escape"))).toBe(false);
  expect(readdirSync(dirname(dir)).length).toBe(0);
});

it.skipIf(!UNIX)("install_file_can_mark_executable", () => {
  const root = tempdir();
  const path = join(root, "happyview/3.0.0/happyview");
  installFile(path, b("#!/bin/sh\n"), true);
  expect(mode(path)).toBe(0o755);
});

it.skipIf(!UNIX)("created_directories_are_private", () => {
  const root = tempdir();
  const dir = join(root, "plugins/x/1.0.0");
  installDir(dir, [["a", b("one")]]);
  for (const d of [dir, dirname(dir), join(root, "plugins")]) expect(mode(d)).toBe(0o700);
});

it("concurrent_installs_both_succeed_and_keep_one_whole_entry", async () => {
  // Rust's eight threads are eight workers here: each install is synchronous.
  const root = tempdir();
  const dir = join(root, "plugins/x/1.0.0");
  const worker = new URL("../support/install-dir-worker.ts", import.meta.url);
  const runs = Array.from(
    { length: 8 },
    () =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(worker, { workerData: { dir, times: 20 } });
        w.once("error", reject);
        w.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      }),
  );
  await Promise.all(runs);
  expect(
    holds(dir, [
      ["a", b("one")],
      ["b", b("two")],
    ]),
  ).toBe(true);
  expect(readdirSync(dirname(dir)).length).toBe(1);
});

it("a_failed_install_leaves_the_old_entry", () => {
  const root = tempdir();
  const dir = join(root, "plugins/x/1.0.0");
  installDir(dir, [["a", b("good")]]);
  expect(() =>
    installDir(dir, [
      ["a", b("new")],
      ["../b", b("x")],
    ]),
  ).toThrow();
  expect(holds(dir, [["a", b("good")]])).toBe(true);
  expect(readdirSync(dirname(dir)).length).toBe(1);
});

it("stale_partials_are_swept_and_fresh_ones_kept", () => {
  const root = tempdir();
  const parent = join(root, "plugins/x");
  mkdirSync(parent, { recursive: true });
  const stale = join(parent, ".1.0.0.partial-1-0-0");
  const fresh = join(parent, ".2.0.0.partial-1-0-0");
  mkdirSync(stale);
  mkdirSync(fresh);
  const old = new Date(Date.now() - 7200 * 1000);
  utimesSync(stale, old, old);
  installDir(join(parent, "3.0.0"), [["a", b("x")]]);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

it.skipIf(!UNIX)("a_root_that_is_not_this_users_to_trust_is_refused", () => {
  const base = tempdir();
  const real = join(base, "real");
  mkdirSync(real);
  const link = join(base, "link");
  symlinkSync(real, link);
  for (const origin of ["named", "default"] as const) {
    expect(() => prepareRoot(link, origin)).toThrow(/is a symlink/);
  }
  // Refused before anything was made through the link.
  expect(readdirSync(real).length).toBe(0);

  // A directory the user named keeps its mode, and is refused.
  const loose = join(base, "loose");
  mkdirSync(loose);
  chmodSync(loose, 0o755);
  expect(() => prepareRoot(loose, "named")).toThrow(/chmod 700/);
  expect(mode(loose)).toBe(0o755);
  expect(readdirSync(loose).length).toBe(0);

  // hpy's own default root is tightened, with what it holds.
  mkdirSync(join(loose, "plugins"));
  chmodSync(join(loose, "plugins"), 0o777);
  prepareRoot(loose, "default");
  for (const d of [loose, join(loose, "plugins"), join(loose, "happyview")])
    expect(mode(d), d).toBe(0o700);

  const linked = join(base, "linked");
  mkdirSync(linked, { recursive: true });
  symlinkSync(real, join(linked, "happyview"));
  expect(() => prepareRoot(linked, "named")).toThrow();

  const file = join(base, "file");
  writeFileSync(file, "");
  expect(() => prepareRoot(file, "named")).toThrow(/not a directory/);
});

it.skipIf(!UNIX)("a_named_root_hpy_creates_is_private_and_its_subdirectories_tightened", () => {
  const base = tempdir();
  const root = join(base, "a/b/cache");
  prepareRoot(root, "named");
  for (const d of [root, join(root, "plugins"), join(root, "happyview")])
    expect(mode(d), d).toBe(0o700);
  // Beneath a named root, the two directories are hpy's.
  chmodSync(join(root, "plugins"), 0o775);
  prepareRoot(root, "named");
  expect(mode(join(root, "plugins"))).toBe(0o700);
});

it.skipIf(!UNIX)("a_symlink_at_a_temp_name_is_never_followed", () => {
  const root = tempdir();
  const victim = join(root, "victim");
  writeFileSync(victim, "keep");
  const path = join(root, "bin/happyview");
  mkdirSync(dirname(path), { recursive: true });
  installFile(path, b("new"), false);
  expect(readFileSync(victim).toString()).toBe("keep");
  const tmp = join(root, "bin/t");
  symlinkSync(victim, tmp);
  expect(() => createNew(tmp, 0o600)).toThrow();
  expect(readFileSync(victim).toString()).toBe("keep");
});
