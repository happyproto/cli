// hpy-atproto/src/instance.rs: sign-ins to HappyView instances' admin APIs,
// one per instance URL.
//
// A person signs in through the browser: `hpy happyview login` registers an
// OAuth session with the instance as HappyView's built-in `hpy` client, and
// keeps its DPoP key, as `hpy registry login` does for the registry. CI uses an
// `hv_` API key made in the instance's dashboard instead.
//
// The secret (the DPoP key, or the API key) goes in the OS keychain, under
// `hv-session/<host>` or `hv-api-key/<host>`, and everything else in
// `instances.json` (0600). Without a usable keychain the secret is stored in
// the same file instead. `HPY_HV_API_KEY` (with `HPY_HV_URL` or `--url`) takes
// precedence over both.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Json, sortKeys } from "../core/output.ts";
import { type Credential, type Saved, writeSecretFile } from "./credential.ts";
import { DpopKey } from "./dpop.ts";
import { AtprotoError } from "./error.ts";
import { type KeyStore, KeyStoreError } from "./keystore.ts";
import { DEFAULT_OAUTH_RELAY, processEnv, type Settings } from "./settings.ts";

export const KEY_VAR = "HPY_HV_API_KEY";
export const URL_VAR = "HPY_HV_URL";
const FILE = "instances.json";

/** The OAuth client every instance knows `hpy` as: public and native. */
export const OAUTH_CLIENT_ID = "https://happyproto.at/oauth/hpy-cli/client-metadata.json";
/** The built-in API client's key, when an instance's `/config` doesn't say. */
export const DEFAULT_CLIENT_KEY = "hvc_hpy";
/** What a login asks the PDS for: who the user is, and HappyView's instance-management set. */
export const SCOPE = "atproto include:dev.happyview.adminFull";
/** The method the set grants, as a PDS spells it out once it has expanded the `include:`. */
const ADMIN_LXM = "dev.happyview.admin.manage";

/**
 * Whether a granted scope lets the session manage an instance: an `rpc`
 * permission naming the admin method, for any audience, written either as
 * `rpc:<method>?aud=*` or `rpc?lxm=<method>&lxm=…&aud=*`.
 */
export function grantsAdmin(scopes: string): boolean {
  return scopes
    .split(/\s+/)
    .filter((s) => s !== "")
    .some((scope) => {
      if (!scope.startsWith("rpc")) return false;
      const rest = scope.slice(3);
      let method: string;
      let params: string;
      if (rest.startsWith(":")) {
        const r = rest.slice(1);
        const q = r.indexOf("?");
        [method, params] = q === -1 ? [r, ""] : [r.slice(0, q), r.slice(q + 1)];
      } else if (rest.startsWith("?")) {
        [method, params] = ["", rest.slice(1)];
      } else return false;
      const ps = params.split("&");
      const anyAudience = ps.some((p) => p === "aud=*" || p.toLowerCase() === "aud=%2a");
      const admin = method === ADMIN_LXM || ps.some((p) => p === `lxm=${ADMIN_LXM}`);
      return anyAudience && admin;
    });
}

/**
 * The settings `hpy registry login` signs in with, turned toward an instance:
 * its HappyView and its `hpy` client, as a public client asking for
 * HappyView's instance-management permissions, through the relay page.
 */
export function loginSettings(base: Settings, url: string, clientKey: string): Settings {
  return {
    ...base,
    registryUrl: url,
    clientKey,
    oauthClientId: processEnv("HPY_HV_OAUTH_CLIENT_ID") ?? OAUTH_CLIENT_ID,
    oauthScope: SCOPE,
    oauthRedirect: { kind: "relay", url: DEFAULT_OAUTH_RELAY },
    oauthClientAuth: "none",
  };
}

/** How a sign-in proves itself to the instance. */
export type Auth = { kind: "apiKey"; key: string } | { kind: "session"; cred: Credential };

/** An instance and how to sign in to it. Secrets never print. */
export interface Login {
  url: string;
  auth: Auth;
}

