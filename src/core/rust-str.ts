// Rust's `str`/`char` predicates where they differ from JavaScript's: `char::is_whitespace`
// is Unicode White_Space (JS `\s` adds U+FEFF and drops U+0085), and `is_alphanumeric` is
// Alphabetic or Numeric.

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
