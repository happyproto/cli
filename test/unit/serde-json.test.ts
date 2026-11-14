// Compares serde-json.ts against serde_json 1.0.151 / serde 1.0.229. The expected outputs in
// test/fixtures/serde-json/oracle-output.json comes from a scratch Rust crate (~/Development/clients/.agent-scratch/hpy-ts-port/serde-json/oracle, corpus: make-corpus.mjs):
//   cd oracle && node make-corpus.mjs && cargo run -q --bin serde-json-oracle -- corpus.json > oracle-output.json
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  array,
  bool as boolean,
  type Decoder,
  debugStr,
  decode,
  f64,
  field,
  formatF64,
  fromStr,
  get,
  i64,
  map,
  type Node,
  node,
  objectEntries,
  optional,
  parseValue,
  SerdeJsonError,
  str,
  struct,
  taggedEnum,
  toPlain,
  u32,
  u64,
  unitEnum,
  unitVariant,
  value,
  variant,
  withDefault,
} from "../../src/core/serde-json.ts";

interface OracleCase {
  name: string;
  type: string;
  input: string;
  ok: boolean;
  error?: string;
  value?: string;
}

const oracle: OracleCase[] = JSON.parse(
  readFileSync(new URL("../fixtures/serde-json/oracle-output.json", import.meta.url), "utf8"),
);

// The Rust types in oracle/src/main.rs, as decoders.
const manifest = struct("Manifest", {
  id: str,
  name: optional(str),
  capabilities: optional(array(str)),
  allowed_hosts: withDefault(array(str), []),
  display_name: field(optional(str), { rename: "displayName" }),
  version: optional(u32),
});
const item = struct("Item", { name: str, count: u32 });
const nested = struct("Nested", {
  id: str,
  items: array(item),
  extra: optional(map(value)),
  inner: optional(item),
});
const channel = unitEnum("Channel", ["stable", "beta", "alpha"]);
const signIn = taggedEnum("SignIn", "kind", {
  apiKey: variant("ApiKey", { key_prefix: str }),
  session: variant("Session", {
    client_key: str,
    did: str,
    handle: withDefault(optional(str), undefined),
    pds: str,
    scopes: str,
    access_token: str,
  }),
  anonymous: unitVariant("Anonymous"),
});
const holder = struct("Holder", { channel, sign_in: signIn, after: optional(u32) });
const strict = struct("Strict", { a: u32, b: optional(boolean) }, { denyUnknownFields: true });
const nums = struct("Nums", { a: u32, b: u64, c: i64, d: f64 });
const lang = struct("Lang", { lang: withDefault(str, () => "lua"), v: value });

const decoders: Record<string, Decoder<unknown>> = {
  // `value` gives plain values; the corpus compares serde_json's own serialization instead.
  value: node,
  string: str,
  bool: boolean,
  u32,
  u64,
  i64,
  f64,
  option_string: optional(str),
  vec_string: array(str),
  map_u32: map(u32),
  channel,
  sign_in: signIn,
  manifest,
  nested,
  holder,
  strict,
  nums,
  lang,
};

/** `serde_json::to_string` of a `Value`, from a node. */
function toJson(n: Node): string {
  switch (n.kind) {
    case "null":
      return "null";
    case "bool":
      return String(n.value);
    case "number":
      return typeof n.value === "number" ? formatF64(n.value) : String(n.value);
    case "string":
      return JSON.stringify(n.value);
    case "array":
      return `[${n.children.map(toJson).join(",")}]`;
    case "object":
      return `{${objectEntries(n)
        .map(([k, v]) => `${JSON.stringify(k)}:${toJson(v)}`)
        .join(",")}}`;
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

function outcome(run: () => unknown): Outcome {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    if (!(e instanceof SerdeJsonError)) throw e;
    return { ok: false, error: e.message };
  }
}

describe("oracle corpus", () => {
  it("is big enough", () => {
    expect(oracle.length).toBeGreaterThanOrEqual(60);
  });

  for (const c of oracle) {
    it(c.name, () => {
      const decoder = decoders[c.type];
      expect(decoder, `no decoder for ${c.type}`).toBeDefined();
      const got = outcome(() => fromStr(c.input, decoder!));
      if (c.ok) {
        expect(got).toMatchObject({ ok: true });
        if (c.value !== undefined && got.ok) expect(toJson(got.value as Node)).toBe(c.value);
      } else {
        expect(got).toEqual({ ok: false, error: c.error });
      }
    });
  }
});

describe("decode(parseValue(text)) agrees with fromStr for valid documents", () => {
  for (const c of oracle) {
    if (c.type === "value") continue;
    let parsed: Node;
    try {
      parsed = parseValue(c.input);
    } catch {
      continue;
    }
    it(c.name, () => {
      const decoder = decoders[c.type]!;
      expect(outcome(() => decode(parsed, decoder))).toEqual(
        outcome(() => fromStr(c.input, decoder)),
      );
    });
  }
});

describe("float fidelity (oracle/floats.json)", () => {
  const floats: { format: [string, string][]; parse: [string, string][] } = JSON.parse(
    readFileSync(new URL("../fixtures/serde-json/floats.json", import.meta.url), "utf8"),
  );
  const fromBits = (hex: string): number =>
    new DataView(new BigUint64Array([BigInt(`0x${hex}`)]).buffer).getFloat64(0, true);
  const toBits = (f: number): string => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, f, true);
    return view.getBigUint64(0, true).toString(16).padStart(16, "0");
  };

  it(`formats ${floats.format.length} doubles like serde_json`, () => {
    const wrong = floats.format.filter(([bits, text]) => formatF64(fromBits(bits)) !== text);
    expect(wrong).toEqual([]);
  });

  it(`parses ${floats.parse.length} decimal strings to the same bits`, () => {
    const wrong = floats.parse.filter(([text, expected]) => {
      const got = outcome(() => fromStr(text, f64));
      return (got.ok ? toBits(got.value as number) : got.error) !== expected;
    });
    expect(wrong).toEqual([]);
  });
});

