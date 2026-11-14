// hpy-atproto/src/dpop.rs: DPoP (RFC 9449). The P-256 key HappyView provisions,
// and the proofs signed with it for every request to the PDS's authorization
// server and to HappyView.
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { inspect } from "node:util";
import { type Json, sortKeys } from "../core/output.ts";
import { AtprotoError } from "./error.ts";

export function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64url");
}

/** `bytes` of randomness, base64url-encoded. */
export function randomToken(bytes: number): string {
  return b64url(randomBytes(bytes));
}

/** The `htu` claim: the URL as sent, without its query or fragment (RFC 9449 §4.2). */
export function htu(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

export function sha256b64url(text: string): string {
  return b64url(createHash("sha256").update(text).digest());
}

/** A private P-256 JWK as p256 writes it: kty, crv, x, y, d. */
export interface PrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

/**
 * The key's private half lives only in private fields, so `util.inspect`, `console.log` and
 * `JSON.stringify` show its thumbprint and never `d`, as Rust's hand-written `Debug` does.
 */
export class DpopKey {
  readonly #jwk: PrivateJwk;
  readonly #key: webcrypto.CryptoKey;

  private constructor(jwk: PrivateJwk, key: webcrypto.CryptoKey) {
    this.#jwk = jwk;
    this.#key = key;
  }

  static async generate(): Promise<DpopKey> {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const j = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
    return DpopKey.fromJwk({ kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d });
  }

  static async fromJwk(jwk: unknown): Promise<DpopKey> {
    const bad = () => AtprotoError.other("the DPoP key is not a P-256 private JWK");
    if (!jwk || typeof jwk !== "object") throw bad();
    const j = jwk as Record<string, unknown>;
    if (j.kty !== "EC" || j.crv !== "P-256") throw bad();
    for (const k of ["x", "y", "d"]) if (typeof j[k] !== "string") throw bad();
    const clean: PrivateJwk = {
      kty: "EC",
      crv: "P-256",
      x: j.x as string,
      y: j.y as string,
      d: j.d as string,
    };
    try {
      const key = await webcrypto.subtle.importKey(
        "jwk",
        { ...clean, ext: true },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      return new DpopKey(clean, key);
    } catch {
      throw bad();
    }
  }

  /** The private JWK, `d` included, as a serde_json `Value` (keys sorted when printed). */
  toJwk(): Json {
    return { ...this.#jwk };
  }

  /** The public JWK: exactly `kty`, `crv`, `x`, `y`. */
  publicJwk(): { kty: "EC"; crv: "P-256"; x: string; y: string } {
    return { kty: "EC", crv: "P-256", x: this.#jwk.x, y: this.#jwk.y };
  }

  /** RFC 7638 thumbprint: SHA-256 of the required members in lexical order. */
  thumbprint(): string {
    return sha256b64url(`{"crv":"P-256","kty":"EC","x":"${this.#jwk.x}","y":"${this.#jwk.y}"}`);
  }

  equals(other: DpopKey): boolean {
    return this.thumbprint() === other.thumbprint();
  }

  /** A DPoP proof for one request; `accessToken` adds `ath`, `nonce` the server's last `DPoP-Nonce`. */
  async proof(method: string, url: string, accessToken?: string | null, nonce?: string | null) {
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk() };
    const claims: Record<string, Json> = {
      jti: randomToken(16),
      // `to_ascii_uppercase`: only ASCII letters change.
      htm: method.replace(/[a-z]+/g, (m) => m.toUpperCase()),
      htu: htu(url),
      iat: Math.floor(Date.now() / 1000),
    };
    // `Some("")` is still a value: an empty nonce the server sent goes back as one.
    if (accessToken !== undefined && accessToken !== null) claims.ath = sha256b64url(accessToken);
    if (nonce !== undefined && nonce !== null) claims.nonce = nonce;
    return this.signJwt(header, claims);
  }

  async signJwt(header: Json, claims: Json): Promise<string> {
    const input = `${b64url(Buffer.from(JSON.stringify(sortKeys(header))))}.${b64url(
      Buffer.from(JSON.stringify(sortKeys(claims))),
    )}`;
    const sig = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.#key,
      Buffer.from(input),
    );
    return `${input}.${b64url(new Uint8Array(sig))}`;
  }

  /** Never print the private key. */
  toString(): string {
    return `DpopKey(${this.thumbprint()})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }

  toJSON(): string {
    return this.toString();
  }
}
