// hpy-project/src/lock.rs tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Problem } from "../../src/plugin/problem.ts";
import { type PluginKind, ProjectToml } from "../../src/project/config.ts";
import { LOCK_VERSION, type LockedPlugin, Lockfile } from "../../src/project/lock.ts";

const DID = "did:plc:abc";

function plugin(id: string, kind: PluginKind, keys: string[], version: string): LockedPlugin {
  return {
    id,
    kind,
    keys: [...keys],
    project: `at://${DID}/software.release.project/${id}`,
    version,
    channel: keys.length > 0 ? "latest" : undefined,
    version_uri: `at://${DID}/software.release.version/${id}.${version}`,
    manifest_cid: "bafyreimanifest",
    package_cid: "bafkreipackage",
    manifest_blob_cid: "bafkreimanifestblob",
    dependencies: [],
    capabilities: [],
  };
}

function lock(): Lockfile {
  return new Lockfile({
    version: LOCK_VERSION,
    happyview: { version: "3.0.0" },
    plugins: [
      plugin("happyview-lua", "interpreter", ["lua"], "1.4.2"),
      plugin("happyview-http", "library", [], "1.0.3"),
    ],
  });
}

function problem(f: () => unknown): Problem {
  try {
    f();
  } catch (e) {
    return e as Problem;
  }
  throw new Error("expected a problem");
}

it("renders_sorted_with_a_header_and_round_trips", () => {
  const text = lock().render();
  expect(text.startsWith("# Written by hpy")).toBe(true);
  expect(text.indexOf("happyview-http")).toBeLessThan(text.indexOf("happyview-lua"));
  expect(text).toContain("[[plugin]]");
  const back = Lockfile.parse(text);
  const reversed = lock();
  reversed.plugins.reverse();
  expect(back).toEqual(reversed);
  expect(back.findKey("interpreter", "lua")?.version).toBe("1.4.2");
  expect(back.findKey("library", "lua")).toBeUndefined();
});

it("a_lock_without_recorded_capabilities_parses_as_unrecorded", () => {
  const text = lock()
    .render()
    .split("\n")
    .filter((l, i, all) => i < all.length - 1 || l !== "")
    .filter((l) => !l.startsWith("capabilities"))
    .map((l) => `${l}\n`)
    .join("");
  expect(text).not.toContain("capabilities");
  const back = Lockfile.parse(text);
  expect(back.plugins.every((p) => p.capabilities === undefined)).toBe(true);
});

it("recorded_capabilities_round_trip", () => {
  const l = lock();
  l.plugins[0]!.capabilities = ["database:write", "kv:read"];
  const back = Lockfile.parse(l.render());
  const p = back.plugins.find((p) => p.id === l.plugins[0]!.id)!;
  expect(p.capabilities).toEqual(["database:write", "kv:read"]);
});

it("a_lock_recording_capabilities_has_none_unrecorded", () => {
  expect(lock().unrecordedCapabilities()).toEqual([]);
});

it("unrecorded_capabilities_names_only_the_plugins_missing_them", () => {
  const l = lock();
  l.plugins[0]!.capabilities = undefined;
  expect(l.unrecordedCapabilities()).toEqual([l.plugins[0]!.id]);
});

it("a_lock_from_before_the_registry_moved_says_to_delete_it", () => {
  const old =
    'version = 1\n[happyview]\nversion = "3.0.0"\n[[plugin]]\nid = "x"\nkind = "library"\npackage = "at://did:plc:a/at.happyproto.plugin.profile/x"\nversion = "1.0.0"\nchecksum = "bciq"\n';
  expect(problem(() => Lockfile.parse(old)).toString()).toBe(
    "happyview.lock predates the software.release registry; delete it and run hpy happyview check",
  );
});

it("a_newer_format_is_refused", () => {
  const err = problem(() => Lockfile.parse('version = 3\n[happyview]\nversion = "3.0.0"\n'));
  expect(err.problem).toContain("upgrade hpy");
});

