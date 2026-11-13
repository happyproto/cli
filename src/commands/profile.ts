// crates/hpy/src/commands/profile.rs: a plugin's project as a whole, `[project]` in hpy.toml,
// and the project, publication and sidecar records `putProject` writes from it.
import { Failure } from "../core/failure.ts";
import { hpyName, loadHpyToml } from "../plugin/config.ts";
import { loadManifest, type Manifest } from "../plugin/manifest.ts";
import { isProjectName } from "../plugin/validate.ts";

/** The project name: `--name`, else hpy.toml's `[project] name`, else the manifest's `id`. */
export function resolveName(dir: string, flag: string | undefined): string {
  let name: string;
  if (flag !== undefined) {
    name = flag;
  } else {
    let manifest: Manifest | undefined;
    try {
      manifest = loadManifest(dir);
    } catch {
      manifest = undefined;
    }
    let toml: ReturnType<typeof loadHpyToml>;
    try {
      toml = loadHpyToml(dir);
    } catch (e) {
      throw Failure.from(e);
    }
    const found = hpyName(toml ?? {}, manifest);
    if (found === undefined) {
      throw Failure.usage(
        "no project name: pass --name, or run in a directory with manifest.json or hpy.toml",
      );
    }
    name = found;
  }
  if (!isProjectName(name)) {
    throw Failure.usage(
      `\`${name}\` is not a project name: 1 to 64 lowercase letters, digits and interior \`-\``,
    );
  }
  return name;
}
