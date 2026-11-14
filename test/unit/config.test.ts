// hpy-plugin/src/config.rs tests. The author's email is a placeholder rather than the Rust
// fixture's real address; nothing here depends on who it is.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { predictedBlob } from "../../src/plugin/artifact.ts";
import {
  type HpyToml,
  hpyName,
  loadHpyToml,
  projectConfig,
  releaseChangelog,
  releaseConfig,
  releaseSections,
  toDetails,
  writeProject,
} from "../../src/plugin/config.ts";
import { manifest } from "../../src/plugin/manifest.ts";
import type { Problem } from "../../src/plugin/problem.ts";
import { projectProblems } from "../../src/plugin/project.ts";
import { ENOENT_TEXT } from "../support/os-text.ts";

const TOML = `
# keep me
[project]
display_name = "Lua"
icon = { path = "icon.png", alt = "the Lua logo" }
keywords = ["lua"]
authors = [{ name = "Trezy", email = "ada@example.com" }]
security = [{ url = "https://github.com/happyproto/plugins/security" }]

[release]
license = "MIT"
changelog = "CHANGELOG.md"

[release.requires]
"env:happyview" = ">=3.0.0"

[release.sections]
description = "DESCRIPTION.md"
installation = { text = "hpy add happyview-lua" }

[release.artifacts]
banner = { path = "banner.png", alt = "a banner" }
screenshots = [{ path = "shot.png" }]

[build]
wasm = "plugin.wasm"
`;

const CHANGELOG =
  "## [1.1.0](https://example.com/v1.1.0) (2026-10-10)\n\n- **Async.** Calls run together.\n\n## [1.0.0](https://example.com/v1.0.0) (2026-10-07)\n\n- First.\n";

const luaManifest = () =>
  manifest({
    id: "happyview-lua",
    name: "Lua (manifest)",
    description: "Lua scripts.",
    plugin_type: "interpreter",
  });

const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-config-"));

function load(text: string): [string, HpyToml] {
  const dir = tempdir();
  writeFileSync(join(dir, "hpy.toml"), text);
  return [dir, loadHpyToml(dir)!];
}

function loadErr(dir: string): Problem {
  try {
    loadHpyToml(dir);
  } catch (e) {
    return e as Problem;
  }
  throw new Error("expected an error");
}

it("loads_the_project_table_with_manifest_defaults", () => {
  const [, cfg] = load(TOML);
  const m = luaManifest();
  expect(hpyName(cfg, m)).toBe("happyview-lua");
  const project = cfg.project!;
  const icon = project.icon!;
  expect([icon.path, icon.alt]).toEqual(["icon.png", "the Lua logo"]);
  const blob = predictedBlob(Buffer.from("png"), "image/png");
  const details = toDetails(project, "happyview-lua", m, blob);
  expect(details.name).toBe("happyview-lua");
  expect(details.publication.name).toBe("Lua");
  // the manifest's description, since hpy.toml gives none
  expect(details.publication.description).toBe("Lua scripts.");
  expect(details.publication.icon).toEqual(blob);
  expect(details.pluginType).toBe("interpreter");
  expect(details.keywords).toEqual(["lua"]);
  expect(details.authors[0]!.name).toBe("Trezy");
  expect(projectProblems(details)).toEqual([]);
});

it("project_name_and_display_name_can_be_set", () => {
  const [, cfg] = load('[project]\nname = "lua"\n');
  const m = luaManifest();
  expect(hpyName(cfg, m)).toBe("lua");
  const details = toDetails(cfg.project!, "lua", m, undefined);
  expect(details.publication.name).toBe("Lua (manifest)");
  expect(details.publication.icon).toBeUndefined();
});

it("loads_the_release_table", () => {
  const [dir, cfg] = load(TOML);
  writeFileSync(join(dir, "DESCRIPTION.md"), "# Lua");
  const release = cfg.release!;
  expect(release.license).toBe("MIT");
  expect(release.requires.get("env:happyview")).toBe(">=3.0.0");
  const [sections, problems] = releaseSections(release, dir);
  expect(problems).toEqual([]);
  expect(sections).toEqual({
    description: "# Lua",
    installation: "hpy add happyview-lua",
    security: undefined,
  });
  expect(release.artifacts.banner!.alt).toBe("a banner");
  expect(release.artifacts.screenshots[0]!.path).toBe("shot.png");
  expect(cfg.build!.wasm).toBe("plugin.wasm");
});

it("a_missing_section_file_is_a_problem", () => {
  const [dir, cfg] = load(TOML);
  const [sections, problems] = releaseSections(cfg.release!, dir);
  expect(sections.description).toBe("");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.path).toBe("release.sections.description");
  // io::Error's Display, as Rust prints it on this platform
  expect(problems[0]!.problem).toBe(`cannot read \`DESCRIPTION.md\`: ${ENOENT_TEXT}`);
});

it("the_changelog_entry_for_a_version_is_read", () => {
  const [dir, cfg] = load(TOML);
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
  const release = cfg.release!;
  expect(releaseChangelog(release, dir, "1.1.0")).toBe("- **Async.** Calls run together.");
  expect(releaseChangelog(release, dir, "2.0.0")).toBeNull();
  expect(releaseChangelog(releaseConfig(), dir, "1.1.0")).toBeNull();
});

it("an_unreadable_changelog_is_a_problem", () => {
  const [dir, cfg] = load(TOML);
  let err: Problem | undefined;
  try {
    releaseChangelog(cfg.release!, dir, "1.1.0");
  } catch (e) {
    err = e as Problem;
  }
  expect(err!.path).toBe("release.changelog");
});

it("a_profile_table_is_refused", () => {
  const dir = tempdir();
  writeFileSync(join(dir, "hpy.toml"), '[profile]\nlicense = "MIT"\n');
  expect(loadErr(dir).toString()).toBe(
    "hpy.toml: uses [profile], which the software.release registry replaced; move its fields to [project] and [release] (see hpy's README)",
  );
});

it("a_release_icon_is_refused", () => {
  const dir = tempdir();
  writeFileSync(join(dir, "hpy.toml"), '[release.artifacts]\nicon = { path = "icon.png" }\n');
  const err = loadErr(dir);
  expect(err.path).toBe("release.artifacts.icon");
  expect(err.problem).toContain("[project] icon");
});

it("write_project_preserves_other_tables_and_comments", () => {
  const [dir, cfg] = load(TOML);
  const project = { ...cfg.project!, display_name: "Lua 5.4" };
  writeProject(dir, project);
  const text = readFileSync(join(dir, "hpy.toml"), "utf8");
  expect(text).toContain("# keep me");
  expect(text).toContain("[build]");
  const reloaded = loadHpyToml(dir)!;
  expect(reloaded.project!.display_name).toBe("Lua 5.4");
  expect(reloaded.release!.license).toBe("MIT");
});

it("write_project_creates_the_file", () => {
  const dir = tempdir();
  writeProject(dir, projectConfig({ name: "x" }));
  expect(loadHpyToml(dir)!.project!.name).toBe("x");
});

it("malformed_toml_is_a_problem", () => {
  const dir = tempdir();
  writeFileSync(join(dir, "hpy.toml"), "[project\n");
  const err = loadErr(dir);
  expect(err.path).toBe("hpy.toml");
  // toml's Display, byte for byte (checked against the Rust binary)
  expect(err.message).toBe(
    "hpy.toml: is not valid: TOML parse error at line 1, column 9\n  |\n1 | [project\n  |         ^\nunclosed table, expected `]`\n",
  );
  expect(loadHpyToml(tempdir())).toBeNull();
});
