// crates/hpy/tests/happyview.rs, the `dev --network local` tests: `hpy hv dev --network local`
// against a fake `deno` (Atmosphere in a Box's CLI) and a fake `docker`, with the fake
// HappyView release served for Docker's architecture.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { FAKE_DENO, FAKE_DOCKER } from "../support/fake-network.ts";
import { hpy } from "../support/hpy.ts";
import { FAKE_HAPPYVIEW, Stack, says, target, VERSION } from "../support/hv-stack.ts";
import { tarXz } from "../support/tar.ts";

const windows = process.platform === "win32";
const ptyHost = process.platform === "darwin" || process.platform === "linux";
const BIN = process.env.HPY_TEST_BIN;
const SCRIPT = fileURLToPath(new URL("../../dist/hpy.mjs", import.meta.url));
/** The command line that runs hpy, as test/support/hpy.ts runs it. */
const HPY: string[] = BIN ? [BIN] : [process.execPath, "--", SCRIPT];
const T = 120_000;

const read = (p: string) => readFileSync(p, "utf8");
const readOr = (p: string) => {
  try {
    return read(p);
  } catch {
    return "";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempdir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "hpy-net-")));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const newStack = async () => {
  const s = await Stack.start();
  cleanups.push(() => s.dispose());
  return s;
};

/** `serve_release`: the fake HappyView release for `target`. */
function serveRelease(stack: Stack, t: string): void {
  const asset = `happyview-${t}.tar.xz`;
  const archive = tarXz([[`happyview-${t}/happyview`, FAKE_HAPPYVIEW, 0o755]]);
  const sum = createHash("sha256").update(archive).digest("hex");
  stack.server.given("GET", `/dl/v${VERSION}/${asset}`, { body: Buffer.from(archive) });
  stack.server.given("GET", `/dl/v${VERSION}/${asset}.sha256`, { body: `${sum}  ${asset}\n` });
}

/** `atmosbox::network_dir` (the directory and the subnet), computed apart from src. */
function networkDirOf(data: string, project: string): [string, string] {
  const canonical = realpathSync(project);
  const digest = createHash("sha256").update(canonical).digest();
  const hash = digest.toString("hex");
  const octet = digest[0] === 249 ? 250 : digest[0]!;
  const mapped = [...basename(canonical).toLowerCase()]
    .map((c) => (/^[a-z0-9]$/.test(c) ? c : "-"))
    .join("")
    .split("-")
    .filter(Boolean)
    .join("-");
  const name = mapped.slice(0, 24).replace(/-+$/, "") || "project";
  return [join(data, "networks", `${name}-${hash.slice(0, 8)}`), `172.30.${octet}.0/24`];
}

/**
 * A loopback port nothing listens on. Rust binds one without listening, which holds it for the
 * test; Node cannot bind without listening, so this answers a port that was free a moment ago.
 */
async function freePort(): Promise<string> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const addr = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return `127.0.0.1:${addr.port}`;
}

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A project ready for `dev --network local` against fakes, as `LocalNet` sets it up. */
class LocalNet {
  readonly stack: Stack;
  readonly bin: string;
  readonly log: string;
  readonly checkout: string;
  readonly project: string;
  readonly subnet: string;
  readonly freeAddr: string;

  private constructor(stack: Stack, bin: string, freeAddr: string) {
    this.stack = stack;
    this.bin = bin;
    this.freeAddr = freeAddr;
    serveRelease(stack, "aarch64-unknown-linux-musl");
    for (const [name, body] of [
      ["deno", FAKE_DENO],
      ["docker", FAKE_DOCKER],
    ] as const) {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    }
    const [net, subnet] = networkDirOf(join(stack.cache, "data"), stack.project);
    this.subnet = subnet;
    this.checkout = join(net, "atmosphereinabox-v0.7.1");
    this.project = `hv-${basename(net)}`;
    mkdirSync(join(this.checkout, "stacks"), { recursive: true });
    writeFileSync(join(this.checkout, "stacks/components.json"), "[]");
    // The pinned archive's sha256, which marks the checkout installed.
    writeFileSync(
      join(this.checkout, ".hpy-installed"),
      "73bd22ac78ba137a2b5e9b8ffb88944232f1d25f0df42cdd5ab70e8d12bb526c",
    );
    const ca = createHash("sha256").update("fake-ca\n").digest("hex");
    writeFileSync(join(net, "access.toml"), `ca_sha256 = "${ca}"\n`);
    this.log = join(bin, "net.log");
  }

