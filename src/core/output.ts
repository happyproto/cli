// crates/hpy/src/output.rs: human text to stderr; the result to stdout, as JSON
// with `--json`. serde_json's `Value` keeps object keys in a BTreeMap, so Rust
// prints them sorted; `toJson` does the same, recursively.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(v).sort(byCodePoint)) out[k] = sortKeys(v[k] as Json);
    return out;
  }
  return v;
}

/** BTreeMap<String, _> orders by bytes, which for UTF-8 is code-point order. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `serde_json::to_string_pretty` of a `Value`. */
export function toJson(v: Json): string {
  return JSON.stringify(sortKeys(v), null, 2);
}

export class Output {
  readonly json: boolean;

  constructor(json: boolean) {
    this.json = json;
  }

  isJson(): boolean {
    return this.json;
  }

  status(msg: string): void {
    process.stderr.write(`${msg}\n`);
  }

  done(human: string, json: Json): void {
    if (this.json) process.stdout.write(`${toJson(json)}\n`);
    else if (human !== "") process.stdout.write(`${human}\n`);
  }
}