export function newLogin(url: string, auth: Auth): Login {
  const login = { url, auth };
  Object.defineProperty(login, Symbol.for("nodejs.util.inspect.custom"), {
    enumerable: false,
    value: () => {
      const a =
        auth.kind === "apiKey" ? `api key ${prefix(auth.key)}` : `session for ${auth.cred.did}`;
      return `Login { url: ${JSON.stringify(url)}, auth: ${JSON.stringify(a)} }`;
    },
  });
  return login;
}

/** A stored sign-in, read without the keychain. */
export interface Info {
  url: string;
  kind: "session" | "apiKey";
  /** The handle (or DID) signed in, or enough of the API key to find it in the dashboard. */
  account: string;
  storage: "keychain" | "file" | "environment";
}

type SignIn =
  | { kind: "apiKey"; key_prefix: string }
  | {
      kind: "session";
      client_key: string;
      did: string;
      handle?: string;
      pds: string;
      scopes: string;
      access_token: string;
    };

interface StoredInstance {
  url: string;
  signIn: SignIn;
  /** `{"keychain": true}`, or the secret itself: the API key, or the session's private JWK. */
  secret: Json;
}

interface Stored {
  v: number;
  instances: StoredInstance[];
}

const inKeychain = (i: StoredInstance) =>
  !!i.secret &&
  typeof i.secret === "object" &&
  !Array.isArray(i.secret) &&
  (i.secret as Record<string, Json>).keychain === true;

const storedAccount = (i: StoredInstance) => account(i.url, i.signIn.kind === "session");

function infoOf(i: StoredInstance): Info {
  return {
    url: i.url,
    kind: i.signIn.kind,
    account:
      i.signIn.kind === "apiKey"
        ? `API key ${i.signIn.key_prefix}`
        : i.signIn.handle !== undefined
          ? `@${i.signIn.handle}`
          : i.signIn.did,
    storage: inKeychain(i) ? "keychain" : "file",
  };
}

async function loginOf(i: StoredInstance, secret: Json): Promise<Login> {
  const unreadable = () =>
    AtprotoError.loginRequired(
      `the saved sign-in for ${i.url} is unreadable; run \`hpy hv login --url ${i.url}\``,
    );
  if (i.signIn.kind === "apiKey") {
    if (typeof secret !== "string") throw unreadable();
    return newLogin(i.url, { kind: "apiKey", key: secret });
  }
  let key: DpopKey;
  try {
    key = await DpopKey.fromJwk(secret);
  } catch {
    throw unreadable();
  }
  const s = i.signIn;
  return newLogin(i.url, {
    kind: "session",
    cred: {
      registry: i.url,
      clientKey: s.client_key,
      did: s.did,
      handle: s.handle ?? null,
      pds: s.pds,
      scopes: s.scopes,
      accessToken: s.access_token,
      dpopKey: key,
    },
  });
}

/** `hv_` and the first characters after it, as the dashboard lists keys. */
export function prefix(key: string): string {
  return `${Array.from(key).slice(0, 8).join("")}…`;
}

/** The keychain account for an instance's session key or API key. */
export function account(url: string, session: boolean): string {
  const i = url.indexOf("://");
  const rest = i === -1 ? url : url.slice(i + 3);
  return `${session ? "hv-session" : "hv-api-key"}/${rest}`;
}

/**
 * An instance URL as it is stored and compared: https (or http to this
 * computer), no query or fragment, no trailing slash. A path is kept.
 */
export function normalizeUrl(raw: string): string {
  const bad = (why: string) =>
    AtprotoError.loginRequired(`\`${raw}\` is not an instance URL: ${why}`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw bad("expected https://api.example.com");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local)))
    throw bad("it must use https");
  // `url.search` is empty for a bare `?`, which the url crate still counts as a query.
  if (url.href.includes("?") || url.href.includes("#")) throw bad("it has a query or fragment");
  if (url.username !== "" || url.password !== "") throw bad("it has credentials in it");
  return url.href.replace(/\/+$/, "");
}

/** Checks that `key` looks like a HappyView API key, without saying what it is. */
export function checkKey(key: string): string | null {
  const k = key.trim();
  if (!k.startsWith("hv_") || Buffer.byteLength(k) < 8 || /\s/u.test(k))
    return "an API key starts with hv_; create one in the instance's dashboard";
  return null;
}

