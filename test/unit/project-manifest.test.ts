// hpy-project/src/manifest.rs tests.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Json } from "../../src/core/output.ts";
import {
  artifactFromManifest,
  artifactFromValue,
  type PluginArtifact,
} from "../../src/plugin/artifact.ts";
import { manifestProblems, parseManifest } from "../../src/plugin/manifest.ts";
import type { Problem } from "../../src/plugin/problem.ts";
import {
  happyviewRequirement,
  type Published,
  projectRequirements,
  synthesize,
} from "../../src/project/manifest.ts";

const DID = "did:plc:abc";

type O = { [key: string]: Json };

function artifact(fields: O, requires: O): PluginArtifact {
  const value: O = {
    $type: "at.happyproto.plugin.v1",
    package: {
      $type: "blob",
      ref: { $link: "bafkreipkg" },
      mimeType: "application/wasm",
      size: 1,
    },
    manifest: {
      $type: "blob",
      ref: { $link: "bafkreiman" },
      mimeType: "application/json",
      size: 1,
    },
    capabilities: [],
    license: "MIT",
    sections: { description: "d" },
    requires,
  };
  for (const [k, v] of Object.entries(fields)) value[k] = v;
  return artifactFromValue(value);
}

function published(name: string, a: PluginArtifact, manifest: Json): Published {
  return { did: DID, name, version: "1.4.2", artifact: a, manifest };
}

function problem(f: () => unknown): Problem {
  try {
    f();
  } catch (e) {
    return e as Problem;
  }
  throw new Error("expected a problem");
}

it("an_interpreter_manifest_carries_its_language_and_extensions", () => {
  const a = artifact(
    {
      pluginType: "interpreter",
      apiVersion: "2",
      languageId: "lua",
      fileExtensions: ["lua"],
      capabilities: ["library:call", "script:host"],
    },
    { "env:happyview": ">=3.0.0" },
  );
  const m = synthesize({
    ...published("happyview-lua", a, {}),
    displayName: "Lua",
    description: "Lua 5.4 for HappyView scripts.",
  });
  expect(m).toEqual({
    id: "happyview-lua",
    name: "Lua",
    version: "1.4.2",
    description: "Lua 5.4 for HappyView scripts.",
    api_version: "2",
    plugin_type: "interpreter",
    language_id: "lua",
    monaco_language: "lua",
    extensions: ["lua"],
    file_extension: "lua",
    capabilities: ["library:call", "script:host"],
    allowed_hosts: [],
    dependencies: [],
    publisher: "did:plc:abc",
    wasm_file: "happyview-lua.wasm",
  });
});

it("a_library_manifest_has_the_exact_shape_happyview_loads", () => {
  const a = artifact(
    {
      pluginType: "library",
      apiVersion: "2",
      namespace: "happyview.record",
      capabilities: ["records:read"],
      allowedHosts: ["api.example.com"],
    },
    {
      "env:happyview": ">=3.0.0",
      "at://did:plc:abc/software.release.project/happyview-db": "^0.1",
    },
  );
  expect(synthesize(published("happyview-record", a, {}))).toEqual({
    id: "happyview-record",
    name: "happyview-record",
    version: "1.4.2",
    api_version: "2",
    plugin_type: "library",
    namespace: "happyview.record",
    capabilities: ["records:read"],
    allowed_hosts: ["api.example.com"],
    dependencies: [{ id: "happyview-db", version: "^0.1" }],
    publisher: "did:plc:abc",
    wasm_file: "happyview-record.wasm",
  });
});

it("only_a_library_carries_dependencies", () => {
  const a = artifact(
    { pluginType: "interpreter", apiVersion: "2", languageId: "lua", fileExtensions: ["lua"] },
    { "at://did:plc:abc/software.release.project/happyview-db": "^0.1" },
  );
  const m = synthesize(published("happyview-lua", a, {})) as O;
  expect(m.dependencies).toEqual([]);
});

it("the_published_manifest_supplies_the_library_list", () => {
  const a = artifact(
    { pluginType: "interpreter", apiVersion: "2", languageId: "lua", fileExtensions: ["lua"] },
    {},
  );
  const shipped = { supports_libraries: ["happyview.http"], capabilities: ["everything"] };
  const m = synthesize(published("happyview-lua", a, shipped)) as O;
  expect(m.supports_libraries).toEqual(["happyview.http"]);
  // Everything else comes from the artifact the registry validated.
  expect(m.capabilities).toEqual([]);
});

it("an_interpreter_without_file_extensions_is_refused", () => {
  const a = artifact({ pluginType: "interpreter", apiVersion: "2", languageId: "lua" }, {});
  const err = problem(() => synthesize(published("happyview-lua", a, {})));
  expect(err.problem).toContain("no file extensions");
});

it("requires_splits_into_projects_and_happyview", () => {
  const a = artifact(
    { pluginType: "library", apiVersion: "2", namespace: "x" },
    {
      "env:happyview": ">=3.0.0",
      "env:other": "1",
      "at://did:plc:abc/software.release.project/happyview-db": "^0.1",
    },
  );
  expect(projectRequirements(a)).toEqual([
    ["at://did:plc:abc/software.release.project/happyview-db", "^0.1"],
  ]);
  expect(happyviewRequirement(a)).toBe(">=3.0.0");
});

it("a_name_that_could_leave_the_plugin_directory_is_refused", () => {
  const a = artifact({ pluginType: "library", apiVersion: "2", namespace: "x" }, {});
  for (const name of ["../evil", "a/b", "a\\b", "..", ".hidden", ""]) {
    const err = problem(() => synthesize(published(name, a, {})));
    expect(err.problem, name).toContain("not a project name");
  }
});

// Pins the round trip against the real interpreter manifest: publishing it yields this
// artifact, and rebuilding from that must give the manifest back. A field HappyView needs that
// neither the artifact nor the shipped manifest carries shows up here as a difference.
it("the_real_lua_manifest_survives_a_publish_and_rebuild", () => {
  const text = readFileSync(
    new URL("../fixtures/project/happyview-lua-manifest.json", import.meta.url),
    "utf8",
  );
  const original = JSON.parse(text) as O;
  const parsed = parseManifest(text);
  expect(manifestProblems(parsed)).toEqual([]);
  const a = artifactFromManifest(parsed, {}, {}, "MIT", { description: "" });
  const rebuilt = synthesize({
    did: DID,
    name: "happyview-lua",
    version: original.version as string,
    artifact: a,
    displayName: original.name as string | undefined,
    description: original.description as string | undefined,
    manifest: original,
  }) as O;
  expect(rebuilt.publisher).toBe("did:plc:abc");
  delete rebuilt.publisher;
  expect(rebuilt).toEqual(original);
});
