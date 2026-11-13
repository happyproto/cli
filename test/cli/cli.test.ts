// crates/hpy/tests/cli.rs, against the built binary. Tests for commands not
// ported yet are `it.todo` with the Rust test's name, so the ledger stays whole.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportedCredential } from "../support/credential.ts";
import { Home, hpy } from "../support/hpy.ts";
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

  it.todo("profile_init_without_tty_names_missing_flag");
  it.todo("profile_init_local_only_from_flags_writes_hpy_toml");

  it("withdraw_and_retry_are_unknown_subcommands", async () => {
    for (const gone of ["withdraw", "retry"]) {
      const r = await hpy(home, ["registry", "plugin", gone, "1.0.0"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unrecognized subcommand");
    }
  });

  it.todo("publish_validation_errors_exit_2_before_login");

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
