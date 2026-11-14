// crates/hpy/src/commands/publish.rs tests, against test/support/fakes.ts (crate::testing).
// The Rust fixtures' values are kept as they are.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_SCOPE } from "../../src/atproto/settings.ts";
import { applyEdit, editableFromView } from "../../src/commands/profile.ts";
import {
  differs,
  execute,
  type Outcome,
  type Prepared,
  type PrepareOptions,
  type Published,
  prepare,
  promote,
  publishedJson,
  resumedStatus,
  type Timing,
  trackFor,
  type Ui,
  waitForAvailable,
} from "../../src/commands/publish.ts";
import type { Failure } from "../../src/core/failure.ts";
import type { Json } from "../../src/core/output.ts";
import { artifactToValue } from "../../src/plugin/artifact.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import { PUBLICATION_NSID } from "../../src/plugin/nsid.ts";
import type { ProjectDetails } from "../../src/plugin/project.ts";
import { DID, FakeRegistry, FakeRepo, projectView } from "../support/fakes.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
/** A 1x1 PNG. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

class TestUi implements Ui {
  answer: boolean;
  readonly warnings: string[] = [];
  readonly summaries: string[] = [];
  constructor(answer = true) {
    this.answer = answer;
  }
  warn(m: string): void {
    this.warnings.push(m);
  }
  progress(): void {}
  async confirm(summary: string): Promise<boolean> {
    this.summaries.push(summary);
    return this.answer;
  }
}

const HPY_TOML =
  '[project]\ndisplay_name = "Mine"\nicon = { path = "icon.png" }\nauthors = [{ name = "Ada" }]\nsecurity = [{ email = "s@x.io" }]\n\n[release]\nlicense = "MIT"\nchangelog = "CHANGELOG.md"\n\n[release.sections]\ndescription = { text = "Does things." }\n\n[release.artifacts]\nbanner = { path = "banner.png", alt = "A banner" }\n\n[release.requires]\n"env:happyview" = ">=3.0.0"\n';

function pluginDir(version: string, withProject: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "hpy-publish-"));
  writeFileSync(
    join(dir, "manifest.json"),
    `{"id":"my-plugin","name":"Mine","version":"${version}","api_version":"2","plugin_type":"library","namespace":"my.plugin","capabilities":[],"wasm_file":"my-plugin.wasm"}`,
  );
  writeFileSync(join(dir, "my-plugin.wasm"), WASM);
  writeFileSync(join(dir, "icon.png"), PNG);
  // Another image's bytes, so the banner has a CID of its own.
  writeFileSync(join(dir, "banner.png"), Buffer.concat([PNG, enc("banner")]));
  writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## ${version}\n\n* first\n`);
  const toml = withProject ? HPY_TOML : `[release]${HPY_TOML.split("[release]")[1]}`;
  writeFileSync(join(dir, "hpy.toml"), toml);
  return dir;
}

const opts = (o: Partial<PrepareOptions> = {}): PrepareOptions => ({
  wasm: undefined,
  version: undefined,
  noBuild: true,
  ...o,
});
const noBuild = () => {};

function prepared(version: string): [string, Prepared] {
  const dir = pluginDir(version, true);
  return [dir, prepare(dir, opts(), noBuild)];
}

function failureOf(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected a failure");
}

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected a failure");
}

const editToml = (dir: string, from: string, to: string) => {
  const path = join(dir, "hpy.toml");
  const text = readFileSync(path, "utf8").replace(from, to);
  writeFileSync(path, text);
  return text;
};

const at = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], v);

it("prepare_collects_every_problem", () => {
  const dir = pluginDir("1.0.0+abc", true);
  editToml(dir, '"env:happyview" = ">=3.0.0"', 'nope = "^1 || ^2"');
  const err = failureOf(() => prepare(dir, opts(), noBuild));
  expect(err.code).toBe(2);
  expect(err.message).toContain("build metadata");
  expect(err.message).toContain("requires");
});

it("prepare_rejects_v_prefix_from_manifest", () => {
  const dir = pluginDir("v1.0.0", true);
  const err = failureOf(() => prepare(dir, opts(), noBuild));
  expect(err.message).toContain("`v`");
});

it("prepare_builds_the_artifact_with_predicted_blobs", () => {
  const [dir, p] = prepared("1.0.0");
  expect([p.name, p.version]).toEqual(["my-plugin", "1.0.0"]);
  const a = artifactToValue(p.artifact);
  expect(at(a, "package", "ref", "$link")).toBe(rawCid(WASM));
  const manifest = readFileSync(join(dir, "manifest.json"));
  // The manifest is published as it sits beside the module.
  expect(at(a, "manifest", "ref", "$link")).toBe(rawCid(manifest));
  expect(at(a, "license")).toBe("MIT");
  expect(at(a, "sections", "description")).toBe("Does things.");
  expect(at(a, "requires", "env:happyview")).toBe(">=3.0.0");
  expect(at(a, "banner", "alt")).toBe("A banner");
  const details = (p.details as { ok: ProjectDetails }).ok;
  expect(details.publication.name).toBe("Mine");
  expect(at(details.publication.icon, "ref", "$link")).toBe(rawCid(PNG));
  expect(p.changelog).toBe("* first");
});

it("version_flag_overrides_manifest", () => {
  const dir = pluginDir("1.0.0", true);
  const p = prepare(dir, opts({ version: "1.1.0" }), noBuild);
  expect(p.version).toBe("1.1.0");
});

it("build_command_runs_unless_disabled", () => {
  const dir = pluginDir("1.0.0", true);
  const path = join(dir, "hpy.toml");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n[build]\ncommand = "make wasm"\n`);
  const ran: string[] = [];
  prepare(dir, opts({ noBuild: false }), (c) => {
    ran.push(c);
  });
  expect(ran).toEqual(["make wasm"]);
  const err = failureOf(() =>
    prepare(dir, opts({ noBuild: false }), () => {
      throw "exit 1";
    }),
  );
  expect(err.message).toContain("make wasm");
});

it("the_track_follows_the_version_unless_given", () => {
  const cases: [string, string | undefined, { ok: string } | { err: string }][] = [
    ["1.2.0", undefined, { ok: "latest" }],
    ["1.2.0-beta.1", undefined, { ok: "beta" }],
    ["1.2.0-alpha.3", undefined, { ok: "alpha" }],
    ["1.2.0-rc.1", undefined, { err: "--track" }],
    ["1.2.0-rc.1", "beta", { ok: "beta" }],
    ["1.2.0", "alpha", { ok: "alpha" }],
    ["1.2.0", "stable", { err: "latest, beta or alpha" }],
  ];
  for (const [version, flag, want] of cases) {
    if ("ok" in want) {
      expect(trackFor(version, flag), `${version} ${flag}`).toBe(want.ok);
    } else {
      const e = failureOf(() => trackFor(version, flag));
      expect(e.code).toBe(2);
      expect(e.message, `${version} ${flag}`).toContain(want.err);
    }
  }
});

const fast = (): Timing => ({ poll: 1, limit: 50 });

const run = (p: Prepared, repo: FakeRepo, reg: FakeRegistry, dryRun: boolean) =>
  execute(p, repo, reg, new TestUi(), "latest", dryRun);

function published(o: Outcome): Published {
  if ("published" in o) return o.published;
  throw new Error("a dry run");
}

const uploadedCids = (repo: FakeRepo) => repo.blobs.map(([b]) => rawCid(b));
const clear = <T>(xs: T[]) => xs.splice(0, xs.length);

it("a_first_publish_validates_everything_then_writes_it", async () => {
  const [dir, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  const out = published(await run(p, repo, reg, false));
  expect(out.createdProject).toBe(true);
  expect(out.resumed).toBe(false);
  expect(out.uri).toBe("at://did:plc:testuser/software.release.version/my-plugin.1.0.0");
  expect(reg.calls).toEqual([
    ["project", true],
    ["release", true],
    ["project", false],
    ["release", false],
  ]);
  // Icon, module, manifest and banner, each once.
  const uploaded = uploadedCids(repo);
  const manifest = readFileSync(join(dir, "manifest.json"));
  expect(uploaded.length).toBe(4);
  for (const cid of [rawCid(WASM), rawCid(manifest), rawCid(PNG)]) expect(uploaded).toContain(cid);
  const input = reg.published[0] as { [k: string]: Json };
  expect(input.name).toBe("my-plugin");
  expect(input.version).toBe("1.0.0");
  expect(input.track).toBe("latest");
  expect(input.changelog).toBe("* first");
  expect(input.artifact).toEqual(artifactToValue(p.artifact));
  const project = reg.putProjects[0];
  expect(project?.name).toBe("my-plugin");
  expect(at(project, "publication", "icon", "ref", "$link")).toBe(rawCid(PNG));
});

it("a_second_publish_with_the_same_project_skips_put_project_and_unchanged_images", async () => {
  const [, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  clear(reg.calls);
  clear(repo.blobs);

  const [, next] = prepared("1.1.0");
  const out = published(await run(next, repo, reg, false));
  expect(out.createdProject).toBe(false);
  expect(reg.calls).toEqual([
    ["release", true],
    ["release", false],
  ]);
  // The icon is the publication's and the banner the last version's, so neither is sent
  // again; only the changed manifest is.
  const uploaded = uploadedCids(repo);
  expect(uploaded).not.toContain(rawCid(PNG));
  expect(uploaded.length).toBe(1);
});

it("changed_project_details_are_put_again_without_reuploading_the_icon", async () => {
  const [dir, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  clear(reg.calls);
  clear(repo.blobs);
  editToml(dir, 'display_name = "Mine"', 'display_name = "Mine Too"');
  const next = prepare(dir, opts({ version: "1.1.0" }), noBuild);
  await run(next, repo, reg, false);
  expect(reg.calls).toEqual([
    ["project", true],
    ["release", true],
    ["project", false],
    ["release", false],
  ]);
  expect(uploadedCids(repo)).not.toContain(rawCid(PNG));
});

/** What the gateway wrote as the publication, in the repo, so `currentIcon` finds it as it would on a real PDS. */
function mirrorPublication(repo: FakeRepo, reg: FakeRegistry): void {
  const input = reg.putProjects[reg.putProjects.length - 1] as { [k: string]: Json };
  repo.records.set(`${PUBLICATION_NSID} ${input.name}`, [
    structuredClone(input.publication as Json),
    "bafypublication",
  ]);
}

