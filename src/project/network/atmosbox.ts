// crates/hpy/src/project/network/atmosbox.rs: Atmosphere in a Box, pinned. Each project gets its
// own checkout in `hpy`'s data directory, never inside the project: the checkout's `state/`
// holds the sandbox's private CA key, and the project is bind-mounted into a container.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { Failure } from "../../core/failure.ts";
import { createDirAll, ioErrorText, readToString, writeString } from "../../core/io.ts";
import { dataBase, rustFileName, rustJoin, rustParent } from "../../core/paths.ts";
import { Version } from "../../core/semver.ts";
import { type HttpClient, sendError, statusError, tarEntries } from "../binary.ts";
import { mustWithEnv, type Runner } from "./runner.ts";

export const VERSION = "v0.7.1";
export const DENO_FLOOR = "2.8.0";

export interface Pinned {
  url: string;
  sha256: string;
  /** The archive's single top-level directory. */
  top: string;
}

export const PINNED: Pinned = Object.freeze({
  url: "https://tangled.org/kandake.africa/atmosphereinabox/archive/v0.7.1",
  sha256: "73bd22ac78ba137a2b5e9b8ffb88944232f1d25f0df42cdd5ab70e8d12bb526c",
  top: "atmosphereinabox-v0.7.1",
});

/**
 * Holds the sha256 of the archive the checkout was installed from, so a checkout from any other
 * archive is installed again.
 */
export const INSTALLED = ".hpy-installed";

/** The third octet Atmosphere in a Box's own default subnet uses, which a hand-made sandbox would already hold. */
const DEFAULT_SUBNET_OCTET = 249;

export interface NetworkDir {
  dir: string;
  /** The sandbox's Compose project name: Atmosphere in a Box requires `^[a-z][a-z0-9-]*$`. */
  project: string;
  /**
   * The sandbox's network, chosen here because Atmosphere in a Box's `--subnet auto` needs a
   * local Linux Docker engine and refuses Docker Desktop. Derived from the project's path, so
   * it never changes for one project and two projects rarely share one.
   */
  subnet: string;
}

const runtime = (e: unknown): Failure => Failure.runtime(ioErrorText(e));

export function subnetFor(digest: Uint8Array): string {
  const first = digest[0]!;
  const octet = first === DEFAULT_SUBNET_OCTET ? DEFAULT_SUBNET_OCTET + 1 : first;
  return `172.30.${octet}.0/24`;
}

export function dataRoot(): string {
  const dir = process.env.HPY_DATA_DIR;
  if (dir !== undefined && dir !== "") return dir;
  return rustJoin(dataBase(), "hpy");
}

/** `std::fs::canonicalize`, throwing a runtime failure with Rust's text. */
export function canonicalize(p: string): string {
  try {
    return realpathSync.native(p);
  } catch (e) {
    throw runtime(e);
  }
}

/**
 * One sandbox per project, keyed by the project's canonical path so `.`, symlinks and trailing
 * slashes all land on the same one.
 */
export function networkDir(dataRoot: string, projectRoot: string): NetworkDir {
  const canonical = canonicalize(projectRoot);
  const digest = createHash("sha256").update(canonical, "utf8").digest();
  const hash = digest.toString("hex");
  const mapped = [...(rustFileName(canonical) ?? "").replace(/[A-Z]/g, (c) => c.toLowerCase())]
    .map((c) => (/^[a-z0-9]$/.test(c) ? c : "-"))
    .join("");
  const joined = mapped
    .split("-")
    .filter((s) => s !== "")
    .join("-");
  // Truncating can leave a dangling separator.
  const name = [...joined].slice(0, 24).join("").replace(/-+$/, "");
  const slug = `${name === "" ? "project" : name}-${hash.slice(0, 8)}`;
  return {
    dir: rustJoin(dataRoot, "networks", slug),
    project: `hv-${slug}`,
    subnet: subnetFor(digest),
  };
}

export function parseDenoVersion(out: string): Version | undefined {
  const first = out.split("\n")[0];
  if (first === undefined || (first === "" && out === "")) return undefined;
  const line = first.endsWith("\r") ? first.slice(0, -1) : first;
  if (!line.startsWith("deno ")) return undefined;
  const v = line
    .slice(5)
    .split(/\p{White_Space}+/u)
    .find((t) => t !== "");
  if (v === undefined) return undefined;
  try {
    return Version.parse(v);
  } catch {
    return undefined;
  }
}

export async function checkTools(r: Runner, cwd: string): Promise<void> {
  const floor = Version.parse(DENO_FLOOR);
  let deno: string;
  try {
    deno = await r.capture("deno", ["--version"], cwd);
  } catch {
    throw Failure.usage(
      `--network local needs Deno ${DENO_FLOOR} or later: https://docs.deno.com/runtime/getting_started/installation/`,
    );
  }
  const found = parseDenoVersion(deno);
  if (found === undefined || Version.compare(found, floor) < 0) {
    throw Failure.usage(
      `--network local needs Deno 2.8 or later (found ${found === undefined ? "an unreadable version" : found.toString()}); run \`deno upgrade\``,
    );
  }
  try {
    await r.capture("docker", ["compose", "version"], cwd);
  } catch {
    throw Failure.usage(
      "--network local needs Docker with Docker Compose v2 (`docker compose version` failed)",
    );
  }
}