it("a_future_format_of_another_shape_still_says_to_upgrade", () => {
  const err = problem(() => Lockfile.parse('version = 3\n[[package]]\nname = "x"\n'));
  expect(err.problem).toContain("upgrade hpy");
});

it("version_zero_is_refused", () => {
  const err = problem(() => Lockfile.parse('version = 0\n[happyview]\nversion = "3.0.0"\n'));
  expect(err.problem).toContain("upgrade hpy");
});

function parseWith(edit: (l: Lockfile) => void): Problem {
  const l = lock();
  edit(l);
  return problem(() => Lockfile.parse(l.render()));
}

it("a_cid_that_is_not_one_names_the_entry", () => {
  for (const field of ["manifest_cid", "package_cid", "manifest_blob_cid"] as const) {
    const e = parseWith((l) => {
      const p = l.plugins[0]!;
      if (field === "manifest_cid") p.manifest_cid = "";
      else if (field === "package_cid") p.package_cid = "sha256:abc";
      else p.manifest_blob_cid = "bciqNOTACID";
    });
    expect(e.path.includes("plugin[") && e.path.endsWith(`.${field}`), String(e)).toBe(true);
    expect(e.problem).toContain("happyview-lua");
  }
});

it("a_project_must_be_a_project_uri_and_match_the_version_uri", () => {
  let e = parseWith((l) => {
    l.plugins[0]!.project = "at://did:plc:abc/at.happyproto.plugin.profile/happyview-lua";
  });
  expect(e.path.endsWith("plugin[1].project"), String(e)).toBe(true);
  e = parseWith((l) => {
    l.plugins[0]!.project = "https://example.com/x";
  });
  expect(e.path.endsWith("plugin[1].project"), String(e)).toBe(true);
  e = parseWith((l) => {
    l.plugins[0]!.version_uri = "at://did:plc:abc/software.release.version/happyview-lua.9.9.9";
  });
  expect(e.path.endsWith("plugin[1].version_uri"), String(e)).toBe(true);
});

it("duplicate_ids_are_refused", () => {
  const e = parseWith((l) => {
    l.plugins[1] = plugin("happyview-lua", "library", [], "1.0.3");
  });
  expect(e.problem).toContain("more than once");
});

it("a_dangling_dependency_is_refused", () => {
  const e = parseWith((l) => {
    l.plugins[0]!.dependencies = ["ghost"];
  });
  expect(e.path.endsWith(".dependencies"), String(e)).toBe(true);
  expect(e.problem).toContain("ghost");
  const l = lock();
  l.plugins[0]!.dependencies = ["happyview-http"];
  expect(() => Lockfile.parse(l.render())).not.toThrow();
});

it("garbage_and_missing_tables_are_problems_not_panics", () => {
  expect(() => Lockfile.parse("not toml {{")).toThrow();
  expect(() => Lockfile.parse("")).toThrow();
  expect(() => Lockfile.parse("version = 2\n")).toThrow();
});

it("render_is_pinned_byte_for_byte", () => {
  const l = lock();
  l.plugins[0]!.dependencies = ["happyview-http"];
  const expected = `# Written by hpy from happyview.toml. Commit it; don't edit it by hand.

version = 2

[happyview]
version = "3.0.0"

[[plugin]]
id = "happyview-http"
kind = "library"
keys = []
project = "at://did:plc:abc/software.release.project/happyview-http"
version = "1.0.3"
version_uri = "at://did:plc:abc/software.release.version/happyview-http.1.0.3"
manifest_cid = "bafyreimanifest"
package_cid = "bafkreipackage"
manifest_blob_cid = "bafkreimanifestblob"
dependencies = []
capabilities = []

[[plugin]]
id = "happyview-lua"
kind = "interpreter"
keys = ["lua"]
project = "at://did:plc:abc/software.release.project/happyview-lua"
version = "1.4.2"
channel = "latest"
version_uri = "at://did:plc:abc/software.release.version/happyview-lua.1.4.2"
manifest_cid = "bafyreimanifest"
package_cid = "bafkreipackage"
manifest_blob_cid = "bafkreimanifestblob"
dependencies = ["happyview-http"]
capabilities = []
`;
  expect(l.render()).toBe(expected);
});

