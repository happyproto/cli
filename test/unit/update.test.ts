// crates/hpy/src/update.rs, channel.rs and commands/channel.rs tests, by name; then TS-only tests
// for the npm install kind and the daily check's start and finish.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelOf,
  effective,
  latestOn,
  type Release,
  read,
  Version,
  write,
} from "../../src/channel.ts";
import { plan } from "../../src/commands/channel.ts";
import { staleReceipt } from "../../src/commands/update.ts";
import { Failure } from "../../src/core/failure.ts";
import { PACKAGE_NAME, VERSION } from "../../src/core/version.ts";
import {
  available,
  detect,
  due,
  type Env,
  type Escalate,
  enabled,
  type Facts,
  finish,
  inNodeModules,
  installedByReceipt,
  installerUrl,
  isCompiledBinary,
  layout,
  listReleases,
  readLastChecked,
  receiptPath,
  receiptPrefix,
  runJob,
  SelfUpdateError,
  selfUpdateFailed,
  selfUpdatePrefix,
  shellQuote,
  start,
  switchHint,
  thisInstall,
  upgradeHint,
  writeLastChecked,
  writeReceiptVersion,
} from "../../src/update.ts";
import { MockServer, query } from "../support/mock-server.ts";

const v = (s: string) => Version.parse(s);
const release = (tag: string): Release => ({ tag, draft: false });
const releases = (tags: string[]) => tags.map(release);
const facts = (exe: string): Facts => ({
  exe,
  scriptReceipt: false,
  dpkgOwned: false,
  rpmOwned: false,
});
const envOf =
  (pairs: [string, string][]): Env =>
  (k) =>
    pairs.find(([n]) => n === k)?.[1];
const same = (a: Version | undefined, b: string | undefined) =>
  expect(a?.toString()).toBe(b === undefined ? undefined : v(b).toString());

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hpy-update-test-")));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("channel.rs", () => {
  it("a_version_is_on_the_channel_its_prerelease_names", () => {
    expect(channelOf(v("1.0.0"))).toBe("stable");
    expect(channelOf(v("1.0.0-alpha.1"))).toBe("alpha");
    expect(channelOf(v("1.1.0-beta.3"))).toBe("beta");
    expect(channelOf(v("1.0.0-rc.1"))).toBeUndefined();
  });

  it("the_latest_on_a_channel_is_strictly_that_channels", () => {
    const all: Release[] = [
      release("v1.0.0"),
      release("v1.1.0-alpha.2"),
      release("v1.1.0-beta.1"),
      release("v2.0.0"),
      release("not-a-version"),
      { tag: "v1.1.0-alpha.3", draft: true },
    ];
    same(latestOn("stable", all), "2.0.0");
    same(latestOn("beta", all), "1.1.0-beta.1");
    // a newer stable never counts for alpha, and a draft is not released
    same(latestOn("alpha", all), "1.1.0-alpha.2");
    expect(latestOn("alpha", [release("v1.0.0")])).toBeUndefined();
  });

  it("the_chosen_channel_wins_else_the_installed_versions", () => {
    expect(effective("beta", v("1.0.0-alpha.1"))).toBe("beta");
    expect(effective(undefined, v("1.0.0-alpha.1"))).toBe("alpha");
    expect(effective(undefined, v("1.0.0"))).toBe("stable");
    expect(effective(undefined, v("1.0.0-rc.1"))).toBe("stable");
  });

  it("the_chosen_channel_round_trips_and_a_corrupt_file_is_none", () => {
    const path = join(tmp, "hpy/channel.toml");
    expect(read(path)).toBeUndefined();
    write(path, "alpha");
    expect(read(path)).toBe("alpha");
    expect(readFileSync(path, "utf8")).toBe('channel = "alpha"\n');
    writeFileSync(path, 'channel = "nightly"');
    expect(read(path)).toBeUndefined();
  });
});

