#!/usr/bin/env node
// Runs every case in cases.txt against the Rust hpy and the TypeScript one,
// each in a fresh HOME, and diffs exit code, stdout and stderr byte for byte.
//
//   RUST_HPY=/path/to/rust/hpy node test/parity/run.mjs [--offline] [--ts "node dist/hpy.mjs"] [filter]
//
// Exits 1 when any case's exit code or stdout differs. stderr differences are
// listed but do not fail the run unless --strict-stderr is given.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const fixtures = join(root, "test/fixtures/credentials");
const args = process.argv.slice(2);
const flag = (f) => {
  const i = args.indexOf(f);
  if (i === -1) return undefined;
  args.splice(i, 1);
  return true;
};
const opt = (f) => {
  const i = args.indexOf(f);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const offline = flag("--offline");
const strictStderr = flag("--strict-stderr");
const tsCmd = (opt("--ts") ?? `node ${join(root, "dist/hpy.mjs")}`).split(" ");
const rust = process.env.RUST_HPY;
if (!rust) {
  console.error("set RUST_HPY to a Rust hpy binary (see HANDOFF.md)");
  process.exit(2);
}
const filter = args[0];

const cases = readFileSync(join(here, "cases.txt"), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"));

function run(cmd, line) {
  const [pre, argvText] = line.split(" -- ");
  const tags = (pre.startsWith("--") ? "" : pre).split(" ").filter(Boolean);
  const argv = (line.startsWith("-- ") ? line.slice(3) : argvText).split(" ").filter(Boolean);
  const home = mkdtempSync(join(tmpdir(), "hpy-parity-"));
  const config = join(home, ".config");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    HPY_NO_UPDATE_CHECK: "1",
    HPY_CREDENTIAL_STORE: "file",
  };
  for (const t of tags) {
    if (t === "@cred") env.HPY_CREDENTIAL = readFileSync(join(fixtures, "HPY_CREDENTIAL"), "utf8");
    else if (t === "@file") {
      mkdirSync(join(config, "hpy"), { recursive: true });
      copyFileSync(join(fixtures, "credentials.file.json"), join(config, "hpy/credentials.json"));
    } else if (t === "@net") {
    } else if (t.includes("=")) {
      const [k, ...v] = t.split("=");
      env[k] = v.join("=");
    }
  }
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...argv], {
    env,
    cwd: home,
    input: "",
    encoding: "utf8",
  });
  rmSync(home, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.replaceAll(home, "$HOME") };
}

let failed = 0;
let stderrOnly = 0;
for (const line of cases) {
  if (filter && !line.includes(filter)) continue;
  if (offline && line.includes("@net")) continue;
  const a = run([rust], line);
  const b = run(tsCmd, line);
  const same = a.code === b.code && a.stdout === b.stdout;
  const errSame = a.stderr === b.stderr;
  if (same && errSame) {
    console.log(`ok      ${line}`);
    continue;
  }
  if (same) {
    stderrOnly++;
    console.log(`stderr  ${line}`);
  } else {
    failed++;
    console.log(`FAIL    ${line}`);
    if (a.code !== b.code) console.log(`        exit: rust ${a.code}, ts ${b.code}`);
    if (a.stdout !== b.stdout)
      console.log(`        stdout:\n--- rust\n${a.stdout}--- ts\n${b.stdout}---`);
  }
  if (!errSame) console.log(`        stderr:\n--- rust\n${a.stderr}--- ts\n${b.stderr}---`);
}
console.log(`\n${cases.length} cases: ${failed} failing, ${stderrOnly} differing only on stderr`);
process.exit(failed > 0 || (strictStderr && stderrOnly > 0) ? 1 : 0);