  static async start(): Promise<LocalNet> {
    return new LocalNet(await newStack(), tempdir(), await freePort());
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.stack.env(),
      PATH: `${this.bin}:/usr/bin:/bin`,
      NET_LOG: this.log,
      NET_FOLLOWING: this.marker("following"),
      NET_STEP_STARTED: this.marker("step-started"),
      NET_STEP_RELEASE: this.marker("step-release"),
      HPY_NETWORK_ACCESS_ADDR: this.freeAddr,
      ...extra,
    };
  }

  /** A file a fake writes, or waits for, to coordinate with a test. */
  marker(name: string): string {
    return join(this.bin, name);
  }

  hpy(args: string[] = [], extra: Record<string, string> = {}): Promise<Outcome> {
    return this.stack.hpy(["hv", "dev", "--network", "local", ...args], this.env(extra));
  }

  /** The sandbox commands run, in order. */
  sandboxCalls(): string[] {
    return readOr(this.log)
      .split("\n")
      .filter((l) => l.startsWith("deno task sandbox "))
      .map((l) => l.slice("deno task sandbox ".length));
  }

  calls(): string {
    return readOr(this.log);
  }

  clearLog(): void {
    writeFileSync(this.log, "");
  }
}

/** The environment test/support/hpy.ts gives hpy, for a child spawned by hand. */
function hpyEnv(stack: Stack, extra: Record<string, string>): NodeJS.ProcessEnv {
  const home = stack.home;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: home.config,
    APPDATA: home.config,
    XDG_CACHE_HOME: join(home.dir, "cache"),
    XDG_DATA_HOME: join(home.dir, "data"),
    HOME: home.dir,
    HPY_CREDENTIAL_STORE: "file",
    HPY_NO_UPDATE_CHECK: "1",
    ...extra,
  };
  delete env.HPY_CREDENTIAL;
  for (const k of Object.keys(env)) if (k.startsWith("NET_") && !(k in extra)) delete env[k];
  return env;
}

/** Spawns `hpy hv dev --network local` in a process group of its own, as a terminal would. */
function spawnGroup(net: LocalNet, extra: Record<string, string>, stderr?: string): ChildProcess {
  const fd = stderr === undefined ? "ignore" : openSync(stderr, "w");
  const child = spawn(HPY[0]!, [...HPY.slice(1), "hv", "dev", "--network", "local"], {
    cwd: net.stack.project,
    env: hpyEnv(net.stack, net.env(extra)),
    stdio: ["ignore", "ignore", fd],
    detached: true,
  });
  if (typeof fd === "number") closeSync(fd);
  const exited = { done: false };
  child.on("exit", () => {
    exited.done = true;
  });
  cleanups.push(() => {
    if (!exited.done) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
  });
  return child;
}

function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((r) => child.once("exit", (code) => r(code)));
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

async function waitFor(path: string, child: ChildProcess, what: string, net: LocalNet) {
  const deadline = Date.now() + 60_000;
  while (!existsSync(path)) {
    if (!running(child)) throw new Error(`hpy exited before ${what}: ${net.calls()}`);
    if (Date.now() >= deadline) throw new Error(`hpy never reached ${what}: ${net.calls()}`);
    await sleep(20);
  }
}

async function exitWithin(child: ChildProcess, net: LocalNet): Promise<number | null> {
  const code = await Promise.race([exitOf(child), sleep(60_000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    process.kill(-child.pid!, "SIGKILL");
    throw new Error(`hpy did not exit after Ctrl-C: ${net.calls()}`);
  }
  return code;
}

it("reset_needs_the_local_network", async () => {
  const stack = await newStack();
  const r = await stack.hpy(["hv", "dev", "--reset"]);
  expect(r.code).toBe(2);
  expect(says(r.stderr, "--network")).toBe(true);
});

it.skipIf(windows)(
  "local_without_deno_names_what_to_install",
  async () => {
    const stack = await newStack();
    const empty = tempdir();
    const r = await stack.hpy(["hv", "dev", "--network", "local"], { PATH: empty });
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "Deno 2.8")).toBe(true);
  },
  T,
);

