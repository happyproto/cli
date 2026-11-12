// hpy-atproto/src/admin.rs tests, against MockServer.
import { inspect } from "node:util";
import { afterEach, expect, it } from "vitest";
import { Admin, deployEmpty } from "../../src/atproto/admin.ts";
import type { Credential } from "../../src/atproto/credential.ts";
import { DpopKey } from "../../src/atproto/dpop.ts";
import type { AtprotoError } from "../../src/atproto/error.ts";
import { header, MockServer, query, type Recorded } from "../support/mock-server.ts";

const KEY = "hv_0123456789abcdef0123456789abcdef";

let servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.verify();
    await s.stop();
  }
  servers = [];
});
const start = async () => {
  const s = await MockServer.start();
  servers.push(s);
  return s;
};
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected an error");
    },
    (e: AtprotoError) => e,
  );
const bodyJson =
  (v: unknown) =>
  (r: Recorded): boolean => {
    try {
      return JSON.stringify(r.json()) === JSON.stringify(v);
    } catch {
      return false;
    }
  };
const cred = async (s: MockServer, token = "t"): Promise<Credential> => ({
  registry: s.url,
  clientKey: "hvc_hpy",
  did: "did:plc:me",
  handle: null,
  pds: "https://pds.test",
  scopes: "atproto",
  accessToken: token,
  dpopKey: await DpopKey.generate(),
});

function plugin(id: string, versionUri: string | null) {
  return {
    id,
    name: id,
    version: "1.0.0",
    source: "registry",
    enabled: true,
    plugin_type: "interpreter",
    registry:
      versionUri === null
        ? null
        : {
            did: "did:plc:pub",
            name: id,
            channel: null,
            version_uri: versionUri,
            unresolved: false,
          },
    capabilities: {},
  };
}

it("lists_plugins_with_the_key_as_a_bearer_token", async () => {
  const s = await start();
  s.given(
    "GET",
    "/admin/plugins",
    {
      json: {
        plugins: [plugin("lua", "at://did:plc:pub/v/1"), plugin("hand-made", null)],
        encryption_configured: true,
      },
    },
    header("authorization", `Bearer ${KEY}`),
  );
  const plugins = await Admin.withKey(s.url, KEY).plugins();
  expect(plugins.length).toBe(2);
  expect(plugins[0]?.id).toBe("lua");
  expect(plugins[0]?.plugin_type).toBe("interpreter");
  expect(plugins[0]?.registry?.did).toBe("did:plc:pub");
  expect(plugins[0]?.registry?.version_uri).toBe("at://did:plc:pub/v/1");
  expect(plugins[1]?.registry).toBeNull();
});

it("a_refused_key_says_how_to_sign_in_again", async () => {
  const s = await start();
  s.given("GET", "*", { status: 401, json: { error: "Unauthorized" } });
  const err = await fails(Admin.withKey(s.url, KEY).plugins());
  expect(err.isAuth()).toBe(true);
  expect(err.message).toContain("hpy hv login --url");
  expect(err.message).toContain(s.url);
});

it("an_expired_session_says_to_sign_in_again", async () => {
  const s = await start();
  s.given("GET", "*", { status: 401, json: { error: "Unauthorized" } });
  const err = await fails(Admin.withSession(await cred(s)).project());
  expect(err.isAuth()).toBe(true);
  expect(err.message).toContain("expired");
  expect(err.message).toContain(`hpy hv login --url ${s.url}`);
  expect(err.message).not.toContain("API key");
});

it("a_reached_limit_says_the_hosts_words_and_its_action", async () => {
  const s = await start();
  s.given("POST", "*", {
    status: 403,
    json: {
      error: "LimitReached",
      limit: "seats",
      max: 1,
      current: 1,
      message: "Your plan includes 1 seat.",
      actionUrl: "https://host.example/billing",
      actionLabel: "Add a seat",
    },
  });
  const text = (
    await fails(Admin.withKey(s.url, KEY).install("did:plc:x", "happyview-example", "1.0.0", []))
  ).message;
  expect(text).toContain("Your plan includes 1 seat.");
  expect(text).toContain("Add a seat: https://host.example/billing");
  expect(text, "a limit is not a missing permission").not.toContain("permission");
});

it("a_reached_limit_without_wording_or_with_a_bad_action_still_reads", async () => {
  const s = await start();
  s.given("GET", "*", {
    status: 403,
    json: {
      error: "LimitReached",
      limit: "api_clients",
      actionUrl: "javascript:alert(1)",
      actionLabel: "Upgrade",
    },
  });
  const text = (await fails(Admin.withKey(s.url, KEY).plugins())).message;
  expect(text).toContain("the instance's limits don't allow it");
  expect(text).not.toContain("javascript");
  expect(text).not.toContain("permission");
});

it("a_missing_permission_is_named", async () => {
  const s = await start();
  s.given("GET", "*", {
    status: 403,
    json: { error: "InsufficientPermissions", message: "Missing permission: plugins:read" },
  });
  const text = (await fails(Admin.withKey(s.url, KEY).plugins())).message;
  expect(text).toContain("plugins:read");
  expect(text).toContain("API key");
});

