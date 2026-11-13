// The release configuration agrees with itself: one version (D9) and one set of
// targets across package.json, package-lock.json, dist.toml,
// dist-workspace.toml and scripts/build-bun.mjs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));

/** The quoted strings of a TOML array `key = [ … ]`. */
function tomlArray(text: string, key: string): string[] {
  const m = text.match(new RegExp(`^${key} = \\[([^\\]]*)\\]`, "m"));
  if (!m) throw new Error(`no ${key} array`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("release configuration", () => {
  it("has one version in package.json, package-lock.json and dist.toml", () => {
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(read("dist.toml")).toMatch(new RegExp(`^version = "${pkg.version}"$`, "m"));
  });

  it("keeps the dist package name the Rust releases used (D3)", () => {
    expect(read("dist.toml")).toMatch(/^name = "hpy-cli"$/m);
    expect(tomlArray(read("dist.toml"), "binaries")).toEqual(["hpy"]);
  });

  it("builds a Bun binary for every dist target", () => {
    const dist = tomlArray(read("dist-workspace.toml"), "targets");
    const script = read("scripts/build-bun.mjs");
    const block = script.slice(script.indexOf("export const TARGETS"), script.indexOf("};"));
    const bun = [...block.matchAll(/^ {2}"([^"]+)": \{/gm)].map((m) => m[1]);
    expect(bun.sort()).toEqual([...dist].sort());
  });

  it("publishes the npm package with only the bundle", () => {
    expect(pkg.bin).toEqual({ hpy: "dist/hpy.mjs" });
    // npm adds package.json, README.md and a LICENSE file itself; dist/bun's
    // binaries stay out.
    expect(pkg.files).toEqual(["dist/hpy.mjs"]);
    // @napi-rs/lzma's own range: npm skips its binding on any Node outside it.
    expect(pkg.engines.node).toBe("^22.20 || ^24.12 || >=25");
  });
});
