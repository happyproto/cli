// hpy-atproto/src/pkce.rs: PKCE (RFC 7636), S256 only.
import { randomToken, sha256b64url } from "./dpop.ts";

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function newPkce(): Pkce {
  // 32 random bytes → a 43-character verifier, the RFC's minimum length.
  const verifier = randomToken(32);
  return { verifier, challenge: sha256b64url(verifier) };
}
