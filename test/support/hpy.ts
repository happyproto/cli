// Runs the built hpy (dist/hpy.mjs, or HPY_TEST_BIN, e.g. a Bun-compiled
// binary) in a private config directory, the way tests/cli.rs's `hpy()` did.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa, type Options } from "execa";

const BIN = process.env.HPY_TEST_BIN;
const SCRIPT = fileURLToPath(new URL("../../dist/hpy.mjs", import.meta.url));
const KEYRING_HOOK = fileURLToPath(new URL("./keyring-hook.mjs", import.meta.url));

/**
 * Node's arguments for running dist/hpy.mjs with the OS keychain swapped for
 * keyring-fake.mjs. A Bun binary (HPY_TEST_BIN) has the addon built in, so there only
 * HPY_CREDENTIAL_STORE=file keeps it away from the keychain.
 */
export const NODE_ARGS: readonly string[] = ["--import", KEYRING_HOOK, "--", SCRIPT];

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export class Home {
  readonly dir = mkdtempSync(join(tmpdir(), "hpy-test-"));
  /** The XDG config base: hpy keeps its files in `${config}/hpy`. */
  get config(): string {
    return this.dir;
  }
  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The environment `hpy` runs with in `home`, plus `extra`. */
export function hpyEnv(
  home: Home,
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: home.config,
    APPDATA: home.config,
    XDG_CACHE_HOME: join(home.dir, "cache"),
    XDG_DATA_HOME: join(home.dir, "data"),
    HOME: home.dir,
    HPY_CREDENTIAL: undefined,
    HPY_CREDENTIAL_STORE: "file",
    HPY_REGISTRY_URL: "http://127.0.0.1:9",
    HPY_NO_UPDATE_CHECK: "1",
    ...extra,
  };
  if (env.HPY_CREDENTIAL_STORE !== "file")
    throw new Error("a spawned hpy keeps its secrets in files (HPY_CREDENTIAL_STORE=file)");
  return env;
}

/** The program and leading arguments that run the built `hpy`. */
export function hpyCommand(): [string, string[]] {
  return BIN ? [BIN, []] : [process.execPath, [...NODE_ARGS]];
}

export async function hpy(
  home: Home,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; input?: string } = {},
): Promise<Run> {
  const env = hpyEnv(home, opts.env ?? {});
  const options: Options = {
    env,
    extendEnv: false,
    reject: false,
    stripFinalNewline: false,
    cwd: opts.cwd ?? home.dir,
    input: opts.input ?? "",
  };
  const r = BIN
    ? await execa(BIN, args, options)
    : await execa(process.execPath, [...NODE_ARGS, ...args], options);
  return { code: r.exitCode ?? -1, stdout: String(r.stdout), stderr: String(r.stderr) };
}
