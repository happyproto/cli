// crates/hpy/src/commands/happyview/create.rs's inline tests.
import { describe, expect, it } from "vitest";
import {
  checkDid,
  matchProjects,
  orderLanguages,
  type Pins,
  pick,
  report,
} from "../../src/commands/create.ts";
import { Failure } from "../../src/core/failure.ts";
import { parseProjectUri } from "../../src/plugin/validate.ts";
import { ProjectToml } from "../../src/project/config.ts";
import { LOCK_VERSION, Lockfile } from "../../src/project/lock.ts";
import { Candidate, type Choose } from "../../src/project/resolve.ts";

function candidate(project: string, language: string): Candidate {
  const [did, name] = parseProjectUri(project)!;
  return new Candidate({
    project,
    did,
    name,
    handle: undefined,
    displayName: name,
    channel: "latest",
    version: "1.0.0",
    languageId: language,
    namespace: undefined,
  });
}

const ONE = "at://did:plc:a/software.release.project/lua-one";
const TWO = "at://did:plc:b/software.release.project/lua-two";

const never: Choose = () => {
  throw new Error("nothing should be ambiguous here");
};

function failure(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a Failure");
}

describe("create", () => {
  it("dids_follow_the_atproto_grammar", () => {
    for (const ok of [
      "did:plc:z72i7hdynmk6r22z27h6tvur",
      "did:web:example.com",
      "did:web:localhost%3A8080",
      "did:example:a:b_c-d.e",
    ]) {
      expect(checkDid(ok), ok).toBeNull();
    }
    for (const bad of [
      "did:PLC:x",
      "did:plc:",
      "did::x",
      "did:plc:x:",
      "did:plc:x%",
      "did:plc:x y",
      "plc:x",
      "did:plc",
    ]) {
      expect(checkDid(bad), bad).not.toBeNull();
    }
    expect(checkDid(`did:plc:${"a".repeat(2048)}`)).not.toBeNull();
  });

  it("lua_comes_first_then_name_order", () => {
    expect(orderLanguages(["typescript", "lua", "javascript", "typescript", "lua"])).toEqual([
      "lua",
      "javascript",
      "typescript",
    ]);
    expect(orderLanguages(["js"])).toEqual(["js"]);
  });

  it("a_project_is_pinned_to_the_key_it_answers", () => {
    const found = [candidate(ONE, "lua"), candidate(TWO, "lua")];
    const chosen = [["interpreter", ["lua"], found]] as const;
    const pins = matchProjects([TWO], chosen);
    expect([...pins.values()]).toEqual([TWO]);
    const both = failure(() => matchProjects([ONE, TWO], chosen));
    expect(both.message).toContain("both answer to `lua`");
    const none = failure(() =>
      matchProjects(["at://did:plc:c/software.release.project/js"], chosen),
    );
    expect(none.code).toBe(2);
    expect(none.message).toContain("answers to none");
  });

  it("each_key_follows_its_projects_channel_and_a_pin_settles_several", async () => {
    const alpha = candidate(TWO, "lua");
    alpha.channel = "alpha";
    const found = [candidate(ONE, "lua"), alpha];
    const pins: Pins = matchProjects([TWO], [["interpreter", ["lua"], found]]);
    const entries = await pick("interpreter", ["lua"], found, pins, never);
    expect(entries.get("lua")).toEqual({
      did: "did:plc:b",
      name: "lua-two",
      pin: { kind: "channel", channel: "alpha" },
    });
    const chooseFirst: Choose = async () => 0;
    const first = await pick("interpreter", ["lua"], found, new Map(), chooseFirst);
    expect(first.get("lua")?.name).toBe("lua-one");
    const err = await pick("interpreter", ["python"], found, new Map(), never).catch((e) => e);
    expect(err).toBeInstanceOf(Failure);
    expect((err as Failure).message).toContain("answers to `python`");
  });

  it("the_json_names_each_entry_and_what_was_locked", () => {
    const toml = new ProjectToml({
      happyview: { version: "3.0.0" },
      interpreters: new Map([
        ["lua", { did: "did:plc:a", name: "lua-one", pin: { kind: "channel", channel: "latest" } }],
      ]),
    });
    const lock = new Lockfile({
      version: LOCK_VERSION,
      happyview: { version: "3.0.0" },
      plugins: [],
    });
    expect(report("app", "3.0.0", toml, lock)).toEqual({
      dir: "app",
      happyview: "3.0.0",
      interpreters: { lua: { project: ONE, channel: "latest" } },
      libraries: {},
      plugins: [],
    });
  });
});
