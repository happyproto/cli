// hpy-atproto/src/keystore.rs tests.
import { expect, it } from "vitest";
import { randomToken } from "../../src/atproto/dpop.ts";
import { Keychain, loadKeychain, MemoryStore } from "../../src/atproto/keystore.ts";

it("memory_store_round_trip", () => {
  const s = new MemoryStore();
  expect(s.get("a")).toBeNull();
  s.set("a", "secret");
  expect(s.get("a")).toBe("secret");
  s.delete("a");
  s.delete("a");
  expect(s.get("a")).toBeNull();
});

// Touches the real OS keychain, under the test service only; run by hand with
// HPY_REAL_KEYCHAIN_TEST=1 (Rust's `#[ignore]`).
it.skipIf(!process.env.HPY_REAL_KEYCHAIN_TEST)("real_keychain_round_trip", async () => {
  await loadKeychain();
  const account = `hpy-test/${randomToken(8)}`;
  const k = new Keychain("hpy-test-keystore");
  expect(k.get(account)).toBeNull();
  k.set(account, "secret");
  expect(k.get(account)).toBe("secret");
  k.delete(account);
  expect(k.get(account)).toBeNull();
});
