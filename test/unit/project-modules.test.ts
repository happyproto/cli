// crates/hpy/src/project/modules.rs tests (all `#[cfg(unix)]` in Rust: they run shell-script
// fakes of cargo and rustup).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { Failure } from "../../src/core/failure.ts";
import {
  type BuildResult,
  buildAll,
  buildEach,
  buildModule,
  checkToolchain,
  fingerprint,
  installArtifact,
  type ModuleSpec,
  readModules,
  Snapshot,
  sameFingerprint,
  Toolchain,
  watch,
} from "../../src/project/modules.ts";

const WIN = process.platform === "win32";
const unixIt = it.skipIf(WIN);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const ABORT = '[profile.release]\npanic = "abort"\n';
const REGISTRY =
  '[modules.registry]\nlanguage = "rust"\npath = "modules/registry"\ncapabilities = ["library:call"]\n';

function project(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hpy-modules-"));
  writeFileSync(join(dir, "happyview.toml"), toml);
  mkdirSync(join(dir, "modules/registry/src"), { recursive: true });
  writeFileSync(join(dir, "modules/registry/Cargo.toml"), `[package]\nname = "registry"\n${ABORT}`);
  return dir;
}

function toolchain(dir: string, targets: string): Toolchain {
  return {
    cargo: script(dir, "cargo", "echo 'cargo 1.96.1 (fake)'"),
    rustup: script(dir, "rustup", `printf '%s\\n' ${targets}`),
  };
}

/**
 * A cargo that reports `wasm` as the cdylib of whatever manifest it was given, or fails like a
 * compile error when `fail` is set. Every build appends a line to `count`.
 */
function fakeCargo(dir: string, wasm: string, fail: boolean, count: string): Toolchain {
  const build = fail
    ? "exit 101"
    : `printf '{"reason":"compiler-artifact","manifest_path":"%s","target":{"crate_types":["cdylib"]},"filenames":["${wasm}"]}\\n' "$manifest"\n` +
      `echo '{"reason":"build-finished","success":true}'`;
  const body =
    `if [ "$1" = --version ]; then echo 'cargo 1.96.1 (fake)'; exit 0; fi\n` +
    `echo build >> '${count}'\n` +
    `manifest=''\n` +
    `while [ $# -gt 0 ]; do [ "$1" = --manifest-path ] && manifest="$2"; shift; done\n` +
    build;
  return {
    cargo: script(dir, fail ? "cargo-fail" : "cargo-ok", body),
    rustup: script(dir, "rustup", "echo wasm32-wasip1"),
  };
}

