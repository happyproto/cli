// commands/happyview/deploy.rs and project/deploy.rs tests.
import { expect, it } from "vitest";
import type { InstalledPlugin } from "../../src/atproto/admin.ts";
import { capabilitiesRecorded, capabilityLines } from "../../src/commands/deploy.ts";
import type { Failure } from "../../src/core/failure.ts";
import { projectUri, versionUri } from "../../src/plugin/validate.ts";
import {
  type PluginPlan,
  type PluginStep,
  planPlugins,
  stepText,
  type Target,
} from "../../src/project/deploy.ts";
import type { LockedPlugin } from "../../src/project/lock.ts";

// --- commands/happyview/deploy.rs

function target(id: string, capabilities: string[] | undefined, fresh: string[]): Target {
  return {
    id,
    did: "did:plc:pub",
    name: id,
    version: "1.0.0",
    capabilities,
    new_capabilities: fresh,
  };
}
const plan = (steps: PluginStep[]): PluginPlan => ({ steps, unchanged: [], kept: [] });
const refusal = (f: () => void): Failure => {
  try {
    f();
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected a refusal");
};

it("a_lock_recording_every_plugins_capabilities_is_accepted", () => {
  const p = plan([
    { kind: "install", target: target("lua", ["kv:read"], []) },
    { kind: "remove", id: "old" },
  ]);
  expect(() => capabilitiesRecorded(p)).not.toThrow();
});

it("a_lock_missing_them_is_refused_and_names_the_plugins", () => {
  const p = plan([
    { kind: "install", target: target("lua", undefined, []) },
    { kind: "move", target: target("std", undefined, []), from: "1.0.0" },
    { kind: "install", target: target("http", ["kv:read"], []) },
  ]);
  const err = refusal(() => capabilitiesRecorded(p));
  expect(err.code).toBe(2);
  const text = err.message;
  expect(text).toContain("lua");
  expect(text).toContain("std");
  expect(text).not.toContain("http");
  // On its own indented line, so a tester can see what to run without picking it out of a sentence.
  expect(text).toContain("\n\n    hpy happyview check\n\n");
  expect(text).toContain("commit the change");
});

it("a_removal_needs_no_capabilities", () => {
  expect(() => capabilitiesRecorded(plan([{ kind: "remove", id: "old" }]))).not.toThrow();
});

it("an_install_lists_what_it_grants", () => {
  expect(
    capabilityLines({ kind: "install", target: target("lua", ["kv:read", "database:write"], []) }),
  ).toEqual(["      capabilities: kv:read, database:write"]);
});

it("a_plugin_granting_nothing_says_so", () => {
  expect(capabilityLines({ kind: "install", target: target("plain", [], []) })).toEqual([
    "      capabilities: none",
  ]);
});

it("a_move_lists_the_new_ones_separately", () => {
  expect(
    capabilityLines({
      kind: "move",
      target: target("lua", ["kv:read", "database:write"], ["database:write"]),
      from: "1.0.0",
    }),
  ).toEqual(["      capabilities: kv:read, database:write", "      new: database:write"]);
});

it("a_removal_lists_nothing", () => {
  expect(capabilityLines({ kind: "remove", id: "old" })).toEqual([]);
});

// --- project/deploy.rs

const PUB = "did:plc:pub";

function locked(id: string, version: string, deps: string[]): LockedPlugin {
  return {
    id,
    kind: "interpreter",
    keys: [id],
    project: projectUri(PUB, id),
    version,
    channel: undefined,
    version_uri: versionUri(PUB, id, version),
    manifest_cid: "bafymanifest",
    package_cid: "bafypackage",
    manifest_blob_cid: "bafyblob",
    dependencies: deps,
    capabilities: ["kv:read"],
  };
}

function installed(id: string, from: [string, string] | null): InstalledPlugin {
  return {
    id,
    version: from ? from[1] : "0.0.0",
    plugin_type: "library",
    registry: from
      ? { did: from[0], name: id, version_uri: versionUri(from[0], id, from[1]) }
      : null,
    capabilities: { declared: [] },
  };
}

const ids = (p: PluginPlan) => p.steps.map(stepText);

it("a_plugin_at_the_locked_version_is_left_alone", () => {
  const p = planPlugins([locked("lua", "1.0.0", [])], [installed("lua", [PUB, "1.0.0"])], false);
  expect(p.steps).toEqual([]);
  expect(p.unchanged).toEqual(["lua"]);
});

it("missing_plugins_are_installed_after_what_they_depend_on", () => {
  const p = planPlugins(
    [
      locked("lua", "1.0.0", ["std"]),
      locked("std", "2.0.0", ["http"]),
      locked("http", "0.1.0", []),
    ],
    [],
    false,
  );
  expect(ids(p)).toEqual(["install http 0.1.0", "install std 2.0.0", "install lua 1.0.0"]);
});

it("another_version_of_the_same_project_is_moved", () => {
  const p = planPlugins([locked("lua", "1.1.0", [])], [installed("lua", [PUB, "1.0.0"])], false);
  expect(ids(p)).toEqual(["move lua 1.0.0 → 1.1.0"]);
});

it("a_fresh_install_carries_the_locked_capabilities", () => {
  const p = planPlugins([locked("lua", "1.0.0", [])], [], false);
  const s = p.steps[0];
  if (s?.kind !== "install") throw new Error(JSON.stringify(p.steps));
  expect(s.target.capabilities).toEqual(["kv:read"]);
  expect(s.target.new_capabilities).toEqual([]);
});

it("a_move_names_only_the_capabilities_the_installed_version_lacked", () => {
  const lock = locked("lua", "1.1.0", []);
  lock.capabilities = ["kv:read", "database:write"];
  const on = installed("lua", [PUB, "1.0.0"]);
  on.capabilities = { declared: [{ name: "kv:read" }] };
  const s = planPlugins([lock], [on], false).steps[0];
  if (s?.kind !== "move") throw new Error(JSON.stringify(s));
  expect(s.target.new_capabilities).toEqual(["database:write"]);
});

it("a_move_to_a_version_granting_no_more_has_nothing_new", () => {
  const on = installed("lua", [PUB, "1.0.0"]);
  on.capabilities = { declared: [{ name: "kv:read" }] };
  const s = planPlugins([locked("lua", "1.1.0", [])], [on], false).steps[0];
  if (s?.kind !== "move") throw new Error(JSON.stringify(s));
  expect(s.target.new_capabilities).toEqual([]);
});

it("an_unrecorded_lock_reaches_the_plan_as_unrecorded", () => {
  const lock = locked("lua", "1.0.0", []);
  lock.capabilities = undefined;
  const s = planPlugins([lock], [], false).steps[0];
  if (s?.kind !== "install") throw new Error(JSON.stringify(s));
  expect(s.target.capabilities).toBeUndefined();
});

it("a_plugin_from_elsewhere_is_replaced", () => {
  const p = planPlugins(
    [locked("lua", "1.0.0", []), locked("js", "1.0.0", [])],
    [installed("lua", null), installed("js", ["did:plc:someone-else", "1.0.0"])],
    false,
  );
  expect(ids(p)).toEqual([
    "replace js 1.0.0 (installed from did:plc:someone-else)",
    "replace lua 1.0.0 (installed from a URL)",
  ]);
});

it("plugins_not_in_the_lock_are_kept_unless_pruning", () => {
  const lock = [locked("lua", "1.0.0", [])];
  const on = [installed("lua", [PUB, "1.0.0"]), installed("old", [PUB, "1.0.0"])];
  let p = planPlugins(lock, on, false);
  expect(p.steps).toEqual([]);
  expect(p.kept).toEqual(["old"]);
  p = planPlugins(lock, on, true);
  expect(ids(p)).toEqual(["remove old"]);
  expect(p.kept).toEqual([]);
});

it("auth_plugins_are_not_the_projects_to_remove", () => {
  const auth = installed("passkeys", null);
  auth.plugin_type = "auth";
  const p = planPlugins([], [auth], true);
  expect(p.steps).toEqual([]);
  expect(p.kept).toEqual([]);
});
