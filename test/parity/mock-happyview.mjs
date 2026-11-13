// The HappyView the parity harness's `@mock` cases talk to. One server serves
// both binaries in turn, so URLs (and so outputs) are the same for each.
//
// The first path segment picks a behaviour, so a case chooses one by URL:
//   $MOCK/ok/…       a healthy instance: no plugins, no project deployed
//   $MOCK/refuse/…   every admin call answers 401
//   $MOCK/forbid/…   every admin call answers 403 Missing permission
//   $MOCK/old/…      no /admin/project route (an old HappyView)
//   $MOCK/reg-<mode>/… the plugin registry (see mock-registry.mjs)
// For `hv deploy` (against test/fixtures/hvproject, whose lock pins lua 1.1.0 and std 2.0.0):
//   $MOCK/dep/…      lua 1.0.0 and old 1.0.0 installed, nothing deployed; a deploy adds a lexicon
//   $MOCK/same/…     everything already as the lock and the bundle say
//   $MOCK/invalid/…  the project check answers 422 InvalidProject
//   $MOCK/pending/…  only std installed, and the check needs lua first
//   $MOCK/eol/…      nothing installed, and installing lua is refused
//   $MOCK/noboot/…   the deployed project failed to build at the last boot
// For `hv pull`, see mock-pull.mjs.
// For `hv env push`:
//   $MOCK/vars/…     B is set already; every set is accepted
//   $MOCK/varsfail/… as vars, but setting A fails, quoting the value
import { MockServer } from "../support/mock-server.ts";
import { mountPull } from "./mock-pull.mjs";
import { mountRegistry } from "./mock-registry.mjs";