it.skipIf(windows)(
  "a_local_run_without_a_terminal_prints_no_password",
  async () => {
    const net = await LocalNet.start();
    const r = await net.hpy();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("seeded-secret-pw");
    expect(r.stderr).toContain(join(net.checkout, "state/accounts.json"));
    expect(r.stderr).toContain("https://happyview.atmosbox.internal");
    // HappyView joins only after the seed, so it first boots knowing its superadmin; the
    // walkthrough then starts the relay, and the end stops everything.
    expect(net.sandboxCalls()).toEqual([
      `create --pds 1 --users-per-pds 1 --project ${net.project} --preset full-stack --subnet ${net.subnet}`,
      "check",
      "up --build --wait-timeout 600",
      "seed",
      "apply --app happyview",
      "check",
      "up --build --wait-timeout 600",
      "access hosts",
      "access start",
      "access stop",
      "down",
    ]);
    const calls = net.calls();
    // Its subnet was checked against Docker's before `create` asked for it.
    expect(calls.indexOf("docker network inspect")).toBeLessThan(
      calls.indexOf("deno task sandbox create"),
    );
    expect(calls.indexOf("docker network inspect")).toBeGreaterThanOrEqual(0);
    // Adding HappyView's route restarts the services that read routes only at start, once the
    // network carrying the route is up.
    const restart = "docker restart hv-test-dns-1 hv-test-gateway-1 hv-test-pds1-1\n";
    expect(calls, calls).toContain(restart);
    expect(calls.indexOf(restart)).toBeGreaterThan(calls.lastIndexOf("deno task sandbox up"));
    expect(calls, "an installed checkout was installed again").not.toContain("deno install");
    const stackFile = read(join(net.checkout, "stacks/happyview.yaml"));
    expect(stackFile).toContain("did:plc:user1");
    // The release for the fake Docker's architecture, which the cache files beside the host's
    // own release, under its target, unless it is the host's.
    expect(statSync(join(net.checkout, "stacks/happyview/happyview")).isFile()).toBe(true);
    const dockerTarget = "aarch64-unknown-linux-musl";
    const releases = join(net.stack.cache, `happyview/${VERSION}`);
    const release = target() === dockerTarget ? releases : join(releases, dockerTarget);
    expect(statSync(join(release, "happyview")).isFile()).toBe(true);
    expect(statSync(join(net.stack.project, ".happyview/local-network")).isDirectory()).toBe(true);
    // The network directory names its project, so it can be found again once it has moved.
    expect(read(join(net.checkout, "..", "project"))).toBe(realpathSync(net.stack.project));

    // A second run finds the sandbox seeded and only brings it up; its route is unchanged, so
    // nothing restarts and no subnet is checked.
    net.clearLog();
    expect((await net.hpy()).code).toBe(0);
    expect(net.calls()).not.toContain("docker restart");
    expect(net.calls()).not.toContain("docker network");
    expect(net.sandboxCalls()).toEqual([
      "check",
      "up --build --wait-timeout 600",
      "access hosts",
      "access start",
      "access stop",
      "down",
    ]);
  },
  T,
);

it.skipIf(windows)(
  "under_json_stdout_holds_only_the_result",
  async () => {
    const net = await LocalNet.start();
    const r = await net.stack.hpy(["--json", "hv", "dev", "--network", "local"], net.env());
    expect(r.code, r.stderr).toBe(0);
    let result: { url: string; handle: string; project: string };
    try {
      result = JSON.parse(r.stdout);
    } catch (e) {
      throw new Error(`stdout is not JSON alone (${e}): ${r.stdout}`);
    }
    expect(result.url).toBe("https://happyview.atmosbox.internal");
    expect(result.handle).toBe("user1.pds1.atmosbox.test");
    expect(r.stdout).not.toContain("seeded-secret-pw");
    expect(r.stderr).toContain("happyview log line");
    // The sandbox's own progress is there too, not on stdout.
    expect(r.stderr).toContain("sandbox progress: task sandbox up");
  },
  T,
);

