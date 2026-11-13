// hpy-atproto/src/credential.rs tests.
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  account,
  type Credential,
  exportCredential,
  importCredential,
  load,
  peek,
  remove,
  save,
} from "../../src/atproto/credential.ts";
import { DpopKey } from "../../src/atproto/dpop.ts";
import { AtprotoError } from "../../src/atproto/error.ts";
import { type KeyStore, KeyStoreError, MemoryStore } from "../../src/atproto/keystore.ts";
import {
  credentialsFile,
  type StoreChoice,
  settingsFromSources,
} from "../../src/atproto/settings.ts";

const settings = (dir: string, choice: StoreChoice) => ({
  ...settingsFromSources(undefined, () => undefined, dir),
  credentialStore: choice,
});
const tmp = () => mkdtempSync(join(tmpdir(), "hpy-cred-"));
const noEnv = () => undefined;

async function cred(did: string): Promise<Credential> {
  return {
    registry: "https://api.happyproto.at",
    clientKey: "hvc_test",
    did,
    handle: "alice.test",
    pds: "https://pds.test",
    scopes: "atproto",
    accessToken: "secret-token",
    dpopKey: await DpopKey.generate(),
  };
}

/** Credential equality as Rust's derived PartialEq (DpopKey compares by thumbprint). */
function same(a: Credential | null, b: Credential) {
  expect(a).not.toBeNull();
  const { dpopKey: ka, ...ra } = a as Credential;
  const { dpopKey: kb, ...rb } = b;
  expect(ra).toEqual(rb);
  expect(ka.thumbprint()).toBe(kb.thumbprint());
}

class Unavailable implements KeyStore {
  get(): string | null {
    throw new KeyStoreError("no Secret Service", true);
  }
  set(): void {
    throw new KeyStoreError("no Secret Service", true);
  }
  delete(): void {
    throw new KeyStoreError("no Secret Service", true);
  }
}

class MustNotBeUsed implements KeyStore {
  get(): string | null {
    throw new Error("the keychain must not be used");
  }
  set(): void {
    throw new Error("the keychain must not be used");
  }
  delete(): void {
    throw new Error("the keychain must not be used");
  }
}

