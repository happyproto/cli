// crates/hpy/src/project/binary.rs: the HappyView binary a project pins, from HappyView's
// GitHub releases. The archive is checked against the `.sha256` published beside it. That
// catches a corrupt or truncated download; it is not a signature, since both come from the
// same release.
import { createHash } from "node:crypto";
// A literal static import, so `bun build --compile` embeds the addon (HANDOFF D5).
import { xz } from "@napi-rs/lzma";
import { DECODE_ERROR, type RequestOptions, request, statusText } from "../atproto/http.ts";
import { Failure } from "../core/failure.ts";
import { toIoError } from "../core/io.ts";
import { Version } from "../core/semver.ts";
import { array, bool, fromStr, str, struct, withDefault } from "../core/serde-json.ts";
import { binaryPath, installFile, isFile, withFileName } from "./cache.ts";

/** The triple `hpy` would have been built for on this machine. */
function buildTarget(): string {
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  switch (process.platform) {
    case "darwin":
      return `${arch}-apple-darwin`;
    case "win32":
      return `${arch}-pc-windows-msvc`;
    case "linux":
      return `${arch}-unknown-linux-gnu`;
    default:
      return `${arch}-unknown-${process.platform}`;
  }
}

/**
 * The release asset for this machine. On Linux that is always the static musl build, which
 * runs on any distribution, whatever libc hpy itself was built against; elsewhere it is the
 * triple hpy was built for.
 */
export const HOST_TARGET: string =
  process.platform === "linux" && process.arch === "x64"
    ? "x86_64-unknown-linux-musl"
    : process.platform === "linux" && process.arch === "arm64"
      ? "aarch64-unknown-linux-musl"
      : buildTarget();

export const DEFAULT_REPO = "gamesgamesgamesgamesgames/happyview";

export type Env = (k: string) => string | undefined;

export interface ReleaseSource {
  api: string;
  download: string;
  repo: string;
}

export const ReleaseSource = {
  fromEnv(env: Env): ReleaseSource {
    const repo = env("HPY_HAPPYVIEW_REPO") ?? DEFAULT_REPO;
    return {
      api: env("HPY_GITHUB_API") ?? "https://api.github.com",
      download: env("HPY_HAPPYVIEW_DOWNLOAD") ?? `https://github.com/${repo}/releases/download`,
      repo,
    };
  },
};

/** reqwest's `Client`: hpy's user agent, and no overall timeout, so a large download on a slow line is never cut off. */
export interface HttpClient {
  request(url: string, o?: RequestOptions): Promise<Response>;
}

/**
 * How long a download may go without a byte before it fails: no response within this long, or
 * a gap this long in its body. Rust's client sets no timeout at all, so a server that accepts a
 * connection and never answers held it forever; this is a generous bound on that alone.
 */
export const STALL_MS = 60_000;

/** A request with a per-call `timeout` keeps that overall timeout; any other gets the stall bound. */
export function httpClient(stallMs: number = STALL_MS): HttpClient {
  return {
    request: (url, o = {}) =>
      o.timeout !== undefined && o.timeout !== null
        ? request(url, o)
        : requestUnlessStalled(url, o, stallMs),
  };
}

/** Statuses whose response has no body, which `new Response` refuses one for. */
const NULL_BODY = [101, 103, 204, 205, 304];

/**
 * `request`, aborted once `stallMs` pass with nothing arriving: first the response, then each
 * chunk of its body. The answer is a copy of the response whose body re-arms the timer as it
 * is read.
 */
