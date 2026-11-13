// crates/hpy/src/commands/happyview/network.rs: `dev --network local`: the project's HappyView
// inside a private atproto network, with its logs in the foreground. Unix only; `dev` refuses
// it elsewhere before calling `runLocal`.
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { Ctx } from "../core/ctx.ts";
import { Failure } from "../core/failure.ts";
import { createDirAll, ioErrorText, readToString } from "../core/io.ts";
import { comparePaths, rustJoin, rustParent } from "../core/paths.ts";
import { lines, trim } from "../core/rust-str.ts";
import { httpClient } from "../project/binary.ts";
import { CONFIG_FILE, findRoot, ProjectToml } from "../project/config.ts";
import { languages, writeEditorConfig } from "../project/editor.ts";
import { readModules, Snapshot } from "../project/modules.ts";
import { ensureAccess, recordPath } from "../project/network/access.ts";
import { accountsPath, type SeededAccount, seededSuperadmin } from "../project/network/accounts.ts";
import {
  APP_ID,
  type AppConfig,
  BACKFILL_ON_LOCAL,
  LOCAL_DB_DIR,
  PUBLIC_URL,
  writeApp,
} from "../project/network/app.ts";
import {
  canonicalize,
  checkTools,
  dataRoot,
  fetchCheckout,
  installCheckout,
  isFile,
  type NetworkDir,
  networkDir,
  PINNED,
} from "../project/network/atmosbox.ts";
import { type Runner, SystemRunner } from "../project/network/runner.ts";
import { chooseSubnet, Sandbox } from "../project/network/sandbox.ts";
import { prepare } from "../project/prepare.ts";
import { finish, firstBuildUntil, ModuleWatcher } from "../project/run.ts";

/** Where the sandbox's access relay listens. Only one process on this computer can hold it. */
const ACCESS_ADDR = "127.0.0.1:443";
/**
 * Replaces `ACCESS_ADDR` for the free-port probe only, so tests need not depend on what holds
 * 443 on the machine running them. The relay still listens on `ACCESS_ADDR`.
 */
const ACCESS_ADDR_ENV = "HPY_NETWORK_ACCESS_ADDR";
/** The file in a network directory naming the project it belongs to. */
const PROJECT_FILE = "project";

/** What `dev --network local` reads of `dev`'s arguments (cli.rs `DevArgs`). */
export interface DevArgs {
  /** `--locked`, from the shared run arguments. */
  locked: boolean;
  reset: boolean;
  subnet: string | undefined;
  yes: boolean;
}

const runtime = (e: unknown): Failure => Failure.runtime(ioErrorText(e));

export function linuxTarget(dockerArch: string): string {
  const arch = trim(dockerArch);
  if (arch === "x86_64" || arch === "amd64") return "x86_64-unknown-linux-musl";
  if (arch === "aarch64" || arch === "arm64") return "aarch64-unknown-linux-musl";
  throw Failure.usage(`HappyView publishes no Linux binary for Docker's \`${arch}\` architecture`);
}

/** `accounts` is where the password is kept; `accessRecord` is the file whose removal repeats the one-time setup. */
export function banner(
  account: SeededAccount,
  interactive: boolean,
  accounts: string,
  accessRecord: string,
): string {
  const password = interactive ? `password ${account.password}` : `password in ${accounts}`;
  return (
    `local network ready: ${PUBLIC_URL}\n  sign in as ${account.handle} (${password}); that account is the superadmin\n  ` +
    `a certificate error in the browser? delete ${accessRecord} and run this again to repeat the one-time setup\n  ` +
    "writes stay on this computer; Ctrl-C stops the network and keeps its data"
  );
}

/**
 * The seeded password is a throwaway, but it still reaches only a person at a terminal: never
 * a log, a pipe, or a `--json` consumer.
 */
export function showsPassword(interactive: boolean, json: boolean): boolean {
  return interactive && !json;
}

/**
 * `docker inspect` of the HappyView container once its logs end: still running means the
 * developer stopped following them, so `hpy` exits 0; stopped means HappyView exited, and its
 * code is passed on.
 */
export function exitFromInspect(out: string): number {
  const parts = out.split(/\p{White_Space}+/u).filter((p) => p !== "");
  if (parts[0] === "true") return 0;
  // Rust parses an `i32`, which takes a leading `+` or `-`.
  if (parts[0] === "false" && parts[1] !== undefined && /^[+-]?[0-9]+$/.test(parts[1])) {
    const n = Number(parts[1]);
    if (n >= -2147483648 && n <= 2147483647) return n;
  }
  return 1;
}

