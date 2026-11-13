// src/core/stdio.ts, which has no Rust counterpart: Rust neither sets O_NONBLOCK on its
// streams nor reports a closed pipe with a stack trace.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Checked where the closed pipe was reported, on unix; Windows has not been tried.
const unix = process.platform !== "win32";

const STDIO = fileURLToPath(new URL("../../src/core/stdio.ts", import.meta.url));

/** Runs `body` in a child Node whose stdout's reader has already gone, answering its exit code and stderr. */
function withClosedStdout(body: string): Promise<[number | null, string]> {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `import * as stdio from ${JSON.stringify(STDIO)};\n${body}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  return new Promise((r) => child.once("close", (code) => r([code, stderr])));
}

// Far more than a pipe holds, written while the process carries on, as a long listing piped
// into `head` is.
const LARGE = "process.stdout.write('x'.repeat(1 << 20)); setTimeout(() => {}, 5000);";

it.skipIf(!unix)("a_closed_stdout_ends_the_process_quietly", async () => {
  const [code, stderr] = await withClosedStdout(`stdio.quietOnClosedPipe();\n${LARGE}`);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

it.skipIf(!unix)(
  "without_the_handler_node_reports_the_closed_pipe_with_a_stack_trace",
  async () => {
    const [code, stderr] = await withClosedStdout(LARGE);
    expect(code).not.toBe(0);
    expect(stderr).toContain("EPIPE");
  },
);
