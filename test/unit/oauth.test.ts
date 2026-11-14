// hpy-atproto/src/oauth.rs tests, against MockServer.
import { afterEach, expect, it } from "vitest";
import { DpopKey } from "../../src/atproto/dpop.ts";
import {
  callbackParams,
  escapeHtml,
  exchange,
  listen,
  type ParParams,
  par,
} from "../../src/atproto/oauth.ts";
import type { AuthServer } from "../../src/atproto/resolve.ts";
import { bodyContains, MockServer, type Recorded } from "../support/mock-server.ts";

let server: MockServer | undefined;
afterEach(async () => {
  server?.verify();
  await server?.stop();
  server = undefined;
});
const start = async () => {
  server = await MockServer.start();
  return server;
};

const auth = (s: MockServer): AuthServer => ({
  issuer: s.url,
  parEndpoint: `${s.url}/oauth/par`,
  authorizationEndpoint: `${s.url}/oauth/authorize`,
  tokenEndpoint: `${s.url}/oauth/token`,
});

function proofClaims(r: Recorded): Record<string, unknown> {
  const proof = r.headers.dpop as string;
  return JSON.parse(Buffer.from(proof.split(".")[1] as string, "base64url").toString());
}

const parParams = (): ParParams => ({
  clientId: "https://c.example/meta.json",
  redirectUri: "http://127.0.0.1:1/oauth/callback",
  scope: "atproto",
  state: "st",
  codeChallenge: "chal",
  loginHint: "alice.test",
  clientAssertion: "assert.ion.jwt",
});

it("par_sends_assertion_pkce_and_dpop", async () => {
  const s = await start();
  s.given(
    "POST",
    "/oauth/par",
    { status: 201, json: { request_uri: "urn:req:1", expires_in: 60 } },
    bodyContains("client_assertion=assert.ion.jwt"),
    bodyContains(
      "client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer",
    ),
    bodyContains("code_challenge_method=S256"),
    bodyContains("login_hint=alice.test"),
  );
  const { requestUri, nonce } = await par(auth(s), parParams(), await DpopKey.generate());
  expect(requestUri).toBe("urn:req:1");
  expect(nonce).toBeNull();
  const claims = proofClaims(s.requests[0] as Recorded);
  expect(claims.htm).toBe("POST");
  expect("ath" in claims).toBe(false);
});

it("par_retries_once_with_dpop_nonce", async () => {
  const s = await start();
  s.given("POST", "/oauth/par", {
    status: 400,
    headers: { "dpop-nonce": "n1" },
    json: { error: "use_dpop_nonce" },
  }).times(1);
  s.given("POST", "/oauth/par", {
    status: 201,
    headers: { "dpop-nonce": "n2" },
    json: { request_uri: "urn:req:2" },
  });
  const { requestUri, nonce } = await par(auth(s), parParams(), await DpopKey.generate());
  expect(requestUri).toBe("urn:req:2");
  expect(nonce).toBe("n2");
  expect(s.requests.length).toBe(2);
  expect("nonce" in proofClaims(s.requests[0] as Recorded)).toBe(false);
  expect(proofClaims(s.requests[1] as Recorded).nonce).toBe("n1");
});

it("exchange_returns_tokens_and_reuses_the_nonce", async () => {
  const s = await start();
  s.given(
    "POST",
    "/oauth/token",
    {
      json: {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        scope: "atproto repo:x",
        sub: "did:plc:abc",
        token_type: "DPoP",
      },
    },
    bodyContains("grant_type=authorization_code"),
    bodyContains("code=c0de"),
    bodyContains("code_verifier=ver"),
    bodyContains("client_assertion=a2"),
  );
  const tokens = await exchange(
    auth(s),
    {
      clientId: "https://c.example/meta.json",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      code: "c0de",
      codeVerifier: "ver",
      clientAssertion: "a2",
    },
    await DpopKey.generate(),
    "n2",
  );
  expect([tokens.accessToken, tokens.refreshToken ?? "", tokens.sub]).toEqual([
    "at",
    "rt",
    "did:plc:abc",
  ]);
  expect(tokens.expiresIn).toBe(3600);
  expect(proofClaims(s.requests[0] as Recorded).nonce).toBe("n2");
});

it("token_errors_carry_the_server_description", async () => {
  const s = await start();
  s.given("POST", "*", {
    status: 400,
    json: { error: "invalid_client", error_description: "client authentication failed" },
  });
  await expect(par(auth(s), parParams(), await DpopKey.generate())).rejects.toThrow(
    "client authentication failed",
  );
});

