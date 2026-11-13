// crates/hpy/src/update.rs: update checks, on the first command of each UTC day, and the
// installing that `hpy update` and `hpy channel` share. Only the newest release on the channel
// being followed counts (see channel.ts).
//
// The check runs in the background while the command does its work, and the command waits for
// it at most a couple of seconds at the end. A copy of `hpy` installed by the shell/PowerShell
// installer (it left an install receipt) updates itself by re-running the new release's
// installer into the same place, or, where that place is not writable (the shell installer's
// `/usr/local/bin`), by running it into a temporary directory and asking sudo to copy the binary
// over this one; one installed by Homebrew, apt, dnf or cargo belongs to that package manager,
// so `hpy` only says how to upgrade it.
//
// TS-only: hpy also ships as an npm package, run by Node. That copy belongs to npm (the `npm`
// install kind), and a copy run from a checkout's bundle is never replaced; only the
// Bun-compiled binary replaces itself, as the Rust binary does.
//
// Never in CI, without a terminal, or with `HPY_NO_UPDATE_CHECK` set.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request, statusText, transportError } from "./atproto/http.ts";
import * as channel from "./channel.ts";
import { type Channel, channelOf, RELEASE, type Release, Version } from "./channel.ts";
import { todayUtc } from "./core/clock.ts";
import { ioErrorText, readToString, toIoError, writeString } from "./core/io.ts";
import { type Json, sortKeys } from "./core/output.ts";
import { rustJoin } from "./core/paths.ts";
import { array, fromStr as jsonFromStr, str, struct } from "./core/serde-json.ts";
import { blockingStdio } from "./core/stdio.ts";
import { encStr, encStruct, fromStr as tomlFromStr, toTomlString } from "./core/toml.ts";
import { PACKAGE_NAME, VERSION } from "./core/version.ts";

const REPO = "happyproto/cli";
export const GITHUB_API = "https://api.github.com";
/** The name dist's installers use for receipts and artifacts: the package's. */
const APP = "hpy-cli";
const CURRENT = VERSION;
const WAIT_MS = 2000;
/** The apt and yum repositories, on GitHub Pages. */
const PACKAGES = "https://happyproto.github.io/cli";

/** How this copy was installed. `npm` is TS-only: the npm package, run by Node. */
export type Install = "script" | "homebrew" | "apt" | "dnf" | "cargo" | "npm" | "unknown";

/** What `detect` decides from, gathered by `facts`. */
export interface Facts {
  exe: string;
  scriptReceipt: boolean;
  dpkgOwned: boolean;
  rpmOwned: boolean;
  /** TS-only: this is the npm package's script, under a `node_modules` directory. */
  npm?: boolean;
}

export type Env = (k: string) => string | undefined;

export function due(lastChecked: string | undefined, today: string): boolean {
  return lastChecked !== today;
}

export function enabled(env: Env, terminal: boolean): boolean {
  return terminal && env("CI") === undefined && env("HPY_NO_UPDATE_CHECK") === undefined;
}

export function detect(f: Facts): Install {
  // npm's copy is a script Node runs, wherever npm keeps its global modules (Homebrew's Node
  // puts them under /opt/homebrew), so it is decided first.
  if (f.npm) return "npm";
  if (f.scriptReceipt) return "script";
  const path = f.exe;
  if (
    path.includes("/Cellar/") ||
    path.startsWith("/opt/homebrew/") ||
    path.includes("/.linuxbrew/")
  )
    return "homebrew";
  if (f.dpkgOwned) return "apt";
  if (f.rpmOwned) return "dnf";
  if (path.includes("/.cargo/bin/") || path.includes("\\.cargo\\bin\\")) return "cargo";
  return "unknown";
}

/** The Homebrew formula each channel is published as. */
export function formula(ch: Channel): string {
  return ch === "stable" ? "hpy" : `hpy-${ch}`;
}

/** TS-only: the npm dist-tag each channel is published under (semantic-release's default for `main` is `latest`). */
export function distTag(ch: Channel): string {
  return ch === "stable" ? "latest" : ch;
}

/** The yum repository definition for each channel. */
function yumRepo(ch: Channel): string {
  return ch === "stable" ? `${PACKAGES}/hpy.repo` : `${PACKAGES}/hpy-${ch}.repo`;
}

