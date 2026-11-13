// crates/hpy/src/commands/status.rs tests.
import { expect, it } from "vitest";
import type { Availability, State, VersionView } from "../../src/atproto/registry.ts";
import type { StoredRecord } from "../../src/atproto/repo.ts";
import { report, rows, versionOf } from "../../src/commands/status.ts";
import { versionView } from "../support/fakes.ts";

it("version_of_splits_at_the_first_dot_and_ignores_colon_keys", () => {
  const uri = (k: string) => `at://did:plc:x/software.release.version/${k}`;
  expect(versionOf("lua", uri("lua.1.0.0-alpha.4"))).toBe("1.0.0-alpha.4");
  expect(versionOf("lua", uri("lua:1.0.0"))).toBeUndefined();
});

const mine = (v: string): StoredRecord => ({
  uri: `at://did:plc:x/software.release.version/p.${v}`,
  cid: null,
  value: {},
});

function view(v: string, availability: Availability, state: State, installable: boolean) {
  const out: VersionView = versionView("did:plc:x", "p", v, {});
  out.availability = availability;
  out.lifecycle.state = state;
  out.lifecycle.installable = installable;
  return out;
}

it("merges_and_sorts", () => {
  const got = rows(
    "p",
    [mine("1.10.0"), mine("1.9.0"), mine("2.0.0-rc.1")],
    [
      view("1.9.0", "available", "deprecated", true),
      view("1.8.0", "deletedAtSource", "retired", false),
    ],
  ).map((r) => [r.version, r.availability, r.state, r.installable, r.inRepo]);
  expect(got).toEqual([
    ["2.0.0-rc.1", "not indexed", "active", false, true],
    ["1.10.0", "not indexed", "active", false, true],
    ["1.9.0", "available", "deprecated", true, true],
    ["1.8.0", "deletedAtSource", "retired", false, false],
  ]);
});

it("other_projects_are_ignored_and_an_unreachable_registry_is_marked", () => {
  const other: StoredRecord = {
    uri: "at://did:plc:x/software.release.version/q:1.0.0",
    cid: null,
    value: {},
  };
  const rs = rows("p", [mine("1.0.0"), other], { error: new Error("down") });
  expect(rs).toHaveLength(1);
  expect(rs[0]!.availability).toBe("unknown");
});

it("the_json_names_what_the_publish_action_reads", () => {
  const rs = rows("p", [mine("1.2.0")], [view("1.2.0", "pending", "active", true)]);
  expect(report("p", "at://did:plc:x/software.release.project/p", rs)).toEqual({
    name: "p",
    project: "at://did:plc:x/software.release.project/p",
    versions: [
      {
        version: "1.2.0",
        availability: "pending",
        state: "active",
        installable: true,
        inRepo: true,
      },
    ],
  });
  expect((report("p", undefined, []) as { project: unknown }).project).toBeNull();
});
