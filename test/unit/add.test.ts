// crates/hpy/src/commands/happyview/add.rs tests.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  type AddArgs,
  type Addition,
  addedLine,
  addIn,
  applyAdditions,
  planAdditions,
  report,
  requestedPin,
} from "../../src/commands/add.ts";
import { Failure } from "../../src/core/failure.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import { projectUri } from "../../src/plugin/validate.ts";
import { CONFIG_FILE, entryProjectUri, type Pin, ProjectToml } from "../../src/project/config.ts";
import { Lockfile } from "../../src/project/lock.ts";
import type { Choose } from "../../src/project/resolve.ts";
import { interpreterExt, libraryExt, privateTempdir, RegistryFixture } from "../support/fakes.ts";

const HV = "did:plc:happyview";

const never: Choose = () => {
  throw new Error("nothing should be ambiguous here");
};

function registry(): RegistryFixture {
  const reg = new RegistryFixture();
  reg.publish(HV, "happyview-lua", "1.4.0", interpreterExt("lua", "lua"), {}, "a");
  reg.publish(HV, "happyview-lua", "1.5.0", interpreterExt("lua", "lua"), {}, "b");
  reg.publish(HV, "happyview-http", "1.0.3", libraryExt("happyview.http"), {}, "c");
  return reg;
}

function plan(
  reg: RegistryFixture,
  specs: string[],
  kind?: "interpreter" | "library",
  project?: string,
  pin?: Pin,
): Promise<Addition[]> {
  return planAdditions(reg, specs, kind, project, pin, undefined, never);
}

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Failure);
    return e as Failure;
  }
  throw new Error("expected a failure");
}

function failureOf(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(Failure);
    return e as Failure;
  }
  throw new Error("expected a failure");
}

it("the_kind_is_found_from_the_registry_and_the_latest_channel_followed", async () => {
  const adds = await plan(registry(), ["lua", "happyview.http"]);
  expect(adds.map((a) => [a.kind, a.key, a.entry.name, a.version])).toEqual([
    ["interpreter", "lua", "happyview-lua", "1.5.0"],
    ["library", "happyview.http", "happyview-http", "1.0.3"],
  ]);
  expect(adds[0]!.entry.pin).toEqual({ kind: "channel", channel: "latest" });
  expect(adds[0]!.entry.did).toBe(HV);
});

it("a_channel_or_version_given_is_written_and_must_exist", async () => {
  const reg = registry();
  const adds = await plan(reg, ["lua"], undefined, undefined, {
    kind: "version",
    version: "1.4.0",
  });
  expect(adds[0]!.entry.pin).toEqual({ kind: "version", version: "1.4.0" });
  expect(adds[0]!.version).toBe("1.4.0");
  let err = await failure(
    plan(reg, ["lua"], undefined, undefined, { kind: "version", version: "9.0.0" }),
  );
  expect(err.message).toContain("no happyview-lua 9.0.0");
  err = await failure(
    plan(reg, ["lua"], undefined, undefined, { kind: "channel", channel: "beta" }),
  );
  expect(err.message).toContain("no beta channel");
});

it("the_pin_flags_are_checked", () => {
  expect(requestedPin(undefined, undefined)).toBeUndefined();
  expect(requestedPin("beta", undefined)).toEqual({ kind: "channel", channel: "beta" });
  expect(requestedPin(undefined, "1.0.0")).toEqual({ kind: "version", version: "1.0.0" });
  for (const [c, v] of [
    ["stable", undefined],
    [undefined, "^1"],
    ["beta", "1.0.0"],
  ] as const) {
    expect(failureOf(() => requestedPin(c, v)).code, `${c} ${v}`).toBe(2);
  }
});

it("the_old_at_version_spelling_points_at_the_flag", async () => {
  const err = await failure(plan(registry(), ["lua@1.4.0"]));
  expect(err.code).toBe(2);
  expect(err.message).toContain("--version 1.4.0");
});

it("a_project_with_only_prereleases_follows_its_channel", async () => {
  const reg = registry();
  for (const v of ["0.1.0-alpha.1", "0.1.0-alpha.3"]) {
    reg.publish(HV, "happyview-js", v, interpreterExt("js", "js"), {}, v);
  }
  const adds = await plan(reg, ["js"]);
  expect(adds[0]!.entry.pin).toEqual({ kind: "channel", channel: "alpha" });
  expect(adds[0]!.version).toBe("0.1.0-alpha.3");
});