async function requestUnlessStalled(
  url: string,
  o: RequestOptions,
  stallMs: number,
): Promise<Response> {
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => clearTimeout(timer);
  const arm = () => {
    disarm();
    timer = setTimeout(
      () => stall.abort(new DOMException("no data for too long", "TimeoutError")),
      stallMs,
    );
    // The open connection keeps the process alive while it waits; the timer alone never does.
    timer.unref?.();
  };
  arm();
  const signal = o.signal ? AbortSignal.any([o.signal, stall.signal]) : stall.signal;
  let resp: Response;
  try {
    resp = await request(url, { ...o, timeout: null, signal });
  } catch (e) {
    disarm();
    throw e;
  }
  if (resp.body === null || NULL_BODY.includes(resp.status)) {
    disarm();
    return resp;
  }
  arm();
  const body = resp.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        arm();
        out.enqueue(chunk);
      },
      flush: disarm,
    }),
  );
  const copy = new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
  // `statusError` names the URL the response came from, after any redirect.
  Object.defineProperty(copy, "url", { value: resp.url });
  return copy;
}

/** reqwest's Display for an `error_for_status` error. */
export function statusError(resp: Response): string {
  const kind = resp.status >= 500 ? "server" : "client";
  return `HTTP status ${kind} error (${statusText(resp.status)}) for url (${resp.url})`;
}

/** reqwest's Display for a request that never got a response. */
export function sendError(url: string): string {
  try {
    return `error sending request for url (${new URL(url).href})`;
  } catch {
    return "builder error";
  }
}

/** TS-only: what a stalled transfer adds to its error (Rust's client never times out). */
export function stallNote(e: unknown): string {
  return e instanceof Error && e.name === "TimeoutError"
    ? `: timed out after ${STALL_MS / 1000} seconds with no data`
    : "";
}

export const BINARY_NAME = "happyview";
/** The v2-to-v3 script rewriter, which the release archive carries beside `happyview`. */
export const CODEMOD_NAME = "happyview-codemod";

/** HappyView ships no Windows build, so a Windows host can't run it. */
function runsLocally(target: string): boolean {
  return !target.includes("windows");
}

/** The refusal for a host HappyView has no build for, given before anything is looked up. */
function requireLocalBuild(target: string): void {
  if (!runsLocally(target))
    throw Failure.usage("running HappyView locally isn't supported on Windows; use WSL");
}

export function assetName(target: string): string {
  return `happyview-${target}.tar.xz`;
}

/** Where a binary sits inside the release archive: cargo-dist nests it under `happyview-<triple>/`. */
function archiveEntry(target: string, name: string): string {
  return `happyview-${target}/${name}`;
}

/** `char::is_whitespace`: Unicode White_Space, which (unlike `\s`) leaves out U+FEFF. */
const RUST_WHITESPACE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/**
 * The digest in a `.sha256` file, which leads with the hex digest and may follow it with the
 * file name.
 */
export function parseSha256(text: string): Uint8Array | undefined {
  const token = text.split(RUST_WHITESPACE).find((t) => t !== "");
  if (token === undefined) return undefined;
  if (token.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(token)) return undefined;
  const bytes = Buffer.from(token, "hex");
  return bytes.length === 32 ? new Uint8Array(bytes) : undefined;
}

/**
 * A name that climbs out of, or starts above, wherever the archive would be unpacked. Judged on
 * the text with both separators, so a Windows-shaped name is caught too.
 */
function escapes(name: string): boolean {
  const drive = name.length >= 2 && /^[A-Za-z]:/.test(name);
  return (
    name.startsWith("/") ||
    name.startsWith("\\") ||
    drive ||
    name.split(/[/\\]/).some((part) => part === "..")
  );
}

/** One archive entry, as far as the extraction rules care. */
interface Entry {
  name: string;
  link: boolean;
  file: boolean;
}

/**
 * The release archive is refused whole if any entry could write outside its own directory or
 * is a link, even though only one entry is ever read: an archive shaped like that did not come
 * from HappyView's release build.
 */
function checkEntry(entry: Entry, want: string): boolean {
  if (escapes(entry.name))
    throw Failure.runtime(
      `the release archive holds \`${entry.name}\`, which points outside the archive; nothing was installed`,
    );
  if (entry.link)
    throw Failure.runtime(
      `the release archive holds a link at \`${entry.name}\`; nothing was installed`,
    );
  return entry.file && entry.name === want;
}

// ---------------------------------------------------------------------------------------------
// The tar crate's reader (0.4), as far as `Archive::entries` goes: ustar, GNU and old headers,
// GNU long names and pax `path` records.

