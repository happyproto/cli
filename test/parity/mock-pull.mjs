// The instances `hv pull` reads in the parity harness, under the shared mock:
//   $MOCK/pv3/…     a v3 instance with one of everything (as tests/happyview.rs's `v3`)
//   $MOCK/pv3nos/…  the same, but the sign-in may read neither settings nor module source
//   $MOCK/pv3mod/…  the same, serving interpreter modules (one outside src/) and a module handler
//   $MOCK/pvdev/…   the same, with a /config that names no version
//   $MOCK/pv2/…     a v2 instance (as tests/happyview.rs's `v2`), read with the key below
// and what they need beside them:
//   $MOCK/hvreg/…   the registry their plugins come from (HPY_REGISTRY_URL)
//   $MOCK/dl/…      HappyView releases (HPY_HAPPYVIEW_DOWNLOAD): a fake `happyview` that exits 0
//   $MOCK/gh/…      GitHub's releases API (HPY_GITHUB_API)
import { createHash } from "node:crypto";
import {
  FAKE_HAPPYVIEW,
  HV_DID,
  mountRegistryOn,
  Plugin,
  target,
  VERSION,
} from "../support/hv-stack.ts";
import { tarXz } from "../support/tar.ts";

const KEY = "hv_0123456789abcdef0123456789abcdef";

const lexicon = (id, ty) => ({
  lexicon: 1,
  id,
  defs: {
    main:
      ty === "record"
        ? { type: "record", key: "tid", record: { type: "object", properties: {} } }
        : {
            type: ty,
            parameters: {
              type: "params",
              properties: { limit: { type: "integer", minimum: 1.0 } },
            },
          },
  },
});

const v3Lexicon = (id, ty, layer, backfill, indexed) => ({
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
  token_cost: ty === "procedure" ? 3 : null,
  indexed,
});

const v3Script = (id, language, layer, body, description, extra = {}) => ({
  id,
  script_type: language,
  body,
  description,
  outbound_xrpcs: null,
  created_at: null,
  updated_at: null,
  layer,
  path: null,
  shadows_stored: false,
  recreatable: true,
  needs_migration: [],
  runnable: true,
  ...extra,
});

const v3Plugin = (id, ty, namespace, secrets, registry = true) => ({
  id,
  name: id,
  version: "1.4.2",
  source: registry ? "registry" : "url",
  required_secrets: secrets.map((k) => ({ key: k, name: k, description: null })),
  registry: registry
    ? {
        did: HV_DID,
        name: id,
        channel: "latest",
        version_uri: `at://${HV_DID}/software.release.version/${id}.1.4.2`,
      }
    : null,
  plugin_type: ty,
  namespace,
  capabilities: { declared: [] },
});

const lua = () => Plugin.interpreter("happyview-lua", "lua", "\0asm lua");
const ts = () => {
  const p = Plugin.interpreter("happyview-ts", "typescript", "\0asm ts");
  p.fields.fileExtensions = ["ts"];
  return p;
};
const db = () => Plugin.library("happyview-db", "happyview.db", "\0asm db");

function mountV3(s, mode) {
  const at = (path) => `/${mode}${path}`;
  const json = (path, body, status = 200) => s.given("GET", at(path), { status, json: body });
  s.given("*", new RegExp(`^/${mode}/admin/plugins/[^/]+/secrets$`), { status: 500 });
  json(
    "/config",
    mode === "pvdev"
      ? { cli_client_key: "hvc_hpy" }
      : { version: VERSION, cli_client_key: "hvc_hpy" },
  );
  const rows = [
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
    [v3Lexicon("bad..id", "query", "manual", false, true), lexicon("bad..id", "query")],
  ];
  json(
    "/admin/lexicons",
    rows.map(([r]) => r),
  );
  for (const [r, doc] of rows) json(`/admin/lexicons/${r.id}`, { ...r, lexicon_json: doc });
  json("/admin/network-lexicons", [{ nsid: "com.other.feed" }, { nsid: "com.other.like" }]);
  const scripts = [
    v3Script(
      "xrpc.query:com.example.listPosts",
      "lua",
      "project",
      '-- Lists posts.\nfunction handle(input, ctx)\n  return xrpc.query("com.other.get")\nend\n',
      "Lists posts.",
      { path: "src/lexicons/com/example/listPosts.lua", outbound_xrpcs: ["com.other.get"] },
    ),
    v3Script(
      "xrpc.procedure:com.example.createPost",
      "typescript",
      "manual",
      "export function handle(input, ctx) {\n  return {};\n}\n",
      "Creates a post",
      { outbound_xrpcs: ["com.other.put"] },
    ),
    v3Script("record.create:com.example.post", "lua", "manual", "function handle() end\n", null),
    v3Script("job.run:nightly", "lua", "manual", "function handle() end\n", null),
    v3Script("labeler.apply:_actor", "lua", "manual", "function handle() end\n", null),
    v3Script("xrpc.query:com.example.missing", "lua", "manual", "function handle() end\n", null),
    v3Script("hook.before:x", "lua", "manual", "", null),
    v3Script("job.run:py", "python", "manual", "print(1)\n", null),
  ];
  if (mode === "pv3mod")
    scripts.push(
      v3Script("xrpc.query:com.example.getThing", "rust", "project", "", null, {
        path: "modules/scoring",
        module: { module: "scoring", path: "modules/scoring", handler: "get_thing", hash: "ab12" },
      }),
      v3Script("job.run:escape", "rust", "project", "", null, {
        module: { module: "esc", path: "../outside", handler: "h" },
      }),
    );
  json("/admin/scripts", scripts);
  json("/admin/script-variables", [
    { key: "WEBHOOK", preview: "••••", unreadable: false },
    { key: "API_TOKEN", preview: "••••", unreadable: true },
  ]);
  json("/admin/plugins", {
    plugins: [
      v3Plugin("happyview-lua", "interpreter", null, []),
      v3Plugin("happyview-ts", "interpreter", null, []),
      v3Plugin("happyview-db", "library", "happyview.db", ["DB_URL", "DB_PASSWORD"]),
      v3Plugin("hand-made", "library", "hand.made", [], false),
      v3Plugin("passkeys", "auth", null, []),
    ],
  });
  if (mode === "pv3nos") {
    json(
      "/admin/settings",
      { error: "Forbidden", message: "Missing permission: settings:manage" },
      403,
    );
    json(
      "/admin/scripts/modules",
      { error: "Forbidden", message: "Missing permission: scripts:read" },
      403,
    );
  } else {
    json("/admin/settings", [
      { key: "app_name", value: "My App", source: "database" },
      { key: "logo_uri", value: "https://x/logo.png", source: "database" },
    ]);
  }
  if (mode === "pv3mod")
    json("/admin/scripts/modules", [
      { id: "src/lib/format.lua", path: "src/lib/format.lua", source: "local M = {}\nreturn M\n" },
      { id: "lib/escaped.lua", path: "lib/escaped.lua", source: "return 1\n" },
    ]);
  json("/admin/users", [
    { id: "1", did: "did:plc:member", is_super: false },
    { id: "2", did: "did:plc:super", is_super: true },
  ]);
  json("/admin/labelers", [
    { did: "did:plc:labeler", status: "active" },
    { did: "did:plc:paused", status: "paused" },
  ]);
  json("/admin/project", { error: "NoProject" }, 404);
}