it("a_project_table_without_an_icon_keeps_the_publications_icon", async () => {
  const [dir, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  mirrorPublication(repo, reg);
  clear(reg.calls);
  const toml = readFileSync(join(dir, "hpy.toml"), "utf8").replace(
    'icon = { path = "icon.png" }\n',
    "",
  );
  writeFileSync(join(dir, "hpy.toml"), toml);
  // Without the icon line, nothing else differs: no put at all.
  const same = prepare(dir, opts({ version: "1.1.0" }), noBuild);
  await run(same, repo, reg, false);
  expect(reg.calls).toEqual([
    ["release", true],
    ["release", false],
  ]);
  // A real change is put with the icon the publication already has.
  writeFileSync(
    join(dir, "hpy.toml"),
    toml.replace('display_name = "Mine"', 'display_name = "Renamed"'),
  );
  const renamed = prepare(dir, opts({ version: "1.2.0" }), noBuild);
  await run(renamed, repo, reg, false);
  const input = reg.putProjects[reg.putProjects.length - 1];
  expect(at(input, "publication", "name")).toBe("Renamed");
  expect(at(input, "publication", "icon", "ref", "$link")).toBe(rawCid(PNG));
});

it("an_existing_project_is_put_with_its_sidecars_cid", async () => {
  const [dir, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  expect(reg.putProjects[0]).not.toHaveProperty("swapCid");
  (reg.project as NonNullable<typeof reg.project>).sidecar.cid = "bafysidecar";
  editToml(dir, 'display_name = "Mine"', 'display_name = "Renamed"');
  const next = prepare(dir, opts({ version: "1.1.0" }), noBuild);
  await run(next, repo, reg, false);
  expect(reg.putProjects[reg.putProjects.length - 1]?.swapCid).toBe("bafysidecar");
});

it("an_edit_survives_the_next_publish", async () => {
  const [dir, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  mirrorPublication(repo, reg);
  (reg.project as NonNullable<typeof reg.project>).sidecar.cid = "bafysidecar";
  const view = structuredClone(reg.project as NonNullable<typeof reg.project>);
  const edited = editableFromView(view);
  edited.display_name = "Edited";
  edited.keywords.push("new");
  await applyEdit(dir, reg, repo, view, edited);
  const put = reg.putProjects[reg.putProjects.length - 1];
  expect(put?.swapCid).toBe("bafysidecar");
  expect(at(put, "publication", "icon", "ref", "$link")).toBe(rawCid(PNG));
  const toml = readFileSync(join(dir, "hpy.toml"), "utf8");
  expect(toml).toContain('display_name = "Edited"');
  expect(toml).toContain("icon.png");

  clear(reg.calls);
  const next = prepare(dir, opts({ version: "1.1.0" }), noBuild);
  await run(next, repo, reg, false);
  // A put here would have reverted the edit.
  expect(reg.calls).toEqual([
    ["release", true],
    ["release", false],
  ]);
  expect(reg.project?.publication.name).toBe("Edited");
});

it("null_and_absent_author_fields_are_the_same_author", () => {
  const [, p] = prepared("1.0.0");
  const details = (p.details as { ok: ProjectDetails }).ok;
  const view = projectView(DID, "my-plugin", "library");
  view.publication.name = "Mine";
  view.publication.icon = rawCid(PNG);
  view.authors = [{ name: "Ada", email: null, url: null }];
  view.security = [{ email: "s@x.io", url: null }];
  expect(differs(details, view)).toBe(false);
  view.authors = [{ name: "Bea" }];
  expect(differs(details, view)).toBe(true);
});

it("a_deleted_version_holds_no_blobs", async () => {
  const [, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  (reg.versions.get("1.0.0") as NonNullable<ReturnType<typeof reg.versions.get>>).availability =
    "deletedAtSource";
  clear(repo.blobs);
  const [, next] = prepared("1.1.0");
  await run(next, repo, reg, false);
  expect(uploadedCids(repo)).toContain(rawCid(WASM));
});

it("a_blob_the_pds_no_longer_has_is_sent_and_the_publish_retried", async () => {
  const [, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  clear(repo.blobs);
  reg.missingBlobOnce = true;
  const [, next] = prepared("1.1.0");
  const out = published(await run(next, repo, reg, false));
  expect(out.uri.endsWith("my-plugin.1.1.0")).toBe(true);
  // The first pass skipped the module; the retry sent it.
  expect(uploadedCids(repo)).toContain(rawCid(WASM));
  expect(reg.calls.filter(([w, v]) => w === "release" && !v).length).toBe(3);
});

it("publishing_a_finished_version_again_reports_it_resumed", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  expect(published(await run(p, repo, reg, false)).resumed).toBe(false);
  const again = published(await run(p, repo, reg, false));
  expect(again.resumed).toBe(true);
  expect(again.uri).toBe("at://did:plc:testuser/software.release.version/my-plugin.1.0.0");
});

it("publishing_a_finished_version_again_says_it_was_already_published", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  const first = published(await run(p, repo, reg, false));
  expect(first.uploaded).toBe(true);
  const again = published(await run(p, repo, reg, false));
  expect(again.resumed).toBe(true);
  expect(again.uploaded).toBe(false);
  expect(resumedStatus(again, "my-plugin", "1.0.0")).toBe("my-plugin 1.0.0 was already published");
});

it("a_resumed_publish_answered_without_a_manifest_succeeds", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  reg.failNextPublish = true;
  await expect(run(p, repo, reg, false)).rejects.toThrow();
  reg.omitManifest = true;
  const out = published(await run(p, repo, reg, false));
  expect(out.resumed).toBe(true);
  expect(out.uri).toBe("at://did:plc:testuser/software.release.version/my-plugin.1.0.0");
});

it("finishing_a_cut_off_publish_says_so", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  reg.failNextPublish = true;
  await expect(run(p, repo, reg, false)).rejects.toThrow();
  const out = published(await run(p, repo, reg, false));
  expect(out.resumed && out.uploaded).toBe(true);
  expect(resumedStatus(out, "my-plugin", "1.0.0")).toBe(
    "Finished a publish an earlier attempt left incomplete",
  );
});

it("an_upload_the_pds_stores_under_another_cid_fails_naming_both", async () => {
  const [, p] = prepared("1.0.0");
  const wrong = rawCid(enc("other"));
  const repo = new FakeRepo({ wrongCid: wrong });
  const reg = new FakeRegistry();
  const err = await failure(run(p, repo, reg, false));
  expect(err.message).toContain(wrong);
  expect(err.message).toContain(rawCid(PNG));
  expect(reg.published).toEqual([]);
});

it("a_publish_cut_off_after_the_uploads_resumes_when_run_again", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  reg.failNextPublish = true;
  await expect(run(p, repo, reg, false)).rejects.toThrow();
  expect(reg.published).toEqual([]);
  const out = published(await run(p, repo, reg, false));
  expect(out.resumed).toBe(true);
  expect(reg.published.length).toBe(1);
});