export interface TarEntry {
  path: string;
  type: number;
  data: Uint8Array;
  /** The header's mode bits. */
  mode: number;
  /** The header's modification time, in seconds. */
  mtime: number;
  /** A link's target: a GNU long link, a pax `linkpath`, or the header's own field. */
  link: string;
  /** Whether the header is ustar or GNU, rather than an old (v7) one. */
  modern: boolean;
}

const lossy = new TextDecoder("utf-8", { ignoreBOM: true });

function cstr(b: Uint8Array): Uint8Array {
  const nul = b.indexOf(0);
  return nul === -1 ? b : b.subarray(0, nul);
}

function octal(field: Uint8Array): number {
  // Base-256 (the GNU extension for large values).
  if (field[0]! & 0x80) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  const text = lossy.decode(cstr(field)).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error(`numeric field was not a number: ${text}`);
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function paxPath(data: Uint8Array, key = "path"): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const len = Number.parseInt(lossy.decode(data.subarray(off, space)), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(space + 1, off + len - 1);
    const eq = record.indexOf(0x3d);
    if (eq !== -1 && lossy.decode(record.subarray(0, eq)) === key) found = record.subarray(eq + 1);
    off += len;
  }
  return found;
}

export function* tarEntries(bytes: Uint8Array): Generator<TarEntry> {
  let off = 0;
  let longName: Uint8Array | undefined;
  let longLink: Uint8Array | undefined;
  let pax: Uint8Array | undefined;
  while (off < bytes.length) {
    if (bytes.length - off < 512) throw new Error("failed to read entire block");
    const h = bytes.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (octal(h.subarray(148, 156)) !== sum) throw new Error("archive header checksum mismatch");
    const size = octal(h.subarray(124, 136));
    const type = h[156]!;
    const start = off + 512;
    if (start + size > bytes.length) throw new Error("unexpected EOF during skip");
    const data = bytes.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    const magic = lossy.decode(h.subarray(257, 263));
    const ustar = magic === "ustar\0" && lossy.decode(h.subarray(263, 265)) === "00";
    const gnu = magic === "ustar " && lossy.decode(h.subarray(263, 265)) === " \0";
    if ((ustar || gnu) && type === 0x4c /* L */) {
      if (longName) throw new Error("two long name entries describing the same member");
      longName = data;
      continue;
    }
    if ((ustar || gnu) && type === 0x4b /* K */) {
      if (longLink) throw new Error("two long name entries describing the same member");
      longLink = data;
      continue;
    }
    if ((ustar || gnu) && type === 0x78 /* x */) {
      if (pax) throw new Error("two pax extensions entries describing the same member");
      pax = data;
      continue;
    }
    let path: Uint8Array;
    const fromPax = pax ? paxPath(pax) : undefined;
    if (longName) {
      path = longName.at(-1) === 0 ? longName.subarray(0, -1) : longName;
    } else if (fromPax) {
      path = fromPax;
    } else {
      const name = cstr(h.subarray(0, 100));
      const prefix = ustar ? cstr(h.subarray(345, 500)) : new Uint8Array();
      path = prefix.length ? Buffer.concat([prefix, Buffer.from("/"), name]) : name;
    }
    let link: Uint8Array;
    const linkFromPax = pax ? paxPath(pax, "linkpath") : undefined;
    if (longLink) link = longLink.at(-1) === 0 ? longLink.subarray(0, -1) : longLink;
    else if (linkFromPax) link = linkFromPax;
    else link = cstr(h.subarray(157, 257));
    longName = undefined;
    longLink = undefined;
    pax = undefined;
    yield {
      path: lossy.decode(path),
      type,
      data,
      mode: octal(h.subarray(100, 108)),
      mtime: octal(h.subarray(136, 148)),
      link: lossy.decode(link),
      modern: ustar || gnu,
    };
  }
}

/**
 * The bytes of the binary called `name` (`happyview`, or a helper beside it) in a release
 * archive, taken from the one entry cargo-dist puts it at and nowhere else.
 */
