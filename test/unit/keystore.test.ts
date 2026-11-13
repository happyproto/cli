// hpy-atproto/src/keystore.rs tests.
import { expect, it } from "vitest";
import { randomToken } from "../../src/atproto/dpop.ts";
import { classify, Keychain, loadKeychain, MemoryStore } from "../../src/atproto/keystore.ts";

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

// TS-only: @napi-rs/keyring 2.x raises every error as GenericFailure with keyring-core's
// wording, so "no usable keychain" is told apart by the message alone.
it("keyring_cores_no_keychain_errors_are_unavailable", () => {
  for (const msg of [
    "Couldn't access platform storage: no secret service",
    "Platform failure: org.freedesktop.DBus.Error.ServiceUnknown",
    "Unsupported: this store cannot do that",
    "No default store has been set, so cannot search or create entries",
  ]) {
    expect(classify(new Error(msg)).unavailable, msg).toBe(true);
  }
  for (const msg of ["No matching credential found", "Password data is not valid UTF-8"]) {
    expect(classify(new Error(msg)).unavailable, msg).toBe(false);
  }
});

// TS-only: the CLI's keychain service is fixed; only a test that builds a Keychain names another.
it("the_keychain_service_is_hpy_whatever_the_environment_says", () => {
  const before = process.env.HPY_KEYCHAIN_SERVICE_FOR_TESTS;
  try {
    process.env.HPY_KEYCHAIN_SERVICE_FOR_TESTS = "hpy-test-other";
    expect(new Keychain().service).toBe("hpy");
    expect(new Keychain("hpy-test-keystore").service).toBe("hpy-test-keystore");
  } finally {
    if (before === undefined) delete process.env.HPY_KEYCHAIN_SERVICE_FOR_TESTS;
    else process.env.HPY_KEYCHAIN_SERVICE_FOR_TESTS = before;
  }
});
