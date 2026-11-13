// crates/hpy/src/project/network/{runner,sandbox,atmosbox,app,access,accounts}.rs and
// crates/hpy/src/commands/happyview/network.rs tests. `FakeRunner` is in
// test/support/fake-runner.ts; wiremock is test/support/mock-server.ts.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  banner,
  claimNetworkDir,
  exitFromInspect,
  linuxTarget,
  showsPassword,
} from "../../src/commands/network.ts";
import { gzip } from "../../src/core/deflate.ts";
import { Failure } from "../../src/core/failure.ts";
import { Version } from "../../src/core/semver.ts";
import { Header, TarBuilder } from "../../src/core/tar.ts";
import { httpClient } from "../../src/project/binary.ts";
import {
  AccessRecord,
  assess,
  missingHosts,
  parseHostsBlock,
  recordPath,
  walkthroughText,
} from "../../src/project/network/access.ts";
import {
  SeededAccount,
  SUPERADMIN_HANDLE,
  seededSuperadmin,
} from "../../src/project/network/accounts.ts";
import {
  APP_ID,
  type AppConfig,
  BACKFILL_ENV,
  BACKFILL_ON_LOCAL,
  DEFINITION_FILE,
  definitionJson,
  LOCAL_DB_DIR,
  NETWORK_ENV,
  PUBLIC_URL,
  ROUTE_HOSTNAME,
  ROUTE_ID,
  registerComponent,
  STACK_FILE,
  SUPERADMIN_ENV,
  stackJson,
  WATCH_POLL_ENV,
  WATCH_POLL_MS,
  Written,
  writeApp,
} from "../../src/project/network/app.ts";
import {
  checkTools,
  fetchCheckout,
  INSTALLED,
  installCheckout,
  type NetworkDir,
  networkDir,
  PINNED,
  type Pinned,
  parseDenoVersion,
  subnetFor,
  VERSION,
} from "../../src/project/network/atmosbox.ts";
import { Exit, mustWithEnv, SystemRunner } from "../../src/project/network/runner.ts";
import { chooseSubnet, overlappingNetwork, Sandbox } from "../../src/project/network/sandbox.ts";
import TEMPLATES from "../../src/project/network/templates.json" with { type: "json" };
import { FakeRunner } from "../support/fake-runner.ts";
import { MockServer } from "../support/mock-server.ts";

/** The Rust tests gated `#[cfg(unix)]`. */
const windows = process.platform === "win32";
const dirs: string[] = [];
const tempdir = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "hpy-network-")));
  dirs.push(d);
  return d;
};
const servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function failure(p: Promise<unknown> | (() => unknown)): Promise<Failure> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(Failure);
    return e as Failure;
  }
  throw new Error("expected a failure");
}

it("the templates are crates/hpy/templates/network's", () => {
  for (const name of ["Dockerfile", "entrypoint.sh"] as const) {
    const src = new URL(`../../src/project/network/templates/${name}`, import.meta.url);
    expect(TEMPLATES[name]).toBe(readFileSync(src, "utf8"));
  }
});

describe("runner.rs", () => {
  it.skipIf(windows)("capture_answers_stdout_and_failures_carry_stderr", async () => {
    const dir = tempdir();
    expect(await new SystemRunner().capture("sh", ["-c", "echo hi"], dir)).toBe("hi\n");
    const err = await failure(
      new SystemRunner().capture("sh", ["-c", "echo nope >&2; exit 4"], dir),
    );
    expect(err.message).toContain("nope");
  });

  it.skipIf(windows)("a_missing_program_is_named", async () => {
    const dir = tempdir();
    const err = await failure(new SystemRunner().capture("no-such-tool-hpy", [], dir));
    expect(err.message).toContain("`no-such-tool-hpy` is not installed");
    expect(err.code).toBe(2);
  });

  it.skipIf(windows)("must_turns_a_non_zero_show_into_a_failure", async () => {
    const dir = tempdir();
    const err = await failure(mustWithEnv(new SystemRunner(), "sh", ["-c", "exit 5"], [], dir));
    expect(err.message).toContain("`sh -c exit 5` exited with 5");
  });

  /** A shell that succeeds only as the leader of its own process group, with nothing to read. */
  const DETACHED = `[ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ] && ! read -r line`;

  it.skipIf(windows)("every_child_leads_its_own_group_and_reads_nothing", async () => {
    const dir = tempdir();
    const script = `${DETACHED} && [ "$HPY_RUNNER_TEST" = set ]`;
    const code = await new SystemRunner().showWithEnv(
      "sh",
      ["-c", script],
      [["HPY_RUNNER_TEST", "set"]],
      dir,
    );
    expect(code, "a shown child shares hpy's group or its stdin").toEqual(Exit.code(0));
    await new SystemRunner().capture("sh", ["-c", DETACHED], dir);
  });

  it.skipIf(windows)("a_signal_death_is_reported_apart_from_an_exit_code", async () => {
    const dir = tempdir();
    const run = (script: string) => new SystemRunner().show("sh", ["-c", script], dir);
    const SIGTERM = constants.signals.SIGTERM;
    expect(await run("kill -TERM $$")).toEqual({ code: 128 + SIGTERM, signal: SIGTERM });
    // The same number from an ordinary exit is not a signal.
    expect(await run("exit 143")).toEqual(Exit.code(143));
    const exit = await run("kill -TERM $$");
    const err = await failure(() => Exit.check(exit, "sh", ["-c"]));
    expect(err.message).toContain("signal 15");
  });
});