it.skipIf(windows)(
  "a_second_network_is_refused_while_one_runs",
  async () => {
    // A fake `docker` that reports another sandbox holding the access relay.
    const stack = await newStack();
    const bin = tempdir();
    const write = (name: string, body: string) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`);
      chmodSync(p, 0o755);
    };
    write("deno", "echo 'deno 2.8.3 (stable, release)'");
    write(
      "docker",
      `case "$*" in
  "compose version"*) echo "Docker Compose version v2.40.0" ;;
  "ps --filter label=com.docker.compose.service=host-access"*) echo "hv-other-12345678" ;;
  *) exit 0 ;;
esac`,
    );
    const r = await stack.hpy(["hv", "dev", "--network", "local"], {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "hv-other-12345678") && says(r.stderr, "127.0.0.1:443")).toBe(true);

    // Anything else on the relay's port is refused before the relay starts, and the network
    // that was brought up is stopped again.
    const net = await LocalNet.start();
    const taken = createServer();
    await new Promise<void>((res) => taken.listen(0, "127.0.0.1", res));
    cleanups.push(() => new Promise<void>((res) => taken.close(() => res())));
    const a = taken.address();
    const addr = `127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`;
    const s = await net.hpy([], { HPY_NETWORK_ACCESS_ADDR: addr });
    expect(s.code, s.stderr).toBe(2);
    expect(says(s.stderr, `something else is listening on ${addr}`)).toBe(true);
    const calls = net.sandboxCalls();
    expect(calls).not.toContain("access start");
    expect(calls.slice(-2)).toEqual(["access stop", "down"]);
  },
  T,
);

it.skipIf(windows)(
  "a_failed_up_shows_happyviews_last_log_lines_and_stops_the_network",
  async () => {
    const net = await LocalNet.start();
    const r = await net.hpy([], { NET_UP_FAILS: "1" });
    expect(r.code, r.stderr).toBe(1);
    expect(says(r.stderr, "could not open the database")).toBe(true);
    expect(says(r.stderr, "deno task sandbox up")).toBe(true);
    expect(net.calls()).toContain("docker logs --tail 50 hv-test-happyview-1");
    expect(net.sandboxCalls().slice(-2)).toEqual(["access stop", "down"]);
  },
  T,
);

/** `declare_module`: a Rust module in the project, built by a fake cargo that logs to NET_LOG. */
function declareModule(stack: Stack): [Record<string, string>, string] {
  const root = stack.project;
  writeFileSync(
    join(root, "happyview.toml"),
    `[happyview]\nversion = "${VERSION}"\n[modules.registry]\nlanguage = "rust"\npath = "modules/registry"\n`,
  );
  mkdirSync(join(root, "modules/registry/src"), { recursive: true });
  writeFileSync(
    join(root, "modules/registry/Cargo.toml"),
    `[package]\nname = "registry"\n[profile.release]\npanic = "abort"\n`,
  );
  writeFileSync(join(root, "modules/registry/src/lib.rs"), "");
  const built = join(root, "built.wasm");
  writeFileSync(built, "\0asm-1");
  const cargo = join(root, "cargo");
  writeFileSync(
    cargo,
    `#!/bin/sh\nif [ "$1" = --version ]; then exit 0; fi\n` +
      `if [ -n "$NET_LOG" ]; then echo 'cargo build' >> "$NET_LOG"; fi\n` +
      `manifest=''; while [ $# -gt 0 ]; do [ "$1" = --manifest-path ] && manifest="$2"; shift; done\n` +
      `printf '{"reason":"compiler-artifact","manifest_path":"%s","target":{"crate_types":["cdylib"]},"filenames":["${built}"]}\\n' "$manifest"\n`,
  );
  chmodSync(cargo, 0o755);
  return [
    { HPY_CARGO: cargo, HPY_RUSTUP: "/nonexistent/rustup" },
    join(root, ".happyview/build/registry.wasm"),
  ];
}

/** `edit_and_await_rebuild`. */
async function editAndAwaitRebuild(stack: Stack, dest: string, next: string): Promise<void> {
  writeFileSync(join(stack.project, "built.wasm"), next);
  writeFileSync(join(stack.project, "modules/registry/src/lib.rs"), "// edited\n");
  const deadline = Date.now() + 15_000;
  while (readOr(dest) !== next) {
    if (Date.now() >= deadline) throw new Error("the module was never rebuilt");
    await sleep(50);
  }
}

