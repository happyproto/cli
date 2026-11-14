// Bundles src/main.ts into dist/hpy.mjs: one ESM file for `node`, the npm
// package and `bun build --compile`. The two napi addons stay external; they
// are loaded through static imports so Bun embeds them (see src/native.ts).

import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { version, name } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/hpy.mjs",
  external: ["@napi-rs/keyring", "@napi-rs/lzma"],
  define: { HPY_VERSION: JSON.stringify(version), HPY_PACKAGE_NAME: JSON.stringify(name) },
  banner: {
    // Plain `env node`: BusyBox's env (Alpine, where npm is the natural install) has no `-S`, so
    // `env -S node --` would not start at all. The cost: Node (22 to 26) also reads a
    // `--env-file` that comes after the script, so under the npm package `hv env push
    // --env-file x` loads x into hpy's own environment too, and a missing x is Node's error
    // (exit 9) rather than hpy's. The Bun binaries are unaffected.
    js: '#!/usr/bin/env node\nimport { createRequire as __hpyRequire } from "node:module";\nconst require = __hpyRequire(import.meta.url);',
  },
  legalComments: "none",
  logLevel: "warning",
});
