// hpy-atproto/src/oauth.rs: the atproto OAuth requests hpy makes to a PDS's
// authorization server, as a confidential client whose assertions HappyView
// signs: PAR, the loopback callback, and the token exchange. Every request
// carries a DPoP proof made with the key HappyView provisioned.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fromSlice, get, type Node, node } from "../core/serde-json.ts";
import type { DpopKey } from "./dpop.ts";
import { AtprotoError } from "./error.ts";
import { request, statusText, transportError } from "./http.ts";
import type { AuthServer } from "./resolve.ts";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export interface ParParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  loginHint?: string | null;
  /** HappyView-signed, for a confidential client; null for a public one. */
  clientAssertion: string | null;
}

export interface TokenParams {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  clientAssertion: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string;
  sub: string;
}

export interface Callback {
  code: string;
  state: string;
  iss: string | null;
}

/** `url::form_urlencoded`, as reqwest's `.form()` writes it. */
export function formEncode(pairs: [string, string][]): string {
  return new URLSearchParams(pairs).toString();
}

/** `body[name].as_str()`: a string member of an object, or undefined. */
function str(body: Node | undefined, name: string): string | undefined {
  const v = body === undefined ? undefined : get(body, name);
  return v?.kind === "string" ? v.value : undefined;
}

/** A form POST with a DPoP proof, retried once when the server asks for a nonce. */
async function postForm(
  what: string,
  url: string,
  form: [string, string][],
  key: DpopKey,
  startNonce: string | null,
): Promise<{ body: Node | undefined; nonce: string | null }> {
  let nonce = startNonce;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proof = await key.proof("POST", url, null, nonce);
    let resp: Response;
    try {
      resp = await request(url, {
        method: "POST",
        headers: { dpop: proof, "content-type": "application/x-www-form-urlencoded" },
        body: formEncode(form),
        timeout: 30,
      });
    } catch (e) {
      throw AtprotoError.other(
        `could not reach the authorization server (${what}): ${transportError(e)}`,
      );
    }
    const newNonce = resp.headers.get("dpop-nonce");
    // `resp.json().unwrap_or(Value::Null)`.
    let body: Node | undefined;
    try {
      body = fromSlice(new Uint8Array(await resp.arrayBuffer()), node);
    } catch {}
    if (resp.ok) return { body, nonce: newNonce ?? nonce };
    if (str(body, "error") === "use_dpop_nonce" && attempt === 0 && newNonce !== null) {
      nonce = newNonce;
      continue;
    }
    const error = str(body, "error") ?? "unknown_error";
    const d = str(body, "error_description");
    const description = d !== undefined ? `: ${d}` : "";
    throw AtprotoError.other(
      `${what} was refused (${statusText(resp.status)}) — ${error}${description}`,
    );
  }
  throw new Error("unreachable: the loop returns on its second attempt");
}

/** Pushed authorization request; answers the `request_uri` and the nonce to use next. */
export async function par(auth: AuthServer, p: ParParams, key: DpopKey) {
  const form: [string, string][] = [
    ["response_type", "code"],
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["scope", p.scope],
    ["state", p.state],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", "S256"],
  ];
  if (p.clientAssertion !== null) {
    form.push(["client_assertion_type", ASSERTION_TYPE]);
    form.push(["client_assertion", p.clientAssertion]);
  }
  if (p.loginHint !== undefined && p.loginHint !== null) form.push(["login_hint", p.loginHint]);
  const { body, nonce } = await postForm("the sign-in request", auth.parEndpoint, form, key, null);
  const requestUri = str(body, "request_uri");
  if (requestUri === undefined)
    throw AtprotoError.other("the authorization server answered no request_uri");
  return { requestUri, nonce };
}

export function authorizeUrl(auth: AuthServer, clientId: string, requestUri: string): string {
  return `${auth.authorizationEndpoint}?${formEncode([
    ["client_id", clientId],
    ["request_uri", requestUri],
  ])}`;
}