it.skipIf(windows)(
  "a_local_network_builds_modules_before_happyview_boots_and_rebuilds_them",
  async () => {
    const net = await LocalNet.start();
    const [envs, dest] = declareModule(net.stack);
    const child = spawnGroup(net, { ...envs, NET_BLOCK: "1" });
    await waitFor(net.marker("following"), child, "following the logs", net);
    expect(read(dest)).toBe("\0asm-1");
    const calls = net.calls();
    const built = calls.indexOf("cargo build");
    expect(built, calls).toBeGreaterThanOrEqual(0);
    expect(built, calls).toBeLessThan(calls.indexOf("deno task sandbox up"));

    await editAndAwaitRebuild(net.stack, dest, "\0asm-2");

    process.kill(-child.pid!, "SIGINT");
    expect(await exitWithin(child, net), net.calls()).toBe(0);
    expect(net.sandboxCalls().slice(-2)).toEqual(["access stop", "down"]);
  },
  T,
);

it.skipIf(windows)(
  "ctrl_c_while_following_stops_the_network",
  async () => {
    const net = await LocalNet.start();
    const child = spawnGroup(net, { NET_BLOCK: "1" });
    await waitFor(net.marker("following"), child, "following the logs", net);
    // Its own group, which a terminal's Ctrl-C signals as a whole.
    process.kill(-child.pid!, "SIGINT");
    // `docker logs` never saw the signal and would have followed for two minutes; `hpy` ended
    // it.
    expect(await exitWithin(child, net), net.calls()).toBe(0);
    expect(net.sandboxCalls().slice(-2)).toEqual(["access stop", "down"]);
  },
  T,
);

it.skipIf(windows)(
  "without_a_terminal_a_missing_hosts_entry_stops_before_the_relay",
  async () => {
    let net = await LocalNet.start();
    const line = "127.0.0.1 happyview.hpy-missing-host.atmosbox.test";
    let r = await net.hpy([], { NET_HOSTS: line });
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, line) && says(r.stderr, "/etc/hosts")).toBe(true);
    let calls = net.sandboxCalls();
    expect(calls).toContain("access hosts");
    expect(calls).not.toContain("access start");
    expect(calls.slice(-2)).toEqual(["access stop", "down"]);

    // A CA nobody has confirmed trusting is refused the same way; this case leaves the
    // machine's real /etc/hosts out of it.
    net = await LocalNet.start();
    unlinkSync(join(net.checkout, "..", "access.toml"));
    r = await net.hpy();
    expect(r.code, r.stderr).toBe(2);
    for (const s of [
      "cannot reach the local network yet",
      "state/ca/root.crt",
      // How to ask again once that trust is gone.
      "access.toml",
      "delete that file",
    ])
      expect(says(r.stderr, s), s).toBe(true);
    calls = net.sandboxCalls();
    expect(calls).not.toContain("access start");
    expect(calls.slice(-2)).toEqual(["access stop", "down"]);
  },
  T,
);

it.skipIf(windows)(
  "an_interrupted_first_create_is_resumed_not_created_again",
  async () => {
    const net = await LocalNet.start();
    mkdirSync(join(net.checkout, "state"), { recursive: true });
    writeFileSync(join(net.checkout, "state/pending-create.json"), "{}");
    expect(existsSync(join(net.checkout, "state/manifest.json"))).toBe(false);
    expect((await net.hpy()).code).toBe(0);
    const calls = net.sandboxCalls();
    expect(calls[0]).toBe("resume");
    expect(calls.some((c) => c.startsWith("create"))).toBe(false);
  },
  T,
);

