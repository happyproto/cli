// crates/hpy/src/project/network/access.rs: reaching the sandbox from this computer's browser,
// which OAuth needs. The steps stay the developer's: `hpy` prints them, checks what it can, and
// never edits the hosts file or a trust store.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Ctx } from "../../core/ctx.ts";
import { Failure } from "../../core/failure.ts";
import { createDirAll, ioErrorText, readToString, writeString } from "../../core/io.ts";
import { rustJoin } from "../../core/paths.ts";
import { lines, trim } from "../../core/rust-str.ts";
import { str, struct } from "../../core/serde-json.ts";
import { encStr, encStruct, fromStr, toTomlString } from "../../core/toml.ts";
import type { Sandbox } from "./sandbox.ts";

const RECORD = "access.toml";

/**
 * Where the developer's word that they trust the CA is kept. Deleting it is how they ask for
 * the walkthrough again, since `hpy` cannot see a trust store and so cannot notice the trust
 * being removed.
 */
export function recordPath(networkDir: string): string {
  return rustJoin(networkDir, RECORD);
}

/** `str::split_whitespace`. */
const words = (s: string): string[] => s.split(/\p{White_Space}+/u).filter((w) => w !== "");

export function parseHostsBlock(out: string): [string, string][] {
  const found: [string, string][] = [];
  for (const raw of lines(out)) {
    const l = trim(raw);
    if (l === "" || l.startsWith("#")) continue;
    const [ip, host] = words(l);
    if (ip !== undefined && host !== undefined) found.push([ip, host]);
  }
  return found;
}

export function missingHosts(hostsFile: string, wanted: readonly [string, string][]): string[] {
  const present: [string, string[]][] = [];
  for (const line of lines(hostsFile)) {
    const [ip, ...names] = words(line.split("#")[0] ?? "");
    if (ip !== undefined) present.push([ip, names]);
  }
  return wanted
    .filter(([ip, host]) => !present.some(([i, names]) => i === ip && names.includes(host)))
    .map(([ip, host]) => `${ip} ${host}`);
}

/** A change to the CA's file means a new CA, which has to be trusted again. */
export function caSha256(checkout: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(rustJoin(checkout, "state/ca/root.crt"));
  } catch (e) {
    throw Failure.runtime(
      `the sandbox has no public CA yet (state/ca/root.crt: ${ioErrorText(e)})`,
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export interface AccessRecord {
  /** The CA the developer last confirmed trusting. */
  ca_sha256: string;
}

export const ACCESS_RECORD = struct("AccessRecord", { ca_sha256: str });
export const encAccessRecord = encStruct<AccessRecord>("AccessRecord", { ca_sha256: encStr });

export const AccessRecord = {
  load(dir: string): AccessRecord | undefined {
    let text: string;
    try {
      text = readToString(recordPath(dir));
    } catch {
      return undefined;
    }
    try {
      return fromStr(text, ACCESS_RECORD);
    } catch {
      return undefined;
    }
  },

  save(record: AccessRecord, dir: string): void {
    try {
      createDirAll(dir);
      writeString(recordPath(dir), toTomlString(record, encAccessRecord));
    } catch (e) {
      throw Failure.runtime(ioErrorText(e));
    }
  },
} as const;

export interface AccessCheck {
  missingHosts: string[];
  caTrusted: boolean;
}

export function assess(
  block: string,
  hostsFile: string,
  ca: string,
  record: AccessRecord | undefined,
): AccessCheck {
  return {
    missingHosts: missingHosts(hostsFile, parseHostsBlock(block)),
    caTrusted: record !== undefined && record.ca_sha256 === ca,
  };
}

export function walkthroughText(check: AccessCheck, caPath: string, record: string): string {
  const out: string[] = [];
  if (check.missingHosts.length > 0) {
    out.push(
      `Add these lines to /etc/hosts (it needs sudo; hpy does not edit it):\n\n  ${check.missingHosts.join("\n  ")}\n`,
    );
  }
  if (!check.caTrusted) {
    out.push(
      `Trust the sandbox's certificate authority in your browser or OS (hpy does not edit trust stores):\n\n  ${caPath}\n\n` +
        "On macOS: open it in Keychain Access, add it to the System keychain, and set it to Always Trust.\n" +
        "On Linux: import it in your browser's certificate settings, under Authorities.\n" +
        "Import only this file; never the sandbox's private key.\n\n" +
        `hpy records that you trusted it in ${record}. If you remove that trust later, or your browser ` +
        "reports a certificate error for the local HappyView, delete that file and hpy walks you " +
        "through this again.",
    );
  }
  return out.join("\n");
}

export async function ensureAccess(
  ctx: Ctx,
  sandbox: Sandbox,
  networkDir: string,
  hostsPath: string,
): Promise<void> {
  const caPath = rustJoin(sandbox.checkout, "state/ca/root.crt");
  for (;;) {
    const block = await sandbox.hostsBlock();
    let hosts = "";
    try {
      hosts = readToString(hostsPath);
    } catch {}
    const ca = caSha256(sandbox.checkout);
    const record = AccessRecord.load(networkDir);
    const check = assess(block, hosts, ca, record);
    const text = walkthroughText(check, caPath, recordPath(networkDir));
    if (text === "") break;
    if (!ctx.prompter.isInteractive()) {
      throw Failure.usage(
        `this computer cannot reach the local network yet:\n\n${text}\n\nthen run this again from a terminal`,
      );
    }
    ctx.out.status(`\nOne-time setup, so your browser can reach the local network:\n\n${text}\n`);
    if (!(await ctx.prompter.confirm("Done?", false))) throw Failure.runtime("cancelled");
    // Hosts are checked again on the next pass; trust cannot be checked from here, so the
    // developer's word is recorded against this CA.
    if (!check.caTrusted) AccessRecord.save({ ca_sha256: ca }, networkDir);
  }
  await sandbox.accessStart();
}
