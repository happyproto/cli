// hpy-plugin's manifest.rs and validate.rs tests.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadManifest,
  manifest,
  manifestProblems,
  parseManifest,
} from "../../src/plugin/manifest.ts";
import type { Problem } from "../../src/plugin/problem.ts";
import {
  graphemes,
  isDid,
  isProjectName,
  parseProjectUri,
  projectUri,
  rangeProblem,
  requiresKeyProblem,
  versionProblem,
  versionUri,
} from "../../src/plugin/validate.ts";

const paths = (ps: Problem[]) => ps.map((p) => p.path);
const problemOf = (f: () => unknown): Problem => {
  try {
    f();
  } catch (e) {
    return e as Problem;
  }
  throw new Error("expected a problem");
};

describe("manifest.rs", () => {
  const ATPROTO = `{
      "id": "happyview-atproto", "name": "Atproto", "version": "0.1.0",
      "api_version": "2", "plugin_type": "library", "namespace": "happyview.atproto",
      "description": "AT Protocol helpers.", "capabilities": ["atproto:read", "attest:sign"],
      "allowed_hosts": [], "dependencies": [], "wasm_file": "happyview-atproto.wasm"
    }`;

  it("a_valid_library_has_no_problems", () => {
    expect(manifestProblems(parseManifest(ATPROTO))).toEqual([]);
  });

  it("file_extensions_have_a_shape", () => {
    const m = parseManifest(
      `{"id":"x","api_version":"2","plugin_type":"interpreter","language_id":"x",
        "extensions":[".lua","LUA","toolongextension1","json"],"capabilities":[]}`,
    );
    expect(paths(manifestProblems(m))).toEqual([
      "manifest.extensions[0]",
      "manifest.extensions[1]",
      "manifest.extensions[2]",
      "manifest.extensions[3]",
    ]);
  });

  it("a_repeated_extension_is_refused", () => {
    const m = parseManifest(
      `{"id":"x","api_version":"2","plugin_type":"interpreter","language_id":"x",
        "extensions":["ts","mts","ts"],"capabilities":[]}`,
    );
    expect(paths(manifestProblems(m))).toEqual(["manifest.extensions[2]"]);
  });

  it("interpreter_needs_language_id", () => {
    const m = parseManifest(
      `{"id":"x","api_version":"2","plugin_type":"interpreter","capabilities":[]}`,
    );
    expect(paths(manifestProblems(m))).toContain("manifest.language_id");
  });

  it("rejects_old_api_and_unknown_type_and_missing_capabilities", () => {
    const m = parseManifest(`{"id":"x","api_version":"1","plugin_type":"theme"}`);
    const ps = manifestProblems(m);
    expect(paths(ps)).toEqual(
      expect.arrayContaining([
        "manifest.api_version",
        "manifest.plugin_type",
        "manifest.capabilities",
      ]),
    );
    // Rust's `{:?}` of the Option.
    expect(ps[0]?.toString()).toBe(
      'manifest.plugin_type: must be auth, library or interpreter (got Some("theme"))',
    );
  });

  it("language_id_shape", () => {
    const m = parseManifest(
      `{"id":"x","api_version":"2","plugin_type":"interpreter","language_id":"Lua","capabilities":[]}`,
    );
    expect(paths(manifestProblems(m))).toContain("manifest.language_id");
  });

  it("load_reports_missing_and_malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "hpy-manifest-"));
    expect(problemOf(() => loadManifest(dir)).problem).toContain("no manifest.json");
    writeFileSync(join(dir, "manifest.json"), "{");
    const p = problemOf(() => loadManifest(dir));
    // serde_json's own words, as Rust prints them.
    expect(p.problem).toBe("is not valid: EOF while parsing an object at line 1 column 1");
    writeFileSync(join(dir, "manifest.json"), ATPROTO);
    expect(loadManifest(dir).id).toBe("happyview-atproto");
  });

  it("lexicon_length_limits", () => {
    const long = (n: number) => "x".repeat(n);
    const m = manifest({
      id: "x",
      api_version: `2${long(16)}`,
      plugin_type: "library",
      namespace: long(257),
      capabilities: [long(129)],
      allowed_hosts: [long(257)],
    });
    const got = paths(manifestProblems(m));
    for (const want of [
      "manifest.api_version",
      "manifest.namespace",
      "manifest.capabilities[0]",
      "manifest.allowed_hosts[0]",
    ])
      expect(got, `${want} missing`).toContain(want);
  });
});