it.skipIf(windows)(
  "reset_destroys_only_a_sandbox_that_exists_or_is_pending",
  async () => {
    const destroyed = (net: LocalNet) =>
      net.sandboxCalls().includes("destroy --accept-destructive");
    // Nothing there yet: nothing to destroy.
    let net = await LocalNet.start();
    expect((await net.hpy(["--reset", "--yes"])).code).toBe(0);
    expect(destroyed(net), String(net.sandboxCalls())).toBe(false);

    // Only pending state, with no manifest.
    net = await LocalNet.start();
    mkdirSync(join(net.checkout, "state"), { recursive: true });
    writeFileSync(join(net.checkout, "state/pending-create.json"), "{}");
    expect((await net.hpy(["--reset", "--yes"])).code).toBe(0);
    // `resume` writes the manifest that `destroy` needs.
    expect(net.sandboxCalls().slice(0, 2)).toEqual(["resume", "destroy --accept-destructive"]);

    // A created sandbox.
    net.clearLog();
    expect((await net.hpy(["--reset", "--yes"])).code).toBe(0);
    expect(net.sandboxCalls()[0]).toBe("destroy --accept-destructive");

    // Created and pending: the sandbox refuses `destroy` until `resume`.
    writeFileSync(join(net.checkout, "state/pending-apply.json"), "{}");
    expect(statSync(join(net.checkout, "state/manifest.json")).isFile()).toBe(true);
    net.clearLog();
    expect((await net.hpy(["--reset", "--yes"])).code).toBe(0);
    expect(net.sandboxCalls().slice(0, 2)).toEqual(["resume", "destroy --accept-destructive"]);
  },
  T,
);

it.skipIf(windows)(
  "a_checkout_installed_from_another_archive_is_installed_again_frozen",
  async () => {
    const net = await LocalNet.start();
    // What an earlier hpy wrote: a version, which a re-tagged archive keeps.
    const marker = join(net.checkout, ".hpy-installed");
    writeFileSync(marker, "v0.7.1");
    // A checkout with `state/` is kept rather than downloaded again, so the test never reaches
    // the real archive; the unit tests in network.test.ts cover the download.
    mkdirSync(join(net.checkout, "state"), { recursive: true });
    expect((await net.hpy()).code).toBe(0);
    const calls = net.calls();
    const install = "deno install --frozen --entrypoint bin/sandbox.ts runtime/accounts.mjs\n";
    expect(calls).toContain(install);
    expect(calls).toContain("deno install saw DENO_NO_PACKAGE_JSON=1");
    expect(calls.indexOf(install)).toBeLessThan(calls.indexOf("deno task sandbox"));
    expect(read(marker)).toBe("73bd22ac78ba137a2b5e9b8ffb88944232f1d25f0df42cdd5ab70e8d12bb526c");
  },
  T,
);

it.skipIf(windows)(
  "a_failure_that_leaves_a_step_pending_stops_nothing",
  async () => {
    const net = await LocalNet.start();
    const r = await net.hpy([], { NET_SEED_FAILS: "1" });
    expect(r.code, r.stderr).toBe(1);
    expect(says(r.stderr, "until the next run resumes it")).toBe(true);
    // The sandbox would refuse both while the step is pending.
    expect(net.sandboxCalls().at(-1)).toBe("seed");
  },
  T,
);

it.skipIf(windows)(
  "a_lock_found_at_start_is_refused_before_any_sandbox_command",
  async () => {
    const net = await LocalNet.start();
    const lock = join(net.checkout, "state/cli.lock");
    mkdirSync(lock, { recursive: true });
    const r = await net.hpy();
    expect(r.code, r.stderr).toBe(2);
    // The report is wrapped to the terminal's width, path and all.
    const flat = [...r.stderr].filter((c) => !/^\s$/.test(c) && c !== "│").join("");
    expect(flat).toContain(lock);
    expect(flat).toContain("inspectthatlock,removeit");
    expect(net.sandboxCalls(), net.calls()).toEqual([]);
    expect(statSync(lock).isDirectory(), "a lock hpy did not take was removed").toBe(true);
  },
  T,
);

it.skipIf(windows)(
  "a_lock_another_command_holds_is_never_removed",
  async () => {
    const net = await LocalNet.start();
    expect((await net.hpy([], { NET_UP_CONTENDED: "1" })).code).toBe(1);
    expect(
      existsSync(join(net.checkout, "state/cli.lock")),
      `the other command's lock was removed: ${net.calls()}`,
    ).toBe(true);
    // Cleanup ran into that lock rather than taking it away.
    expect(net.calls()).toContain("deno refused: locked");
  },
  T,
);