it("write_then_load", () => {
  const dir = mkdtempSync(join(tmpdir(), "hpy-project-lock-"));
  expect(Lockfile.load(dir)).toBeNull();
  lock().write(dir);
  expect(Lockfile.load(dir)?.plugins).toHaveLength(2);
});

const toml = (body: string) => ProjectToml.parse(`[happyview]\nversion = "3.0.0"\n${body}`);

it("drift_is_empty_when_the_lock_describes_the_toml", () => {
  const channel = toml(
    '[interpreters]\nlua = { did = "did:plc:abc", name = "happyview-lua", channel = "latest" }\n',
  );
  expect(lock().drift(channel)).toEqual([]);
  const version = toml(
    '[interpreters]\nlua = { did = "did:plc:abc", name = "happyview-lua", version = "1.4.2" }\n',
  );
  const pinned = lock();
  pinned.plugins[0]!.channel = undefined;
  expect(pinned.drift(version)).toEqual([]);
});

it("a_changed_pin_is_drift", () => {
  const entry = (pin: string) =>
    toml(`[interpreters]\nlua = { did = "did:plc:abc", name = "happyview-lua", ${pin} }\n`);
  expect(lock().drift(entry('channel = "beta"'))).toEqual([
    "interpreter `lua` is locked from channel latest, but happyview.toml asks for channel beta",
  ]);
  expect(lock().drift(entry('version = "1.4.2"'))).toEqual([
    "interpreter `lua` is locked from channel latest, but happyview.toml asks for version 1.4.2",
  ]);
  const pinned = lock();
  pinned.plugins[0]!.channel = undefined;
  expect(pinned.drift(entry('channel = "latest"'))).toEqual([
    "interpreter `lua` is locked at version 1.4.2, but happyview.toml asks for channel latest",
  ]);
});

it("a_locked_channel_must_be_one_and_only_on_a_named_plugin", () => {
  // Rendered sorted by id, so happyview-lua is plugin[1].
  let e = parseWith((l) => {
    l.plugins[0]!.channel = "stable";
  });
  expect(e.path.endsWith("plugin[1].channel"), String(e)).toBe(true);
  e = parseWith((l) => {
    l.plugins[1]!.channel = "latest";
  });
  expect(e.path.endsWith("plugin[0].channel"), String(e)).toBe(true);
  expect(e.problem).toContain("happyview-http");
});

it("drift_names_every_difference", () => {
  const cfg = ProjectToml.parse(
    '[happyview]\nversion = "3.1.0"\n[interpreters]\n' +
      'lua = { did = "did:plc:abc", name = "happyview-lua", version = "2.0.0" }\n' +
      'typescript = { did = "did:plc:abc", name = "happyview-ts", channel = "latest" }\n' +
      "[libraries]\n" +
      '"happyview.http" = { did = "did:plc:other", name = "happyview-http", channel = "latest" }\n',
  );
  const stale = lock();
  stale.plugins[1]!.keys = ["happyview.http"];
  stale.plugins.push(plugin("old-lib", "library", ["old"], "1.0.0"));
  expect(stale.drift(cfg)).toEqual([
    "HappyView is locked at 3.0.0 but happyview.toml asks for 3.1.0",
    "interpreter `lua` is locked from channel latest, but happyview.toml asks for version 2.0.0",
    "interpreter `typescript` is not in the lock",
    "library `happyview.http` is locked to at://did:plc:abc/software.release.project/happyview-http, " +
      "but happyview.toml names at://did:plc:other/software.release.project/happyview-http",
    "library `old` is locked but no longer in happyview.toml",
  ]);
});
