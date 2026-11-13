// crates/hpy/src/project/resolve.rs tests.
import { expect, it } from "vitest";
import { Failure } from "../../src/core/failure.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import { projectUri } from "../../src/plugin/validate.ts";
import { ProjectToml } from "../../src/project/config.ts";
import { Lockfile } from "../../src/project/lock.ts";
import { candidates, type Resolver, resolveLock } from "../../src/project/resolve.ts";
import { interpreterExt, libraryExt, RegistryFixture } from "../support/fakes.ts";

const HV = "did:plc:happyview";
const OTHER = "did:plc:someoneelse";

function toml(body: string): ProjectToml {
  return ProjectToml.parse(`[happyview]\nversion = "3.0.0-alpha.12"\n${body}`);
}

/** `key = { did = HV, name, <pin> }` in `table`. */
function entry(table: string, key: string, name: string, pin: string): string {
  return `[${table}]\n${key} = { did = "${HV}", name = "${name}", ${pin} }\n`;
}

function resolve(reg: RegistryFixture, cfg: ProjectToml, prev?: Lockfile): Promise<Lockfile> {
  return resolveLock({ registry: reg, warn: () => {} }, cfg, prev);
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

function registry(): RegistryFixture {
  const reg = new RegistryFixture();
  for (const [v, wasm] of [
    ["1.4.0", "lua140"],
    ["1.4.2", "lua142"],
    ["2.0.0", "lua200"],
  ] as const) {
    reg.publish(HV, "happyview-lua", v, interpreterExt("lua", "lua"), {}, wasm);
  }
  reg.publish(HV, "happyview-db", "0.1.0", libraryExt("happyview.db"), {}, "db010");
  reg.publish(
    HV,
    "happyview-record",
    "2.1.0",
    libraryExt("happyview.record"),
    { [projectUri(HV, "happyview-db")]: "^0.1" },
    "record210",
  );
  return reg;
}

function collecting(reg: RegistryFixture): [Resolver, string[]] {
  const warnings: string[] = [];
  return [{ registry: reg, warn: (m) => warnings.push(m) }, warnings];
}

it("a_channel_and_a_version_resolve_with_dependencies", async () => {
  const reg = registry();
  const cfg = toml(
    entry("interpreters", "lua", "happyview-lua", 'channel = "latest"') +
      entry("libraries", '"happyview.record"', "happyview-record", 'version = "2.1.0"'),
  );
  const lock = await resolve(reg, cfg);
  expect(lock.happyview.version).toBe("3.0.0-alpha.12");
  const lua = lock.findKey("interpreter", "lua")!;
  expect([lua.id, lua.version]).toEqual(["happyview-lua", "2.0.0"]);
  expect(lua.package_cid).toBe(rawCid(new TextEncoder().encode("lua200")));
  expect(lua.project).toBe(projectUri(HV, "happyview-lua"));
  const view = reg.find(HV, "happyview-lua", "2.0.0")!;
  expect(lua.version_uri).toBe(view.uri);
  expect(lua.manifest_cid).toBe(view.manifest.cid);
  const artifact = view.artifact as { manifest: { ref: { $link: string } } };
  expect(lua.manifest_blob_cid).toBe(artifact.manifest.ref.$link);
  // What the published artifact declares, recorded so a deploy accepts the set that was
  // resolved rather than the one served later.
  expect(lua.capabilities).toEqual(["script:host"]);
  const record = lock.findKey("library", "happyview.record")!;
  expect(record.dependencies).toEqual(["happyview-db"]);
  const db = lock.plugins.find((p) => p.id === "happyview-db")!;
  expect(db.keys).toEqual([]);
  expect(db.version).toBe("0.1.0");
  // Recorded as declaring none, which a deploy can accept; distinct from a lock that never
  // recorded them, which it refuses.
  expect(db.capabilities).toEqual([]);
  // The lock it writes reads back.
  Lockfile.parse(lock.render());
});

it("a_channel_that_points_at_an_uninstallable_version_is_refused", async () => {
  const reg = registry();
  reg.retire(HV, "happyview-lua", "2.0.0");
  reg.setChannel(HV, "happyview-lua", "latest", "2.0.0");
  const cfg = toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"'));
  const err = await failure(resolve(reg, cfg));
  expect(err.code).toBe(2);
  expect(err.message).toContain("2.0.0");
  expect(err.message).toContain("unavailable");
  expect(err.message).toContain("withdrawn by its publisher");
});

it("a_pinned_version_that_is_not_installable_warns_but_resolves", async () => {
  const reg = registry();
  reg.retire(HV, "happyview-lua", "1.4.0");
  const cfg = toml(entry("interpreters", "lua", "happyview-lua", 'version = "1.4.0"'));
  const [r, warnings] = collecting(reg);
  const lock = await resolveLock(r, cfg, undefined);
  expect(lock.plugins[0]!.version).toBe("1.4.0");
  expect(warnings.some((w) => w.includes("1.4.0") && w.includes("unavailable"))).toBe(true);
});

it("a_missing_channel_or_version_is_named", async () => {
  const reg = registry();
  let err = await failure(
    resolve(reg, toml(entry("interpreters", "lua", "happyview-lua", 'channel = "beta"'))),
  );
  expect(err.message).toContain("no beta channel");
  err = await failure(
    resolve(reg, toml(entry("interpreters", "lua", "happyview-lua", 'version = "9.0.0"'))),
  );
  expect(err.message).toContain("9.0.0");
});

it("a_locked_version_is_kept_while_the_channel_moves_on", async () => {
  const reg = new RegistryFixture();
  reg.publish(HV, "happyview-lua", "1.4.0", interpreterExt("lua", "lua"), {}, "a");
  const cfg = toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"'));
  const first = await resolve(reg, cfg);
  reg.publish(HV, "happyview-lua", "1.5.0", interpreterExt("lua", "lua"), {}, "b");
  const again = await resolve(reg, cfg, first);
  expect(again.plugins[0]!.version).toBe("1.4.0");
  const fresh = await resolve(reg, cfg);
  expect(fresh.plugins[0]!.version).toBe("1.5.0");
});

it("the_lock_records_the_channel_each_entry_follows", async () => {
  const reg = registry();
  const cfg = toml(
    entry("interpreters", "lua", "happyview-lua", 'channel = "latest"') +
      entry("libraries", '"happyview.record"', "happyview-record", 'version = "2.1.0"'),
  );
  const lock = await resolve(reg, cfg);
  const channel = (id: string) => lock.plugins.find((p) => p.id === id)!.channel;
  expect(channel("happyview-lua")).toBe("latest");
  expect(channel("happyview-record")).toBeUndefined();
  expect(channel("happyview-db")).toBeUndefined();
  expect(lock.drift(cfg)).toEqual([]);
});

it("a_locked_version_from_another_channel_is_not_kept", async () => {
  const reg = registry();
  reg.publish(HV, "happyview-lua", "2.1.0-beta.1", interpreterExt("lua", "lua"), {}, "beta");
  const latest = toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"'));
  const first = await resolve(reg, latest);
  const beta = toml(entry("interpreters", "lua", "happyview-lua", 'channel = "beta"'));
  expect(first.drift(beta)).not.toEqual([]);
  const moved = await resolve(reg, beta, first);
  expect(moved.plugins[0]!.version).toBe("2.1.0-beta.1");
  expect(moved.plugins[0]!.channel).toBe("beta");
});

it("a_kept_locked_version_that_is_no_longer_installable_warns", async () => {
  const reg = registry();
  const cfg = toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"'));
  const first = await resolve(reg, cfg);
  reg.retire(HV, "happyview-lua", "2.0.0");
  const [r, warnings] = collecting(reg);
  const lock = await resolveLock(r, cfg, first);
  expect(lock.plugins[0]!.version).toBe("2.0.0");
  expect(warnings.some((w) => w.includes("2.0.0") && w.includes("unavailable"))).toBe(true);
});

it("a_locked_version_whose_manifest_changed_is_refused", async () => {
  const reg = registry();
  const cfg = toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"'));
  const prev = await resolve(reg, cfg);
  prev.plugins[0]!.manifest_cid = "bafyreisomethingelse";
  const err = await failure(resolve(reg, cfg, prev));
  expect(err.message).toContain(
    "the registry's happyview-lua 2.0.0 no longer matches happyview.lock",
  );
});

it("a_dependency_takes_the_highest_installable_version_in_range", async () => {
  const reg = registry();
  reg.publish(HV, "happyview-db", "0.1.5", libraryExt("happyview.db"), {}, "db015");
  reg.publish(HV, "happyview-db", "0.1.7", libraryExt("happyview.db"), {}, "db017");
  reg.publish(HV, "happyview-db", "0.2.0", libraryExt("happyview.db"), {}, "db020");
  reg.retire(HV, "happyview-db", "0.1.7");
  const cfg = toml(
    entry("libraries", '"happyview.record"', "happyview-record", 'channel = "latest"'),
  );
  const lock = await resolve(reg, cfg);
  expect(lock.plugins.find((p) => p.id === "happyview-db")!.version).toBe("0.1.5");
});

it("a_dependency_nothing_needs_any_more_is_dropped", async () => {
  const reg = registry();
  const withIt = await resolve(
    reg,
    toml(entry("libraries", '"happyview.record"', "happyview-record", 'channel = "latest"')),
  );
  expect(withIt.plugins.length).toBe(2);
  const without = await resolve(
    reg,
    toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"')),
    withIt,
  );
  expect(without.plugins.map((p) => p.id)).toEqual(["happyview-lua"]);
});

it("a_pin_a_requirement_refuses_names_both", async () => {
  const reg = registry();
  reg.publish(HV, "happyview-db", "0.2.0", libraryExt("happyview.db"), {}, "db020");
  const cfg = toml(
    `[libraries]\n"happyview.record" = { did = "${HV}", name = "happyview-record", channel = "latest" }\n` +
      `"happyview.db" = { did = "${HV}", name = "happyview-db", version = "0.2.0" }\n`,
  );
  const err = await failure(resolve(reg, cfg));
  expect(err.code).toBe(2);
  expect(err.message).toBe(
    "no version of happyview-db satisfies every requirement: " +
      "happyview.toml pins happyview-db version 0.2.0; happyview-record@2.1.0 needs happyview-db ^0.1\n" +
      "an older version of `happyview-record` may ask for less; " +
      "naming one in happyview.toml may settle this",
  );
});

it("a_repick_withdraws_its_old_requirements", async () => {
  const cUri = projectUri(HV, "c");
  const aUri = projectUri(HV, "a");
  const reg = new RegistryFixture();
  reg.publish(HV, "c", "1.0.0", libraryExt("c"), {}, "c1");
  reg.publish(HV, "c", "2.0.0", libraryExt("c"), {}, "c2");
  reg.publish(HV, "a", "1.0.0", libraryExt("a"), { [cUri]: "^1" }, "a1");
  reg.publish(HV, "a", "2.0.0", libraryExt("a"), { [cUri]: "^2" }, "a2");
  reg.publish(HV, "x", "1.0.0", libraryExt("x"), { [aUri]: "^1" }, "x1");
  reg.publish(HV, "y", "1.0.0", libraryExt("y"), { [aUri]: "*" }, "y1");

  // `y` asks for any `a`, which picks 2 and asks for `c ^2`; then `x` forces `a` back to 1,
  // whose `c ^1` must replace that request.
  const cfg = toml(
    `[libraries]\ny = { did = "${HV}", name = "y", channel = "latest" }\n` +
      `x = { did = "${HV}", name = "x", channel = "latest" }\n`,
  );
  const lock = await resolve(reg, cfg);
  expect(lock.plugins.map((p) => [p.id, p.version])).toEqual([
    ["a", "1.0.0"],
    ["c", "1.0.0"],
    ["x", "1.0.0"],
    ["y", "1.0.0"],
  ]);
});

it("a_release_must_be_the_kind_and_answer_the_key_it_was_named_for", async () => {
  const reg = registry();
  reg.publish(OTHER, "js", "1.0.0", interpreterExt("js", "js"), {}, "js");
  const library = await failure(
    resolve(reg, toml(entry("interpreters", "lua", "happyview-db", 'channel = "latest"'))),
  );
  expect(library.message).toBe(
    "happyview-db@0.1.0 is a library plugin, but it is wanted as an interpreter",
  );
  const otherLanguage = await failure(
    resolve(
      reg,
      toml(`[interpreters]\nlua = { did = "${OTHER}", name = "js", channel = "latest" }\n`),
    ),
  );
  expect(otherLanguage.message).toBe(
    "js@1.0.0 does not answer to `lua`, which happyview.toml names it by",
  );
});

it("only_prereleases_suggests_pinning_a_channel", async () => {
  const reg = new RegistryFixture();
  reg.publish(HV, "a", "1.0.0", libraryExt("a"), { [projectUri(HV, "b")]: "*" }, "a");
  for (const v of ["0.1.0-alpha.1", "0.1.0-alpha.3"]) {
    reg.publish(HV, "b", v, libraryExt("b"), {}, v);
  }
  const err = await failure(resolve(reg, toml(entry("libraries", "a", "a", 'channel = "latest"'))));
  expect(err.message).toBe(
    "no version of b satisfies every requirement: a@1.0.0 needs b *\n" +
      "an older version of `a` may ask for less; naming one in happyview.toml may settle this\n" +
      'b has only prereleases, which a range matches only when it names one, as "^0.1.0-alpha.3" does',
  );
});

it("an_interpreter_without_file_extensions_is_refused", async () => {
  const reg = new RegistryFixture();
  reg.publish(
    HV,
    "happyview-lua",
    "0.1.0",
    { pluginType: "interpreter", apiVersion: "2", languageId: "lua", capabilities: [] },
    {},
    "old",
  );
  const err = await failure(
    resolve(reg, toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"'))),
  );
  expect(err.message).toContain("no file extensions");
});

it("an_unmet_happyview_requirement_warns_rather_than_refusing", async () => {
  const reg = new RegistryFixture();
  reg.publish(
    HV,
    "happyview-lua",
    "1.0.0",
    interpreterExt("lua", "lua"),
    { "env:happyview": ">=3.0.0" },
    "lua",
  );
  const [r, warnings] = collecting(reg);
  await resolveLock(
    r,
    toml(entry("interpreters", "lua", "happyview-lua", 'channel = "latest"')),
    undefined,
  );
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain(">=3.0.0");
  expect(warnings[0]).toContain("3.0.0-alpha.12");
});

it("two_projects_with_one_name_are_refused", async () => {
  const reg = registry();
  reg.publish(OTHER, "happyview-db", "0.1.0", libraryExt("other.db"), {}, "x");
  const cfg = toml(
    `[libraries]\n"happyview.record" = { did = "${HV}", name = "happyview-record", channel = "latest" }\n` +
      `"other.db" = { did = "${OTHER}", name = "happyview-db", channel = "latest" }\n`,
  );
  const err = await failure(resolve(reg, cfg));
  expect(err.message).toContain("by id");
});

it("two_keys_pinning_one_project_differently_are_refused", async () => {
  const reg = registry();
  const cfg = toml(
    `[libraries]\none = { did = "${HV}", name = "happyview-db", channel = "latest" }\n` +
      `two = { did = "${HV}", name = "happyview-db", version = "0.1.0" }\n`,
  );
  const err = await failure(resolve(reg, cfg));
  expect(err.code).toBe(2);
  expect(err.message).toContain("`one`");
  expect(err.message).toContain("`two`");
});

it("candidates_follow_each_projects_newest_channel", async () => {
  const reg = registry();
  reg.publish(HV, "happyview-js", "0.1.0-alpha.2", interpreterExt("javascript", "js"), {}, "js");
  const found = await candidates(reg, "interpreter");
  expect(found.map((c) => [c.name, c.channel, c.version])).toEqual([
    ["happyview-lua", "latest", "2.0.0"],
    ["happyview-js", "alpha", "0.1.0-alpha.2"],
  ]);
  expect(found[0]!.answers("interpreter", "lua")).toBe(true);
  expect(found[1]!.key("interpreter")).toBe("javascript");
});

it("resolution_is_deterministic", async () => {
  const cfg = toml(
    entry("interpreters", "lua", "happyview-lua", 'channel = "latest"') +
      entry("libraries", '"happyview.record"', "happyview-record", 'channel = "latest"'),
  );
  const first = (await resolve(registry(), cfg)).render();
  expect((await resolve(registry(), cfg)).render()).toBe(first);
});
