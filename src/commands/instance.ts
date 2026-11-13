// crates/hpy/src/commands/happyview/instance.rs: `hpy hv login`, `logout` and
// `whoami`, the sign-ins to HappyView instances' admin APIs.
import { Admin } from "../atproto/admin.ts";
import type { Credential, Saved } from "../atproto/credential.ts";
import * as credential from "../atproto/credential.ts";
import { AtprotoError } from "../atproto/error.ts";
import { HappyView } from "../atproto/happyview.ts";
import { DECODE_ERROR, parseJson, request, statusText, transportError } from "../atproto/http.ts";
import type { Auth, Info } from "../atproto/instance.ts";
import * as instance from "../atproto/instance.ts";
import { processEnv } from "../atproto/settings.ts";
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import type { Json } from "../core/output.ts";

const noEnv = () => undefined;

const describe = (i: Info): Json => ({
  url: i.url,
  kind: i.kind,
  account: i.account,
  storage: i.storage,
});

function adminFor(auth: Auth, url: string): Admin {
  return auth.kind === "apiKey" ? Admin.withKey(url, auth.key) : Admin.withSession(auth.cred);
}

/** The admin API of the instance `--url` (or the environment, or the only sign-in) names. */
export async function admin(ctx: Ctx, url: string | undefined): Promise<Admin> {
  const login = await instance.current(ctx.settings, () => ctx.keystore(), processEnv, url);
  return adminFor(login.auth, login.url);
}

/** Signs a session out on its instance. Best effort: the local copy is forgotten either way. */
async function revoke(cred: Credential): Promise<void> {
  try {
    await new HappyView(cred.registry, cred.clientKey).revoke(cred);
  } catch {}
}

/** The key of the instance's built-in `hpy` client, as its `/config` names it; `HPY_HV_CLIENT_KEY` overrides it. */
async function clientKey(url: string): Promise<string> {
  const override = processEnv("HPY_HV_CLIENT_KEY");
  if (override !== undefined) return override;
  let resp: Response;
  try {
    resp = await request(`${url}/config`, { timeout: 30 });
  } catch (e) {
    throw Failure.runtime(`could not reach ${url}: ${transportError(e)}`);
  }
  if (!resp.ok)
    throw Failure.runtime(
      `could not reach ${url}: HTTP status ${resp.status >= 500 ? "server" : "client"} error (${statusText(resp.status)}) for url (${url}/config)`,
    );
  let config: unknown;
  try {
    config = parseJson(new Uint8Array(await resp.arrayBuffer()));
  } catch {
    throw Failure.runtime(`${url}/config is not a HappyView's: ${DECODE_ERROR}`);
  }
  const key = (config as { cli_client_key?: unknown } | null)?.cli_client_key;
  return typeof key === "string" ? key : instance.DEFAULT_CLIENT_KEY;
}

/** `read_line`: stdin up to and including the first newline, or to its end. */
async function readLine(): Promise<string> {
  let line = "";
  for await (const chunk of process.stdin) {
    line += chunk.toString();
    const nl = line.indexOf("\n");
    if (nl !== -1) {
      process.stdin.pause();
      return line.slice(0, nl + 1);
    }
  }
  return line;
}

async function loginWithKey(ctx: Ctx, url: string): Promise<Saved> {
  const key = (await readLine()).trim();
  const bad = instance.checkKey(key);
  if (bad !== null) throw Failure.usage(bad);
  // Listing plugins is the first thing a deploy does, so a key that can't isn't worth saving.
  await Admin.withKey(url, key).plugins();
  return instance.saveKey(ctx.settings, url, key, await ctx.keystore());
}

