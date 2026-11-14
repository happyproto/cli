// hpy-plugin/src/changelog.rs: a version's entry in a plugin's CHANGELOG.md,
// which becomes the changelog document published with the release.

/** Rust's `str::lines`: split on `\n`, dropping a `\r` before it and a final empty line. */
export function lines(text: string): string[] {
  const out = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (out.length > 0 && out[out.length - 1] === "" && text.endsWith("\n")) out.pop();
  if (text === "") return [];
  return out;
}

/** Whether a heading is for exactly `version`, so `1.1.0` never matches `1.1.0-alpha.1` or `1.1`. */
function namesVersion(heading: string, version: string): boolean {
  const h = heading.trimStart();
  if (h.startsWith("[")) {
    // `[1.1.0](…) (date)` and `[1.1.0 (date)](…)` both occur.
    const linked = h.slice(1);
    if (!linked.startsWith(version)) return false;
    const rest = linked.slice(version.length);
    return rest.startsWith("]") || /^\s/u.test(rest);
  }
  if (!h.startsWith(version)) return false;
  const rest = h.slice(version.length);
  return rest === "" || /^\s/u.test(rest);
}

/**
 * The text under the `## [version](…)` or `## version` heading, up to the next
 * `## ` heading, trimmed; null when there is no such heading or nothing under it.
 */
export function changelogEntry(md: string, version: string): string | null {
  const all = lines(md);
  const at = all.findIndex((l) => l.startsWith("## ") && namesVersion(l.slice(3), version));
  if (at === -1) return null;
  const body: string[] = [];
  for (const l of all.slice(at + 1)) {
    if (l.startsWith("## ")) break;
    body.push(l);
  }
  const entry = body.join("\n").trim();
  return entry === "" ? null : entry;
}