/**
 * Creates the network directory if it is new, recording which project it belongs to. A new one
 * is also when a moved or renamed project shows up, so it answers a line for every network
 * whose project no longer exists. Nothing is deleted: those networks hold the only copy of
 * their data.
 */
export function claimNetworkDir(net: NetworkDir, projectRoot: string): string[] {
  const canonical = canonicalize(projectRoot);
  const record = (dir: string) => {
    try {
      writeFileSync(rustJoin(dir, PROJECT_FILE), canonical);
    } catch (e) {
      throw runtime(e);
    }
  };
  if (existsSync(net.dir)) {
    if (!isFile(rustJoin(net.dir, PROJECT_FILE))) record(net.dir);
    return [];
  }
  try {
    createDirAll(net.dir);
  } catch (e) {
    throw runtime(e);
  }
  record(net.dir);
  const networks = rustParent(net.dir);
  if (networks === undefined) return [];
  let others: string[];
  try {
    others = readdirSync(networks)
      .map((n) => rustJoin(networks, n))
      .filter((p) => p !== net.dir);
  } catch (e) {
    throw runtime(e);
  }
  others.sort(comparePaths);
  const found: string[] = [];
  for (const dir of others) {
    let old: string;
    try {
      old = readToString(rustJoin(dir, PROJECT_FILE));
    } catch {
      continue;
    }
    if (!existsSync(old)) {
      found.push(
        `a local network for ${old}, which no longer exists, is at ${dir}; remove it with ` +
          `\`deno task sandbox destroy --accept-destructive\` in ${rustJoin(dir, PINNED.top)}`,
      );
    }
  }
  return found;
}

/** The host's uid and gid, which the container runs HappyView as so its files in the project are the developer's. */
function hostIds(): [number, number] {
  return [process.getuid?.() ?? 0, process.getgid?.() ?? 0];
}

/**
 * Ctrl-C, caught so `hpy` decides when the run stops. Every child runs in a process group of
 * its own (see `runner`), so the terminal's Ctrl-C reaches `hpy` alone: a sandbox command is
 * never cut off part way, which would leave the sandbox locked, and `hpy` stops the network
 * once the step in progress has finished.
 *
 * tokio's `Signal` keeps at most one undelivered signal; so does `#waiting`.
 */
class Interrupt {
  #seen = false;
  #waiting = false;
  #wake: (() => void) | undefined;

  static install(): Interrupt {
    const i = new Interrupt();
    process.on("SIGINT", () => {
      const wake = i.#wake;
      if (wake !== undefined) {
        i.#wake = undefined;
        wake();
      } else i.#waiting = true;
    });
    return i;
  }

