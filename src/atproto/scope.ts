// hpy-atproto/src/scope.rs: what a session was granted, read before asking it
// to do something. A grant missing something cannot be widened by retrying,
// and a publish that fails halfway leaves blobs with no record, so the grant is
// checked before the first upload.
import {
  CHANNEL_NSID,
  DOCUMENT_NSID,
  MANIFEST_NSID,
  PROJECT_NSID,
  PUBLICATION_NSID,
  SIDECAR_NSID,
  STATUS_NSID,
  VERSION_NSID,
} from "../plugin/nsid.ts";

/** The collections a publish writes to through the gateway. */
export const PUBLISH_COLLECTIONS = [
  PROJECT_NSID,
  MANIFEST_NSID,
  VERSION_NSID,
  CHANNEL_NSID,
  STATUS_NSID,
  SIDECAR_NSID,
  PUBLICATION_NSID,
  DOCUMENT_NSID,
] as const;

const tokens = (granted: string) => granted.split(/\s+/).filter((t) => t !== "");

/** Whether `granted` carries a `repo:` permission covering `collection`. */
export function coversRepo(granted: string, collection: string): boolean {
  return tokens(granted)
    .filter((t) => t.startsWith("repo:"))
    .map((t) => t.slice(5).split("?")[0] ?? "")
    .some((named) => named === "*" || named === collection);
}

export function missingRepoScopes(granted: string, collections: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const c of collections) {
    const scope = `repo:${c}`;
    if (!coversRepo(granted, c) && !missing.includes(scope)) missing.push(scope);
  }
  return missing;
}

/** A mime type's parameters and case say nothing about which blobs a scope admits. */
function normalize(mime: string): string {
  return (mime.split(";")[0] ?? mime).trim().toLowerCase();
}

function patternMatches(pattern: string, mime: string): boolean {
  if (pattern === "*/*" || pattern === mime) return true;
  // `image/*` covers `image/png`; a bare `image` is deliberately not a pattern.
  if (!pattern.endsWith("/*")) return false;
  const prefix = pattern.slice(0, -2);
  return prefix !== "" && mime.startsWith(`${prefix}/`);
}

export function coversBlob(granted: string, mime: string): boolean {
  const m = normalize(mime);
  return tokens(granted)
    .filter((t) => t.startsWith("blob:"))
    .some((p) => patternMatches(normalize(p.slice(5)), m));
}

export function missingBlobScopes(granted: string, mimes: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const mime of mimes) {
    const scope = `blob:${normalize(mime)}`;
    if (!coversBlob(granted, mime) && !missing.includes(scope)) missing.push(scope);
  }
  return missing;
}
