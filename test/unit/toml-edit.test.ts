// Compares toml-edit.ts (and hpy's call sites in src/plugin/config.ts and src/project) against
// toml_edit 0.25.17 and the real hpy functions (oracle/oracle-output.json; see toml.test.ts for how it is made).
import { describe, expect, it } from "vitest";
import * as json from "../../src/core/serde-json.ts";
import { DocumentMut } from "../../src/core/toml-edit.ts";
import { PROJECT_CONFIG, projectText } from "../../src/plugin/config.ts";
import { Pin, type PluginEntry, type PluginKind, setPlugin } from "../../src/project/config.ts";
import { firstInterpreter } from "../../src/project/handlers.ts";
import { ProjectFile, renderScaffold } from "../../src/project/scaffold.ts";
import { corpus, expected, oracle, outcome } from "../support/toml/oracle-fixtures.ts";

type J = Record<string, unknown>;

function entry(j: J): PluginEntry {
  return {
    did: j.did as string,
    name: j.name as string,
    pin: typeof j.channel === "string" ? Pin.channel(j.channel) : Pin.version(j.version as string),
  };
}

function entries(j: unknown): Map<string, PluginEntry> {
  return new Map(Object.entries((j ?? {}) as Record<string, J>).map(([k, v]) => [k, entry(v)]));
}

function run(
  op: string,
  input: string | undefined,
  args: J,
): { ok: boolean; output?: string; error?: string } {
  switch (op) {
    case "doc":
      return outcome(() => DocumentMut.parse(input ?? "").toString());
    case "write_project":
      return outcome(() =>
        projectText(input ?? "", json.fromStr(JSON.stringify(args), PROJECT_CONFIG)),
      );
    case "set_plugin":
      return outcome(() =>
        setPlugin(input ?? "", args.kind as PluginKind, args.key as string, entry(args.entry as J)),
      );
    case "first_interpreter":
      return outcome(() => JSON.stringify(firstInterpreter(input ?? "") ?? null));
    case "scaffold":
      return outcome(
        () =>
          renderScaffold({
            appName: args.app_name as string,
            superadmin: args.superadmin as string,
            happyviewVersion: args.happyview_version as string,
            interpreters: entries(args.interpreters),
            libraries: entries(args.libraries),
            handlerLanguage: args.handler_language as string | undefined,
          })[0]![1],
      );
    case "render": {
      const obj = <T>(k: string, f: (v: J) => T): Map<string, T> =>
        new Map(
          Object.entries((args[k] ?? {}) as Record<string, J>).map(([key, v]) => [key, f(v)]),
        );
      return outcome(() =>
        new ProjectFile({
          happyviewVersion: args.happyview_version as string,
          appName: args.app_name as string | undefined,
          superadmin: args.superadmin as string | undefined,
          interpreters: entries(args.interpreters),
          libraries: entries(args.libraries),
          networkLexicons: (args.network_lexicons ?? []) as string[],
          labels: (args.labels ?? []) as string[],
          lexicons: obj("lexicons", (v) => ({
            backfill: v.backfill as boolean | undefined,
            tokenCost: v.token_cost as number | undefined,
            indexed: v.indexed as boolean | undefined,
          })),
          scripts: obj("scripts", (v) => ({
            description: v.description as string | undefined,
            outboundXrpcs: v.outbound_xrpcs as string[] | undefined,
          })),
          modules: obj("modules", (v) => ({
            language: v.language as string,
            path: v.path as string,
          })),
        }).render(),
      );
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const EDIT_OPS = new Set([
  "doc",
  "write_project",
  "set_plugin",
  "first_interpreter",
  "scaffold",
  "render",
]);

describe("toml_edit 0.25.17 oracle", () => {
  for (const c of corpus.filter((x) => EDIT_OPS.has(x.op))) {
    const o = oracle.find((x) => x.name === c.name)!;
    it(c.name, () => {
      expect(o.panic).toBeUndefined();
      expect(run(c.op, c.input, (c.args ?? {}) as J)).toEqual(expected(o));
    });
  }
});