it("the_prerelease_note_is_only_for_a_defaulted_channel", () => {
  const add: Addition = {
    kind: "interpreter",
    key: "js",
    entry: { did: HV, name: "happyview-js", pin: { kind: "channel", channel: "alpha" } },
    version: "0.1.0-alpha.3",
  };
  expect(addedLine(add, true)).toContain("no latest channel");
  expect(addedLine(add, false)).not.toContain("no latest channel");
});

it("a_name_both_kinds_answer_needs_a_flag", async () => {
  const reg = registry();
  reg.publish("did:plc:x", "lua", "1.0.0", libraryExt("lua"), {}, "d");
  const err = await failure(plan(reg, ["lua"]));
  expect(err.message).toContain("--interpreter or --library");
  const adds = await plan(reg, ["lua"], "library");
  expect(entryProjectUri(adds[0]!.entry)).toBe(projectUri("did:plc:x", "lua"));
});

it("project_picks_among_several", async () => {
  const reg = registry();
  reg.publish("did:plc:x", "other-lua", "3.0.0", interpreterExt("lua", "lua"), {}, "e");
  const uri = projectUri("did:plc:x", "other-lua");
  const adds = await plan(reg, ["lua"], undefined, uri);
  expect([entryProjectUri(adds[0]!.entry), adds[0]!.version]).toEqual([uri, "3.0.0"]);
  const err = await failure(plan(reg, ["lua"], undefined, projectUri("did:plc:nobody", "x")));
  expect(err.message).toContain("does not answer to `lua`");
});

it("applying_keeps_the_rest_of_the_file", () => {
  const text =
    '# mine\n[happyview]\nversion = "3.0.0"\n\n[interpreters]\nlua = { did = "did:plc:happyview", name = "happyview-lua", channel = "latest" } # keep\n';
  const out = applyAdditions(text, [
    {
      kind: "library",
      key: "happyview.http",
      entry: { did: HV, name: "happyview-http", pin: { kind: "version", version: "1.0.3" } },
      version: "1.0.3",
    },
  ]);
  expect(out.startsWith("# mine\n"), out).toBe(true);
  expect(out).toContain('channel = "latest" } # keep');
  expect(out).toContain(
    '"happyview.http" = { did = "did:plc:happyview", name = "happyview-http", version = "1.0.3" }',
  );
});

function project(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hpy-add-"));
  writeFileSync(join(dir, CONFIG_FILE), toml);
  return dir;
}

function args(plugins: string[], project?: string): AddArgs {
  return {
    plugins,
    interpreter: false,
    library: false,
    channel: undefined,
    version: undefined,
    project,
  };
}

const quiet = () => {};
const read = (p: string) => readFileSync(p, "utf8");

it("adding_writes_the_entry_the_lock_and_the_json", async () => {
  const reg = registry();
  const dir = project('[happyview]\nversion = "3.0.0"\n');
  const cache = privateTempdir();
  const [adds, lock] = await addIn(dir, reg, cache, args(["lua"]), never, quiet);
  const cfg = ProjectToml.load(dir);
  expect(cfg.interpreters.get("lua")).toEqual(adds[0]!.entry);
  expect(lock.plugins[0]!.version).toBe("1.5.0");
  expect(existsSync(join(dir, "happyview.lock"))).toBe(true);
  expect(report(adds, lock)).toEqual({
    added: [
      {
        kind: "interpreter",
        key: "lua",
        project: projectUri(HV, "happyview-lua"),
        channel: "latest",
        version: "1.5.0",
      },
    ],
    locked: [{ id: "happyview-lua", version: "1.5.0" }],
  });
  expect(read(join(cache, "plugins/happyview-lua/1.5.0/happyview-lua.wasm"))).toBe("b");
});

it("a_named_project_replaces_the_one_the_lock_recorded", async () => {
  const reg = registry();
  reg.publish("did:plc:x", "other-lua", "3.0.0", interpreterExt("lua", "lua"), {}, "other");
  const first = projectUri(HV, "happyview-lua");
  const second = projectUri("did:plc:x", "other-lua");
  const dir = project('[happyview]\nversion = "3.0.0"\n');
  const cache = privateTempdir();
  await addIn(dir, reg, cache, args(["lua"], first), never, quiet);
  await addIn(dir, reg, cache, args(["lua"], second), never, quiet);
  const lua = Lockfile.load(dir)!.findKey("interpreter", "lua")!;
  expect([lua.project, lua.version]).toEqual([second, "3.0.0"]);
});

