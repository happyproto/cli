// hpy-atproto/src/keystore.rs: where the DPoP private key lives. The OS
// keychain (macOS Keychain, Windows Credential Manager, the Secret Service on
// Linux) through @napi-rs/keyring, or memory for tests.

export const SERVICE = "hpy";

/** Why a store failed: `unavailable` (no usable keychain here) lets `auto` fall back to the file. */
export class KeyStoreError extends Error {
  readonly unavailable: boolean;
  constructor(message: string, unavailable: boolean) {
    super(message);
    this.unavailable = unavailable;
  }
}

export interface KeyStore {
  get(account: string): string | null;
  set(account: string, secret: string): void;
  /** Deleting what is not there succeeds. */
  delete(account: string): void;
}

/**
 * keyring's errors, by their Display text: @napi-rs/keyring raises every one as
 * GenericFailure, so the message is all there is. NoStorageAccess, PlatformFailure,
 * NoDefaultStore and NotSupportedByStore mean there is no usable keychain here. The
 * patterns cover both keyring v3's wording and keyring-core's, which @napi-rs/keyring 2.x
 * uses ("Couldn't access platform storage:", "Platform failure:", "Unsupported:", "No default
 * store has been set").
 */
export function classify(e: unknown): KeyStoreError {
  const msg = e instanceof Error ? e.message : String(e);
  const unavailable =
    /access platform secure storage|platform storage|Platform secure storage failure|Platform failure|^Unsupported:|No default store|not supported by/i.test(
      msg,
    );
  return new KeyStoreError(msg, unavailable);
}

type EntryCtor = new (
  service: string,
  account: string,
) => {
  getPassword(): string | null | undefined;
  setPassword(s: string): void;
  deletePassword(): boolean | undefined;
};

let entryCtor: EntryCtor | undefined;

/** Loads the addon on first use; a failure to load is an unavailable keychain. */
export async function loadKeychain(): Promise<void> {
  if (entryCtor) return;
  try {
    // A literal specifier, so `bun build --compile` embeds the addon.
    const mod = await import("@napi-rs/keyring");
    entryCtor = mod.Entry as unknown as EntryCtor;
  } catch (e) {
    entryCtor = undefined;
    loadError = classify(e);
    loadError = new KeyStoreError(loadError.message, true);
  }
}
let loadError: KeyStoreError | undefined;

/** The OS keychain. Call `loadKeychain()` first. */
export class Keychain implements KeyStore {
  readonly service: string;

  constructor(service = process.env.HPY_KEYCHAIN_SERVICE_FOR_TESTS || SERVICE) {
    this.service = service;
  }

  #entry(account: string) {
    if (!entryCtor) throw loadError ?? new KeyStoreError("the OS keychain is not loaded", true);
    try {
      return new entryCtor(this.service, account);
    } catch (e) {
      throw classify(e);
    }
  }

  get(account: string): string | null {
    const entry = this.#entry(account);
    try {
      return entry.getPassword() ?? null;
    } catch (e) {
      if (/no matching entry|NoEntry/i.test(String(e))) return null;
      throw classify(e);
    }
  }

  set(account: string, secret: string): void {
    const entry = this.#entry(account);
    try {
      entry.setPassword(secret);
    } catch (e) {
      throw classify(e);
    }
  }

  delete(account: string): void {
    const entry = this.#entry(account);
    try {
      entry.deletePassword();
    } catch (e) {
      if (/no matching entry|NoEntry/i.test(String(e))) return;
      throw classify(e);
    }
  }
}

/** An in-memory store, for tests. */
export class MemoryStore implements KeyStore {
  readonly map = new Map<string, string>();
  get(a: string) {
    return this.map.get(a) ?? null;
  }
  set(a: string, s: string) {
    this.map.set(a, s);
  }
  delete(a: string) {
    this.map.delete(a);
  }
}