/** A version as a .deb names it: nfpm writes a prerelease after `~`, which sorts before the release it precedes. */
function debVersion(v: Version): string {
  if (v.pre.isEmpty()) return v.toString();
  return `${v.major}.${v.minor}.${v.patch}~${v.pre}`;
}

function releasePage(version: Version): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`;
}

/** How to upgrade to `version`, the newest on `ch`, when a package manager owns this copy of hpy. */
export function upgradeHint(install: Install, ch: Channel, version: Version): string {
  switch (install) {
    case "homebrew":
      return `brew upgrade ${formula(ch)}`;
    case "apt":
      return "sudo apt update && sudo apt install --only-upgrade hpy";
    case "dnf":
      return "sudo dnf upgrade hpy";
    // `--locked`: without it cargo re-resolves from scratch and builds a dependency set nobody
    // tested, which is also how a yanked transitive dependency makes the build fail outright.
    case "cargo":
      return `cargo install --git https://github.com/${REPO} --tag v${version} --locked hpy-cli --force`;
    // TS-only.
    case "npm":
      return `npm i -g ${PACKAGE_NAME}@${distTag(ch)}`;
    case "script":
    case "unknown":
      return `download it from ${releasePage(version)}`;
  }
}

/** How to move a package manager's copy of hpy from channel `from` to `to`, whose newest release is `version` (possibly older than the one installed). */
export function switchHint(install: Install, from: Channel, to: Channel, version: Version): string {
  switch (install) {
    case "homebrew":
      return `brew uninstall ${formula(from)} && brew install happyproto/tap/${formula(to)}`;
    case "apt":
      return [
        `sudo sed -i 's#/deb [a-z]* main#/deb ${to} main#' /etc/apt/sources.list.d/hpy.list`,
        "sudo apt update",
        `sudo apt install --allow-downgrades hpy=${debVersion(version)}`,
      ].join(" && ");
    // distro-sync moves to the newest the enabled repository has, down as well as up.
    case "dnf":
      return `sudo curl -fsSL ${yumRepo(to)} -o /etc/yum.repos.d/hpy.repo && sudo dnf distro-sync hpy`;
    default:
      return upgradeHint(install, to, version);
  }
}

/** The newest release on `ch`, when it is newer than `current`. */
export function available(
  current: Version,
  ch: Channel,
  releases: readonly Release[],
): Version | undefined {
  const latest = channel.latestOn(ch, releases);
  return latest !== undefined && Version.compare(latest, current) > 0 ? latest : undefined;
}

/** The running version. */
export function current(): Version {
  return Version.parse(CURRENT);
}

// The daily check's state file.
export const UPDATE_STATE = struct("State", { last_checked: str });
export const encUpdateState = encStruct<{ last_checked: string }>("State", {
  last_checked: encStr,
});

export function readLastChecked(path: string): string | undefined {
  let text: string;
  try {
    text = readToString(path);
  } catch {
    return undefined;
  }
  try {
    return tomlFromStr(text, UPDATE_STATE).last_checked;
  } catch {
    return undefined;
  }
}

/** Throws an `IoError`. */
export function writeLastChecked(path: string, day: string): void {
  mkdirAll(dirname(path));
  writeString(path, toTomlString({ last_checked: day }, encUpdateState));
}

function mkdirAll(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw toIoError(e);
  }
}

/** Where dist's installers write their receipt (the same place `axoupdater` reads it from). */
export function receiptPath(env: Env, windows: boolean): string | undefined {
  let base: string;
  if (windows) {
    const local = env("LOCALAPPDATA");
    if (local === undefined) return undefined;
    base = local;
  } else {
    const xdg = env("XDG_CONFIG_HOME");
    if (xdg !== undefined) base = xdg;
    else {
      const home = env("HOME");
      if (home === undefined) return undefined;
      base = rustJoin(home, ".config");
    }
  }
  return rustJoin(base, APP, `${APP}-receipt.json`);
}

const RECEIPT = struct("Receipt", { install_prefix: str });

export function receiptPrefix(receipt: string): string | undefined {
  try {
    return jsonFromStr(receipt, RECEIPT).install_prefix;
  } catch {
    return undefined;
  }
}