it("a_version_the_registry_holds_with_this_artifact_is_finished_not_refused", async () => {
  const [, p] = prepared("1.0.0");
  const reg = FakeRegistry.withVersion("my-plugin", "1.0.0", artifactToValue(p.artifact));
  reg.project = null;
  const out = await run(p, new FakeRepo(), reg, false);
  expect("published" in out).toBe(true);
});

it("a_version_the_registry_holds_with_another_artifact_is_refused", async () => {
  const [, p] = prepared("1.0.0");
  const other = artifactToValue(p.artifact) as { [k: string]: Json };
  other.license = "Apache-2.0";
  const reg = FakeRegistry.withVersion("my-plugin", "1.0.0", other);
  const manifest = reg.versions.get("1.0.0")?.manifest.cid as string;
  const repo = new FakeRepo();
  const err = await failure(run(p, repo, reg, false));
  expect(err.code).toBe(2);
  expect(err.message).toContain("immutable");
  expect(err.message).toContain(manifest);
  expect(repo.blobs).toEqual([]);
  expect(reg.calls).toEqual([]);
});

it("an_unreadable_artifact_in_the_registry_names_the_version", async () => {
  const [, p] = prepared("1.0.0");
  const reg = FakeRegistry.withVersion("my-plugin", "1.0.0", { $type: "x" });
  const err = await failure(run(p, new FakeRepo(), reg, false));
  expect(err.message).toContain("my-plugin 1.0.0");
});

