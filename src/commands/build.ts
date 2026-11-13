// crates/hpy/src/commands/happyview/build.rs: `hpy hv build`, every module in the project.
import type { Ctx } from "../core/ctx.ts";
import type { Json } from "../core/output.ts";
import { rustComponents } from "../core/paths.ts";
import { buildAll, Toolchain } from "../project/modules.ts";
import { projectRoot } from "../project/prepare.ts";

/** `Path::strip_prefix(base)` displayed, or `path` itself when it is not under `base`. */
function stripPrefix(path: string, base: string): string {
  const p = rustComponents(path);
  const b = rustComponents(base);
  if (b.length > p.length || b.some((c, i) => c !== p[i])) return path;
  return p.slice(b.length).join(process.platform === "win32" ? "\\" : "/");
}

export async function run(ctx: Ctx): Promise<void> {
  const root = projectRoot(ctx);
  const built = await buildModules(root);
  if (built.length === 0) {
    ctx.out.done("no [modules] in happyview.toml; nothing to build", { modules: [] });
    return;
  }
  const lines = built.map(([name, path]) => `built ${name} → ${stripPrefix(path, root)}`);
  const modules: Json[] = built.map(([name, path]) => ({ name, path }));
  ctx.out.done(lines.join("\n"), { modules });
}

/** Every module in the project at `root`, built. */
export function buildModules(root: string): Promise<[string, string][]> {
  return buildAll(Toolchain.fromEnv(), root);
}
