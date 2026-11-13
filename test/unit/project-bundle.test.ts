// crates/hpy/src/project/bundle.rs's tests, then whole bundles of synthetic projects against
// the Rust oracle (test/fixtures/bundle/oracle.json, trees from test/support/bundle-cases.ts).
// The deflate and gzip streams alone are checked in deflate.test.ts.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Failure } from "../../src/core/failure.ts";
import { type Bundle, bundle } from "../../src/project/bundle.ts";
import { TREE_CASES, type TreeCase } from "../support/bundle-cases.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempdir(): string {
  const d = mkdtempSync(join(tmpdir(), "hpy-bundle-"));
  dirs.push(d);
  return d;
}

function write(root: string, rel: string, body: string | Uint8Array): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

function project(): string {
  const root = tempdir();
  write(root, "happyview.toml", '[happyview]\nversion = "3.0.0"\n');
  write(root, "src/lexicons/com/example/hello.json", "{}");
  write(root, "src/lexicons/com/example/hello.lua", "return {}");
  write(root, "src/jobs/sweep.ts", "export default 1");
  write(root, ".env", "SECRET=1");
  write(root, ".happyview/plugins/lua.wasm", "plugin");
  write(root, ".happyview/types/lua/ctx.d.lua", "types");
  write(root, ".happyview/build/counter.wasm", "module");
  write(root, ".happyview/build/stale.wasm", "old module");
  write(root, "README.md", "readme");
  return root;
}

const dec = new TextDecoder();
const cstr = (b: Uint8Array) => {
  const i = b.indexOf(0);
  return dec.decode(i < 0 ? b : b.subarray(0, i));
};

/** Each entry's path and contents, in archive order (ustar prefix and GNU long names). */
function entries(b: Bundle): [string, string][] {
  const tar = new Uint8Array(gunzipSync(b.bytes));
  const out: [string, string][] = [];
  let longName: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const size = Number.parseInt(cstr(h.subarray(124, 136)), 8);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (h[156] === 0x4c) {
      longName = cstr(body);
      continue;
    }
    const prefix = cstr(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/` : "") + cstr(h.subarray(0, 100));
    longName = undefined;
    out.push([name, dec.decode(body)]);
  }
  return out;
}

function failure(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a Failure");
}

describe("bundle.rs", () => {
  it("holds_the_config_the_sources_and_the_module_builds_only", () => {
    const b = bundle(project(), ["counter"]);
    const paths = entries(b).map(([p]) => p);
    expect(paths).toEqual([
      ".happyview/build/counter.wasm",
      "happyview.toml",
      "src/jobs/sweep.ts",
      "src/lexicons/com/example/hello.json",
      "src/lexicons/com/example/hello.lua",
    ]);
    expect(b.files).toEqual(paths);
    expect(b.sha256).toHaveLength(64);
  });

  it("the_same_files_make_the_same_bytes", () => {
    const root = project();
    const first = bundle(root, ["counter"]);
    // Rewriting a file with the same contents changes only its mtime.
    write(root, "src/jobs/sweep.ts", "export default 1");
    const again = bundle(root, ["counter"]);
    expect(again.sha256).toBe(first.sha256);
    expect(again.bytes).toEqual(first.bytes);
    write(root, "src/jobs/sweep.ts", "export default 2");
    expect(bundle(root, ["counter"]).sha256).not.toBe(first.sha256);
  });

  it("a_module_that_was_not_built_is_named", () => {
    const text = failure(() => bundle(project(), ["missing"])).message;
    expect(text).toContain("missing");
    expect(text).toContain("hpy happyview build");
  });

  it.skipIf(process.platform === "win32")("a_symlink_under_src_is_refused", () => {
    const root = project();
    symlinkSync("/etc/passwd", join(root, "src/passwd.lua"));
    const err = failure(() => bundle(root, []));
    expect(err.message).toContain("src/passwd.lua");
    expect(err.message).toContain("symlink");
    expect(err.code).toBe(2);
  });

  it("a_project_without_src_still_bundles_its_config", () => {
    const root = tempdir();
    write(root, "happyview.toml", "");
    expect(bundle(root, []).files).toEqual(["happyview.toml"]);
  });
});

interface Fixture {
  trees: Record<
    string,
    { sha256?: string; len?: number; tar?: string; files?: string[]; error?: string }
  >;
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/bundle/oracle.json", import.meta.url), "utf8"),
);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function makeTree(t: TreeCase): string {
  const root = tempdir();
  for (const [rel, body] of t.files) write(root, rel, body);
  for (const [rel, target] of t.symlinks ?? []) symlinkSync(target, join(root, rel));
  return root;
}

describe("bundle against the Rust oracle", () => {
  it("covers every tree case", () => {
    expect(Object.keys(fixture.trees).sort()).toEqual(TREE_CASES.map((c) => c.name).sort());
  });

  for (const t of TREE_CASES) {
    it.skipIf(t.unixOnly && process.platform === "win32")(`matches Rust for ${t.name}`, () => {
      const want = fixture.trees[t.name]!;
      const root = makeTree(t);
      if (want.error !== undefined) {
        expect(failure(() => bundle(root, t.modules)).message).toBe(want.error);
        return;
      }
      const b = bundle(root, t.modules);
      expect(b.files).toEqual(want.files);
      expect(sha(new Uint8Array(gunzipSync(b.bytes))), "the tar").toBe(want.tar);
      expect(b.bytes.length).toBe(want.len);
      expect(b.sha256).toBe(want.sha256);
      expect(entries(b).map(([p]) => p)).toEqual(want.files);
    });
  }

  it("bundles a few megabytes quickly", () => {
    const t = TREE_CASES.find((c) => c.name === "big-and-empty-files")!;
    const root = makeTree(t);
    const start = performance.now();
    bundle(root, t.modules);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
