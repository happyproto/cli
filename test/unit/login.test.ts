// hpy-atproto/src/login.rs tests: a fake resolver, and one MockServer playing
// HappyView and the authorization server, with a test playing the browser.
import { afterEach, expect, it } from "vitest";
import { DpopKey } from "../../src/atproto/dpop.ts";
import { AtprotoError } from "../../src/atproto/error.ts";
import { HappyView } from "../../src/atproto/happyview.ts";
import { type LoginOptions, login } from "../../src/atproto/login.ts";
import type { AuthServer, Resolved, Resolver } from "../../src/atproto/resolve.ts";
import { type Settings, settingsFromSources } from "../../src/atproto/settings.ts";
import { MockServer, type Recorded } from "../support/mock-server.ts";

let servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.verify();
    await s.stop();
  }
  servers = [];
});

const auth = (s: MockServer): AuthServer => ({
  issuer: s.url,
  parEndpoint: `${s.url}/oauth/par`,
  authorizationEndpoint: `${s.url}/oauth/authorize`,
  tokenEndpoint: `${s.url}/oauth/token`,
});

const fakeResolver = (a: AuthServer): Resolver => ({
  async resolve(): Promise<Resolved> {
    return { did: "did:plc:abc", handle: "alice.test", pds: "https://pds.test", auth: a };
  },
});

const partialJson =
  (fields: Record<string, unknown>) =>
  (r: Recorded): boolean => {
    try {
      const body = r.json() as Record<string, unknown>;
      return Object.entries(fields).every(([k, v]) => body[k] === v);
    } catch {
      return false;
    }
  };

/** A HappyView and an authorization server on one mock server. */
async function servers_(sub: string, assertions = 2): Promise<[MockServer, DpopKey]> {
  const s = await MockServer.start();
  servers.push(s);
  const key = await DpopKey.generate();
  s.given("POST", "/oauth/dpop-keys", {
    status: 201,
    json: { provision_id: "hvp_1", dpop_key: key.toJwk() },
  });
  s.given(
    "POST",
    "/oauth/client-assertion",
    { json: { client_assertion: "asrt" } },
    partialJson({ provision_id: "hvp_1" }),
  ).expect(assertions);
  s.given("POST", "/oauth/par", { status: 201, json: { request_uri: "urn:req:1" } });
  s.given("POST", "/oauth/token", {
    json: {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "atproto repo:x",
      sub,
    },
  });
  s.given(
    "POST",
    "/oauth/sessions",
    { status: 201, json: { session_id: "s", did: "did:plc:abc" } },
    partialJson({
      provision_id: "hvp_1",
      did: "did:plc:abc",
      access_token: "at",
      refresh_token: "rt",
    }),
  );
  return [s, key];
}

const form = (s: MockServer, path: string) =>
  new URLSearchParams((s.requests.find((r) => r.path === path) as Recorded).body.toString());

/**
 * Plays the browser: reads the PAR request's state and redirect URI, then
 * calls the loopback callback with `stateOverride` if given.
 */
const browser =
  (s: MockServer, stateOverride: string | null = null, sendIss = true) =>
  (_url: string) => {
    const par = form(s, "/oauth/par");
    const state = stateOverride ?? (par.get("state") as string);
    const redirect = par.get("redirect_uri") as string;
    // In relay mode the hosted page would forward to the port in `state`.
    const target = redirect.startsWith("http://127.0.0.1")
      ? redirect
      : `http://127.0.0.1:${(par.get("state") as string).split(".")[0]}/oauth/callback`;
    const iss = sendIss ? `&iss=${encodeURIComponent(s.url)}` : "";
    void fetch(`${target}?code=c0de&state=${state}${iss}`).catch(() => {});
  };

const settings = (): Settings => settingsFromSources(undefined, () => undefined, "/tmp/hpy-test");
const opts = (showUrl: (u: string) => void): LoginOptions => ({
  identifier: "alice.test",
  openBrowser: false,
  showUrl,
});
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected an error");
    },
    (e: Error) => e,
  );