const path = (s: Settings) => join(s.configDir, FILE);

function parseSignIn(o: Record<string, unknown>): SignIn {
  const str = (k: string) => {
    if (typeof o[k] !== "string") throw new Error(k);
    return o[k] as string;
  };
  if (o.kind === "apiKey") return { kind: "apiKey", key_prefix: str("key_prefix") };
  if (o.kind === "session") {
    const s: SignIn = {
      kind: "session",
      client_key: str("client_key"),
      did: str("did"),
      pds: str("pds"),
      scopes: str("scopes"),
      access_token: str("access_token"),
    };
    if (o.handle !== undefined && o.handle !== null) s.handle = str("handle");
    return s;
  }
  throw new Error("kind");
}

function read(s: Settings): Stored {
  let text: string;
  try {
    text = readFileSync(path(s), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { v: 0, instances: [] };
    throw AtprotoError.other(e);
  }
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !Number.isInteger(v.v) || !Array.isArray(v.instances))
      throw new Error("shape");
    return {
      v: v.v as number,
      instances: v.instances.map((x: Record<string, unknown>) => {
        if (!x || typeof x !== "object" || typeof x.url !== "string" || !("secret" in x))
          throw new Error("instance");
        return { url: x.url, signIn: parseSignIn(x), secret: x.secret as Json };
      }),
    };
  } catch {
    throw AtprotoError.loginRequired(
      `${path(s)} is unreadable; delete it and run \`hpy hv login --url <instance>\` again`,
    );
  }
}

/** serde's layout: `url`, the flattened sign-in (its `kind` tag first), then `secret`. */
function storedJson(stored: Stored): string {
  return JSON.stringify(
    {
      v: stored.v,
      instances: stored.instances.map((i) => ({
        url: i.url,
        ...i.signIn,
        secret: sortKeys(i.secret),
      })),
    },
    null,
    2,
  );
}

function write(s: Settings, stored: Stored): void {
  if (stored.instances.length === 0) {
    rmSync(path(s), { force: true });
    return;
  }
  writeSecretFile(path(s), storedJson(stored));
}

/** `Value::to_string()`: a string as itself, anything else as compact JSON with sorted keys. */
const compact = (v: Json): string => (typeof v === "string" ? v : JSON.stringify(sortKeys(v)));

/** Saves a sign-in, replacing whatever was saved for its instance: the secret in the keychain when it can, else inline. */
function save(s: Settings, url: string, signIn: SignIn, secret: Json, store: KeyStore): Saved {
  const stored = read(s);
  stored.v = 1;
  const old = stored.instances.find((i) => i.url === url);
  if (old && inKeychain(old)) {
    try {
      store.delete(storedAccount(old));
    } catch {}
  }
  stored.instances = stored.instances.filter((i) => i.url !== url);
  const entry: StoredInstance = { url, signIn, secret: { keychain: true } };
  let saved: Saved;
  if (s.credentialStore === "file") {
    saved = { kind: "file", reason: null };
  } else {
    try {
      store.set(storedAccount(entry), compact(secret));
      saved = { kind: "keychain" };
    } catch (e) {
      const err = e instanceof KeyStoreError ? e : new KeyStoreError(String(e), false);
      if (err.unavailable && s.credentialStore === "auto")
        saved = { kind: "file", reason: err.message };
      else
        throw AtprotoError.other(
          `could not store your sign-in in the OS keychain (${err.message}); set HPY_CREDENTIAL_STORE=file to keep it in a 0600 file instead`,
        );
    }
  }
  if (saved.kind !== "keychain") entry.secret = secret;
  stored.instances.push(entry);
  write(s, stored);
  return saved;
}

/** Saves the API key for `url`. */
export function saveKey(s: Settings, url: string, key: string, store: KeyStore): Saved {
  const u = normalizeUrl(url);
  const k = key.trim();
  const bad = checkKey(k);
  if (bad !== null) throw AtprotoError.loginRequired(bad);
  return save(s, u, { kind: "apiKey", key_prefix: prefix(k) }, k, store);
}