it.skipIf(windows)(
  "a_lock_our_crashed_command_left_is_removed_and_cleanup_runs",
  async () => {
    const net = await LocalNet.start();
    expect((await net.hpy([], { NET_UP_CRASHES: "1" })).code).toBe(1);
    expect(net.sandboxCalls().slice(-2)).toEqual(["access stop", "down"]);
    expect(net.calls(), "cleanup ran into the crashed command's lock").not.toContain(
      "deno refused: locked",
    );
    expect(existsSync(join(net.checkout, "state/cli.lock"))).toBe(false);
  },
  T,
);

/**
 * Runs `dev --network local` with `block` (`NET_SEED_BLOCK` or `NET_UP_BLOCK`) set to `mode`,
 * and sends Ctrl-C to its process group, as a terminal does, once that step is under way. The
 * step is let finish only after `hpy` has had time to act on the signal. Answers the exit code
 * and what `hpy` wrote to stderr.
 */
async function interruptDuring(
  net: LocalNet,
  block: string,
  mode: string,
): Promise<[number | null, string]> {
  const stderr = net.marker("stderr");
  const child = spawnGroup(net, { [block]: mode }, stderr);
  await waitFor(net.marker("step-started"), child, "the step", net);
  process.kill(-child.pid!, "SIGINT");
  // `hpy` waits for the step rather than ending it or itself. The step is released before
  // anything is asserted, so a failure leaves no fake waiting behind it.
  await sleep(500);
  const waited = running(child);
  const callsWhileWaiting = net.calls();
  writeFileSync(net.marker("step-release"), "");
  expect(waited, `hpy did not wait for the step: ${callsWhileWaiting}`).toBe(true);
  expect(callsWhileWaiting).not.toContain("access stop");
  const code = await exitWithin(child, net);
  return [code, readOr(stderr)];
}

it.skipIf(windows)(
  "ctrl_c_during_setup_lets_the_step_finish_then_stops_unless_a_step_is_pending",
  async () => {
    let net = await LocalNet.start();
    let [code, stderr] = await interruptDuring(net, "NET_SEED_BLOCK", "1");
    expect(code, net.calls()).toBe(130);
    expect(stderr).toContain("Ctrl-C: stopping once creating the sandbox's accounts has finished");
    // The seed was not killed: it finished, and only then did `hpy` stop the network,
    // starting nothing new in between.
    let calls = net.calls();
    expect(calls.indexOf("deno seed finished")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("deno seed finished")).toBeLessThan(
      calls.indexOf("deno task sandbox access stop"),
    );
    let sandbox = net.sandboxCalls();
    expect(sandbox.slice(-3)).toEqual(["seed", "access stop", "down"]);

    // A pending step leaves the sandbox for `resume`, which is all it accepts.
    net = await LocalNet.start();
    [code] = await interruptDuring(net, "NET_SEED_BLOCK", "pending");
    expect(code, net.calls()).toBe(130);
    expect(net.calls()).toContain("deno seed finished");
    expect(net.sandboxCalls().at(-1)).toBe("seed");

    // The last step before the logs, on a second run where nothing follows `up`: the run stops
    // there and never reaches the access setup or the logs.
    net = await LocalNet.start();
    expect((await net.hpy()).code).toBe(0);
    net.clearLog();
    [code, stderr] = await interruptDuring(net, "NET_UP_BLOCK", "1");
    expect(code, `${net.calls()}\n${stderr}`).toBe(130);
    sandbox = net.sandboxCalls();
    expect(sandbox.slice(-3)).toEqual(["up --build --wait-timeout 600", "access stop", "down"]);
    calls = net.calls();
    expect(calls).not.toContain("docker logs");
  },
  T,
);

/** `args` under a pseudo-terminal from script(1). */
function scriptCommand(args: string[]): [string, string[]] {
  if (process.platform === "darwin") return ["script", ["-q", "/dev/null", ...args]];
  const line = args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
  return ["script", ["-qec", line, "/dev/null"]];
}