describe("credential.rs", () => {
  it("saves_key_in_keychain_and_rest_in_file", async () => {
    const s = settings(tmp(), "auto");
    const store = new MemoryStore();
    const c = await cred("did:plc:abc");
    expect(save(s, c, store)).toEqual({ kind: "keychain" });
    const text = readFileSync(credentialsFile(s), "utf8");
    expect(JSON.parse(text).dpop_key).toEqual({ keychain: true });
    expect(text).not.toContain('"d"');
    expect(store.get(account(c.registry, c.did))).toContain('"d"');
    if (process.platform !== "win32") expect(statSync(credentialsFile(s)).mode & 0o777).toBe(0o600);
    same(await load(s, store, noEnv), c);
  });

  it("account_is_registry_host_and_did", () => {
    expect(account("https://api.happyproto.at", "did:plc:abc")).toBe(
      "api.happyproto.at/did:plc:abc",
    );
    expect(account("http://127.0.0.1:3000/", "did:plc:abc")).toBe("127.0.0.1:3000/did:plc:abc");
  });

  it("falls_back_to_file_when_keychain_unavailable", async () => {
    const s = settings(tmp(), "auto");
    const c = await cred("did:plc:abc");
    const saved = save(s, c, new Unavailable());
    expect(saved.kind === "file" && saved.reason !== null).toBe(true);
    same(await load(s, new Unavailable(), noEnv), c);
  });

  it("keychain_choice_makes_unavailable_an_error", async () => {
    const s = settings(tmp(), "keychain");
    expect(() => save(s, {} as Credential, new Unavailable())).toThrow();
    let err: unknown;
    try {
      save(s, await cred("did:plc:abc"), new Unavailable());
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toContain("HPY_CREDENTIAL_STORE");
    expect(existsSync(credentialsFile(s))).toBe(false);
  });

  it("file_choice_never_touches_the_keychain", async () => {
    const s = settings(tmp(), "file");
    const c = await cred("did:plc:abc");
    expect(save(s, c, new MustNotBeUsed())).toEqual({ kind: "file", reason: null });
    same(await load(s, new MustNotBeUsed(), noEnv), c);
    expect(remove(s, new MustNotBeUsed())).not.toBeNull();
  });

  it("missing_keychain_item_is_an_auth_error", async () => {
    const s = settings(tmp(), "auto");
    const store = new MemoryStore();
    const c = await cred("did:plc:abc");
    save(s, c, store);
    store.delete(account(c.registry, c.did));
    const err = await load(s, store, noEnv).catch((e) => e);
    expect(err).toBeInstanceOf(AtprotoError);
    expect((err as AtprotoError).isAuth()).toBe(true);
    expect(err.message).toContain("hpy registry login");
  });

  it("env_credential_wins", async () => {
    const s = settings(tmp(), "auto");
    save(s, await cred("did:plc:file"), new MemoryStore());
    const ci = await cred("did:plc:ci");
    const exported = exportCredential(ci);
    const env = (k: string) => (k === "HPY_CREDENTIAL" ? exported : undefined);
    same(await load(s, new MustNotBeUsed(), env), ci);
    expect((await peek(s, env))?.did).toBe("did:plc:ci");
  });

  it("export_import_round_trip", async () => {
    const c = await cred("did:plc:abc");
    same(await importCredential(exportCredential(c)), c);
    const err = await importCredential("not a credential").catch((e) => e);
    expect(err.message).toContain("hpy registry login --export");
  });

  it("peek_reads_the_file_without_the_keychain", async () => {
    const s = settings(tmp(), "auto");
    save(s, await cred("did:plc:abc"), new MemoryStore());
    const id = await peek(s, noEnv);
    expect([id?.did, id?.handle]).toEqual(["did:plc:abc", "alice.test"]);
    expect(id?.storage).toBe("keychain");
  });

  it("remove_deletes_both_and_tolerates_corruption", async () => {
    const s = settings(tmp(), "auto");
    const store = new MemoryStore();
    const c = await cred("did:plc:abc");
    save(s, c, store);
    expect(remove(s, store)?.did).toBe("did:plc:abc");
    expect(existsSync(credentialsFile(s))).toBe(false);
    expect(store.get(account(c.registry, c.did))).toBeNull();
    writeFileSync(credentialsFile(s), "{garbage");
    expect(remove(s, store)).toBeNull();
    expect(existsSync(credentialsFile(s))).toBe(false);
    expect(remove(s, store)).toBeNull();
  });

  it("corrupt_file_on_load_says_to_log_in", async () => {
    const dir = tmp();
    const s = settings(dir, "auto");
    writeFileSync(credentialsFile(s), "{garbage");
    const err = await load(s, new MemoryStore(), noEnv).catch((e) => e);
    expect(err.isAuth() && err.message.includes("hpy registry login")).toBe(true);
  });

  // Rust's Debug impl hid the token; TypeScript has no Debug, and no code path
  // prints a Credential. The key's own toString shows only its thumbprint.
  it("debug_never_shows_secrets", async () => {
    const c = await cred("did:plc:abc");
    expect(String(c.dpopKey)).toBe(`DpopKey(${c.dpopKey.thumbprint()})`);
  });

  it("saving_and_removing_clear_leftovers", async () => {
    const dir = tmp();
    const s = settings(dir, "file");
    writeFileSync(join(dir, "session.toml"), 'did = "x"');
    save(s, await cred("did:plc:abc"), new MemoryStore());
    expect(existsSync(join(dir, "session.toml"))).toBe(false);
    writeFileSync(join(dir, "credentials.json.tmp"), "{}");
    remove(s, new MemoryStore());
    expect(existsSync(join(dir, "credentials.json.tmp"))).toBe(false);
  });

  it("reads what the Rust exporter and save() wrote (test/fixtures/credentials)", async () => {
    const fixtures = fileURLToPath(new URL("../fixtures/credentials/", import.meta.url));
    const c = await importCredential(readFileSync(join(fixtures, "HPY_CREDENTIAL"), "utf8"));
    expect(c.dpopKey.thumbprint()).toBe("dANLZuw-YcgAZFy8Ai1GCunPGJXy1EnSrx1q8nfRZB8");
    const dir = tmp();
    writeFileSync(
      join(dir, "credentials.json"),
      readFileSync(join(fixtures, "credentials.file.json")),
    );
    const fromFile = await load(settings(dir, "auto"), new MustNotBeUsed(), noEnv);
    expect(fromFile?.dpopKey.thumbprint()).toBe(c.dpopKey.thumbprint());
    // And writes it back the same way: --export is byte-identical to Rust's.
    expect(exportCredential(c)).toBe(readFileSync(join(fixtures, "HPY_CREDENTIAL"), "utf8").trim());
  });
});