describe("sandbox.rs", () => {
  const sandbox = (runner: FakeRunner, dir: string) =>
    new Sandbox(runner, dir, "hv-app-1234abcd", "172.30.17.0/24");

  const writeManifest = (dir: string, body: string) => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state/manifest.json"), body);
  };

  it("a_new_sandbox_is_created_with_the_full_stack_and_happyview_applied_later", async () => {
    const dir = tempdir();
    const runner = new FakeRunner();
    const s = sandbox(runner, dir);
    expect(s.created()).toBe(false);
    await s.create();
    expect(runner.calls).toEqual([
      "docker network ls --format {{.Name}}",
      "deno task sandbox create --pds 1 --users-per-pds 1 --project hv-app-1234abcd --preset full-stack --subnet 172.30.17.0/24",
    ]);
    writeManifest(dir, `{"applications":[]}`);
    runner.calls.length = 0;
    const unchanged = Written.default();
    const files: Written = { any: true, definition: false };
    const route: Written = { any: true, definition: true };
    // A first apply always adds the route.
    expect(await s.sync(unchanged)).toBe(true);
    expect(runner.calls).toEqual(["deno task sandbox apply --app happyview"]);
    // The fake runs nothing, so stand in for what the real `apply` records.
    writeManifest(dir, `{"applications":["happyview"]}`);
    runner.calls.length = 0;
    expect(await s.sync(unchanged)).toBe(false);
    expect(runner.calls).toEqual([]);
    expect(await s.sync(files)).toBe(false);
    expect(await s.sync(route)).toBe(true);
    expect(runner.calls).toEqual([
      "deno task sandbox apply --component happyview",
      "deno task sandbox apply --component happyview",
    ]);
  });

  it("an_existing_sandbox_without_happyview_gets_it_applied", async () => {
    const dir = tempdir();
    writeManifest(dir, `{"applications":[]}`);
    const runner = new FakeRunner();
    const s = sandbox(runner, dir);
    expect(s.created()).toBe(true);
    expect(s.applied()).toBe(false);
    expect(await s.sync(Written.default())).toBe(true);
    expect(runner.calls).toEqual(["deno task sandbox apply --app happyview"]);
  });

  it("a_manifest_without_applications_reads_as_not_applied", () => {
    const dir = tempdir();
    writeManifest(dir, "{}");
    expect(sandbox(new FakeRunner(), dir).applied()).toBe(false);
  });

  it("an_interrupted_create_or_apply_is_pending_and_resumes", async () => {
    const dir = tempdir();
    const runner = new FakeRunner();
    const s = sandbox(runner, dir);
    expect(s.pending()).toBe(false);
    for (const file of ["pending-create.json", "pending-apply.json"]) {
      mkdirSync(join(dir, "state"), { recursive: true });
      writeFileSync(join(dir, "state", file), "{}");
      expect(s.pending(), file).toBe(true);
      unlinkSync(join(dir, "state", file));
      expect(s.pending()).toBe(false);
    }
    await s.resume();
    expect(runner.calls).toEqual(["deno task sandbox resume"]);
  });

  it("up_checks_first_and_waits_long_enough_for_a_cold_start", async () => {
    const dir = tempdir();
    const runner = new FakeRunner();
    await sandbox(runner, dir).up();
    expect(runner.calls).toEqual([
      "deno task sandbox check",
      "deno task sandbox up --build --wait-timeout 600",
    ]);
  });

  it("a_failed_step_names_the_command", async () => {
    const dir = tempdir();
    const runner = FakeRunner.answering([["deno task sandbox check", { err: "bad" }]]);
    const err = await failure(sandbox(runner, dir).up());
    expect(err.message).toContain("deno task sandbox check");
    expect(runner.calls.length).toBe(1);
  });

  it("subnets_overlap_by_range_not_by_text", () => {
    const inspect =
      "bridge 172.17.0.0/16 \nhv-other_atmosinabox 172.30.17.0/24 fd00::/64 \nhost \nwide 172.16.0.0/12 \n";
    expect(overlappingNetwork(inspect, "172.30.17.0/24")).toEqual([
      "hv-other_atmosinabox",
      "172.30.17.0/24",
    ]);
    // A /12 holding the /24 is as much in the way as the same /24.
    expect(overlappingNetwork("wide 172.16.0.0/12\n", "172.30.18.0/24")).toEqual([
      "wide",
      "172.16.0.0/12",
    ]);
    expect(
      overlappingNetwork("bridge 172.17.0.0/16\nv6 fd00::/64\n", "172.30.18.0/24"),
    ).toBeUndefined();
  });

  it("a_subnet_once_chosen_is_kept_until_another_is_asked_for", () => {
    const derived = "172.30.17.0/24";
    // A new project takes the derived network, or the one asked for.
    expect(chooseSubnet(undefined, undefined, derived, false, false)).toBe(derived);
    expect(chooseSubnet("10.40.0.0/24", undefined, derived, false, false)).toBe("10.40.0.0/24");
    // `--reset` without `--subnet` recreates it where it was.
    expect(chooseSubnet(undefined, "10.40.0.0/24", derived, true, true)).toBe("10.40.0.0/24");
    // `--reset` with `--subnet` moves it.
    expect(chooseSubnet("10.41.0.0/24", "10.40.0.0/24", derived, true, true)).toBe("10.41.0.0/24");
    // Naming the network it already has is not a move.
    expect(() => chooseSubnet("10.40.0.0/24", "10.40.0.0/24", derived, true, false)).not.toThrow();
  });

  it("a_created_network_asked_to_move_without_reset_is_refused", async () => {
    const err = await failure(() =>
      chooseSubnet("10.41.0.0/24", "10.40.0.0/24", "172.30.17.0/24", true, false),
    );
    expect(err.message).toContain("created on 10.40.0.0/24");
    expect(err.message).toContain("--reset");
    expect(err.code).toBe(2);
  });

  it("the_recorded_subnet_is_the_manifests", () => {
    const dir = tempdir();
    const s = sandbox(new FakeRunner(), dir);
    expect(s.recordedSubnet()).toBeUndefined();
    writeManifest(dir, `{"applications":[],"subnet":"10.40.0.0/24"}`);
    expect(s.recordedSubnet()).toBe("10.40.0.0/24");
  });

  it("create_refuses_a_subnet_another_network_holds_and_names_it", async () => {
    const dir = tempdir();
    const runner = FakeRunner.answering([
      ["docker network ls", { ok: "bridge\nhv-app-1234abcd_atmosinabox\nsomeone-else\n" }],
      ["docker network inspect", { ok: "bridge 172.17.0.0/16 \nsomeone-else 172.30.0.0/16 \n" }],
    ]);
    const err = await failure(sandbox(runner, dir).create());
    expect(err.message).toContain("`someone-else`");
    expect(err.message).toContain("172.30.0.0/16");
    expect(err.message).toContain("--subnet <CIDR>");
    expect(err.code).toBe(2);
    // This sandbox's own network is never counted against it, and nothing is created.
    expect(runner.calls[1]!.endsWith("bridge someone-else"), String(runner.calls)).toBe(true);
    expect(runner.calls.some((c) => c.includes("sandbox create"))).toBe(false);
  });

  it("a_stopped_relay_is_removed_before_access_starts", async () => {
    const dir = tempdir();
    const runner = FakeRunner.answering([
      [
        "docker ps -a --filter label=com.docker.compose.project=hv-app-1234abcd --filter label=com.docker.compose.service=host-access",
        { ok: "hv-app-1234abcd-host-access-1 host-access exited\nodd-1 dns exited\n" },
      ],
    ]);
    await sandbox(runner, dir).accessStart();
    const rm = runner.calls.indexOf("docker rm hv-app-1234abcd-host-access-1");
    const start = runner.calls.findIndex((c) => c.endsWith("access start"));
    expect(rm, String(runner.calls)).toBeGreaterThanOrEqual(0);
    expect(start, String(runner.calls)).toBeGreaterThan(rm);
  });

  it("a_running_relay_is_not_removed", async () => {
    const dir = tempdir();
    const runner = FakeRunner.answering([
      ["docker ps -a", { ok: "hv-app-1234abcd-host-access-1 host-access running\n" }],
    ]);
    await sandbox(runner, dir).accessStart();
    expect(runner.calls.some((c) => c.startsWith("docker rm"))).toBe(false);
  });

  it("only_the_route_readers_are_restarted", async () => {
    const dir = tempdir();
    const runner = FakeRunner.answering([
      [
        "docker ps --filter label=com.docker.compose.project=hv-app-1234abcd",
        {
          ok: "hv-app-dns-1 dns\nhv-app-gateway-1 gateway\nhv-app-pds1-1 pds1\nhv-app-plc-1 plc\nhv-app-happyview-1 happyview\nhv-app-pds-space2-1 pds-space2\nodd pdsx\n",
        },
      ],
    ]);
    const restarted = await sandbox(runner, dir).restartRouteReaders();
    expect(restarted).toEqual([
      "hv-app-dns-1",
      "hv-app-gateway-1",
      "hv-app-pds1-1",
      "hv-app-pds-space2-1",
    ]);
    expect(runner.calls.at(-1)).toBe(
      "docker restart hv-app-dns-1 hv-app-gateway-1 hv-app-pds1-1 hv-app-pds-space2-1",
    );
  });

  it("a_lock_found_at_start_is_refused_with_its_path", async () => {
    const dir = tempdir();
    const s = sandbox(new FakeRunner(), dir);
    s.refuseAHeldLock();
    mkdirSync(s.lock(), { recursive: true });
    const err = await failure(() => s.refuseAHeldLock());
    expect(err.message).toContain(s.lock());
    expect(err.message).toContain(dir);
    expect(err.code).toBe(2);
  });

  /** Runs `script` in the sandbox checkout as a real child, standing in for a sandbox command. */
  const underTheLockRule = (s: Sandbox, script: string) =>
    s.releasingADroppedLock(() => new SystemRunner().show("sh", ["-c", script], s.checkout));

  it.skipIf(windows)("only_a_lock_our_signalled_command_left_is_removed", async () => {
    const dir = tempdir();
    mkdirSync(join(dir, "state"));
    const s = sandbox(new FakeRunner(), dir);

    // Another command took the lock after the check, and ours refused with an ordinary exit,
    // as the CLI's "CLI locked" does.
    let exit = await underTheLockRule(s, "mkdir state/cli.lock; exit 1");
    expect(exit).toEqual(Exit.code(1));
    expect(existsSync(s.lock()), "another command's lock was removed").toBe(true);
    rmdirSync(s.lock());

    // Ours took the lock and a signal ended it before it let go.
    exit = await underTheLockRule(s, "mkdir state/cli.lock; kill -TERM $$");
    expect(exit.signal).toBe(constants.signals.SIGTERM);
    expect(existsSync(s.lock()), "our own stale lock was kept").toBe(false);

    // A lock that was there before the command is never touched.
    mkdirSync(s.lock());
    await underTheLockRule(s, "kill -TERM $$");
    expect(existsSync(s.lock()), "a lock from before the command was removed").toBe(true);
  });
});

