// hpy-atproto/src/happyview.rs: HappyView as hpy talks to it. Provisioning a
// DPoP key, signing client assertions, registering and revoking sessions, and
// XRPC calls made as the signed-in user.
import { type Json, sortKeys } from "../core/output.ts";
import { fromSlice, optional, str, struct } from "../core/serde-json.ts";
import type { Credential } from "./credential.ts";
import { DpopKey } from "./dpop.ts";
import { AtprotoError } from "./error.ts";
import { parseJson, request, statusText, transportError } from "./http.ts";

/** Refusals the gateway makes on purpose; each message is written for the publisher. */
const NAMED_REGISTRY_ERRORS = [
  "InvalidRecord",
  "InvalidRequest",
  "VersionExists",
  "ProjectMissing",
  "InvalidSwap",
  "NotInstallable",
  "SubjectNotFound",
  "InvalidStatus",
  "VersionNotFound",
];

export interface Provision {
  provisionId: string;
  dpopKey: DpopKey;
}

export interface SessionRegistration {
  provisionId: string;
  pkceVerifier: string;
  did: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: string;
  scopes: string;
  pdsUrl: string;
  issuer: string;
}

/**
 * A registration that `util.inspect` (console.log, test diffs) prints without
 * its tokens or PKCE verifier, as Rust's hand-written `Debug` does.
 */
export function sessionRegistration(r: SessionRegistration): SessionRegistration {
  const out = { ...r };
  Object.defineProperty(out, Symbol.for("nodejs.util.inspect.custom"), {
    enumerable: false,
    value: () =>
      `SessionRegistration { provision_id: ${JSON.stringify(r.provisionId)}, did: ${JSON.stringify(r.did)}, scopes: ${JSON.stringify(r.scopes)}, pds_url: ${JSON.stringify(r.pdsUrl)}, issuer: ${JSON.stringify(r.issuer)}, .. }`,
  });
  return out;
}

/** The struct's serde form: fields in declaration order, `refresh_token` skipped when None. */
function registrationJson(r: SessionRegistration): string {
  const o: Record<string, Json> = {
    provision_id: r.provisionId,
    pkce_verifier: r.pkceVerifier,
    did: r.did,
    access_token: r.accessToken,
  };
  if (r.refreshToken !== undefined && r.refreshToken !== null) o.refresh_token = r.refreshToken;
  o.expires_at = r.expiresAt;
  o.scopes = r.scopes;
  o.pds_url = r.pdsUrl;
  o.issuer = r.issuer;
  return JSON.stringify(o);
}

/** `XrpcError`: `{ error, message }`, each an optional string. */
const XRPC_ERROR = struct("XrpcError", { error: optional(str), message: optional(str) });

/**
 * `serde_json::from_slice::<XrpcError>(body).unwrap_or(..)`: a body that is not that struct
 * (a non-string `error`, say) is read as naming neither.
 */