it("a_session_missing_a_permission_is_told_to_ask_the_owner", async () => {
  const s = await start();
  s.given("GET", "*", {
    status: 403,
    json: { error: "InsufficientPermissions", message: "Missing permission: plugins:read" },
  });
  const text = (await fails(Admin.withSession(await cred(s)).plugins())).message;
  expect(text).toContain("plugins:read");
  expect(text).toContain("owner");
  expect(text).not.toContain("API key");
});

it("an_account_that_is_not_an_admin_is_told_so", async () => {
  const s = await start();
  s.given("GET", "*", { status: 403, json: { error: "not a user" } });
  expect((await fails(Admin.withKey(s.url, KEY).project())).message).toContain("isn't an admin");
});

it("a_session_of_another_client_says_to_sign_in_again", async () => {
  const s = await start();
  s.given("GET", "*", {
    status: 403,
    json: { error: "Forbidden", message: "an API client's session cannot use the admin API" },
  });
  const err = await fails(Admin.withKey(s.url, KEY).project());
  expect(err.isAuth()).toBe(true);
  expect(err.message).toContain("hpy hv login --url");
});

it("a_sign_in_without_the_admin_grant_says_to_approve_it", async () => {
  const s = await start();
  s.given("GET", "*", {
    status: 403,
    json: {
      error: "Forbidden",
      message:
        "this sign-in did not grant dev.happyview.adminFull; sign in again and approve managing your HappyView instances",
    },
  });
  const err = await fails(Admin.withKey(s.url, KEY).project());
  expect(err.isAuth()).toBe(true);
  expect(err.message).toContain("hpy hv login --url");
  expect(err.message).toContain("approve");
});

it("installs_a_registry_version", async () => {
  const s = await start();
  s.given(
    "POST",
    "/admin/plugins",
    { json: plugin("lua", "at://x") },
    bodyJson({
      accepted_capabilities: ["library:call", "wasi:clock"],
      registry: { did: "did:plc:pub", name: "lua", version: "1.2.0" },
    }),
  ).expect(1);
  const installed = await Admin.withKey(s.url, KEY).install("did:plc:pub", "lua", "1.2.0", [
    "library:call",
    "wasi:clock",
  ]);
  expect(installed.id).toBe("lua");
});

it("installs_a_version_that_declares_no_capabilities", async () => {
  const s = await start();
  s.given(
    "POST",
    "/admin/plugins",
    { json: plugin("plain", "at://x") },
    bodyJson({
      accepted_capabilities: [],
      registry: { did: "did:plc:pub", name: "plain", version: "1.0.0" },
    }),
  ).expect(1);
  await Admin.withKey(s.url, KEY).install("did:plc:pub", "plain", "1.0.0", []);
});

it("moves_an_installed_plugin_to_a_version", async () => {
  const s = await start();
  s.given(
    "POST",
    "/admin/plugins/lua/reload",
    { json: plugin("lua", "at://x") },
    bodyJson({ accepted_capabilities: ["kv:read"], registry: { version: "1.3.0" } }),
  ).expect(1);
  await Admin.withKey(s.url, KEY).reload("lua", "1.3.0", ["kv:read"]);
});

it("removing_a_plugin_others_need_names_them", async () => {
  const s = await start();
  s.given("DELETE", "/admin/plugins/std", {
    status: 409,
    json: { error: "plugin has dependents", dependents: ["lua"] },
  });
  const text = (await fails(Admin.withKey(s.url, KEY).remove("std"))).message;
  expect(text).toContain("std");
  expect(text).toContain("lua");
});

it("removes_a_plugin", async () => {
  const s = await start();
  s.given("DELETE", "/admin/plugins/old", { status: 204 }).expect(1);
  await Admin.withKey(s.url, KEY).remove("old");
});

const deployAnswer = (dryRun: boolean) => ({
  sha256: "abc",
  dry_run: dryRun,
  deployed_at: dryRun ? null : "2026-10-28T20:00:00Z",
  changes: {
    lexicons: { added: ["com.example.hello"], changed: [], removed: [] },
    scripts: { added: ["xrpc.query:com.example.hello"], changed: [], removed: [] },
    modules: { added: [], changed: [], removed: [] },
  },
  backfills: ["com.example.post"],
  warnings: [{ path: "happyview.toml", message: "[jetstream] is ignored" }],
});

it("no_deployed_project_is_none", async () => {
  const s = await start();
  s.given("GET", "/admin/project", { status: 404, json: { error: "NoProject" } });
  expect(await Admin.withKey(s.url, KEY).project()).toBeNull();
});

it("the_deployed_project_carries_its_boot_problems", async () => {
  const s = await start();
  s.given("GET", "/admin/project", {
    json: {
      sha256: "abc",
      deployed_at: "2026-10-28T20:00:00Z",
      deployed_by: "did:plc:me",
      error: { problems: [{ path: "src/x.ts", message: "no interpreter claims .ts" }] },
    },
  });
  const deployed = await Admin.withKey(s.url, KEY).project();
  expect(deployed?.sha256).toBe("abc");
  expect(deployed?.problems.length).toBe(1);
  expect(deployed?.problems[0]?.path).toBe("src/x.ts");
});