it("logs_in_through_happyview", async () => {
  const [s, key] = await servers_("did:plc:abc");
  const hv = new HappyView(s.url, "hvc_test");
  const cred = await login(settings(), fakeResolver(auth(s)), hv, opts(browser(s)));
  expect(cred.did).toBe("did:plc:abc");
  expect(cred.dpopKey.equals(key)).toBe(true);
  expect(cred.accessToken).toBe("at");
  expect(cred.registry).toBe(s.url);
  expect(s.requests.filter((r) => r.path === "/oauth/sessions").length).toBe(1);
});

it("refuses_a_token_for_someone_else", async () => {
  const [s] = await servers_("did:plc:mallory");
  const err = await fails(
    login(settings(), fakeResolver(auth(s)), new HappyView(s.url, "hvc_test"), opts(browser(s))),
  );
  expect(err.message).toContain("did:plc:mallory");
  // Nothing reaches HappyView for a token that is not the user's.
  expect(s.requests.some((r) => r.path === "/oauth/sessions")).toBe(false);
});

it("refuses_a_callback_with_the_wrong_state", async () => {
  // The forged callback is refused before the token request, so only PAR's assertion is asked for.
  const [s] = await servers_("did:plc:abc", 1);
  const err = await fails(
    login(
      settings(),
      fakeResolver(auth(s)),
      new HappyView(s.url, "hvc_test"),
      opts(browser(s, "forged")),
    ),
  );
  expect(err.message).toContain("state");
});

it("relay_mode_carries_the_port_in_state_and_uses_the_relay_uri", async () => {
  const [s] = await servers_("did:plc:abc");
  const st = settings();
  st.oauthRedirect = { kind: "relay", url: "https://relay.test/oauth/hpy/callback" };
  await login(st, fakeResolver(auth(s)), new HappyView(s.url, "hvc_test"), opts(browser(s)));
  const par = form(s, "/oauth/par");
  expect(par.get("redirect_uri")).toBe("https://relay.test/oauth/hpy/callback");
  const [port] = (par.get("state") as string).split(".");
  expect(Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) < 65536).toBe(true);
  expect(form(s, "/oauth/token").get("redirect_uri")).toBe("https://relay.test/oauth/hpy/callback");
});

it("public_loopback_mode_sends_no_assertions", async () => {
  const [s] = await servers_("did:plc:abc", 0);
  const st = settings();
  st.oauthRedirect = { kind: "loopback" };
  st.oauthClientAuth = "none";
  await login(st, fakeResolver(auth(s)), new HappyView(s.url, "hvc_test"), opts(browser(s)));
  const body = (s.requests.find((r) => r.path === "/oauth/par") as Recorded).body.toString();
  expect(body).not.toContain("client_assertion");
  expect(body).toContain("redirect_uri=http%3A%2F%2F127.0.0.1");
});

it("refuses_a_callback_without_iss", async () => {
  const [s] = await servers_("did:plc:abc", 1);
  const err = await fails(
    login(
      settings(),
      fakeResolver(auth(s)),
      new HappyView(s.url, "hvc_test"),
      opts(browser(s, null, false)),
    ),
  );
  expect(err.message).toContain("iss");
});

it("a_mistyped_handle_provisions_nothing", async () => {
  const s = await MockServer.start();
  servers.push(s);
  s.given("POST", "/oauth/dpop-keys", { status: 500 }).expect(0);
  const noSuchUser: Resolver = {
    async resolve(id: string): Promise<Resolved> {
      throw AtprotoError.other(`could not find where \`${id}\` signs in`);
    },
  };
  const err = await fails(
    login(settings(), noSuchUser, new HappyView(s.url, "hvc_test"), {
      identifier: "alcie.test",
      openBrowser: false,
      showUrl: () => {},
    }),
  );
  expect(err.message).toContain("alcie.test");
});