/** Saves the session `hpy happyview login` registered with `c.registry`. */
export function saveSession(s: Settings, c: Credential, store: KeyStore): Saved {
  const u = normalizeUrl(c.registry);
  // serde's order: the fields as declared, `handle` skipped when None.
  const signIn: SignIn = {
    kind: "session",
    client_key: c.clientKey,
    did: c.did,
    ...(c.handle !== null ? { handle: c.handle } : {}),
    pds: c.pds,
    scopes: c.scopes,
    access_token: c.accessToken,
  };
  return save(s, u, signIn, c.dpopKey.toJwk(), store);
}

/** Every stored sign-in, without touching the keychain. */
export function list(s: Settings): Info[] {
  return read(s).instances.map(infoOf);
}

function notSignedIn(url: string | null): AtprotoError {
  return AtprotoError.loginRequired(
    `not signed in to ${url ?? "a HappyView instance"}; run \`hpy hv login --url ${url ?? "<instance>"}\``,
  );
}

/** The stored instance `url` names, or the only one when it names none. */
function choose(stored: Stored, url: string | null): StoredInstance {
  if (url !== null) {
    const found = stored.instances.find((i) => i.url === url);
    if (!found) throw notSignedIn(url);
    return found;
  }
  const [only, ...more] = stored.instances;
  if (!only) throw notSignedIn(null);
  if (more.length === 0) return only;
  throw AtprotoError.other(
    `signed in to several instances (${stored.instances.map((i) => i.url).join(", ")}); choose one with --url`,
  );
}

export type EnvFn = (k: string) => string | undefined;

/**
 * The instance to act on, `url` or else `HPY_HV_URL`, and how to sign in to
 * it: `HPY_HV_API_KEY` when set, else a stored sign-in.
 */
export async function current(
  s: Settings,
  store: KeyStore | (() => Promise<KeyStore>),
  env: EnvFn,
  url: string | null | undefined,
): Promise<Login> {
  const raw = url ?? env(URL_VAR);
  const u = raw !== undefined && raw !== null ? normalizeUrl(raw) : null;
  const key = env(KEY_VAR);
  if (key !== undefined) {
    if (u === null)
      throw AtprotoError.loginRequired(`${KEY_VAR} is set, so set ${URL_VAR} or pass --url too`);
    const bad = checkKey(key);
    if (bad !== null) throw AtprotoError.loginRequired(`${KEY_VAR}: ${bad}`);
    return newLogin(u, { kind: "apiKey", key: key.trim() });
  }
  const chosen = choose(read(s), u);
  let secret: Json;
  if (inKeychain(chosen)) {
    const again = (why: string) =>
      AtprotoError.loginRequired(`${why}; run \`hpy hv login --url ${chosen.url}\``);
    let text: string | null;
    try {
      const ks = typeof store === "function" ? await store() : store;
      text = ks.get(storedAccount(chosen));
    } catch (e) {
      throw again(`could not read your sign-in from the OS keychain (${(e as Error).message})`);
    }
    if (text === null) throw again("your sign-in is missing from the OS keychain");
    if (chosen.signIn.kind === "apiKey") secret = text;
    else {
      try {
        secret = JSON.parse(text) as Json;
      } catch {
        throw again("the key in your OS keychain is unreadable");
      }
    }
  } else {
    secret = chosen.secret;
  }
  return loginOf(chosen, secret);
}

/**
 * Forgets the sign-in `url` names (or the only one): its keychain item and its
 * entry. Answers what was forgotten, if anything was stored.
 */
export function remove(s: Settings, store: KeyStore, url: string | null | undefined): Info | null {
  const u = url !== undefined && url !== null ? normalizeUrl(url) : null;
  const stored = read(s);
  let chosen: StoredInstance;
  try {
    chosen = choose(stored, u);
  } catch (e) {
    if (e instanceof AtprotoError && e.isAuth()) return null;
    throw e;
  }
  if (inKeychain(chosen)) {
    try {
      store.delete(storedAccount(chosen));
    } catch {}
  }
  stored.instances = stored.instances.filter((i) => i.url !== chosen.url);
  write(s, stored);
  return infoOf(chosen);
}
