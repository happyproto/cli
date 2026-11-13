// hpy-atproto/src/session.rs: the active session, the stored (or `HPY_CREDENTIAL`) credential
// wired to HappyView.

import type { Credential } from "./credential.ts";
import * as credential from "./credential.ts";
import { HappyView } from "./happyview.ts";
import type { KeyStore } from "./keystore.ts";
import { HttpRegistry } from "./registry.ts";
import { HappyViewRepo, type Repo } from "./repo.ts";
import { processEnv, type Settings } from "./settings.ts";

export class Session {
  readonly credential: Credential;
  readonly happyview: HappyView;
  readonly repo: Repo;

  constructor(cred: Credential) {
    this.credential = cred;
    this.happyview = new HappyView(cred.registry, cred.clientKey);
    this.repo = new HappyViewRepo(this.happyview, cred);
  }

  /** The registry, able to publish as this session. */
  registry(): HttpRegistry {
    return new HttpRegistry(this.credential.registry).withSession(this.happyview, this.credential);
  }
}

export async function current(settings: Settings, store: KeyStore): Promise<Session | null> {
  const c = await credential.load(settings, store, processEnv);
  return c ? new Session(c) : null;
}