async function loginWithBrowser(
  ctx: Ctx,
  url: string,
  identifierArg: string | undefined,
  openBrowser: boolean,
): Promise<Saved> {
  let suggested: string | undefined;
  try {
    const i = await credential.peek(ctx.settings, noEnv);
    if (i) suggested = i.handle ?? i.did;
  } catch {}
  const identifier = await ctx.prompter.required(
    "<IDENTIFIER>",
    "Handle or DID:",
    identifierArg,
    suggested,
    (s) => (s.trim() === "" ? "required" : null),
  );
  const key = await clientKey(url);
  const settings = instance.loginSettings(ctx.settings, url, key);
  const hv = new HappyView(url, key);
  const show = (link: string) => {
    process.stderr.write(`Open this URL to sign in to ${url}:\n\n  ${link}\n\n`);
    process.stderr.write("Waiting for you to sign in in your browser…\n");
  };
  const { login } = await import("../atproto/login.ts");
  const { NetworkResolver } = await import("../atproto/resolve.ts");
  const cred = await login(settings, new NetworkResolver(), hv, {
    identifier,
    openBrowser,
    showUrl: show,
  });
  // A session the instance won't let deploy is no use; don't keep it.
  if (!instance.grantsAdmin(cred.scopes)) {
    await revoke(cred);
    throw Failure.runtime(
      `the sign-in didn't grant managing ${url}: your account's server (PDS) gave only \`${cred.scopes}\`. Signing in to deploy needs a PDS that supports atproto permission sets`,
    );
  }
  try {
    await Admin.withSession(cred).project();
  } catch (e) {
    await revoke(cred);
    throw e;
  }
  const store = await ctx.keystore();
  let previous: Auth | undefined;
  try {
    previous = (await instance.current(ctx.settings, store, noEnv, url)).auth;
  } catch {}
  const saved = instance.saveSession(ctx.settings, cred, store);
  if (previous?.kind === "session") await revoke(previous.cred);
  return saved;
}

export async function login(ctx: Ctx, args: Args): Promise<void> {
  const given = await ctx.prompter.required(
    "--url",
    "Instance URL:",
    args.url as string | undefined,
    undefined,
    (s) => {
      try {
        instance.normalizeUrl(s);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
  );
  const url = instance.normalizeUrl(given);
  const saved = args.keyStdin
    ? await loginWithKey(ctx, url)
    : await loginWithBrowser(
        ctx,
        url,
        args.IDENTIFIER as string | undefined,
        args.browser !== false,
      );
  if (saved.kind === "file" && saved.reason !== null) {
    const { join } = await import("node:path");
    ctx.out.status(
      `Your OS keychain isn't available (${saved.reason}), so your sign-in is stored in ${join(ctx.settings.configDir, "instances.json")}, readable only by you.`,
    );
  }
  const info = instance.list(ctx.settings).find((i) => i.url === url);
  if (!info) throw Failure.runtime("the sign-in was not saved");
  ctx.out.done(`Signed in to ${url} as ${info.account}`, describe(info));
}

export async function logout(ctx: Ctx, args: Args): Promise<void> {
  const url = args.url as string | undefined;
  try {
    const login = await instance.current(ctx.settings, () => ctx.keystore(), noEnv, url);
    if (login.auth.kind === "session") await revoke(login.auth.cred);
  } catch {}
  const store = await ctx.keystore();
  const i = instance.remove(ctx.settings, store, url);
  if (i === null) ctx.out.done("Not signed in.", { loggedOut: null });
  else if (i.kind === "apiKey")
    ctx.out.done(
      `Forgot the API key for ${i.url}. It still works until you revoke it in the instance's dashboard.`,
      { loggedOut: i.url },
    );
  else ctx.out.done(`Signed out of ${i.url}`, { loggedOut: i.url });
}

export async function whoami(ctx: Ctx): Promise<void> {
  const signedIn = instance.list(ctx.settings);
  const url = processEnv(instance.URL_VAR);
  const key = processEnv(instance.KEY_VAR);
  if (url !== undefined && key !== undefined)
    signedIn.unshift({
      url: instance.normalizeUrl(url),
      kind: "apiKey",
      account: `API key ${instance.prefix(key)}`,
      storage: "environment",
    });
  if (signedIn.length === 0)
    throw Failure.from(
      AtprotoError.loginRequired(
        "not signed in to a HappyView instance; run `hpy hv login --url <instance>`",
      ),
    );
  const where = {
    keychain: "in the OS keychain",
    file: "in instances.json",
    environment: "from HPY_HV_API_KEY",
  };
  ctx.out.done(signedIn.map((i) => `${i.url} as ${i.account} (${where[i.storage]})`).join("\n"), {
    instances: signedIn.map(describe),
  });
}