describe("atmosbox.rs", () => {
  const FROZEN_INSTALL =
    "DENO_NO_PACKAGE_JSON=1 deno install --frozen --entrypoint bin/sandbox.ts runtime/accounts.mjs";

  it("deno_versions_parse", () => {
    expect(
      parseDenoVersion("deno 2.8.3 (stable, release, aarch64-apple-darwin)\nv8 14.0\n")?.toString(),
    ).toBe(Version.parse("2.8.3").toString());
    expect(parseDenoVersion("something else")).toBeUndefined();
  });

  it("an_old_deno_or_no_compose_is_a_usage_error", async () => {
    const dir = tempdir();
    const old = FakeRunner.answering([["deno --version", { ok: "deno 2.7.9 (stable)\n" }]]);
    let err = await failure(checkTools(old, dir));
    expect(err.message).toContain("Deno 2.8");
    const noCompose = FakeRunner.answering([
      ["deno --version", { ok: "deno 2.8.3 (stable)\n" }],
      ["docker compose version", { err: "unknown command" }],
    ]);
    err = await failure(checkTools(noCompose, dir));
    expect(err.message).toContain("Docker Compose");
  });

  it("the_network_dir_is_stable_for_one_project", () => {
    const data = tempdir();
    const project = tempdir();
    const app = join(project, "My_Cool.App");
    mkdirSync(app);
    const a = networkDir(data, app);
    const b = networkDir(data, `${app}/.`);
    expect(a.dir).toBe(b.dir);
    expect(a.project.startsWith("hv-my-cool-app-"), a.project).toBe(true);
    expect(/^[a-z0-9-]*$/.test(a.project)).toBe(true);
    expect(a.dir.startsWith(join(data, "networks"))).toBe(true);
    expect(a.subnet).toBe(b.subnet);
  });

  it("each_project_gets_its_own_subnet_and_never_the_default", () => {
    const data = tempdir();
    const project = tempdir();
    const subnets = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const app = join(project, `app-${i}`);
      mkdirSync(app);
      subnets.add(networkDir(data, app).subnet);
    }
    // Derived from a hash: 64 projects land on well over one /24.
    expect(subnets.size).toBeGreaterThan(32);
    for (const subnet of subnets)
      expect(subnet.startsWith("172.30.") && subnet.endsWith(".0/24")).toBe(true);
    expect(subnetFor(new Uint8Array([249]))).toBe("172.30.250.0/24");
    expect(subnetFor(new Uint8Array([7]))).toBe("172.30.7.0/24");
  });

  it("truncating_a_long_name_leaves_no_dangling_separator", () => {
    const data = tempdir();
    const project = tempdir();
    // The 24th character is a separator.
    const app = join(project, `${"a".repeat(23)}-tail`);
    mkdirSync(app);
    const net = networkDir(data, app);
    expect(net.project.startsWith(`hv-${"a".repeat(23)}-`)).toBe(true);
    expect(net.project.includes("--"), net.project).toBe(false);
  });

  /**
   * A `.tar.gz` holding `<top>/deno.json`. Rust's test writes a GNU header; src/core/tar.ts
   * ports only ustar paths, which the reader takes the same way.
   */
  function archive(top: string): Uint8Array {
    const chunks: Uint8Array[] = [];
    const builder = new TarBuilder((c) => chunks.push(c));
    const body = Buffer.from(`{"tasks":{}}`);
    const header = Header.ustar();
    header.setSize(body.length);
    header.setMode(0o644);
    header.setCksum();
    builder.appendData(header, `${top}/deno.json`, body);
    builder.finish();
    return gzip(Buffer.concat(chunks));
  }

  async function server(): Promise<MockServer> {
    const s = await MockServer.start();
    servers.push(s);
    return s;
  }

  it("installs_once_and_refuses_a_wrong_archive", async () => {
    const s = await server();
    const bytes = archive("atmosphereinabox-v0.7.1");
    s.given("GET", "/archive/v0.7.1", { body: Buffer.from(bytes) });
    const sum = createHash("sha256").update(bytes).digest("hex");
    const url = `${s.url}/archive/v0.7.1`;
    const data = tempdir();
    const net: NetworkDir = {
      dir: join(data, "networks/x"),
      project: "hv-x",
      subnet: "172.30.1.0/24",
    };
    const runner = new FakeRunner();
    const good: Pinned = { url, sha256: sum, top: "atmosphereinabox-v0.7.1" };
    const http = httpClient();
    const checkout = await fetchCheckout(http, good, net, () => {});
    expect(statSync(join(checkout, "deno.json")).isFile()).toBe(true);
    expect(runner.calls, "fetching runs nothing").toEqual([]);
    await installCheckout(runner, good, checkout);
    expect(runner.calls).toEqual([FROZEN_INSTALL]);
    expect(readFileSync(join(checkout, INSTALLED), "utf8")).toBe(sum);
    await fetchCheckout(http, good, net, () => {});
    await installCheckout(runner, good, checkout);
    expect(runner.calls.length, "a second run reinstalled").toBe(1);

    // A marker from another archive (or the version-only marker an earlier hpy wrote) is not
    // this archive's install.
    writeFileSync(join(checkout, INSTALLED), VERSION);
    await installCheckout(runner, good, checkout);
    expect(runner.calls.length, "a stale marker was trusted").toBe(2);

    const other: NetworkDir = {
      dir: join(data, "networks/y"),
      project: "hv-y",
      subnet: "172.30.2.0/24",
    };
    const bad: Pinned = { url, sha256: "0".repeat(64), top: "atmosphereinabox-v0.7.1" };
    const err = await failure(fetchCheckout(http, bad, other, () => {}));
    expect(err.message).toContain("does not match the pinned");
    expect(existsSync(join(other.dir, "atmosphereinabox-v0.7.1"))).toBe(false);
  });

  it("an_interrupted_install_never_touches_state", async () => {
    const s = await server();
    const data = tempdir();
    const net: NetworkDir = {
      dir: join(data, "networks/x"),
      project: "hv-x",
      subnet: "172.30.1.0/24",
    };
    const checkout = join(net.dir, "atmosphereinabox-v0.7.1");
    mkdirSync(join(checkout, "state"), { recursive: true });
    writeFileSync(join(checkout, "state/accounts.json"), "{}");
    const runner = new FakeRunner();
    const pinned: Pinned = {
      url: `${s.url}/never`,
      sha256: "0".repeat(64),
      top: "atmosphereinabox-v0.7.1",
    };
    const fetched = await fetchCheckout(httpClient(), pinned, net, () => {});
    await installCheckout(runner, pinned, fetched);
    expect(readFileSync(join(checkout, "state/accounts.json"), "utf8")).toBe("{}");
    expect(runner.calls).toEqual([FROZEN_INSTALL]);
  });

  it("the pinned archive is v0.7.1's", () => {
    expect(PINNED.top).toBe(`atmosphereinabox-${VERSION}`);
    expect(PINNED.url.endsWith(`/archive/${VERSION}`)).toBe(true);
  });
});