/** `Path::canonicalize`, or `undefined` on any error. */
function canonicalize(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** `Path::parent`: `undefined` for a root or an empty path. */
function parent(p: string): string | undefined {
  const d = dirname(p);
  return d === p ? undefined : d;
}

/**
 * Whether `exe` is the binary a receipt with this install prefix put there, and not, say, a
 * package manager's copy on a machine that also once ran the installer. The installer puts
 * binaries in `<prefix>/bin` or `<prefix>`.
 */
export function installedByReceipt(exe: string, prefix: string): boolean {
  const e = canonicalize(exe);
  const p = canonicalize(prefix);
  if (e === undefined || p === undefined) return false;
  const dir = parent(e);
  if (dir === undefined) return false;
  return dir === p || (basename(dir) === "bin" && parent(dir) === p);
}

export function installerUrl(version: string, windows: boolean): string {
  const ext = windows ? "ps1" : "sh";
  return `https://github.com/${REPO}/releases/download/v${version}/${APP}-installer.${ext}`;
}

/** The repo's newest releases, or `undefined` on any failure: an update check must never get in the way of the command. */
export async function listReleases(
  apiBase: string,
  signal?: AbortSignal,
): Promise<Release[] | undefined> {
  try {
    const resp = await request(`${apiBase}/repos/${REPO}/releases`, {
      query: [["per_page", "100"]],
      headers: { accept: "application/vnd.github+json" },
      timeout: 5,
      ...(signal ? { signal } : {}),
    });
    if (resp.status < 200 || resp.status > 299) return undefined;
    return jsonFromStr(await resp.text(), array(RELEASE));
  } catch {
    return undefined;
  }
}

/** The releases, for a command that cannot go on without them. Throws the message as a string. */
export async function releases(apiBase = GITHUB_API): Promise<Release[]> {
  const found = await listReleases(apiBase);
  if (found === undefined) throw `could not list hpy's releases on GitHub (github.com/${REPO})`;
  return found;
}

export const envVar: Env = (k) => {
  const v = process.env[k];
  return v !== undefined && v !== "" ? v : undefined;
};

const WINDOWS = process.platform === "win32";

/** The install prefix, when this executable came from the installer. */
function scriptPrefix(exe: string, env: Env = envVar): string | undefined {
  const path = receiptPath(env, WINDOWS);
  if (path === undefined) return undefined;
  let receipt: string;
  try {
    receipt = readToString(path);
  } catch {
    return undefined;
  }
  const prefix = receiptPrefix(receipt);
  if (prefix === undefined) return undefined;
  return installedByReceipt(exe, prefix) ? prefix : undefined;
}

/**
 * Where a self-update may write, or `undefined` when something else owns this copy and has to
 * be the one to replace it.
 *
 * Homebrew, apt and dnf keep a database of the files they own: a binary swapped underneath one
 * leaves its records describing a version that is no longer there, and its next upgrade reverts
 * the swap. Those are told how to upgrade with the manager instead, and so is npm (TS-only).
 * Nothing defends the other two — `cargo install` builds and copies into a directory the user
 * owns, and an unknown install is a binary sitting somewhere — so for those the prefix is the
 * directory this executable is in, when it can be written to. Falling back to the hint on a
 * read-only directory keeps the failure a sentence rather than a half-finished install.
 */
export function selfUpdatePrefix(install: Install, exe: string): string | undefined {
  switch (install) {
    case "script":
      return scriptPrefix(exe);
    case "cargo":
    case "unknown": {
      const dir = parent(exe);
      return dir !== undefined && writable(dir) ? dir : undefined;
    }
    case "homebrew":
    case "apt":
    case "dnf":
    case "npm":
      return undefined;
  }
}

/**
 * Whether a directory can be written to, answered by writing to it: the permission bits alone do
 * not account for an owner, an ACL or a read-only mount.
 */
function writable(dir: string): boolean {
  const probe = rustJoin(dir, `.hpy-update-${process.pid}`);
  let fd: number;
  try {
    // `wx` (create_new) so a name that somehow exists is never truncated.
    fd = openSync(probe, "wx");
  } catch {
    return false;
  }
  closeSync(fd);
  try {
    unlinkSync(probe);
  } catch {}
  return true;
}

function facts(exe: string): Facts {
  const underUsr = exe.startsWith("/usr/");
  const dpkgOwned = underUsr && existsSync("/var/lib/dpkg/info/hpy.list");
  const rpmOwned =
    underUsr && !dpkgOwned && spawnSync("rpm", ["-qf", exe], { stdio: "pipe" }).status === 0;
  return { scriptReceipt: scriptPrefix(exe) !== undefined, exe, dpkgOwned, rpmOwned };
}

/** How this copy of hpy was installed; for the installer's, where to. */
export interface This {
  exe: string;
  install: Install;
  prefix: string | undefined;
}

/**
 * TS-only: whether this is a Bun-compiled binary, which is the executable itself; under Node (or
 * `bun run`) the executable is the runtime and the program a script it was given.
 */
export function isCompiledBinary(): boolean {
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  const main = bun?.main;
  return (
    typeof main === "string" &&
    (main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main))
  );
}

