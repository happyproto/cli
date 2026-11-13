// Compares toml.ts against toml 1.1.8 (oracle/oracle-output.json, made by oracle/src/main.rs
// over oracle/corpus.json):
//   cd oracle && node make-corpus.mjs && cargo run -q -- corpus.json > oracle-output.json
import { describe, expect, it } from "vitest";
import type { Decoder } from "../../src/core/serde-json.ts";
import * as json from "../../src/core/serde-json.ts";
import {
  type Encoder,
  encTomlTable,
  fromStr,
  parseTable,
  type TomlTable,
  type TomlValue,
  tomlValue,
  toTomlString,
  toTomlStringPretty,
  tryInto,
} from "../../src/core/toml.ts";
import * as d from "../support/toml/decoders.ts";
import { corpus, expected, oracle, outcome } from "../support/toml/oracle-fixtures.ts";

// --- the oracle's JSON shapes ---

function floatBits(f: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, f);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

/** oracle `value_json`. NaN is compared as "nan": V8 does not keep a NaN's sign. */
function valueJson(v: TomlValue): unknown {
  switch (v.type) {
    case "string":
      return { string: v.value };
    case "integer":
      return { integer: v.value.toString() };
    case "float":
      return { float: Number.isNaN(v.value) ? "nan" : floatBits(v.value) };
    case "boolean":
      return { boolean: v.value };
    case "datetime":
      return { datetime: v.value.toString() };
    case "array":
      return { array: v.value.map(valueJson) };
    case "table":
      return { table: [...v.value].map(([k, x]) => [k, valueJson(x)]) };
  }
}

function normalizeNan(j: unknown): unknown {
  if (Array.isArray(j)) return j.map(normalizeNan);
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    if (typeof o.float === "string" && o.float !== "nan") {
      const bits = BigInt(`0x${o.float}`);
      const isNan = (bits >> 52n) % 2048n === 2047n && bits % 2n ** 52n !== 0n;
      return { float: isNan ? "nan" : o.float };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, normalizeNan(v)]));
  }
  return j;
}

/** TS field names whose Rust field is `#[serde(rename = "…")]`. */
const RUST_NAMES: Record<string, string> = { renamed: "renamed-key", plugins: "plugin" };

const VALUE_TYPES = new Set([
  "string",
  "integer",
  "float",
  "boolean",
  "datetime",
  "array",
  "table",
]);

/** serde_json's view of a decoded value, with `None`, empty lists and empty maps dropped. */
function canon(v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Map) return canon(Object.fromEntries(v));
  if (Array.isArray(v)) return v.length === 0 ? undefined : v.map((x) => canon(x) ?? null);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (
      keys.length === 2 &&
      keys.includes("type") &&
      keys.includes("value") &&
      VALUE_TYPES.has(o.type as string)
    ) {
      const tv = v as TomlValue;
      if (tv.type === "datetime") return { $__toml_private_datetime: tv.value.toString() };
      if (tv.type === "table") return canon(tv.value) ?? undefined;
      return canon(tv.value);
    }
    const out: Record<string, unknown> = {};
    for (const k of keys.sort()) {
      const c = canon(o[k]);
      if (c !== undefined) out[RUST_NAMES[k] ?? k] = c;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return v;
}

const decoders: Record<string, Decoder<unknown>> = {
  HpyToml: d.hpyToml,
  Lockfile: d.lockfile,
  LockFormat: d.lockFormat,
  RawToml: d.rawToml,
  ModulesFile: d.modulesFile,
  SettingsFile: d.settingsFile,
  ChannelFile: d.channelFile,
  UpdateState: d.updateState,
  AccessRecord: d.accessRecord,
  Editable: d.editable,
  Kitchen: d.kitchen,
  Strict: d.strict,
  ShapeHolder: d.shapeHolder,
  Nested: d.nested,
  Bare: d.bare,
};

