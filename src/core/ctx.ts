// crates/hpy/src/ctx.rs: what every command gets.
import type { Credential } from "../atproto/credential.ts";
import * as credential from "../atproto/credential.ts";
import { Keychain, type KeyStore, loadKeychain } from "../atproto/keystore.ts";
import { processEnv, type Settings } from "../atproto/settings.ts";
import { Failure } from "./failure.ts";
import type { Output } from "./output.ts";
import type { Prompter } from "./prompt.ts";

export class Ctx {
  readonly settings: Settings;
  readonly prompter: Prompter;
  readonly out: Output;
  readonly dir: string;
  #keystore: KeyStore | undefined;

  constructor(
    settings: Settings,
    prompter: Prompter,
    out: Output,
    dir: string,
    keystore?: KeyStore,
  ) {
    this.settings = settings;
    this.prompter = prompter;
    this.out = out;
    this.dir = dir;
    this.#keystore = keystore;
  }

  /** Where the DPoP key is kept; the addon loads on first use. */
  async keystore(): Promise<KeyStore> {
    if (!this.#keystore) {
      await loadKeychain();
      this.#keystore = new Keychain();
    }
    return this.#keystore;
  }

  async session(): Promise<Credential> {
    const c = await credential.load(this.settings, await this.keystore(), processEnv);
    if (!c) throw Failure.notLoggedIn();
    return c;
  }
}