/** TS-only: whether `script` (canonical) is a copy npm installed. */
export function inNodeModules(script: string): boolean {
  return script.split(/[\\/]/).includes("node_modules");
}

export function thisInstall(): This | undefined {
  if (isCompiledBinary()) {
    const exe = canonicalize(process.execPath);
    if (exe === undefined) return undefined;
    const install = detect(facts(exe));
    return { exe, install, prefix: selfUpdatePrefix(install, exe) };
  }
  // A script Node runs: npm's, or a checkout's bundle. Neither is a binary to replace.
  const exe = canonicalize(fileURLToPath(import.meta.url));
  if (exe === undefined) return undefined;
  return { exe, install: inNodeModules(exe) ? "npm" : "unknown", prefix: undefined };
}

/** The channel to follow, given the config directory. */
export function following(configDir: string): Channel {
  return channel.effective(channel.read(channelFile(configDir)), current());
}

export function channelFile(configDir: string): string {
  return join(configDir, "channel.toml");
}

type Found =
  | { kind: "selfUpdate"; latest: Version; prefix: string }
  | { kind: "notice"; latest: Version; hint: string };

/** What the daily check depends on, so tests can stand in for each. */
export interface CheckDeps {
  apiBase: string;
  thisInstall: () => This | undefined;
  signal?: AbortSignal;
}

async function check(configDir: string, deps: CheckDeps): Promise<Found | undefined> {
  const self = deps.thisInstall();
  if (self === undefined) return undefined;
  const ch = following(configDir);
  const list = await listReleases(deps.apiBase, deps.signal);
  if (list === undefined) return undefined;
  const latest = available(current(), ch, list);
  if (latest === undefined) return undefined;
  const dir = parent(self.exe);
  const hereWritable = dir !== undefined && writable(dir);
  if (self.prefix !== undefined) {
    // Replacing it would need sudo, which is `hpy update`'s to ask for, not a password prompt at
    // the end of some other command.
    if (!hereWritable && !WINDOWS) return { kind: "notice", hint: "hpy update", latest };
    return { kind: "selfUpdate", latest, prefix: self.prefix };
  }
  return { kind: "notice", hint: upgradeHint(self.install, ch, latest), latest };
}

/**
 * Whether a self-update may ask sudo to replace a copy of hpy in a directory this user cannot
 * write to (the shell installer's `/usr/local/bin`). `hpy update` and `hpy channel` may; the
 * daily check, which runs behind another command, never does.
 */
export type Escalate = "never" | "ask";

/** Why a self-update did not happen. */
export class SelfUpdateError extends Error {
  /**
   * `failed`: the download or the installer failed. `needsRoot`: this copy is in a directory
   * only root can write to, and sudo could not be used: there is no terminal for its password
   * prompt, it failed, or the caller does not allow it. The message says exactly what to run.
   * This copy of hpy is untouched.
   */
  readonly kind: "failed" | "needsRoot";
  constructor(kind: "failed" | "needsRoot", message: string) {
    super(message);
    this.kind = kind;
  }
}

const failed = (m: string) => new SelfUpdateError("failed", m);
const needsRoot = (m: string) => new SelfUpdateError("needsRoot", m);

/**
 * Where the binary sits relative to the install prefix: dist's installer puts it in
 * `<prefix>/bin` (its `cargo-home` layout, the default and `HPY_CLI_INSTALL_DIR`), or in
 * `<prefix>` itself (the `flat` layout the shell installer's `/usr/local/bin` copy is recorded
 * with).
 */
export type Layout = "flat" | "bin";

