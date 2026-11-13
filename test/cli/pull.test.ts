// crates/hpy/tests/happyview.rs `mod pull`: `hpy hv pull` against a fake instance, a fake
// registry and a fake HappyView release.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTable, type TomlTable, type TomlValue } from "../../src/core/toml.ts";
import {
  HV_DID,
  mountRegistry,
  Plugin,
  Stack,
  says,
  target,
  VERSION,
} from "../support/hv-stack.ts";
import { header, MockServer, type Recorded } from "../support/mock-server.ts";

const KEY = "hv_0123456789abcdef0123456789abcdef";
const OFFICIAL = "did:plc:mo7vq4jbioxwafy5zkcc3eux";
const windows = process.platform === "win32";

let stacks: Stack[] = [];
let instances: MockServer[] = [];
afterEach(async () => {
  for (const i of instances) {
    i.verify();
    await i.stop();
  }
  for (const s of stacks) await s.dispose();
  stacks = [];
  instances = [];
});
const newStack = async () => {
  const s = await Stack.start();
  stacks.push(s);
  return s;
};
const newInstance = async () => {
  const i = await MockServer.start();
  instances.push(i);
  return i;
};

const read = (p: string) => readFileSync(p, "utf8");

function lexicon(id: string, ty: string) {
  const main =
    ty === "record"
      ? { type: "record", key: "tid", record: { type: "object", properties: {} } }
      : ty === "procedure"
        ? { type: "procedure" }
        : { type: "query" };
  return { lexicon: 1, id, defs: { main } };
}

/** A row of v3's `GET /admin/lexicons`. */
function v3Lexicon(id: string, ty: string, layer: string, backfill: boolean, indexed: boolean) {
  return {
    id,
    revision: 1,
    lexicon_type: ty,
    backfill,
    source: layer,
    layer,
    path: layer === "project" ? `src/lexicons/${id.replaceAll(".", "/")}.json` : null,
    shadows_stored: false,
    declared: layer === "network",
    authority_did: null,
    last_fetched_at: null,
    created_at: null,
    updated_at: null,
    token_cost: null,
    indexed,
  };
}

/** A row of v3's `GET /admin/scripts`. */
function v3Script(
  id: string,
  language: string,
  layer: string,
  body: string,
  description: string | null,
) {
  return {
    id,
    script_type: language,
    body,
    description,
    outbound_xrpcs: null as unknown,
    created_at: null,
    updated_at: null,
    layer,
    path: null as unknown,
    shadows_stored: false,
    recreatable: true,
    needs_migration: [],
    runnable: true,
  };
}

/** A v3 plugin installed from the fake registry. */
function v3Plugin(id: string, ty: string, namespace: string | null, secrets: string[]) {
  return {
    id,
    name: id,
    version: "1.4.2",
    description: null,
    icon_url: null,
    banner_url: null,
    source: "registry",
    url: null,
    sha256: null,
    enabled: true,
    auth_type: "none",
    required_secrets: secrets.map((k) => ({ key: k, name: k, description: null })),
    secrets_configured: secrets.length === 0,
    loaded_at: null,
    update_available: false,
    pending_releases: [],
    registry: {
      did: HV_DID,
      name: id,
      channel: "latest",
      version_uri: `at://${HV_DID}/software.release.version/${id}.1.4.2`,
      installed_state: "active",
      installed_reason: null,
      channel_state: "active",
      unresolved: false,
    } as unknown,
    plugin_type: ty,
    namespace,
    dependencies: [],
    allowed_hosts: [],
    capabilities: { declared: [] },
  };
}

const serve = (i: MockServer, at: string, body: unknown, status = 200) =>
  i.given("GET", at, { status, json: body });

/** Fails the test if pull ever asks for a plugin's secrets. */
const forbidSecrets = (i: MockServer) =>
  i.given("*", /^\/admin\/plugins\/[^/]+\/secrets$/, { status: 500 }).expect(0);

