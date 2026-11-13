// hpy-atproto/src/login.rs: `hpy registry login`. Provision a DPoP key from
// HappyView, sign in to the user's PDS with it, and hand the session to HappyView.
import { spawn } from "node:child_process";
import { type Credential, newCredential } from "./credential.ts";
import { randomToken } from "./dpop.ts";
import { AtprotoError } from "./error.ts";
import { type HappyView, sessionRegistration } from "./happyview.ts";
import * as oauth from "./oauth.ts";
import { newPkce } from "./pkce.ts";
import type { Resolver } from "./resolve.ts";
import type { Settings } from "./settings.ts";

const CALLBACK_TIMEOUT_MS = 300_000;

export interface LoginOptions {
  identifier: string;
  openBrowser: boolean;
  showUrl: (url: string) => void;
}

/** RFC 3339 with seconds and `Z`, as chrono's `to_rfc3339_opts(Secs, true)` writes it. */
export function rfc3339Secs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function login(
  settings: Settings,
  resolver: Resolver,
  hv: HappyView,
  opts: LoginOptions,
): Promise<Credential> {
  // Resolve first, so a mistyped handle costs nothing on HappyView.
  const resolved = await resolver.resolve(opts.identifier);

  // The HappyView half: a key for this device, bound to a PKCE pair that
  // later proves this is the same client that asked for it.
  const hvPkce = newPkce();
  const provision = await hv.provision(hvPkce.challenge);
  const key = provision.dpopKey;

  const auth = resolved.auth;
  const listener = await oauth.listen();
  try {
    const pdsPkce = newPkce();
    // With a relay, the hosted page reads the loopback port from `state`.
    const [redirectUri, state] =
      settings.oauthRedirect.kind === "loopback"
        ? [`http://127.0.0.1:${listener.port}/oauth/callback`, randomToken(16)]
        : [settings.oauthRedirect.url, `${listener.port}.${randomToken(16)}`];
    const assertion = async () =>
      settings.oauthClientAuth === "assertion"
        ? hv.clientAssertion(auth.issuer, provision.provisionId, hvPkce.verifier)
        : null;

    const parAssertion = await assertion();
    const { requestUri, nonce } = await oauth.par(
      auth,
      {
        clientId: settings.oauthClientId,
        redirectUri,
        scope: settings.oauthScope,
        state,
        codeChallenge: pdsPkce.challenge,
        loginHint: opts.identifier.trim().replace(/^@+/, ""),
        clientAssertion: parAssertion,
      },
      key,
    );

    const url = oauth.authorizeUrl(auth, settings.oauthClientId, requestUri);
    opts.showUrl(url);
    if (opts.openBrowser) openBrowser(url);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () => rej(AtprotoError.other("timed out after 5 minutes waiting for you to authorize hpy")),
        CALLBACK_TIMEOUT_MS,
      );
    });
    const callback = await Promise.race([listener.callback, timeout]).finally(() =>
      clearTimeout(timer),
    );
    if (callback.state !== state)
      throw AtprotoError.other(
        "the sign-in response's state did not match this request; try again",
      );
    // atproto requires `iss` on the authorization response (RFC 9207).
    if (callback.iss === null)
      throw AtprotoError.other(
        "the sign-in response did not say which server sent it (no `iss`); try again",
      );
    if (callback.iss.replace(/\/+$/, "") !== auth.issuer.replace(/\/+$/, ""))
      throw AtprotoError.other(
        `the sign-in response came from ${callback.iss}, not ${auth.issuer}`,
      );

    // A fresh assertion: each one is good for 60 seconds and one request.
    const tokenAssertion = await assertion();
    const tokens = await oauth.exchange(
      auth,
      {
        clientId: settings.oauthClientId,
        redirectUri,
        code: callback.code,
        codeVerifier: pdsPkce.verifier,
        clientAssertion: tokenAssertion,
      },
      key,
      nonce,
    );
    if (tokens.sub !== resolved.did)
      throw AtprotoError.other(
        `the PDS issued a token for ${tokens.sub} instead of ${resolved.did}; nothing was saved`,
      );
    if (!tokens.scope.split(" ").includes("atproto"))
      throw AtprotoError.other(`the PDS granted \`${tokens.scope}\`, which lacks \`atproto\``);

    const expiresAt = new Date(Date.now() + (tokens.expiresIn ?? 3600) * 1000);
    await hv.registerSession(
      sessionRegistration({
        provisionId: provision.provisionId,
        pkceVerifier: hvPkce.verifier,
        did: resolved.did,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: rfc3339Secs(expiresAt),
        scopes: tokens.scope,
        pdsUrl: resolved.pds,
        issuer: auth.issuer,
      }),
    );

    return newCredential({
      registry: hv.base,
      clientKey: settings.clientKey,
      did: resolved.did,
      handle: resolved.handle,
      pds: resolved.pds,
      scopes: tokens.scope,
      accessToken: tokens.accessToken,
      dpopKey: key,
    });
  } finally {
    listener.close();
  }
}

/** Best effort; the URL is always printed as well. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/C", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