export function layout(exe: string, prefix: string): Layout | undefined {
  const e = canonicalize(exe);
  const p = canonicalize(prefix);
  if (e === undefined || p === undefined) return undefined;
  const dir = parent(e);
  if (dir === undefined) return undefined;
  if (dir === p) return "flat";
  if (dir === join(p, "bin")) return "bin";
  return undefined;
}

/**
 * Everything a self-update depends on, so that tests can stand in for each: the installer's URL,
 * the copy being replaced, whether there is a terminal, and the program run as sudo.
 */
export interface Job {
  installerUrl: string;
  /** This executable, canonical. */
  exe: string;
  prefix: string;
  version: Version;
  /** Whether sudo could ask for a password: `/dev/tty` opens. */
  terminal: boolean;
  /** `sudo`, found on PATH; a test points this at a shim. */
  sudo: string;
  escalate: Escalate;
  /** The install receipt, whose version is brought up to date as this user. */
  receipt: string | undefined;
}

/** Downloads the release's installer and runs it to replace this copy of hpy where it is. Throws `SelfUpdateError`. */
export async function selfUpdate(
  latest: Version,
  prefix: string,
  escalate: Escalate,
): Promise<void> {
  let exe: string;
  try {
    exe = realpathSync.native(process.execPath);
  } catch (e) {
    throw failed(ioErrorText(e));
  }
  await runJob({
    installerUrl: installerUrl(latest.toString(), WINDOWS),
    exe,
    prefix,
    version: latest,
    terminal: hasTerminal(),
    sudo: "sudo",
    escalate,
    receipt: receiptPath(envVar, WINDOWS),
  });
}

/** reqwest's Display for an `error_for_status` failure. */
function statusError(status: number, url: string): string {
  const kind = status >= 500 ? "server" : "client";
  return `HTTP status ${kind} error (${statusText(status)}) for url (${url})`;
}

async function download(url: string): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await request(url);
  } catch (e) {
    throw failed(transportError(e));
  }
  if (resp.status >= 400) throw failed(statusError(resp.status, resp.url || url));
  try {
    return new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    throw failed(transportError(e));
  }
}

/** Where a run of dist's installer puts hpy. */
type Target =
  /** `<dir>/bin/hpy`, with a receipt naming `<dir>`. */
  | { kind: "cargoHome"; dir: string }
  /** `<dir>/hpy`, with no receipt and no change to shell profiles. */
  | { kind: "flat"; dir: string };

