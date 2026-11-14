#!/usr/bin/env node
// Writes src/help-order.json: for each command, the order clap lists its
// options in, read from the Rust binary's `-h` output in test/fixtures/help.
// clap interleaves the propagated globals (--json, --no-input, -C) with each
// command's own arguments in an order that is simpler to record than to derive.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../test/fixtures/help/", import.meta.url);
const out = {};
for (const f of readdirSync(dir)
  .filter((f) => f.endsWith(".short.txt"))
  .sort()) {
  const path = f.replace(/\.short\.txt$/, "").replaceAll("_", " ");
  const text = readFileSync(new URL(f, dir), "utf8");
  const opts = text.split("\nOptions:\n")[1] ?? "";
  out[path] = opts
    .split("\n")
    .map((l) => l.match(/^ {2}(?:(-[A-Za-z])(?:, )?)?(?: {4})?(--[a-z-]+)?/))
    .filter((m) => m && (m[1] || m[2]))
    .map((m) => m[2] ?? m[1]);
}
writeFileSync(
  new URL("../src/help-order.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
