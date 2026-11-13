// Deterministic inputs for the similar oracle (test/fixtures/similar/oracle.json). The fixture
// stores each case's expected `unified_diff` output (or, for big outputs, its sha256 and length);
// the inputs come from these generators, both here and in the scratch script that ran the Rust
// oracle (similar 3.2.1) to make the fixture. Changing a generator invalidates its fixture entry.

import { rng } from "./bundle-cases.ts";

export interface SimilarCase {
  name: string;
  old: string;
  new: string;
  a: string;
  b: string;
}

type Rand = () => number;

const TOML_KEYS = ["name", "version", "did", "channel", "entry", "out", "target", "minify"];
const LUA_LINES = [
  "local M = {}",
  "end",
  "",
  "  return nil",
  "  if not record then",
  "    return { error = 'missing' }",
  "  end",
  "function M.handle(ctx, record)",
  "  local value = record.value",
  "  ctx.log('handled')",
  "  return value",
  "return M",
  "  -- 日本語のコメント",
  "  local émoji = '🦫'",
];

function tomlText(r: Rand, tables: number): string[] {
  const lines: string[] = [];
  for (let t = 0; t < tables; t++) {
    if (t > 0) lines.push("");
    lines.push(`[plugins.p${r() % 5}]`);
    const keys = 1 + (r() % 5);
    for (let k = 0; k < keys; k++) {
      const key = TOML_KEYS[r() % TOML_KEYS.length]!;
      lines.push(`${key} = "${r() % 3 === 0 ? "x" : `v${r() % 4}`}"`);
    }
  }
  return lines;
}

function luaText(r: Rand, n: number): string[] {
  return Array.from({ length: n }, () => LUA_LINES[r() % LUA_LINES.length]!);
}

function vocabText(r: Rand, n: number, vocab: number): string[] {
  return Array.from({ length: n }, () => `line ${r() % vocab}`);
}

function distinctText(n: number, tag = "l"): string[] {
  return Array.from({ length: n }, (_, i) => `${tag}${i}`);
}

/** Applies `edits` random single-line edits (replace, insert or delete) drawn from `pick`. */
function edit(r: Rand, lines: string[], edits: number, pick: () => string): string[] {
  const out = lines.slice();
  for (let e = 0; e < edits; e++) {
    const kind = r() % 3;
    const at = out.length === 0 ? 0 : r() % (out.length + (kind === 1 ? 1 : 0));
    if (kind === 0 && out.length > 0) out[at] = pick();
    else if (kind === 1 || out.length === 0) out.splice(at, 0, pick());
    else out.splice(at, 1);
  }
  return out;
}

/** Joins with `eol`; `last` decides whether the final line gets one too. */
function join(lines: string[], eol = "\n", last = true): string {
  if (lines.length === 0) return "";
  return lines.join(eol) + (last ? eol : "");
}

