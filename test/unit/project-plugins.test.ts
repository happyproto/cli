// crates/hpy/src/project/plugins.rs tests.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Failure } from "../../src/core/failure.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import { ProjectToml } from "../../src/project/config.ts";
import type { LockedPlugin } from "../../src/project/lock.ts";
import { ensurePlugin, PUBLISHED_MANIFEST } from "../../src/project/plugins.ts";
import { resolveLock } from "../../src/project/resolve.ts";
import { interpreterExt, privateTempdir, RegistryFixture } from "../support/fakes.ts";

const HV = "did:plc:hv";
const b = (s: string) => new TextEncoder().encode(s);

async function locked(reg: RegistryFixture): Promise<LockedPlugin> {
  const cfg = ProjectToml.parse(
    `[happyview]\nversion = "3.0.0"\n[interpreters]\nlua = { did = "${HV}", name = "happyview-lua", channel = "latest" }\n`,
  );
  const lock = await resolveLock({ registry: reg, warn: () => {} }, cfg, undefined);
  return lock.plugins[0]!;
}

function registry(): RegistryFixture {
  const reg = new RegistryFixture();
  reg.publishWithManifest(
    HV,
    "happyview-lua",
    "1.0.0",
    interpreterExt("lua", "lua"),
    {},
    "\0asm lua",
    '{"id":"happyview-lua","supports_libraries":["happyview.http"]}',
  );
  reg.projects[0]!.publication.name = "Lua";
  return reg;
}

const installed = (dir: string) => existsSync(dir);

async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Failure);
    return e as Failure;
  }
  throw new Error("expected a failure");
}

it("downloads_verifies_and_writes_the_manifest", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  const dir = await ensurePlugin(reg, cache, p);
  expect(dir).toBe(join(cache, "plugins/happyview-lua/1.0.0"));
  expect(readFileSync(join(dir, "happyview-lua.wasm"))).toEqual(Buffer.from("\0asm lua"));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(manifest.language_id).toBe("lua");
  expect(manifest.name).toBe("Lua");
  expect(manifest.wasm_file).toBe("happyview-lua.wasm");
  expect(manifest.supports_libraries).toEqual(["happyview.http"]);
  expect(rawCid(readFileSync(join(dir, PUBLISHED_MANIFEST)))).toBe(p.manifest_blob_cid);
});

it("a_cache_hit_asks_the_registry_nothing", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  await ensurePlugin(reg, cache, p);
  reg.calls.length = 0;
  await ensurePlugin(reg, cache, p);
  expect(reg.calls).toEqual([]);
});

it("a_tampered_cache_entry_is_fetched_again", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  const dir = await ensurePlugin(reg, cache, p);
  for (const [file, junk] of [
    ["happyview-lua.wasm", "tampered"],
    ["manifest.json", '{"capabilities":["everything"]}'],
    [PUBLISHED_MANIFEST, "{}"],
  ] as const) {
    const original = readFileSync(join(dir, file));
    writeFileSync(join(dir, file), junk);
    reg.calls.length = 0;
    await ensurePlugin(reg, cache, p);
    expect(readFileSync(join(dir, file)), file).toEqual(original);
    expect(reg.calls.length, file).toBeGreaterThan(0);
  }
});

it("module_bytes_that_do_not_match_their_cid_install_nothing", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  reg.blobs.set(p.package_cid, b("evil"));
  const err = await failure(ensurePlugin(reg, cache, p));
  expect(err.message).toContain(p.package_cid);
  expect(err.message).toContain(rawCid(b("evil")));
  expect(installed(join(cache, "plugins/happyview-lua/1.0.0"))).toBe(false);
});

it("manifest_bytes_that_do_not_match_their_cid_install_nothing", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  reg.blobs.set(p.manifest_blob_cid, b('{"supports_libraries":["*"]}'));
  const err = await failure(ensurePlugin(reg, cache, p));
  expect(err.message).toContain(p.manifest_blob_cid);
  expect(err.message).toContain("manifest.json");
  expect(installed(join(cache, "plugins/happyview-lua/1.0.0"))).toBe(false);
});

it("a_version_whose_manifest_record_changed_is_refused", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  p.manifest_cid = "bafyreisomethingelse";
  const err = await failure(ensurePlugin(reg, cache, p));
  expect(err.message).toBe("the registry's happyview-lua 1.0.0 no longer matches happyview.lock");
});

it("a_version_the_registry_no_longer_has_is_named", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  reg.versions.clear();
  const err = await failure(ensurePlugin(reg, cache, p));
  expect(err.message).toContain("happyview-lua@1.0.0");
});

it("a_lock_naming_a_path_is_refused", async () => {
  const reg = registry();
  const cache = privateTempdir();
  const p = await locked(reg);
  p.version = "../../x";
  const err = await failure(ensurePlugin(reg, cache, p));
  expect(err.code).toBe(2);
});

it.skipIf(process.platform === "win32")("a_symlinked_cache_root_is_refused", async () => {
  const reg = registry();
  const base = mkdtempSync(join(tmpdir(), "hpy-plugins-"));
  mkdirSync(join(base, "real"));
  symlinkSync(join(base, "real"), join(base, "link"));
  const p = await locked(reg);
  const err = await failure(ensurePlugin(reg, join(base, "link"), p));
  expect(err.message).toContain("cannot be trusted");
  // Refused before anything was made through the link.
  expect(readdirSync(join(base, "real")).length).toBe(0);
});