export async function runJob(job: Job): Promise<void> {
  const script = await download(job.installerUrl);
  // A fresh directory only this user can reach (0700), never a name another user could have
  // created first.
  let stage: string;
  try {
    stage = mkdtempSync(join(tmpdir(), "hpy-update-"));
  } catch (e) {
    throw failed(ioErrorText(e));
  }
  // Removed when done, as tempfile's TempDir is on drop, unless kept for a printed command.
  let keep = false;
  try {
    const installer = join(stage, WINDOWS ? "installer.ps1" : "installer.sh");
    try {
      writeFileSync(installer, script);
    } catch (e) {
      throw failed(ioErrorText(e));
    }

    if (WINDOWS) {
      runInstallerOrFail(installer, { kind: "cargoHome", dir: job.prefix });
      return;
    }

    const dir = parent(job.exe);
    if (dir === undefined) throw failed("this copy of hpy is not in a directory");
    const lay = layout(job.exe, job.prefix);
    if (lay === undefined)
      throw failed(
        `${job.exe} is in neither ${job.prefix} nor its bin directory, where it was installed`,
      );

    // Writable: the release's installer, into the same place, as before.
    if (writable(dir)) {
      if (lay === "bin") {
        // dist's installer writes the receipt itself.
        runInstallerOrFail(installer, { kind: "cargoHome", dir: job.prefix });
      } else {
        runInstallerOrFail(installer, { kind: "flat", dir: job.prefix });
        recordVersion(job.receipt, job.prefix, job.version);
      }
      return;
    }

    // Not writable: only root can replace this copy.
    if (job.escalate === "never")
      throw needsRoot(
        `${dir} is not writable by you; run \`hpy update\`, which asks sudo to replace it`,
      );
    const stagedDir = join(stage, "bin");
    runInstallerOrFail(installer, { kind: "flat", dir: stagedDir });
    const staged = join(stagedDir, "hpy");
    if (!isFile(staged)) throw failed(`the installer did not leave hpy in ${stagedDir}`);
    const command = `sudo install -m 0755 ${shellQuote(staged)} ${shellQuote(job.exe)}`;
    if (!job.terminal) {
      // Kept, so the command stays runnable.
      keep = true;
      throw needsRoot(
        `${dir} is not writable by you, and with no terminal sudo cannot ask for your password. hpy ${job.version} is downloaded; to put it in place of this copy, run:\n\n  ${command}\n\nThis copy of hpy was left as it was.`,
      );
    }
    process.stderr.write(
      `${dir} is not writable by you, so sudo will ask for your password to copy hpy ${job.version} over ${job.exe}.\n`,
    );
    // The only command run as root: the copy. stdin and stderr stay the terminal's, so sudo can
    // prompt; stdout stays clear for `--json`.
    blockingStdio();
    const status = spawnSync(job.sudo, ["install", "-m", "0755", staged, job.exe], {
      stdio: ["inherit", "ignore", "inherit"],
    });
    if (status.error !== undefined || status.status !== 0) {
      keep = true;
      throw needsRoot(
        `sudo did not replace ${job.exe}. To try again, run:\n\n  ${command}\n\nThis copy of hpy was left as it was.`,
      );
    }
    recordVersion(job.receipt, job.prefix, job.version);
  } finally {
    if (!keep) rmSync(stage, { recursive: true, force: true });
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function runInstallerOrFail(installer: string, into: Target): void {
  const e = runInstaller(installer, into);
  if (e !== undefined) throw failed(e);
}

/** The installer's error, or `undefined` when it succeeded. */
function runInstaller(installer: string, into: Target): string | undefined {
  const [cmd, args] = WINDOWS
    ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]]
    : ["sh", [installer, "--quiet"]];
  const env: Record<string, string | undefined> = { ...process.env };
  // dist's installer takes HPY_CLI_INSTALL_DIR over the others, so one left in the environment
  // from an install must not redirect this one.
  delete env.HPY_CLI_INSTALL_DIR;
  delete env.CARGO_DIST_FORCE_INSTALL_DIR;
  delete env.HPY_CLI_UNMANAGED_INSTALL;
  if (into.kind === "cargoHome") env.CARGO_DIST_FORCE_INSTALL_DIR = into.dir;
  else env.HPY_CLI_UNMANAGED_INSTALL = into.dir;
  // PATH was set up by the first install; don't touch shell profiles again.
  env.INSTALLER_NO_MODIFY_PATH = "1";
  env.HPY_CLI_NO_MODIFY_PATH = "1";
  const out = spawnSync(cmd as string, args as string[], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 30,
  });
  if (out.error !== undefined) return ioErrorText(out.error);
  if (out.status === 0) return undefined;
  return new TextDecoder().decode(out.stderr).trim();
}

/**
 * Brings the receipt's version up to date after a copy dist's installer did not record (a flat
 * layout), as this user. Only a receipt for this prefix is touched, and a failure is a warning:
 * hpy itself is already replaced.
 */
