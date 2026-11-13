// The HappyView the parity harness's `@mock` cases talk to. One server serves
// both binaries in turn, so URLs (and so outputs) are the same for each.
//
// The first path segment picks a behaviour, so a case chooses one by URL:
//   $MOCK/ok/…       a healthy instance: no plugins, no project deployed
//   $MOCK/refuse/…   every admin call answers 401
//   $MOCK/forbid/…   every admin call answers 403 Missing permission
//   $MOCK/old/…      no /admin/project route (an old HappyView)
//   $MOCK/reg-<mode>/… the plugin registry (see mock-registry.mjs)
import { MockServer } from "../support/mock-server.ts";
import { mountRegistry } from "./mock-registry.mjs";

export async function startMock() {
  const s = await MockServer.start();
  const mode = (r) => r.path.split("/")[1];
  mountRegistry(s);
  s.given("GET", /\/config$/, { json: { cli_client_key: "hvc_hpy" } });
  s.given("DELETE", /\/oauth\/sessions\//, { status: 204 });
  s.given("*", /^\/refuse\/admin\//, { status: 401, json: { error: "Unauthorized" } });
  s.given("*", /^\/forbid\/admin\//, {
    status: 403,
    json: { error: "InsufficientPermissions", message: "Missing permission: plugins:read" },
  });
  s.given("GET", /^\/old\/admin\/project$/, { status: 404 });
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
