// Rust's `str`/`char` predicates where they differ from JavaScript's: `char::is_whitespace`
// is Unicode White_Space (JS `\s` adds U+FEFF and drops U+0085), and `is_alphanumeric` is
// Alphabetic or Numeric.
import { RUST_ESCAPED } from "./rust-escape-table.ts";

export const isWhitespace = (c: string): boolean => /^\p{White_Space}$/u.test(c);
export const isAlphanumeric = (c: string): boolean => /^[\p{Alphabetic}\p{N}]$/u.test(c);
export const isAsciiAlphabetic = (c: string): boolean => /^[A-Za-z]$/.test(c);
export const isAsciiAlphanumeric = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);

/** `str::trim_start`. */
export const trimStart = (s: string): string => s.replace(/^\p{White_Space}+/u, "");
/** `str::trim_end`. */
export const trimEnd = (s: string): string => s.replace(/\p{White_Space}+$/u, "");
/** `str::trim`. */
export const trim = (s: string): string => trimEnd(trimStart(s));

/** `str::lines`: split on `\n`, each line without it or a `\r` before it; no last empty line. */
export function lines(s: string): string[] {
  if (s === "") return [];
  const out = s.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * Whether Rust's Debug formatting prints `cp` as `\u{…}` (`char::escape_debug_ext` with
 * grapheme extenders escaped), by Rust's Unicode tables. \0, \t, \r and \n, which have their
 * own escapes, are not in the table.
 */
export function rustEscapesUnicode(cp: number): boolean {
  let lo = 0;
  let hi = RUST_ESCAPED.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < RUST_ESCAPED[mid * 2]!) hi = mid - 1;
    else if (cp > RUST_ESCAPED[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}
