// hpy-atproto/src/instance.rs tests.
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, it } from "vitest";
import type { Credential } from "../../src/atproto/credential.ts";
import { DpopKey } from "../../src/atproto/dpop.ts";
import type { AtprotoError } from "../../src/atproto/error.ts";
import {
  checkKey,
  current,
  grantsAdmin,
  KEY_VAR,
  type Login,
  list,
  loginSettings,
  newLogin,
  normalizeUrl,
  remove,
  saveKey,
  saveSession,
  URL_VAR,
} from "../../src/atproto/instance.ts";
import { type KeyStore, KeyStoreError, MemoryStore } from "../../src/atproto/keystore.ts";
import {
  DEFAULT_OAUTH_RELAY,
  type Settings,
  type StoreChoice,
  settingsFromSources,
} from "../../src/atproto/settings.ts";

const KEY = "hv_0123456789abcdef0123456789abcdef";
const OTHER = "hv_fedcba9876543210fedcba9876543210";
const FILE = "instances.json";

const tmp = () => mkdtempSync(join(tmpdir(), "hpy-instance-"));
const settings = (dir: string, choice: StoreChoice): Settings => ({
  ...settingsFromSources(undefined, () => undefined, dir),
  credentialStore: choice,
});
const noEnv = () => undefined;

function key(login: Login): string {
  if (login.auth.kind !== "apiKey") throw new Error("a session, not an API key");
  return login.auth.key;
}

const session = async (url: string): Promise<Credential> => ({
  registry: url,
  clientKey: "hvc_hpy",
  did: "did:plc:me",
  handle: "me.test",
  pds: "https://pds.test",
  scopes: "atproto",
  accessToken: "token",
  dpopKey: await DpopKey.generate(),
});

const unavailable: KeyStore = {
  get() {
    throw new KeyStoreError("no secret service", true);
  },
  set() {
    throw new KeyStoreError("no secret service", true);
  },
  delete() {
    throw new KeyStoreError("no secret service", true);
  },
};

const fails = async (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected an error");
    },
    (e: AtprotoError) => e,
  );

