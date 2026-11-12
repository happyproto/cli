// hpy-atproto/src/happyview.rs tests, against MockServer.
import { inspect } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { Credential } from "../../src/atproto/credential.ts";
import { DpopKey, sha256b64url } from "../../src/atproto/dpop.ts";
import type { AtprotoError } from "../../src/atproto/error.ts";
import { HappyView, sessionRegistration } from "../../src/atproto/happyview.ts";
import { header, MockServer, type Recorded } from "../support/mock-server.ts";

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

/** wiremock's `body_partial_json`: every given field is in the JSON body with that value. */
const partialJson =
  (fields: Record<string, unknown>) =>
  (r: Recorded): boolean => {
    try {
      const body = r.json() as Record<string, unknown>;
      return Object.entries(fields).every(
        ([k, v]) => JSON.stringify(body[k]) === JSON.stringify(v),
      );
    } catch {
      return false;
    }
  };

/** A request whose DPoP proof is for exactly this request and, when given, this access token. */
const proofFor =
  (token: string | null) =>
  (r: Recorded): boolean => {
    const proof = r.headers.dpop;
    if (typeof proof !== "string") return false;
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(proof.split(".")[1] ?? "", "base64url").toString());
    } catch {
      return false;
    }
    let htu: URL;
    try {
      htu = new URL(String(claims.htu));
    } catch {
      return false;
    }
    // HappyView rebuilds `htu` from the Host header, so compare against that and the path.
    const htuOk =
      htu.search === "" &&
      htu.pathname === r.path &&
      `${htu.hostname}:${htu.port || "80"}` === r.headers.host;
    const athOk =
      token === null
        ? !("ath" in claims)
        : claims.ath === sha256b64url(token) && r.headers.authorization === `DPoP ${token}`;
    return claims.htm === r.method && htuOk && athOk;
  };

const cred = async (s: MockServer): Promise<Credential> => ({
  registry: s.url,
  clientKey: "hvc_test",
  did: "did:plc:abc",
  handle: null,
  pds: "https://pds.test",
  scopes: "atproto",
  accessToken: "tok",
  dpopKey: await DpopKey.generate(),
});

const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected an error");
    },
    (e: AtprotoError) => e,
  );

it("provision_sends_client_key_and_challenge", async () => {
  const s = await start();
  const key = await DpopKey.generate();
  s.given(
    "POST",
    "/oauth/dpop-keys",
    { status: 201, json: { provision_id: "hvp_1", dpop_key: key.toJwk() } },
    header("x-client-key", "hvc_test"),
    partialJson({ pkce_challenge: "chal" }),
  );
  const p = await new HappyView(s.url, "hvc_test").provision("chal");
  expect(p.provisionId).toBe("hvp_1");
  expect(p.dpopKey.equals(key)).toBe(true);
});

it("client_assertion_proves_the_provision", async () => {
  const s = await start();
  s.given(
    "POST",
    "/oauth/client-assertion",
    {
      json: {
        client_assertion: "eyJ.a.b",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        expires_in: 60,
      },
    },
    header("x-client-key", "hvc_test"),
    partialJson({ issuer: "https://pds.test", provision_id: "hvp_1", pkce_verifier: "ver" }),
  );
  expect(
    await new HappyView(s.url, "hvc_test").clientAssertion("https://pds.test", "hvp_1", "ver"),
  ).toBe("eyJ.a.b");
});

it("register_session_sends_the_tokens", async () => {
  const s = await start();
  s.given(
    "POST",
    "/oauth/sessions",
    { status: 201, json: { session_id: "s", did: "did:plc:abc" } },
    partialJson({
      provision_id: "hvp_1",
      pkce_verifier: "ver",
      did: "did:plc:abc",
      access_token: "a",
      refresh_token: "r",
      issuer: "https://pds.test",
    }),
  ).expect(1);
  await new HappyView(s.url, "hvc_test").registerSession({
    provisionId: "hvp_1",
    pkceVerifier: "ver",
    did: "did:plc:abc",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: "2026-10-10T00:00:00Z",
    scopes: "atproto",
    pdsUrl: "https://pds.test",
    issuer: "https://pds.test",
  });
  // Byte-identical to serde: declaration order, and expires_at is sent.
  expect((s.requests[0] as Recorded).body.toString()).toBe(
    '{"provision_id":"hvp_1","pkce_verifier":"ver","did":"did:plc:abc","access_token":"a","refresh_token":"r","expires_at":"2026-10-10T00:00:00Z","scopes":"atproto","pds_url":"https://pds.test","issuer":"https://pds.test"}',
  );
});

it("procedure_sends_dpop_auth_with_matching_proof", async () => {
  const s = await start();
  s.given(
    "POST",
    "/xrpc/at.happyproto.registry.publishRelease",
    { json: { valid: true } },
    header("x-client-key", "hvc_test"),
    proofFor("tok"),
    partialJson({ validateOnly: true }),
  ).expect(1);
  const out = (await new HappyView(s.url, "hvc_test").procedure(
    await cred(s),
    "at.happyproto.registry.publishRelease",
    { record: {}, validateOnly: true },
  )) as Record<string, unknown>;
  expect(out.valid).toBe(true);
});

