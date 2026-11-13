// crates/hpy/src/clock.rs tests.
import { expect, it } from "vitest";
import { civilFromDays, todayUtc } from "../../src/core/clock.ts";

it("dates_are_iso_8601_utc", () => {
  const t = todayUtc();
  expect(t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(civilFromDays(0)).toEqual([1970, 1, 1]);
  expect(civilFromDays(20_735)).toEqual([2026, 10, 9]);
});
