#!/usr/bin/env node
// Writes src/project/templates.json from src/project/templates/*: the files hpy-project embedded
// with `include_str!`, as one JSON object the bundle imports. Rerun after editing a template.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../src/project/templates/", import.meta.url);
const out = {};
for (const name of readdirSync(dir).sort()) out[name] = readFileSync(new URL(name, dir), "utf8");
writeFileSync(
  new URL("../src/project/templates.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