it("upload_blob_sends_bytes_with_content_type", async () => {
  const s = await start();
  s.given(
    "POST",
    "/xrpc/com.atproto.repo.uploadBlob",
    {
      json: {
        blob: { $type: "blob", ref: { $link: "bafk" }, mimeType: "application/wasm", size: 4 },
      },
    },
    header("content-type", "application/wasm"),
    proofFor("tok"),
  );
  const blob = (await new HappyView(s.url, "hvc_test").uploadBlob(
    await cred(s),
    new Uint8Array([0, 0x61, 0x73, 0x6d]),
    "application/wasm",
  )) as { ref: { $link: string } };
  expect(blob.ref.$link).toBe("bafk");
  expect([...(s.requests[0] as Recorded).body]).toEqual([0, 0x61, 0x73, 0x6d]);
});

it("registry_errors_keep_their_name_and_message", async () => {
  const s = await start();
  s.given("POST", "*", {
    status: 400,
    json: {
      error: "InvalidRecord",
      message: "requires key is neither env:* nor a profile AT URI: x",
    },
  });
  const err = await fails(
    new HappyView(s.url, "hvc_test").procedure(
      await cred(s),
      "at.happyproto.registry.publishRelease",
      {},
    ),
  );
  expect(err.isUsage()).toBe(true);
  expect(err.message).toContain("neither env:*");
});

it("auth_failures_are_session_expired", async () => {
  for (const [status, json] of [
    [401, { error: "AuthRequired", message: "x" }],
    [400, { error: "AuthRequired", message: "your identity could not be determined" }],
  ] as const) {
    const s = await start();
    s.given("POST", "*", { status, json });
    const err = await fails(new HappyView(s.url, "hvc_test").procedure(await cred(s), "a.b.c", {}));
    expect(err.isAuth(), String(status)).toBe(true);
  }
});

it("retries_429_once", async () => {
  const s = await start();
  s.given("POST", "*", { status: 429, headers: { "retry-after": "0" } }).times(1);
  s.given("POST", "*", { json: { ok: true } });
  const out = (await new HappyView(s.url, "hvc_test").procedure(await cred(s), "a.b.c", {})) as {
    ok: boolean;
  };
  expect(out.ok).toBe(true);
  // A fresh proof for the retry: a replayed jti would be refused.
  const [a, b] = s.requests.map((r) => r.headers.dpop);
  expect(a).not.toBe(b);
});

it("revoke_proof_htu_is_the_encoded_url", async () => {
  const s = await start();
  s.given("DELETE", "/oauth/sessions/did%3Aplc%3Aabc", { status: 204 }, proofFor("tok")).expect(1);
  await new HappyView(s.url, "hvc_test").revoke(await cred(s));
});

it("lua_failures_arrive_as_200_and_are_still_errors", async () => {
  // HappyView returns a script's `{ error, message }` table with 200 OK.
  const s = await start();
  s.given("POST", "*", {
    json: { error: "ProjectMissing", message: "no project is indexed under that name" },
  });
  const err = await fails(
    new HappyView(s.url, "hvc_test").procedure(
      await cred(s),
      "at.happyproto.registry.publishRelease",
      {},
    ),
  );
  expect(err.registryName()).toBe("ProjectMissing");
});

it("every_named_registry_refusal_keeps_its_name", async () => {
  for (const name of [
    "InvalidRecord",
    "InvalidRequest",
    "VersionExists",
    "ProjectMissing",
    "InvalidSwap",
    "NotInstallable",
    "SubjectNotFound",
    "InvalidStatus",
    "VersionNotFound",
  ]) {
    const s = await start();
    s.given("POST", "*", { status: 400, json: { error: name, message: "refused for a reason" } });
    const err = await fails(
      new HappyView(s.url, "hvc_test").procedure(
        await cred(s),
        "at.happyproto.registry.putStatus",
        {},
      ),
    );
    expect(err.registryName(), name).toBe(name);
    expect(err.message).toBe("refused for a reason");
  }
});

it("a_refused_login_handshake_is_not_an_expired_session", async () => {
  const s = await start();
  s.given("POST", "/oauth/dpop-keys", { status: 401, json: { error: "unknown client" } });
  const err = await fails(new HappyView(s.url, "hvc_bad").provision("chal"));
  expect(err.isAuth()).toBe(false);
  expect(err.message).toContain("unknown client");
});

it("session_registration_debug_hides_tokens", () => {
  const r = sessionRegistration({
    provisionId: "hvp_1",
    pkceVerifier: "verifier-secret",
    did: "did:plc:abc",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: "x",
    scopes: "atproto",
    pdsUrl: "p",
    issuer: "i",
  });
  const shown = inspect(r);
  expect(shown).not.toContain("secret");
  expect(shown).toContain("hvp_1");
});