function recordVersion(receipt: string | undefined, prefix: string, version: Version): void {
  if (receipt === undefined) return;
  try {
    writeReceiptVersion(receipt, prefix, version);
  } catch (e) {
    process.stderr.write(
      `warning: could not record hpy ${version} in ${receipt}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/** `Path`'s `==`: component by component, so `/a//b/` equals `/a/b`. */
function samePath(a: string, b: string): boolean {
  const parts = (p: string) => {
    const xs = p.split("/").filter((s, i) => s !== "" && (s !== "." || i === 0));
    return `${p.startsWith("/") ? "/" : ""}${xs.join("/")}`;
  };
  return parts(a) === parts(b);
}

/** `Path::with_extension`. */
function withExtension(p: string, ext: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return join(dirname(p), `${stem}.${ext}`);
}

/** Throws an `IoError` (or a JSON error, as `io::Error::other`). */
export function writeReceiptVersion(receipt: string, prefix: string, version: Version): boolean {
  let text: string;
  try {
    text = readToString(receipt);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return false;
    throw e;
  }
  const p = receiptPrefix(text);
  const same =
    p !== undefined &&
    (samePath(p, prefix) ||
      (() => {
        const a = canonicalize(p);
        const b = canonicalize(prefix);
        return a !== undefined && b !== undefined && a === b;
      })());
  if (!same) return false;
  // serde_json's `Value` keeps keys sorted; `{value}` is the compact form.
  const value = JSON.parse(text) as { [k: string]: Json };
  value.version = version.toString();
  const tmp = withExtension(receipt, "json.hpy-update");
  try {
    writeFileSync(tmp, `${JSON.stringify(sortKeys(value))}\n`);
    renameSync(tmp, receipt);
  } catch (e) {
    throw toIoError(e);
  }
  return true;
}

/** Whether there is a terminal sudo could prompt on. */
function hasTerminal(): boolean {
  if (WINDOWS) return false;
  try {
    closeSync(openSync("/dev/tty", "r+"));
    return true;
  } catch {
    return false;
  }
}

/** A path as a shell word, for a command printed to be pasted. */
export function shellQuote(path: string): string {
  if (path !== "" && /^[A-Za-z0-9/._+-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** A check started by `start`, finished by `finish`. */
export interface Pending {
  found: Promise<Found | undefined>;
  abort: AbortController;
}

export interface StartOptions {
  env?: Env;
  terminal?: boolean;
  today?: string;
  apiBase?: string;
  thisInstall?: () => This | undefined;
}

/** Starts today's check if this is the first command of the UTC day. */
export function start(configDir: string, o: StartOptions = {}): Pending | undefined {
  if (!enabled(o.env ?? envVar, o.terminal ?? !!process.stderr.isTTY)) return undefined;
  const stateFile = join(configDir, "update-check.toml");
  const today = o.today ?? todayUtc();
  if (!due(readLastChecked(stateFile), today)) return undefined;
  // Recorded up front, so a failed or slow check is not retried by every command for the rest
  // of the day.
  try {
    writeLastChecked(stateFile, today);
  } catch {}
  const abort = new AbortController();
  const found = check(configDir, {
    apiBase: o.apiBase ?? GITHUB_API,
    thisInstall: o.thisInstall ?? thisInstall,
    signal: abort.signal,
  }).catch(() => undefined);
  return { found, abort };
}

export interface FinishOptions {
  waitMs?: number;
  selfUpdate?: (latest: Version, prefix: string, escalate: Escalate) => Promise<void>;
}

/** Waits briefly for the check, then updates or says how to. */
export async function finish(pending: Pending | undefined, o: FinishOptions = {}): Promise<void> {
  if (pending === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), o.waitMs ?? WAIT_MS);
  });
  const found = await Promise.race([pending.found, timeout]);
  clearTimeout(timer);
  // A check still running is dropped with the process, as the Rust task is.
  pending.abort.abort();
  if (found === "timeout" || found === undefined) return;
  if (found.kind === "notice") {
    process.stderr.write(
      `\nhpy ${found.latest} is available (you have ${CURRENT}). To upgrade: ${found.hint}\n`,
    );
    return;
  }
  process.stderr.write(`\nUpdating hpy ${CURRENT} → ${found.latest}…\n`);
  try {
    await (o.selfUpdate ?? selfUpdate)(found.latest, found.prefix, "never");
    process.stderr.write(`Updated hpy to ${found.latest}.\n`);
  } catch (e) {
    process.stderr.write(`${selfUpdateFailed(found.latest, asSelfUpdateError(e))}\n`);
  }
}

function asSelfUpdateError(e: unknown): SelfUpdateError {
  return e instanceof SelfUpdateError ? e : failed(e instanceof Error ? e.message : String(e));
}

export function selfUpdateFailed(latest: Version, error: SelfUpdateError): string {
  if (error.kind === "needsRoot") return `Could not update hpy: ${error.message}`;
  return `Could not update hpy automatically (${error.message}). To update by hand: curl -fsSL ${installScriptUrl(latest)} | sh`;
}

/** The shell installer for `version`'s channel, which installs the newest release on it into /usr/local/bin. */
export function installScriptUrl(version: Version): string {
  const ch = channelOf(version);
  if (ch === "stable") return `${PACKAGES}/install.sh`;
  if (ch !== undefined) return `${PACKAGES}/install-${ch}.sh`;
  return installerUrl(version.toString(), false);
}