  /** Resolves on the next Ctrl-C (or one waiting), marking it seen. */
  recv(): { promise: Promise<void>; cancel: () => void } {
    if (this.#waiting) {
      this.#waiting = false;
      this.#seen = true;
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => {
      wake = () => {
        this.#seen = true;
        resolve();
      };
    });
    this.#wake = wake;
    return {
      promise,
      cancel: () => {
        if (this.#wake === wake) this.#wake = undefined;
      },
    };
  }

  /** Whether a Ctrl-C has arrived, taking one that is waiting without waiting for one. */
  seen(): boolean {
    if (!this.#seen && this.#waiting) {
      this.#waiting = false;
      this.#seen = true;
    }
    return this.#seen;
  }
}

/** A run stopped by Ctrl-C, after each step was left to finish or stop on its own terms. */
class Interrupted {}

const INTERRUPTED = new Interrupted();

type Raced<T> = { done: true; value: T } | { done: false };

/** `tokio::select!` of `fut` against the next Ctrl-C; a rejection of `fut` propagates. */
async function race<T>(interrupt: Interrupt, fut: Promise<T>): Promise<Raced<T>> {
  const signal = interrupt.recv();
  try {
    return await Promise.race([
      fut.then((value): Raced<T> => ({ done: true, value })),
      signal.promise.then((): Raced<T> => ({ done: false })),
    ]);
  } finally {
    signal.cancel();
  }
}

/**
 * Runs a step that has a child and waits for it to finish, even after a Ctrl-C: the signal
 * prints one line, naming the step as `what`, saying the run stops once it is done. No step
 * starts after a Ctrl-C.
 */
async function step<T>(
  ctx: Ctx,
  interrupt: Interrupt,
  what: string,
  start: () => Promise<T>,
): Promise<T> {
  if (interrupt.seen()) throw INTERRUPTED;
  type Settled = { ok: true; value: T } | { ok: false; error: unknown };
  const fut: Promise<Settled> = start().then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  const raced = await race(interrupt, fut);
  let result: Settled;
  if (raced.done) result = raced.value;
  else {
    ctx.out.status(
      `Ctrl-C: stopping once ${what} has finished; cutting it short could leave the sandbox locked`,
    );
    result = await fut;
  }
  if (interrupt.seen()) throw INTERRUPTED;
  if (!result.ok) throw result.error;
  return result.value;
}

/** A step with no child to wait for, abandoned at once on Ctrl-C. */
async function abandonable<T>(interrupt: Interrupt, start: () => Promise<T>): Promise<T> {
  if (interrupt.seen()) throw INTERRUPTED;
  const fut = start();
  fut.catch(() => {});
  const raced = await race(interrupt, fut);
  if (!raced.done) throw INTERRUPTED;
  return raced.value;
}

/** The Compose projects whose access relay is running. */
async function relayProjects(r: Runner, cwd: string): Promise<string[]> {
  const out = await r.capture(
    "docker",
    [
      "ps",
      "--filter",
      "label=com.docker.compose.service=host-access",
      "--format",
      '{{.Label "com.docker.compose.project"}}',
    ],
    cwd,
  );
  return lines(out)
    .map(trim)
    .filter((p) => p !== "");
}

function relayHeldBy(other: string): Failure {
  return Failure.usage(
    `another local network (${other}) holds ${ACCESS_ADDR}; stop it first (Ctrl-C in its terminal, ` +
      "or `deno task sandbox access stop` in its checkout)",
  );
}

/** `std::net::SocketAddr`'s parser, for the IPv4 and bracketed IPv6 forms; `undefined` for anything else. */
function socketAddr(s: string): { host: string; port: number } | undefined {
  const m = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:.]+)\]):(\d{1,5})$/.exec(s);
  if (!m) return undefined;
  const port = Number(m[3]);
  if (port > 65535 || (m[3]!.length > 1 && m[3]!.startsWith("0"))) return undefined;
  if (m[1] !== undefined) {
    const octets = m[1].split(".");
    if (octets.some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith("0"))))
      return undefined;
    return { host: m[1], port };
  }
  return { host: m[2]!, port };
}

/** `TcpStream::connect_timeout(addr, 500ms).is_ok()`. */
function listening(addr: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: addr.host, port: addr.port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Refuses before the relay starts if its port is taken by anything but this sandbox's own
 * relay; the sandbox would otherwise fail without saying why.
 */
async function ensureRelayPortFree(sandbox: Sandbox): Promise<void> {
  const projects = await relayProjects(sandbox.runner, sandbox.checkout);
  const other = projects.find((p) => p !== sandbox.project);
  if (other !== undefined) throw relayHeldBy(other);
  if (projects.includes(sandbox.project)) return;
  const fromEnv = process.env[ACCESS_ADDR_ENV];
  const addr = fromEnv !== undefined && fromEnv !== "" ? fromEnv : ACCESS_ADDR;
  const parsed = socketAddr(addr);
  if (parsed !== undefined && (await listening(parsed))) {
    throw Failure.usage(
      `something else is listening on ${addr} (the local network's HTTPS relay needs it); stop it first`,
    );
  }
}

async function happyviewContainer(sandbox: Sandbox): Promise<string | undefined> {
  const filter = (k: string, v: string) => `label=com.docker.compose.${k}=${v}`;
  const names = await sandbox.runner.capture(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      filter("project", sandbox.project),
      "--filter",
      filter("service", APP_ID),
      "--format",
      "{{.Names}}",
    ],
    sandbox.checkout,
  );
  return lines(names)
    .map(trim)
    .find((n) => n !== "");
}

/**
 * `up`, followed on failure by HappyView's own last words: the sandbox withholds Compose's
 * output, so a HappyView that dies at boot would otherwise surface only as a failed `up`.
 */