describe("validate.rs", () => {
  it("project_names", () => {
    for (const ok of ["a", "happyview-lua", "0", "a-b-c", "a".repeat(64)])
      expect(isProjectName(ok), ok).toBe(true);
    for (const bad of ["", "-a", "a-", "A", "a.b", "a:b", "a_b", "a".repeat(65)])
      expect(isProjectName(bad), bad).toBe(false);
  });

  it("versions", () => {
    for (const ok of [
      "1.2.0",
      "1.2.0-alpha.3",
      "0.0.0",
      "10.20.30-rc-1.x",
      "1.0.0-0",
      "1.0.0-alpha.0",
      "1.0.0-0a",
      "1.0.0-alpha.10",
    ])
      expect(versionProblem(ok), ok).toBeNull();
    expect(versionProblem("v1.2.0")).toContain("`v`");
    expect(versionProblem("1.2.0+b")).toContain("build metadata");
    for (const bad of [
      "1.2",
      "1.2.0-Alpha",
      "01.2.3",
      "1.2.0-",
      "1.2.0-a..b",
      "1.2.x",
      "1.0.0-alpha.01",
      "1.0.0-01",
      "1.0.0-00",
    ])
      expect(versionProblem(bad), bad).not.toBeNull();
    expect(versionProblem(`1.0.0-${"a".repeat(59)}`)).toContain("64");
  });

  it("ranges", () => {
    expect(rangeProblem(">=3.0.0")).toBeNull();
    expect(rangeProblem("^0.1")).toBeNull();
    expect(rangeProblem(">=1.0, <2.0")).toBeNull();
    expect(rangeProblem("*")).toBeNull();
    expect(rangeProblem("^1 || ^2")).toContain("||");
    expect(rangeProblem("")).not.toBeNull();
    // semver's own words, as Rust prints them.
    expect(rangeProblem("latest")).toBe(
      "`latest` is not a semver range: unexpected character 'l' while parsing major version number",
    );
  });

  it("requires_keys", () => {
    expect(requiresKeyProblem("env:happyview")).toBeNull();
    expect(
      requiresKeyProblem("at://did:plc:abc123/software.release.project/happyview-http"),
    ).toBeNull();
    expect(
      requiresKeyProblem("at://did:plc:abc123/at.happyproto.plugin.profile/happyview-http"),
    ).not.toBeNull();
    expect(requiresKeyProblem("env:")).not.toBeNull();
    expect(requiresKeyProblem("happyview-http")).not.toBeNull();
    expect(requiresKeyProblem("at://notadid/software.release.project/x")).not.toBeNull();
    expect(requiresKeyProblem("at://did:plc:abc/software.release.project/Bad")).not.toBeNull();
  });

  it("uris", () => {
    expect(projectUri("did:plc:abc", "happyview-lua")).toBe(
      "at://did:plc:abc/software.release.project/happyview-lua",
    );
    expect(versionUri("did:plc:abc", "happyview-lua", "1.2.0")).toBe(
      "at://did:plc:abc/software.release.version/happyview-lua.1.2.0",
    );
    expect(parseProjectUri("at://did:plc:abc/software.release.project/happyview-lua")).toEqual([
      "did:plc:abc",
      "happyview-lua",
    ]);
    expect(parseProjectUri("at://did:plc:abc/software.release.version/x:1.0.0")).toBeNull();
    expect(parseProjectUri("did:plc:abc/software.release.project/x")).toBeNull();
  });

  it("dids", () => {
    expect(isDid("did:plc:4jrld6fwpnwqehtce56qshzv")).toBe(true);
    expect(isDid("did:web:example.com")).toBe(true);
    expect(isDid("did:PLC:abc")).toBe(false);
    expect(isDid("did:plc:abc:")).toBe(false);
    expect(isDid("plc:abc")).toBe(false);
  });

  it("grapheme_count", () => {
    expect(graphemes("abc")).toBe(3);
    expect(graphemes("👩‍👩‍👧")).toBe(1);
  });
});
