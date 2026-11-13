// crates/hpy/tests/instance.rs, against the built binary: `hpy hv login`,
// `logout` and `whoami`, `deploy` and `env push`, against a stand-in for an
// instance's admin API.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectUri, versionUri } from "../../src/plugin/validate.ts";
import { type LockedPlugin, Lockfile } from "../../src/project/lock.ts";
import { Home, hpy, hpyCommand, hpyEnv } from "../support/hpy.ts";
import { header, MockServer, query, type Recorded } from "../support/mock-server.ts";

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

const PUB = "did:plc:publisher";

const plugins = (list: unknown[]) => ({ plugins: list, encryption_configured: true });

function installed(id: string, version: string) {
  return {
    id,
    name: id,
    version,
    source: "registry",
    enabled: true,
    plugin_type: "interpreter",
    capabilities: {},
    registry: {
      did: PUB,
      name: id,
      channel: null,
      unresolved: false,
      version_uri: versionUri(PUB, id, version),
    },
  };
}

const bodyJson =
  (v: unknown) =>
  (r: Recorded): boolean => {
    try {
      return isDeepStrictEqual(r.json(), v);
    } catch {
      return false;
    }
  };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project whose lock holds `lua` 1.1.0 and `std` 2.0.0, which `lua` depends on. */
function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hpy-project-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "happyview.toml"),
    `[happyview]\nversion = "3.0.0"\n\n[interpreters]\nlua = { did = "${PUB}", name = "lua", version = "1.1.0" }\n\n[libraries]\nstd = { did = "${PUB}", name = "std", version = "2.0.0" }\n`,
  );
  const plugin = (
    id: string,
    kind: "interpreter" | "library",
    version: string,
    deps: string[],
  ): LockedPlugin => ({
    id,
    kind,
    keys: [id],
    project: projectUri(PUB, id),
    version,
    channel: undefined,
    version_uri: versionUri(PUB, id, version),
    manifest_cid: "bafyreimanifest",
    package_cid: "bafkreipackage",
    manifest_blob_cid: "bafkreimanifestblob",
    dependencies: deps,
    capabilities: ["kv:read"],
  });
  new Lockfile({
    version: 2,
    happyview: { version: "3.0.0" },
    plugins: [
      plugin("lua", "interpreter", "1.1.0", ["std"]),
      plugin("std", "library", "2.0.0", []),
    ],
  }).write(dir);
  return dir;
}

function projectAnswer(dryRun: boolean, lexiconsAdded: string[]) {
  return {
    sha256: "new",
    dry_run: dryRun,
    deployed_at: dryRun ? null : "2026-10-28T20:00:00Z",
    changes: {
      lexicons: { added: lexiconsAdded, changed: [], removed: [] },
      scripts: { added: [], changed: [], removed: [] },
    },
    backfills: [],
    warnings: [],
  };
}

/** The project endpoints: nothing deployed yet, and a bundle that adds `lexiconsAdded`. */
function mountProject(s: MockServer, lexiconsAdded: string[]): void {
  s.given("GET", "/admin/project", { status: 404, json: { error: "NoProject" } });
  for (const dryRun of [true, false])
    s.given(
      "PUT",
      "/admin/project",
      { json: projectAnswer(dryRun, lexiconsAdded) },
      query("dry_run", String(dryRun)),
    );
}

async function instanceWith(list: unknown[]): Promise<MockServer> {
  server = await MockServer.start();
  server.given("GET", "/admin/plugins", { json: plugins(list) });
  mountProject(server, ["com.example.hello"]);
  return server;
}

/** The project requests the instance received, in order, as `PUT dry_run=…`. */
const projectPuts = (s: MockServer) =>
  s.requests.filter((r) => r.method === "PUT").map((r) => `PUT ${r.query}`);

/** Distinctive, so finding it anywhere in the output is a leak. */
const SECRET = "sk-live-7Q9zX-never-shown-41d8";