/** Each type's encoder; its input is the oracle's JSON, read with serde-json.ts as Rust does. */
const encoders: Record<string, Encoder<never>> = {
  Lockfile: d.encLockfile as Encoder<never>,
  ChannelFile: d.encChannelFile as Encoder<never>,
  UpdateState: d.encUpdateState as Encoder<never>,
  AccessRecord: d.encAccessRecord as Encoder<never>,
  Editable: d.encEditable as Encoder<never>,
  HpyToml: d.encHpyToml as Encoder<never>,
  Kitchen: d.encKitchen as Encoder<never>,
  Nested: d.encNested as Encoder<never>,
  ShapeHolder: d.encShapeHolder as Encoder<never>,
};

function fromJson<T>(input: string, decoder: Decoder<T>): T {
  try {
    return json.fromStr(input, decoder);
  } catch (e) {
    throw new Error(`json: ${(e as Error).message}`);
  }
}

/** hpy-project lock.rs `Lockfile::render`. */
function renderLockfile(lock: d.Lockfile): string {
  const cmp = json.compareKeys;
  const sorted = {
    ...lock,
    plugins: [...lock.plugins]
      .sort((a, b) => cmp(a.id, b.id))
      .map((p) => ({
        ...p,
        keys: [...p.keys].sort(cmp),
        dependencies: [...p.dependencies].sort(cmp),
      })),
  };
  return `# Written by hpy from happyview.toml. Commit it; don't edit it by hand.\n\n${toTomlString(sorted, d.encLockfile)}`;
}

function run(op: string, input: string): { ok: boolean; output?: string; error?: string } {
  const [kind, type] = op.split(":") as [string, string | undefined];
  switch (kind) {
    case "table":
      return outcome(() => JSON.stringify(valueJson({ type: "table", value: parseTable(input) })));
    case "value":
      return outcome(() => JSON.stringify(valueJson(fromStr(input, tomlValue))));
    case "de":
      return outcome(() => JSON.stringify(canon(fromStr(input, decoders[type!]!)) ?? {}));
    case "try":
      return outcome(() => {
        let table: TomlTable;
        try {
          table = parseTable(input);
        } catch (e) {
          throw new Error(`parse: ${(e as Error).message}`);
        }
        return JSON.stringify(canon(tryInto(table, decoders[type!]!)) ?? {});
      });
    case "ser":
    case "ser_pretty":
      return outcome(() => {
        const value = fromJson(input, decoders[type!]!) as never;
        const enc = encoders[type!]!;
        return kind === "ser" ? toTomlString(value, enc) : toTomlStringPretty(value, enc);
      });
    case "render":
      return outcome(() => renderLockfile(fromJson(input, d.lockfile) as d.Lockfile));
    case "ser_table":
    case "ser_table_pretty":
      return outcome(() => {
        let table: TomlTable;
        try {
          table = parseTable(input);
        } catch (e) {
          throw new Error(`parse: ${(e as Error).message}`);
        }
        return kind === "ser_table"
          ? toTomlString(table, encTomlTable)
          : toTomlStringPretty(table, encTomlTable);
      });
    default:
      throw new Error(`unknown op ${op}`);
  }
}

/** Compares decoded values structurally (the oracle's JSON was made by serde_json). */
function comparable(op: string, r: { ok: boolean; output?: string; error?: string }): unknown {
  if (!r.ok) return r;
  if (op === "table" || op === "value")
    return { ok: true, output: normalizeNan(JSON.parse(r.output!)) };
  if (op.startsWith("de:") || op.startsWith("try:")) {
    return { ok: true, output: canon(JSON.parse(r.output!)) ?? {} };
  }
  return r;
}

const TOML_OPS = /^(table|value|de:|try:|ser|render:)/;

describe("toml 1.1.8 oracle", () => {
  const cases = corpus.filter((c) => TOML_OPS.test(c.op));
  for (const c of cases) {
    const o = oracle.find((x) => x.name === c.name)!;
    it(c.name, () => {
      expect(o.panic).toBeUndefined();
      expect(comparable(c.op, run(c.op, c.input ?? ""))).toEqual(comparable(c.op, expected(o)));
    });
  }
});