async function up(ctx: Ctx, interrupt: Interrupt, sandbox: Sandbox): Promise<void> {
  try {
    await step(ctx, interrupt, "starting the local network", () => sandbox.up());
  } catch (e) {
    if (e instanceof Interrupted) throw e;
    let name: string | undefined;
    try {
      name = await happyviewContainer(sandbox);
    } catch {}
    if (name !== undefined) {
      ctx.out.status("the HappyView container's last 50 log lines:");
      try {
        await sandbox.runner.showOnStderr(
          "docker",
          ["logs", "--tail", "50", name],
          sandbox.checkout,
        );
      } catch {}
    }
    throw e;
  }
}

async function stop(ctx: Ctx, sandbox: Sandbox): Promise<void> {
  ctx.out.status("stopping the local network (its data is kept)");
  // Both are attempted: a relay that would not stop is no reason to leave the whole network
  // running.
  let access: unknown;
  let failed = false;
  try {
    await sandbox.accessStop();
  } catch (e) {
    access = e;
    failed = true;
  }
  await sandbox.down().catch((e) => {
    if (!failed) {
      access = e;
      failed = true;
    }
  });
  if (failed) throw access;
}

const warn = (ctx: Ctx, e: unknown) => ctx.out.status(`warning: ${Failure.from(e).message}`);

/** Where the run stood when `start` returned or threw. */
interface Progress {
  sandbox: Sandbox | undefined;
  /** True once anything may have started, which is from when a failure has to stop the network again. */
  running: boolean;
}

interface Started {
  networkDir: string;
  account: SeededAccount;
  root: string;
  from: Snapshot;
}

/** `dev --network local`. Every child runs as `runner` has it; see `SystemRunner`. */
export async function runLocal(ctx: Ctx, args: DevArgs): Promise<void> {
  // Before any child: from here on Ctrl-C reaches `hpy` as an event rather than ending it.
  const interrupt = Interrupt.install();
  const runner = new SystemRunner({ stdoutToStderr: ctx.out.isJson() });
  const progress: Progress = { sandbox: undefined, running: false };
  let started: Started;
  try {
    started = await start(ctx, args, runner, interrupt, progress);
  } catch (e) {
    const { sandbox, running } = progress;
    if (e instanceof Interrupted) {
      // Each step was left to finish or stop on its own terms. Running containers are stopped
      // like after a failure, except while a step is pending: the sandbox then refuses all but
      // `resume`.
      if (sandbox !== undefined && running && sandbox.pending())
        ctx.out.status(
          "interrupted; the local network's containers may still be running until the next run resumes it",
        );
      else if (sandbox !== undefined && running) {
        try {
          await stop(ctx, sandbox);
        } catch (f) {
          warn(ctx, f);
        }
        ctx.out.status("interrupted; the local network is stopped and the next run resumes");
      } else ctx.out.status("interrupted; the next run resumes");
      throw Failure.exit(130);
    }
    // As after a Ctrl-C: a pending step leaves only `resume`, which refuses `access stop` and
    // `down`.
    if (sandbox !== undefined && running && sandbox.pending())
      ctx.out.status(
        "the local network's setup did not finish; its containers may still be running until the next run resumes it",
      );
    else if (sandbox !== undefined && running) {
      try {
        await stop(ctx, sandbox);
      } catch (f) {
        warn(ctx, f);
      }
    }
    throw e;
  }
  const sandbox = progress.sandbox!;
  // The container runs HappyView from the bind-mounted project, so a host build into its
  // `.happyview/build` is the one it loads: a module is wasm, the same whatever builds it.
  const watcher = ModuleWatcher.spawn(started.root, started.from);
  let followed: { ok: true; code: number } | { ok: false; error: unknown };
  try {
    followed = {
      ok: true,
      code: await follow(ctx, interrupt, sandbox, started.networkDir, started.account),
    };
  } catch (error) {
    followed = { ok: false, error };
  }
  await watcher?.stop();
  const interrupted = interrupt.seen();
  let stopped: { ok: true } | { ok: false; error: unknown };
  try {
    await stop(ctx, sandbox);
    stopped = { ok: true };
  } catch (error) {
    stopped = { ok: false, error };
  }
  if (interrupted) {
    if (!stopped.ok) throw stopped.error;
    return;
  }
  if (followed.ok) {
    if (!stopped.ok) throw stopped.error;
    finish(followed.code);
    return;
  }
  if (!stopped.ok) warn(ctx, stopped.error);
  throw followed.error;
}

