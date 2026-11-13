// crates/hpy/src/ctx.rs: what every command gets.
import { Keychain, type KeyStore, loadKeychain } from "../atproto/keystore.ts";
import { HttpRegistry } from "../atproto/registry.ts";
import type { Session } from "../atproto/session.ts";
import * as session from "../atproto/session.ts";
import type { Settings } from "../atproto/settings.ts";
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

  async session(): Promise<Session> {
    const s = await session.current(this.settings, await this.keystore());
    if (!s) throw Failure.notLoggedIn();
    return s;
  }

  /** The registry, for reads; publishing goes through `Session.registry`. */
  registry(): HttpRegistry {
    return new HttpRegistry(this.settings.registryUrl);
  }
}
