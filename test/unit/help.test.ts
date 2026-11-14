// Every command's `-h` and `--help`, against what the Rust hpy printed (test/fixtures/help).
import { readdirSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildCli } from "../../src/cli.ts";
import { renderHelp } from "../../src/help.ts";

const dir = new URL("../fixtures/help/", import.meta.url);
const root = buildCli("0.0.0", () => {});

function find(path: string[]): Command {
  let c: Command = root;
  for (const name of path.slice(1)) {
    const next = c.commands.find((s) => s.name() === name);
    if (!next) throw new Error(`no command ${path.join(" ")}`);
    c = next;
  }
  return c;
}

describe("help matches clap's", () => {
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()) {
    const [name, kind] = f.split(".") as [string, string];
    it(`${name.replaceAll("_", " ")} ${kind === "long" ? "--help" : "-h"}`, () => {
      const want = readFileSync(new URL(f, dir), "utf8");
      expect(renderHelp(find(name.split("_")), kind === "long", 100)).toBe(want);
    });
  }
});
