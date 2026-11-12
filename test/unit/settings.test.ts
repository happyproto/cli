// hpy-atproto/src/settings.rs tests.
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  credentialsFile,
  DEFAULT_CLIENT_KEY,
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_RELAY,
  DEFAULT_REGISTRY_URL,
  DEFAULT_SCOPE,
  settingsFromSources,
} from "../../src/atproto/settings.ts";

const env =
  (pairs: Record<string, string>) =>
  (k: string): string | undefined =>
    pairs[k];

it("defaults", () => {
  const s = settingsFromSources(undefined, env({}), "/c");
  expect(s.registryUrl).toBe(DEFAULT_REGISTRY_URL);
  expect(s.oauthClientId).toBe(DEFAULT_OAUTH_CLIENT_ID);
  expect(s.clientKey).toBe(DEFAULT_CLIENT_KEY);
  expect(s.credentialStore).toBe("auto");
  expect(s.oauthScope).toBe(DEFAULT_SCOPE);
  expect(DEFAULT_SCOPE).toBe(
    "atproto repo:software.release.project repo:software.release.manifest repo:software.release.version repo:software.release.channel repo:software.release.status repo:at.happyproto.registry.project repo:site.standard.publication repo:site.standard.document blob:application/wasm blob:application/json blob:image/*",
  );
  expect(credentialsFile(s)).toBe(join("/c", "credentials.json"));
});

it("env_beats_file", () => {
  const file = '[registry]\nurl = "https://file"\n[oauth]\nclient_id = "https://file/c.json"\n';
  const s = settingsFromSources(file, env({ HPY_REGISTRY_URL: "https://env" }), "/c");
  expect(s.registryUrl).toBe("https://env");
  expect(s.oauthClientId).toBe("https://file/c.json");
});

it("bad_file_is_an_error", () => {
  expect(() => settingsFromSources("[registry", env({}), "/c")).toThrow();
});

it("credential_store_choice", () => {
  expect(
    settingsFromSources(undefined, env({ HPY_CREDENTIAL_STORE: "file" }), "/c").credentialStore,
  ).toBe("file");
  expect(
    settingsFromSources('[credentials]\nstore = "keychain"\n', env({}), "/c").credentialStore,
  ).toBe("keychain");
  expect(() =>
    settingsFromSources(undefined, env({ HPY_CREDENTIAL_STORE: "vault" }), "/c"),
  ).toThrow();
});

it("oauth_modes", () => {
  let s = settingsFromSources(undefined, env({}), "/c");
  expect(s.oauthRedirect).toEqual({ kind: "relay", url: DEFAULT_OAUTH_RELAY });
  expect(s.oauthClientAuth).toBe("assertion");
  s = settingsFromSources(
    undefined,
    env({ HPY_OAUTH_REDIRECT: "loopback", HPY_OAUTH_CLIENT_AUTH: "none" }),
    "/c",
  );
  expect([s.oauthRedirect, s.oauthClientAuth]).toEqual([{ kind: "loopback" }, "none"]);
  expect(() =>
    settingsFromSources(undefined, env({ HPY_OAUTH_REDIRECT: "http://evil" }), "/c"),
  ).toThrow();
  expect(() =>
    settingsFromSources(undefined, env({ HPY_OAUTH_CLIENT_AUTH: "secret" }), "/c"),
  ).toThrow();
});
