// crates/hpy/src/failure.rs tests.
import { expect, it } from "vitest";
import { AtprotoError } from "../../src/atproto/error.ts";
import { Failure } from "../../src/core/failure.ts";

// A lexicon refusal is the publisher's to fix, like the registry's own
// refusals, so it exits 2 and prints the message the gateway wrote.
it("a_lexicon_refusal_is_a_usage_failure", () => {
  const f = Failure.from(
    AtprotoError.registry(
      "InvalidRequest",
      "Input/project/security must not have fewer than 1 elements",
    ),
  );
  expect(f.code).toBe(2);
  expect(f.message).toBe("Input/project/security must not have fewer than 1 elements");
});

it("exit_failures_are_quiet_and_others_are_not", () => {
  const f = Failure.exit(7);
  expect(f.code).toBe(7);
  expect(f.quiet).toBe(true);
  expect(Failure.usage("x").quiet).toBe(false);
  expect(Failure.runtime("x").quiet).toBe(false);
});
