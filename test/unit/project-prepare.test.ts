// crates/hpy/src/project/prepare.rs tests.
import { expect, it } from "vitest";
import { lockedRefusal } from "../../src/project/prepare.ts";

it("no_lock_at_all_says_so", () => {
  expect(lockedRefusal(null, [])).toBe("there is no happyview.lock");
});

it("a_mismatch_is_reported_as_one", () => {
  const text = lockedRefusal(["lua is not in the lock"], []);
  expect(text).toContain("does not match happyview.toml");
  expect(text).toContain("lua is not in the lock");
});

/**
 * A lock that matches happyview.toml but records no capabilities is not a mismatch, and must
 * not be reported as one: the reader would go looking at a file that is correct.
 */
it("an_unrecorded_lock_is_not_reported_as_a_mismatch", () => {
  const text = lockedRefusal([], ["lua", "std"]);
  expect(text).not.toContain("does not match");
  expect(text).toContain("records no capabilities for lua, std");
  expect(text).toContain("hpy happyview check");
});
