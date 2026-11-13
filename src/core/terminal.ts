// terminal_size 0.4's `terminal_size()`, which clap's help and miette's
// reports both size themselves by: the width of stdout's terminal, else
// stderr's, else stdin's.
import { execFileSync } from "node:child_process";
import { isatty } from "node:tty";

let stdinWidth: number | null | undefined;

/** The columns of stdin's terminal. Node sizes only output streams, so `stty` reads it. */
function stdinColumns(): number | undefined {
  if (stdinWidth === undefined) {
    stdinWidth = null;
    if (isatty(0)) {
      try {
        const out = execFileSync("stty", ["size"], {
          stdio: [0, "pipe", "ignore"],
          encoding: "utf8",
        });
        const [rows, cols] = out.trim().split(/\s+/).map(Number);
        if (rows && cols && rows > 0 && cols > 0) stdinWidth = cols;
      } catch {
        // No stty (Windows): stdin's size is unknown.
      }
    }
  }
  return stdinWidth ?? undefined;
}

/**
 * The terminal's width in columns, or undefined when none of stdout, stderr and stdin is one.
 * As in terminal_size, a terminal that reports no rows or no columns is passed over.
 */
export function terminalWidth(): number | undefined {
  for (const s of [process.stdout, process.stderr]) {
    if (s.isTTY && s.rows > 0 && s.columns > 0) return s.columns;
  }
  return stdinColumns();
}
