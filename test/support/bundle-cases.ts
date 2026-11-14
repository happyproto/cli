// Deterministic inputs for the bundle oracle (test/fixtures/bundle/oracle.json). The fixture
// stores only each case's expected sha256 and length; the bytes come from these generators,
// both here and in the scratch script that ran the Rust oracle (flate2 1.1.10, miniz_oxide
// 0.9.1, tar 0.4.46) to make the fixture. Changing a generator invalidates its fixture entry.

const enc = new TextEncoder();

/** mulberry32: a small seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function randomBytes(n: number, seed: number, alphabet = 256): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = r() % alphabet;
  return out;
}

const WORDS = (() => {
  const r = rng(7);
  const letters = "etaoinshrdlcumwfgypbvkjxqz";
  return Array.from({ length: 600 }, () => {
    const len = 2 + (r() % 9);
    let w = "";
    for (let i = 0; i < len; i++) w += letters[Math.min(r() % 26, r() % 26)];
    return w;
  });
})();

/** Text from a fixed vocabulary with skewed word frequencies, about `n` bytes. */
export function prose(n: number, seed: number): Uint8Array {
  const r = rng(seed);
  let s = "";
  while (s.length < n) {
    const w = WORDS[Math.min(r() % WORDS.length, r() % WORDS.length, r() % WORDS.length)]!;
    s += w;
    const p = r() % 20;
    s += p === 0 ? ".\n" : p === 1 ? ", " : " ";
  }
  return enc.encode(s.slice(0, n));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const repeat = (s: string, n: number) => enc.encode(s.repeat(n));

/** A block of random bytes repeated at a fixed distance, for matches near the window edge. */
function periodic(period: number, total: number, seed: number): Uint8Array {
  const unit = randomBytes(period, seed);
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) out[i] = unit[i % period]!;
  return out;
}

/** Three-byte repeats 9000 bytes apart (tdefl drops a 3-byte match farther than 8 KiB). */
function farTriples(total: number, seed: number): Uint8Array {
  const out = randomBytes(total, seed);
  for (let i = 9000; i + 3 < total; i += 37) {
    out[i] = out[i - 9000]!;
    out[i + 1] = out[i - 8999]!;
    out[i + 2] = out[i - 8998]!;
  }
  return out;
}