function failure(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

async function failureOf(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

const first = (p: string): ModuleSpec => readModules(p)[0]!;

unixIt("modules_are_read_and_other_keys_ignored", () => {
  const p = project(`[instance]\napp_name = "x"\n\n${REGISTRY}`);
  expect(readModules(p)).toEqual([
    { name: "registry", language: "rust", path: "modules/registry" },
  ]);
});

unixIt("a_project_without_modules_has_none", () => {
  const p = project('[instance]\napp_name = "x"\n');
  expect(readModules(p)).toEqual([]);
});

unixIt("a_missing_happyview_toml_is_a_usage_error", () => {
  const dir = mkdtempSync(join(tmpdir(), "hpy-modules-"));
  const err = failure(() => readModules(dir));
  expect(err.code).toBe(2);
  expect(err.message).toContain("happyview.toml");
});

unixIt("a_module_name_that_could_leave_the_build_directory_is_refused", () => {
  const p = project('[modules."../x"]\nlanguage = "rust"\npath = "modules/registry"\n');
  const err = failure(() => readModules(p));
  expect(err.code).toBe(2);
  expect(err.message).toContain("'../x'");
});

unixIt("a_module_name_must_start_with_a_letter_as_happyview_requires", () => {
  let p = project('[modules.2fa]\nlanguage = "rust"\npath = "modules/registry"\n');
  const err = failure(() => readModules(p));
  expect(err.code).toBe(2);
  expect(err.message).toBe(
    "module '2fa' must be lowercase letters, digits, '-' or '_', starting with a letter",
  );
  p = project('[modules.t2-f_a]\nlanguage = "rust"\npath = "modules/registry"\n');
  expect(first(p).name).toBe("t2-f_a");
});

unixIt("a_module_path_whose_symlink_leaves_the_project_is_refused", () => {
  const outside = mkdtempSync(join(tmpdir(), "hpy-outside-"));
  const p = project('[modules.registry]\nlanguage = "rust"\npath = "modules/link"\n');
  symlinkSync(outside, join(p, "modules/link"));
  const err = failure(() => readModules(p));
  expect(err.code).toBe(2);
  expect(err.message).toBe(
    "module 'registry': module path 'modules/link' must be relative to the project root and stay inside it",
  );

  // A symlink that stays inside is only another name for the module.
  unlinkSync(join(p, "modules/link"));
  symlinkSync(join(p, "modules/registry"), join(p, "modules/link"));
  expect(first(p).path).toBe("modules/link");
});

unixIt("an_installed_target_passes", async () => {
  const p = project(REGISTRY);
  const tc = toolchain(p, "aarch64-apple-darwin wasm32-wasip1");
  await checkToolchain(tc, p, first(p));
});

unixIt("a_missing_target_names_the_command_that_installs_it", async () => {
  const p = project(REGISTRY);
  const tc = toolchain(p, "aarch64-apple-darwin");
  const err = await failureOf(checkToolchain(tc, p, first(p)));
  expect(err.code).toBe(2);
  expect(err.message).toContain("rustup target add wasm32-wasip1");
  expect(err.message).toContain("modules/registry");
});

unixIt("a_missing_cargo_says_how_to_install_rust", async () => {
  const p = project(REGISTRY);
  const tc: Toolchain = { cargo: "/nonexistent/cargo", rustup: "/nonexistent/rustup" };
  const err = await failureOf(checkToolchain(tc, p, first(p)));
  expect(err.message).toContain("https://rustup.rs");
});

unixIt("without_rustup_the_target_check_is_left_to_cargo", async () => {
  const p = project(REGISTRY);
  const tc = toolchain(p, "");
  tc.rustup = "/nonexistent/rustup";
  await checkToolchain(tc, p, first(p));
});

unixIt("an_unsupported_language_is_named", async () => {
  const p = project('[modules.registry]\nlanguage = "go"\npath = "modules/registry"\n');
  const tc = toolchain(p, "wasm32-wasip1");
  const err = await failureOf(checkToolchain(tc, p, first(p)));
  expect(err.message).toContain("'go'");
});

unixIt("a_module_path_that_leaves_the_project_is_refused", () => {
  for (const bad of ["/etc/x", "../outside", "modules/../../x", ""]) {
    const p = project(`[modules.registry]\nlanguage = "rust"\npath = "${bad}"\n`);
    const err = failure(() => readModules(p));
    expect(err.code, bad).toBe(2);
    expect(err.message).toContain("registry");
    expect(err.message).toContain(`'${bad}'`);
    expect(err.message).toContain("stay inside it");
  }
});

unixIt("a_nested_module_path_is_accepted", () => {
  const p = project('[modules.registry]\nlanguage = "rust"\npath = "modules/a/b"\n');
  expect(first(p).path).toBe("modules/a/b");
});

unixIt("a_cargo_that_exits_non_zero_is_a_failure_with_the_install_hint", async () => {
  const p = project(REGISTRY);
  const tc = toolchain(p, "wasm32-wasip1");
  tc.cargo = script(p, "badcargo", "exit 1");
  const err = await failureOf(checkToolchain(tc, p, first(p)));
  expect(err.code).toBe(2);
  expect(err.message).toContain("https://rustup.rs");
});

unixIt("cargo_and_rustup_run_in_the_module_directory", async () => {
  const p = project(REGISTRY);
  const tc = toolchain(p, "wasm32-wasip1");
  tc.cargo = script(p, "pwdcargo", '[ "$(basename "$PWD")" = registry ] || exit 1');
  tc.rustup = script(
    p,
    "pwdrustup",
    '[ "$(basename "$PWD")" = registry ] || exit 1; echo wasm32-wasip1',
  );
  await checkToolchain(tc, p, first(p));
});

unixIt("a_rustup_that_fails_leaves_the_target_check_to_cargo", async () => {
  const p = project(REGISTRY);
  const tc = toolchain(p, "");
  tc.rustup = script(p, "badrustup", "exit 1");
  await checkToolchain(tc, p, first(p));
});

unixIt("a_module_without_a_cargo_toml_is_named", async () => {
  const p = project(REGISTRY);
  unlinkSync(join(p, "modules/registry/Cargo.toml"));
  const tc = toolchain(p, "wasm32-wasip1");
  const err = await failureOf(checkToolchain(tc, p, first(p)));
  expect(err.code).toBe(2);
  expect(err.message).toBe("module 'registry': no Cargo.toml in modules/registry");
});

unixIt("a_build_installs_the_cdylib_under_the_module_name", async () => {
  const p = project(REGISTRY);
  const wasm = join(p, "built.wasm");
  writeFileSync(wasm, "\0asm-new");
  const tc = fakeCargo(p, wasm, false, join(p, "count"));
  const dest = await buildModule(tc, p, first(p));
  expect(dest).toBe(join(p, ".happyview/build/registry.wasm"));
  expect(readFileSync(dest, "latin1")).toBe("\0asm-new");
});

unixIt("a_failed_build_leaves_the_previous_module_in_place", async () => {
  const p = project(REGISTRY);
  const dest = join(p, ".happyview/build/registry.wasm");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, "\0asm-old");
  const tc = fakeCargo(p, "/unused", true, join(p, "count"));
  const err = await failureOf(buildModule(tc, p, first(p)));
  expect(err.message).toContain("'registry' failed to build");
  expect(readFileSync(dest, "latin1")).toBe("\0asm-old");
});

unixIt("a_build_with_no_cdylib_says_which_setting_is_missing", async () => {
  const p = project(REGISTRY);
  const body = `if [ "$1" = --version ]; then exit 0; fi\necho '{"reason":"build-finished","success":true}'`;
  const tc: Toolchain = {
    cargo: script(p, "cargo-nolib", body),
    rustup: script(p, "rustup", "echo wasm32-wasip1"),
  };
  const err = await failureOf(buildModule(tc, p, first(p)));
  expect(err.message).toContain('crate-type = ["cdylib"]');
});

unixIt("build_all_builds_every_module_and_reports_each_failure", async () => {
  const p = project(`${REGISTRY}\n[modules.other]\nlanguage = "rust"\npath = "modules/other"\n`);
  const wasm = join(p, "built.wasm");
  writeFileSync(wasm, "\0asm");
  const tc = fakeCargo(p, wasm, false, join(p, "count"));
  // `other` has no Cargo.toml, so it fails before cargo runs.
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  let err: Failure;
  try {
    err = await failureOf(buildAll(tc, p));
  } finally {
    process.stderr.write = write;
  }
  expect(err.message).toContain("other");
  expect(err.message).toBe("1 module(s) failed to build: other");
  expect(err.code).toBe(2);
  expect(stderr).toBe("  × module 'other': no Cargo.toml in modules/other\n\n");
  expect(existsSync(join(p, ".happyview/build/registry.wasm"))).toBe(true);
});

unixIt("a_module_that_unwinds_is_refused_before_cargo_builds_it", async () => {
  for (const [manifest, fix] of [
    [
      '[package]\nname = "registry"\n',
      'add to modules/registry/Cargo.toml:\n  [profile.release]\n  panic = "abort"',
    ],
    [
      '[package]\nname = "registry"\n[profile.release]\npanic = "unwind"\n',
      'set `panic = "abort"` under the existing `[profile.release]` in modules/registry/Cargo.toml',
    ],
    [
      '[package]\nname = "registry"\n[profile.release]\nopt-level = 3\n',
      'set `panic = "abort"` under the existing `[profile.release]` in modules/registry/Cargo.toml',
    ],
  ] as const) {
    const p = project(REGISTRY);
    writeFileSync(join(p, "modules/registry/Cargo.toml"), manifest);
    const count = join(p, "count");
    const tc = fakeCargo(p, "/unused", false, count);
    const err = await failureOf(buildModule(tc, p, first(p)));
    expect(err.code).toBe(2);
    expect(err.message).toContain("'registry'");
    expect(err.message.endsWith(fix), err.message).toBe(true);
    expect(existsSync(count), "cargo built a module that unwinds").toBe(false);
  }
});

unixIt("a_workspace_member_is_judged_by_the_workspace_profile", async () => {
  const p = project(REGISTRY);
  const wasm = join(p, "built.wasm");
  writeFileSync(wasm, "\0asm");
  const tc = fakeCargo(p, wasm, false, join(p, "count"));
  // Cargo ignores a member's own profile, so the one that counts is the workspace root's.
  writeFileSync(join(p, "modules/Cargo.toml"), '[workspace]\nmembers = ["registry"]\n');
  const module = first(p);
  const text = (await failureOf(buildModule(tc, p, module))).message;
  expect(text).toContain("modules/Cargo.toml");
  expect(text).not.toContain("modules/registry/Cargo.toml");

  writeFileSync(join(p, "modules/Cargo.toml"), `[workspace]\nmembers = ["registry"]\n${ABORT}`);
  writeFileSync(join(p, "modules/registry/Cargo.toml"), '[package]\nname = "registry"\n');
  await buildModule(tc, p, module);
});

unixIt("a_module_excluded_from_an_enclosing_workspace_keeps_its_own_profile", async () => {
  const p = project(REGISTRY);
  const wasm = join(p, "built.wasm");
  writeFileSync(wasm, "\0asm");
  const tc = fakeCargo(p, wasm, false, join(p, "count"));
  writeFileSync(join(p, "Cargo.toml"), '[workspace]\nexclude = ["modules"]\n');
  await buildModule(tc, p, first(p));
});

unixIt(
  "the_root_search_passes_an_excluding_workspace_unless_it_also_lists_the_member",
  async () => {
    const p = project(REGISTRY);
    const tc = fakeCargo(p, "/unused", false, join(p, "count"));
    const module = first(p);
    // Cargo carries on above the workspace that excludes the crate and finds the one that
    // lists it, whose profile is the one it applies.
    writeFileSync(join(p, "modules/Cargo.toml"), '[workspace]\nexclude = ["registry"]\n');
    writeFileSync(join(p, "Cargo.toml"), '[workspace]\nmembers = ["modules/registry"]\n');
    let text = (await failureOf(buildModule(tc, p, module))).message;
    expect(text).toContain("add to Cargo.toml:");

    // Listed as a member as well, the crate belongs to the nearer one.
    writeFileSync(
      join(p, "modules/Cargo.toml"),
      '[workspace]\nmembers = ["registry"]\nexclude = ["registry"]\n',
    );
    text = (await failureOf(buildModule(tc, p, module))).message;
    expect(text).toContain("add to modules/Cargo.toml:");
  },
);

unixIt("a_package_workspace_path_is_named_without_dot_segments", async () => {
  const p = project(REGISTRY);
  const tc = fakeCargo(p, "/unused", false, join(p, "count"));
  const module = first(p);
  writeFileSync(
    join(p, "modules/registry/Cargo.toml"),
    '[package]\nname = "registry"\nworkspace = "./../"\n',
  );
  writeFileSync(join(p, "modules/Cargo.toml"), '[workspace]\nmembers = ["registry"]\n');
  const text = (await failureOf(buildModule(tc, p, module))).message;
  expect(text).toContain("add to modules/Cargo.toml:");
});

unixIt("a_failed_install_leaves_no_staging_file_and_the_previous_build", () => {
  const p = project(REGISTRY);
  const built = join(p, "built.wasm");
  writeFileSync(built, "\0asm");
  // A non-empty directory where the module goes makes the rename fail.
  const dest = join(p, ".happyview/build/registry.wasm");
  mkdirSync(join(dest, "kept"), { recursive: true });
  failure(() => installArtifact(p, "registry", built));
  expect(statSync(join(dest, "kept")).isDirectory()).toBe(true);
  expect(readdirSync(join(p, ".happyview/build"))).toEqual(["registry.wasm"]);
});

unixIt("the_fingerprint_sees_a_source_change_and_ignores_build_output", () => {
  const p = project(REGISTRY);
  const dir = join(p, "modules/registry");
  writeFileSync(join(dir, "src/lib.rs"), "a");
  const before = fingerprint(dir);

  mkdirSync(join(dir, "target/release"), { recursive: true });
  writeFileSync(join(dir, "target/release/x.wasm"), "built");
  expect(sameFingerprint(fingerprint(dir), before), "build output is not source").toBe(true);

  writeFileSync(join(dir, "src/lib.rs"), "ab");
  expect(sameFingerprint(fingerprint(dir), before)).toBe(false);
});

unixIt("watch_rebuilds_a_changed_module_once_and_keeps_the_old_build_on_failure", async () => {
  const p = project(REGISTRY);
  const dest = join(p, ".happyview/build/registry.wasm");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, "\0asm-old");
  const count = join(p, "count");
  const tc = fakeCargo(p, "/unused", true, count);
  const stop = new AbortController();
  const src = join(p, "modules/registry/src/lib.rs");
  writeFileSync(src, "a");
  const from = Snapshot.take(p, readModules(p));

  const outcomes: [string, boolean][] = [];
  const stopper = (async () => {
    writeFileSync(src, "changed");
    // A build still under way when `stop` is set is not reported, so the polls that follow
    // are timed from the build rather than from the edit.
    const deadline = Date.now() + 10_000;
    while (!existsSync(count) && Date.now() < deadline) await sleep(10);
    await sleep(400);
    stop.abort();
  })();
  await watch(tc, p, from, 50, stop.signal, (m, r) => {
    outcomes.push([m.name, !(r instanceof Failure)]);
  });
  await stopper;

  expect(outcomes).toEqual([["registry", false]]);
  expect(readFileSync(count, "utf8").split("\n").filter(Boolean).length).toBe(1);
  expect(readFileSync(dest, "latin1")).toBe("\0asm-old");
});

