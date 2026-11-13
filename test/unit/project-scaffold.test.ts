// hpy-project/src/scaffold.rs tests.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { samePath } from "../../src/core/paths.ts";
import { parseValue, toPlain } from "../../src/core/serde-json.ts";
import { get, parseTable, type TomlTable, type TomlValue } from "../../src/core/toml.ts";
import type { Problem } from "../../src/plugin/problem.ts";
import { Pin, type PluginEntry, ProjectToml } from "../../src/project/config.ts";
import {
  ProjectFile,
  renderScaffold,
  type Scaffold,
  STARTER_NSID,
  writeNew,
} from "../../src/project/scaffold.ts";

const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-project-scaffold-"));
const unix = process.platform !== "win32";
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

const entry = (name: string, channel: string): PluginEntry => ({
  did: "did:plc:happyview",
  name,
  pin: Pin.channel(channel),
});

function scaffold(language: string | undefined): Scaffold {
  return {
    appName: 'Jo\'s "App"',
    superadmin: "did:plc:abc",
    happyviewVersion: "3.0.0",
    interpreters: new Map([["lua", entry("happyview-lua", "latest")]]),
    libraries: new Map([["happyview.http", entry("happyview-http", "beta")]]),
    handlerLanguage: language,
  };
}

const file = (files: [string, string][], path: string) =>
  files.find(([p]) => samePath(p, path))?.[1];

/** `toml::Value` indexing: `raw["a"]["b"]`, `undefined` where Rust's `get` is `None`. */
const at = (v: TomlValue | TomlTable | undefined, ...keys: (string | number)[]) => {
  let cur: TomlValue | TomlTable | undefined = v;
  for (const k of keys) {
    if (typeof k === "number") {
      cur = cur && !(cur instanceof Map) && cur.type === "array" ? cur.value[k] : undefined;
    } else {
      cur = get(cur, k);
    }
  }
  return cur as TomlValue | undefined;
};
const scalar = (v: TomlValue | undefined) => v?.value;

function problem(f: () => unknown): Problem {
  try {
    f();
  } catch (e) {
    return e as Problem;
  }
  throw new Error("expected a problem");
}

it("renders_a_toml_happyview_and_hpy_can_both_read", () => {
  const files = renderScaffold(scaffold("lua"));
  const text = file(files, "happyview.toml")!;
  const cfg = ProjectToml.parse(text);
  expect(cfg.happyviewVersion()).toBe("3.0.0");
  expect(cfg.libraries.get("happyview.http")).toEqual(entry("happyview-http", "beta"));
  expect(cfg.interpreters.get("lua")).toEqual(entry("happyview-lua", "latest"));
  const raw = parseTable(text);
  expect(scalar(at(raw, "instance", "app_name"))).toBe('Jo\'s "App"');
  expect(scalar(at(raw, "instance", "superadmin"))).toBe("did:plc:abc");
  expect(scalar(at(raw, "dev", "backfill"))).toBe(false);
});

it("a_pulled_file_writes_only_the_tables_it_has", () => {
  const f = new ProjectFile({
    happyviewVersion: "3.0.0",
    superadmin: "did:plc:abc",
    interpreters: new Map([["lua", entry("happyview-lua", "alpha")]]),
  });
  const bare = f.render();
  const rawBare = parseTable(bare);
  expect(at(rawBare, "instance", "app_name"), bare).toBeUndefined();
  for (const absent of ["lexicons", "scripts", "modules", "labels", "network_lexicons"]) {
    expect(rawBare.get(absent), `${absent}: ${bare}`).toBeUndefined();
  }
  f.appName = "App";
  f.networkLexicons = ["com.other.post"];
  f.labels = ["did:plc:labeler"];
  f.lexicons.set("com.example.post", { backfill: true, tokenCost: 3, indexed: undefined });
  f.lexicons.set("com.example.quiet", {});
  f.scripts.set("xrpc.query:com.example.hello", {
    description: 'Says "hi"',
    outboundXrpcs: ["com.other.get"],
  });
  f.modules.set("scoring", { language: "rust", path: "modules/scoring" });
  const text = f.render();
  const cfg = ProjectToml.parse(text);
  expect(cfg.interpreters.get("lua")).toEqual(entry("happyview-lua", "alpha"));
  const raw = parseTable(text);
  expect(scalar(at(raw, "instance", "app_name"))).toBe("App");
  expect(scalar(at(raw, "network_lexicons", "include", 0))).toBe("com.other.post");
  expect(scalar(at(raw, "labels", "subscribe", 0))).toBe("did:plc:labeler");
  const post = at(raw, "lexicons", "com.example.post");
  expect(scalar(at(post, "backfill"))).toBe(true);
  expect(scalar(at(post, "token_cost"))).toBe(3n);
  expect(at(post, "indexed")).toBeUndefined();
  // Nothing to say, so not written at all.
  expect(at(raw, "lexicons", "com.example.quiet"), text).toBeUndefined();
  expect(text).toContain('[lexicons."com.example.post"]');
  expect(text).not.toContain("[lexicons]\n");
  const script = at(raw, "scripts", "xrpc.query:com.example.hello");
  expect(scalar(at(script, "description"))).toBe('Says "hi"');
  expect(scalar(at(script, "outbound_xrpcs", 0))).toBe("com.other.get");
  expect(scalar(at(raw, "modules", "scoring", "language"))).toBe("rust");
});

