// hpy-atproto/src/credential.rs: the signed-in session, what HappyView needs to
// recognise this device. The DPoP private key is the secret, so it goes in the
// OS keychain and everything else in `credentials.json` (0600). Without a
// usable keychain the key is stored in the file instead. `HPY_CREDENTIAL`
// (from `hpy registry login --export`) takes precedence over both, for CI.
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { createDirAll, ioErrorText, readToString } from "../core/io.ts";
import type { Json } from "../core/output.ts";
import { trim } from "../core/rust-str.ts";
import {
  debugStr,
  fromSlice,
  fromStr,
  node,
  optional,
  str,
  struct,
  u8,
  withDefault,
} from "../core/serde-json.ts";
import { DpopKey } from "./dpop.ts";
import { AtprotoError } from "./error.ts";
import { nodeJson } from "./http.ts";
import { type KeyStore, KeyStoreError } from "./keystore.ts";
import { credentialsFile, type Settings } from "./settings.ts";

export const ENV_VAR = "HPY_CREDENTIAL";

export interface Credential {
  registry: string;
  clientKey: string;
  did: string;
  handle: string | null;
  pds: string;
  scopes: string;
  accessToken: string;
  dpopKey: DpopKey;
}

/**
 * A credential that `util.inspect` (console.log, test diffs) and `JSON.stringify` show
 * without its access token or private key, as Rust's hand-written `Debug` does.
 */
export function newCredential(c: Credential): Credential {
  const out = { ...c };
  const shown = () => ({
    registry: c.registry,
    did: c.did,
    handle: c.handle,
    pds: c.pds,
    scopes: c.scopes,
    dpop_key: c.dpopKey.toString(),
  });
  Object.defineProperty(out, inspect.custom, {
    enumerable: false,
    value: () =>
      `Credential { registry: ${debugStr(c.registry)}, did: ${debugStr(c.did)}, handle: ${
        c.handle === null ? "None" : `Some(${debugStr(c.handle)})`
      }, pds: ${debugStr(c.pds)}, scopes: ${debugStr(c.scopes)}, dpop_key: ${c.dpopKey}, .. }`,
  });
  Object.defineProperty(out, "toJSON", { enumerable: false, value: shown });
  return out;
}

export type Storage = "keychain" | "file" | "environment";

/** Who is signed in, read without the keychain. */
export interface Identity {
  did: string;
  handle: string | null;
  pds: string;
  registry: string;
  storage: Storage;
}

/** Keychain, or in the file (`reason` says why the keychain was not used, if it was tried). */
export type Saved = { kind: "keychain" } | { kind: "file"; reason: string | null };

/** The stored form, in Rust's field order: serde writes struct fields as declared. */
interface Stored {
  v: number;
  registry: string;
  client_key: string;
  did: string;
  handle?: string;
  pds: string;
  scopes: string;
  access_token: string;
  /** `{"keychain": true}`, or the private JWK itself. */
  dpop_key: Json;
}

/** serde_json writes a struct's fields in order and a `Value`'s keys sorted. */
function storedJson(s: Stored, pretty: boolean): string {
  const ordered: Record<string, Json> = {
    v: s.v,
    registry: s.registry,
    client_key: s.client_key,
    did: s.did,
  };
  if (s.handle !== undefined) ordered.handle = s.handle;
  ordered.pds = s.pds;
  ordered.scopes = s.scopes;
  ordered.access_token = s.access_token;
  ordered.dpop_key = sortedValue(s.dpop_key);
  return pretty ? JSON.stringify(ordered, null, 2) : JSON.stringify(ordered);
}

function sortedValue(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortedValue);
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(v).sort())
      out[k] = sortedValue((v as Record<string, Json>)[k] as Json);
    return out;
  }
  return v;
}

function toStored(c: Credential, dpopKey: Json): Stored {
  const s: Stored = {
    v: 1,
    registry: c.registry,
    client_key: c.clientKey,
    did: c.did,
    pds: c.pds,
    scopes: c.scopes,
    access_token: c.accessToken,
    dpop_key: dpopKey,
  };
  if (c.handle !== null) s.handle = c.handle;
  return s;
}

