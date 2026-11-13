// The oracle's corpus and results, shared by toml.test.ts and toml-edit.test.ts.
import { readFileSync } from "node:fs";

export interface OracleCase {
  name: string;
  op: string;
  ok: boolean;
  output?: string;
  error?: string;
  panic?: boolean;
}

export const corpus: { name: string; op: string; input?: string; args?: unknown }[] = JSON.parse(
  readFileSync(new URL("../../fixtures/toml/corpus.json", import.meta.url), "utf8"),
);
export const oracle: OracleCase[] = JSON.parse(
  readFileSync(new URL("../../fixtures/toml/oracle-output.json", import.meta.url), "utf8"),
);

/** Runs `body`, giving the oracle's shape: `{ ok, output }` or `{ ok: false, error }`. */
export function outcome(body: () => string): { ok: boolean; output?: string; error?: string } {
  try {
    return { ok: true, output: body() };
  } catch (e) {
    if (
      !(e instanceof Error) ||
      e.name === "TypeError" ||
      e.name === "RangeError" ||
      e.name === "ReferenceError"
    ) {
      throw e;
    }
    return { ok: false, error: e.message };
  }
}

export function expected(c: OracleCase): { ok: boolean; output?: string; error?: string } {
  return c.ok ? { ok: true, output: c.output! } : { ok: false, error: c.error! };
}