function lexicons(i: MockServer, rows: [Record<string, unknown>, unknown][]) {
  serve(
    i,
    "/admin/lexicons",
    rows.map(([row]) => row),
  );
  for (const [row, doc] of rows)
    serve(i, `/admin/lexicons/${row.id}`, { ...row, lexicon_json: doc });
}

const tsInterpreter = () => {
  const ts = Plugin.interpreter("happyview-ts", "typescript", "\0asm ts");
  ts.fields.fileExtensions = ["ts"];
  return ts;
};
const libraryWithSecret = () => Plugin.library("happyview-db", "happyview.db", "\0asm db");

/** A v3 instance with one of everything a project holds; `first` mounts ahead of the rest. */
async function v3(stack: Stack, settingsAllowed: boolean, first?: (i: MockServer) => void) {
  mountRegistry(stack, [
    Plugin.interpreter("happyview-lua", "lua", "\0asm lua"),
    tsInterpreter(),
    libraryWithSecret(),
  ]);
  const i = await newInstance();
  forbidSecrets(i);
  first?.(i);
  serve(i, "/config", { version: VERSION, cli_client_key: "hvc_hpy" });
  lexicons(i, [
    [
      v3Lexicon("com.example.listPosts", "query", "project", false, true),
      lexicon("com.example.listPosts", "query"),
    ],
    [
      v3Lexicon("com.example.createPost", "procedure", "manual", false, true),
      lexicon("com.example.createPost", "procedure"),
    ],
    [
      v3Lexicon("com.example.post", "record", "manual", true, false),
      lexicon("com.example.post", "record"),
    ],
    [
      v3Lexicon("com.example.getThing", "query", "manual", false, true),
      lexicon("com.example.getThing", "query"),
    ],
    [
      v3Lexicon("com.other.feed", "record", "network", false, true),
      lexicon("com.other.feed", "record"),
    ],
  ]);
  serve(i, "/admin/network-lexicons", [
    {
      nsid: "com.other.feed",
      authority_did: "did:plc:other",
      last_fetched_at: null,
      created_at: "2026-01-01T00:00:00Z",
      declared: true,
      indexed: true,
    },
  ]);
  const listed = v3Script(
    "xrpc.query:com.example.listPosts",
    "lua",
    "project",
    '-- Lists posts.\nfunction handle(input, ctx)\n  return xrpc.query("com.other.get")\nend\n',
    "Lists posts.",
  );
  listed.path = "src/lexicons/com/example/listPosts.lua";
  listed.outbound_xrpcs = ["com.other.get"];
  serve(i, "/admin/scripts", [
    listed,
    v3Script(
      "xrpc.procedure:com.example.createPost",
      "typescript",
      "manual",
      "export function handle(input, ctx) {\n  return {};\n}\n",
      "Creates a post",
    ),
    v3Script("record.create:com.example.post", "lua", "manual", "function handle() end\n", null),
    v3Script("job.run:nightly", "lua", "manual", "function handle() end\n", null),
    v3Script("labeler.apply:_actor", "lua", "manual", "function handle() end\n", null),
  ]);
  serve(i, "/admin/script-variables", [
    {
      key: "API_TOKEN",
      preview: "••••••••",
      unreadable: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
  const handMade = v3Plugin("hand-made", "library", "hand.made", []);
  handMade.source = "url";
  handMade.registry = null;
  serve(i, "/admin/plugins", {
    plugins: [
      v3Plugin("happyview-lua", "interpreter", null, []),
      v3Plugin("happyview-ts", "interpreter", null, []),
      v3Plugin("happyview-db", "library", "happyview.db", ["DB_URL"]),
      handMade,
    ],
    encryption_configured: true,
  });
  if (settingsAllowed)
    serve(i, "/admin/settings", [
      { key: "app_name", value: "My App", source: "database" },
      { key: "logo_uri", value: "https://x/logo.png", source: "database" },
    ]);
  else
    serve(
      i,
      "/admin/settings",
      { error: "Forbidden", message: "Missing permission: settings:manage" },
      403,
    );
  serve(i, "/admin/users", [
    {
      id: "1",
      did: "did:plc:member",
      is_super: false,
      permissions: [],
      created_at: "x",
      last_used_at: null,
    },
    {
      id: "2",
      did: "did:plc:super",
      is_super: true,
      permissions: [],
      created_at: "x",
      last_used_at: null,
    },
  ]);
  serve(i, "/admin/labelers", [
    {
      declared: false,
      did: "did:plc:labeler",
      status: "active",
      cursor: null,
      created_at: "x",
      updated_at: "x",
    },
    {
      declared: false,
      did: "did:plc:paused",
      status: "paused",
      cursor: null,
      created_at: "x",
      updated_at: "x",
    },
  ]);
  serve(i, "/admin/project", { error: "NoProject" }, 404);
  return i;
}

const pull = (
  stack: Stack,
  i: MockServer,
  extra: string[] = [],
  env: Record<string, string> = {},
) =>
  stack.hpy(["hv", "pull", "pulled", ...extra], { HPY_HV_URL: i.url, HPY_HV_API_KEY: KEY, ...env });

function plain(v: TomlValue | TomlTable): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
  if (v.type === "array") return v.value.map(plain);
  if (v.type === "table") return plain(v.value as TomlTable);
  return v.value;
}
// biome-ignore lint/suspicious/noExplicitAny: a parsed TOML document, read by key.
const tomlOf = (dir: string): any => plain(parseTable(read(join(dir, "happyview.toml"))));

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.filter((p) => !p.startsWith(".happyview")).sort();
}

describe.skipIf(windows)("tests/happyview.rs pull", () => {
  it("pulls_a_v3_instance_into_a_project_that_checks", async () => {
    const stack = await newStack();
    const i = await v3(stack, true);
    const r = await pull(stack, i, [], { HV_EXIT: "0" });
    expect(r.code, r.stderr).toBe(0);
    expect(says(r.stderr, "plugin `hand-made` was installed from a url")).toBe(true);
    expect(r.stdout).toContain("happyview-db: DB_URL");
    expect(r.stdout).toContain("Script variables, in .env.example without their values: API_TOKEN");
    const dir = join(stack.project, "pulled");
    const files = tree(dir);
    for (const want of [
      ".env.example",
      ".gitignore",
      "happyview.lock",
      "happyview.toml",
      "src/jobs/nightly.lua",
      "src/labels/_actor.lua",
      "src/lexicons/com/example/createPost.json",
      "src/lexicons/com/example/createPost.ts",
      "src/lexicons/com/example/getThing.json",
      "src/lexicons/com/example/listPosts.json",
      "src/lexicons/com/example/listPosts.lua",
      "src/lexicons/com/example/post.create.lua",
      "src/lexicons/com/example/post.json",
    ])
      expect(files, want).toContain(want);
    // A network lexicon is named, not copied.
    expect(files.some((f) => f.includes("com/other"))).toBe(false);
    expect(read(join(dir, "src/lexicons/com/example/createPost.ts"))).toBe(
      "export function handle(input, ctx) {\n  return {};\n}\n",
    );
    expect(JSON.parse(read(join(dir, "src/lexicons/com/example/post.json")))).toEqual(
      lexicon("com.example.post", "record"),
    );
    const t = tomlOf(dir);
    expect(t.happyview.version).toBe(VERSION);
    expect(t.instance.app_name).toBe("My App");
    expect(t.instance.superadmin).toBe("did:plc:super");
    expect(t.interpreters.lua.name).toBe("happyview-lua");
    expect(t.interpreters.lua.channel).toBe("latest");
    expect(t.interpreters.typescript.did).toBe(HV_DID);
    expect(t.libraries["happyview.db"].name).toBe("happyview-db");
    expect(t.libraries["hand.made"]).toBeUndefined();
    expect(t.network_lexicons.include).toEqual(["com.other.feed"]);
    expect(t.labels.subscribe).toEqual(["did:plc:labeler"]);
    // Only what differs from a project lexicon's defaults.
    expect(Object.keys(t.lexicons)).toEqual(["com.example.post"]);
    expect(t.lexicons["com.example.post"].backfill).toBe(true);
    expect(t.lexicons["com.example.post"].indexed).toBe(false);
    // A description the leading comment already gives, and calls the body already makes, are not repeated.
    expect(Object.keys(t.scripts)).toEqual(["xrpc.procedure:com.example.createPost"]);
    expect(t.scripts["xrpc.procedure:com.example.createPost"].description).toBe("Creates a post");
    expect(t.jetstream).toBeUndefined();
    const env = read(join(dir, ".env.example"));
    expect(env).toContain("\nAPI_TOKEN=\n");
    expect(env).not.toContain("••");
    const lock = read(join(dir, "happyview.lock"));
    for (const id of ["happyview-lua", "happyview-ts", "happyview-db"])
      expect(lock).toContain(`id = "${id}"`);
    // Pull ends with the same check `hpy hv check` runs.
    expect(stack.readLog().trim()).toBe("check .");
    expect(i.requests.every((q: Recorded) => !q.path.includes("secrets"))).toBe(true);
  });

  it("a_module_handler_is_declared_and_its_missing_crate_fails_the_check", async () => {
    const stack = await newStack();
    const i = await v3(stack, true, (m) =>
      serve(m, "/admin/scripts", [
        {
          id: "xrpc.query:com.example.getThing",
          script_type: "rust",
          body: "",
          description: null,
          outbound_xrpcs: null,
          created_at: null,
          updated_at: null,
          layer: "project",
          path: "modules/scoring",
          shadows_stored: false,
          recreatable: true,
          needs_migration: [],
          runnable: true,
          module: {
            module: "scoring",
            path: "modules/scoring",
            handler: "get_thing",
            hash: "ab12",
          },
        },
      ]),
    );
    const r = await pull(stack, i, [], { HV_EXIT: "0" });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain(
      "scoring (modules/scoring, `get_thing` handles xrpc.query:com.example.getThing)",
    );
    expect(r.stderr).toContain("was written");
    const dir = join(stack.project, "pulled");
    const t = tomlOf(dir);
    expect(t.modules.scoring.language).toBe("rust");
    expect(t.modules.scoring.path).toBe("modules/scoring");
    // A module handler has no body to write.
    expect(tree(dir).some((f) => f.includes("getThing.") && !f.endsWith(".json"))).toBe(false);
  });

  const moduleSource = (at: string, language: string, src: string) => ({
    id: at,
    path: at,
    language,
    source: src,
  });

  it("an_interpreter_module_is_written_to_its_path", async () => {
    const stack = await newStack();
    const i = await v3(stack, true);
    const src = "local M = {}\nfunction M.title(s) return s end\nreturn M\n";
    serve(i, "/admin/scripts/modules", [moduleSource("src/lib/format.lua", "lua", src)]);
    const r = await pull(stack, i, [], { HV_EXIT: "0" });
    expect(r.code, r.stderr).toBe(0);
    expect(read(join(stack.project, "pulled/src/lib/format.lua"))).toBe(src);
    expect(r.stdout).toContain("1 interpreter modules");
    expect(r.stderr).not.toContain("interpreter module source");
  });

  it("a_module_path_outside_src_is_left_out_with_a_warning", async () => {
    const stack = await newStack();
    const i = await v3(stack, true);
    serve(i, "/admin/scripts/modules", [
      moduleSource("src/../../escaped.lua", "lua", "return 'out'\n"),
      moduleSource("/etc/escaped.lua", "lua", "return 'abs'\n"),
      moduleSource("lib/escaped.lua", "lua", "return 'root'\n"),
    ]);
    const r = await pull(stack, i, [], { HV_EXIT: "0" });
    expect(r.code, r.stderr).toBe(0);
    for (const p of ["src/../../escaped.lua", "/etc/escaped.lua", "lib/escaped.lua"])
      expect(r.stderr).toContain(
        `module ${p} has a path that isn't under src/ ("${p}"), so it is left out`,
      );
    const dir = join(stack.project, "pulled");
    expect(tree(dir).some((f) => f.includes("escaped"))).toBe(false);
    expect(existsSync(join(stack.project, "escaped.lua"))).toBe(false);
  });

  it("an_instance_without_the_module_route_warns_and_still_pulls", async () => {
    const stack = await newStack();
    const i = await v3(stack, true);
    serve(
      i,
      "/admin/scripts/modules",
      { error: "NotFound", message: "script not found: modules" },
      404,
    );
    const r = await pull(stack, i, [], { HV_EXIT: "0" });
    expect(r.code, r.stderr).toBe(0);
    expect(
      says(
        r.stderr,
        "this HappyView doesn't serve interpreter module source, so files scripts import (such as src/lib/…) aren't pulled; copy them in by hand",
      ),
    ).toBe(true);
    expect(tree(join(stack.project, "pulled")).some((f) => f.startsWith("src/lib"))).toBe(false);
  });

  it("a_sign_in_without_scripts_read_for_modules_warns", async () => {
    const stack = await newStack();
    const i = await v3(stack, true);
    serve(
      i,
      "/admin/scripts/modules",
      { error: "Forbidden", message: "Missing permission: scripts:read" },
      403,
    );
    const r = await pull(stack, i, [], { HV_EXIT: "0" });
    expect(r.code, r.stderr).toBe(0);
    expect(
      says(r.stderr, "the sign-in can't read interpreter module source (that needs scripts:read)"),
    ).toBe(true);
  });

  it("a_key_without_settings_manage_skips_the_app_name_and_a_failed_check_still_writes", async () => {
    const stack = await newStack();
    const i = await v3(stack, false);
    const r = await pull(stack, i, [], { HV_EXIT: "3" });
    expect(r.code).toBe(3);
    expect(says(r.stderr, "that needs settings:manage")).toBe(true);
    expect(says(r.stderr, "was written")).toBe(true);
    const t = tomlOf(join(stack.project, "pulled"));
    expect(t.instance.app_name).toBeUndefined();
    expect(t.instance.superadmin).toBe("did:plc:super");
    expect(stack.readLog().trim()).toBe("check .");
  });

  it("an_existing_project_is_refused", async () => {
    const stack = await newStack();
    const i = await v3(stack, true);
    const dir = join(stack.project, "pulled");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "happyview.toml"), "mine\n");
    const r = await pull(stack, i);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "is already a project; use --diff")).toBe(true);
    expect(read(join(dir, "happyview.toml"))).toBe("mine\n");
    expect(tree(dir)).toEqual(["happyview.toml"]);
  });

  it("diff_prints_what_differs_and_writes_nothing", async () => {
    const stack = await newStack();
    const i = await v3(stack, true);
    const dir = join(stack.project, "pulled");
    mkdirSync(join(dir, "src/jobs"), { recursive: true });
    writeFileSync(join(dir, "happyview.toml"), '[happyview]\nversion = "0.0.1"\n');
    writeFileSync(join(dir, "src/jobs/nightly.lua"), "-- mine\n");
    writeFileSync(join(dir, "src/jobs/nightly.test.lua"), "-- a test\n");
    const before = tree(dir);
    const r = await pull(stack, i, ["--diff"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("--- a/src/jobs/nightly.lua\n+++ b/src/jobs/nightly.lua");
    expect(r.stdout).toContain("--- /dev/null\n+++ b/src/lexicons/com/example/post.json");
    expect(r.stdout).toContain('-version = "0.0.1"');
    expect(r.stdout).not.toContain("nightly.test.lua");
    expect(tree(dir)).toEqual(before);
    expect(read(join(dir, "src/jobs/nightly.lua"))).toBe("-- mine\n");
    // Nothing to check: nothing was written.
    expect(stack.readLog()).toBe("");
  });

  it("a_v2_instance_needs_legacy", async () => {
    const stack = await newStack();
    const i = await newInstance();
    serve(i, "/config", { version: "2.17.0" });
    const r = await pull(stack, i);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "is a v2 instance (HappyView 2.17.0); add --legacy")).toBe(true);
    expect(existsSync(join(stack.project, "pulled"))).toBe(false);
  });

  /**
   * Stands in for `happyview-codemod`: logs its arguments, prefixes the script with what it was
   * asked, adds a `happyview.db` require, and leaves a marker in a job.
   */
  const FAKE_CODEMOD = `#!/bin/sh
echo "$*" >> "$CODEMOD_LOG"
kind=""
while [ $# -gt 0 ]; do
  [ "$1" = "--kind" ] && kind="$2"
  shift
done
echo "-- v3 $kind"
echo 'local db = require("happyview.db")'
cat
if [ "$kind" = job ]; then
  echo "-- codemod: ctx.job has no v3 equivalent"
  echo "ctx.job has no v3 equivalent" >&2
  exit 2
fi
`;

  const v2Lexicon = (id: string, ty: string, tgt: string | null) => ({
    id,
    revision: 1,
    lexicon_json: lexicon(id, ty),
    lexicon_type: ty,
    backfill: true,
    action: ty === "procedure" ? "upsert" : null,
    target_collection: tgt,
    source: "manual",
    authority_did: null,
    last_fetched_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    token_cost: null,
  });

  const v2Script = (id: string, body: string, description: string | null) => ({
    id,
    script_type: "lua",
    body,
    description,
    outbound_xrpcs: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    recreatable: true,
  });

  const v2Plugin = (id: string, secrets: string[]) => ({
    id,
    name: id,
    version: "0.3.0",
    source: "url",
    url: `https://plugins.example/${id}.wasm`,
    sha256: null,
    enabled: true,
    auth_type: "oauth2",
    required_secrets: secrets.map((k) => ({ key: k, name: k, description: null })),
    secrets_configured: false,
    loaded_at: null,
    update_available: false,
    latest_version: null,
    pending_releases: [],
  });

  async function v2(stack: Stack): Promise<MockServer> {
    const steam = Plugin.library("steam", "steam", "\0asm steam");
    const steamVersion = steam.versionJson();
    mountRegistry(
      stack,
      [Plugin.interpreter("happyview-lua", "lua", "\0asm lua"), libraryWithSecret(), steam],
      (s) => {
        // The official project of a v2 plugin, on its beta channel.
        s.given(
          "GET",
          "/xrpc/at.happyproto.registry.resolveChannel",
          { json: steamVersion },
          (r) => r.query.get("name") === "steam" && r.query.get("channel") === "beta",
        );
      },
    );
    stack.server.given("GET", "/repos/gamesgamesgamesgamesgames/happyview/releases", {
      json: [
        {
          tag_name: `v${VERSION}`,
          draft: false,
          assets: [{ name: `happyview-${target()}.tar.xz` }],
        },
      ],
    });
    const i = await newInstance();
    forbidSecrets(i);
    serve(i, "/config", { version: "2.17.0" });
    // Every admin read needs the key, as a bearer token.
    const authed = (at: string, body: unknown) =>
      i.given("GET", at, { json: body }, header("authorization", `Bearer ${KEY}`));
    const lexs = [
      v2Lexicon("com.example.listPosts", "query", "com.example.post"),
      v2Lexicon("com.example.post", "record", null),
    ];
    authed("/admin/lexicons", lexs);
    for (const l of lexs) authed(`/admin/lexicons/${l.id}`, l);
    authed("/admin/network-lexicons", []);
    authed("/admin/scripts", [
      v2Script(
        "xrpc.query:com.example.listPosts",
        "return db.query({collection = collection})\n",
        "Lists posts",
      ),
      v2Script("record.create:com.example.post", "log(record.uri)\n", null),
      v2Script("job.run:cleanup", "local j = ctx.job\n", null),
      v2Script("labeler.apply:com.example.post", "return {}\n", null),
    ]);
    authed("/admin/script-variables", [
      {
        key: "WEBHOOK_SECRET",
        preview: "••••••••",
        unreadable: false,
        created_at: "x",
        updated_at: "x",
      },
    ]);
    authed("/admin/plugins", {
      plugins: [v2Plugin("steam", ["STEAM_API_KEY"]), v2Plugin("homebrew-thing", [])],
      encryption_configured: true,
    });
    authed("/admin/settings", [{ key: "app_name", value: "Old App", source: "database" }]);
    authed("/admin/users", [
      {
        id: "1",
        did: "did:plc:super",
        is_super: true,
        permissions: [],
        created_at: "x",
        last_used_at: null,
      },
    ]);
    authed("/admin/labelers", []);
    i.given("*", /^\/admin\//, { status: 401, json: { error: "Unauthorized" } });
    return i;
  }

  function codemod(stack: Stack): [string, string] {
    const bin = join(stack.cache, "fake-codemod");
    writeFileSync(bin, FAKE_CODEMOD);
    chmodSync(bin, 0o755);
    return [bin, join(stack.project, "codemod.log")];
  }

  it("legacy_pulls_a_v2_instance_through_the_codemod", async () => {
    const stack = await newStack();
    const i = await v2(stack);
    const [bin, log] = codemod(stack);
    const r = await stack.hpy(["hv", "pull", "--legacy", "--url", i.url, "pulled"], {
      HAPPYVIEW_API_KEY: KEY,
      HPY_HAPPYVIEW_CODEMOD: bin,
      CODEMOD_LOG: log,
      HV_EXIT: "0",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(says(r.stderr, "v2 plugin `homebrew-thing` has no official registry project")).toBe(
      true,
    );
    expect(r.stdout).toContain("src/jobs/cleanup.lua: the codemod left `-- codemod:` markers");
    expect(r.stdout).toContain("steam: STEAM_API_KEY");
    const calls = read(log);
    for (const want of [
      "--stdin --kind query --collection com.example.post\n",
      "--stdin --kind record\n",
      "--stdin --kind job\n",
      "--stdin --kind label\n",
    ])
      expect(calls).toContain(want);
    const dir = join(stack.project, "pulled");
    expect(read(join(dir, "src/lexicons/com/example/listPosts.lua"))).toBe(
      '-- v3 query\nlocal db = require("happyview.db")\nreturn db.query({collection = collection})\n',
    );
    expect(read(join(dir, "src/jobs/cleanup.lua"))).toContain("-- codemod: ctx.job");
    expect(existsSync(join(dir, "src/lexicons/com/example/post.create.lua"))).toBe(true);
    expect(existsSync(join(dir, "src/labels/com.example.post.lua"))).toBe(true);
    const t = tomlOf(dir);
    expect(t.happyview.version).toBe(VERSION);
    expect(t.instance.app_name).toBe("Old App");
    expect(Object.keys(t.interpreters)).toEqual(["lua"]);
    expect(t.libraries["happyview.db"].name).toBe("happyview-db");
    expect(t.libraries.steam.did).toBe(OFFICIAL);
    expect(t.libraries.steam.channel).toBe("beta");
    expect(t.libraries["homebrew-thing"]).toBeUndefined();
    // Backfill means something only for a record lexicon; v2 sets it on every one.
    expect(Object.keys(t.lexicons)).toEqual(["com.example.post"]);
    expect(t.lexicons["com.example.post"].backfill).toBe(true);
    expect(t.scripts["xrpc.query:com.example.listPosts"].description).toBe("Lists posts");
    const text = read(join(dir, "happyview.toml"));
    expect(text.includes("target_collection") || text.includes("action")).toBe(false);
    expect(read(join(dir, ".env.example"))).toContain("\nWEBHOOK_SECRET=\n");
    // The key is read, never written.
    for (const f of tree(dir)) expect(read(join(dir, f)), f).not.toContain(KEY);
    expect(stack.readLog().trim()).toBe("check .");
  });

  it("legacy_without_a_key_or_a_terminal_says_where_to_put_one", async () => {
    const stack = await newStack();
    const i = await v2(stack);
    const r = await stack.hpy([
      "hv",
      "pull",
      "--legacy",
      "--url",
      i.url,
      "--api-key-env",
      "MY_V2_KEY",
    ]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "from MY_V2_KEY")).toBe(true);
  });
});