export async function startMock() {
  const s = await MockServer.start();
  const mode = (r) => r.path.split("/")[1];
  mountRegistry(s);
  mountPull(s);
  s.given("GET", /\/config$/, { json: { cli_client_key: "hvc_hpy" } });
  s.given("DELETE", /\/oauth\/sessions\//, { status: 204 });
  s.given("*", /^\/refuse\/admin\//, { status: 401, json: { error: "Unauthorized" } });
  s.given("*", /^\/forbid\/admin\//, {
    status: 403,
    json: { error: "InsufficientPermissions", message: "Missing permission: plugins:read" },
  });
  s.given("GET", /^\/old\/admin\/project$/, { status: 404 });
  mountDeploy(s);
  s.given("GET", /\/admin\/plugins$/, { json: { plugins: [] } });
  s.given("GET", /\/admin\/project$/, (r) =>
    mode(r) === "ok" || mode(r) === "old"
      ? { status: 404, json: { error: "NoProject" } }
      : { status: 404 },
  );
  return s;
}

/** A request as the harness compares it: what hpy chose to send, without per-run randomness. */
export function describeRequest(r) {
  const h = r.headers;
  const keep = ["content-type", "if-match", "x-client-key", "user-agent"]
    .filter((k) => h[k] !== undefined)
    .map((k) => `${k}: ${h[k]}`);
  // A DPoP proof and its token are random per run; say only that they were sent.
  if (h.authorization !== undefined)
    keep.push(`authorization: ${h.authorization.startsWith("DPoP ") ? "DPoP …" : h.authorization}`);
  if (h.dpop !== undefined) keep.push("dpop: …");
  const body = r.body.length ? `\n  ${r.body.toString()}` : "";
  return `${r.method} ${r.path}${r.query.size ? `?${r.query}` : ""}\n  ${keep.join("\n  ")}${body}`;
}

const PUB = "did:plc:publisher";
const installed = (id, version) => ({
  id,
  name: id,
  version,
  source: "registry",
  enabled: true,
  plugin_type: "interpreter",
  capabilities: { declared: [{ name: "kv:read" }] },
  registry: {
    did: PUB,
    name: id,
    channel: null,
    unresolved: false,
    version_uri: `at://${PUB}/software.release.version/${id}.${version}`,
  },
});
const projectAnswer = (dryRun, added) => ({
  sha256: dryRun ? "new" : "0123456789abcdef0123456789abcdef",
  dry_run: dryRun,
  deployed_at: dryRun ? null : "2026-10-28T20:00:00Z",
  changes: {
    lexicons: { added, changed: [], removed: [] },
    network_lexicons: { added: [], changed: [], removed: dryRun ? ["com.other.feed"] : [] },
    scripts: { added: ["job.run:nightly"], changed: [], removed: [] },
  },
  backfills: added.length ? ["com.example.post"] : [],
  warnings: [{ path: "src/jobs/nightly.lua", line: 3, message: "an unused local" }],
});
const emptyAnswer = (dryRun) => ({
  sha256: "new",
  dry_run: dryRun,
  deployed_at: null,
  changes: { lexicons: { added: [], changed: [], removed: [] } },
  backfills: [],
  warnings: [],
});
const invalid = {
  status: 422,
  json: {
    error: "InvalidProject",
    problems: [
      { path: "src/lexicons/com/example/hello.lua", message: "no interpreter claims .lua" },
    ],
  },
};
const isDry = (r) => r.query.get("dry_run") === "true";

function mountDeploy(s) {
  const route = (method, m, path, reply) =>
    s.given(method, new RegExp(`^/${m}/admin${path}$`), reply);
  route("GET", "dep", "/plugins", {
    json: { plugins: [installed("lua", "1.0.0"), installed("old", "1.0.0")] },
  });
  route("GET", "same", "/plugins", {
    json: { plugins: [installed("lua", "1.1.0"), installed("std", "2.0.0")] },
  });
  route("GET", "invalid", "/plugins", {
    json: { plugins: [installed("lua", "1.1.0"), installed("std", "2.0.0")] },
  });
  route("GET", "noboot", "/plugins", {
    json: { plugins: [installed("lua", "1.1.0"), installed("std", "2.0.0")] },
  });
  route("GET", "pending", "/plugins", { json: { plugins: [installed("std", "2.0.0")] } });
  route("GET", "same", "/project", { json: { sha256: "new" } });
  route("GET", "noboot", "/project", {
    json: {
      sha256: "deployed",
      deployed_at: "2026-10-27T00:00:00Z",
      error: { problems: [{ path: "src/x.ts", message: "no interpreter claims .ts" }] },
    },
  });
  route("PUT", "same", "/project", (r) => ({ json: emptyAnswer(isDry(r)) }));
  route("PUT", "invalid", "/project", invalid);
  route("PUT", "pending", "/project", (r) =>
    isDry(r) ? invalid : { json: projectAnswer(false, ["com.example.hello"]) },
  );
  route("PUT", "noboot", "/project", (r) => ({ json: emptyAnswer(isDry(r)) }));
  route("PUT", "(?:dep|eol)", "/project", (r) => ({
    json: projectAnswer(isDry(r), ["com.example.hello"]),
  }));
  s.given("POST", /^\/eol\/admin\/plugins$/, (r) =>
    r.json().registry?.name === "lua"
      ? { status: 400, json: { error: "NotInstallable", message: "lua 1.1.0 reached end of life" } }
      : { json: installed(r.json().registry.name, r.json().registry.version) },
  );
  s.given("POST", /^\/[a-z]+\/admin\/plugins$/, (r) => ({
    json: installed(r.json().registry.name, r.json().registry.version),
  }));
  s.given("POST", /^\/[a-z]+\/admin\/plugins\/[^/]+\/reload$/, (r) => ({
    json: installed(r.path.split("/")[4], r.json().registry.version),
  }));
  s.given("DELETE", /^\/[a-z]+\/admin\/plugins\/[^/]+$/, { status: 204 });
  for (const m of ["vars", "varsfail"]) {
    s.given("GET", new RegExp(`^/${m}/admin/script-variables$`), {
      json: [
        {
          key: "B",
          preview: "****",
          unreadable: false,
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
        },
        { key: "C", preview: "****", unreadable: true, created_at: null, updated_at: null },
      ],
    });
  }
  s.given("POST", /^\/varsfail\/admin\/script-variables$/, (r) =>
    r.json().key === "A"
      ? {
          status: 500,
          json: {
            error: "InternalError",
            message: `failed to upsert script variable: ${r.json().value}`,
          },
        }
      : { status: 204 },
  );
  s.given("POST", /^\/vars\/admin\/script-variables$/, { status: 204 });
}