/** `Stored` as serde derives it: `v` a u8, no duplicate fields, `handle` optional. */
const STORED = struct("Stored", {
  v: u8,
  registry: str,
  client_key: str,
  did: str,
  handle: withDefault(optional(str), undefined),
  pds: str,
  scopes: str,
  access_token: str,
  dpop_key: node,
});

/** `serde_json::from_str::<Stored>` (or `from_slice` for bytes). */
function parseStored(text: string | Uint8Array): Stored {
  const raw = typeof text === "string" ? fromStr(text, STORED) : fromSlice(text, STORED);
  const s: Stored = {
    v: raw.v,
    registry: raw.registry,
    client_key: raw.client_key,
    did: raw.did,
    pds: raw.pds,
    scopes: raw.scopes,
    access_token: raw.access_token,
    dpop_key: nodeJson(raw.dpop_key),
  };
  if (raw.handle !== undefined) s.handle = raw.handle;
  return s;
}

const inKeychain = (s: Stored) =>
  !!s.dpop_key &&
  typeof s.dpop_key === "object" &&
  (s.dpop_key as Record<string, Json>).keychain === true;

function intoCredential(s: Stored, key: DpopKey): Credential {
  return newCredential({
    registry: s.registry,
    clientKey: s.client_key,
    did: s.did,
    handle: s.handle ?? null,
    pds: s.pds,
    scopes: s.scopes,
    accessToken: s.access_token,
    dpopKey: key,
  });
}

const identityOf = (s: Stored, storage: Storage): Identity => ({
  did: s.did,
  handle: s.handle ?? null,
  pds: s.pds,
  registry: s.registry,
  storage,
});

/** The keychain account: `<registry host>/<did>`, so sessions on different registries never collide. */
export function account(registry: string, did: string): string {
  try {
    const u = new URL(registry);
    if (u.host !== "") return `${u.host}/${did}`;
  } catch {}
  return `${registry.replace(/\/+$/, "")}/${did}`;
}

const loginAgain = (why: string) =>
  AtprotoError.loginRequired(`${why}; run \`hpy registry login\``);

/**
 * Writes a file of secrets (`credentials.json`, `instances.json`) owner-only, atomically. A
 * failure is `Error::other` of the `io::Error`: `No space left on device (os error 28)`.
 */
export function writeSecretFile(path: string, json: string): void {
  const io = (e: unknown) => AtprotoError.other(ioErrorText(e));
  try {
    createDirAll(dirname(path));
  } catch (e) {
    throw io(e);
  }
  const tmp = path.replace(/\.json$/, ".json.tmp");
  try {
    rmSync(tmp, { force: true });
  } catch {}
  let fd: number;
  try {
    fd = openSync(tmp, "wx", 0o600);
  } catch (e) {
    throw io(e);
  }
  try {
    const bytes = Buffer.from(json);
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
  } catch (e) {
    throw io(e);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    throw io(e);
  }
}

type ReadResult = null | { ok: Stored } | { err: string };

function readFile(path: string): ReadResult {
  let text: string;
  try {
    text = readToString(path);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw AtprotoError.other(e);
  }
  try {
    return { ok: parseStored(text) };
  } catch (e) {
    return { err: String(e) };
  }
}

/** The file the login before HappyView left behind; it held tokens. */
const LEGACY_SESSION_FILE = "session.toml";

export function save(settings: Settings, c: Credential, store: KeyStore): Saved {
  rmSync(join(settings.configDir, LEGACY_SESSION_FILE), { force: true });
  const path = credentialsFile(settings);
  const inline = () => writeSecretFile(path, storedJson(toStored(c, c.dpopKey.toJwk()), true));
  if (settings.credentialStore === "file") {
    inline();
    return { kind: "file", reason: null };
  }
  try {
    store.set(account(c.registry, c.did), JSON.stringify(sortedValue(c.dpopKey.toJwk())));
  } catch (e) {
    const err = e instanceof KeyStoreError ? e : new KeyStoreError(String(e), false);
    if (err.unavailable && settings.credentialStore === "auto") {
      inline();
      return { kind: "file", reason: err.message };
    }
    throw AtprotoError.other(
      `could not store your key in the OS keychain (${err.message}); set HPY_CREDENTIAL_STORE=file to keep it in a 0600 file instead`,
    );
  }
  writeSecretFile(path, storedJson(toStored(c, { keychain: true }), true));
  return { kind: "keychain" };
}