export function extractNamed(archive: Uint8Array, target: string, name: string): Uint8Array {
  const want = archiveEntry(target, name);
  let found: Uint8Array | undefined;
  let tar: Uint8Array;
  try {
    tar = xz.decompressSync(archive);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  try {
    for (const entry of tarEntries(tar)) {
      const described: Entry = {
        name: entry.path,
        // '2' symlink, '1' hard link; '0' and NUL are regular files.
        link: entry.type === 0x32 || entry.type === 0x31,
        file: entry.type === 0x30 || entry.type === 0,
      };
      if (checkEntry(described, want)) {
        if (found !== undefined)
          throw Failure.runtime(
            `the release archive holds \`${want}\` more than once; nothing was installed`,
          );
        found = new Uint8Array(entry.data);
      }
    }
  } catch (e) {
    if (e instanceof Failure) throw e;
    throw Failure.runtime((e as Error).message);
  }
  if (found === undefined) throw Failure.runtime(`the release archive holds no \`${want}\``);
  return found;
}

const GITHUB_RELEASES = array(
  struct("GithubRelease", {
    tag_name: str,
    draft: withDefault(bool, false),
    assets: withDefault(array(struct("GithubAsset", { name: str })), () => []),
  }),
);

/**
 * How many pages of releases `latestVersion` reads before giving up. At a hundred a page that
 * is far more releases than the repository will have.
 */
export const MAX_RELEASE_PAGES = 20;

/** The `rel="next"` target of a GitHub `Link` header. */
export function nextPage(link: string): string | undefined {
  for (const part of link.split(",")) {
    const semi = part.indexOf(";");
    if (semi === -1) continue;
    const [url, params] = [part.slice(0, semi), part.slice(semi + 1)];
    const isNext = params.split(";").some((p) => p.trim().toLowerCase() === 'rel="next"');
    const trimmed = url.trim();
    if (!trimmed.startsWith("<") || !trimmed.endsWith(">") || trimmed.length < 2) continue;
    if (isNext) return trimmed.slice(1, -1);
  }
  return undefined;
}

/**
 * The newest stable release carrying a binary for `target`, or the newest prerelease when no
 * stable one does. Releases from before HappyView shipped native binaries carry none, so they
 * never qualify. A host HappyView has no build for still pins a version for a project it only
 * deploys, so its releases are judged by the Linux build. Every page is read, because a stable
 * release can sit behind a long run of prereleases.
 */
export async function latestVersion(
  http: HttpClient,
  src: ReleaseSource,
  target: string,
): Promise<string> {
  const judged = runsLocally(target) ? target : "x86_64-unknown-linux-musl";
  const asset = assetName(judged);
  const shipped: Version[] = [];
  let url: string | undefined = `${src.api}/repos/${src.repo}/releases?per_page=100`;
  let pages = 0;
  while (url !== undefined) {
    const page: string = url;
    url = undefined;
    if (pages === MAX_RELEASE_PAGES)
      throw Failure.runtime(
        `HappyView lists more than ${MAX_RELEASE_PAGES} pages of releases; ` +
          "set [happyview] version in happyview.toml instead",
      );
    pages++;
    let resp: Response;
    try {
      resp = await http.request(page, { headers: { accept: "application/vnd.github+json" } });
    } catch (e) {
      throw Failure.runtime(`could not list HappyView releases: ${sendError(page)}${stallNote(e)}`);
    }
    if (resp.status >= 400) {
      await resp.body?.cancel();
      throw Failure.runtime(`could not list HappyView releases: ${statusError(resp)}`);
    }
    const link = resp.headers.get("link");
    url = link !== null ? nextPage(link) : undefined;
    let releases: { tag_name: string; draft: boolean; assets: { name: string }[] }[];
    try {
      const bytes = new Uint8Array(await resp.arrayBuffer());
      releases = fromStr(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        GITHUB_RELEASES,
      );
    } catch {
      throw Failure.runtime(`could not read HappyView releases: ${DECODE_ERROR}`);
    }
    for (const r of releases) {
      if (r.draft || !r.assets.some((a) => a.name === asset)) continue;
      try {
        shipped.push(Version.parse(r.tag_name.replace(/^v+/, "")));
      } catch {}
    }
  }
  const max = (vs: Version[]) =>
    vs.reduce<Version | undefined>(
      (best, v) => (best === undefined || Version.compare(v, best) >= 0 ? v : best),
      undefined,
    );
  const best = max(shipped.filter((v) => v.pre.isEmpty())) ?? max(shipped);
  if (best === undefined) throw Failure.runtime(`no HappyView release ships ${asset} yet`);
  return best.toString();
}

async function fetchBytes(http: HttpClient, url: string): Promise<Uint8Array | undefined> {
  let resp: Response;
  try {
    resp = await http.request(url);
  } catch (e) {
    throw Failure.runtime(`could not download ${url}: ${sendError(url)}${stallNote(e)}`);
  }
  if (resp.status === 404) {
    await resp.body?.cancel();
    return undefined;
  }
  if (resp.status >= 400) {
    await resp.body?.cancel();
    throw Failure.runtime(`could not download ${url}: ${statusError(resp)}`);
  }
  try {
    return new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    throw Failure.runtime(
      `could not download ${url}: request or response body error for url (${resp.url})${stallNote(e)}`,
    );
  }
}

/** The cached binary for `version`, downloaded and verified first if it is not there yet. */
export function ensureBinary(
  http: HttpClient,
  src: ReleaseSource,
  root: string,
  version: string,
  target: string,
  status: (msg: string) => void,
): Promise<string> {
  return ensureNamed(http, src, root, version, target, BINARY_NAME, status);
}

/**
 * The cached `happyview-codemod` of `version`, from the same verified archive `ensureBinary`
 * reads. `HPY_HAPPYVIEW_CODEMOD` names one to use instead, for testing.
 */
export async function ensureCodemod(
  http: HttpClient,
  src: ReleaseSource,
  root: string,
  version: string,
  target: string,
  status: (msg: string) => void,
): Promise<string> {
  const named = process.env.HPY_HAPPYVIEW_CODEMOD;
  if (named !== undefined && named !== "") return named;
  return ensureNamed(http, src, root, version, target, CODEMOD_NAME, status);
}

export async function ensureNamed(
  http: HttpClient,
  src: ReleaseSource,
  root: string,
  version: string,
  target: string,
  name: string,
  status: (msg: string) => void,
): Promise<string> {
  requireLocalBuild(target);
  // The version names a cache directory, so anything but a version could point it elsewhere.
  try {
    Version.parse(version);
  } catch {
    throw Failure.usage(
      `\`${version}\` is not a HappyView version; set [happyview] version in happyview.toml to one, like 3.0.0`,
    );
  }
  const path = withFileName(binaryPath(root, version, target), name);
  if (isFile(path)) return path;
  const asset = assetName(target);
  const url = `${src.download}/v${version}/${asset}`;
  const missing = () =>
    Failure.usage(
      `HappyView ${version} has no ${asset}; pick another [happyview] version in happyview.toml`,
    );
  const sum = await fetchBytes(http, `${url}.sha256`);
  if (sum === undefined) throw missing();
  const want = parseSha256(new TextDecoder("utf-8", { ignoreBOM: true }).decode(sum));
  if (want === undefined) throw Failure.runtime(`${asset}.sha256 holds no sha256 digest`);
  status(`downloading HappyView ${version} for ${target}`);
  const archive = await fetchBytes(http, url);
  if (archive === undefined) throw missing();
  const got = createHash("sha256").update(archive).digest();
  if (!got.equals(want))
    throw Failure.runtime(
      `the downloaded ${asset} does not match its published .sha256; nothing was installed`,
    );
  const binary = extractNamed(archive, target, name);
  try {
    installFile(path, binary, true);
  } catch (e) {
    throw Failure.runtime(toIoError(e).message);
  }
  return path;
}