describe("commands/channel.rs", () => {
  it("a_channel_with_no_releases_cannot_be_switched_to", () => {
    let err: unknown;
    try {
      plan(v("1.0.0"), "beta", releases(["v1.0.0"]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Failure);
    expect((err as Failure).message).toContain("no beta releases");
    expect((err as Failure).code).toBe(1);
  });

  it("a_prerelease_channel_warns_that_it_is_unstable", () => {
    const p = plan(v("1.0.0"), "alpha", releases(["v1.0.0", "v1.1.0-alpha.1", "v1.1.0-alpha.2"]));
    same(p.target, "1.1.0-alpha.2");
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toContain("unstable");
  });

  it("a_channel_whose_newest_is_older_warns_of_the_downgrade", () => {
    const p = plan(v("1.1.0-alpha.2"), "stable", releases(["v1.0.0", "v1.1.0-alpha.2"]));
    same(p.target, "1.0.0");
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toContain("older");
  });

  it("a_newer_stable_needs_no_warning", () => {
    const p = plan(v("1.0.0-alpha.2"), "stable", releases(["v1.0.0", "v1.0.0-alpha.2"]));
    same(p.target, "1.0.0");
    expect(p.warnings).toEqual([]);
  });
});

describe("update.rs", () => {
  it("checks_on_the_first_command_of_each_utc_day", () => {
    expect(due(undefined, "2026-10-09")).toBe(true);
    expect(due("2026-10-09", "2026-10-09")).toBe(false);
    expect(due("2026-10-08", "2026-10-09")).toBe(true);
    // a clock that went backwards still checks once on the new day
    expect(due("2026-10-10", "2026-10-09")).toBe(true);
  });

  it("never_checks_in_ci_or_when_disabled_or_without_a_terminal", () => {
    expect(enabled(envOf([]), true)).toBe(true);
    expect(enabled(envOf([]), false)).toBe(false);
    expect(enabled(envOf([["CI", "true"]]), true)).toBe(false);
    expect(enabled(envOf([["HPY_NO_UPDATE_CHECK", "1"]]), true)).toBe(false);
  });

  it("detects_how_hpy_was_installed", () => {
    expect(detect({ ...facts("/Users/a/.cargo/bin/hpy"), scriptReceipt: true })).toBe("script");
    expect(detect(facts("/opt/homebrew/Cellar/hpy/0.1.0/bin/hpy"))).toBe("homebrew");
    expect(detect(facts("/home/linuxbrew/.linuxbrew/Cellar/hpy/0.1.0/bin/hpy"))).toBe("homebrew");
    expect(detect({ ...facts("/usr/bin/hpy"), dpkgOwned: true })).toBe("apt");
    expect(detect({ ...facts("/usr/bin/hpy"), rpmOwned: true })).toBe("dnf");
    expect(detect(facts("/Users/a/.cargo/bin/hpy"))).toBe("cargo");
    expect(detect(facts("/tmp/hpy"))).toBe("unknown");
  });

  it("tells_package_manager_users_how_to_upgrade_on_their_channel", () => {
    const alpha = v("1.1.0-alpha.2");
    expect(upgradeHint("homebrew", "stable", v("1.1.0"))).toBe("brew upgrade hpy");
    expect(upgradeHint("homebrew", "alpha", alpha)).toBe("brew upgrade hpy-alpha");
    expect(upgradeHint("apt", "alpha", alpha)).toContain("apt install --only-upgrade hpy");
    expect(upgradeHint("dnf", "alpha", alpha)).toContain("dnf upgrade hpy");
    const cargo = upgradeHint("cargo", "alpha", alpha);
    expect(cargo).toContain("--tag v1.1.0-alpha.2");
    // A from-source build that re-resolves builds an untested dependency set, and fails
    // outright when one has been yanked.
    expect(cargo).toContain("--locked");
    expect(upgradeHint("unknown", "alpha", alpha).endsWith("/releases/tag/v1.1.0-alpha.2")).toBe(
      true,
    );
  });

  it("tells_package_manager_users_how_to_switch_channel", () => {
    const alpha = v("1.1.0-alpha.2");
    expect(switchHint("homebrew", "stable", "alpha", alpha)).toBe(
      "brew uninstall hpy && brew install happyproto/tap/hpy-alpha",
    );
    const apt = switchHint("apt", "stable", "alpha", alpha);
    expect(apt).toContain("/deb alpha main");
    // apt never picks a lower version on its own, so name it exactly
    expect(apt).toContain("hpy=1.1.0~alpha.2");
    const dnf = switchHint("dnf", "alpha", "stable", v("1.0.0"));
    expect(dnf).toContain("/hpy.repo");
    expect(dnf).toContain("dnf distro-sync hpy");
    expect(switchHint("dnf", "stable", "beta", v("1.1.0-beta.1"))).toContain("/hpy-beta.repo");
  });

  it("only_newer_versions_on_the_channel_count", () => {
    const all = releases(["v1.0.0", "v1.1.0", "v1.2.0-alpha.1", "v1.2.0-alpha.2"]);
    same(available(v("1.0.0"), "stable", all), "1.1.0");
    expect(available(v("1.1.0"), "stable", all)).toBeUndefined();
    same(available(v("1.2.0-alpha.1"), "alpha", all), "1.2.0-alpha.2");
    // strict: a newer stable is not offered on alpha
    const later = releases(["v1.2.0-alpha.2", "v2.0.0"]);
    expect(available(v("1.2.0-alpha.2"), "alpha", later)).toBeUndefined();
    expect(available(v("1.0.0"), "beta", all)).toBeUndefined();
  });

  it("state_round_trips_and_a_corrupt_file_reads_as_never_checked", () => {
    const path = join(tmp, "hpy/update-check.toml");
    expect(readLastChecked(path)).toBeUndefined();
    writeLastChecked(path, "2026-10-09");
    expect(readLastChecked(path)).toBe("2026-10-09");
    expect(readFileSync(path, "utf8")).toBe('last_checked = "2026-10-09"\n');
    writeFileSync(path, "not toml [");
    expect(readLastChecked(path)).toBeUndefined();
  });

  it("lists_the_releases_skipping_drafts_downstream", async () => {
    const server = await MockServer.start();
    try {
      server.given(
        "GET",
        "/repos/happyproto/cli/releases",
        {
          json: [
            { tag_name: "v1.4.0-alpha.1", draft: false, prerelease: true },
            { tag_name: "v1.3.0", draft: false, prerelease: false },
          ],
        },
        query("per_page", "100"),
      );
      const found = await listReleases(server.url);
      expect(found?.map((r) => r.tag)).toEqual(["v1.4.0-alpha.1", "v1.3.0"]);
      const req = server.requests[0];
      expect(req?.headers.accept).toBe("application/vnd.github+json");
      expect(req?.headers["user-agent"]).toBe(`hpy/${VERSION}`);
      expect(await listReleases("http://127.0.0.1:9")).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  it("finds_the_installer_receipt", () => {
    expect(
      receiptPath(
        envOf([
          ["XDG_CONFIG_HOME", "/x"],
          ["HOME", "/h"],
        ]),
        false,
      ),
    ).toBe("/x/hpy-cli/hpy-cli-receipt.json");
    expect(receiptPath(envOf([["HOME", "/h"]]), false)).toBe(
      "/h/.config/hpy-cli/hpy-cli-receipt.json",
    );
    expect(receiptPath(envOf([["LOCALAPPDATA", "C:/l"]]), true)).toBe(
      "C:/l/hpy-cli/hpy-cli-receipt.json",
    );
    expect(receiptPath(envOf([]), false)).toBeUndefined();
  });

  it("a_receipt_counts_only_for_the_binary_it_installed", () => {
    const prefix = join(tmp, ".cargo");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(prefix, "bin/hpy"), "");
    const receipt = `{"install_prefix":${JSON.stringify(prefix)},"version":"0.1.0","binaries":["hpy"]}`;
    const prefixRead = receiptPrefix(receipt) as string;
    expect(installedByReceipt(join(prefix, "bin/hpy"), prefixRead)).toBe(true);
    const elsewhere = join(tmp, "usr/bin");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "hpy"), "");
    expect(installedByReceipt(join(elsewhere, "hpy"), prefixRead)).toBe(false);
    expect(receiptPrefix("{")).toBeUndefined();
  });

  it("the_installer_url_follows_the_release", () => {
    expect(installerUrl("1.4.0", false)).toBe(
      "https://github.com/happyproto/cli/releases/download/v1.4.0/hpy-cli-installer.sh",
    );
    expect(installerUrl("1.4.0", true).endsWith("/v1.4.0/hpy-cli-installer.ps1")).toBe(true);
  });
});

describe("update.rs self_update_policy", () => {
  // `cargo install` copies into a directory the user owns, so hpy can replace that copy itself
  // rather than asking for a build from source.
  it("a_cargo_install_is_replaced_in_place", () => {
    expect(selfUpdatePrefix("cargo", join(tmp, "hpy"))).toBe(tmp);
  });

  it("an_unknown_install_is_replaced_when_its_directory_is_writable", () => {
    expect(selfUpdatePrefix("unknown", join(tmp, "hpy"))).toBe(tmp);
    // Nowhere to write means the hint, not a half-finished install.
    expect(selfUpdatePrefix("unknown", "/nonexistent-xyz/hpy")).toBeUndefined();
  });

  // These keep a database of the files they own, and their next upgrade would revert anything
  // swapped underneath them.
  it("a_managed_install_is_left_to_its_manager", () => {
    for (const install of ["homebrew", "apt", "dnf"] as const)
      expect(selfUpdatePrefix(install, join(tmp, "hpy")), install).toBeUndefined();
  });
});

const unix = process.platform !== "win32";
const root = unix && process.getuid?.() === 0;

/**
 * The update decision for a copy of hpy the shell installer put in a directory only root can
 * write to, against a stand-in installer (served by the mock) and a stand-in sudo that records
 * how it was called and runs the command without escalating.
 */
describe.skipIf(!unix)("update.rs sudo_boundary", () => {
  interface World {
    root: string;
    server: MockServer;
    installs: string;
    sudoCalls: string;
    sudo: string;
    receipt: string;
  }
  let worlds: World[] = [];
  afterEach(async () => {
    for (const w of worlds) await w.server.stop();
    worlds = [];
  });

  const script = (path: string, body: string) => {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  const lines = (path: string): string[] =>
    existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  const contents = (path: string) => readFileSync(path, "utf8");

  async function world(sudoFails: boolean): Promise<World> {
    const installs = join(tmp, "installs.log");
    const sudoCalls = join(tmp, "sudo.log");
    // dist's installer, as far as this decision cares: the flat layout for an unmanaged
    // install, `<dir>/bin` for a forced one.
    const installer = `#!/bin/sh
set -eu
if [ -n "\${HPY_CLI_UNMANAGED_INSTALL:-}" ]; then
  d=$HPY_CLI_UNMANAGED_INSTALL; how=flat
elif [ -n "\${CARGO_DIST_FORCE_INSTALL_DIR:-}" ]; then
  d=$CARGO_DIST_FORCE_INSTALL_DIR/bin; how=cargo-home
else
  exit 3
fi
printf '%s %s\\n' "$how" "$d" >> '${installs}'
mkdir -p "$d"
printf 'new\\n' > "$d/hpy"
chmod 755 "$d/hpy"
`;
    const server = await MockServer.start();
    server.given("GET", "/installer.sh", { body: installer });
    // Runs the command as this user, making the target's directory writable for just that
    // long, as root would find it.
    const sudo = join(tmp, "sudo");
    script(
      sudo,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${sudoCalls}'
${sudoFails ? "exit 1" : ""}
for a; do last=$a; done
d=$(dirname "$last")
chmod u+w "$d"
"$@"
rc=$?
chmod 555 "$d"
exit $rc
`,
    );
    const receipt = join(tmp, "config/hpy-cli/hpy-cli-receipt.json");
    const w = { root: tmp, server, installs, sudoCalls, sudo, receipt };
    worlds.push(w);
    return w;
  }

  /** A copy of hpy at `<root>/<rel>/hpy`, recorded in the receipt the shell installer writes, with `prefix` as its install prefix. */
  function installed(w: World, rel: string, prefix: string, lay: string): string {
    const dir = join(w.root, rel);
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "hpy");
    writeFileSync(exe, "old\n");
    chmodSync(exe, 0o755);
    mkdirSync(dirname(w.receipt), { recursive: true });
    writeFileSync(
      w.receipt,
      `{"binaries":["hpy"],"binary_aliases":{},"cdylibs":[],"cstaticlibs":[],"install_layout":"${lay}","install_prefix":"${prefix}","modify_path":false,"provider":{"source":"cargo-dist","version":"0.32.0"},"source":{"app_name":"hpy-cli","name":"cli","owner":"happyproto","release_type":"github"},"version":"1.0.0-alpha.1"}`,
    );
    return exe;
  }

  function doUpdate(
    w: World,
    exe: string,
    prefix: string,
    terminal: boolean,
    escalate: Escalate,
  ): Promise<void> {
    return runJob({
      installerUrl: `${w.server.url}/installer.sh`,
      exe,
      prefix,
      version: v("1.0.0-alpha.2"),
      terminal,
      sudo: w.sudo,
      escalate,
      receipt: w.receipt,
    });
  }

  const receiptVersion = (w: World) =>
    (JSON.parse(readFileSync(w.receipt, "utf8")) as { version: string }).version;

  async function needsRoot(p: Promise<void>): Promise<string> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(SelfUpdateError);
      expect((e as SelfUpdateError).kind).toBe("needsRoot");
      return (e as SelfUpdateError).message;
    }
    throw new Error("expected NeedsRoot");
  }

  // The receipt the shell installer writes for its /usr/local/bin copy makes this a Script
  // install with that directory as its prefix.
  it("the_shell_installers_receipt_is_recognised", () => {
    const sys = join(tmp, "usr/local/bin");
    mkdirSync(sys, { recursive: true });
    writeFileSync(join(sys, "hpy"), "");
    const receipt = `{"binaries":["hpy"],"binary_aliases":{},"cdylibs":[],"cstaticlibs":[],"install_layout":"flat","install_prefix":"${sys}","modify_path":false,"provider":{"source":"cargo-dist","version":"0.32.0"},"source":{"app_name":"hpy-cli","name":"cli","owner":"happyproto","release_type":"github"},"version":"1.0.0-alpha.30"}`;
    const prefix = receiptPrefix(receipt) as string;
    expect(installedByReceipt(join(sys, "hpy"), prefix)).toBe(true);
    expect(layout(join(sys, "hpy"), prefix)).toBe("flat");
    expect(detect({ ...facts(join(sys, "hpy")), scriptReceipt: true })).toBe("script");
  });

  it("a_writable_flat_install_runs_the_installer_into_its_prefix", async () => {
    const w = await world(false);
    const sys = join(w.root, "sys");
    const exe = installed(w, "sys", sys, "flat");
    await doUpdate(w, exe, sys, true, "ask");
    expect(lines(w.installs)).toEqual([`flat ${sys}`]);
    expect(contents(exe)).toBe("new\n");
    expect(lines(w.sudoCalls), "no sudo for a writable directory").toEqual([]);
    expect(receiptVersion(w)).toBe("1.0.0-alpha.2");
    // serde_json's compact form, keys sorted, one newline.
    expect(contents(w.receipt)).toBe(
      `{"binaries":["hpy"],"binary_aliases":{},"cdylibs":[],"cstaticlibs":[],"install_layout":"flat","install_prefix":"${sys}","modify_path":false,"provider":{"source":"cargo-dist","version":"0.32.0"},"source":{"app_name":"hpy-cli","name":"cli","owner":"happyproto","release_type":"github"},"version":"1.0.0-alpha.2"}\n`,
    );
  });

  // `~/.cargo/bin` and `HPY_CLI_INSTALL_DIR` installs: unchanged, the installer into the
  // prefix, which writes its own receipt.
  it("a_writable_bin_install_runs_the_installer_into_its_prefix", async () => {
    const w = await world(false);
    const cargo = join(w.root, "cargo");
    const exe = installed(w, "cargo/bin", cargo, "cargo-home");
    await doUpdate(w, exe, cargo, false, "ask");
    expect(lines(w.installs)).toEqual([`cargo-home ${cargo}/bin`]);
    expect(contents(exe)).toBe("new\n");
    expect(lines(w.sudoCalls)).toEqual([]);
  });

  it.skipIf(root)("an_unwritable_install_with_a_terminal_is_copied_with_sudo", async () => {
    const w = await world(false);
    const sys = join(w.root, "sys");
    const exe = installed(w, "sys", sys, "flat");
    chmodSync(sys, 0o555);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await doUpdate(w, exe, sys, true, "ask");
    } finally {
      errSpy.mockRestore();
      chmodSync(sys, 0o755);
    }

    // The installer ran unprivileged, into a staging directory elsewhere; sudo was asked for
    // exactly one thing, the copy.
    const installs = lines(w.installs);
    expect(installs).toHaveLength(1);
    const stagedDir = (installs[0] as string).replace(/^flat /, "");
    expect(stagedDir.startsWith(sys)).toBe(false);
    expect(lines(w.sudoCalls)).toEqual([`install -m 0755 ${stagedDir}/hpy ${exe}`]);
    expect(contents(exe)).toBe("new\n");
    expect(statSync(exe).mode & 0o777).toBe(0o755);
    // The staging directory is gone, and the receipt says what is there.
    expect(existsSync(stagedDir)).toBe(false);
    expect(receiptVersion(w)).toBe("1.0.0-alpha.2");
    expect(readdirSync(sys), "no second copy").toHaveLength(1);
  });

  it.skipIf(root)("an_unwritable_install_without_a_terminal_prints_the_command", async () => {
    const w = await world(false);
    const sys = join(w.root, "sys");
    const exe = installed(w, "sys", sys, "flat");
    chmodSync(sys, 0o555);
    const msg = await needsRoot(doUpdate(w, exe, sys, false, "ask")).finally(() =>
      chmodSync(sys, 0o755),
    );
    expect(lines(w.sudoCalls), "no sudo without a terminal").toEqual([]);
    expect(contents(exe), "the binary is untouched").toBe("old\n");
    expect(receiptVersion(w)).toBe("1.0.0-alpha.1");
    const stagedDir = (lines(w.installs)[0] as string).replace(/^flat /, "");
    const command = `sudo install -m 0755 ${stagedDir}/hpy ${exe}`;
    expect(msg).toContain(command);
    // The command works: the staged binary was kept for it.
    expect(contents(join(stagedDir, "hpy"))).toBe("new\n");
    rmSync(dirname(stagedDir), { recursive: true, force: true });
  });

  it.skipIf(root)("a_failing_sudo_leaves_the_binary_untouched", async () => {
    const w = await world(true);
    const sys = join(w.root, "sys");
    const exe = installed(w, "sys", sys, "flat");
    chmodSync(sys, 0o555);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const msg = await needsRoot(doUpdate(w, exe, sys, true, "ask")).finally(() => {
      errSpy.mockRestore();
      chmodSync(sys, 0o755);
    });
    expect(lines(w.sudoCalls)).toHaveLength(1);
    expect(contents(exe), "the binary is untouched").toBe("old\n");
    expect(receiptVersion(w)).toBe("1.0.0-alpha.1");
    expect(msg).toContain("sudo install -m 0755 ");
    const stagedDir = (lines(w.installs)[0] as string).replace(/^flat /, "");
    rmSync(dirname(stagedDir), { recursive: true, force: true });
  });

  // The daily check runs behind another command, and never prompts.
  it.skipIf(root)("the_background_update_never_asks_for_sudo", async () => {
    const w = await world(false);
    const sys = join(w.root, "sys");
    const exe = installed(w, "sys", sys, "flat");
    chmodSync(sys, 0o555);
    await needsRoot(doUpdate(w, exe, sys, true, "never")).finally(() => chmodSync(sys, 0o755));
    expect(lines(w.installs)).toEqual([]);
    expect(lines(w.sudoCalls)).toEqual([]);
    expect(contents(exe)).toBe("old\n");
  });

  it("a_receipt_for_another_prefix_is_not_touched", () => {
    const receipt = join(tmp, "r.json");
    writeFileSync(receipt, '{"install_prefix":"/somewhere/else","version":"1.0.0"}');
    const ver = v("1.0.1");
    expect(writeReceiptVersion(receipt, tmp, ver)).toBe(false);
    expect(contents(receipt)).toContain('"version":"1.0.0"');
    expect(writeReceiptVersion(join(tmp, "none.json"), tmp, ver)).toBe(false);
  });

  it("printed_paths_are_quoted_when_they_need_it", () => {
    expect(shellQuote("/usr/local/bin/hpy")).toBe("/usr/local/bin/hpy");
    expect(shellQuote("/a b/it's")).toBe("'/a b/it'\\''s'");
  });
});

// --- TS-only ---

describe("update.ts npm install kind (TS-only)", () => {
  it("an_npm_copy_belongs_to_npm_wherever_its_modules_live", () => {
    // Homebrew's Node keeps global modules under /opt/homebrew, which must not read as Homebrew.
    const homebrewNode = "/opt/homebrew/lib/node_modules/@happyproto/cli/dist/hpy.mjs";
    expect(inNodeModules(homebrewNode)).toBe(true);
    expect(detect({ ...facts(homebrewNode), npm: true })).toBe("npm");
    expect(
      detect({ ...facts("/usr/lib/node_modules/x/dist/hpy.mjs"), npm: true, dpkgOwned: true }),
    ).toBe("npm");
    expect(inNodeModules("/home/a/src/cli/dist/hpy.mjs")).toBe(false);
    expect(inNodeModules("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\x\\hpy.mjs")).toBe(
      true,
    );
  });

  it("npm_users_upgrade_and_switch_with_npm_by_dist_tag", () => {
    expect(PACKAGE_NAME).toBe(
      (
        JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
          name: string;
        }
      ).name,
    );
    expect(upgradeHint("npm", "alpha", v("1.1.0-alpha.2"))).toBe(`npm i -g ${PACKAGE_NAME}@alpha`);
    expect(upgradeHint("npm", "stable", v("1.1.0"))).toBe(`npm i -g ${PACKAGE_NAME}@latest`);
    expect(switchHint("npm", "alpha", "beta", v("1.1.0-beta.1"))).toBe(
      `npm i -g ${PACKAGE_NAME}@beta`,
    );
    expect(switchHint("npm", "alpha", "stable", v("1.0.0"))).toBe(
      `npm i -g ${PACKAGE_NAME}@latest`,
    );
  });

  it("an_npm_copy_is_never_replaced_in_place", () => {
    expect(selfUpdatePrefix("npm", join(tmp, "hpy"))).toBeUndefined();
    expect(staleReceipt("npm")).toBeUndefined();
    expect(staleReceipt("cargo")).toContain("cargo install");
  });

  it("a_script_run_by_node_is_not_a_binary_to_replace", () => {
    expect(isCompiledBinary()).toBe(false);
    const self = thisInstall();
    // vitest runs src/update.ts from the checkout, not from node_modules.
    expect(self?.install).toBe("unknown");
    expect(self?.prefix).toBeUndefined();
  });
});

describe("update.ts daily check (TS-only)", () => {
  const on = envOf([]);
  let server: MockServer;
  let err: string;
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    server = await MockServer.start();
    err = "";
    spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      err += String(s);
      return true;
    });
  });
  afterEach(async () => {
    spy.mockRestore();
    await server.stop();
  });

  const serve = (tags: string[]) =>
    server.given("GET", "/repos/happyproto/cli/releases", {
      json: tags.map((t) => ({ tag_name: t, draft: false })),
    });
  const npmCopy = () => ({ exe: join(tmp, "hpy.mjs"), install: "npm" as const, prefix: undefined });
  // A release newer than this one, on this one's channel.
  const ours = channelOf(v(VERSION)) ?? "stable";
  const newer = `${v(VERSION).major + 1n}.0.0${ours === "stable" ? "" : `-${ours}.1`}`;

  it("is_off_without_a_terminal_in_ci_or_when_disabled", () => {
    expect(start(tmp, { env: on, terminal: false })).toBeUndefined();
    expect(start(tmp, { env: envOf([["CI", "1"]]), terminal: true })).toBeUndefined();
    expect(
      start(tmp, { env: envOf([["HPY_NO_UPDATE_CHECK", "1"]]), terminal: true }),
    ).toBeUndefined();
    expect(existsSync(join(tmp, "update-check.toml"))).toBe(false);
  });

  it("records_the_day_up_front_and_checks_once_a_day", async () => {
    serve([]);
    const o = {
      env: on,
      terminal: true,
      today: "2026-10-09",
      apiBase: server.url,
      thisInstall: npmCopy,
    };
    const p = start(tmp, o);
    expect(p).toBeDefined();
    expect(readLastChecked(join(tmp, "update-check.toml"))).toBe("2026-10-09");
    await finish(p);
    expect(start(tmp, o)).toBeUndefined();
    expect(start(tmp, { ...o, today: "2026-10-10" })).toBeDefined();
    expect(err).toBe("");
  });

  it("tells_an_npm_user_how_to_upgrade", async () => {
    serve([`v${newer}`]);
    const p = start(tmp, {
      env: on,
      terminal: true,
      today: "d",
      apiBase: server.url,
      thisInstall: npmCopy,
    });
    await finish(p);
    const tag = ours === "stable" ? "latest" : ours;
    expect(err).toBe(
      `\nhpy ${newer} is available (you have ${VERSION}). To upgrade: npm i -g ${PACKAGE_NAME}@${tag}\n`,
    );
  });

  it("says_nothing_when_current_or_when_the_check_fails", async () => {
    serve([`v${VERSION}`]);
    await finish(
      start(tmp, {
        env: on,
        terminal: true,
        today: "a",
        apiBase: server.url,
        thisInstall: npmCopy,
      }),
    );
    await finish(
      start(tmp, {
        env: on,
        terminal: true,
        today: "b",
        apiBase: "http://127.0.0.1:9",
        thisInstall: npmCopy,
      }),
    );
    await finish(
      start(tmp, {
        env: on,
        terminal: true,
        today: "c",
        apiBase: server.url,
        thisInstall: () => undefined,
      }),
    );
    expect(err).toBe("");
  });

  it("waits_at_most_briefly_for_the_check", async () => {
    // A release list that takes longer than the wait, as a slow network would.
    server.given("GET", "/repos/happyproto/cli/releases", () => ({ json: [] }));
    const p = start(tmp, {
      env: on,
      terminal: true,
      today: "d",
      apiBase: "http://10.255.255.1",
      thisInstall: npmCopy,
    });
    const t0 = Date.now();
    await finish(p, { waitMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(err).toBe("");
  });

  it("a_writable_installer_copy_updates_itself_quietly_behind_the_command", async () => {
    serve([`v${newer}`]);
    const calls: [string, string, string][] = [];
    const self = () => ({ exe: join(tmp, "hpy"), install: "script" as const, prefix: tmp });
    await finish(
      start(tmp, { env: on, terminal: true, today: "d", apiBase: server.url, thisInstall: self }),
      {
        selfUpdate: async (latest, prefix, escalate) => {
          calls.push([latest.toString(), prefix, escalate]);
        },
      },
    );
    expect(calls).toEqual([[newer, tmp, "never"]]);
    expect(err).toBe(`\nUpdating hpy ${VERSION} → ${newer}…\nUpdated hpy to ${newer}.\n`);
    err = "";
    await finish(
      start(tmp, { env: on, terminal: true, today: "e", apiBase: server.url, thisInstall: self }),
      {
        selfUpdate: async () => {
          throw new SelfUpdateError("failed", "boom");
        },
      },
    );
    expect(err).toBe(
      `\nUpdating hpy ${VERSION} → ${newer}…\n${selfUpdateFailed(v(newer), new SelfUpdateError("failed", "boom"))}\n`,
    );
  });

  it.skipIf(!unix || root)("an_unwritable_installer_copy_is_pointed_at_hpy_update", async () => {
    serve([`v${newer}`]);
    const ro = join(tmp, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    try {
      await finish(
        start(tmp, {
          env: on,
          terminal: true,
          today: "d",
          apiBase: server.url,
          thisInstall: () => ({ exe: join(ro, "hpy"), install: "script", prefix: ro }),
        }),
      );
    } finally {
      chmodSync(ro, 0o755);
    }
    expect(err).toBe(`\nhpy ${newer} is available (you have ${VERSION}). To upgrade: hpy update\n`);
  });
});

describe("update.rs messages", () => {
  it("self_update_failures_say_how_to_update_by_hand", () => {
    expect(selfUpdateFailed(v("1.0.0"), new SelfUpdateError("failed", "x"))).toBe(
      "Could not update hpy automatically (x). To update by hand: curl -fsSL https://happyproto.github.io/cli/install.sh | sh",
    );
    expect(selfUpdateFailed(v("1.0.0-alpha.3"), new SelfUpdateError("failed", "x"))).toContain(
      "/install-alpha.sh | sh",
    );
    expect(selfUpdateFailed(v("1.0.0-rc.1"), new SelfUpdateError("failed", "x"))).toContain(
      "/download/v1.0.0-rc.1/hpy-cli-installer.sh | sh",
    );
    expect(selfUpdateFailed(v("1.0.0"), new SelfUpdateError("needsRoot", "y"))).toBe(
      "Could not update hpy: y",
    );
  });
});
