// hpy-plugin/src/project.rs tests. The author is a placeholder rather than the
// Rust fixture's real address; nothing here depends on who it is.
import { expect, it } from "vitest";
import type { Json } from "../../src/core/output.ts";
import { predictedBlob } from "../../src/plugin/artifact.ts";
import {
  type ProjectDetails,
  parseAuthor,
  parseContact,
  projectInput,
  projectProblems,
} from "../../src/plugin/project.ts";

type Obj = Record<string, Json>;
const EMAIL = "ada@example.com";
const icon = () => predictedBlob(Buffer.from("png"), "image/png") as Obj;
const valid = (): ProjectDetails => ({
  name: "happyview-lua",
  publication: { name: "Lua", description: "Lua scripts for HappyView.", icon: icon() },
  pluginType: "interpreter",
  keywords: ["lua"],
  authors: [{ name: "Ada", url: undefined, email: EMAIL }],
  security: [{ url: "https://github.com/happyproto/plugins/security", email: undefined }],
});
const paths = (d: ProjectDetails) => projectProblems(d).map((p) => p.path);

it("valid_details_have_no_problems_and_become_put_project_input", () => {
  const d = valid();
  expect(projectProblems(d)).toEqual([]);
  const input = projectInput(d);
  expect(input).toEqual({
    name: "happyview-lua",
    publication: { name: "Lua", description: "Lua scripts for HappyView.", icon: icon() },
    project: {
      pluginType: "interpreter",
      keywords: ["lua"],
      authors: [{ name: "Ada", email: EMAIL }],
      security: [{ url: "https://github.com/happyproto/plugins/security" }],
    },
  });
  // A `Value` prints its keys sorted, at every depth.
  const keys = (v: unknown): string[][] =>
    v && typeof v === "object" && !Array.isArray(v)
      ? [Object.keys(v), ...Object.values(v).flatMap(keys)]
      : Array.isArray(v)
        ? v.flatMap(keys)
        : [];
  for (const k of keys(input)) expect(k).toEqual([...k].sort());
});

it("blank_contact_fields_are_left_out_of_the_input", () => {
  const d = valid();
  (d.authors[0] as { url?: string }).url = "";
  d.security = [{ url: "https://example.com/security", email: " " }];
  const project = (projectInput(d) as Obj).project as Obj;
  expect(project.authors).toEqual([{ name: "Ada", email: EMAIL }]);
  expect(project.security).toEqual([{ url: "https://example.com/security" }]);
});

it("optional_input_is_left_out", () => {
  const d = valid();
  d.publication.description = undefined;
  d.publication.icon = undefined;
  d.keywords = [];
  const input = projectInput(d) as Obj;
  expect("description" in (input.publication as Obj)).toBe(false);
  expect("icon" in (input.publication as Obj)).toBe(false);
  expect("keywords" in (input.project as Obj)).toBe(false);
});

it("name_follows_the_project_grammar", () => {
  const d = valid();
  d.name = "HappyView.Lua";
  expect(paths(d)).toEqual(["name"]);
});

it("publication_needs_a_name", () => {
  const d = valid();
  d.publication.name = "  ";
  expect(paths(d)).toEqual(["publication.name"]);
});

it("publication_name_is_at_most_64", () => {
  const d = valid();
  d.publication.name = "n".repeat(64);
  expect(projectProblems(d)).toEqual([]);
  d.publication.name = "n".repeat(65);
  expect(paths(d)).toEqual(["publication.name"]);
});

it("publication_description_is_at_most_300", () => {
  const d = valid();
  d.publication.description = "d".repeat(300);
  expect(projectProblems(d)).toEqual([]);
  d.publication.description = "d".repeat(301);
  expect(paths(d)).toEqual(["publication.description"]);
});

it("an_empty_security_url_or_email_counts_as_absent", () => {
  const d = valid();
  d.security = [{ url: "", email: " " }];
  expect(paths(d)).toEqual(["project.security[0]"]);
});

it("icon_is_an_image_of_at_most_1_mb", () => {
  let d = valid();
  (d.publication.icon as Obj).mimeType = "application/pdf";
  expect(paths(d)).toEqual(["publication.icon"]);
  expect(projectProblems(d)[0]?.toString()).toBe(
    'publication.icon: is "application/pdf"; it must be an image',
  );
  d = valid();
  (d.publication.icon as Obj).size = 1_000_001;
  expect(paths(d)).toEqual(["publication.icon"]);
  (d.publication.icon as Obj).size = 1_000_000;
  expect(projectProblems(d)).toEqual([]);
});

it("plugin_type_is_one_of_three", () => {
  const d = valid();
  d.pluginType = "theme";
  expect(paths(d)).toEqual(["project.pluginType"]);
});

it("at_most_20_keywords", () => {
  const d = valid();
  d.keywords = Array.from({ length: 20 }, (_, i) => `k${i}`);
  expect(projectProblems(d)).toEqual([]);
  d.keywords.push("one-too-many");
  expect(paths(d)).toEqual(["project.keywords"]);
});

it("keywords_have_a_limit", () => {
  const d = valid();
  d.keywords = ["k".repeat(33)];
  expect(paths(d)).toEqual(["project.keywords[0]"]);
  // 32 graphemes, over 320 bytes
  d.keywords = ["👩‍👩‍👧".repeat(32)];
  const problems = projectProblems(d);
  expect(problems.length).toBe(1);
  expect(problems[0]?.problem).toContain("320 bytes");
});

it("at_least_one_author_with_a_name_of_at_most_128", () => {
  const d = valid();
  d.authors = [];
  expect(paths(d)).toEqual(["project.authors"]);
  d.authors = [{ name: " " }];
  expect(paths(d)).toEqual(["project.authors[0].name"]);
  d.authors = [{ name: "n".repeat(129) }];
  expect(paths(d)).toEqual(["project.authors[0].name"]);
  d.authors = [{ name: "n".repeat(128) }];
  expect(projectProblems(d)).toEqual([]);
});

it("at_least_one_security_contact_with_a_url_or_email", () => {
  const d = valid();
  d.security = [];
  expect(paths(d)).toEqual(["project.security"]);
  d.security = [{}];
  expect(paths(d)).toEqual(["project.security[0]"]);
});

it("parses_npm_style_authors_and_contacts", () => {
  expect(parseAuthor(`Ada <${EMAIL}> (https://ada.dev)`)).toEqual({
    name: "Ada",
    email: EMAIL,
    url: "https://ada.dev",
  });
  expect(parseAuthor("Just A Name").name).toBe("Just A Name");
  expect(() => parseAuthor("  ")).toThrow();
  expect(parseContact("security@x.io").email).toBe("security@x.io");
  expect(parseContact("https://x.io/sec").url).toBe("https://x.io/sec");
  expect(() => parseContact("nope")).toThrow();
});