describe("app.rs", () => {
  const config = (superadmin?: string): AppConfig => ({
    projectRoot: "/work/my-app",
    binary: "/cache/happyview/3.0.0/x86_64-unknown-linux-musl/happyview",
    uid: 501,
    gid: 20,
    superadmin,
    backfill: true,
  });

  const checkoutWith = (binary: string): [string, AppConfig] => {
    const dir = tempdir();
    mkdirSync(join(dir, "stacks"));
    writeFileSync(join(dir, "stacks/components.json"), "[]");
    const bin = join(dir, "hv-binary");
    writeFileSync(bin, binary);
    return [dir, { ...config(), binary: bin }];
  };

  // biome-ignore lint/suspicious/noExplicitAny: the stack is untyped JSON.
  const service = (c: AppConfig): any => (stackJson(c).services as any)[APP_ID];

  it("the_stack_mounts_the_project_and_points_at_sandbox_services", () => {
    const svc = service(config("did:plc:user1"));
    expect(svc.command).toEqual(["dev", "."]);
    expect(svc.working_dir).toBe("/project");
    expect(svc.volumes).toEqual([{ type: "bind", source: "/work/my-app", target: "/project" }]);
    const env = svc.environment;
    expect(env.JETSTREAM_URL).toBe("ws://full-stack-jetstream:8080");
    expect(env.RELAY_URL).toBe("http://full-stack-relay:2470");
    expect(env[SUPERADMIN_ENV]).toBe("did:plc:user1");
    expect(env[NETWORK_ENV]).toBe("local");
    expect(env.HV_UID).toBe("501");
    expect(svc.ports, "a managed app must not publish ports").toBeUndefined();
  });

  it("the_local_database_is_separate", () => {
    const env = service(config()).environment;
    expect(env.DATABASE_URL).toBe(`sqlite:///project/${LOCAL_DB_DIR}/happyview.db?mode=rwc`);
    expect(LOCAL_DB_DIR).not.toBe(".happyview");
    expect(env[SUPERADMIN_ENV]).toBeUndefined();
    expect(env[WATCH_POLL_ENV] !== undefined).toBe(WATCH_POLL_MS !== undefined);
    expect(env[WATCH_POLL_ENV]).toBe("500");
  });

  it("backfill_follows_the_recorded_decision", () => {
    const env = service(config()).environment;
    expect(env[BACKFILL_ENV]).toBe(BACKFILL_ON_LOCAL ? "true" : "false");
  });

  it("the_definition_routes_happyview_and_supplies_its_urls", () => {
    // biome-ignore lint/suspicious/noExplicitAny: the definition is untyped JSON.
    const d = definitionJson() as any;
    expect(d.id).toBe(APP_ID);
    expect(d.routes[0]).toEqual({
      id: "happyview",
      service: APP_ID,
      hostname: "happyview.atmosbox.internal",
      port: 3000,
    });
    expect(d.routes[0].host).toBeUndefined();
    expect(PUBLIC_URL).toBe(`https://${ROUTE_HOSTNAME}`);
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    const env: any[] = d.services[0].environment;
    expect(
      env.some(
        (e) =>
          e.name === "PUBLIC_URL" && e.source.kind === "route-url" && e.source.route === ROUTE_ID,
      ),
    ).toBe(true);
    expect(env.some((e) => e.name === "PLC_URL" && e.source.kind === "plc-url")).toBe(true);
  });

  it("registering_is_idempotent_and_keeps_the_rest", () => {
    const base = `[{ "id": "networking", "file": "compose/networking.yaml" }]`;
    const once = registerComponent(base)!;
    const parsed = JSON.parse(once);
    expect(parsed[0].id).toBe("networking");
    expect(parsed[1].definition).toBe("stacks/happyview.definition.json");
    expect(registerComponent(once)).toBeUndefined();
  });

  it("write_app_reports_changes_only_when_something_changed", () => {
    const [checkout, c] = checkoutWith("binary");
    expect(writeApp(checkout, c)).toEqual({ any: true, definition: true });
    expect(writeApp(checkout, c)).toEqual(Written.default());
    c.superadmin = "did:plc:user1";
    // The stack changed; the route did not.
    expect(writeApp(checkout, c)).toEqual({ any: true, definition: false });
    writeFileSync(join(checkout, DEFINITION_FILE), "{}");
    expect(writeApp(checkout, c).definition).toBe(true);
    expect(statSync(join(checkout, "stacks/happyview/Dockerfile")).isFile()).toBe(true);
    expect(statSync(join(checkout, "stacks/happyview/entrypoint.sh")).isFile()).toBe(true);
  });

  it("a_new_binary_changes_the_build_context_not_the_volumes", () => {
    const [checkout, c] = checkoutWith("one");
    writeApp(checkout, c);
    const stackPath = join(checkout, STACK_FILE);
    const before = readFileSync(stackPath, "utf8");
    const copied = join(checkout, "stacks/happyview/happyview");
    expect(readFileSync(copied, "utf8")).toBe("one");

    // Same size, different content: the hash must catch it.
    writeFileSync(c.binary, "two");
    expect(writeApp(checkout, c).any).toBe(true);
    expect(readFileSync(copied, "utf8")).toBe("two");
    expect(readFileSync(stackPath, "utf8")).toBe(before);
    expect(writeApp(checkout, c).any).toBe(false);
  });

  it("the stack and definition are written as serde_json pretty-prints them", () => {
    const [checkout, c] = checkoutWith("bin");
    writeApp(checkout, c);
    const def = readFileSync(join(checkout, DEFINITION_FILE), "utf8");
    expect(def.startsWith('{\n  "id": "happyview",\n  "routes": [\n')).toBe(true);
    expect(def.endsWith("}\n")).toBe(true);
    expect(readFileSync(join(checkout, "stacks/components.json"), "utf8")).toBe(
      '[\n  {\n    "application": "happyview",\n    "definition": "stacks/happyview.definition.json",\n    "file": "stacks/happyview.yaml",\n    "id": "happyview"\n  }\n]\n',
    );
  });

  it("an unreadable components.json says so", async () => {
    const err = await failure(() => registerComponent("{"));
    expect(err.message).toMatch(
      /^stacks\/components\.json is not readable: invalid type: map, expected a sequence at line 1 column \d+$/,
    );
  });
});

