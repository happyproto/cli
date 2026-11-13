// crates/hpy/src/project/network/accounts.rs: the sandbox user who is the local instance's
// superadmin. A developer's real DID cannot sign in to a sandbox PDS, so the first seeded user
// stands in.
import { inspect } from "node:util";
import { debugStr } from "../../core/debug.ts";
import { Failure } from "../../core/failure.ts";
import { type IoError, readToString } from "../../core/io.ts";
import { rustJoin } from "../../core/paths.ts";
import { get, type Node, parseValue } from "../../core/serde-json.ts";

export const SUPERADMIN_HANDLE = "user1.pds1.atmosbox.test";

export class SeededAccount {
  readonly handle: string;
  readonly did: string;
  readonly password: string;

  constructor(handle: string, did: string, password: string) {
    this.handle = handle;
    this.did = did;
    this.password = password;
  }

  /** Rust's hand-written `Debug`, so the password cannot reach a log through `{:?}`. */
  debug(): string {
    return `SeededAccount { handle: ${debugStr(this.handle)}, did: ${debugStr(this.did)}, password: "<redacted>" }`;
  }

  toJSON(): { handle: string; did: string; password: string } {
    return { handle: this.handle, did: this.did, password: "<redacted>" };
  }

  [inspect.custom](): string {
    return this.debug();
  }
}

/** The sandbox's record of the accounts `seed` created, passwords included. */
export function accountsPath(checkout: string): string {
  return rustJoin(checkout, "state/accounts.json");
}

/** `undefined` until `seed` has created the account and recorded its DID. */
export function seededSuperadmin(checkout: string): SeededAccount | undefined {
  const path = accountsPath(checkout);
  let text: string;
  try {
    text = readToString(path);
  } catch (e) {
    if ((e as IoError).code === "ENOENT") return undefined;
    throw Failure.runtime(`state/accounts.json: ${(e as Error).message}`);
  }
  let v: Node;
  try {
    v = parseValue(text);
  } catch (e) {
    throw Failure.runtime(`state/accounts.json is not readable: ${(e as Error).message}`);
  }
  const accounts = get(v, "accounts");
  const entry = accounts === undefined ? undefined : get(accounts, SUPERADMIN_HANDLE);
  const s = (key: string): string | undefined => {
    const n = entry === undefined ? undefined : get(entry, key);
    return n?.kind === "string" ? n.value : undefined;
  };
  // An account that is still being created may already carry a DID.
  if (s("phase") !== "ready") return undefined;
  const did = s("did");
  const password = s("password");
  if (did === undefined || password === undefined) return undefined;
  return new SeededAccount(SUPERADMIN_HANDLE, did, password);
}
