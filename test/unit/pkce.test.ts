// hpy-atproto/src/pkce.rs tests.
import { expect, it } from "vitest";
import { sha256b64url } from "../../src/atproto/dpop.ts";
import { newPkce } from "../../src/atproto/pkce.ts";

it("challenge_is_s256_of_verifier", () => {
  const p = newPkce();
  expect(p.verifier.length).toBe(43);
  expect(p.challenge).toBe(sha256b64url(p.verifier));
  expect(newPkce().verifier).not.toBe(p.verifier);
});
