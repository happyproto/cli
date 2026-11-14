// crates/hpy/src/commands/auth.rs: registry login, logout and whoami.

import type { Credential, Identity } from "../atproto/credential.ts";
import * as credential from "../atproto/credential.ts";
import { HappyView } from "../atproto/happyview.ts";
import { credentialsFile, processEnv } from "../atproto/settings.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import type { Json } from "../core/output.ts";

const noEnv = () => undefined;

/** `@handle (did)`, or the bare DID when the handle is unknown. */
export function who(did: string, handle: string | null | undefined): string {
  return handle ? `@${handle} (${did})` : did;
}

function describe(i: Identity): Json {
  return { did: i.did, handle: i.handle, pds: i.pds, registry: i.registry, keyStorage: i.storage };
}

/** Best effort: the local copy is forgotten either way. */
async function revoke(c: Credential): Promise<void> {
  try {
    await new HappyView(c.registry, c.clientKey).revoke(c);
  } catch {}
}

export async function login(ctx: Ctx, args: Args): Promise<void> {
  const identifier = await ctx.prompter.required(
    "<IDENTIFIER>",
    "Handle or DID:",
    args.IDENTIFIER as string | undefined,
    undefined,
    (s) => (s.trim() === "" ? "required" : null),
  );
  const { login: doLogin } = await import("../atproto/login.ts");
  const { NetworkResolver } = await import("../atproto/resolve.ts");
  const hv = new HappyView(ctx.settings.registryUrl, ctx.settings.clientKey);
  const show = (url: string) => {
    process.stderr.write(`Open this URL to authorize hpy:\n\n  ${url}\n\n`);
    process.stderr.write("Waiting for you to authorize hpy in your browser…\n");
  };
  const cred = await doLogin(ctx.settings, new NetworkResolver(), hv, {
    identifier,
    openBrowser: args.browser !== false,
    showUrl: show,
  });
  const name = who(cred.did, cred.handle);

  if (args.export) {
    ctx.out.status(
      `Signed in as ${name} for CI. Store the credential below as the HPY_CREDENTIAL secret; it acts as you. Revoke it with \`HPY_CREDENTIAL=… hpy registry logout\`.`,
    );
    const exported = credential.exportCredential(cred);
    ctx.out.done(exported, { did: cred.did, handle: cred.handle, credential: exported });
    return;
  }

  // Replace, don't accumulate: sign the previous session out first.
  const store = await ctx.keystore();
  try {
    const previous = await credential.load(ctx.settings, store, noEnv);
    if (previous) await revoke(previous);
  } catch {}
  try {
    credential.remove(ctx.settings, store);
  } catch {}
  const saved = credential.save(ctx.settings, cred, store);
  if (saved.kind === "file" && saved.reason !== null)
    ctx.out.status(
      `Your OS keychain isn't available (${saved.reason}), so your key is stored in ${credentialsFile(ctx.settings)}, readable only by you.`,
    );
  const identity = await credential.peek(ctx.settings, noEnv);
  if (!identity) throw Failure.runtime("the login was not saved");
  ctx.out.done(`Logged in as ${name}`, describe(identity));
}

export async function logout(ctx: Ctx): Promise<void> {
  const exported = processEnv(credential.ENV_VAR);
  if (exported !== undefined) {
    const c = await credential.importCredential(exported);
    const name = who(c.did, c.handle);
    // Logging out is idempotent: a session HappyView no longer knows is already revoked.
    let message: string;
    try {
      await new HappyView(c.registry, c.clientKey).revoke(c);
      message = `Revoked the HPY_CREDENTIAL session for ${name}`;
    } catch (e) {
      const f = Failure.from(e);
      if (f.code !== 3) throw f;
      message = `The HPY_CREDENTIAL session for ${name} was already revoked`;
    }
    ctx.out.done(message, { revoked: c.did });
    return;
  }
  const store = await ctx.keystore();
  try {
    const c = await credential.load(ctx.settings, store, noEnv);
    if (c) await revoke(c);
  } catch {}
  const i = credential.remove(ctx.settings, store);
  if (i) ctx.out.done(`Logged out ${who(i.did, i.handle)}`, { loggedOut: i.did });
  else ctx.out.done("Not logged in.", { loggedOut: null });
}

export async function whoami(ctx: Ctx): Promise<void> {
  const identity = await credential.peek(ctx.settings, processEnv);
  if (!identity) throw Failure.notLoggedIn();
  const storage =
    identity.storage === "keychain"
      ? "key in the OS keychain"
      : identity.storage === "file"
        ? "key in the credentials file"
        : "from HPY_CREDENTIAL";
  ctx.out.done(
    `${who(identity.did, identity.handle)} on ${identity.pds} (${storage})`,
    describe(identity),
  );
}