unixIt("build_each_starts_no_module_once_stopped", async () => {
  const p = project(
    `${REGISTRY}\n[modules.other]\nlanguage = "rust"\npath = "modules/other"\ncapabilities = ["library:call"]\n`,
  );
  mkdirSync(join(p, "modules/other/src"), { recursive: true });
  writeFileSync(join(p, "modules/other/Cargo.toml"), `[package]\nname = "other"\n${ABORT}`);
  const wasm = join(p, "built.wasm");
  writeFileSync(wasm, "\0asm");
  const inner = fakeCargo(p, wasm, false, join(p, "count"));
  // Counted at the version probe, which finishes before a build starts: a build that `stop`
  // kills may die before it records itself.
  const probes = join(p, "probes");
  const tc: Toolchain = {
    cargo: script(
      p,
      "cargo-probed",
      `[ "$1" = --version ] && echo probe >> '${probes}'\nexec '${inner.cargo}' "$@"`,
    ),
    rustup: inner.rustup,
  };
  const modules = readModules(p);
  expect(modules.length).toBe(2);
  const started = () =>
    existsSync(probes) ? readFileSync(probes, "utf8").split("\n").filter(Boolean).length : 0;

  const stop = new AbortController();
  const built: [string, boolean][] = [];
  await buildEach(tc, p, modules, stop.signal, (m, r: BuildResult) => {
    built.push([m.name, !(r instanceof Failure)]);
    stop.abort();
  });
  expect(built).toEqual([[modules[0]!.name, true]]);
  expect(started()).toBe(1);

  await buildEach(tc, p, modules, stop.signal, () => {
    throw new Error("nothing is built once stopped");
  });
  expect(started()).toBe(1);
});