export function similarCases(): SimilarCase[] {
  const cases: SimilarCase[] = [];
  const add = (name: string, old: string, new_: string, a = "a/f", b = "b/f") =>
    cases.push({ name, old, new: new_, a, b });

  // Edge cases.
  add("empty-empty", "", "");
  add("empty-old", "", "one\ntwo\n", "/dev/null", "b/src/x.lua");
  add("empty-new", "one\ntwo\n", "", "a/src/x.lua", "/dev/null");
  add("identical", "a\nb\nc\n", "a\nb\nc\n");
  add("one-line", "a\n", "b\n");
  add("newline-only", "\n", "\n\n");
  add("no-eol-old", "a\nb", "a\nb\n");
  add("no-eol-new", "a\nb\n", "a\nb");
  add("no-eol-both", "a\nb", "a\nc");
  add("no-eol-both-same-last", "x\nb", "y\nb");
  add("no-eol-single", "a", "b");
  add("no-eol-empty-new", "a", "");
  add("no-eol-empty-old", "", "a");
  add("crlf", "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
  add("crlf-vs-lf", "a\r\nb\r\n", "a\nb\n");
  add("lone-cr", "a\rb\rc", "a\rB\rc");
  add("cr-lf-mix", "a\n\r\nb\r\r\n", "a\r\n\nb\n\r");
  add("unicode", "héllo\n日本\n🦫\n", "héllo\n日本語\n🦫\n");
  add("ranges-0", "a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\nX\ne\nf\ng\nh\n");
  add("ranges-1", "a\n", "a\nb\n");
  add("header-spaces", "a\n", "b\n", "a/dir with space/f", "b/dir with space/f");
  for (let gap = 0; gap <= 9; gap++) {
    const base = distinctText(20 + gap);
    const changed = base.slice();
    changed[5] = "X";
    changed[6 + gap] = "Y";
    add(`gap-${gap}`, join(base), join(changed));
  }
  for (const pos of [0, 1, 2, 3, 4, 10, 16, 17, 18, 19]) {
    const base = distinctText(20);
    const changed = base.slice();
    changed[pos] = "Z";
    add(`edge-${pos}`, join(base), join(changed));
    add(`edge-noeol-${pos}`, join(base, "\n", false), join(changed, "\n", false));
  }

  // Random small edits.
  for (let seed = 1; seed <= 160; seed++) {
    const r = rng(seed);
    const n = r() % 60;
    const vocab = [2, 3, 5, 12, 1000][seed % 5]!;
    const base = vocabText(r, n, vocab);
    const changed = edit(r, base, 1 + (r() % 8), () => `line ${r() % vocab}`);
    const eolOld = r() % 5 !== 0;
    const eolNew = r() % 5 !== 0;
    const crlf = seed % 11 === 0;
    add(
      `random-${seed}`,
      join(base, crlf ? "\r\n" : "\n", eolOld),
      join(changed, crlf ? "\r\n" : "\n", eolNew),
    );
  }

  // TOML-like and Lua-like texts.
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(1000 + seed);
    const base = tomlText(r, 1 + (r() % 6));
    const changed = edit(r, base, 1 + (r() % 4), () => `${TOML_KEYS[r() % 8]} = "${r() % 9}"`);
    add(`toml-${seed}`, join(base), join(changed), "a/hpy.toml", "b/hpy.toml");
  }
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(2000 + seed);
    const base = luaText(r, 10 + (r() % 80));
    const changed = edit(r, base, 1 + (r() % 10), () => LUA_LINES[r() % LUA_LINES.length]!);
    add(`lua-${seed}`, join(base), join(changed), "a/src/main.lua", "b/src/main.lua");
  }

  // Larger inputs: past the 100-line remapping threshold, with scattered edits.
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(3000 + seed);
    const n = 100 + (r() % 1500);
    const vocab = [4, 30, 100000][seed % 3]!;
    const base = vocabText(r, n, vocab);
    const changed = edit(r, base, 1 + (r() % 40), () => `line ${r() % vocab}`);
    add(`large-${seed}`, join(base), join(changed));
  }

  // Heavily changed large inputs: the heuristic middle-snake search (cost past 256).
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(4000 + seed);
    const n = 800 + (r() % 2000);
    const vocab = [2, 3, 8, 50][seed % 4]!;
    const base = vocabText(r, n, vocab);
    const changed = edit(
      r,
      base,
      Math.floor(n * (0.2 + (r() % 40) / 100)),
      () => `line ${r() % vocab}`,
    );
    add(`heavy-${seed}`, join(base), join(changed));
  }

  // Disjoint and near-disjoint large inputs: the preflight reduction.
  for (let seed = 1; seed <= 8; seed++) {
    const r = rng(5000 + seed);
    const n = 520 + (r() % 600);
    const m = 520 + (r() % 600);
    const shared = Array.from({ length: 1 + (r() % 30) }, (_, i) => `shared ${i}`);
    const old = distinctText(n, "o");
    const new_ = distinctText(m, "n");
    for (const line of shared) {
      old.splice(1 + (r() % (old.length - 2)), 0, line);
      new_.splice(1 + (r() % (new_.length - 2)), 0, line);
    }
    if (seed % 2 === 0) {
      // Frequent lines on both sides, to exercise the "investigate" records.
      for (let i = 0; i < 80; i++) {
        old.splice(1 + (r() % (old.length - 2)), 0, "end");
        new_.splice(1 + (r() % (new_.length - 2)), 0, "end");
      }
    }
    add(`disjoint-${seed}`, join(old), join(new_));
  }

  // One small side against a large one: the small-side exact fallback.
  for (let seed = 1; seed <= 8; seed++) {
    const r = rng(6000 + seed);
    const small = vocabText(r, 1 + (r() % 64), 6);
    const large = vocabText(r, 520 + (r() % 400), 6);
    add(`small-side-${seed}`, join(seed % 2 ? small : large), join(seed % 2 ? large : small));
  }

  // A large shift on one side: front-anchor peeling.
  for (let seed = 1; seed <= 8; seed++) {
    const r = rng(7000 + seed);
    const body = vocabText(r, 100 + (r() % 300), 1000);
    const lead = vocabText(r, 1 + (r() % 4), 1000);
    const tail = vocabText(r, body.length + 50 + (r() % 200), 7);
    const grown = [...lead, ...body, ...tail];
    const shrunk = seed % 4 < 2 ? [...body, "x"] : [...body.slice(0, 50), "x", ...body.slice(50)];
    add(`anchor-${seed}`, join(seed % 2 ? shrunk : grown), join(seed % 2 ? grown : shrunk));
  }

  // The heuristic "good snake" split. It is only tried past cost 256, and the forced split comes
  // at max(256, isqrt(N + M)), so it needs N + M > 66,000 and a cheap run of edits (one replaced
  // line in every five) that reaches a 30-line common block at cost 257 or 258.
  for (const groups of [126, 127, 128, 129, 130, 131]) {
    const r = rng(8000 + groups);
    const side = (tag: string) => {
      const lines: string[] = [];
      for (let g = 0; g < groups; g++) {
        for (let j = 0; j < 4; j++) lines.push(`p${g}-${j}`);
        lines.push(`${tag}${g}`);
      }
      lines.push(...distinctText(30, "block"));
      lines.push(...vocabText(r, 33000 + (r() % 500), 4));
      return lines;
    };
    const [o, n] = [side("o"), side("n")];
    add(`good-snake-${groups}`, join(o), join(n));
    // Reversed, the block is found by the backward search.
    if (groups === 129 || groups === 130) {
      add(`good-snake-rev-${groups}`, join(o.reverse()), join(n.reverse()));
    }
  }

  return cases;
}
