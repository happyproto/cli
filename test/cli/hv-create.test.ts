// crates/hpy/tests/happyview.rs's `create_*` tests: `hpy hv create` against a fake registry,
// in a private parent directory, with nothing downloaded.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportedCredential } from "../support/credential.ts";
import { mountRegistry, Plugin, Stack, says, VERSION } from "../support/hv-stack.ts";

let stacks: Stack[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const s of stacks) await s.dispose();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  stacks = [];
  dirs = [];
});
const newStack = async () => {
  const s = await Stack.start();
  stacks.push(s);
  return s;
};
const tempdir = () => {
  const d = mkdtempSync(join(tmpdir(), "hpy-create-"));
  dirs.push(d);
  return d;
};
const read = (p: string) => readFileSync(p, "utf8");
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

const mountLua = (stack: Stack) =>
  mountRegistry(stack, [Plugin.interpreter("happyview-lua", "lua", "\0asm lua")]);

const LUA_ENTRY = 'lua = { did = "did:plc:hv", name = "happyview-lua", channel = "latest" }';

const create = (name: string, ...rest: string[]) => [
  "hv",
  "create",
  "--name",
  name,
  "--no-input",
  ...rest,
];
const pinned = ["--superadmin", "did:plc:me", "--happyview-version", VERSION];

