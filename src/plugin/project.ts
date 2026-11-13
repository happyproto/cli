// hpy-plugin/src/project.rs: a plugin as a whole, apart from any release: what
// `putProject` writes as the `software.release.project`, its
// `site.standard.publication` and its `at.happyproto.registry.project` sidecar.
import { debugStr } from "../core/debug.ts";
import { type Json, sortKeys } from "../core/output.ts";
import { blobProblem } from "./artifact.ts";
import { PLUGIN_TYPES } from "./nsid.ts";
import { Problem } from "./problem.ts";
import { graphemes, isProjectName, tooLong } from "./validate.ts";

/** The publication's icon limit: the standard.site lexicon's, so a decimal megabyte. */
export const MAX_ICON_BYTES = 1_000_000;
export const MAX_KEYWORDS = 20;
export const MAX_PUBLICATION_NAME = 64;
export const MAX_PUBLICATION_DESCRIPTION = 300;

export interface Author {
  name: string;
  url?: string | undefined;
  email?: string | undefined;
}

export interface Contact {
  url?: string | undefined;
  email?: string | undefined;
}

/** serde's form of an Author or Contact: absent options skipped, fields in declaration order. */
export const authorJson = (a: Author): Json => ({
  name: a.name,
  ...(a.url !== undefined ? { url: a.url } : {}),
  ...(a.email !== undefined ? { email: a.email } : {}),
});
export const contactJson = (c: Contact): Json => ({
  ...(c.url !== undefined ? { url: c.url } : {}),
  ...(c.email !== undefined ? { email: c.email } : {}),
});

/** The `site.standard.publication` half of `putProject`; the gateway adds its `url`. */
export interface PublicationInput {
  name: string;
  description?: string | undefined;
  icon?: Json | undefined;
}

/** Everything `putProject` sends. */
export interface ProjectDetails {
  name: string;
  publication: PublicationInput;
  pluginType: string;
  keywords: string[];
  authors: Author[];
  security: Contact[];
}

export function looksLikeUri(s: string): boolean {
  const i = s.indexOf(":");
  if (i === -1) return false;
  const scheme = s.slice(0, i);
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) && s.length > i + 1;
}

const given = (f: string | undefined) => f !== undefined && f.trim() !== "";

/** Everything the gateway would refuse, each located by its path in the `putProject` input. */
export function projectProblems(d: ProjectDetails): Problem[] {
  const out: Problem[] = [];
  if (!isProjectName(d.name))
    out.push(
      new Problem(
        "name",
        `\`${d.name}\` must be 1 to 64 lowercase letters, digits and interior \`-\``,
      ),
    );
  if (d.publication.name.trim() === "") out.push(new Problem("publication.name", "is required"));
  else if (graphemes(d.publication.name) > MAX_PUBLICATION_NAME)
    out.push(new Problem("publication.name", `is longer than ${MAX_PUBLICATION_NAME} characters`));
  if (
    d.publication.description !== undefined &&
    graphemes(d.publication.description) > MAX_PUBLICATION_DESCRIPTION
  )
    out.push(
      new Problem(
        "publication.description",
        `is longer than ${MAX_PUBLICATION_DESCRIPTION} characters`,
      ),
    );
  if (d.publication.icon !== undefined) {
    const icon = d.publication.icon as Record<string, unknown> | null;
    const m = icon && typeof icon === "object" ? icon.mimeType : undefined;
    const mime = typeof m === "string" ? m : "";
    const p = mime.startsWith("image/")
      ? blobProblem(d.publication.icon, [mime], MAX_ICON_BYTES)
      : `is ${debugStr(mime)}; it must be an image`;
    if (p !== null) out.push(new Problem("publication.icon", p));
  }
  if (!(PLUGIN_TYPES as readonly string[]).includes(d.pluginType))
    out.push(
      new Problem(
        "project.pluginType",
        `must be auth, library or interpreter (got ${debugStr(d.pluginType)})`,
      ),
    );
  if (d.keywords.length > MAX_KEYWORDS)
    out.push(new Problem("project.keywords", `has more than ${MAX_KEYWORDS} keywords`));
  for (const [i, k] of d.keywords.entries()) tooLong(out, `project.keywords[${i}]`, k, 32, 320);
  if (d.authors.length === 0) out.push(new Problem("project.authors", "needs at least one author"));
  for (const [i, a] of d.authors.entries()) {
    const path = `project.authors[${i}]`;
    if (a.name.trim() === "") out.push(new Problem(`${path}.name`, "is required"));
    else if (graphemes(a.name) > 128)
      out.push(new Problem(`${path}.name`, "is longer than 128 characters"));
    if (a.url !== undefined && !looksLikeUri(a.url))
      out.push(new Problem(`${path}.url`, "is not a URI"));
  }
  if (d.security.length === 0)
    out.push(
      new Problem(
        "project.security",
        "needs at least one contact: a plugin runs as native code in an operator's process",
      ),
    );
  for (const [i, c] of d.security.entries()) {
    const path = `project.security[${i}]`;
    if (!given(c.url) && !given(c.email)) out.push(new Problem(path, "needs a url or an email"));
    if (given(c.url) && !looksLikeUri(c.url as string))
      out.push(new Problem(`${path}.url`, "is not a URI"));
  }
  return out;
}

