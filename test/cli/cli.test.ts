// crates/hpy/tests/cli.rs, against the built binary. Tests for commands not
// ported yet are `it.todo` with the Rust test's name, so the ledger stays whole.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportedCredential } from "../support/credential.ts";
import { Home, hpy, hpyCommand, hpyEnv } from "../support/hpy.ts";
import { MockServer } from "../support/mock-server.ts";

let home: Home;
beforeEach(() => {
  home = new Home();
});
afterEach(() => home.dispose());

describe("tests/cli.rs", () => {
  it("help_lists_groups", async () => {
    expect((await hpy(home, ["--help"])).stdout).toContain("registry");
    const reg = await hpy(home, ["registry", "--help"]);
    expect(reg.code).toBe(0);
    for (const w of ["login", "whoami", "plugin"]) expect(reg.stdout).toContain(w);
    const plugin = await hpy(home, ["registry", "plugin", "--help"]);
    expect(plugin.stdout).toContain("publish");
    expect(plugin.stdout).toContain("init");
  });

  it("whoami_when_logged_out_exits_3", async () => {
    const r = await hpy(home, ["registry", "whoami"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("hpy registry login");
  });

  it("whoami_reads_an_exported_credential", async () => {
    const r = await hpy(home, ["registry", "whoami", "--json"], {
      env: { HPY_CREDENTIAL: await exportedCredential("did:plc:ci") },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"did": "did:plc:ci"');
    expect(r.stdout).toContain("environment");
  });

  it("whoami_reads_the_file_without_the_keychain", async () => {
    mkdirSync(join(home.config, "hpy"), { recursive: true });
    writeFileSync(
      join(home.config, "hpy/credentials.json"),
      '{"v":1,"registry":"https://api.happyproto.at","client_key":"hvc_test","did":"did:plc:abc","handle":"alice.test","pds":"https://pds.test","scopes":"atproto","access_token":"t","dpop_key":{"keychain":true}}',
    );
    const r = await hpy(home, ["registry", "whoami"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("@alice.test");
  });

  it("corrupt_credentials_mean_log_in_again_and_logout_cleans_up", async () => {
    mkdirSync(join(home.config, "hpy"), { recursive: true });
    writeFileSync(join(home.config, "hpy/credentials.json"), "{garbage");
    const r = await hpy(home, ["registry", "whoami"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("hpy registry login");
    expect((await hpy(home, ["registry", "logout"])).code).toBe(0);
    expect(existsSync(join(home.config, "hpy/credentials.json"))).toBe(false);
  });

  it("login_offers_export_and_no_app_passwords", async () => {
    const r = await hpy(home, ["registry", "login", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--export");
    expect(r.stdout).not.toContain("app-password");
  });

  it("login_without_tty_needs_identifier", async () => {
    const r = await hpy(home, ["registry", "login", "--no-input"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("<IDENTIFIER>");
  });

  it("logout_when_logged_out_is_fine", async () => {
    expect((await hpy(home, ["registry", "logout"])).code).toBe(0);
  });

  it("profile_init_without_tty_names_missing_flag", async () => {
    const plugin = mkdtempSync(join(tmpdir(), "hpy-plugin-"));
    try {
      writeFileSync(join(plugin, "manifest.json"), '{"id":"my-plugin","name":"Mine"}');
      const r = await hpy(home, [
        "registry",
        "plugin",
        "init",
        "--no-input",
        "--local-only",
        "-C",
        plugin,
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--author");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("profile_init_local_only_from_flags_writes_hpy_toml", async () => {
    const plugin = mkdtempSync(join(tmpdir(), "hpy-plugin-"));
    try {
      writeFileSync(
        join(plugin, "manifest.json"),
        '{"id":"my-plugin","name":"Mine","plugin_type":"library"}',
      );
      const r = await hpy(home, [
        "registry",
        "plugin",
        "init",
        "--no-input",
        "--local-only",
        "--author",
        "Ada <ada@x.io>",
        "--security",
        "sec@x.io",
        "-C",
        plugin,
      ]);
      expect(r.code, r.stderr).toBe(0);
      const text = readFileSync(join(plugin, "hpy.toml"), "utf8");
      expect(text).toContain("[project]");
      expect(text).toContain('display_name = "Mine"');
      expect(text).toContain("Ada");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("withdraw_and_retry_are_unknown_subcommands", async () => {
    for (const gone of ["withdraw", "retry"]) {
      const r = await hpy(home, ["registry", "plugin", gone, "1.0.0"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unrecognized subcommand");
    }
  });

  it("publish_validation_errors_exit_2_before_login", async () => {
    const plugin = mkdtempSync(join(tmpdir(), "hpy-plugin-"));
    try {
      writeFileSync(
        join(plugin, "manifest.json"),
        '{"id":"p","version":"1.0.0+meta","api_version":"2","plugin_type":"library","namespace":"p","capabilities":[]}',
      );
      writeFileSync(join(plugin, "p.wasm"), Buffer.from("\0asm\x01\0\0\0", "latin1"));
      const r = await hpy(home, [
        "registry",
        "plugin",
        "publish",
        "--no-input",
        "--wasm",
        join(plugin, "p.wasm"),
        "-C",
        plugin,
      ]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("build metadata");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("logging_out_an_already_revoked_ci_credential_is_fine", async () => {
    const server = await MockServer.start();
    try {
      server.given("DELETE", "*", { status: 401, json: { error: "session not found" } });
      const credential = await exportedCredential("did:plc:ci", server.url, null);
      const r = await hpy(home, ["registry", "logout"], { env: { HPY_CREDENTIAL: credential } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("already");
    } finally {
      await server.stop();
    }
  });

  it("registry_commands_are_not_top_level", async () => {
    for (const gone of ["login", "logout", "whoami", "plugin"]) {
      const r = await hpy(home, [gone]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unrecognized subcommand");
    }
  });

  it("listing_commands_sit_directly_under_plugin", async () => {
    expect((await hpy(home, ["registry", "plugin", "profile", "--help"])).code).toBe(2);
    for (const cmd of ["init", "show", "edit", "pull"])
      expect((await hpy(home, ["registry", "plugin", cmd, "--help"])).code).toBe(0);
  });

  it("channel_defaults_to_the_installed_versions", async () => {
    const version = (await hpy(home, ["--version"])).stdout.trim().replace(/^hpy /, "");
    const pre = version.split("-")[1];
    const expected = pre !== undefined ? pre.split(".")[0] : "stable";
    const r = await hpy(home, ["--json", "channel"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`"channel": "${expected}"`);
    expect(r.stdout).toContain('"chosen": false');
  });

  it("choosing_the_channel_already_followed_records_it_without_the_network", async () => {
    const shown = await hpy(home, ["--json", "channel"]);
    const current = (JSON.parse(shown.stdout) as { channel: string }).channel;
    const r = await hpy(home, ["channel", current]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Already on");
    const after = await hpy(home, ["--json", "channel"]);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain('"chosen": true');
  });

  it("an_unknown_channel_is_a_usage_error", async () => {
    const r = await hpy(home, ["channel", "nightly"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("stable, beta or alpha");
  });
});

describe.skipIf(process.platform === "win32")("tests/cli.rs happyview_build", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function script(dir: string, name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  }

  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "hpy-build-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "happyview.toml"),
      '[modules.registry]\nlanguage = "rust"\npath = "modules/registry"\n',
    );
    mkdirSync(join(dir, "modules/registry"), { recursive: true });
    writeFileSync(
      join(dir, "modules/registry/Cargo.toml"),
      '[package]\nname = "registry"\n[profile.release]\npanic = "abort"\n',
    );
    writeFileSync(join(dir, "built.wasm"), "\0asm");
    return dir;
  }

  function cargo(dir: string): string {
    return script(
      dir,
      "cargo",
      `if [ "$1" = --version ]; then exit 0; fi\n` +
        `manifest=''; while [ $# -gt 0 ]; do [ "$1" = --manifest-path ] && manifest="$2"; shift; done\n` +
        `printf '{"reason":"compiler-artifact","manifest_path":"%s","target":{"crate_types":["cdylib"]},"filenames":["${join(dir, "built.wasm")}"]}\\n' "$manifest"`,
    );
  }

  function failingCargo(dir: string): string {
    return script(
      dir,
      "cargo",
      `if [ "$1" = --version ]; then exit 0; fi\necho 'error: could not compile' >&2; exit 101`,
    );
  }

  const run = (p: string, cmd: string, cargoPath: string, target = "wasm32-wasip1") =>
    hpy(home, ["-C", p, "happyview", cmd], {
      env: { HPY_CARGO: cargoPath, HPY_RUSTUP: script(p, "rustup", `echo ${target}`) },
    });

  it("build_writes_each_module_to_the_build_directory", async () => {
    const p = project();
    const r = await run(p, "build", cargo(p));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("registry");
    expect(existsSync(join(p, ".happyview/build/registry.wasm"))).toBe(true);
  });

  it("build_without_the_target_exits_2_with_the_install_command", async () => {
    const p = project();
    const r = await run(p, "build", cargo(p), "aarch64-apple-darwin");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("rustup target add wasm32-wasip1");
  });

  it("build_refuses_a_module_that_unwinds", async () => {
    const p = project();
    writeFileSync(join(p, "modules/registry/Cargo.toml"), '[package]\nname = "registry"\n');
    const r = await run(p, "build", cargo(p));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("'registry'");
    expect(r.stderr).toContain('panic = "abort"');
    expect(existsSync(join(p, ".happyview/build/registry.wasm"))).toBe(false);
  });

  it("check_builds_modules_before_anything_else", async () => {
    const p = project();
    const r = await run(p, "check", failingCargo(p));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("'registry' failed to build");
  });

  it("test_builds_modules_before_anything_else", async () => {
    const p = project();
    const r = await run(p, "test", failingCargo(p));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("'registry' failed to build");
  });
});

// TS-only: a spawned hpy reaches the keychain through test/support/keyring-fake.mjs, under the
// CLI's own `hpy` service, and never the OS keychain. A Bun binary has the addon built in.
describe.skipIf(!!process.env.HPY_TEST_BIN)("the keychain a spawned hpy sees", () => {
  it("is_the_test_stand_in", async () => {
    const did = "did:plc:abc";
    const jwk = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../fixtures/credentials/credentials.file.json"),
        "utf8",
      ),
    ).dpop_key;
    mkdirSync(join(home.config, "hpy"), { recursive: true });
    // Nothing listens on port 9, so the logout's revoke fails fast and is ignored.
    writeFileSync(
      join(home.config, "hpy/credentials.json"),
      JSON.stringify({
        v: 1,
        registry: "http://127.0.0.1:9",
        client_key: "hvc_test",
        did,
        pds: "https://pds.test",
        scopes: "atproto",
        access_token: "t",
        dpop_key: { keychain: true },
      }),
    );
    const items = join(home.dir, "test-keychain.json");
    const item = `hpy/127.0.0.1:9/${did}`;
    writeFileSync(items, JSON.stringify({ [item]: JSON.stringify(jwk) }));
    const r = await hpy(home, ["registry", "logout"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Logged out ${did}`);
    expect(JSON.parse(readFileSync(items, "utf8"))).toEqual({});
  });
});

// Not a Rust test: Rust ignores SIGPIPE and its `println!` panics; Node's default is a stack
// trace from an unhandled `error` event.
describe("a reader that has gone away", () => {
  for (const args of [["--version"], ["--help"], ["channel", "--json"]]) {
    it(`ends_${args.join("_").replace(/-/g, "")}_quietly`, async () => {
      const [program, lead] = hpyCommand();
      const child = spawn(program, [...lead, ...args], {
        env: hpyEnv(home),
        cwd: home.dir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Closed before hpy has started, so its first write meets a closed pipe.
      child.stdout.destroy();
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      const code = await new Promise<number | null>((r) => child.once("close", (c) => r(c)));
      expect(stderr).toBe("");
      expect(code).toBe(0);
    });
  }
});