it("callback_parses_code_and_rejects_access_denied", async () => {
  let l = await listen();
  const body = await (
    await fetch(
      `http://127.0.0.1:${l.port}/oauth/callback?code=c0de&state=st&iss=https%3A%2F%2Fpds.test`,
    )
  ).text();
  expect(body).toContain("close this tab");
  const cb = await l.callback;
  expect([cb.code, cb.state, cb.iss]).toEqual(["c0de", "st", "https://pds.test"]);

  l = await listen();
  const denied = l.callback.catch((e: Error) => e);
  await fetch(
    `http://127.0.0.1:${l.port}/oauth/callback?error=access_denied&error_description=User+said+no&state=st`,
  ).catch(() => {});
  expect(String(await denied)).toContain("User said no");
});

it("callback_ignores_other_paths_until_the_real_one", async () => {
  const l = await listen();
  await fetch(`http://127.0.0.1:${l.port}/favicon.ico`).catch(() => {});
  await fetch(`http://127.0.0.1:${l.port}/oauth/callback?code=c&state=s`).catch(() => {});
  expect((await l.callback).code).toBe("c");
});

it("exchange_accepts_a_missing_refresh_token", async () => {
  const s = await start();
  s.given("POST", "*", {
    json: { access_token: "at", expires_in: 60, scope: "atproto", sub: "did:plc:abc" },
  });
  const tokens = await exchange(
    auth(s),
    { clientId: "c", redirectUri: "r", code: "c", codeVerifier: "v", clientAssertion: null },
    await DpopKey.generate(),
    null,
  );
  expect(tokens.refreshToken).toBeNull();
});

// TS-only: Rust's `ParParams.login_hint` is `Some` even when empty, so the field is sent.
it("an_empty_login_hint_is_still_sent", async () => {
  const s = await start();
  s.given("POST", "/oauth/par", { status: 201, json: { request_uri: "urn:req:1" } });
  await par(auth(s), { ...parParams(), loginHint: "" }, await DpopKey.generate());
  expect((s.requests[0] as Recorded).body.toString()).toMatch(/(^|&)login_hint=(&|$)/);
});

it("a_repeated_callback_parameter_keeps_its_last_value", () => {
  const p = callbackParams("code=a&state=s&code=b&error_description=x+y%21");
  expect(p.get("code")).toBe("b");
  expect(p.get("error_description")).toBe("x y!");
  // Rust splits the target at its first `?`, so a second one is part of the first name.
  expect([...callbackParams("?code=a").keys()]).toEqual(["?code"]);
});

it("an_empty_dpop_nonce_is_sent_back_on_the_retry", async () => {
  const s = await start();
  s.given("POST", "/oauth/par", {
    status: 400,
    headers: { "dpop-nonce": "" },
    json: { error: "use_dpop_nonce" },
  }).times(1);
  s.given("POST", "/oauth/par", { status: 201, json: { request_uri: "urn:req:2" } });
  const { nonce } = await par(auth(s), parParams(), await DpopKey.generate());
  expect(nonce).toBe("");
  expect(proofClaims(s.requests[1] as Recorded).nonce).toBe("");
});

it("expires_in_is_read_only_as_a_whole_number", async () => {
  for (const [given, read] of [
    [3600, 3600],
    ["3600.0", null],
    [-1, null],
    ['"3600"', null],
  ] as const) {
    const s = await start();
    s.given("POST", "/oauth/token", {
      headers: { "content-type": "application/json" },
      body: `{"access_token":"at","scope":"atproto","sub":"did:plc:abc","expires_in":${given}}`,
    });
    const tokens = await exchange(
      auth(s),
      {
        clientId: "c",
        redirectUri: "http://127.0.0.1:1/oauth/callback",
        code: "c",
        codeVerifier: "v",
        clientAssertion: null,
      },
      await DpopKey.generate(),
      null,
    );
    expect(tokens.expiresIn, String(given)).toBe(read);
    s.verify();
    await s.stop();
    server = undefined;
  }
});

// TS-only: the page shows the server's words as text, never as markup; the error keeps them
// as they were.
it("the_callback_page_shows_the_error_description_as_text", async () => {
  const l = await listen();
  const denied = l.callback.catch((e: Error) => e);
  const said = `<b>"no" & 'never'</b>`;
  const page = await (
    await fetch(
      `http://127.0.0.1:${l.port}/oauth/callback?error=access_denied&error_description=${encodeURIComponent(said)}`,
    )
  ).text();
  expect(page).toContain(
    "Sign-in was not completed: &#60;b&#62;&#34;no&#34; &#38; &#39;never&#39;&#60;/b&#62;.",
  );
  expect(page).not.toContain("<b>");
  expect(String(await denied)).toContain(`sign-in was not completed: ${said}`);
  expect(escapeHtml("a&b")).toBe("a&#38;b");
});