function installed(checkout: string, pinned: Pinned): boolean {
  try {
    return readToString(rustJoin(checkout, INSTALLED)).trim() === pinned.sha256;
  } catch {
    return false;
  }
}

/**
 * Downloads and unpacks the pinned archive unless the checkout is already there. Runs no
 * child, so it can be abandoned part way; `installCheckout` finishes the job.
 */
export async function fetchCheckout(
  http: HttpClient,
  pinned: Pinned,
  net: NetworkDir,
  status: (m: string) => void,
): Promise<string> {
  const checkout = rustJoin(net.dir, pinned.top);
  if (installed(checkout, pinned)) return checkout;
  // A checkout with state in it is a sandbox; re-extracting over it could pair its state with
  // files it was not made from. Finish the install instead.
  if (!existsSync(rustJoin(checkout, "state"))) {
    status(`downloading Atmosphere in a Box ${VERSION}`);
    const failed = (m: string) => Failure.runtime(`could not download Atmosphere in a Box: ${m}`);
    let resp: Response;
    try {
      resp = await http.request(pinned.url);
    } catch {
      throw failed(sendError(pinned.url));
    }
    if (resp.status >= 400) throw failed(statusError(resp));
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch {
      throw failed(`error decoding response body`);
    }
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== pinned.sha256) {
      throw Failure.runtime(
        `the Atmosphere in a Box archive has sha256 ${got}, which does not match the pinned ${pinned.sha256}; nothing was installed`,
      );
    }
    try {
      createDirAll(net.dir);
      if (existsSync(checkout)) rmSync(checkout, { recursive: true });
    } catch (e) {
      throw runtime(e);
    }
    // Unpacking refuses entries that would land outside the destination, which is what makes
    // unpacking a downloaded archive safe.
    try {
      unpackTarGz(bytes, net.dir);
    } catch (e) {
      throw Failure.runtime(`could not unpack Atmosphere in a Box: ${(e as Error).message}`);
    }
  }
  return checkout;
}

/**
 * Caches the checkout's dependencies at exactly the versions its shipped `deno.lock` names,
 * once per archive.
 *
 * This is the `install` task's own command rather than `deno task install --frozen`: the task
 * runner also reads `package.json`, whose devDependencies the shipped lock leaves out, so it
 * refuses a frozen install of the pristine v0.7.1 archive.
 */
export async function installCheckout(r: Runner, pinned: Pinned, checkout: string): Promise<void> {
  if (installed(checkout, pinned)) return;
  await mustWithEnv(
    r,
    "deno",
    ["install", "--frozen", "--entrypoint", "bin/sandbox.ts", "runtime/accounts.mjs"],
    [["DENO_NO_PACKAGE_JSON", "1"]],
    checkout,
  );
  try {
    writeString(rustJoin(checkout, INSTALLED), pinned.sha256);
  } catch (e) {
    throw runtime(e);
  }
}

// ---------------------------------------------------------------------------------------------
// tar 0.4's `Archive::unpack` over flate2's `GzDecoder`, as far as a git-made source archive
// needs: directories (made last, as tar does, so their modes cannot block what goes in them),
// regular files, symlinks and hard links. An entry with a `..` component is skipped, a leading
// `/` is dropped, and an entry whose parent resolves outside the destination is refused. Modes
// are the header's lower nine bits, and modification times are kept.

function unpackTarGz(gz: Uint8Array, dst: string): void {
  const tar = gunzipSync(gz);
  createDirAll(dst);
  const root = realpathSync.native(dst);
  const dirs: [string, number, number][] = [];
  for (const entry of tarEntries(tar)) {
    // pax global headers and the like carry no file.
    if (entry.type === 0x67 /* g */ || entry.type === 0x78 /* x */) continue;
    const parts: string[] = [];
    let skip = false;
    for (const part of entry.path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        skip = true;
        break;
      }
      parts.push(part);
    }
    if (skip || parts.length === 0) continue;
    const target = rustJoin(dst, ...parts);
    const parent = rustParent(target)!;
    createDirAll(parent);
    const real = realpathSync.native(parent);
    if (real !== root && !real.startsWith(`${root}${sep}`))
      throw new Error(`trying to unpack outside of destination path: ${root}`);
    const isDir = entry.type === 0x35 || (!entry.modern && entry.path.endsWith("/"));
    if (isDir) {
      if (!existsSync(target)) mkdirSync(target);
      dirs.push([target, entry.mode & 0o777, entry.mtime]);
      continue;
    }
    removeExisting(target);
    if (entry.type === 0x32 /* symlink */) {
      symlinkSync(entry.link, target);
      continue;
    }
    if (entry.type === 0x31 /* hard link */) {
      linkSync(rustJoin(dst, entry.link), target);
      continue;
    }
    writeFileSync(target, entry.data);
    chmodSync(target, entry.mode & 0o777);
    utimesSync(target, entry.mtime, entry.mtime);
  }
  for (const [dir, mode, mtime] of dirs) {
    chmodSync(dir, mode);
    utimesSync(dir, mtime, mtime);
  }
}

function removeExisting(path: string): void {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory()) unlinkSync(path);
  } catch {}
}

/** Whether `p` is a regular file, following links (`Path::is_file`). */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
