// hpy-atproto/src/dpop.rs tests.
import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { DpopKey, htu, sha256b64url } from "../../src/atproto/dpop.ts";

type Obj = Record<string, unknown>;

/** Splits a compact JWT, checks its ES256 signature against the key in its own header, and answers the decoded header and claims. */
async function verify(jwt: string): Promise<[Obj, Obj]> {
  const parts = jwt.split(".");
  expect(parts.length).toBe(3);
  const [h, c, sig] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as Obj;
  const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as Obj;
  const key = await webcrypto.subtle.importKey(
    "jwk",
    header.jwk as webcrypto.JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(sig, "base64url"),
    Buffer.from(`${h}.${c}`),
  );
  expect(ok, "signature verifies").toBe(true);
  return [header, claims];
}

it("proof_verifies_and_carries_the_claims", async () => {
  const key = await DpopKey.generate();
  const jwt = await key.proof("post", "https://hv.example/xrpc/x.y?q=1#f", "tok", "n1");
  const [header, claims] = await verify(jwt);
  expect(header.typ).toBe("dpop+jwt");
  expect(header.alg).toBe("ES256");
  expect((header.jwk as Obj).d).toBeUndefined();
  expect(header.jwk).toEqual(key.publicJwk());
  expect(claims.htm).toBe("POST");
  expect(claims.htu).toBe("https://hv.example/xrpc/x.y");
  expect(claims.ath).toBe(sha256b64url("tok"));
  expect(claims.nonce).toBe("n1");
  expect((claims.jti as string).length).toBeGreaterThanOrEqual(16);
  expect(claims.iat as number).toBeGreaterThan(1_700_000_000);
});

it("proof_without_token_or_nonce_omits_them", async () => {
  const key = await DpopKey.generate();
  const [, claims] = await verify(await key.proof("GET", "https://x.example/a"));
  expect("ath" in claims).toBe(false);
  expect("nonce" in claims).toBe(false);
});

it("jwk_round_trip_and_rfc7638_thumbprint", async () => {
  // RFC 7517 appendix A.2's P-256 key; thumbprint computed independently.
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
    y: "4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM",
    d: "870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE",
  };
  const key = await DpopKey.fromJwk(jwk);
  expect(key.toJwk()).toEqual(jwk);
  expect(key.thumbprint()).toBe("cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn-s");
  await expect(DpopKey.fromJwk({ kty: "EC" })).rejects.toThrow();
});

it("htu_keeps_percent_encoding_and_port", () => {
  expect(htu("http://127.0.0.1:3000/oauth/sessions/did%3Aplc%3Aabc?x=1")).toBe(
    "http://127.0.0.1:3000/oauth/sessions/did%3Aplc%3Aabc",
  );
  expect(htu("https://api.happyproto.at/xrpc/a.b#frag")).toBe("https://api.happyproto.at/xrpc/a.b");
});

// TS-only: Rust's `Option<&str>` keeps an empty value, so an empty nonce or token is still sent.
it("an_empty_nonce_or_token_is_still_a_claim", async () => {
  const key = await DpopKey.generate();
  const [, claims] = await verify(await key.proof("get", "https://x.example/a", "", ""));
  expect(claims.ath).toBe(sha256b64url(""));
  expect(claims.nonce).toBe("");
  // `to_ascii_uppercase` leaves non-ASCII letters alone.
  const [, odd] = await verify(await key.proof("dél", "https://x.example/a"));
  expect(odd.htm).toBe("DéL");
});