/** Something shaped like a tar of small text files: headers, short bodies, zero padding. */
function tarLike(files: number, seed: number): Uint8Array {
  const r = rng(seed);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < files; i++) {
    const head = new Uint8Array(512);
    head.set(enc.encode(`src/lexicons/com/example/file${i}.json`));
    head.set(enc.encode("0000644\u00000000000\u00000000000\u0000"), 100);
    head.set(enc.encode("ustar\u000000"), 257);
    parts.push(head);
    const body = prose(1 + (r() % 1500), seed + i);
    parts.push(body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return concat(...parts);
}

export interface StreamCase {
  name: string;
  make: () => Uint8Array;
  /** Also compress it fed in chunks of these sizes, as flate2's writer is fed. */
  chunks?: number[];
}

export const STREAM_CASES: StreamCase[] = [
  { name: "empty", make: () => new Uint8Array(0), chunks: [1] },
  { name: "one-zero-byte", make: () => new Uint8Array(1) },
  { name: "one-byte-a", make: () => enc.encode("a") },
  { name: "deflate-late", make: () => enc.encode("Deflate late") },
  { name: "two-bytes", make: () => enc.encode("ab") },
  { name: "three-same", make: () => enc.encode("aaa") },
  { name: "short-text", make: () => enc.encode('[happyview]\nversion = "3.0.0"\n') },
  { name: "47-bytes", make: () => randomBytes(47, 1, 4) },
  { name: "48-bytes", make: () => randomBytes(48, 1, 4) },
  { name: "hello-repeat", make: () => repeat("hello hello hello world ", 1000), chunks: [7, 512] },
  { name: "run-a-100k", make: () => repeat("a", 100_000), chunks: [1000] },
  { name: "zeros-70k", make: () => new Uint8Array(70_000) },
  { name: "zeros-1m", make: () => new Uint8Array(1 << 20), chunks: [8192] },
  { name: "random-10", make: () => randomBytes(10, 10) },
  { name: "random-33", make: () => randomBytes(33, 33) },
  { name: "random-100", make: () => randomBytes(100, 100) },
  { name: "random-1000", make: () => randomBytes(1000, 1000) },
  { name: "random-31743", make: () => randomBytes(31743, 3) },
  { name: "random-31745", make: () => randomBytes(31745, 4) },
  { name: "random-32767", make: () => randomBytes(32767, 5) },
  { name: "random-32768", make: () => randomBytes(32768, 6) },
  { name: "random-32769", make: () => randomBytes(32769, 7) },
  { name: "random-65535", make: () => randomBytes(65535, 8) },
  { name: "random-65536", make: () => randomBytes(65536, 9) },
  { name: "random-70000", make: () => randomBytes(70000, 11), chunks: [512, 8192] },
  { name: "random-200k", make: () => randomBytes(200_000, 12) },
  { name: "random-1.2m", make: () => randomBytes(1_258_291, 13), chunks: [8192] },
  { name: "low-entropy-4", make: () => randomBytes(150_000, 14, 4) },
  { name: "low-entropy-16", make: () => randomBytes(150_000, 15, 16) },
  { name: "alphabet-2", make: () => randomBytes(80_000, 16, 2) },
  { name: "prose-1k", make: () => prose(1000, 1) },
  { name: "prose-40k", make: () => prose(40_000, 2) },
  { name: "prose-500k", make: () => prose(500_000, 3), chunks: [1, 333, 8192, 32768] },
  { name: "prose-3m", make: () => prose(3_000_000, 4) },
  {
    name: "mixed",
    make: () =>
      concat(
        prose(20_000, 5),
        randomBytes(20_000, 5),
        new Uint8Array(5000),
        repeat("xyz", 4000),
        randomBytes(50_000, 6, 8),
        prose(30_000, 6),
      ),
    chunks: [512],
  },
  { name: "periodic-32760", make: () => periodic(32760, 200_000, 20) },
  { name: "periodic-32768", make: () => periodic(32768, 200_000, 21) },
  { name: "periodic-32770", make: () => periodic(32770, 200_000, 22) },
  { name: "periodic-300", make: () => periodic(300, 100_000, 23) },
  { name: "periodic-259", make: () => periodic(259, 100_000, 24) },
  { name: "far-triples", make: () => farTriples(120_000, 25) },
  { name: "tar-like-20", make: () => tarLike(20, 30), chunks: [512] },
  { name: "tar-like-300", make: () => tarLike(300, 31) },
  {
    name: "ramp",
    make: () => {
      const out = new Uint8Array(300_000);
      for (let i = 0; i < out.length; i++) out[i] = (i * i) >>> 8;
      return out;
    },
  },
  {
    name: "csv-numbers",
    make: () => {
      let s = "";
      for (let i = 0; s.length < 400_000; i++) s += `${i},${(i * 7919) % 10007},${i % 13}\n`;
      return enc.encode(s);
    },
  },
];

export type Content = string | Uint8Array;

export interface TreeCase {
  name: string;
  files: [string, Content][];
  symlinks?: [string, string][];
  modules: string[];
  /** Rust refuses symlinks only on unix; skip such a case elsewhere. */
  unixOnly?: boolean;
}

const lexicon = (id: string) =>
  JSON.stringify({ lexicon: 1, id, defs: { main: { type: "query" } } }, null, 2);

const longDir = (n: number, c: string) => c.repeat(n);

export const TREE_CASES: TreeCase[] = [
  {
    name: "bundle-rs-project",
    files: [
      ["happyview.toml", '[happyview]\nversion = "3.0.0"\n'],
      ["src/lexicons/com/example/hello.json", "{}"],
      ["src/lexicons/com/example/hello.lua", "return {}"],
      ["src/jobs/sweep.ts", "export default 1"],
      [".env", "SECRET=1"],
      [".happyview/plugins/lua.wasm", "plugin"],
      [".happyview/types/lua/ctx.d.lua", "types"],
      [".happyview/build/counter.wasm", "module"],
      [".happyview/build/stale.wasm", "old module"],
      ["README.md", "readme"],
    ],
    modules: ["counter"],
  },
  { name: "config-only", files: [["happyview.toml", ""]], modules: [] },
  {
    name: "non-ascii-and-order",
    files: [
      ["happyview.toml", '[happyview]\nversion = "3.0.0"\n'],
      ["src/a.txt", "a"],
      ["src/Z.txt", "Z"],
      ["src/café.json", lexicon("com.example.cafe")],
      ["src/cafe.json", lexicon("com.example.cafe2")],
      ["src/日本語/ファイル.lua", "return { name = '日本語' }"],
      // U+FF5E sorts before U+1F600 in UTF-8 and after it in UTF-16.
      ["src/～.txt", "fullwidth tilde"],
      ["src/\u{1f600}.txt", "grinning face"],
      ["src/é/x", "e acute dir"],
      ["src/e/x", "e dir"],
      ["src/e-x", "dash"],
      ["src/e.x", "dot"],
      ["src/F", "capital"],
    ],
    modules: [],
  },
  {
    name: "long-paths",
    files: [
      ["happyview.toml", "[happyview]\n"],
      // 100 bytes exactly: fits the name field.
      [`src/${"n".repeat(96)}`, "exactly 100"],
      // Over 100 bytes, split between prefix and name.
      [`src/${longDir(60, "d")}/${longDir(60, "f")}.lua`, "split"],
      // A last component over 100 bytes: GNU long name.
      [`src/${"L".repeat(120)}.lua`, "gnu long name"],
      // A prefix that only fits after dropping several components.
      [
        `src/${longDir(80, "a")}/${longDir(80, "b")}/${longDir(40, "c")}/${longDir(50, "e")}.ts`,
        "deep",
      ],
      // Over 255 bytes in all, last components short.
      [
        `src/${longDir(200, "p")}/${longDir(30, "q")}/${longDir(30, "r")}/${longDir(30, "s")}.json`,
        "long prefix",
      ],
      // Non-ASCII past byte 100, so the GNU fallback's 100-byte cut lands inside a character.
      [`src/${"é".repeat(60)}.lua`, "two-byte characters"],
      [`src/${"x".repeat(95)}${"日本語".repeat(10)}`, "three-byte characters"],
    ],
    modules: [],
  },
  {
    name: "big-and-empty-files",
    files: [
      ["happyview.toml", prose(3000, 40)],
      ["src/empty.lua", ""],
      ["src/block.bin", randomBytes(512, 41)],
      ["src/block-plus-one.bin", randomBytes(513, 42)],
      ["src/random.bin", randomBytes(1_500_000, 43)],
      ["src/prose.md", prose(700_000, 44)],
      [".happyview/build/big.wasm", randomBytes(300_000, 45, 64)],
      [".happyview/build/small.wasm", concat(enc.encode("\0asm"), new Uint8Array(4000))],
    ],
    modules: ["small", "big"],
  },
  {
    name: "many-small-files",
    files: [
      ["happyview.toml", '[happyview]\nversion = "3.0.0"\n'],
      ...Array.from(
        { length: 250 },
        (_, i) =>
          [
            `src/lexicons/com/example/n${i % 17}/rec${i}.json`,
            lexicon(`com.example.n${i % 17}.rec${i}`),
          ] as [string, Content],
      ),
      ...Array.from(
        { length: 60 },
        (_, i) => [`src/jobs/job${i}.ts`, `export default ${i};\n`] as [string, Content],
      ),
    ],
    modules: [],
  },
  {
    name: "module-path-with-dotdot",
    files: [
      ["happyview.toml", ""],
      ["x.wasm", "outside the build dir"],
      [".happyview/build/other.wasm", "keeps the build dir"],
    ],
    modules: ["../../x"],
  },
  {
    name: "module-in-subdir",
    files: [
      ["happyview.toml", ""],
      [".happyview/build/nested/mod.wasm", "nested"],
    ],
    modules: ["nested/mod"],
  },
  { name: "missing-config", files: [["src/a.lua", "a"]], modules: [] },
  {
    name: "symlink-under-src",
    files: [
      ["happyview.toml", ""],
      ["src/a.lua", "a"],
    ],
    symlinks: [["src/passwd.lua", "/etc/passwd"]],
    modules: [],
    unixOnly: true,
  },
];
