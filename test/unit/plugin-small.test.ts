// hpy-plugin's problem.rs, checksum.rs and changelog.rs tests.
import { describe, expect, it } from "vitest";
import { changelogEntry } from "../../src/plugin/changelog.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import { Problem } from "../../src/plugin/problem.ts";

describe("problem.rs", () => {
  it("a_problem_without_a_path_prints_only_its_message", () => {
    expect(new Problem("a.b", "is wrong").toString()).toBe("a.b: is wrong");
    expect(new Problem("", "x is wrong").toString()).toBe("x is wrong");
  });
});

describe("checksum.rs", () => {
  it("hello_world_vector", () => {
    expect(rawCid(Buffer.from("hello world"))).toBe(
      "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e",
    );
  });
  it("wasm_header_vector", () => {
    expect(rawCid(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBe(
      "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy",
    );
  });
});

describe("changelog.rs", () => {
  // The shape semantic-release writes in the plugins repo.
  const PLUGINS = `## [1.1.0](https://github.com/happyproto/plugins/releases/tag/happyview-lua-v1.1.0) (2026-10-10)

- **Library calls can run together.** The new \`internal.async\` module.
- **Tracebacks name the library bridge.** It's labelled \`[library bridge]\` now.

## [1.0.0](https://github.com/happyproto/plugins/releases/tag/happyview-lua-v1.0.0) (2026-10-07)

- **First release on HappyView v3's plugin API.**
`;

  it("reads_the_bullets_under_a_linked_heading", () => {
    expect(changelogEntry(PLUGINS, "1.1.0")).toBe(
      "- **Library calls can run together.** The new `internal.async` module.\n- **Tracebacks name the library bridge.** It's labelled `[library bridge]` now.",
    );
    expect(changelogEntry(PLUGINS, "1.0.0")).toBe(
      "- **First release on HappyView v3's plugin API.**",
    );
  });

  it("reads_a_heading_with_the_date_inside_the_link", () => {
    const jobs = `## [1.1.0 (2026-10-08)](https://github.com/happyproto/plugins/releases/tag/happyview-jobs-v1.1.0)

- **Scripts can read jobs.**

## [1.0.0 (2026-10-07)](https://github.com/happyproto/plugins/releases/tag/happyview-jobs-v1.0.0)

- **First release.**
`;
    expect(changelogEntry(jobs, "1.1.0")).toBe("- **Scripts can read jobs.**");
    expect(changelogEntry(jobs, "1.0.0")).toBe("- **First release.**");
    expect(changelogEntry(jobs, "1.1")).toBeNull();
  });

  it("reads_a_bare_heading", () => {
    const md =
      "# Changelog\n\n## 2.0.0 (2026-01-01)\n\n### Fixes\n\n- a fix\n\n## 1.0.0\n\n- first\n";
    expect(changelogEntry(md, "2.0.0")).toBe("### Fixes\n\n- a fix");
    expect(changelogEntry(md, "1.0.0")).toBe("- first");
  });

  it("a_version_must_match_whole", () => {
    expect(changelogEntry(PLUGINS, "1.1")).toBeNull();
    expect(changelogEntry(PLUGINS, "1.1.0-alpha.1")).toBeNull();
    const md = "## 1.1.0-alpha.1\n\n- pre\n\n## 1.1.0\n\n- final\n";
    expect(changelogEntry(md, "1.1.0")).toBe("- final");
    expect(changelogEntry(md, "1.1.0-alpha.1")).toBe("- pre");
  });

  it("an_empty_or_missing_entry_is_none", () => {
    expect(changelogEntry("## 1.0.0\n\n## 0.9.0\n- x\n", "1.0.0")).toBeNull();
    expect(changelogEntry("", "1.0.0")).toBeNull();
  });
});