/** A zombie is already dead; on Linux it stays one under a subreaper that does not reap. */
function alive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[0];
      return state !== undefined && state !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

unixIt("stopping_the_watch_ends_a_build_under_way_with_its_children", async () => {
  const p = project(REGISTRY);
  const pidFile = join(p, "cargo.pid");
  const grandchild = join(p, "rustc.pid");
  // A cargo that starts a child of its own, as cargo starts rustc.
  const body = `if [ "$1" = --version ]; then exit 0; fi\nsleep 30 &\necho $! > '${grandchild}'\necho $$ > '${pidFile}'\nwait`;
  const tc: Toolchain = {
    cargo: script(p, "cargo-slow", body),
    rustup: script(p, "rustup", "echo wasm32-wasip1"),
  };
  const stop = new AbortController();
  const src = join(p, "modules/registry/src/lib.rs");
  writeFileSync(src, "a");
  const from = Snapshot.take(p, readModules(p));

  let outcomes = 0;
  const read = (path: string): number | undefined => {
    try {
      const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      return Number.isNaN(n) ? undefined : n;
    } catch {
      return undefined;
    }
  };
  const stopper = (async () => {
    try {
      writeFileSync(src, "changed");
      const deadline = Date.now() + 10_000;
      let cargo = read(pidFile);
      while (cargo === undefined) {
        if (Date.now() >= deadline) throw new Error("cargo never started");
        await sleep(20);
        cargo = read(pidFile);
      }
      const rustc = read(grandchild);
      if (rustc === undefined) throw new Error("cargo's child is written first");
      stop.abort();
      return { cargo, rustc, stoppedAt: Date.now() };
    } finally {
      stop.abort();
    }
  })();
  await watch(tc, p, from, 50, stop.signal, () => {
    outcomes++;
  });
  const { cargo, rustc, stoppedAt } = await stopper;
  const waited = Date.now() - stoppedAt;
  // An orphan is reaped by whichever process adopts it, which takes a moment after the kill.
  const deadline = Date.now() + 5000;
  while (alive(rustc) && Date.now() < deadline) await sleep(20);
  const [cargoAlive, rustcAlive] = [alive(cargo), alive(rustc)];
  for (const pid of [cargo, rustc]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  expect(cargoAlive, "the stopped build's cargo is still running").toBe(false);
  expect(rustcAlive, "the stopped build's child is still running").toBe(false);
  expect(waited, `watch waited ${waited}ms for the build`).toBeLessThan(5000);
  expect(outcomes, "a stopped build is not reported").toBe(0);
});

// `#[ignore]` in Rust: builds a real crate, so it needs cargo and the wasm32-wasip1 target.
it.skipIf(WIN || !process.env.HPY_REAL_CARGO_TEST)(
  "a_real_cargo_build_produces_a_wasm_module",
  async () => {
    const p = project(REGISTRY);
    writeFileSync(
      join(p, "modules/registry/Cargo.toml"),
      `[package]\nname = "registry"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib"]\n[workspace]\n${ABORT}`,
    );
    writeFileSync(
      join(p, "modules/registry/src/lib.rs"),
      '#[no_mangle] pub extern "C" fn answer() -> i32 { 42 }\n',
    );
    const dest = await buildModule(Toolchain.fromEnv(), p, first(p));
    expect(readFileSync(dest).subarray(0, 4).toString("latin1")).toBe("\0asm");
  },
  300_000,
);
