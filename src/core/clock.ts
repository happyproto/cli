// crates/hpy/src/clock.rs: UTC dates, for the daily update check.

/** Today's UTC date: `2026-10-09`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The civil date `days` after 1970-01-01, as clock.rs's days-to-civil answers it. */
export function civilFromDays(days: number): [number, number, number] {
  const d = new Date(days * 86_400_000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}
