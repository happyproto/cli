// hpy-project/src/config.rs tests.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Problem } from "../../src/plugin/problem.ts";
import {
  CONFIG_FILE,
  entryProjectUri,
  findRoot,
  Pin,
  type PluginEntry,
  ProjectToml,
  setPlugin,
  versionMatches,
  writeIfChanged,
} from "../../src/project/config.ts";

const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-project-config-"));
const unix = process.platform !== "win32";

function problem(f: () => unknown): Problem {
  try {
    f();
  } catch (e) {
    return e as Problem;
  }
  throw new Error("expected a problem");
}

it("dev_backfill_defaults_off", () => {
  expect(ProjectToml.parse("").dev.backfill).toBe(false);
  expect(ProjectToml.parse("[dev]\nbackfill = true\n").dev.backfill).toBe(true);
});

const HV = "did:plc:happyview";

const PROJECT = `# The registry's own instance.
[happyview]
version = "3.0.0" # pinned for the workshop

[instance]
app_name = "HappyProto Registry"

[interpreters]
lua = { did = "did:plc:happyview", name = "happyview-lua", channel = "latest" } # the language most handlers use
typescript = { did = "did:plc:happyview", name = "happyview-ts", version = "0.2.0" }

[libraries]
"happyview.record" = { did = "did:plc:happyview", name = "happyview-record", channel = "beta" }
`;

const entry = (name: string, pin: Pin): PluginEntry => ({ did: HV, name, pin });

it("reads_the_slice_hpy_owns_and_ignores_the_rest", () => {
  const cfg = ProjectToml.parse(PROJECT);
  expect(cfg.happyviewVersion()).toBe("3.0.0");
  const reqs = cfg.requirements().map((r) => [r.kind, r.key, r.entry]);
  expect(reqs).toEqual([
    ["interpreter", "lua", entry("happyview-lua", Pin.channel("latest"))],
    ["interpreter", "typescript", entry("happyview-ts", Pin.version("0.2.0"))],
    ["library", "happyview.record", entry("happyview-record", Pin.channel("beta"))],
  ]);
  expect(entryProjectUri(cfg.interpreters.get("lua")!)).toBe(
    "at://did:plc:happyview/software.release.project/happyview-lua",
  );
});

const refusal = (e: string) => problem(() => ProjectToml.parse(`[interpreters]\nlua = ${e}\n`));

it("a_bare_version_string_is_refused_naming_the_table_form", () => {
  const err = refusal('"^1"');
  expect(err.path).toBe("interpreters.lua");
  expect(err.problem).toContain("software.release");
  expect(err.problem).toContain("did = ");
  expect(err.problem).toContain('channel = "latest"');
});

it("an_entry_needs_exactly_one_of_channel_and_version", () => {
  const both = refusal(
    '{ did = "did:plc:happyview", name = "happyview-lua", channel = "latest", version = "1.0.0" }',
  );
  expect(both.path).toBe("interpreters.lua");
  expect(both.problem).toContain("both");
  const neither = refusal('{ did = "did:plc:happyview", name = "happyview-lua" }');
  expect(neither.path).toBe("interpreters.lua");
  expect(neither.problem).toContain("channel");
  expect(neither.problem).toContain("version");
});

it("an_entry_is_checked_field_by_field", () => {
  for (const [e, needle] of [
    ['{ name = "x", channel = "latest" }', "needs `did`"],
    ['{ did = "alice.test", name = "x", channel = "latest" }', "not a DID"],
    ['{ did = "did:plc:a", channel = "latest" }', "needs `name`"],
    ['{ did = "did:plc:a", name = "X", channel = "latest" }', "not a project name"],
    ['{ did = "did:plc:a", name = "x", channel = "stable" }', "not one of"],
    ['{ did = "did:plc:a", name = "x", version = "^1" }', "`version`"],
    ['{ did = "did:plc:a", name = "x", channel = "latest", chanel = "beta" }', "chanel"],
    ["3", "must be a table"],
  ] as const) {
    const err = refusal(e);
    expect(err.path, e).toBe("interpreters.lua");
    expect(err.problem, e).toContain(needle);
  }
});

it("a_full_happyview_file_loads_and_hpys_own_edits_stay_valid", () => {
  const FULL = `
[happyview]
version = "3.0.0"

[instance]
app_name = "Games"
superadmin = "did:plc:abc123"

[dev]
port = 3000
backfill = true

[interpreters]
lua = { did = "did:plc:happyview", name = "happyview-lua", channel = "latest" }

[libraries]
"happyview.record" = { did = "did:plc:happyview", name = "happyview-record", version = "2.1.0" }

[network_lexicons]
include = ["app.bsky.feed.post"]

[labels]
subscribe = ["did:plc:labeler"]

[jetstream]
protocol = "v2"
compression = true

[lexicons."com.example.getThing"]
backfill = true
token_cost = 2

[scripts."xrpc.query:com.example.getThing"]
description = "reads a thing"

[modules.shared]
language = "lua"
path = "modules/shared"
`;
  const cfg = ProjectToml.parse(FULL);
  expect(cfg.happyviewVersion()).toBe("3.0.0");
  expect(cfg.requirements()).toHaveLength(2);

  // The edit must leave every table it did not touch intact.
  const http = entry("happyview-http", Pin.version("1.0.3"));
  const edited = setPlugin(FULL, "library", "happyview.http", http);
  expect(edited).toContain("[modules.shared]");
  const again = ProjectToml.parse(edited);
  expect(again.libraries.get("happyview.http")).toEqual(http);
  expect(again.interpreters.get("lua")).toEqual(entry("happyview-lua", Pin.channel("latest")));
});

