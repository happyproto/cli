// Rust's `{:?}` for the values hpy's messages print that way.
import { debugStr } from "./serde-json.ts";

export { debugStr };

/** `<Option<&str> as Debug>`: `None` or `Some("…")`. */
export function debugOption(s: string | null | undefined): string {
  return s === null || s === undefined ? "None" : `Some(${debugStr(s)})`;
}