describe("access.rs", () => {
  const BLOCK =
    "# sandbox hv-app host access: begin\n127.0.0.1 happyview.atmosbox.internal\n127.0.0.1 pds1.atmosbox.test\n# sandbox hv-app host access: end\n";

  it("the_block_parses_to_entries", () => {
    expect(parseHostsBlock(BLOCK)).toEqual([
      ["127.0.0.1", "happyview.atmosbox.internal"],
      ["127.0.0.1", "pds1.atmosbox.test"],
    ]);
  });

  it("hosts_lines_match_by_ip_and_any_name_and_ignore_comments", () => {
    const wanted = parseHostsBlock(BLOCK);
    const hosts =
      "127.0.0.1 localhost\n# 127.0.0.1 pds1.atmosbox.test\n127.0.0.1\tfoo happyview.atmosbox.internal # mine\n";
    expect(missingHosts(hosts, wanted)).toEqual(["127.0.0.1 pds1.atmosbox.test"]);
    expect(missingHosts(`${hosts}${BLOCK}`, wanted)).toEqual([]);
  });

  it("a_changed_ca_needs_trusting_again", () => {
    const hosts = BLOCK;
    const record: AccessRecord = { ca_sha256: "aaa" };
    expect(assess(BLOCK, hosts, "aaa", record).caTrusted).toBe(true);
    expect(assess(BLOCK, hosts, "bbb", record).caTrusted).toBe(false);
    expect(assess(BLOCK, hosts, "aaa", undefined).caTrusted).toBe(false);
  });

  it("the_walkthrough_says_what_to_do_and_never_offers_to_do_it", () => {
    const text = walkthroughText(
      { missingHosts: ["127.0.0.1 pds1.atmosbox.test"], caTrusted: false },
      "/data/x/state/ca/root.crt",
      recordPath("/data/x"),
    );
    expect(text).toContain("127.0.0.1 pds1.atmosbox.test");
    expect(text).toContain("/data/x/state/ca/root.crt");
    expect(text).toContain("hpy does not edit");
    // Removed trust cannot be detected, so the remedy is in the text.
    expect(text).toContain("delete that file");
    expect(text).toContain("/data/x/access.toml");
    expect(text).toContain("certificate error");
    const done = walkthroughText({ missingHosts: [], caTrusted: true }, "/x", "/x/access.toml");
    expect(done).toBe("");
  });

  it("the_record_round_trips", () => {
    const dir = tempdir();
    expect(AccessRecord.load(dir)).toBeUndefined();
    AccessRecord.save({ ca_sha256: "abc" }, dir);
    expect(AccessRecord.load(dir)?.ca_sha256).toBe("abc");
    expect(readFileSync(recordPath(dir), "utf8")).toBe('ca_sha256 = "abc"\n');
  });
});