// A grant from before the registry moved collections: it can upload every blob, so only the
// repo check stops it before the first upload.
it("a_grant_missing_a_scope_refuses_before_uploading_anything", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo({
    scopes:
      "atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm blob:image/*",
  });
  const reg = new FakeRegistry();
  const err = await failure(run(p, repo, reg, false));
  expect(err.message).toContain("blob:application/json");
  expect(err.message).toContain("repo:software.release.version");
  expect(err.message).toContain("hpy registry login");
  expect(repo.blobs).toEqual([]);
  expect(reg.calls).toEqual([]);
});

// The scope a login asks for has to get a publish all the way through.
it("the_default_grant_publishes", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo({ scopes: DEFAULT_SCOPE });
  expect("published" in (await run(p, repo, new FakeRegistry(), false))).toBe(true);
});

it("no_project_anywhere_points_at_init", async () => {
  const dir = pluginDir("1.0.0", false);
  const p = prepare(dir, opts(), noBuild);
  const err = await failure(run(p, new FakeRepo(), new FakeRegistry(), false));
  expect(err.message).toContain("hpy registry plugin init");
});

it("a_registered_project_needs_no_project_table", async () => {
  const [, first] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  await run(first, repo, reg, false);
  clear(reg.calls);
  const dir = pluginDir("1.1.0", false);
  const next = prepare(dir, opts(), noBuild);
  await run(next, repo, reg, false);
  expect(reg.calls).toEqual([
    ["release", true],
    ["release", false],
  ]);
});

