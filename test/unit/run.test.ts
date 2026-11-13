// crates/hpy/src/project/run.rs's tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Failure } from "../../src/core/failure.ts";
import { childEnv, finish, runForeground } from "../../src/project/run.ts";

describe("project/run.rs", () => {
  // The rest of this path ends in `exec`, which would replace the test process;
  // test/cli/hv-run.test.ts drives it through the binary instead.
  it("a_missing_binary_says_which", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hpy-run-"));
    try {
      const err = await runForeground(join(dir, "nope"), [], dir, [], []).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Failure);
      expect((err as Failure).message).toContain(`could not start ${join(dir, "nope")}: `);
      if (process.platform !== "win32")
        expect((err as Failure).message).toMatch(/: No such file or directory \(os error 2\)$/);
      expect(process.cwd()).not.toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Not a Rust test: `Command::env_remove` matches Windows names case-insensitively for free.
  it("windows_env_names_are_removed_and_replaced_whatever_their_case", () => {
    const from = { Plugin_Dir: "/elsewhere", Path: "C:\\bin", keep: "1" };
    expect(childEnv([["PATH", "D:\\bin"]], ["PLUGIN_DIR"], true, from)).toEqual({
      keep: "1",
      PATH: "D:\\bin",
    });
    // On unix names are exact.
    expect(childEnv([], ["PLUGIN_DIR"], false, from)).toEqual(from);
  });

  it("finish_maps_codes", () => {
    expect(() => finish(0)).not.toThrow();
    const code = (c: number) => {
      try {
        finish(c);
      } catch (e) {
        return (e as Failure).code;
      }
      return undefined;
    };
    expect(code(4)).toBe(4);
    expect(code(300)).toBe(1);
  });
});