describe("hv create", () => {
  it("create_writes_a_project_and_its_lock_without_downloading_anything", async () => {
    const stack = await newStack();
    mountLua(stack);
    const parent = tempdir();
    const r = await stack.hpyIn(parent, create("my-app", ...pinned));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("hpy happyview dev");
    expect(r.stdout).toContain("superadmin: did:plc:me\n");
    const app = join(parent, "my-app");
    const toml = read(join(app, "happyview.toml"));
    expect(toml).toContain(LUA_ENTRY);
    expect(toml).toContain('app_name = "my-app"');
    const lock = read(join(app, "happyview.lock"));
    expect(lock).toContain('id = "happyview-lua"');
    expect(lock).toContain('keys = ["lua"]');
    expect(isFile(join(app, "src/lexicons/com/example/hello.lua"))).toBe(true);
    // Lua is the default interpreter, so the project starts pointing LuaLS at the types
    // `hpy happyview dev` writes.
    expect(read(join(app, ".luarc.json"))).toContain(".happyview/types/lua");
    expect(existsSync(join(app, "tsconfig.json"))).toBe(false);
    expect(read(join(app, ".gitignore"))).toBe(".env\n.happyview/\n");
    expect(readdirSync(stack.cache), "create downloaded something").toEqual([]);
  });

  it("create_resolves_before_writing_anything", async () => {
    const stack = await newStack();
    mountLua(stack);
    const parent = tempdir();
    const r = await stack.hpyIn(
      parent,
      create("my-app", ...pinned, "--interpreter", "lua", "--library", "happyview.nope"),
    );
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "happyview.nope")).toBe(true);
    expect(existsSync(join(parent, "my-app"))).toBe(false);
  });

  it("create_writes_nothing_when_resolution_refuses_the_release", async () => {
    const stack = await newStack();
    // An interpreter from before project mode: no file extensions.
    const lua = Plugin.interpreter("happyview-lua", "lua", "\0asm lua");
    delete lua.fields.fileExtensions;
    mountRegistry(stack, [lua]);
    const parent = tempdir();
    const r = await stack.hpyIn(parent, create("my-app", ...pinned));
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "declares no file extensions"), r.stderr).toBe(true);
    expect(existsSync(join(parent, "my-app"))).toBe(false);
  });

  it("create_names_the_signed_in_superadmin_by_handle_and_did", async () => {
    const stack = await newStack();
    mountLua(stack);
    const parent = tempdir();
    const credential = await exportedCredential(
      "did:plc:alice",
      "https://api.happyproto.at",
      "alice.test",
    );
    const r = await stack.hpyIn(parent, create("my-app", "--happyview-version", VERSION), {
      HPY_CREDENTIAL: credential,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("superadmin: @alice.test (did:plc:alice)");
    // happyview.toml holds the DID, which is what HappyView checks at boot.
    const toml = read(join(parent, "my-app/happyview.toml"));
    expect(toml).toContain('superadmin = "did:plc:alice"');
  });

  it("create_without_a_login_or_flag_names_superadmin", async () => {
    const stack = await newStack();
    const parent = tempdir();
    const r = await stack.hpyIn(parent, create("my-app"));
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "--superadmin")).toBe(true);
  });

  it("create_refuses_a_directory_with_files_in_it", async () => {
    const stack = await newStack();
    const parent = tempdir();
    mkdirSync(join(parent, "taken"));
    writeFileSync(join(parent, "taken/notes.txt"), "mine");
    const r = await stack.hpyIn(parent, create("taken", "--superadmin", "did:plc:me"));
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "not empty")).toBe(true);
    expect(read(join(parent, "taken/notes.txt"))).toBe("mine");
  });

  it("create_takes_a_project_where_several_answer", async () => {
    const stack = await newStack();
    mountRegistry(stack, [
      Plugin.interpreter("happyview-lua", "lua", "\0asm lua"),
      Plugin.interpreter("other-lua", "lua", "\0asm other"),
    ]);
    const parent = tempdir();
    const run = (name: string, project?: string) =>
      stack.hpyIn(parent, create(name, ...pinned, ...(project ? ["--project", project] : [])));
    const asked = await run("asked");
    expect(asked.code, asked.stderr).toBe(2);
    expect(says(asked.stderr, "pass --project <AT-URI> to choose")).toBe(true);
    const other = "at://did:plc:hv/software.release.project/other-lua";
    const ok = await run("pinned", other);
    expect(ok.code, ok.stderr).toBe(0);
    const lock = read(join(parent, "pinned/happyview.lock"));
    expect(lock).toContain('id = "other-lua"');
    expect(lock).toContain(other);
    expect(read(join(parent, "pinned/happyview.toml"))).toContain('name = "other-lua"');
    const stray = await run("stray", "at://did:plc:hv/software.release.project/nobody");
    expect(stray.code, stray.stderr).toBe(2);
    expect(says(stray.stderr, "nobody answers to")).toBe(true);
    expect(existsSync(join(parent, "stray"))).toBe(false);
  });

  it("create_refuses_a_superadmin_that_is_not_a_did", async () => {
    const stack = await newStack();
    const parent = tempdir();
    const r = await stack.hpyIn(parent, create("my-app", "--superadmin", "did:PLC:me"));
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "--superadmin")).toBe(true);
    expect(says(r.stderr, "is not a DID")).toBe(true);
    expect(existsSync(join(parent, "my-app"))).toBe(false);
  });

  it("create_refuses_a_blank_app_name", async () => {
    const stack = await newStack();
    mountLua(stack);
    const parent = tempdir();
    const r = await stack.hpyIn(parent, create("my-app", ...pinned, "--app-name", "   "));
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "--app-name")).toBe(true);
    expect(says(r.stderr, "must not be empty")).toBe(true);
    expect(existsSync(join(parent, "my-app"))).toBe(false);
  });

  it("create_fills_an_existing_empty_directory", async () => {
    const stack = await newStack();
    mountLua(stack);
    const parent = tempdir();
    mkdirSync(join(parent, "my-app"));
    const r = await stack.hpyIn(parent, create("my-app", ...pinned));
    expect(r.code, r.stderr).toBe(0);
    const app = join(parent, "my-app");
    expect(isFile(join(app, "happyview.toml")) && isFile(join(app, "happyview.lock"))).toBe(true);
    expect(readdirSync(parent), "a temporary directory was left beside it").toEqual(["my-app"]);
  });

  it("create_fills_the_directory_it_is_run_in", async () => {
    const stack = await newStack();
    mountLua(stack);
    const parent = tempdir();
    const app = join(parent, "my-app");
    mkdirSync(app);
    const r = await stack.hpyIn(app, create(".", ...pinned));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("cd .");
    expect(read(join(app, "happyview.toml"))).toContain('app_name = "my-app"');
    expect(isFile(join(app, "happyview.lock"))).toBe(true);
    expect(readdirSync(parent)).toEqual(["my-app"]);
  });

  it("create_refuses_a_name_that_is_a_file", async () => {
    const stack = await newStack();
    const parent = tempdir();
    writeFileSync(join(parent, "my-app"), "mine");
    const r = await stack.hpyIn(parent, create("my-app", "--superadmin", "did:plc:me"));
    expect(r.code, r.stderr).toBe(2);
    expect(says(r.stderr, "is not a directory")).toBe(true);
    expect(read(join(parent, "my-app"))).toBe("mine");
  });

  it("create_takes_a_library_by_namespace_or_name", async () => {
    const stack = await newStack();
    mountRegistry(stack, [
      Plugin.interpreter("happyview-lua", "lua", "\0asm lua"),
      Plugin.library("http-lib", "happyview.http", "\0asm http"),
    ]);
    const parent = tempdir();
    const run = (name: string, library: string) =>
      stack.hpyIn(parent, create(name, ...pinned, "--library", library));
    for (const [name, library] of [
      ["by-namespace", "happyview.http"],
      ["by-name", "http-lib"],
    ] as const) {
      const r = await run(name, library);
      expect(r.code, r.stderr).toBe(0);
      const toml = read(join(parent, name, "happyview.toml"));
      const entry = '{ did = "did:plc:hv", name = "http-lib", channel = "latest" }';
      expect(
        toml.includes(`"${library}" = ${entry}`) || toml.includes(`${library} = ${entry}`),
        toml,
      ).toBe(true);
      expect(read(join(parent, name, "happyview.lock"))).toContain('id = "http-lib"');
    }
    const neither = await run("neither", "happyview.nope");
    expect(neither.code, neither.stderr).toBe(2);
    expect(says(neither.stderr, "--library: `happyview.nope`")).toBe(true);
    expect(existsSync(join(parent, "neither"))).toBe(false);
  });
});