/** check.rs `point_editors_at_types`; M4 ports it there. */
function pointEditorsAtTypes(ctx: Ctx, root: string): void {
  let written: string[];
  try {
    written = writeEditorConfig(root, languages(root));
  } catch (e) {
    throw Failure.runtime(ioErrorText(e));
  }
  for (const line of written) ctx.out.status(line);
}

/**
 * Everything up to a running network with HappyView in it, answering the network's directory,
 * the seeded superadmin, and the project's root and modules. `progress` records the sandbox
 * and whether anything may be running, for the caller to clean up after a throw.
 */
async function start(
  ctx: Ctx,
  args: DevArgs,
  runner: Runner,
  interrupt: Interrupt,
  progress: Progress,
): Promise<Started> {
  await step(ctx, interrupt, "checking for Deno and Docker", () => checkTools(runner, ctx.dir));
  const root = findRoot(ctx.dir);
  if (root === undefined) {
    throw Failure.usage(
      `no ${CONFIG_FILE} in ${ctx.dir} or any directory above it; start one with \`hpy happyview create\``,
    );
  }
  const data = dataRoot();
  const net = networkDir(data, root);
  // Checked before anything downloads or starts: the relay's port is the one resource two
  // sandboxes cannot share.
  const relays = await step(ctx, interrupt, "looking for another local network", () =>
    relayProjects(runner, root),
  );
  const other = relays.find((p) => p !== net.project);
  if (other !== undefined) throw relayHeldBy(other);
  const dockerArch = await step(ctx, interrupt, "asking Docker for its architecture", () =>
    runner.capture("docker", ["info", "--format", "{{.Architecture}}"], root),
  );
  // The container runs Linux whatever this computer runs, so the binary is the Linux release
  // for Docker's architecture, never the host's own.
  const target = linuxTarget(dockerArch);
  const prepared = await abandonable(interrupt, () =>
    prepare(ctx, { locked: args.locked, place: "copy", target }),
  );
  // The project is mounted into HappyView's container, so the types its dev server writes land
  // in the project as they do natively.
  pointEditorsAtTypes(ctx, prepared.root);
  // Before HappyView first boots, which refuses a module with no build. Taken before the
  // build, so a save made while it runs is rebuilt.
  const from = Snapshot.take(prepared.root, readModules(prepared.root));
  if (from.modules().length > 0) {
    // Not a `step`: a build holds no sandbox lock, so Ctrl-C ends the one under way at once
    // rather than waiting out every module left.
    if (interrupt.seen()) throw INTERRUPTED;
    const halt = new AbortController();
    const build = firstBuildUntil(prepared.root, from.modules(), halt.signal);
    build.catch(() => {});
    const raced = await race(interrupt, build);
    if (!raced.done) {
      halt.abort();
      await build;
      throw INTERRUPTED;
    }
  }
  let backfill: boolean;
  try {
    backfill = ProjectToml.load(prepared.root).dev.backfill;
  } catch (e) {
    throw Failure.from(e);
  }
  for (const line of claimNetworkDir(net, prepared.root)) ctx.out.status(line);
  const checkout = await abandonable(interrupt, () =>
    fetchCheckout(httpClient(), PINNED, net, (m) => ctx.out.status(m)),
  );
  await step(ctx, interrupt, "installing Atmosphere in a Box", () =>
    installCheckout(runner, PINNED, checkout),
  );
  const sandbox = new Sandbox(runner, checkout, net.project, net.subnet);
  progress.sandbox = sandbox;
  // Before the first sandbox command, which would only fail on it.
  sandbox.refuseAHeldLock();
  // Read before `--reset` destroys the manifest that records it.
  sandbox.subnet = chooseSubnet(
    args.subnet,
    sandbox.recordedSubnet(),
    net.subnet,
    sandbox.created(),
    args.reset,
  );

  if (args.reset) {
    if (
      !(await ctx.prompter.confirm(
        "Discard the local network's accounts, records and database?",
        args.yes,
      ))
    )
      throw Failure.runtime("cancelled");
    // The sandbox refuses `destroy` while a step is pending, and an interrupted first create
    // has no manifest for `destroy` to find the project in: `resume` settles both, and leaves
    // a created sandbox.
    if (sandbox.pending()) {
      progress.running = true;
      await step(ctx, interrupt, "finishing the interrupted setup", () => sandbox.resume());
    }
    if (sandbox.created())
      await step(ctx, interrupt, "discarding the local network", () => sandbox.destroy());
    const local = rustJoin(prepared.root, LOCAL_DB_DIR);
    if (existsSync(local)) {
      try {
        rmSync(local, { recursive: true });
      } catch (e) {
        throw runtime(e);
      }
    }
  }
  try {
    createDirAll(rustJoin(prepared.root, LOCAL_DB_DIR));
  } catch (e) {
    throw runtime(e);
  }

  // Before `created()`: an interrupted first create can leave pending state with no manifest
  // yet, and only `resume` may finish it.
  if (sandbox.pending()) {
    ctx.out.status("finishing the local network's interrupted setup");
    progress.running = true;
    await step(ctx, interrupt, "finishing the interrupted setup", () => sandbox.resume());
  }
  if (!sandbox.created()) {
    ctx.out.status(`creating the local network (${net.project} on ${sandbox.subnet})`);
    await step(ctx, interrupt, "creating the local network", () => sandbox.create());
  }
  let account = seededSuperadmin(checkout);
  if (account === undefined) {
    // HappyView joins only once the seeded user exists, so its first boot already has its
    // superadmin and it boots once.
    progress.running = true;
    await up(ctx, interrupt, sandbox);
    await step(ctx, interrupt, "creating the sandbox's accounts", () => sandbox.seed());
    account = seededSuperadmin(checkout);
    if (account === undefined) throw Failure.runtime("seed finished without recording user1's DID");
  }
  const [uid, gid] = hostIds();
  const app: AppConfig = {
    projectRoot: prepared.root,
    binary: prepared.binary,
    uid,
    gid,
    superadmin: account.did,
    backfill,
  };
  const written = writeApp(checkout, app);
  const routeChanged = await step(ctx, interrupt, "applying HappyView to the local network", () =>
    sandbox.sync(written),
  );
  progress.running = true;
  await up(ctx, interrupt, sandbox);
  if (routeChanged) {
    const restarted = await step(
      ctx,
      interrupt,
      "restarting the sandbox's DNS, gateway and PDS",
      () => sandbox.restartRouteReaders(),
    );
    if (restarted.length === 0) {
      ctx.out.status(
        "warning: no DNS, gateway or PDS container was running to restart for HappyView's new route; " +
          "sign-in may fail until the local network is restarted",
      );
    }
  }
  if (backfill && !BACKFILL_ON_LOCAL) {
    ctx.out.status(
      "backfill is off on the local network: its relay cannot list repos by collection",
    );
  }
  return { networkDir: net.dir, account, root: prepared.root, from };
}

