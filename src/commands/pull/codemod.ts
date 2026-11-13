// commands/happyview/pull/codemod.rs: a v2 script through `happyview-codemod --stdin`, as
// `src/bin/codemod.rs` on HappyView's alpha documents it: the rewrite on stdout, notes on
// stderr, and exit 0 when clean, 2 when it left `-- codemod:` markers, 1 on an error.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { Failure } from "../../core/failure.ts";
import { ioErrorText } from "../../core/io.ts";
import { trim } from "../../core/rust-str.ts";
import { hasCodemodMarker, type Kind } from "./map.ts";

export type Rewrite =
  /** Rewritten with nothing left to do. */
  | { kind: "clean"; source: string }
  /** Rewritten, with markers where a person has to finish it. */
  | { kind: "marked"; source: string }
  /** Refused; the v2 source is kept, and this is why. */
  | { kind: "failed"; why: string };

/** std's `ExitStatus` Display on unix. */
export function exitStatusText(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit status: ${code}`;
  const n = signal ? (constants.signals as Record<string, number>)[signal] : undefined;
  return `signal: ${n ?? 0}${signal ? ` (${signal})` : ""}`;
}

export function rewrite(
  codemod: string,
  body: string,
  kind: Kind,
  collection: string | undefined,
): Promise<Rewrite> {
  const args = ["--stdin", "--kind", kind];
  if (collection !== undefined) args.push("--collection", collection);
  return new Promise((resolve, reject) => {
    const child = spawn(codemod, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      reject(
        Failure.runtime(
          spawned
            ? `running ${codemod}: ${ioErrorText(e)}`
            : `could not run ${codemod}: ${ioErrorText(e)}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      const decode = (b: Buffer[]) => new TextDecoder("utf-8").decode(Buffer.concat(b));
      const source = decode(out);
      const notes = trim(decode(err));
      if (code === 0)
        resolve(hasCodemodMarker(source) ? { kind: "marked", source } : { kind: "clean", source });
      else if (code === 2) resolve({ kind: "marked", source });
      else if (notes === "")
        resolve({ kind: "failed", why: `it exited with ${exitStatusText(code, signal)}` });
      else resolve({ kind: "failed", why: notes });
    });
    child.stdin.end(body);
  });
}
