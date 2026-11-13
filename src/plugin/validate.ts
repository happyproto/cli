// hpy-plugin/src/validate.rs: the registry's grammar for names, versions,
// ranges and `requires` keys. The registry refuses what breaks these, so the
// CLI refuses it first and says why. Ranges are judged by a port of the Rust
// `semver` crate, which is what HappyView parses them with.
import { VersionReq } from "../core/semver.ts";
import { PROJECT_NSID, VERSION_NSID } from "./nsid.ts";
import { Problem } from "./problem.ts";

const MAX_NAME = 64;
const MAX_VERSION = 64;

const isLowerOrDigit = (c: string) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");

/**
 * A project name: the record key of the project, its publication and its
 * sidecar, and the first half of a version's and a channel's, so it must
 * survive a record key, a URL segment and a split on `:`.
 */
export function isProjectName(s: string): boolean {
  const bytes = Buffer.from(s);
  if (bytes.length < 1 || bytes.length > MAX_NAME) return false;
  const chars = [...s];
  const first = chars[0] as string;
  const last = chars[chars.length - 1] as string;
  return (
    isLowerOrDigit(first) &&
    isLowerOrDigit(last) &&
    chars.every((c) => isLowerOrDigit(c) || c === "-")
  );
}

/**
 * Why `s` is not a publishable version, or null when it is: a semver core and
 * an optional lowercase prerelease. The version is half of a record key, which
 * cannot hold `+`, and keys compare byte for byte.
 */
export function versionProblem(s: string): string | null {
  if (s.startsWith("v") || s.startsWith("V"))
    return `\`${s}\` must not start with \`v\`; use \`${s.slice(1)}\``;
  if (s.includes("+"))
    return `\`${s}\` carries build metadata (\`+…\`), which cannot appear in a record key; drop it`;
  if (Buffer.byteLength(s) > MAX_VERSION) return `is longer than ${MAX_VERSION} characters`;
  const dash = s.indexOf("-");
  const core = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? null : s.slice(dash + 1);
  const number = (n: string) => /^[0-9]+$/.test(n) && (n === "0" || !n.startsWith("0"));
  const parts = core.split(".");
  if (parts.length !== 3 || !parts.every(number))
    return `\`${s}\` must be MAJOR.MINOR.PATCH, numbers without leading zeros (e.g. \`1.2.0\`)`;
  // `semver` refuses a numeric identifier with a leading zero, so such a version would publish but never install.
  const leadingZero = (i: string) => i.length > 1 && i.startsWith("0") && /^[0-9]+$/.test(i);
  if (pre !== null && pre.split(".").some(leadingZero))
    return `\`${s}\` has a numeric prerelease identifier with a leading zero (e.g. \`alpha.01\`); write \`alpha.1\``;
  if (pre !== null && !pre.split(".").every((i) => /^[a-z0-9-]+$/.test(i)))
    return `\`${s}\` has a prerelease that is not dot-separated lowercase letters, digits and \`-\` (e.g. \`1.2.0-alpha.3\`)`;
  return null;
}

/** Why `s` is not a version requirement HappyView can resolve, or null. */
export function rangeProblem(s: string): string | null {
  if (s.trim() === "") return "is empty";
  if (s.includes("||"))
    return "uses `||`, which Cargo's semver does not support; give one range with comma-separated bounds, or publish one release per major";
  try {
    VersionReq.parse(s);
    return null;
  } catch (e) {
    return `\`${s}\` is not a semver range: ${(e as Error).message}`;
  }
}

/** Why `key` is not a valid `requires` key, or null. */
export function requiresKeyProblem(key: string): string | null {
  if (key.startsWith("env:")) {
    const name = key.slice(4);
    if (name !== "" && /^[A-Za-z0-9.-]+$/.test(name)) return null;
  }
  if (parseProjectUri(key) !== null) return null;
  return `\`${key}\` must be \`env:<name>\` or \`at://<did>/${PROJECT_NSID}/<name>\``;
}

export const projectUri = (did: string, name: string) => `at://${did}/${PROJECT_NSID}/${name}`;

export const versionUri = (did: string, name: string, version: string) =>
  `at://${did}/${VERSION_NSID}/${name}.${version}`;

/** The DID and name in a `software.release.project` URI, or null for any other URI. */
export function parseProjectUri(uri: string): [string, string] | null {
  if (!uri.startsWith("at://")) return null;
  const rest = uri.slice(5);
  const sep = `/${PROJECT_NSID}/`;
  const i = rest.indexOf(sep);
  if (i === -1) return null;
  const did = rest.slice(0, i);
  const name = rest.slice(i + sep.length);
  return isDid(did) && isProjectName(name) ? [did, name] : null;
}

/** atproto DID syntax: `did:<lowercase method>:<identifier>`, at most 2048 characters, never ending in `:` or `%`. */
export function isDid(s: string): boolean {
  if (!s.startsWith("did:")) return false;
  const rest = s.slice(4);
  const colon = rest.indexOf(":");
  if (colon === -1) return false;
  const method = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  return (
    Buffer.byteLength(s) <= 2048 &&
    /^[a-z]+$/.test(method) &&
    /^[A-Za-z0-9._:%-]+$/.test(id) &&
    !id.endsWith(":") &&
    !id.endsWith("%")
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** User-perceived characters, which is what lexicon `maxGraphemes` counts. */
export function graphemes(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

/** Records a problem when `s` exceeds a lexicon's `maxGraphemes` or `maxLength` (bytes), naming whichever it broke. */
export function tooLong(
  out: Problem[],
  path: string,
  s: string,
  maxGraphemes: number,
  maxBytes: number,
): void {
  if (graphemes(s) > maxGraphemes)
    out.push(new Problem(path, `is longer than ${maxGraphemes} characters`));
  else if (Buffer.byteLength(s) > maxBytes)
    out.push(new Problem(path, `is longer than ${maxBytes} bytes`));
}