it("the_handler_follows_the_first_interpreter", () => {
  for (const [lang, path] of [
    ["lua", "src/lexicons/com/example/hello.lua"],
    ["javascript", "src/lexicons/com/example/hello.js"],
    ["typescript", "src/lexicons/com/example/hello.ts"],
  ] as const) {
    const files = renderScaffold(scaffold(lang));
    expect(file(files, path), lang).toContain("com.example.hello");
    expect(file(files, "src/lexicons/com/example/hello.json")).toBeDefined();
  }
  const files = renderScaffold(scaffold("python"));
  expect(files.some(([p]) => p.endsWith(".py"))).toBe(false);
});

it("ignores_and_example_env_are_there", () => {
  const files = renderScaffold(scaffold(undefined));
  expect(file(files, ".gitignore")).toBe(".env\n.happyview/\n");
  const env = file(files, ".env.example")!;
  expect(env).toContain("ctx.env");
  // Every line is a comment, so copying it sets nothing by accident.
  for (const line of env.split("\n").filter((l) => l.trim() !== "")) {
    expect(line.trimStart().startsWith("#"), line).toBe(true);
  }
});

it("the_starter_lexicon_names_its_own_path", () => {
  const files = renderScaffold(scaffold("lua"));
  const lexicon = toPlain(parseValue(file(files, "src/lexicons/com/example/hello.json")!)) as {
    id: string;
  };
  expect(lexicon.id).toBe(STARTER_NSID);
  expect(STARTER_NSID.replaceAll(".", "/")).toBe("com/example/hello");
});

it("write_new_refuses_a_directory_with_anything_in_it", () => {
  const dir = tempdir();
  writeFileSync(join(dir, "README.md"), "mine");
  const err = problem(() => writeNew(dir, renderScaffold(scaffold("lua"))));
  expect(err.problem).toContain("not empty");
  expect(existsSync(join(dir, "happyview.toml"))).toBe(false);
  const fresh = join(dir, "app");
  writeNew(fresh, renderScaffold(scaffold("lua")));
  expect(isFile(join(fresh, "src/lexicons/com/example/hello.lua"))).toBe(true);
});

const entries = (dir: string) => readdirSync(dir).sort();

/**
 * A project whose last file cannot be written: `happyview.toml` is a file by then, so nothing
 * can go under it.
 */
function failingFiles(): [string, string][] {
  const files = renderScaffold(scaffold("lua"));
  files.push(["happyview.toml/oops", ""]);
  return files;
}

it("a_failure_partway_leaves_nothing_behind", () => {
  const parent = tempdir();
  const dir = join(parent, "app");
  const err = problem(() => writeNew(dir, failingFiles()));
  expect(err.problem).toContain("happyview.toml/oops");
  expect(entries(parent)).toEqual([]);
  writeNew(dir, renderScaffold(scaffold("lua")));
  expect(isFile(join(dir, "happyview.toml"))).toBe(true);
});

it("a_path_that_leaves_the_project_writes_nothing", () => {
  for (const hostile of ["../outside.lua", "/tmp/outside.lua", "src/../../outside.lua", ""]) {
    const parent = tempdir();
    const dir = join(parent, "app");
    const files = renderScaffold(scaffold("lua"));
    files.push([hostile, "evil"]);
    const err = problem(() => writeNew(dir, files));
    expect(err.problem, JSON.stringify(hostile)).toContain("isn't a plain path");
    expect(existsSync(join(parent, "outside.lua"))).toBe(false);
    expect(existsSync(join(dir, "happyview.toml")), hostile).toBe(false);
  }
});

/** What tells one directory from another put at the same path. */
function identity(dir: string): [number, number] {
  if (!unix) return [0, 0];
  const meta = statSync(dir);
  return [meta.ino, meta.mode & 0o777];
}

it("a_failure_in_an_empty_directory_empties_it_again_in_place", () => {
  const parent = tempdir();
  const dir = join(parent, "app");
  mkdirSync(dir);
  if (unix) chmodSync(dir, 0o750);
  const inode = identity(dir);
  const err = problem(() => writeNew(dir, failingFiles()));
  expect(err.problem).toContain("happyview.toml/oops");
  expect(entries(parent)).toEqual(["app"]);
  expect(entries(dir)).toEqual([]);
  expect(identity(dir), "the directory was replaced").toEqual(inode);

  writeNew(dir, renderScaffold(scaffold("lua")));
  expect(isFile(join(dir, "happyview.toml"))).toBe(true);
  expect(identity(dir), "the directory was replaced").toEqual(inode);
});

it("an_empty_directory_is_filled_in_place", () => {
  const parent = tempdir();
  const dir = join(parent, "app");
  mkdirSync(dir);
  if (unix) chmodSync(dir, 0o700);
  const before = identity(dir);
  writeNew(dir, renderScaffold(scaffold("lua")));
  expect(isFile(join(dir, "src/lexicons/com/example/hello.lua"))).toBe(true);
  expect(entries(parent)).toEqual(["app"]);
  expect(identity(dir), "the directory was replaced").toEqual(before);
});

it("the_working_directory_can_be_filled_through_dot", () => {
  const dir = tempdir();
  writeNew(`${dir}/.`, renderScaffold(scaffold("lua")));
  expect(isFile(join(dir, "happyview.toml"))).toBe(true);
});

it("a_file_at_the_name_is_refused_and_kept", () => {
  const parent = tempdir();
  const f = join(parent, "app");
  writeFileSync(f, "mine");
  const err = problem(() => writeNew(f, renderScaffold(scaffold("lua"))));
  expect(err.problem).toContain("not a directory");
  expect(readFileSync(f, "utf8")).toBe("mine");
  expect(entries(parent)).toEqual(["app"]);
});
