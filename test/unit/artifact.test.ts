// hpy-plugin/src/artifact.rs tests.
import { expect, it } from "vitest";
import type { Json } from "../../src/core/output.ts";
import {
  artifactFromManifest,
  artifactFromValue,
  artifactProblems,
  artifactToValue,
  type Image,
  inspectImage,
  MANIFEST_MIME,
  MAX_IMAGE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_WASM_BYTES,
  type PluginArtifact,
  predictedBlob,
  WASM_MIME,
  wasmProblem,
} from "../../src/plugin/artifact.ts";
import { parseManifest } from "../../src/plugin/manifest.ts";
import { ARTIFACT_TYPE } from "../../src/plugin/nsid.ts";

// 1x1 PNG
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
const WASM = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const bytes = (s: string) => Buffer.from(s);
type Obj = Record<string, Json>;
const o = (v: Json | undefined) => v as Obj;
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected an error");
};

it("wasm_magic_and_size", () => {
  expect(wasmProblem(WASM)).toBeNull();
  expect(wasmProblem(bytes("PK\x03\x04"))).toContain("not a WebAssembly");
  const big = new Uint8Array(MAX_WASM_BYTES + 1);
  big.set(WASM);
  expect(wasmProblem(big)).toContain("16 MiB");
});

it("png_is_inspected", () => {
  const info = inspectImage(PNG);
  expect([info.mime, info.width, info.height]).toEqual(["image/png", 1, 1]);
});