it("a_missing_version_says_how_to_pin_one", () => {
  const err = problem(() => ProjectToml.parse("[dev]\nbackfill = true\n").happyviewVersion());
  expect(err.path).toBe("happyview.version");
  expect(err.problem).toContain("[happyview]");
});

it("set_plugin_keeps_comments_order_and_trailing_comments", () => {
  const pinned = entry("happyview-lua", Pin.version("1.5.0"));
  const out = setPlugin(PROJECT, "interpreter", "lua", pinned);
  expect(out).toContain(
    'lua = { did = "did:plc:happyview", name = "happyview-lua", version = "1.5.0" } # the language most handlers use',
  );
  expect(out.startsWith("# The registry's own instance.")).toBe(true);
  expect(out).toContain('version = "3.0.0" # pinned for the workshop');
  expect(out.indexOf("lua =")).toBeLessThan(out.indexOf("typescript ="));
  expect(ProjectToml.parse(out).interpreters.get("lua")).toEqual(pinned);
});

it("set_plugin_quotes_dotted_keys_and_creates_the_table", () => {
  const http = entry("happyview-http", Pin.channel("latest"));
  const out = setPlugin('[happyview]\nversion = "3.0.0"\n', "library", "happyview.http", http);
  expect(out).toContain(
    '[libraries]\n"happyview.http" = { did = "did:plc:happyview", name = "happyview-http", channel = "latest" }',
  );
  expect(ProjectToml.parse(out).libraries.get("happyview.http")).toEqual(http);
});

it("set_plugin_refuses_a_table_that_is_not_one", () => {
  const lua = entry("happyview-lua", Pin.channel("latest"));
  const err = problem(() => setPlugin("interpreters = 3\n", "interpreter", "lua", lua));
  expect(err.path).toBe("interpreters");
});

it("set_plugin_refuses_what_happyview_would_refuse", () => {
  const e = entry("x", Pin.channel("latest"));
  for (const key of ["Lua", "1lua", "", "lua.x", "lu a"]) {
    const err = problem(() => setPlugin("", "interpreter", key, e));
    expect(err.path).toBe(`interpreters.${key}`);
    expect(err.problem).toContain("lowercase");
  }
  expect(() => setPlugin("", "interpreter", "type-script_2", e)).not.toThrow();
  expect(() => setPlugin("", "library", " ", e)).toThrow();
  expect(() => setPlugin("", "library", "Happyview.Http", e)).not.toThrow();
});

it("find_root_walks_up", () => {
  const dir = tempdir();
  writeFileSync(join(dir, CONFIG_FILE), "");
  const deep = join(dir, "src/lexicons/com/example");
  mkdirSync(deep, { recursive: true });
  expect(findRoot(deep)).toBe(dir);
  expect(findRoot(tempdir())).toBeUndefined();
});

it("version_matching_is_cargo_flavoured", () => {
  expect(versionMatches("1.4.0", "1.9.2")).toBe(true);
  expect(versionMatches("1.4.0", "2.0.0")).toBe(false);
  expect(versionMatches("=1.4.0", "1.4.0")).toBe(true);
  expect(versionMatches("*", "1.2.0")).toBe(true);
  expect(versionMatches("*", "0.1.0-alpha.3")).toBe(false);
  expect(versionMatches(">=3.0.0", "3.0.0-alpha.10")).toBe(false);
  expect(versionMatches("^1.3.0-alpha", "1.3.0-alpha.1")).toBe(true);
  expect(versionMatches("0.1.0-alpha.3", "0.1.0-alpha.3")).toBe(true);
  expect(versionMatches("not a range", "1.0.0")).toBe(false);
  expect(versionMatches("1", "not a version")).toBe(false);
});

const names = (dir: string) => readdirSync(dir).sort();

it("write_if_changed_replaces_and_skips_identical_text", () => {
  const dir = tempdir();
  const path = join(dir, CONFIG_FILE);
  expect(writeIfChanged(path, "a = 1\n")).toBe(true);
  expect(writeIfChanged(path, "a = 1\n")).toBe(false);
  expect(writeIfChanged(path, "a = 2\n")).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("a = 2\n");
  expect(names(dir), "no temporary file is left behind").toEqual([CONFIG_FILE]);
});

it.skipIf(!unix)("write_if_changed_writes_through_a_link_and_keeps_the_mode", () => {
  const dir = tempdir();
  const shared = join(dir, "dotfiles");
  mkdirSync(shared);
  const real = join(shared, "real.toml");
  writeFileSync(real, "a = 1\n");
  chmodSync(real, 0o600);
  const project = join(dir, "project");
  mkdirSync(project);
  const path = join(project, CONFIG_FILE);
  symlinkSync("../dotfiles/real.toml", path);

  expect(writeIfChanged(path, "a = 2\n")).toBe(true);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, "utf8")).toBe("a = 2\n");
  expect(statSync(real).mode & 0o777).toBe(0o600);
  expect(names(shared)).toEqual(["real.toml"]);
  expect(names(project)).toEqual([CONFIG_FILE]);

  rmSync(real);
  let err: Error | undefined;
  try {
    writeIfChanged(path, "a = 3\n");
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toContain("does not exist");
  expect(names(shared)).toEqual([]);
});

it("write_if_changed_leaves_no_temporary_file_when_it_fails", () => {
  const dir = tempdir();
  // A directory at the name: the temporary file is written, and the rename onto it fails.
  const path = join(dir, CONFIG_FILE);
  mkdirSync(path);
  expect(() => writeIfChanged(path, "a = 1\n")).toThrow();
  expect(names(dir)).toEqual([CONFIG_FILE]);
  expect(statSync(path).isDirectory()).toBe(true);
});
