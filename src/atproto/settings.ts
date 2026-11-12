// hpy-atproto/src/settings.rs: where hpy talks to, from HPY_* variables, then
// config.toml, then the defaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { configDir } from "../core/paths.ts";
import { AtprotoError } from "./error.ts";

export const DEFAULT_REGISTRY_URL = "https://api.happyproto.at";
/** The `hpy` API client on the default registry's HappyView. Not a secret. */
export const DEFAULT_CLIENT_KEY = "hvc_f4b41f1b8ca045b291488098e010f5ea";
export const DEFAULT_OAUTH_CLIENT_ID = "https://happyproto.at/oauth/hpy/client-metadata.json";
/** The hosted page a confidential client is redirected to; it forwards to the loopback listener. */
export const DEFAULT_OAUTH_RELAY = "https://happyproto.at/oauth/hpy/callback";
/** What a publish needs. A session's scopes are fixed when it is issued. */
export const DEFAULT_SCOPE =
  "atproto repo:software.release.project repo:software.release.manifest repo:software.release.version repo:software.release.channel repo:software.release.status repo:at.happyproto.registry.project repo:site.standard.publication repo:site.standard.document blob:application/wasm blob:application/json blob:image/*";

/** Where the PDS sends the browser after sign-in. */
export type Redirect = { kind: "relay"; url: string } | { kind: "loopback" };
/** How hpy authenticates to the token endpoint: a HappyView-signed assertion, or not at all. */
export type ClientAuth = "assertion" | "none";
/** `auto` tries the OS keychain and falls back to the credentials file; the others insist. */
export type StoreChoice = "auto" | "keychain" | "file";

export interface Settings {
  registryUrl: string;
  clientKey: string;
  oauthClientId: string;
  oauthScope: string;
  credentialStore: StoreChoice;
  oauthRedirect: Redirect;
  oauthClientAuth: ClientAuth;
  configDir: string;
}

export function parseRedirect(s: string): Redirect {
  if (s === "loopback") return { kind: "loopback" };
  if (s.startsWith("https://")) return { kind: "relay", url: s };
  throw AtprotoError.other(`OAuth redirect \`${s}\` must be \`loopback\` or an https:// URL`);
}

export function parseClientAuth(s: string): ClientAuth {
  if (s === "assertion" || s === "none") return s;
  throw AtprotoError.other(`OAuth client auth \`${s}\` is not one of assertion, none`);
}

export function parseStoreChoice(s: string): StoreChoice {
  if (s === "auto" || s === "keychain" || s === "file") return s;
  throw AtprotoError.other(`credential store \`${s}\` is not one of auto, keychain, file`);
}

type Env = (k: string) => string | undefined;

export const processEnv: Env = (k) => {
  const v = process.env[k];
  return v !== undefined && v !== "" ? v : undefined;
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function settingsFromSources(file: string | undefined, env: Env, dir: string): Settings {
  let parsed: Record<string, Record<string, unknown>> = {};
  if (file !== undefined) {
    try {
      parsed = parseToml(file) as typeof parsed;
    } catch (e) {
      throw AtprotoError.other(`config.toml is not valid: ${(e as Error).message}`);
    }
  }
  const section = (name: string) => {
    const s = parsed[name];
    return s && typeof s === "object" ? s : {};
  };
  const registry = section("registry");
  const oauth = section("oauth");
  const credentials = section("credentials");
  const redirect = env("HPY_OAUTH_REDIRECT") ?? str(oauth.redirect);
  const auth = env("HPY_OAUTH_CLIENT_AUTH") ?? str(oauth.client_auth);
  const store = env("HPY_CREDENTIAL_STORE") ?? str(credentials.store);
  return {
    registryUrl: (env("HPY_REGISTRY_URL") ?? str(registry.url) ?? DEFAULT_REGISTRY_URL).replace(
      /\/+$/,
      "",
    ),
    clientKey: env("HPY_CLIENT_KEY") ?? str(registry.client_key) ?? DEFAULT_CLIENT_KEY,
    oauthClientId: env("HPY_OAUTH_CLIENT_ID") ?? str(oauth.client_id) ?? DEFAULT_OAUTH_CLIENT_ID,
    oauthScope: env("HPY_OAUTH_SCOPE") ?? str(oauth.scope) ?? DEFAULT_SCOPE,
    oauthRedirect:
      redirect !== undefined
        ? parseRedirect(redirect)
        : { kind: "relay", url: DEFAULT_OAUTH_RELAY },
    oauthClientAuth: auth !== undefined ? parseClientAuth(auth) : "assertion",
    credentialStore: store !== undefined ? parseStoreChoice(store) : "auto",
    configDir: dir,
  };
}

export function loadSettings(): Settings {
  const dir = configDir();
  let file: string | undefined;
  try {
    file = readFileSync(join(dir, "config.toml"), "utf8");
  } catch {
    file = undefined;
  }
  return settingsFromSources(file, processEnv, dir);
}

export const configFile = (s: Settings) => join(s.configDir, "config.toml");
export const credentialsFile = (s: Settings) => join(s.configDir, "credentials.json");
