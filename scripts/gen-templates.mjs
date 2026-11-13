#!/usr/bin/env node
// Writes src/project/templates.json from src/project/templates/* (the files hpy-project embedded
// with `include_str!`) and src/project/network/templates.json from src/project/network/templates/*
// (crates/hpy/templates/network), each as one JSON object the bundle imports. Rerun after
// editing a template.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

for (const base of ["../src/project/", "../src/project/network/"]) {
  const dir = new URL(`${base}templates/`, import.meta.url);
  const out = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(new URL(name, dir), "utf8");
  writeFileSync(
    new URL(`${base}templates.json`, import.meta.url),
    `${JSON.stringify(out, null, 2)}\n`,
  );
}