describe("accounts.rs", () => {
  const write = (checkout: string, body: string) => {
    mkdirSync(join(checkout, "state"), { recursive: true });
    writeFileSync(join(checkout, "state/accounts.json"), body);
  };

  it("reads_the_ready_seeded_user", () => {
    const dir = tempdir();
    write(
      dir,
      `{"version":1,"accounts":{"user1.pds1.atmosbox.test":
            {"handle":"user1.pds1.atmosbox.test","email":"u@x.test","pds":"pds1",
             "password":"pw","phase":"ready","did":"did:plc:user1"}}}`,
    );
    const a = seededSuperadmin(dir)!;
    expect([a.did, a.password]).toEqual(["did:plc:user1", "pw"]);
  });

  it("nothing_before_seed_finishes", () => {
    const dir = tempdir();
    expect(seededSuperadmin(dir)).toBeUndefined();
    write(
      dir,
      `{"version":1,"accounts":{"user1.pds1.atmosbox.test":
            {"handle":"user1.pds1.atmosbox.test","password":"pw","phase":"prepared"}}}`,
    );
    expect(seededSuperadmin(dir)).toBeUndefined();
    write(
      dir,
      `{"version":1,"accounts":{"user1.pds1.atmosbox.test":
            {"handle":"user1.pds1.atmosbox.test","password":"pw","phase":"attempted","did":"did:plc:user1"}}}`,
    );
    expect(seededSuperadmin(dir)).toBeUndefined();
  });

  it("an_unreadable_file_says_so", async () => {
    const dir = tempdir();
    write(dir, "{not json");
    const err = await failure(() => seededSuperadmin(dir));
    expect(err.message).toContain("state/accounts.json");
    expect(err.message).toBe(
      "state/accounts.json is not readable: key must be a string at line 1 column 2",
    );
  });

  it("debug_never_shows_the_password", () => {
    const a = new SeededAccount(SUPERADMIN_HANDLE, "did:plc:user1", "seeded-secret-pw");
    for (const shown of [a.debug(), JSON.stringify(a), inspect(a)]) {
      expect(shown).toContain("<redacted>");
      expect(shown).not.toContain("seeded-secret-pw");
      expect(shown).toContain("did:plc:user1");
    }
  });
});

