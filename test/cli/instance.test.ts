// crates/hpy/tests/instance.rs, against the built binary: `hpy hv login`,
// `logout` and `whoami` against a stand-in for an instance's admin API. The
// deploy and env push tests are `it.todo` until M3 ports those commands.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Home, hpy } from "../support/hpy.ts";
import { header, MockServer } from "../support/mock-server.ts";

const KEY = "hv_0123456789abcdef0123456789abcdef";

let home: Home;
let server: MockServer | undefined;
beforeEach(() => {
  home = new Home();
});
afterEach(async () => {
  home.dispose();
  server?.verify();
  await server?.stop();
  server = undefined;
});

const plugins = (list: unknown[]) => ({ plugins: list, encryption_configured: true });

/** An instance that lists no plugins for KEY and refuses any other. */
async function instance(): Promise<MockServer> {
  server = await MockServer.start();
  server.given(
    "GET",
    "/admin/plugins",
    { json: plugins([]) },
    header("authorization", `Bearer ${KEY}`),
  );
  server.given("GET", "/admin/plugins", { status: 401, json: { error: "Unauthorized" } });
  return server;
}

async function login(url: string): Promise<void> {
  const r = await hpy(home, ["hv", "login", "--url", url, "--key-stdin"], { input: `${KEY}\n` });
  expect(r.code, r.stderr).toBe(0);
}

describe("tests/instance.rs", () => {
  it("login_checks_the_key_and_whoami_shows_where_without_it", async () => {
    const s = await instance();
    const r = await hpy(home, ["hv", "login", "--url", s.url, "--key-stdin"], {
      input: `${KEY}\n`,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(s.url);
    expect(readFileSync(join(home.config, "hpy/instances.json"), "utf8")).toContain(s.url);
    const who = await hpy(home, ["hv", "whoami", "--json"]);
    expect(who.code).toBe(0);
    expect(who.stdout).toContain(s.url);
    expect(who.stdout).toContain("hv_01234");
    expect(who.stdout).not.toContain(KEY);
  });

  it("a_refused_key_is_not_saved", async () => {
    const s = await instance();
    const r = await hpy(home, ["hv", "login", "--url", s.url, "--key-stdin"], {
      input: "hv_ffffffffffffffffffffffffffffffff\n",
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("refused the API key");
    expect(existsSync(join(home.config, "hpy/instances.json"))).toBe(false);
  });

  it("login_without_a_terminal_needs_a_handle_or_a_key", async () => {
    const r = await hpy(home, ["hv", "login", "--url", "https://api.example.com"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("<IDENTIFIER>");
    // An API key is never taken as an argument.
    expect(
      (await hpy(home, ["hv", "login", "--url", "https://api.example.com", "--key", KEY])).code,
    ).toBe(2);
  });

  it("logout_forgets_the_instance", async () => {
    const s = await instance();
    await login(s.url);
    const out = await hpy(home, ["hv", "logout"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(s.url);
    const who = await hpy(home, ["hv", "whoami"]);
    expect(who.code).toBe(3);
    expect(who.stderr).toContain("hpy hv login --url");
  });

  // M3: deploy and env push.
  it.todo("a_dry_run_shows_the_plugin_changes_and_sends_none");
  it.todo("deploy_installs_dependencies_first_then_moves");
  it.todo("deploy_stops_at_the_first_refusal_and_says_what_was_done");
  it.todo("deploy_needs_the_lock_to_match");
  it.todo("deploy_refuses_a_lock_that_records_no_capabilities");
  it.todo("ci_signs_in_from_the_environment");
  it.todo("deploy_sends_the_version_it_compared_against");
  it.todo("an_unchanged_project_is_up_to_date_and_not_sent_again");
  it.todo("an_invalid_project_changes_nothing");
  it.todo("a_project_the_instance_could_not_boot_is_shown");
  it.todo("a_project_check_that_needs_pending_plugins_waits_for_them");
  it.todo("a_first_deploy_with_nothing_to_show_is_still_sent");
  it.todo("env_push_with_yes_sends_every_key");
  it.todo("env_push_without_a_terminal_or_yes_sends_nothing");
  it.todo("env_push_dry_run_labels_each_key_and_sends_nothing");
  it.todo("env_push_sends_only_the_keys_named");
  it.todo("env_push_refuses_a_bad_key_by_its_line");
  it.todo("env_push_reports_a_failed_key_and_exits_non_zero");
  it.todo("env_push_signed_out_is_refused_as_deploy_is");
});