describe("Debug escaping (oracle/escapes.txt)", () => {
  it("escapes exactly the code points Rust escapes", () => {
    const escaped = new Uint8Array(0x110000);
    for (const line of readFileSync(
      new URL("../fixtures/serde-json/escapes.txt", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")) {
      const [a, b] = line.split("-").map((h) => Number.parseInt(h, 16)) as [number, number];
      escaped.fill(1, a, b + 1);
    }
    const wrong: string[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const got = debugStr(String.fromCodePoint(cp)).includes("\\u{") ? 1 : 0;
      if (got !== escaped[cp]) wrong.push(cp.toString(16));
    }
    expect(wrong).toEqual([]);
  });
});

describe("SerdeJsonError", () => {
  it("exposes line and column", () => {
    const e = outcome(() => parseValue('{\n  "a": 1,\n}'));
    expect(e).toEqual({ ok: false, error: "trailing comma at line 3 column 1" });
    try {
      parseValue('{\n  "a": 1,\n}');
    } catch (err) {
      expect(err).toBeInstanceOf(SerdeJsonError);
      expect(err).toMatchObject({ code: "trailing comma", line: 3, column: 1 });
    }
  });

  it("has no position for errors serde_json reports without one", () => {
    try {
      fromStr('{"kind":"apiKey"}', signIn);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ message: "missing field `key_prefix`", line: 0, column: 0 });
    }
  });

  it("matches the hpy manifest message shape", () => {
    expect(outcome(() => fromStr("{", manifest))).toEqual({
      ok: false,
      error: "EOF while parsing an object at line 1 column 1",
    });
  });
});

describe("values", () => {
  it("keeps the last of duplicate keys and sorts keys like BTreeMap", () => {
    const n = parseValue('{"b":1,"a":2,"b":3}');
    expect(n.kind === "object" && n.entries.length).toBe(3);
    expect(toPlain(n)).toEqual({ a: 2, b: 3 });
    expect(Object.keys(toPlain(n) as object)).toEqual(["a", "b"]);
    expect(get(n, "b")).toMatchObject({ kind: "number", value: 3n });
  });

  it("uses bigint beyond 2^53 and numbers otherwise", () => {
    expect(
      toPlain(parseValue("[9007199254740991, 9007199254740993, -9223372036854775808]")),
    ).toEqual([9007199254740991, 9007199254740993n, -9223372036854775808n]);
    expect(toPlain(parseValue("[1.5, -0, 1e2]"))).toEqual([1.5, -0, 100]);
    expect(parseValue("1e2")).toMatchObject({ kind: "number", type: "f64", value: 100 });
    expect(parseValue("-1")).toMatchObject({ kind: "number", type: "i64", value: -1n });
  });

  it("records byte offsets", () => {
    const n = parseValue(' {"é": [1, "x"]} ');
    expect(n).toMatchObject({ start: 1, end: 17 });
    const entry = n.kind === "object" ? n.entries[0]! : undefined;
    expect(entry).toMatchObject({ key: "é", keyStart: 2, keyEnd: 6 });
    expect(entry?.value).toMatchObject({ kind: "array", start: 8, end: 16 });
  });

  it("does not let __proto__ keys touch the prototype", () => {
    const plain = toPlain(parseValue('{"__proto__": {"x": 1}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(Object.keys(plain)).toEqual(["__proto__"]);
  });

  it("keeps a leading U+FEFF inside strings", () => {
    expect(toPlain(parseValue('"﻿a"'))).toBe("﻿a");
  });
});

describe("typed decoding", () => {
  it("decodes a manifest", () => {
    const m = fromStr(
      '{"id":"a","displayName":"A","capabilities":["x"],"version":3,"other":{"y":[]}}',
      manifest,
    );
    expect(m).toEqual({
      id: "a",
      name: undefined,
      capabilities: ["x"],
      allowed_hosts: [],
      display_name: "A",
      version: 3,
    });
  });

  it("does not share default values between results", () => {
    const a = fromStr('{"id":"a"}', manifest);
    a.allowed_hosts.push("x");
    expect(fromStr('{"id":"b"}', manifest).allowed_hosts).toEqual([]);
  });

  it("decodes enums, maps and wide integers", () => {
    expect(
      fromStr('{"channel":"alpha","sign_in":{"kind":"apiKey","key_prefix":"p"}}', holder),
    ).toEqual({ channel: "alpha", sign_in: { kind: "apiKey", key_prefix: "p" }, after: undefined });
    expect([...fromStr('{"b":1,"a":2,"b":3}', map(u32))]).toEqual([
      ["a", 2],
      ["b", 3],
    ]);
    expect(fromStr("18446744073709551615", u64)).toBe(18446744073709551615n);
    expect(fromStr('{"v":{"k":null}}', lang)).toEqual({ lang: "lua", v: { k: null } });
    expect(fromStr('{"kind":"anonymous"}', signIn)).toEqual({ kind: "anonymous" });
  });
});