describe("network.rs", () => {
  it("docker_architectures_map_to_musl_release_targets", () => {
    expect(linuxTarget("x86_64\n")).toBe("x86_64-unknown-linux-musl");
    expect(linuxTarget("aarch64")).toBe("aarch64-unknown-linux-musl");
    expect(linuxTarget("arm64")).toBe("aarch64-unknown-linux-musl");
    expect(() => linuxTarget("s390x")).toThrow();
  });

  it("credentials_print_only_to_a_terminal", () => {
    const a = new SeededAccount("user1.pds1.atmosbox.test", "did:plc:u", "secret-pw");
    const accounts = "/data/net/atmosphereinabox-v0.7.1/state/accounts.json";
    const record = "/data/net/access.toml";
    const shown = banner(a, true, accounts, record);
    expect(
      shown.includes("https://happyview.atmosbox.internal") && shown.includes("secret-pw"),
    ).toBe(true);
    const hidden = banner(a, false, accounts, record);
    expect(hidden.includes("user1.pds1.atmosbox.test") && !hidden.includes("secret-pw")).toBe(true);
    expect(hidden).toContain(accounts);
    // A removed CA trust shows up only as a browser error; the line names the file whose
    // removal repeats the setup.
    for (const text of [shown, hidden]) {
      expect(text).toContain("certificate error");
      expect(text).toContain("delete /data/net/access.toml");
    }
  });

  it("the_password_needs_a_terminal_and_no_json", () => {
    expect(showsPassword(true, false)).toBe(true);
    expect(showsPassword(true, true)).toBe(false);
    expect(showsPassword(false, false)).toBe(false);
    expect(showsPassword(false, true)).toBe(false);
  });

  it("a_stopped_container_reports_its_exit_code_and_an_interrupted_one_zero", () => {
    expect(exitFromInspect("true 0\n")).toBe(0);
    expect(exitFromInspect("false 3\n")).toBe(3);
    expect(exitFromInspect("garbage")).toBe(1);
  });

  it("a_network_whose_project_is_gone_is_named_and_kept", () => {
    const data = tempdir();
    const first = tempdir();
    const second = tempdir();
    const firstPath = realpathSync(first);
    const old = networkDir(data, first);
    expect(claimNetworkDir(old, first)).toEqual([]);
    rmSync(first, { recursive: true });

    const fresh = networkDir(data, second);
    const found = claimNetworkDir(fresh, second);
    expect(found.length, String(found)).toBe(1);
    expect(found[0]).toContain(firstPath);
    expect(found[0]).toContain(old.dir);
    expect(found[0]).toContain("deno task sandbox destroy --accept-destructive");
    expect(found[0]).toContain(`in ${join(old.dir, PINNED.top)}`);
    expect(statSync(old.dir).isDirectory(), "an old network is never deleted").toBe(true);
    // Said once, when the new directory appears.
    expect(claimNetworkDir(fresh, second)).toEqual([]);
  });
});