export async function exchange(
  auth: AuthServer,
  p: TokenParams,
  key: DpopKey,
  nonce: string | null,
): Promise<TokenSet> {
  const form: [string, string][] = [
    ["grant_type", "authorization_code"],
    ["code", p.code],
    ["redirect_uri", p.redirectUri],
    ["code_verifier", p.codeVerifier],
    ["client_id", p.clientId],
  ];
  if (p.clientAssertion !== null) {
    form.push(["client_assertion_type", ASSERTION_TYPE]);
    form.push(["client_assertion", p.clientAssertion]);
  }
  const { body } = await postForm("the token request", auth.tokenEndpoint, form, key, nonce);
  const field = (name: string) => {
    const v = str(body, name);
    if (v === undefined) throw AtprotoError.other(`the token response has no ${name}`);
    return v;
  };
  // `as_u64()`: a non-negative integer, not a float such as `3600.0`.
  const expires = body === undefined ? undefined : get(body, "expires_in");
  return {
    accessToken: field("access_token"),
    refreshToken: str(body, "refresh_token") ?? null,
    expiresIn: expires?.kind === "number" && expires.type === "u64" ? Number(expires.value) : null,
    scope: field("scope"),
    sub: field("sub"),
  };
}

/**
 * The callback's query as Rust collects `form_urlencoded::parse` into a HashMap: a name given
 * more than once keeps its last value.
 */
export function callbackParams(query: string): Map<string, string> {
  // A leading `&` keeps URLSearchParams from dropping a leading `?`, which Rust keeps.
  return new Map(new URLSearchParams(`&${query}`));
}

/** Text as HTML: `&`, `<`, `>`, `"` and `'` as character references. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PAGE =
  '<!doctype html><meta charset=utf-8><title>hpy</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">';

/**
 * Binds the loopback redirect listener; answers its port and the callback,
 * which resolves when the browser comes back to `/oauth/callback`.
 */
export async function listen(): Promise<{
  port: number;
  callback: Promise<Callback>;
  close: () => void;
}> {
  let settle!: (r: { ok: Callback } | { err: AtprotoError }) => void;
  const done = new Promise<{ ok: Callback } | { err: AtprotoError }>((res) => {
    settle = res;
  });
  const server = createServer((req, res) => {
    const target = req.url ?? "";
    const q = target.indexOf("?");
    const path = q === -1 ? target : target.slice(0, q);
    const query = q === -1 ? "" : target.slice(q + 1);
    if (path !== "/oauth/callback") {
      res.writeHead(404, { "Content-Length": "0", Connection: "close" }).end();
      return;
    }
    const params = callbackParams(query);
    const error = params.get("error") ?? null;
    const code = params.get("code") ?? null;
    const state = params.get("state") ?? null;
    let result: { ok: Callback } | { err: AtprotoError };
    let message: string;
    if (error !== null) {
      const why = params.get("error_description") ?? error;
      result = { err: AtprotoError.other(`sign-in was not completed: ${why}`) };
      message = `Sign-in was not completed: ${escapeHtml(why)}.`;
    } else if (code !== null && state !== null) {
      result = { ok: { code, state, iss: params.get("iss") ?? null } };
      message = "You're signed in to hpy.";
    } else {
      result = { err: AtprotoError.other("the sign-in response had no code") };
      message = "Sign-in failed: the response had no code.";
    }
    const html = `${PAGE}<p>${message}</p><p>You can close this tab and return to your terminal.</p></body>`;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(html)),
      Connection: "close",
    });
    res.end(html, () => {
      server.close();
      settle(result);
    });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const port = (server.address() as AddressInfo).port;
  const callback = done.then((r) => {
    if ("err" in r) throw r.err;
    return r.ok;
  });
  // A callback that fails before anyone awaits it (a stray request during PAR) is reported
  // when the caller gets to it, not as an unhandled rejection that kills the process.
  callback.catch(() => {});
  return {
    port,
    callback,
    close: () => server.close(),
  };
}