it("a_registry_refusal_uploads_nothing", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry({
    rejectRelease: ["InvalidRecord", "capabilities must be declared, even when empty"],
  });
  const err = await failure(run(p, repo, reg, false));
  expect(err.code).toBe(2);
  expect(err.message).toContain("capabilities must be declared");
  expect(repo.blobs).toEqual([]);
  expect(reg.putProjects).toEqual([]);
});

it("a_project_not_yet_written_is_no_refusal_while_validating", async () => {
  const [, p] = prepared("1.0.0");
  const reg = new FakeRegistry({ rejectRelease: ["ProjectMissing", "no such project"] });
  // Validation passes; the write then meets the same refusal, since the fake does not see the
  // project it was just given.
  const err = await failure(run(p, new FakeRepo(), reg, false));
  expect(reg.calls).toEqual([
    ["project", true],
    ["release", true],
    ["project", false],
    ["release", false],
  ]);
  expect(err.message).toContain("no such project");
});

it("a_dry_run_asks_the_registry_and_writes_nothing", async () => {
  const [, p] = prepared("1.0.0");
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  const outcome = await run(p, repo, reg, true);
  if (!("dryRun" in outcome)) throw new Error("not a dry run");
  const out = outcome.dryRun;
  expect(at(out, "dryRun")).toBe(true);
  expect(at(out, "artifact")).toEqual(artifactToValue(p.artifact));
  expect(at(out, "project", "name")).toBe("my-plugin");
  expect(reg.calls).toEqual([
    ["project", true],
    ["release", true],
  ]);
  expect(repo.blobs).toEqual([]);
  await expect(execute(p, repo, reg, new TestUi(false), "latest", false)).rejects.toThrow();
  expect(reg.published).toEqual([]);
  expect(reg.putProjects).toEqual([]);
});

