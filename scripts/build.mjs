// Bundles src/main.ts into dist/hpy.mjs: one ESM file for `node`, the npm
// package and `bun build --compile`. The two napi addons stay external; they
// are loaded through static imports so Bun embeds them (see src/native.ts).

import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/hpy.mjs",
  external: ["@napi-rs/keyring", "@napi-rs/lzma"],
  define: { HPY_VERSION: JSON.stringify(version) },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __hpyRequire } from "node:module";\nconst require = __hpyRequire(import.meta.url);',
  },
  legalComments: "none",
  logLevel: "warning",
});