export type EnvFn = (k: string) => string | undefined;

export async function load(
  settings: Settings,
  store: KeyStore,
  env: EnvFn,
): Promise<Credential | null> {
  const exported = env(ENV_VAR);
  if (exported !== undefined) return importCredential(exported);
  const r = readFile(credentialsFile(settings));
  if (r === null) return null;
  if ("err" in r) throw loginAgain("your saved login is unreadable");
  const stored = r.ok;
  let jwk: unknown;
  if (inKeychain(stored)) {
    let secret: string | null;
    try {
      secret = store.get(account(stored.registry, stored.did));
    } catch (e) {
      throw loginAgain(`could not read your key from the OS keychain (${(e as Error).message})`);
    }
    if (secret === null) throw loginAgain("your hpy key is missing from the OS keychain");
    try {
      jwk = JSON.parse(secret);
    } catch {
      throw loginAgain("the key in your OS keychain is unreadable");
    }
  } else {
    jwk = stored.dpop_key;
  }
  let key: DpopKey;
  try {
    key = await DpopKey.fromJwk(jwk);
  } catch {
    throw loginAgain("your saved key is unreadable");
  }
  return intoCredential(stored, key);
}

/** Who is signed in, without touching the keychain (for `whoami`). */
export async function peek(settings: Settings, env: EnvFn): Promise<Identity | null> {
  const exported = env(ENV_VAR);
  if (exported !== undefined) {
    const c = await importCredential(exported);
    return identityOf(toStored(c, null), "environment");
  }
  const r = readFile(credentialsFile(settings));
  if (r === null) return null;
  if ("err" in r) throw loginAgain("your saved login is unreadable");
  return identityOf(r.ok, inKeychain(r.ok) ? "keychain" : "file");
}

/** Forgets the stored session: the keychain item and the file. Answers who was signed in. */
export function remove(settings: Settings, store: KeyStore): Identity | null {
  const path = credentialsFile(settings);
  rmSync(path.replace(/\.json$/, ".json.tmp"), { force: true });
  rmSync(join(settings.configDir, LEGACY_SESSION_FILE), { force: true });
  const r = readFile(path);
  if (r === null) return null;
  let identity: Identity | null = null;
  if ("ok" in r) {
    if (inKeychain(r.ok)) {
      try {
        store.delete(account(r.ok.registry, r.ok.did));
      } catch {}
    }
    identity = identityOf(r.ok, inKeychain(r.ok) ? "keychain" : "file");
  }
  rmSync(path, { force: true });
  return identity;
}

/** The whole credential, key included, as one string for `HPY_CREDENTIAL`. */
export function exportCredential(c: Credential): string {
  return Buffer.from(storedJson(toStored(c, c.dpopKey.toJwk()), false)).toString("base64url");
}

export async function importCredential(exported: string): Promise<Credential> {
  const bad = () =>
    AtprotoError.loginRequired(
      `${ENV_VAR} is not a credential from \`hpy registry login --export\``,
    );
  const bytes = base64UrlNoPad(trim(exported));
  if (bytes === null) throw bad();
  let stored: Stored;
  try {
    stored = parseStored(bytes);
  } catch {
    throw bad();
  }
  let key: DpopKey;
  try {
    key = await DpopKey.fromJwk(stored.dpop_key);
  } catch {
    throw bad();
  }
  return intoCredential(stored, key);
}

/**
 * The base64 crate's `URL_SAFE_NO_PAD.decode`: the URL-safe alphabet only, no padding, no
 * length that leaves a lone symbol, and no stray bits in the last symbol. null when it refuses.
 */
export function base64UrlNoPad(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, "base64url");
  // Node ignores stray bits; a canonical encoding has none, so it round-trips.
  return bytes.toString("base64url") === text ? new Uint8Array(bytes) : null;
}