/** Why this host cannot give a child a pseudo-terminal, or `undefined` when it can. */
function noPtyReason(): string | undefined {
  const [cmd, args] = scriptCommand(["sh", "-c", "test -t 0 && test -t 2 && echo hpy-pty-ok"]);
  const out = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (out.error) {
    if ((out.error as NodeJS.ErrnoException).code === "ENOENT") return "script(1) is not installed";
    return `script(1) could not run: ${out.error.message}`;
  }
  if (!String(out.stdout).includes("hpy-pty-ok"))
    return `script(1) could not open a pseudo-terminal: ${String(out.stderr).trim()}`;
  return undefined;
}

/**
 * `dev --network local` under a pseudo-terminal, answering everything the terminal showed;
 * `undefined` when this host has no pseudo-terminal to give, which `HPY_REQUIRE_PTY_TEST=1`
 * (set in CI) turns into a failure.
 */
async function runOnATerminal(net: LocalNet, extra: string[]): Promise<string | undefined> {
  const why = noPtyReason();
  if (why !== undefined) {
    expect(process.env.HPY_REQUIRE_PTY_TEST, `HPY_REQUIRE_PTY_TEST=1 but ${why}`).not.toBe("1");
    console.error(`skipped: ${why}`);
    return undefined;
  }
  const [cmd, args] = scriptCommand([...HPY, "hv", "dev", "--network", "local", ...extra]);
  // Not spawnSync: the mock release server runs on this process's event loop.
  const child = spawn(cmd, args, {
    cwd: net.stack.project,
    env: hpyEnv(net.stack, net.env()),
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  await exitOf(child);
  return out;
}

it.skipIf(!ptyHost)(
  "a_terminal_shows_the_password_but_never_under_json",
  async () => {
    const net = await LocalNet.start();
    // Without --json the terminal gets it, which shows the pty is real.
    const shown = await runOnATerminal(net, []);
    if (shown === undefined) return;
    expect(shown).toContain("seeded-secret-pw");
    const json = await runOnATerminal(net, ["--json"]);
    if (json === undefined) return;
    expect(json).toContain('"url"');
    expect(json).not.toContain("seeded-secret-pw");
  },
  T,
);

it("a_subnet_is_refused_off_the_local_network_and_when_it_is_not_one", async () => {
  const stack = await newStack();
  const dir = tempdir();
  const dev = (args: string[]) =>
    hpy(stack.home, ["hv", "dev", ...args], { cwd: dir, env: stack.env() });
  let r = await dev(["--subnet", "10.40.0.0/24"]);
  expect(r.code).toBe(2);
  expect(says(r.stderr, "--subnet applies only to --network local")).toBe(true);
  r = await dev(["--network", "local", "--subnet", "10.40.0.1/24"]);
  expect(r.code).toBe(2);
  expect(says(r.stderr, "did you mean 10.40.0.0/24?")).toBe(true);
});

it.skipIf(windows)(
  "a_chosen_subnet_is_kept_until_reset_moves_it",
  async () => {
    const net = await LocalNet.start();
    const createdOn = (subnet: string) =>
      `create --pds 1 --users-per-pds 1 --project ${net.project} --preset full-stack --subnet ${subnet}`;
    let r = await net.hpy(["--subnet", "10.40.0.0/24"]);
    expect(r.code, r.stderr).toBe(0);
    expect(says(r.stderr, "on 10.40.0.0/24")).toBe(true);
    expect(net.sandboxCalls()[0]).toBe(createdOn("10.40.0.0/24"));

    // A created network cannot move, so asking it to is refused before any sandbox command.
    net.clearLog();
    r = await net.hpy(["--subnet", "10.41.0.0/24"]);
    expect(r.code).toBe(2);
    expect(says(r.stderr, "created on 10.40.0.0/24") && says(r.stderr, "--reset")).toBe(true);
    expect(net.sandboxCalls()).toEqual([]);

    // `--reset` alone recreates it where it was, not on the derived one.
    net.clearLog();
    expect((await net.hpy(["--reset", "--yes"])).code).toBe(0);
    expect(net.sandboxCalls()).toContain(createdOn("10.40.0.0/24"));
    expect(net.subnet).not.toBe("10.40.0.0/24");

    // `--reset` with `--subnet` moves it.
    net.clearLog();
    expect((await net.hpy(["--reset", "--yes", "--subnet", "10.41.0.0/24"])).code).toBe(0);
    expect(net.sandboxCalls()).toContain(createdOn("10.41.0.0/24"));
  },
  T,
);