async function follow(
  ctx: Ctx,
  interrupt: Interrupt,
  sandbox: Sandbox,
  networkDir: string,
  account: SeededAccount,
): Promise<number> {
  await ensureRelayPortFree(sandbox);
  await ensureAccess(ctx, sandbox, networkDir, "/etc/hosts");
  const name = await happyviewContainer(sandbox);
  if (name === undefined) {
    throw Failure.runtime(
      `the HappyView container did not start; see \`deno task sandbox ps\` in ${sandbox.checkout}`,
    );
  }
  ctx.out.status(
    banner(
      account,
      showsPassword(ctx.prompter.isInteractive(), ctx.out.isJson()),
      accountsPath(sandbox.checkout),
      recordPath(networkDir),
    ),
  );
  ctx.out.done("", { url: PUBLIC_URL, handle: account.handle, project: sandbox.project });
  // Under --json the runner sends these to stderr with every other child's output, keeping
  // stdout to the one result document.
  const cancel = new AbortController();
  const logs = sandbox.runner.show(
    "docker",
    ["logs", "--follow", name],
    sandbox.checkout,
    cancel.signal,
  );
  logs.catch(() => {});
  const raced = await race(interrupt, logs);
  if (!raced.done) {
    // `docker logs` is in a process group of its own and never sees the terminal's Ctrl-C;
    // ending it here is what stops it.
    cancel.abort();
    return 0;
  }
  const state = await sandbox.runner.capture(
    "docker",
    ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", name],
    sandbox.checkout,
  );
  return exitFromInspect(state);
}