it("urls_are_https_without_a_trailing_slash", () => {
  expect(normalizeUrl("https://api.example.com/")).toBe("https://api.example.com");
  expect(normalizeUrl("https://example.com/hv/")).toBe("https://example.com/hv");
  expect(normalizeUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  for (const bad of [
    "http://api.example.com",
    "api.example.com",
    "https://api.example.com/?x=1",
    "https://me:pw@api.example.com",
  ]) {
    expect(() => normalizeUrl(bad), bad).toThrow();
  }
});

it("keys_look_like_happyview_keys", () => {
  expect(checkKey(KEY)).toBeNull();
  for (const bad of ["", "hvc_0123456789", "hv_12", "hv_0123 4567"]) {
    expect(checkKey(bad), bad).not.toBeNull();
  }
});

it("saves_the_key_in_the_keychain_and_the_instance_in_the_file", async () => {
  const dir = tmp();
  const s = settings(dir, "auto");
  const store = new MemoryStore();
  expect(saveKey(s, "https://api.example.com/", KEY, store)).toEqual({ kind: "keychain" });
  const text = readFileSync(join(dir, FILE), "utf8");
  expect(text).not.toContain(KEY);
  expect(store.get("hv-api-key/api.example.com")).toBe(KEY);
  if (process.platform !== "win32") expect(statSync(join(dir, FILE)).mode & 0o777).toBe(0o600);
  const login = await current(s, store, noEnv, null);
  expect(login.url).toBe("https://api.example.com");
  expect(key(login)).toBe(KEY);
  expect(list(s)).toEqual([
    {
      url: "https://api.example.com",
      kind: "apiKey",
      account: "API key hv_01234…",
      storage: "keychain",
    },
  ]);
});

it("falls_back_to_the_file_without_a_keychain", async () => {
  const s = settings(tmp(), "auto");
  const saved = saveKey(s, "https://api.example.com", KEY, unavailable);
  expect(saved.kind === "file" && saved.reason !== null).toBe(true);
  expect(key(await current(s, unavailable, noEnv, null))).toBe(KEY);
  expect(list(s)[0]?.storage).toBe("file");
});

it("logging_in_again_replaces_the_key", async () => {
  const s = settings(tmp(), "file");
  const store = new MemoryStore();
  saveKey(s, "https://api.example.com", KEY, store);
  saveKey(s, "https://api.example.com/", OTHER, store);
  expect(list(s).length).toBe(1);
  expect(key(await current(s, store, noEnv, null))).toBe(OTHER);
});

it("several_instances_need_a_url_to_choose", async () => {
  const s = settings(tmp(), "auto");
  const store = new MemoryStore();
  saveKey(s, "https://a.example.com", KEY, store);
  saveKey(s, "https://b.example.com", OTHER, store);
  let err = await fails(current(s, store, noEnv, null));
  expect(err.message).toContain("--url");
  expect(err.message).toContain("https://a.example.com");
  expect(key(await current(s, store, noEnv, "https://b.example.com/"))).toBe(OTHER);
  err = await fails(current(s, store, noEnv, "https://c.example.com"));
  expect(err.isAuth()).toBe(true);
  expect(err.message).toContain("hpy hv login --url https://c.example.com");
});

it("hpy_hv_url_chooses_a_saved_sign_in_too", async () => {
  const s = settings(tmp(), "auto");
  const store = new MemoryStore();
  saveKey(s, "https://a.example.com", KEY, store);
  saveKey(s, "https://b.example.com", OTHER, store);
  const env = (k: string) => (k === URL_VAR ? "https://b.example.com/" : undefined);
  expect(key(await current(s, store, env, null))).toBe(OTHER);
  // --url wins over it.
  expect(key(await current(s, store, env, "https://a.example.com"))).toBe(KEY);
});

it("nothing_saved_says_how_to_sign_in", async () => {
  const err = await fails(current(settings(tmp(), "auto"), new MemoryStore(), noEnv, null));
  expect(err.isAuth()).toBe(true);
  expect(err.message).toContain("hpy hv login --url");
});

it("the_environment_takes_precedence_and_never_touches_the_keychain", async () => {
  const s = settings(tmp(), "auto");
  const env = (k: string) =>
    k === KEY_VAR ? OTHER : k === URL_VAR ? "https://ci.example.com/" : undefined;
  let login = await current(s, unavailable, env, null);
  expect(login.url).toBe("https://ci.example.com");
  expect(key(login)).toBe(OTHER);
  // --url wins over HPY_HV_URL.
  login = await current(s, unavailable, env, "https://other.example.com");
  expect(login.url).toBe("https://other.example.com");
  const keyOnly = (k: string) => (k === KEY_VAR ? OTHER : undefined);
  expect((await fails(current(s, unavailable, keyOnly, null))).message).toContain(URL_VAR);
});

it("remove_forgets_the_key_and_the_instance", () => {
  const dir = tmp();
  const s = settings(dir, "auto");
  const store = new MemoryStore();
  saveKey(s, "https://a.example.com", KEY, store);
  saveKey(s, "https://b.example.com", OTHER, store);
  expect(remove(s, store, "https://a.example.com")?.url).toBe("https://a.example.com");
  expect(store.get("hv-api-key/a.example.com")).toBeNull();
  expect(list(s).length).toBe(1);
  expect(remove(s, store, "https://a.example.com")).toBeNull();
  // With one left, no URL is needed.
  expect(remove(s, store, null)).not.toBeNull();
  expect(existsSync(join(dir, FILE))).toBe(false);
});

it("debug_never_shows_the_key", async () => {
  expect(inspect(newLogin("https://api.example.com", { kind: "apiKey", key: KEY }))).not.toContain(
    KEY,
  );
  const c = await session("https://api.example.com");
  const shown = inspect(newLogin("https://api.example.com", { kind: "session", cred: c }));
  expect(shown).not.toContain("token");
  expect(shown).not.toContain((c.dpopKey.toJwk() as { d: string }).d);
  expect(
    JSON.stringify(newLogin("https://api.example.com", { kind: "session", cred: c })),
  ).not.toContain("token");
  expect(
    JSON.stringify(newLogin("https://api.example.com", { kind: "apiKey", key: KEY })),
  ).not.toContain(KEY);
});

it("a_session_keeps_its_key_in_the_keychain_and_the_rest_in_the_file", async () => {
  const dir = tmp();
  const s = settings(dir, "auto");
  const store = new MemoryStore();
  const c = await session("https://api.example.com/");
  expect(saveSession(s, c, store)).toEqual({ kind: "keychain" });
  expect(readFileSync(join(dir, FILE), "utf8")).not.toContain('"d"');
  expect(store.get("hv-session/api.example.com")).toContain('"d"');
  const login = await current(s, store, noEnv, null);
  expect(login.url).toBe("https://api.example.com");
  if (login.auth.kind !== "session") throw new Error("an API key, not a session");
  const back = login.auth.cred;
  expect(back.registry).toBe("https://api.example.com");
  expect(back.dpopKey.thumbprint()).toBe(c.dpopKey.thumbprint());
  expect(back.accessToken).toBe("token");
  expect(list(s)).toEqual([
    { url: "https://api.example.com", kind: "session", account: "@me.test", storage: "keychain" },
  ]);
});

it("a_session_falls_back_to_the_file_without_a_keychain", async () => {
  const s = settings(tmp(), "auto");
  const c = await session("https://api.example.com");
  const saved = saveSession(s, c, unavailable);
  expect(saved.kind === "file" && saved.reason !== null).toBe(true);
  const login = await current(s, unavailable, noEnv, null);
  if (login.auth.kind !== "session") throw new Error("not a session");
  expect(login.auth.cred.dpopKey.thumbprint()).toBe(c.dpopKey.thumbprint());
});

it("signing_in_again_replaces_a_key_with_a_session", async () => {
  const s = settings(tmp(), "auto");
  const store = new MemoryStore();
  saveKey(s, "https://api.example.com", KEY, store);
  saveSession(s, await session("https://api.example.com"), store);
  expect(store.get("hv-api-key/api.example.com")).toBeNull();
  expect(list(s).length).toBe(1);
  expect((await current(s, store, noEnv, null)).auth.kind).toBe("session");
  expect(remove(s, store, null)).not.toBeNull();
  expect(store.get("hv-session/api.example.com")).toBeNull();
});

it("a_grant_manages_the_instance_only_with_the_admin_rpc", () => {
  expect(grantsAdmin("atproto rpc:dev.happyview.admin.manage?aud=*")).toBe(true);
  // A PDS may percent-encode the audience.
  expect(grantsAdmin("rpc:dev.happyview.admin.manage?aud=%2A atproto")).toBe(true);
  // Or name several methods in one permission.
  expect(
    grantsAdmin("atproto rpc?lxm=dev.happyview.admin.manage&lxm=com.example.other&aud=*"),
  ).toBe(true);
  for (const no of [
    "atproto",
    "atproto include:dev.happyview.adminFull",
    "atproto rpc:dev.happyview.admin.manage?aud=did:web:other#hv",
    "atproto rpc:dev.happyview.admin.manageX?aud=*",
    "atproto rpc:*?aud=*",
    "atproto rpc?lxm=com.example.other&aud=*",
    "atproto rpc?lxm=dev.happyview.admin.manage&aud=did:web:other%23hv",
  ]) {
    expect(grantsAdmin(no), no).toBe(false);
  }
});

it("instance_logins_use_the_public_hpy_client", () => {
  const base = settingsFromSources(undefined, () => undefined, "/c");
  const s = loginSettings(base, "https://api.example.com", "hvc_hpy");
  expect(s.registryUrl).toBe("https://api.example.com");
  expect(s.clientKey).toBe("hvc_hpy");
  expect(s.oauthScope).toBe("atproto include:dev.happyview.adminFull");
  // Through the relay, not loopback: some PDSes refuse a loopback redirect URI on any port but the registered one.
  expect(s.oauthRedirect).toEqual({ kind: "relay", url: DEFAULT_OAUTH_RELAY });
  expect(s.oauthClientAuth).toBe("none");
  expect(s.configDir).toBe(base.configDir);
});