/** The `putProject` input, without `swapCid` or `validateOnly`, which depend on the call. Keys sorted, as a `Value`. */
export function projectInput(d: ProjectDetails): Json {
  const publication: Record<string, Json> = { name: d.publication.name };
  if (d.publication.description !== undefined) publication.description = d.publication.description;
  if (d.publication.icon !== undefined) publication.icon = d.publication.icon;
  // Validation counts a blank url or email as absent, so none is sent.
  const keep = (f: string | undefined) => (given(f) ? f : undefined);
  const project: Record<string, Json> = {
    pluginType: d.pluginType,
    authors: d.authors.map((a) =>
      authorJson({ name: a.name, url: keep(a.url), email: keep(a.email) }),
    ),
    security: d.security.map((c) => contactJson({ url: keep(c.url), email: keep(c.email) })),
  };
  if (d.keywords.length > 0) project.keywords = d.keywords;
  return sortKeys({ name: d.name, publication, project });
}

export function authorDisplay(a: Author): string {
  let s = a.name;
  if (a.email !== undefined) s += ` <${a.email}>`;
  if (a.url !== undefined) s += ` (${a.url})`;
  return s;
}

export function contactDisplay(c: Contact): string {
  if (c.email !== undefined && c.url !== undefined) return `${c.email} (${c.url})`;
  return c.email ?? c.url ?? "(empty)";
}

/** Cuts the first `open … close` span out of `s.v`, answering its trimmed contents when non-empty. */
function takeDelimited(s: { v: string }, open: string, close: string): string | undefined {
  const start = s.v.indexOf(open);
  if (start === -1) return undefined;
  const rel = s.v.slice(start).indexOf(close);
  if (rel === -1) return undefined;
  const end = start + rel;
  const inner = s.v.slice(start + open.length, end).trim();
  s.v = s.v.slice(0, start) + s.v.slice(end + close.length);
  return inner === "" ? undefined : inner;
}

/** `Name <email> (url)`, as npm writes authors; throws the reason as a string. */
export function parseAuthor(text: string): Author {
  const rest = { v: text.trim() };
  const email = takeDelimited(rest, "<", ">");
  const url = takeDelimited(rest, "(", ")");
  const name = rest.v.trim();
  if (name === "") throw "an author needs a name, e.g. `Ada <ada@example.com> (https://ada.dev)`";
  return { name, email, url };
}

/** A security contact: an email address or a URI; throws the reason as a string. */
export function parseContact(text: string): Contact {
  const s = text.trim();
  if (s.includes("://") || s.startsWith("mailto:")) return { url: s, email: undefined };
  if (s.includes("@") && !s.includes(" ")) return { url: undefined, email: s };
  throw `\`${s}\` is neither an email address nor a URL`;
}