function mountV2(s) {
  const authed = (path, body) =>
    s.given("GET", `/pv2${path}`, (r) =>
      r.headers.authorization === `Bearer ${KEY}`
        ? { json: body }
        : { status: 401, json: { error: "Unauthorized" } },
    );
  s.given("GET", "/pv2/config", { json: { version: "2.17.0" } });
  const lexicons = [
    {
      id: "com.example.listPosts",
      lexicon_json: lexicon("com.example.listPosts", "query"),
      lexicon_type: "query",
      backfill: true,
      target_collection: "com.example.post",
      source: "manual",
    },
    {
      id: "com.example.post",
      lexicon_json: lexicon("com.example.post", "record"),
      lexicon_type: "record",
      backfill: true,
      source: "manual",
    },
  ];
  authed("/admin/lexicons", lexicons);
  for (const l of lexicons) authed(`/admin/lexicons/${l.id}`, l);
  authed("/admin/network-lexicons", []);
  authed("/admin/scripts", [
    {
      id: "xrpc.query:com.example.listPosts",
      script_type: "lua",
      body: "return db.query({collection = collection})\n",
      description: "Lists posts",
    },
    { id: "record.create:com.example.post", script_type: "lua", body: "log(record.uri)\n" },
    { id: "job.run:cleanup", script_type: "lua", body: "local j = ctx.job\n" },
    { id: "labeler.apply:com.example.post", script_type: "lua", body: "return {}\n" },
  ]);
  authed("/admin/script-variables", [{ key: "WEBHOOK_SECRET" }]);
  authed("/admin/plugins", {
    plugins: [
      {
        id: "steam",
        version: "0.3.0",
        source: "url",
        required_secrets: [{ key: "STEAM_API_KEY" }],
      },
      { id: "homebrew-thing", version: "0.1.0", source: "url" },
    ],
  });
  authed("/admin/settings", [{ key: "app_name", value: "Old App" }]);
  authed("/admin/users", [{ did: "did:plc:super", is_super: true }]);
  authed("/admin/labelers", []);
}

export function mountPull(s) {
  for (const mode of ["pv3", "pv3nos", "pv3mod", "pvdev"]) mountV3(s, mode);
  mountV2(s);
  const steam = Plugin.library("steam", "steam", "\0asm steam");
  mountRegistryOn(s, "/hvreg", [lua(), ts(), db(), steam], (srv) =>
    srv.given(
      "GET",
      "/hvreg/xrpc/at.happyproto.registry.resolveChannel",
      { json: steam.versionJson() },
      (r) => r.query.get("name") === "steam" && r.query.get("channel") === "beta",
    ),
  );
  // The host's release, and the Linux one `dev --network local` asks for (the fake `docker`
  // reports aarch64).
  for (const t of new Set([target(), "aarch64-unknown-linux-musl"])) {
    const asset = `happyview-${t}.tar.xz`;
    const archive = tarXz([[`happyview-${t}/happyview`, FAKE_HAPPYVIEW, 0o755]]);
    const sum = createHash("sha256").update(archive).digest("hex");
    s.given("GET", `/dl/v${VERSION}/${asset}`, { body: Buffer.from(archive) });
    s.given("GET", `/dl/v${VERSION}/${asset}.sha256`, { body: `${sum}  ${asset}\n` });
  }
  const asset = `happyview-${target()}.tar.xz`;
  s.given("GET", "/gh/repos/gamesgamesgamesgamesgames/happyview/releases", {
    json: [{ tag_name: `v${VERSION}`, draft: false, assets: [{ name: asset }] }],
  });
}