it("a_locked_key_keeps_its_project_without_searching_and_moves_to_the_channel_head", async () => {
  const reg = registry();
  reg.publish("did:plc:x", "other-lua", "3.0.0", interpreterExt("lua", "lua"), {}, "other");
  const original = projectUri(HV, "happyview-lua");
  const dir = project('[happyview]\nversion = "3.0.0"\n');
  const cache = privateTempdir();
  const pinned = args(["lua"], original);
  pinned.version = "1.4.0";
  await addIn(dir, reg, cache, pinned, never, quiet);
  reg.calls.length = 0;
  // Two projects answer to `lua`, and `never` throws if asked.
  const [adds, lock] = await addIn(dir, reg, cache, args(["lua"]), never, quiet);
  expect(entryProjectUri(adds[0]!.entry)).toBe(original);
  const lua = lock.findKey("interpreter", "lua")!;
  expect([lua.project, lua.version]).toEqual([original, "1.5.0"]);
  expect(
    reg.calls.some((c) => c.startsWith("searchProjects")),
    reg.calls.join(", "),
  ).toBe(false);
});

it("installing_keeps_the_locked_version_and_touches_no_file", async () => {
  const reg = new RegistryFixture();
  reg.publish(HV, "happyview-lua", "1.4.0", interpreterExt("lua", "lua"), {}, "a");
  const dir = project('[happyview]\nversion = "3.0.0"\n');
  const cache = privateTempdir();
  await addIn(dir, reg, cache, args(["lua"]), never, quiet);
  reg.publish(HV, "happyview-lua", "1.5.0", interpreterExt("lua", "lua"), {}, "b");
  const tomlPath = join(dir, CONFIG_FILE);
  const lockPath = join(dir, "happyview.lock");
  const lockText = read(lockPath);
  const longAgo = new Date(1_000_000_000 * 1000);
  for (const path of [tomlPath, lockPath]) utimesSync(path, longAgo, longAgo);
  rmSync(join(cache, "plugins"), { recursive: true });

  const [adds, lock] = await addIn(dir, reg, cache, args([]), never, quiet);
  expect(adds).toEqual([]);
  expect(lock.plugins[0]!.version).toBe("1.4.0");
  expect(read(lockPath)).toBe(lockText);
  for (const path of [tomlPath, lockPath]) {
    expect(statSync(path).mtime.getTime(), path).toBe(longAgo.getTime());
  }
  expect(read(join(cache, "plugins/happyview-lua/1.4.0/happyview-lua.wasm"))).toBe("a");
});

it("a_refused_resolution_leaves_both_files_alone", async () => {
  const reg = registry();
  const toml = `[happyview]\nversion = "3.0.0"\n\n[interpreters]\nlua = { did = "${HV}", name = "happyview-lua", version = "1.4.0" }\n`;
  const dir = project(toml);
  const cache = privateTempdir();
  await addIn(dir, reg, cache, args([]), never, quiet);
  const lock = read(join(dir, "happyview.lock"));
  // A hand edit no version satisfies; adding beside it must not write.
  const broken = toml.replace("1.4.0", "7.0.0");
  writeFileSync(join(dir, CONFIG_FILE), broken);
  await failure(addIn(dir, reg, cache, args(["happyview.http"]), never, quiet));
  expect(read(join(dir, CONFIG_FILE))).toBe(broken);
  expect(read(join(dir, "happyview.lock"))).toBe(lock);
});

it("a_failed_download_leaves_both_files_alone", async () => {
  const reg = registry();
  const dir = project('[happyview]\nversion = "3.0.0"\n');
  const cache = privateTempdir();
  await addIn(dir, reg, cache, args(["lua"]), never, quiet);
  const toml = read(join(dir, CONFIG_FILE));
  const lock = read(join(dir, "happyview.lock"));
  reg.blobs.delete(rawCid(Buffer.from("c")));
  await failure(addIn(dir, reg, cache, args(["happyview.http"]), never, quiet));
  expect(read(join(dir, CONFIG_FILE))).toBe(toml);
  expect(read(join(dir, "happyview.lock"))).toBe(lock);
});

it("an_old_style_entry_is_refused_before_the_network", async () => {
  const reg = registry();
  const dir = project('[happyview]\nversion = "3.0.0"\n[interpreters]\nlua = "^1"\n');
  const cache = privateTempdir();
  const err = await failure(addIn(dir, reg, cache, args([]), never, quiet));
  expect(err.code).toBe(2);
  expect(err.message).toContain("interpreters.lua");
});