/** An instance that has `B` already, and accepts every set; `first` mounts ahead of the defaults. */
async function variablesInstance(first?: (s: MockServer) => void): Promise<MockServer> {
  server = await MockServer.start();
  first?.(server);
  // What `hpy hv login --key-stdin` checks the key against.
  server.given("GET", "/admin/plugins", { json: plugins([]) });
  server.given("GET", "/admin/script-variables", {
    json: [
      {
        key: "B",
        preview: "****",
        unreadable: false,
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-01T00:00:00Z",
      },
    ],
  });
  server.given("POST", "/admin/script-variables", { status: 204 });
  return server;
}

/** A project whose `.env` holds `text`. */
function envProject(text: string): string {
  const dir = projectDir();
  writeFileSync(join(dir, ".env"), text);
  return dir;
}

const envText = () => `# keys for scripts\nA=${SECRET}\nB="second ${SECRET}"\n`;

/** The sets the instance received, as `[key, value]`. */
const sets = (s: MockServer) =>
  s.requests
    .filter((r) => r.method === "POST")
    .map((r) => {
      const b = r.json() as { key: string; value: string };
      return [b.key, b.value];
    });

/** Runs `hpy hv env push` with `args`, and checks the value appears nowhere in what it printed. */
async function push(project: string, args: string[]) {
  const r = await hpy(home, ["hv", "env", "push", ...args], { cwd: project });
  expect(r.stdout + r.stderr, "the value was printed").not.toContain(SECRET);
  return r;
}

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

  it("a_dry_run_shows_the_plugin_changes_and_sends_none", async () => {
    const project = projectDir();
    const s = await instanceWith([installed("lua", "1.0.0"), installed("old", "1.0.0")]);
    await login(s.url);
    s.given("POST", "*", { status: 500 }).expect(0);
    const r = await hpy(home, ["hv", "deploy", "--dry-run"], { cwd: project });
    expect(r.code, r.stderr).toBe(0);
    for (const want of [
      "install std 2.0.0",
      "move lua 1.0.0 → 1.1.0",
      "old",
      "--prune-plugins",
      "+ lexicon com.example.hello",
    ])
      expect(r.stderr).toContain(want);
    expect(projectPuts(s)).toEqual(["PUT dry_run=true"]);
  });

  it("deploy_installs_dependencies_first_then_moves", async () => {
    const project = projectDir();
    const s = await instanceWith([installed("lua", "1.0.0")]);
    await login(s.url);
    s.given(
      "POST",
      "/admin/plugins",
      { json: installed("std", "2.0.0") },
      bodyJson({
        registry: { did: PUB, name: "std", version: "2.0.0" },
        accepted_capabilities: ["kv:read"],
      }),
    ).expect(1);
    s.given(
      "POST",
      "/admin/plugins/lua/reload",
      { json: installed("lua", "1.1.0") },
      bodyJson({ registry: { version: "1.1.0" }, accepted_capabilities: ["kv:read"] }),
    ).expect(1);
    const r = await hpy(home, ["hv", "deploy", "--yes", "--json"], { cwd: project });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.instance).toBe(s.url);
    expect(out.plugins.applied).toEqual(["install std 2.0.0", "move lua 1.0.0 → 1.1.0"]);
    expect(
      s.requests.filter((q) => q.method !== "GET").map((q) => `${q.method} ${q.path}`),
    ).toEqual([
      "PUT /admin/project",
      "POST /admin/plugins",
      "POST /admin/plugins/lua/reload",
      "PUT /admin/project",
    ]);
    expect(projectPuts(s)).toEqual(["PUT dry_run=true", "PUT dry_run=false"]);
    expect(out.project.changes.lexicons.added).toEqual(["com.example.hello"]);
  });

  it("deploy_stops_at_the_first_refusal_and_says_what_was_done", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given(
      "POST",
      "/admin/plugins",
      { json: installed("std", "2.0.0") },
      bodyJson({
        registry: { did: PUB, name: "std", version: "2.0.0" },
        accepted_capabilities: ["kv:read"],
      }),
    );
    s.given(
      "POST",
      "/admin/plugins",
      {
        status: 400,
        json: { error: "NotInstallable", message: "lua 1.1.0 reached end of life" },
      },
      bodyJson({
        registry: { did: PUB, name: "lua", version: "1.1.0" },
        accepted_capabilities: ["kv:read"],
      }),
    );
    s.given("GET", "/admin/plugins", { json: plugins([]) });
    mountProject(s, ["com.example.hello"]);
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--yes"], { cwd: project });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("end of life");
    expect(r.stderr).toContain("install std 2.0.0");
  });

  it("deploy_needs_the_lock_to_match", async () => {
    const project = projectDir();
    rmSync(join(project, "happyview.lock"));
    const s = await instanceWith([]);
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--dry-run"], { cwd: project });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("happyview.lock");
  });

  it("deploy_refuses_a_lock_that_records_no_capabilities", async () => {
    const project = projectDir();
    const lock = join(project, "happyview.lock");
    const stripped = readFileSync(lock, "utf8")
      .split("\n")
      .filter((l, i, all) => !(i === all.length - 1 && l === ""))
      .filter((l) => !l.startsWith("capabilities"))
      .map((l) => `${l}\n`)
      .join("");
    writeFileSync(lock, stripped);
    const s = await instanceWith([]);
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--yes"], { cwd: project });
    expect(r.code).toBe(2);
    for (const want of ["lua", "std", "hpy happyview check"]) expect(r.stderr).toContain(want);
  });

  it("ci_signs_in_from_the_environment", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given(
      "GET",
      "/admin/plugins",
      { json: plugins([installed("lua", "1.1.0"), installed("std", "2.0.0")]) },
      header("authorization", `Bearer ${KEY}`),
    );
    mountProject(s, []);
    const r = await hpy(home, ["hv", "deploy", "--dry-run"], {
      cwd: project,
      env: { HPY_HV_URL: s.url, HPY_HV_API_KEY: KEY },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("up to date");
  });

  it("deploy_sends_the_version_it_compared_against", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given("GET", "/admin/plugins", {
      json: plugins([installed("lua", "1.1.0"), installed("std", "2.0.0")]),
    });
    s.given("GET", "/admin/project", {
      json: { sha256: "deployed", deployed_at: "2026-10-27T00:00:00Z", deployed_by: "did:plc:me" },
    });
    for (const dryRun of [true, false])
      s.given(
        "PUT",
        "/admin/project",
        { json: projectAnswer(dryRun, ["com.example.hello"]) },
        query("dry_run", String(dryRun)),
        header("if-match", '"deployed"'),
        header("content-type", "application/gzip"),
      ).expect(1);
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--yes"], { cwd: project });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Deployed");
  });

  it("an_unchanged_project_is_up_to_date_and_not_sent_again", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given("GET", "/admin/plugins", {
      json: plugins([installed("lua", "1.1.0"), installed("std", "2.0.0")]),
    });
    // The instance already serves this bundle (the stand-in answers its sha256 as `new`).
    s.given("GET", "/admin/project", { json: { sha256: "new" } });
    s.given("PUT", "/admin/project", { json: projectAnswer(true, []) }, query("dry_run", "true"));
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy"], { cwd: project });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("up to date");
    expect(projectPuts(s)).toEqual(["PUT dry_run=true"]);
  });

  it("an_invalid_project_changes_nothing", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given("GET", "/admin/plugins", {
      json: plugins([installed("lua", "1.1.0"), installed("std", "2.0.0")]),
    });
    s.given("GET", "/admin/project", { status: 404, json: { error: "NoProject" } });
    s.given("PUT", "*", {
      status: 422,
      json: {
        error: "InvalidProject",
        problems: [
          { path: "src/lexicons/com/example/hello.json", message: "id does not match the path" },
        ],
      },
    });
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--yes"], { cwd: project });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("src/lexicons/com/example/hello.json: id does not match the path");
    expect(projectPuts(s)).toEqual(["PUT dry_run=true"]);
  });

  it("a_project_the_instance_could_not_boot_is_shown", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given("GET", "/admin/plugins", {
      json: plugins([installed("lua", "1.1.0"), installed("std", "2.0.0")]),
    });
    s.given("GET", "/admin/project", {
      json: {
        sha256: "deployed",
        error: { problems: [{ path: "src/x.ts", message: "no interpreter claims .ts" }] },
      },
    });
    s.given("PUT", "*", { json: projectAnswer(true, []) });
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--dry-run"], { cwd: project });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("serving no project");
    expect(r.stderr).toContain("src/x.ts: no interpreter claims .ts");
  });

  it("a_project_check_that_needs_pending_plugins_waits_for_them", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given("GET", "/admin/plugins", { json: plugins([installed("std", "2.0.0")]) });
    s.given("GET", "/admin/project", { status: 404, json: { error: "NoProject" } });
    s.given(
      "PUT",
      "*",
      {
        status: 422,
        json: {
          error: "InvalidProject",
          problems: [
            { path: "src/lexicons/com/example/hello.lua", message: "no interpreter claims .lua" },
          ],
        },
      },
      query("dry_run", "true"),
    );
    s.given(
      "PUT",
      "*",
      { json: projectAnswer(false, ["com.example.hello"]) },
      query("dry_run", "false"),
    ).expect(1);
    s.given("POST", "/admin/plugins", { json: installed("lua", "1.1.0") }).expect(1);
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--yes"], { cwd: project });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("after the plugins");
  });

  it("a_first_deploy_with_nothing_to_show_is_still_sent", async () => {
    const project = projectDir();
    const s = await MockServer.start();
    server = s;
    s.given("GET", "/admin/plugins", {
      json: plugins([installed("lua", "1.1.0"), installed("std", "2.0.0")]),
    });
    mountProject(s, []);
    await login(s.url);
    const r = await hpy(home, ["hv", "deploy", "--yes"], { cwd: project });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Deployed");
    expect(projectPuts(s)).toEqual(["PUT dry_run=true", "PUT dry_run=false"]);
  });

  // `hpy hv env push`

  it("env_push_with_yes_sends_every_key", async () => {
    const project = envProject(envText());
    const s = await variablesInstance();
    await login(s.url);
    const r = await push(project, ["--yes"]);
    expect(r.code, r.stderr).toBe(0);
    for (const want of ["sent A", "sent B", s.url]) expect(r.stderr).toContain(want);
    expect(r.stdout).toContain("Sent 2 keys");
    expect(sets(s)).toEqual([
      ["A", SECRET],
      ["B", `second ${SECRET}`],
    ]);
    // And as JSON, still without a value.
    const j = await push(project, ["--yes", "--json"]);
    expect(j.code).toBe(0);
    expect(j.stdout).toContain('"sent": [');
    expect(j.stdout).toContain('"dryRun": false');
  });

  it("env_push_without_a_terminal_or_yes_sends_nothing", async () => {
    const project = envProject(envText());
    const s = await variablesInstance();
    await login(s.url);
    const before = s.requests.length;
    const r = await push(project, []);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("pass --yes");
    expect(r.stderr).toContain("Nothing was sent");
    expect(s.requests.length).toBe(before);
  });

  it("env_push_dry_run_labels_each_key_and_sends_nothing", async () => {
    const project = envProject(envText());
    const s = await variablesInstance();
    await login(s.url);
    const r = await push(project, ["--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("  new A\n");
    expect(r.stderr).toContain("  replaces existing B\n");
    expect(r.stdout).toContain("nothing was sent");
    expect(r.stderr.split("masked").length - 1).toBe(1);
    const j = await push(project, ["--dry-run", "--json"]);
    expect(j.code).toBe(0);
    expect(j.stdout).toContain('"status": "new"');
    expect(j.stdout).toContain('"status": "replace"');
    expect(sets(s)).toEqual([]);
  });

  it("env_push_sends_only_the_keys_named", async () => {
    const project = envProject(envText());
    const s = await variablesInstance();
    await login(s.url);
    const r = await push(project, ["B", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("sent B");
    expect(r.stderr).not.toContain("sent A");
    expect(sets(s)).toEqual([["B", `second ${SECRET}`]]);
    // A key the file doesn't set is refused, and nothing is sent.
    const m = await push(project, ["A", "MISSING", "--yes"]);
    expect(m.code).toBe(2);
    // The report wraps at the terminal width, and a long temp path (Windows) moves the break.
    expect(m.stderr.replace(/\s+│\s+/g, " ")).toContain("doesn't set MISSING, so nothing was sent");
    expect(sets(s).length).toBe(1);
  });

  it("env_push_refuses_a_bad_key_by_its_line", async () => {
    const project = envProject(`A=1\nMY-TOKEN=${SECRET}\n${SECRET}\n`);
    const s = await variablesInstance();
    await login(s.url);
    const before = s.requests.length;
    const r = await push(project, ["--yes"]);
    expect(r.code).toBe(2);
    // The report wraps at the terminal width, and a long temp path moves the breaks: compare
    // the words, not the layout.
    const words = r.stderr
      .replace(/[│×├└─╭╰]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    for (const wanted of [
      ".env:2: a key starts with a letter or _",
      ".env:3: expected KEY=VALUE",
      "nothing was sent",
    ])
      expect(words).toContain(wanted);
    expect(s.requests.length).toBe(before);
  });

  it("env_push_reports_a_failed_key_and_exits_non_zero", async () => {
    const project = envProject(envText());
    const s = await variablesInstance((m) =>
      m.given(
        "POST",
        "/admin/script-variables",
        {
          status: 500,
          json: {
            error: "InternalError",
            message: `failed to upsert script variable: ${SECRET}`,
          },
        },
        (q: Recorded) => (q.json() as { key: string }).key === "A",
      ),
    );
    await login(s.url);
    const r = await push(project, ["--yes"]);
    expect(r.code).toBe(1);
    for (const want of [
      "failed A: ",
      "failed to upsert script variable",
      "sent B",
      "1 key not sent: A",
    ])
      expect(r.stderr).toContain(want);
    expect(r.stdout).toContain("skipped 0, failed 1");
    const j = await push(project, ["--yes", "--json"]);
    expect(j.code).toBe(1);
    expect(j.stdout).toContain('"failed": [');
  });

  it("env_push_signed_out_is_refused_as_deploy_is", async () => {
    const project = envProject(envText());
    const deploy = await hpy(home, ["hv", "deploy", "--yes"], { cwd: project });
    expect(deploy.code).toBe(3);
    const pushed = await push(project, ["--yes"]);
    expect(pushed.code).toBe(3);
    expect(pushed.stderr).toBe(deploy.stderr);
    expect(pushed.stderr).toContain("hpy hv login");
  });
});

// Not a Rust test: a reader that falls behind gets all of a large output, on stdout and on
// stderr, and from the Bun binary too (HPY_TEST_BIN). Bun's `process.exit` once dropped what a
// slow pipe hadn't taken yet; this reads nothing for a second, then everything.
describe("a slow reader", () => {
  const KEYS = 30_000;
  const bigEnv = () => Array.from({ length: KEYS }, (_, i) => `KEY_${i}=value-${i}\n`).join("");

  async function slowly(project: string, args: string[]) {
    const [program, pre] = hpyCommand();
    const child = spawn(program, [...pre, ...args], {
      cwd: project,
      env: hpyEnv(home) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pause();
    child.stderr.pause();
    await new Promise((r) => setTimeout(r, 1_000));
    const take = (s: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      s.on("data", (c: Buffer) => chunks.push(c));
      return () => Buffer.concat(chunks).toString();
    };
    const out = take(child.stdout);
    const err = take(child.stderr);
    child.stdout.resume();
    child.stderr.resume();
    const code = await new Promise<number | null>((r) => child.on("close", r));
    return { code, stdout: out(), stderr: err() };
  }

  it("gets_all_of_a_large_output_on_stdout_and_stderr", async () => {
    const project = envProject(bigEnv());
    const s = await variablesInstance();
    await login(s.url);
    const json = await slowly(project, ["--json", "hv", "env", "push", "--dry-run"]);
    expect(json.code, json.stderr.slice(-500)).toBe(0);
    expect(json.stdout.length).toBeGreaterThan(1_000_000);
    expect(json.stdout).toContain(`KEY_${KEYS - 1}`);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    const text = await slowly(project, ["hv", "env", "push", "--dry-run"]);
    expect(text.code, text.stderr.slice(-500)).toBe(0);
    // Without --json the listing is status text, on stderr.
    expect(text.stderr.length).toBeGreaterThan(300_000);
    expect(text.stderr).toContain(`KEY_${KEYS - 1}`);
  }, 60_000);
});