it("svg_and_oversize_refused", () => {
  expect(() => inspectImage(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toThrow();
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  expect(err(() => inspectImage(big))).toContain("1 MiB");
});

const image = (alt?: string): Image => ({
  blob: predictedBlob(PNG, "image/png"),
  width: 1,
  height: 1,
  alt,
});

/** A valid interpreter, the most constrained plugin type. */
const valid = (): PluginArtifact => ({
  package: predictedBlob(WASM, WASM_MIME),
  manifest: predictedBlob(bytes('{"id":"happyview-lua"}'), MANIFEST_MIME),
  banner: image("the Lua logo"),
  screenshots: [image()],
  pluginType: "interpreter",
  apiVersion: "2",
  capabilities: ["library:call"],
  namespace: undefined,
  languageId: "lua",
  fileExtensions: ["lua"],
  allowedHosts: ["example.com"],
  requires: new Map([["env:happyview", ">=3.0.0-alpha.24"]]),
  license: "MIT",
  sections: { description: "Lua scripts.", installation: undefined, security: undefined },
});

const paths = (a: PluginArtifact) => artifactProblems(a).map((p) => p.path);
const has = (a: PluginArtifact, path: string) =>
  expect(paths(a), `${path} missing`).toContain(path);

it("a_valid_interpreter_has_no_problems", () => {
  expect(artifactProblems(valid())).toEqual([]);
});

it("serializes_without_checksums_or_urls", () => {
  const v = o(artifactToValue(valid()));
  expect(v.$type).toBe(ARTIFACT_TYPE);
  expect(v.$type).toBe("at.happyproto.plugin.v1");
  expect(o(v.package).$type).toBe("blob");
  expect(o(o(v.package).ref).$link).toBe(
    "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy",
  );
  expect(o(v.package).mimeType).toBe("application/wasm");
  expect(o(v.package).size).toBe(8);
  expect(o(v.manifest).mimeType).toBe("application/json");
  expect(o(o(v.banner).image).mimeType).toBe("image/png");
  expect(o(v.banner).alt).toBe("the Lua logo");
  const shot = o((v.screenshots as Json[])[0]);
  expect(shot.width).toBe(1);
  expect("alt" in shot).toBe(false);
  expect(v.pluginType).toBe("interpreter");
  expect(v.apiVersion).toBe("2");
  expect(v.languageId).toBe("lua");
  expect(v.fileExtensions).toEqual(["lua"]);
  expect(v.allowedHosts).toEqual(["example.com"]);
  expect(o(v.requires)["env:happyview"]).toBe(">=3.0.0-alpha.24");
  expect(v.license).toBe("MIT");
  expect(o(v.sections).description).toBe("Lua scripts.");
  expect("installation" in o(v.sections)).toBe(false);
  expect("namespace" in v).toBe(false);
  const text = JSON.stringify(v);
  expect(text).not.toContain("checksum");
  expect(text).not.toContain('"url"');
  expect(artifactFromValue(v)).toEqual(valid());
});

it("blank_optional_fields_are_left_out", () => {
  const a = valid();
  a.namespace = "";
  a.languageId = " ";
  a.sections.installation = "";
  const v = o(artifactToValue(a));
  expect("namespace" in v).toBe(false);
  expect("languageId" in v).toBe(false);
  expect("installation" in o(v.sections)).toBe(false);
});

it("capabilities_are_written_even_when_empty", () => {
  const a = valid();
  a.capabilities = [];
  expect(o(artifactToValue(a)).capabilities).toEqual([]);
});

it("from_value_refuses_another_type", () => {
  const v = o(artifactToValue(valid()));
  v.$type = "at.happyproto.plugin.v2";
  expect(err(() => artifactFromValue(v))).toBe(
    'is not an at.happyproto.plugin.v1 (its $type is "at.happyproto.plugin.v2")',
  );
});

it("package_must_be_a_wasm_blob", () => {
  let a = valid();
  a.package = { url: "https://example.com/x.wasm" };
  has(a, "artifact.package");
  a = valid();
  a.package = predictedBlob(WASM, "application/octet-stream");
  has(a, "artifact.package");
});

it("package_at_most_16_mib", () => {
  const a = valid();
  o(a.package).size = MAX_WASM_BYTES + 1;
  has(a, "artifact.package");
  o(a.package).size = MAX_WASM_BYTES;
  expect(artifactProblems(a)).toEqual([]);
});

it("manifest_must_be_a_json_blob_of_at_most_1_mib", () => {
  let a = valid();
  o(a.manifest).mimeType = "text/plain";
  has(a, "artifact.manifest");
  a = valid();
  o(a.manifest).size = MAX_MANIFEST_BYTES + 1;
  has(a, "artifact.manifest");
});

it("images_are_raster_and_at_most_1_mib", () => {
  let a = valid();
  o(a.banner?.blob).mimeType = "image/svg+xml";
  has(a, "artifact.banner.image");
  expect(artifactProblems(a)[0]?.toString()).toBe(
    'artifact.banner.image: is "image/svg+xml"; it must be image/png, image/jpeg, image/webp, image/gif, image/avif',
  );
  a = valid();
  o(a.screenshots[0]?.blob).size = MAX_IMAGE_BYTES + 1;
  has(a, "artifact.screenshots[0].image");
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]) {
    a = valid();
    o(a.screenshots[0]?.blob).mimeType = mime;
    expect(artifactProblems(a), mime).toEqual([]);
  }
});

it("at_most_8_screenshots", () => {
  const a = valid();
  a.screenshots = Array.from({ length: 8 }, () => image());
  expect(artifactProblems(a)).toEqual([]);
  a.screenshots.push(image());
  has(a, "artifact.screenshots");
});

it("alt_text_has_a_limit", () => {
  let a = valid();
  a.banner = image("a".repeat(301));
  has(a, "artifact.banner.alt");
  a = valid();
  // 300 graphemes, but over 3000 bytes
  a.screenshots = [image("👩‍👩‍👧".repeat(300))];
  has(a, "artifact.screenshots[0].alt");
});

it("plugin_type_is_one_of_three", () => {
  const a = valid();
  a.pluginType = "theme";
  has(a, "artifact.pluginType");
});

it("api_version_is_2_or_later_and_short", () => {
  for (const bad of ["1", "1.9", "", "x", `2${"0".repeat(16)}`]) {
    const a = valid();
    a.apiVersion = bad;
    has(a, "artifact.apiVersion");
  }
  const a = valid();
  a.apiVersion = "12.1";
  expect(artifactProblems(a)).toEqual([]);
});

it("capabilities_have_a_limit", () => {
  const a = valid();
  a.capabilities = ["c".repeat(129)];
  has(a, "artifact.capabilities[0]");
});

