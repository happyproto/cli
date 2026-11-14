// crates/hpy/src/commands/profile.rs tests, against test/support/fakes.ts (crate::testing).
// The Rust fixtures' values are kept as they are.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AtprotoError } from "../../src/atproto/error.ts";
import { DEFAULT_SCOPE } from "../../src/atproto/settings.ts";
import {
  applyEdit,
  applyEdits,
  type Editable,
  editableFromView,
  editableToDetails,
  fromEditable,
  pulledConfig,
  putError,
  putProject,
  resolveName,
  toEditable,
} from "../../src/commands/profile.ts";
import { Blob } from "../../src/commands/publish.ts";
import type { Failure } from "../../src/core/failure.ts";
import { predictedBlob } from "../../src/plugin/artifact.ts";
import { projectConfig } from "../../src/plugin/config.ts";
import { parseAuthor, parseContact } from "../../src/plugin/project.ts";
import { DID, FakeRegistry, FakeRepo, projectView } from "../support/fakes.ts";

const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-profile-"));
const bytes = (s: string) => new TextEncoder().encode(s);

function editable(): Editable {
  return {
    display_name: "Mine",
    description: undefined,
    keywords: [],
    authors: [{ name: "A" }],
    security: [{ email: "s@x.io", url: undefined }],
  };
}

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected a failure");
}

it("put_project_validates_uploads_the_icon_then_writes", async () => {
  const reg = new FakeRegistry();
  const repo = new FakeRepo();
  const icon = new Blob(bytes("icon bytes"), "image/png", "icon");
  const details = editableToDetails(
    editable(),
    "my-plugin",
    "library",
    predictedBlob(icon.bytes, icon.mime),
  );
  const [uri, created] = await putProject(reg, repo, details, icon, undefined);
  expect(created).toBe(true);
  expect(uri).toBe("at://did:plc:testuser/software.release.project/my-plugin");
  expect(reg.calls).toEqual([
    ["project", true],
    ["project", false],
  ]);
  expect(repo.blobs.length).toBe(1);
  expect(reg.putProjects[0]).toMatchObject({ publication: { name: "Mine" } });
});

it("a_grant_missing_a_project_scope_or_the_icon_blob_is_refused_before_any_call", async () => {
  const details = editableToDetails(editable(), "my-plugin", "library", undefined);
  const icon = new Blob(bytes("icon bytes"), "image/png", "icon");
  const cases: [string, Blob | undefined, string][] = [
    ["atproto", undefined, "repo:software.release.project"],
    [
      "repo:software.release.project repo:software.release.publication repo:at.happyproto.registry.project",
      icon,
      "blob:image/png",
    ],
  ];
  for (const [scopes, i, want] of cases) {
    const reg = new FakeRegistry();
    const repo = new FakeRepo({ scopes });
    const err = await failure(putProject(reg, repo, details, i, undefined));
    expect(err.code, err.message).toBe(2);
    expect(err.message).toContain(want);
    expect(reg.calls).toEqual([]);
    expect(repo.blobs).toEqual([]);
  }
  const ok = new FakeRepo({ scopes: DEFAULT_SCOPE });
  await putProject(new FakeRegistry(), ok, details, undefined, undefined);
});

it("an_edit_sends_the_cid_it_read_and_a_conflict_says_so", async () => {
  const reg = new FakeRegistry();
  const details = editableToDetails(editable(), "p", "library", undefined);
  await putProject(reg, new FakeRepo(), details, undefined, "bafyold");
  expect(reg.putProjects[0]?.swapCid).toBe("bafyold");

  const conflicted = new FakeRegistry({ rejectProject: ["InvalidSwap", "swap failed"] });
  const err = await failure(putProject(conflicted, new FakeRepo(), details, undefined, "x"));
  expect(err.message).toContain("changed in your repo");
  const f = putError(AtprotoError.sessionExpired());
  expect(f.code).toBe(3);
});

it("apply_edits_adds_and_replaces", () => {
  const p = editable();
  p.keywords = ["old", "keep"];
  applyEdits(p, { displayName: "New", authors: ["B <b@x.io>"], security: [], keywords: ["new"] }, [
    "old",
  ]);
  expect(p.display_name).toBe("New");
  expect(p.authors.length).toBe(2);
  expect(p.keywords).toEqual(["keep", "new"]);
});

async function editIn(dir: string, name: string): Promise<void> {
  const repo = new FakeRepo();
  const reg = new FakeRegistry();
  const view = projectView(DID, name, "library");
  const e = editableFromView(view);
  e.display_name = "Edited";
  e.authors = [parseAuthor("Ada <a@x.io>")];
  e.security = [parseContact("security@x.io")];
  await applyEdit(dir, reg, repo, view, e);
}

it("an_edit_is_written_back_only_to_its_own_hpy_toml", async () => {
  const dir = tempdir();
  const file = join(dir, "hpy.toml");
  const other = '[project]\nname = "other"\ndisplay_name = "Other"\n';
  writeFileSync(file, other);
  await editIn(dir, "my-plugin");
  expect(readFileSync(file, "utf8")).toBe(other);
  await editIn(dir, "other");
  expect(readFileSync(file, "utf8")).toContain('display_name = "Edited"');
});

it("an_edit_matches_a_project_named_by_the_manifest", async () => {
  const dir = tempdir();
  writeFileSync(join(dir, "manifest.json"), '{"id":"my-plugin"}');
  writeFileSync(join(dir, "hpy.toml"), '[project]\ndisplay_name = "Old"\n');
  await editIn(dir, "my-plugin");
  const text = readFileSync(join(dir, "hpy.toml"), "utf8");
  expect(text).toContain('display_name = "Edited"');
});

it("name_resolution_order", () => {
  const dir = tempdir();
  expect(() => resolveName(dir, undefined)).toThrow();
  writeFileSync(join(dir, "manifest.json"), '{"id":"from-manifest"}');
  expect(resolveName(dir, undefined)).toBe("from-manifest");
  writeFileSync(join(dir, "hpy.toml"), '[project]\nname = "from-toml"\n');
  expect(resolveName(dir, undefined)).toBe("from-toml");
  expect(resolveName(dir, "flag")).toBe("flag");
  expect(() => resolveName(dir, "bad:name")).toThrow();
});

it("editor_toml_roundtrip", () => {
  const p = editable();
  const text = toEditable("x", p);
  expect(fromEditable(text)).toEqual(p);
  expect(() => fromEditable("display_name = 3")).toThrow();
});

it("a_pull_writes_the_registrys_project_and_keeps_the_icon_path", () => {
  const view = projectView(DID, "my-plugin", "library");
  view.publication.name = "Mine";
  view.publication.description = "Does things.";
  view.keywords = ["k"];
  view.authors = [{ name: "Ada", email: "a@x.io" }];
  view.security = [{ url: "https://x.io/security" }];
  const existing = projectConfig({ icon: { path: "icon.png", alt: undefined } });
  const cfg = pulledConfig(view, existing);
  expect(cfg.name).toBe("my-plugin");
  expect(cfg.display_name).toBe("Mine");
  expect(cfg.description).toBe("Does things.");
  expect(cfg.icon?.path).toBe("icon.png");
  expect(cfg.authors[0]?.email).toBe("a@x.io");
  expect(cfg.security[0]?.url).toBe("https://x.io/security");
  expect(cfg.keywords).toEqual(["k"]);
});
