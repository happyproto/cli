// crates/hpy/tests/happyview.rs: `hpy hv check`, `test`, `types`, `build` and `dev` (the real
// network) against a fake HappyView release (a shell script in a `.tar.xz`) and, where a
// command needs one, a fake registry. `dev --network local` is network.rs's.
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Json } from "../../src/core/output.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import { hpyCommand, hpyEnv } from "../support/hpy.ts";
import { HV_DID, mountRegistry, Plugin, Stack, says, VERSION } from "../support/hv-stack.ts";
import { query } from "../support/mock-server.ts";

const unix = process.platform !== "win32";
const linux = process.platform === "linux";

let stacks: Stack[] = [];
let temps: string[] = [];
let children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) killGroup(c);
  for (const s of stacks) await s.dispose();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  stacks = [];
  temps = [];
  children = [];
});

async function stack(): Promise<Stack> {
  const s = await Stack.start();
  stacks.push(s);
  return s;
}

function tempdir(): string {
  const d = mkdtempSync(join(tmpdir(), "hpy-elsewhere-"));
  temps.push(d);
  return d;
}

const read = (path: string) => readFileSync(path, "utf8");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function killGroup(c: ChildProcess): void {
  try {
    process.kill(-(c.pid as number), "SIGKILL");
  } catch {
    try {
      c.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The lock entry `hpy` writes for `version` of `name` as `versionJson` describes it. */
function lockEntry(name: string, key: string, version: { [k: string]: Json }): string {
  const artifact = version.artifact as { [k: string]: Json };
  const link = (b: Json) => ((b as { [k: string]: Json }).ref as { [k: string]: Json }).$link;
  return (
    `[[plugin]]\nid = "${name}"\nkind = "interpreter"\nkeys = ["${key}"]\n` +
    `project = "at://${HV_DID}/software.release.project/${name}"\nversion = "${version.version}"\n` +
    `channel = "latest"\nversion_uri = "${version.uri}"\nmanifest_cid = "${(version.manifest as { [k: string]: Json }).cid}"\npackage_cid = "${link(artifact.package as Json)}"\n` +
    `manifest_blob_cid = "${link(artifact.manifest as Json)}"\ndependencies = []\ncapabilities = ${JSON.stringify(artifact.capabilities)}\n`
  );
}

function luaProject(s: Stack): { [k: string]: Json } {
  const lua = Plugin.interpreter("happyview-lua", "lua", "\0asm lua");
  const version = lua.versionJson();
  mountRegistry(s, [lua]);
  writeFileSync(
    join(s.project, "happyview.toml"),
    `[happyview]\nversion = "${VERSION}"\n[interpreters]\n` +
      `lua = { did = "${HV_DID}", name = "happyview-lua", channel = "latest" }\n`,
  );
  writeFileSync(
    join(s.project, "happyview.lock"),
    `version = 2\n\n[happyview]\nversion = "${VERSION}"\n\n${lockEntry("happyview-lua", "lua", version)}`,
  );
  return version;
}

/** A fake cargo that installs whatever `built` holds when it runs. */
function fakeCargo(root: string, built: string): string {
  const cargo = join(root, "cargo");
  writeFileSync(
    cargo,
    `#!/bin/sh\nif [ "$1" = --version ]; then exit 0; fi\n` +
      `if [ -n "$NET_LOG" ]; then echo 'cargo build' >> "$NET_LOG"; fi\n` +
      `manifest=''; while [ $# -gt 0 ]; do [ "$1" = --manifest-path ] && manifest="$2"; shift; done\n` +
      `printf '{"reason":"compiler-artifact","manifest_path":"%s","target":{"crate_types":["cdylib"]},"filenames":["${built}"]}\\n' "$manifest"\n`,
  );
  chmodSync(cargo, 0o755);
  return cargo;
}

/**
 * Declares one Rust module whose builds, by a fake cargo that `HPY_CARGO` names, install
 * whatever `built.wasm` holds at the time. Answers the environment that fake needs, and the
 * path the module installs to.
 */
function declareModule(s: Stack): { env: Record<string, string>; dest: string } {
  const root = s.project;
  writeFileSync(
    join(root, "happyview.toml"),
    `[happyview]\nversion = "${VERSION}"\n[modules.registry]\nlanguage = "rust"\npath = "modules/registry"\n`,
  );
  mkdirSync(join(root, "modules/registry/src"), { recursive: true });
  writeFileSync(
    join(root, "modules/registry/Cargo.toml"),
    `[package]\nname = "registry"\n[profile.release]\npanic = "abort"\n`,
  );
  writeFileSync(join(root, "modules/registry/src/lib.rs"), "");
  const built = join(root, "built.wasm");
  writeFileSync(built, "\0asm-1");
  return {
    env: { HPY_CARGO: fakeCargo(root, built), HPY_RUSTUP: "/nonexistent/rustup" },
    dest: join(root, ".happyview/build/registry.wasm"),
  };
}

/** Starts `hpy` in a process group of its own, as a terminal would. */
function start(s: Stack, args: string[], env: Record<string, string>): ChildProcess {
  const [cmd, lead] = hpyCommand();
  const child = spawn(cmd, [...lead, ...args], {
    cwd: s.project,
    env: hpyEnv(s.home, { ...s.env(), ...env }),
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  children.push(child);
  return child;
}

function exited(c: ChildProcess): boolean {
  return c.exitCode !== null || c.signalCode !== null;
}

/**
 * Waits for the fake binary under `hpy` to report its pid. Fetching and placing the binary
 * has a budget of its own, and the readiness deadline starts once it is in place.
 */
async function awaitBinary(s: Stack, hpy: ChildProcess): Promise<number> {
  const placed = join(s.cache, `happyview/${VERSION}/happyview`);
  const ready = `${s.log}.ready`;
  let deadline = Date.now() + 120_000;
  let inPlace = false;
  for (;;) {
    let pid: number | undefined;
    try {
      const text = read(ready).trim();
      if (text !== "") pid = Number(text);
    } catch {
      // Not yet.
    }
    if (pid !== undefined && Number.isInteger(pid)) return pid;
    if (!inPlace && existsSync(placed)) {
      inPlace = true;
      deadline = Date.now() + 30_000;
    }
    if (exited(hpy)) throw new Error("hpy exited before the binary was ready");
    if (Date.now() >= deadline) throw new Error("the binary never became ready");
    await sleep(20);
  }
}

async function waitExit(c: ChildProcess, ms = 30_000): Promise<number | null> {
  const deadline = Date.now() + ms;
  while (!exited(c)) {
    if (Date.now() >= deadline) {
      killGroup(c);
      throw new Error("hpy did not exit");
    }
    await sleep(20);
  }
  return c.exitCode;
}

/** A running `hpy` and the fake binary under it, in `HV_MODE=signals`. */
class Running {
  readonly hpy: ChildProcess;
  readonly binary: number;

  constructor(hpy: ChildProcess, binary: number) {
    this.hpy = hpy;
    this.binary = binary;
  }

  static async start(s: Stack, args: string[], env: Record<string, string>): Promise<Running> {
    const hpy = start(s, args, { ...env, HV_MODE: "signals" });
    const binary = await awaitBinary(s, hpy);
    if (binary === hpy.pid) {
      killGroup(hpy);
      throw new Error("hpy became the binary instead of watching the modules");
    }
    return new Running(hpy, binary);
  }

  signal(sig: NodeJS.Signals): void {
    process.kill(this.hpy.pid as number, sig);
  }

  signalGroup(sig: NodeJS.Signals): void {
    process.kill(-(this.hpy.pid as number), sig);
  }

  /** Lets any further copy of a signal just sent land, then tells the binary to exit. */
  async settleAndQuit(s: Stack): Promise<number | null> {
    await sleep(500);
    writeFileSync(`${s.log}.quit`, "");
    return this.wait();
  }

  /** `hpy`'s exit code, after which the binary must be gone too. */
  async wait(): Promise<number | null> {
    const code = await waitExit(this.hpy);
    if (alive(this.binary)) {
      process.kill(this.binary, "SIGKILL");
      throw new Error(`hpy exited (${code}) and left the binary running`);
    }
    return code;
  }
}

function signalsReceived(s: Stack): string {
  try {
    return read(`${s.log}.sig`);
  } catch {
    return "";
  }
}

/** Changes the module's source with `next` as what its next build installs, and waits for `dest` to hold it. */
async function editAndAwaitRebuild(s: Stack, dest: string, next: string): Promise<void> {
  writeFileSync(join(s.project, "built.wasm"), next);
  writeFileSync(join(s.project, "modules/registry/src/lib.rs"), "// edited\n");
  const deadline = Date.now() + 15_000;
  for (;;) {
    let now: string | undefined;
    try {
      now = read(dest);
    } catch {
      // Not yet.
    }
    if (now === next) return;
    if (Date.now() >= deadline) throw new Error("the module was never rebuilt");
    await sleep(50);
  }
}

describe("tests/happyview.rs check, test, types, build and dev", () => {
  it.skipIf(!unix)("check_runs_the_pinned_binary_and_passes_its_exit_code_through", async () => {
    const s = await stack();
    const r = await s.hpy(["happyview", "check"], { HV_EXIT: "3" });
    expect(r.code).toBe(3);
    expect(r.stderr).not.toContain("Error");
    expect(s.readLog().trim()).toBe("check .");
    expect(statSync(join(s.cache, `happyview/${VERSION}/happyview`)).isFile()).toBe(true);
    expect(statSync(join(s.project, ".happyview/plugins")).isDirectory()).toBe(true);
  });

  it.skipIf(!unix)("check_warns_of_a_query_or_procedure_without_a_handler", async () => {
    const s = await stack();
    const lex = join(s.project, "src/lexicons/com/example");
    mkdirSync(lex, { recursive: true });
    for (const [name, ty] of [
      ["listNotes", "query"],
      ["saveNote", "procedure"],
      ["hello", "query"],
      ["note", "record"],
    ] as const) {
      writeFileSync(
        join(lex, `${name}.json`),
        JSON.stringify({ lexicon: 1, id: `com.example.${name}`, defs: { main: { type: ty } } }),
      );
    }
    writeFileSync(join(lex, "hello.lua"), "function handle() end");
    const r = await s.hpy(["hv", "check"], { HV_EXIT: "0" });
    // A warning, so the exit code is still HappyView's.
    expect(r.code).toBe(0);
    expect(
      says(
        r.stderr,
        "warning: query com.example.listNotes has no handler beside src/lexicons/com/example/listNotes.json, so HappyView answers it only for ?uri=; run `hpy hv scaffold com.example.listNotes`",
      ),
    ).toBe(true);
    expect(says(r.stderr, "run `hpy hv scaffold com.example.saveNote`")).toBe(true);
    expect(r.stderr).not.toContain("com.example.hello");
    expect(r.stderr).not.toContain("com.example.note ");
    expect(s.readLog().trim()).toBe("check .");
  });

  // An editor reads HappyView's own report, so `--json` reaches it.
  it.skipIf(!unix)("check_passes_json_through", async () => {
    const s = await stack();
    expect((await s.hpy(["happyview", "check", "--json"])).code).toBe(0);
    expect(s.readLog().trim()).toBe("check . --json");
  });

  // A lock from before capabilities were recorded is rewritten by `check`, which is what a
  // deploy's refusal tells the operator to run.
  it.skipIf(!unix)("check_rewrites_a_lock_that_records_no_capabilities", async () => {
    const s = await stack();
    luaProject(s);
    const path = join(s.project, "happyview.lock");
    const before = read(path);
    const stripped = before
      .split("\n")
      .filter((l, i, all) => !(i === all.length - 1 && l === ""))
      .filter((l) => !l.startsWith("capabilities"))
      .map((l) => `${l}\n`)
      .join("");
    writeFileSync(path, stripped);
    expect((await s.hpy(["hv", "check"])).code).toBe(0);
    const after = read(path);
    expect(after).toContain('capabilities = ["script:host"]');
    // Re-resolving passes the previous lock, so the version it pins stays put.
    const versionOf = (text: string) => text.split("\n").find((l) => l.startsWith("version_uri"));
    expect(versionOf(after)).toBe(versionOf(before));
  });

  it.skipIf(!unix)("check_places_and_verifies_locked_plugins", async () => {
    const s = await stack();
    luaProject(s);
    const lock = read(join(s.project, "happyview.lock"));
    expect((await s.hpy(["hv", "check", "--locked"])).code).toBe(0);
    expect(read(join(s.project, "happyview.lock"))).toBe(lock);
    expect(s.readLog().trim()).toBe("check .");
    expect(read(join(s.cache, "plugins/happyview-lua/1.4.2/happyview-lua.wasm"))).toBe("\0asm lua");
    const manifest = read(join(s.project, ".happyview/plugins/happyview-lua/manifest.json"));
    expect(manifest).toContain('"language_id": "lua"');
    expect(manifest).toContain('"name": "Lua"');
  });

  it.skipIf(!unix)("check_refuses_bytes_that_do_not_match_their_cid", async () => {
    const s = await stack();
    const lua = Plugin.interpreter("happyview-lua", "lua", "\0asm lua");
    const version = lua.versionJson();
    const pkg = (
      ((version.artifact as { [k: string]: Json }).package as { [k: string]: Json }).ref as {
        [k: string]: Json;
      }
    ).$link as string;
    // Ahead of the registry's own answer, as wiremock's priority 1 is.
    s.server.given(
      "GET",
      "/xrpc/at.happyproto.registry.getArtifact",
      { body: Buffer.from("\0asm evil"), headers: { "content-type": "application/wasm" } },
      query("cid", pkg),
    );
    mountRegistry(s, [lua]);
    writeFileSync(
      join(s.project, "happyview.toml"),
      `[happyview]\nversion = "${VERSION}"\n[interpreters]\n` +
        `lua = { did = "${HV_DID}", name = "happyview-lua", channel = "latest" }\n`,
    );
    writeFileSync(
      join(s.project, "happyview.lock"),
      `version = 2\n\n[happyview]\nversion = "${VERSION}"\n\n${lockEntry("happyview-lua", "lua", version)}`,
    );
    const r = await s.hpy(["hv", "check"]);
    expect(r.code).toBe(1);
    expect(says(r.stderr, pkg)).toBe(true);
    expect(says(r.stderr, rawCid(Buffer.from("\0asm evil")))).toBe(true);
    expect(s.readLog()).toBe("");
    expect(existsSync(join(s.cache, "plugins/happyview-lua/1.4.2"))).toBe(false);
  });

  it("a_lock_from_before_the_registry_moved_says_to_delete_it", async () => {
    const s = await stack();
    writeFileSync(
      join(s.project, "happyview.lock"),
      `version = 1\n\n[happyview]\nversion = "${VERSION}"\n`,
    );
    const r = await s.hpy(["hv", "check"]);
    expect(r.code).toBe(2);
    expect(
      says(
        r.stderr,
        "happyview.lock predates the software.release registry; delete it and run hpy happyview check",
      ),
    ).toBe(true);
  });

  it("a_bare_version_in_happyview_toml_names_the_table_form", async () => {
    const s = await stack();
    writeFileSync(
      join(s.project, "happyview.toml"),
      `[happyview]\nversion = "${VERSION}"\n[interpreters]\nlua = "*"\n`,
    );
    const r = await s.hpy(["hv", "check"]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "interpreters.lua")).toBe(true);
    expect(says(r.stderr, "did = ")).toBe(true);
  });

  it.skipIf(!unix)("types_runs_the_binary_then_points_editors_at_the_types", async () => {
    const s = await stack();
    luaProject(s);
    let r = await s.hpy(["hv", "types"]);
    expect(r.code).toBe(0);
    expect(says(r.stderr, "wrote .luarc.json, which points editors at .happyview/types/lua")).toBe(
      true,
    );
    expect(s.readLog().trim()).toBe("types .");
    expect(read(join(s.project, ".luarc.json"))).toContain('".happyview/types/lua"');
    expect(existsSync(join(s.project, "tsconfig.json"))).toBe(false);

    // An existing file is the author's: it is named, not rewritten.
    writeFileSync(join(s.project, ".luarc.json"), "{}\n");
    r = await s.hpy(["hv", "types"]);
    expect(r.code).toBe(0);
    expect(says(r.stderr, ".luarc.json does not name .happyview/types/lua")).toBe(true);
    expect(read(join(s.project, ".luarc.json"))).toBe("{}\n");
  });

  it.skipIf(!unix)(
    "a_failed_types_run_still_points_editors_and_passes_its_code_through",
    async () => {
      const s = await stack();
      luaProject(s);
      expect((await s.hpy(["hv", "types"], { HV_EXIT: "1" })).code).toBe(1);
      expect(existsSync(join(s.project, ".luarc.json"))).toBe(true);
    },
  );

  it.skipIf(!unix)("an_inherited_plugin_dir_is_named_and_kept_from_the_binary", async () => {
    const s = await stack();
    const r = await s.hpy(["hv", "check"], { PLUGIN_DIR: "/elsewhere" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("warning: ignoring PLUGIN_DIR");
    expect(s.readLog().trim()).toBe("check .");
  });

  it.skipIf(!unix)("test_passes_watch_and_filter_and_hv_is_an_alias", async () => {
    const s = await stack();
    expect((await s.hpy(["hv", "test", "--watch", "getArtifact"])).code).toBe(0);
    expect(s.readLog().trim()).toBe("test . --watch getArtifact");
  });

  it.skipIf(!unix)("check_and_test_build_the_modules_then_run_the_binary", async () => {
    const s = await stack();
    const root = s.project;
    writeFileSync(
      join(root, "happyview.toml"),
      `[happyview]\nversion = "${VERSION}"\n[modules.registry]\nlanguage = "rust"\npath = "modules/registry"\n`,
    );
    mkdirSync(join(root, "modules/registry"), { recursive: true });
    writeFileSync(
      join(root, "modules/registry/Cargo.toml"),
      `[package]\nname = "registry"\n[profile.release]\npanic = "abort"\n`,
    );
    const built = join(root, "built.wasm");
    const cargo = fakeCargo(root, built);
    const dest = join(root, ".happyview/build/registry.wasm");
    for (const [command, version] of [
      ["check", "\0asm-1"],
      ["test", "\0asm-2"],
    ] as const) {
      writeFileSync(built, version);
      const r = await s.hpy(["hv", command], {
        HPY_CARGO: cargo,
        HPY_RUSTUP: "/nonexistent/rustup",
      });
      expect(r.code, command).toBe(0);
      expect(read(dest), command).toBe(version);
      expect(s.readLog().trimEnd().endsWith(`${command} .`)).toBe(true);
    }
  });

  it.skipIf(!unix)("commands_find_the_project_from_a_subdirectory", async () => {
    const s = await stack();
    const deep = join(s.project, "src/lexicons");
    mkdirSync(deep, { recursive: true });
    expect((await s.hpyIn(deep, ["hv", "check"])).code).toBe(0);
    expect(s.readLog().trim()).toBe("check .");
    expect(read(`${s.log}.cwd`).trim()).toBe(realpathSync(s.project));
  });

  it.skipIf(!unix)("a_failing_check_exits_with_its_code_and_hpy_adds_nothing", async () => {
    const s = await stack();
    // The first run downloads the binary and says so.
    expect((await s.hpy(["hv", "check"])).code).toBe(0);
    const r = await s.hpy(["hv", "check"], { HV_EXIT: "5" });
    expect(r.code).toBe(5);
    expect(r.stderr).toBe("");
  });

  it.skipIf(!unix)(
    "a_sigterm_to_hpy_reaches_the_binary_once_and_its_exit_code_comes_back",
    async () => {
      const s = await stack();
      const child = start(s, ["hv", "check"], { HV_MODE: "trap" });
      const binary = await awaitBinary(s, child);
      process.kill(child.pid as number, "SIGTERM");
      const code = await waitExit(child);
      // A binary still alive here was orphaned; it is stopped before anything is asserted.
      if (alive(binary)) {
        process.kill(binary, "SIGKILL");
        throw new Error(`hpy exited (${code}) and left the binary running`);
      }
      expect(binary, "hpy did not become the binary").toBe(child.pid);
      expect(code).toBe(7);
      expect(read(`${s.log}.term`)).toBe("got\n");
    },
  );

  it("outside_a_project_is_a_usage_error", async () => {
    const s = await stack();
    const r = await s.hpyIn(tempdir(), ["hv", "check"]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "hpy happyview create")).toBe(true);
  });

  it("locked_refuses_a_lock_that_no_longer_matches", async () => {
    const s = await stack();
    writeFileSync(
      join(s.project, "happyview.toml"),
      `[happyview]\nversion = "${VERSION}"\n[interpreters]\n` +
        `lua = { did = "${HV_DID}", name = "happyview-lua", channel = "latest" }\n`,
    );
    const r = await s.hpy(["hv", "check", "--locked"]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "interpreter `lua` is not in the lock")).toBe(true);
    expect(read(join(s.project, "happyview.lock"))).not.toContain("lua");
  });

  it.skipIf(!unix)("dev_runs_happyview_dev_in_the_project", async () => {
    const s = await stack();
    expect((await s.hpy(["hv", "dev"])).code).toBe(0);
    expect(s.readLog().trim()).toBe("dev .");
    expect(read(`${s.log}.cwd`).trim()).toBe(realpathSync(s.project));
  });

  // HappyView's dev server writes the types; hpy points editors at them before starting it.
  it.skipIf(!unix)("dev_points_editors_at_the_types", async () => {
    const s = await stack();
    luaProject(s);
    const r = await s.hpy(["hv", "dev"]);
    expect(r.code).toBe(0);
    expect(says(r.stderr, "wrote .luarc.json, which points editors at .happyview/types/lua")).toBe(
      true,
    );
    expect(s.readLog().trim()).toBe("dev .");
  });

  it.skipIf(!unix)("dev_passes_the_childs_exit_code_through", async () => {
    const s = await stack();
    expect((await s.hpy(["hv", "dev"], { HV_EXIT: "6" })).code).toBe(6);
  });

  it.skipIf(!unix)("dev_does_not_hand_the_binary_a_plugin_dir", async () => {
    const s = await stack();
    expect((await s.hpy(["hv", "dev"], { PLUGIN_DIR: "/elsewhere" })).code).toBe(0);
    expect(s.readLog()).not.toContain("PLUGIN_DIR");
  });

  it.skipIf(!unix)("dev_receives_sigterm_and_exits_with_the_childs_code", async () => {
    const s = await stack();
    const child = start(s, ["hv", "dev"], { HV_MODE: "trap" });
    const binary = await awaitBinary(s, child);
    // Without modules there is nothing for `hpy` to do alongside the binary.
    if (binary !== child.pid) {
      process.kill(binary, "SIGKILL");
      killGroup(child);
      throw new Error("hpy did not become the binary");
    }
    process.kill(child.pid as number, "SIGTERM");
    expect(await waitExit(child)).toBe(7);
    expect(read(`${s.log}.term`)).toBe("got\n");
  });

  it.skipIf(!unix)("dev_with_modules_passes_the_childs_exit_code_through", async () => {
    const s = await stack();
    const { env } = declareModule(s);
    expect((await s.hpy(["hv", "dev"], { ...env, HV_EXIT: "3" })).code).toBe(3);
    expect(s.readLog().trim()).toBe("dev .");
  });

  it.skipIf(!unix)("dev_with_modules_reports_a_signal_death_as_a_shell_does", async () => {
    const s = await stack();
    const { env } = declareModule(s);
    // A `hpy` that had become the binary would itself die by the signal and have no exit code.
    expect((await s.hpy(["hv", "dev"], { ...env, HV_MODE: "die" })).code).toBe(128 + 9);
  });

  it.skipIf(!unix)(
    "dev_with_modules_forwards_one_sigterm_and_exits_with_the_childs_code",
    async () => {
      const s = await stack();
      const { env } = declareModule(s);
      const running = await Running.start(s, ["hv", "dev"], env);
      running.signal("SIGTERM");
      expect(await running.settleAndQuit(s)).toBe(7);
      expect(signalsReceived(s)).toBe("TERM\n");
    },
  );

  it.skipIf(!unix)("dev_with_modules_forwards_a_sighup_once", async () => {
    const s = await stack();
    const { env } = declareModule(s);
    const running = await Running.start(s, ["hv", "dev"], env);
    running.signal("SIGHUP");
    expect(await running.settleAndQuit(s)).toBe(0);
    expect(signalsReceived(s)).toBe("HUP\n");
  });

  it.skipIf(!unix)("ctrl_c_reaches_the_binary_once_through_the_terminals_group", async () => {
    const s = await stack();
    const { env } = declareModule(s);
    const running = await Running.start(s, ["hv", "dev"], env);
    running.signalGroup("SIGINT");
    // `hpy` outlived the Ctrl-C, and reports the binary's own exit.
    expect(await running.settleAndQuit(s)).toBe(0);
    expect(signalsReceived(s)).toBe("INT\n");
  });

  it.skipIf(!unix)(
    "ctrl_backslash_reaches_the_binary_once_through_the_terminals_group",
    async () => {
      const s = await stack();
      const { env } = declareModule(s);
      const running = await Running.start(s, ["hv", "dev"], env);
      running.signalGroup("SIGQUIT");
      expect(await running.settleAndQuit(s)).toBe(0);
      expect(signalsReceived(s)).toBe("QUIT\n");
    },
  );

  // Rust has Linux kill the binary through PR_SET_PDEATHSIG when hpy is SIGKILLed; Node cannot
  // ask for that, so this is a known gap (see src/project/run.ts) and the test stays todo.
  it.todo("a_killed_hpy_takes_the_binary_with_it");
  void linux;

  it.skipIf(!unix)("a_failed_module_build_shows_cargos_own_diagnostics", async () => {
    const s = await stack();
    const { env } = declareModule(s);
    const cargo = join(s.project, "cargo-broken");
    writeFileSync(
      cargo,
      '#!/bin/sh\nif [ "$1" = --version ]; then exit 0; fi\n' +
        "echo 'error[E0425]: cannot find value `answr` in this scope' >&2\nexit 101\n",
    );
    chmodSync(cargo, 0o755);
    const r = await s.hpy(["hv", "build"], { ...env, HPY_CARGO: cargo });
    expect(r.code).toBe(1);
    expect(says(r.stderr, "error[E0425]: cannot find value `answr` in this scope")).toBe(true);
    expect(says(r.stderr, "'registry' failed to build")).toBe(true);
  });

  it.skipIf(!unix)("dev_rebuilds_a_module_when_its_source_changes", async () => {
    const s = await stack();
    const { env, dest } = declareModule(s);
    const running = await Running.start(s, ["hv", "dev"], env);
    expect(read(dest)).toBe("\0asm-1");
    await editAndAwaitRebuild(s, dest, "\0asm-2");
    expect(await running.settleAndQuit(s)).toBe(0);
  });

  it.skipIf(!unix)("test_watch_rebuilds_a_module_when_its_source_changes", async () => {
    const s = await stack();
    const { env, dest } = declareModule(s);
    const running = await Running.start(s, ["hv", "test", "--watch"], env);
    expect(read(dest)).toBe("\0asm-1");
    await editAndAwaitRebuild(s, dest, "\0asm-2");
    expect(await running.settleAndQuit(s)).toBe(0);
    expect(s.readLog().trim()).toBe("test . --watch");
  });

  it.skipIf(!unix)("a_loose_cache_directory_the_user_named_is_refused_not_changed", async () => {
    const s = await stack();
    chmodSync(s.cache, 0o755);
    const r = await s.hpy(["hv", "check"]);
    expect(r.code).toBe(1);
    expect(says(r.stderr, "chmod 700")).toBe(true);
    expect(statSync(s.cache).mode & 0o777).toBe(0o755);
    expect(readdirSync(s.cache)).toHaveLength(0);
  });

  it("a_subnet_is_refused_off_the_local_network_and_when_it_is_not_one", async () => {
    const s = await stack();
    const dir = tempdir();
    let r = await s.hpyIn(dir, ["hv", "dev", "--subnet", "10.40.0.0/24"]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "--subnet applies only to --network local")).toBe(true);
    r = await s.hpyIn(dir, ["hv", "dev", "--network", "local", "--subnet", "10.40.0.1/24"]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "did you mean 10.40.0.0/24?")).toBe(true);
  });

  it("reset_needs_the_local_network", async () => {
    const s = await stack();
    const r = await s.hpy(["hv", "dev", "--reset"]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "--network")).toBe(true);
  });
});