it("a_library_needs_a_namespace_of_at_most_256", () => {
  const a = valid();
  a.pluginType = "library";
  a.languageId = undefined;
  a.fileExtensions = [];
  has(a, "artifact.namespace");
  a.namespace = "n".repeat(257);
  has(a, "artifact.namespace");
  a.namespace = "happyview.lua";
  expect(artifactProblems(a)).toEqual([]);
});

it("an_interpreter_needs_a_language_id", () => {
  const a = valid();
  a.languageId = undefined;
  has(a, "artifact.languageId");
});

it("an_empty_language_id_or_namespace_counts_as_absent", () => {
  let a = valid();
  a.languageId = "";
  expect(paths(a)).toEqual(["artifact.languageId"]);
  a = valid();
  a.pluginType = "library";
  a.languageId = undefined;
  a.fileExtensions = [];
  a.namespace = " ";
  expect(paths(a)).toEqual(["artifact.namespace"]);
});

it("an_interpreter_needs_1_to_8_file_extensions", () => {
  const a = valid();
  a.fileExtensions = [];
  has(a, "artifact.fileExtensions");
  a.fileExtensions = Array.from({ length: 9 }, (_, i) => `e${i}`);
  has(a, "artifact.fileExtensions");
});

it("file_extensions_have_a_shape", () => {
  for (const bad of [".lua", "LUA", "toolongextension1", "json", ""]) {
    const a = valid();
    a.fileExtensions = [bad];
    has(a, "artifact.fileExtensions[0]");
  }
  const a = valid();
  a.fileExtensions = ["ts", "mts", "ts"];
  expect(paths(a)).toEqual(["artifact.fileExtensions[2]"]);
});

it("allowed_hosts_have_a_limit", () => {
  const a = valid();
  a.allowedHosts = ["h".repeat(257)];
  has(a, "artifact.allowedHosts[0]");
});

it("requires_keys_and_ranges", () => {
  const a = valid();
  a.requires = new Map([
    ["at://did:plc:abc/at.happyproto.plugin.profile/happyview-http", "^1.0"],
    ["env:happyview", "^1 || ^2"],
    ["at://did:plc:abc/software.release.project/happyview-http", "^1.0"],
  ]);
  expect(paths(a)).toEqual([
    'artifact.requires["at://did:plc:abc/at.happyproto.plugin.profile/happyview-http"]',
    'artifact.requires["env:happyview"]',
  ]);
});

it("license_is_required_and_at_most_256", () => {
  const a = valid();
  a.license = " ";
  has(a, "artifact.license");
  a.license = "l".repeat(257);
  has(a, "artifact.license");
});

it("sections_description_is_required", () => {
  const a = valid();
  a.sections.description = "";
  has(a, "artifact.sections.description");
});

it("sections_have_a_limit", () => {
  let a = valid();
  a.sections.installation = "i".repeat(2001);
  has(a, "artifact.sections.installation");
  a = valid();
  a.sections.security = "👩‍👩‍👧".repeat(2000);
  has(a, "artifact.sections.security");
});

it("from_manifest_copies_the_plugin_fields", () => {
  const m = parseManifest(
    `{"id":"happyview-lua","api_version":"2","plugin_type":"interpreter",
      "language_id":"lua","file_extension":"lua","capabilities":["library:call"],
      "allowed_hosts":["example.com"]}`,
  );
  const a = artifactFromManifest(
    m,
    predictedBlob(WASM, WASM_MIME),
    predictedBlob(bytes('{"id":"happyview-lua"}'), MANIFEST_MIME),
    "MIT",
    { description: "Lua scripts.", installation: undefined, security: undefined },
  );
  expect(a).toEqual({ ...valid(), banner: undefined, screenshots: [], requires: new Map() });
});

it("a_library_from_a_manifest_has_no_file_extensions", () => {
  const m = parseManifest(
    `{"id":"x","api_version":"2","plugin_type":"library","namespace":"a.b",
      "extensions":["lua"],"capabilities":[]}`,
  );
  const a = artifactFromManifest(
    m,
    predictedBlob(WASM, WASM_MIME),
    predictedBlob(bytes("{}"), MANIFEST_MIME),
    "MIT",
    {
      description: "",
    },
  );
  expect(a.fileExtensions).toEqual([]);
  expect(a.namespace).toBe("a.b");
});
