// hpy-plugin/src/locate.rs: finding the `.wasm` to publish: `--wasm`, then
// `[build] wasm`, then the manifest's `wasm_file`, then Cargo's target
// directory, which in a workspace is shared and found through `cargo metadata`.
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { rustJoin } from "../core/paths.ts";
import type { Manifest } from "./manifest.ts";

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Throws the reason as a string, as the Rust `Err(String)`. */
export function locateWasm(
  dir: string,
  explicit: string | undefined,
  configured: string | undefined,
  manifest: Manifest,
): string {
  // Relative to the plugin's directory, like everything else: `-C` means "as if started there".
  if (explicit !== undefined) return existing(rustJoin(dir, explicit), "--wasm");
  if (configured !== undefined) return existing(rustJoin(dir, configured), "hpy.toml [build] wasm");
  if (manifest.wasm_file !== undefined) {
    const p = rustJoin(dir, manifest.wasm_file);
    if (isFile(p)) return p;
  }
  if (isFile(rustJoin(dir, "Cargo.toml"))) {
    const t = cargoTarget(dir);
    if (t !== null) {
      const found = cargoCandidates(t.target, t.name);
      if (found.length === 1) return found[0] as string;
      if (found.length > 1)
        throw `found more than one built module; pass --wasm or set [build] wasm in hpy.toml:\n${found.map((p) => `  ${p}`).join("\n")}`;
    }
  }
  const note =
    manifest.wasm_file !== undefined
      ? ` (manifest wasm_file \`${manifest.wasm_file}\` does not exist)`
      : "";
  throw `could not find the plugin's .wasm; build it, then pass --wasm <path> or set [build] wasm in hpy.toml${note}`;
}

function existing(path: string, source: string): string {
  if (isFile(path)) return path;
  throw `${source} points at ${path}, which does not exist`;
}

/** `<target>/wasm32-*\/release/<crate_name>.wasm`, in a stable order. */
export function cargoCandidates(targetDir: string, crateName: string): string[] {
  const file = `${crateName.replaceAll("-", "_")}.wasm`;
  let entries: string[];
  try {
    entries = readdirSync(targetDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.startsWith("wasm32-"))
    .map((e) => rustJoin(targetDir, e, "release", file))
    .filter(isFile)
    .sort();
}

/** Whether two paths name the same file, both canonicalized (cargo reports paths in its own form). */
export function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

/** The target directory and package name for the Cargo package in `dir`. */
function cargoTarget(dir: string): { target: string; name: string } | null {
  let manifestPath: string;
  try {
    manifestPath = realpathSync.native(rustJoin(dir, "Cargo.toml"));
  } catch {
    return null;
  }
  const r = spawnSync(
    process.env.CARGO ?? "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--offline",
      "--manifest-path",
      manifestPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0) return null;
  try {
    const meta = JSON.parse(r.stdout) as {
      target_directory?: unknown;
      packages?: { manifest_path?: unknown; name?: unknown }[];
    };
    if (typeof meta.target_directory !== "string" || !Array.isArray(meta.packages)) return null;
    const pkg = meta.packages.find(
      (p) => typeof p.manifest_path === "string" && sameFile(p.manifest_path, manifestPath),
    );
    if (!pkg || typeof pkg.name !== "string") return null;
    return { target: meta.target_directory, name: pkg.name };
  } catch {
    return null;
  }
}
