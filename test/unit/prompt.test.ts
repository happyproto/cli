// crates/hpy/src/prompt.rs tests. Tests run without a terminal.
import { expect, it } from "vitest";
import type { Failure } from "../../src/core/failure.ts";
import { Prompter } from "../../src/core/prompt.ts";

const ok = () => null;
const failure = async (p: Promise<unknown>): Promise<Failure> => {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected a failure");
};

it("says_why_it_cannot_prompt", async () => {
  let err = await failure(
    new Prompter(true, false).required("--license", "License:", undefined, undefined, ok),
  );
  expect(err.message).toContain("--no-input");
  err = await failure(
    new Prompter(false, false).required("--license", "License:", undefined, undefined, ok),
  );
  expect(err.message).toContain("no terminal");
});

it("choose_without_a_terminal_names_the_flag_and_lists_the_options", async () => {
  const err = await failure(
    new Prompter(true, false).choose("--package", "Which `lua`?", ["one", "two"]),
  );
  expect(err.message).toContain("--package");
  expect(err.message).toContain("one");
  expect(err.message).toContain("two");
  expect(err.code).toBe(2);
});

it("multi_uses_flags_then_the_preselection", async () => {
  const p = new Prompter(true, false);
  const options = ["lua", "javascript"];
  expect(await p.multi("--interpreter", "Interpreters:", [], options, ["lua"])).toEqual(["lua"]);
  expect(await p.multi("--interpreter", "Interpreters:", ["javascript"], options, ["lua"])).toEqual(
    ["javascript"],
  );
  const err = await failure(p.multi("--interpreter", "Interpreters:", ["python"], options, []));
  expect(err.message).toContain("--interpreter: `python`");
  expect(err.message).toContain("lua, javascript");
});

it("an_offer_without_a_terminal_is_left_to_the_caller", async () => {
  expect(await new Prompter(true, false).offer("Add it?")).toBeNull();
});

it("multi_takes_any_flag_value_when_nothing_was_listed", async () => {
  expect(await new Prompter(true, false).multi("--library", "Libraries:", ["x"], [], [])).toEqual([
    "x",
  ]);
});
