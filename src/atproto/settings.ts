// hpy-atproto/src/settings.rs: where hpy talks to, from HPY_* variables, then
// config.toml, then the defaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../core/paths.ts";
import { optional, str as strDecoder, struct, withDefault } from "../core/serde-json.ts";
import { fromStr } from "../core/toml.ts";
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

// settings.rs `File` and its sections, with their Rust names (they appear in serde's errors).
const registrySection = struct("RegistrySection", {
  url: optional(strDecoder),
  client_key: optional(strDecoder),
});
const oauthSection = struct("OAuthSection", {
  client_id: optional(strDecoder),
  scope: optional(strDecoder),
  redirect: optional(strDecoder),
  client_auth: optional(strDecoder),
});
const credentialsSection = struct("CredentialsSection", { store: optional(strDecoder) });
const noRegistry = () => ({ url: undefined, client_key: undefined });
const noOauth = () => ({
  client_id: undefined,
  scope: undefined,
  redirect: undefined,
  client_auth: undefined,
});
const noCredentials = () => ({ store: undefined });
const settingsFile = struct("File", {
  registry: withDefault(registrySection, noRegistry),
  oauth: withDefault(oauthSection, noOauth),
  credentials: withDefault(credentialsSection, noCredentials),
});

type SettingsFile = ReturnType<typeof settingsFile>;

export function settingsFromSources(file: string | undefined, env: Env, dir: string): Settings {
  let parsed: SettingsFile = {
    registry: noRegistry(),
    oauth: noOauth(),
    credentials: noCredentials(),
  };
  if (file !== undefined) {
    try {
      parsed = fromStr(file, settingsFile);
    } catch (e) {
      throw AtprotoError.other(`config.toml is not valid: ${(e as Error).message}`);
    }
  }
  const { registry, oauth, credentials } = parsed;
  const redirect = env("HPY_OAUTH_REDIRECT") ?? oauth.redirect;
  const auth = env("HPY_OAUTH_CLIENT_AUTH") ?? oauth.client_auth;
  const store = env("HPY_CREDENTIAL_STORE") ?? credentials.store;
  return {
    registryUrl: (env("HPY_REGISTRY_URL") ?? registry.url ?? DEFAULT_REGISTRY_URL).replace(
      /\/+$/,
      "",
    ),
    clientKey: env("HPY_CLIENT_KEY") ?? registry.client_key ?? DEFAULT_CLIENT_KEY,
    oauthClientId: env("HPY_OAUTH_CLIENT_ID") ?? oauth.client_id ?? DEFAULT_OAUTH_CLIENT_ID,
    oauthScope: env("HPY_OAUTH_SCOPE") ?? oauth.scope ?? DEFAULT_SCOPE,
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