it("the_summary_shows_cids_and_no_checksum", async () => {
  const [, p] = prepared("1.0.0");
  const u = new TestUi();
  await execute(p, new FakeRepo(), new FakeRegistry(), u, "latest", false);
  const summary = u.summaries[0] as string;
  expect(summary).toContain(rawCid(WASM));
  expect(summary).toContain("latest");
  expect(summary).not.toContain("checksum");
});

it("promote_republishes_a_version_under_a_new_one", async () => {
  const reg = new FakeRegistry();
  const out = await promote(reg, "my-plugin", "1.0.0-beta.2", "1.0.0", "latest", "* notes");
  expect(out.uri).toBe("at://did:plc:testuser/software.release.version/my-plugin.1.0.0");
  expect(reg.promoted[0]).toEqual({
    name: "my-plugin",
    fromVersion: "1.0.0-beta.2",
    version: "1.0.0",
    track: "latest",
    changelog: "* notes",
  });
  expect(reg.calls).toEqual([]);
});

it("waiting_reports_availability_and_gives_up_in_time", async () => {
  const [, p] = prepared("1.0.0");
  const reg = FakeRegistry.withVersion("my-plugin", "1.0.0", artifactToValue(p.artifact));
  const seen: string[] = [];
  let got = await waitForAvailable(reg, DID, "my-plugin", "1.0.0", fast(), (s) => seen.push(s));
  expect(got).toBe("available");
  (reg.versions.get("1.0.0") as NonNullable<ReturnType<typeof reg.versions.get>>).availability =
    "pending";
  got = await waitForAvailable(reg, DID, "my-plugin", "1.0.0", fast(), (s) => seen.push(s));
  expect(got).toBe("pending");
  expect(
    seen.some((s) => s.includes("not available yet")),
    seen.join("\n"),
  ).toBe(true);
  const empty = new FakeRegistry();
  got = await waitForAvailable(empty, DID, "my-plugin", "9.9.9", fast(), () => {});
  expect(got).toBe(null);
});

it("the_json_names_what_the_publish_action_reads", () => {
  const out: Published = {
    uri: "at://v",
    cid: "bafyv",
    createdProject: true,
    resumed: false,
    uploaded: false,
  };
  expect(publishedJson(out, "available")).toEqual({
    uri: "at://v",
    cid: "bafyv",
    createdProject: true,
    resumed: false,
    availability: "available",
  });
  expect(at(publishedJson(out, null), "availability")).toBe(null);
});