export function xrpcErrorBody(body: string | Uint8Array): { error?: string; message?: string } {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  try {
    const parsed = fromSlice(bytes, XRPC_ERROR);
    return {
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      ...(parsed.message !== undefined ? { message: parsed.message } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Maps an error from HappyView to ours. `asUser` is false for the sign-in
 * handshake, where a 401 means the client itself was refused, not that a
 * session expired.
 */
export function xrpcError(
  what: string,
  status: number,
  body: string | Uint8Array,
  asUser: boolean,
): AtprotoError {
  const parsed = xrpcErrorBody(body);
  const name = parsed.error ?? `HTTP ${statusText(status)}`;
  const message = parsed.message;
  if (!asUser) {
    const detail = message !== undefined ? `${name}: ${message}` : name;
    return AtprotoError.other(`HappyView refused ${what} (${detail})`);
  }
  if (status === 401 || name === "AuthRequired") return AtprotoError.sessionExpired();
  if (NAMED_REGISTRY_ERRORS.includes(name)) return AtprotoError.registry(name, message ?? name);
  return AtprotoError.xrpc(what, name, message);
}

type Build = () => Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  timeout?: number;
}>;

export class HappyView {
  readonly base: string;
  readonly clientKey: string;

  constructor(base: string, clientKey: string) {
    this.base = base.replace(/\/+$/, "");
    this.clientKey = clientKey;
  }

  /**
   * Sends a request built by `build` (called again for a retry, so each attempt
   * gets a fresh DPoP proof), retrying a 429 once, and answers the JSON body. A
   * Lua procedure's `{ error, message }` arrives with 200 OK, so a body
   * carrying `error` is an error whatever the status.
   */
  async send(what: string, asUser: boolean, build: Build): Promise<Json> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await build();
      let resp: Response;
      try {
        resp = await request(r.url, {
          method: r.method,
          headers: { ...r.headers, "x-client-key": this.clientKey },
          ...(r.body !== undefined ? { body: r.body } : {}),
          timeout: r.timeout ?? 60,
        });
      } catch (e) {
        throw AtprotoError.other(`could not reach ${this.base} (${what}): ${transportError(e)}`);
      }
      if (resp.status === 429 && attempt === 0) {
        const wait = Math.min(retryAfter(resp.headers.get("retry-after")), 10);
        await resp.arrayBuffer().catch(() => undefined);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      const body = await resp
        .arrayBuffer()
        .then((b) => new Uint8Array(b))
        .catch(() => new Uint8Array());
      if (!resp.ok) throw xrpcError(what, resp.status, body, asUser);
      if (body.length === 0) return null;
      let value: Json;
      try {
        value = parseJson(body);
      } catch (e) {
        throw AtprotoError.other(`${what} answered something unreadable: ${(e as Error).message}`);
      }
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.error === "string"
      )
        throw xrpcError(what, resp.status, body, asUser);
      return value;
    }
    throw new Error("unreachable: the loop returns on its second attempt");
  }

  async provision(pkceChallenge: string): Promise<Provision> {
    const url = `${this.base}/oauth/dpop-keys`;
    const body = JSON.stringify(sortKeys({ pkce_challenge: pkceChallenge }));
    const out = (await this.send("provisioning a key", false, async () => ({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }))) as Record<string, Json> | null;
    const id = out?.provision_id;
    if (typeof id !== "string") throw AtprotoError.other("HappyView provisioned no key");
    return { provisionId: id, dpopKey: await DpopKey.fromJwk(out?.dpop_key) };
  }

  async clientAssertion(
    issuer: string,
    provisionId: string,
    pkceVerifier: string,
  ): Promise<string> {
    const url = `${this.base}/oauth/client-assertion`;
    const body = JSON.stringify(
      sortKeys({ issuer, provision_id: provisionId, pkce_verifier: pkceVerifier }),
    );
    const out = (await this.send("signing a client assertion", false, async () => ({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }))) as Record<string, Json> | null;
    const a = out?.client_assertion;
    if (typeof a !== "string") throw AtprotoError.other("HappyView signed no client assertion");
    return a;
  }

  async registerSession(r: SessionRegistration): Promise<void> {
    const url = `${this.base}/oauth/sessions`;
    const body = registrationJson(r);
    await this.send("registering the session", false, async () => ({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
  }

  /** Revokes this device's session. */
  async revoke(cred: Credential): Promise<void> {
    const url = `${this.base}/oauth/sessions/${encodeFormComponent(cred.did)}`;
    await this.send("signing out", true, () => this.authed(cred, "DELETE", url));
  }

  async authed(cred: Credential, method: string, url: string, extra: Record<string, string> = {}) {
    const proof = await cred.dpopKey.proof(method, url, cred.accessToken, null);
    return {
      url,
      method,
      headers: { authorization: `DPoP ${cred.accessToken}`, dpop: proof, ...extra },
    };
  }

  /** An XRPC procedure as the signed-in user. */
  async procedure(cred: Credential, nsid: string, body: Json): Promise<Json> {
    const url = `${this.base}/xrpc/${nsid}`;
    const text = JSON.stringify(sortKeys(body));
    return this.send(nsid, true, async () => ({
      ...(await this.authed(cred, "POST", url, { "content-type": "application/json" })),
      body: text,
    }));
  }

  /** Uploads a blob to the user's PDS through HappyView; answers the blob ref. */
  async uploadBlob(cred: Credential, bytes: Uint8Array, mime: string): Promise<Json> {
    const nsid = "com.atproto.repo.uploadBlob";
    const url = `${this.base}/xrpc/${nsid}`;
    const out = (await this.send(nsid, true, async () => ({
      ...(await this.authed(cred, "POST", url, { "content-type": mime })),
      body: bytes,
      // A module may be 16 MB; give a slow link time to send it.
      timeout: 600,
    }))) as Record<string, Json> | null;
    const blob = out?.blob;
    if (blob === undefined) throw AtprotoError.other("the upload answered no blob");
    return blob;
  }
}

/**
 * Seconds to wait before retrying a 429: `Retry-After` read as `u64::from_str` reads it (digits,
 * with an optional leading `+`), or 1 when it is missing or anything else (`5s`, a date).
 */
export function retryAfter(header: string | null): number {
  if (header === null || !/^\+?[0-9]+$/.test(header)) return 1;
  const n = BigInt(header);
  return n > 18446744073709551615n ? 1 : n > 10n ? 10 : Number(n);
}

/** `url::form_urlencoded::byte_serialize`: application/x-www-form-urlencoded, spaces as `+`. */
export function encodeFormComponent(s: string): string {
  return new URLSearchParams({ x: s }).toString().slice(2);
}