it("deploys_a_bundle_as_gzip_with_the_version_it_saw", async () => {
  const s = await start();
  s.given(
    "PUT",
    "/admin/project",
    { json: deployAnswer(true) },
    query("dry_run", "true"),
    header("content-type", "application/gzip"),
    header("if-match", '"old"'),
    header("authorization", `Bearer ${KEY}`),
    (r) => r.body.toString() === "bundle",
  ).expect(1);
  const out = await Admin.withKey(s.url, KEY).deployProject(Buffer.from("bundle"), true, "old");
  expect(out.dry_run).toBe(true);
  expect(out.changes.lexicons?.added).toEqual(["com.example.hello"]);
  expect(out.backfills).toEqual(["com.example.post"]);
  expect(out.warnings[0]?.message).toBe("[jetstream] is ignored");
  expect(deployEmpty(out)).toBe(false);
});

it("a_first_deploy_sends_no_if_match", async () => {
  const s = await start();
  s.given(
    "PUT",
    "/admin/project",
    (r) => {
      expect(r.headers["if-match"]).toBeUndefined();
      return { json: deployAnswer(false) };
    },
    query("dry_run", "false"),
  ).expect(1);
  await Admin.withKey(s.url, KEY).deployProject(Buffer.from("bundle"), false, null);
});

it("an_invalid_project_lists_its_problems_as_a_usage_error", async () => {
  const s = await start();
  s.given("PUT", "*", {
    status: 422,
    json: {
      error: "InvalidProject",
      message: "the project has 2 problems",
      problems: [
        { path: "src/lexicons/com/example/hello.json", message: "id does not match the path" },
        { path: "happyview.toml", line: 7, message: "unknown table [scirpts]" },
        { path: "", message: "the archive expands past 200 MB" },
      ],
    },
  });
  const err = await fails(Admin.withKey(s.url, KEY).deployProject(Buffer.from("x"), true, null));
  expect(err.isUsage()).toBe(true);
  expect(err.message).toContain("src/lexicons/com/example/hello.json: id does not match the path");
  expect(err.message).toContain("happyview.toml:7: unknown table [scirpts]");
  expect(err.message).toContain("  • the archive expands past 200 MB");
});

it("refusals_of_a_deploy_say_what_to_do", async () => {
  for (const [status, json, says] of [
    [412, { error: "PreconditionFailed" }, "changed since"],
    [409, { error: "ProjectFromFile" }, "HAPPYVIEW_PROJECT"],
    [413, { error: "PayloadTooLarge" }, "too large"],
  ] as const) {
    const s = await start();
    s.given("PUT", "*", { status, json });
    const text = (
      await fails(Admin.withKey(s.url, KEY).deployProject(Buffer.from("x"), false, "a"))
    ).message;
    expect(text, String(status)).toContain(says);
  }
});

it("an_unreachable_instance_is_named", async () => {
  const text = (await fails(Admin.withKey("http://127.0.0.1:9", KEY).plugins())).message;
  expect(text).toContain("127.0.0.1:9");
});

it("a_signed_in_session_sends_a_dpop_proof_for_each_request", async () => {
  const s = await start();
  s.given(
    "PUT",
    "/admin/project",
    { json: deployAnswer(true) },
    header("authorization", "DPoP session-token"),
    header("x-client-key", "hvc_hpy"),
  ).expect(1);
  await Admin.withSession(await cred(s, "session-token")).deployProject(
    Buffer.from("x"),
    true,
    null,
  );
  const proof = (s.requests[0] as Recorded).headers.dpop as string;
  const claims = JSON.parse(Buffer.from(proof.split(".")[1] as string, "base64url").toString());
  expect(claims.htm).toBe("PUT");
  // HappyView checks htu against the path, without the query.
  expect(claims.htu).toBe(`${s.url}/admin/project`);
  expect(typeof claims.ath).toBe("string");
});

it("a_read_without_its_permission_can_be_done_without", async () => {
  const s = await start();
  s.given("GET", "/admin/settings", {
    status: 403,
    json: { error: "Forbidden", message: "Missing permission: settings:manage" },
  });
  s.given("GET", "/admin/users", { json: [{ did: "did:plc:a" }] });
  const admin = Admin.withKey(s.url, KEY);
  expect(await admin.getIfPermitted("reading settings", "/settings")).toBeNull();
  expect(await admin.get("listing users", "/users")).toEqual([{ did: "did:plc:a" }]);
  expect((await fails(admin.get("reading settings", "/settings"))).message).toContain(
    "settings:manage",
  );
});

it("the_key_never_appears_in_debug_output", () => {
  const admin = Admin.withKey("https://api.example.com", KEY);
  expect(inspect(admin)).not.toContain(KEY);
  expect(String(admin)).not.toContain(KEY);
});
