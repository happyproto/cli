// How `main` prints a failure: miette's graphical report as `eprintln!("{:?}",
// report)` renders it without colour. The first line starts `  × `, every
// following line (wrapped, or from a newline in the message) starts `  │ `.
// Lines wrap at the terminal's width less two (78 without a terminal).
//
// miette 7.6 wraps with textwrap 0.16.4 (features unicode-linebreak and
// unicode-width, no smawk): words end at Unicode line-break opportunities
// (UAX #14, found by icu_segmenter), except after `-`, which the hyphen
// splitter handles; a word longer than a line is broken (`break_words`); lines
// are filled first-fit. `breakOpportunities` implements the UAX #14 rules for
// the line-break classes of ASCII and the punctuation hpy's messages use;
// anything else counts as a letter (AL). LB25 is Unicode 15.1's pairwise form, which ICU
// follows. Known gap: a closing curly quote (`”`, `’`) followed by punctuation can break where
// ICU does not (its Pi/Pf quotation rules); hpy's messages quote with backticks.

export function reportWidth(): number {
  const cols = process.stderr.isTTY ? process.stderr.columns : undefined;
  return (cols && cols > 0 ? cols : 80) - 2;
}

type Cls =
  | "SP"
  | "AL"
  | "NU"
  | "OP"
  | "CL"
  | "CP"
  | "QU"
  | "IS"
  | "SY"
  | "HY"
  | "BA"
  | "B2"
  | "EX"
  | "PR"
  | "PO"
  | "IN"
  | "GL";

const ASCII: Record<string, Cls> = {
  " ": "SP",
  "(": "OP",
  "[": "OP",
  "{": "OP",
  ")": "CP",
  "]": "CP",
  "}": "CL",
  '"': "QU",
  "'": "QU",
  ",": "IS",
  ".": "IS",
  ":": "IS",
  ";": "IS",
  "/": "SY",
  "-": "HY",
  "|": "BA",
  "\t": "BA",
  "!": "EX",
  "?": "EX",
  $: "PR",
  "+": "PR",
  "\\": "PR",
  "%": "PO",
};
const OTHER: Record<string, Cls> = {
  "—": "B2", // em dash
  "–": "BA", // en dash
  "…": "IN", // ellipsis
  " ": "GL", // no-break space
  "‘": "QU",
  "’": "QU",
  "“": "QU",
  "”": "QU",
  "«": "QU",
  "»": "QU",
};

function cls(ch: string): Cls {
  const c = ASCII[ch] ?? OTHER[ch];
  if (c !== undefined) return c;
  if (ch >= "0" && ch <= "9") return "NU";
  return "AL";
}

const isLetterLike = (c: Cls) => c === "AL";

/** Whether UAX #14 allows a break between `chars[i - 1]` and `chars[i]`. */
function breakBefore(c: Cls[], i: number): boolean {
  const a = c[i - 1] as Cls;
  const b = c[i] as Cls;
  // LB7: × SP.
  if (b === "SP") return false;
  // The class before any spaces, for the rules written `X SP* ×`.
  let j = i - 1;
  while (j >= 0 && c[j] === "SP") j--;
  const before = j >= 0 ? (c[j] as Cls) : undefined;
  // LB12, LB12a: GL ×, [^SP BA HY] × GL.
  if (a === "GL") return false;
  if (b === "GL" && a !== "SP" && a !== "BA" && a !== "HY") return false;
  // LB13: × CL, × CP, × EX, × IS, × SY.
  if (b === "CL" || b === "CP" || b === "EX" || b === "IS" || b === "SY") return false;
  // LB14: OP SP* ×.
  if (before === "OP") return false;
  // LB15: QU SP* × OP.
  if (before === "QU" && b === "OP") return false;
  // LB17: B2 SP* × B2.
  if (before === "B2" && b === "B2") return false;
  // LB18: SP ÷.
  if (a === "SP") return true;
  // LB19: × QU, QU ×.
  if (b === "QU" || a === "QU") return false;
  // LB21: × BA, × HY.
  if (b === "BA" || b === "HY") return false;
  // LB22: × IN.
  if (b === "IN") return false;
  // LB23: (AL) × NU, NU × (AL).
  if ((isLetterLike(a) && b === "NU") || (a === "NU" && isLetterLike(b))) return false;
  // LB24: (PR|PO) × (AL), (AL) × (PR|PO).
  if ((a === "PR" || a === "PO") && isLetterLike(b)) return false;
  if (isLetterLike(a) && (b === "PR" || b === "PO")) return false;
  // LB25: numbers.
  if (lb25(c, i)) return false;
  // LB28: (AL) × (AL).
  if (isLetterLike(a) && isLetterLike(b)) return false;
  // LB29: IS × (AL).
  if (a === "IS" && isLetterLike(b)) return false;
  // LB30: (AL|NU) × OP, CP × (AL|NU).
  if ((isLetterLike(a) || a === "NU") && b === "OP") return false;
  if (a === "CP" && (isLetterLike(b) || b === "NU")) return false;
  // LB31: ÷.
  return true;
}

/** LB25 as Unicode 15.1 writes it, pair by pair, which ICU follows. */
const LB25 = new Set([
  "CL PO",
  "CP PO",
  "CL PR",
  "CP PR",
  "NU PO",
  "NU PR",
  "PO OP",
  "PO NU",
  "PR OP",
  "PR NU",
  "HY NU",
  "IS NU",
  "NU NU",
  "SY NU",
]);

function lb25(c: Cls[], i: number): boolean {
  return LB25.has(`${c[i - 1]} ${c[i]}`);
}

interface Word {
  word: string;
  whitespace: string;
}

const width = (s: string) => [...s].length;
const isAlnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** textwrap's `find_words_unicode_break_properties`: words end at break opportunities, never right after `-`. */
function findWords(line: string): Word[] {
  const chars = [...line];
  const classes = chars.map(cls);
  const words: Word[] = [];
  let start = 0;
  for (let i = 1; i < chars.length; i++) {
    if (chars[i - 1] === "-" || !breakBefore(classes, i)) continue;
    words.push(wordFrom(chars.slice(start, i).join("")));
    start = i;
  }
  if (start < chars.length) words.push(wordFrom(chars.slice(start).join("")));
  return words;
}

/** `Word::from`: a trailing run of `' '` is the word's whitespace. */
function wordFrom(s: string): Word {
  const word = s.replace(/ +$/, "");
  return { word, whitespace: s.slice(word.length) };
}

/** The hyphen splitter: after each `-` with an alphanumeric on both sides. */
function splitWords(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const chars = [...w.word];
    let prev = 0;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === "-" && isAlnum(chars[i - 1]) && isAlnum(chars[i + 1])) {
        out.push({ word: chars.slice(prev, i + 1).join(""), whitespace: "" });
        prev = i + 1;
      }
    }
    out.push({ word: chars.slice(prev).join(""), whitespace: w.whitespace });
  }
  return out;
}

/** `break_words`: a word wider than a line is cut into pieces that fit. */
function breakWords(words: Word[], lineWidth: number): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    if (width(w.word) <= lineWidth) {
      out.push(w);
      continue;
    }
    let piece = "";
    for (const ch of w.word) {
      if (piece !== "" && width(piece) + 1 > lineWidth) {
        out.push({ word: piece, whitespace: "" });
        piece = "";
      }
      piece += ch;
    }
    out.push({ word: piece, whitespace: w.whitespace });
  }
  return out;
}

/** `wrap_first_fit`. */
function firstFit(words: Word[], lineWidth: number): Word[][] {
  const lines: Word[][] = [];
  let start = 0;
  let w = 0;
  for (const [idx, word] of words.entries()) {
    if (w + width(word.word) > lineWidth && idx > start) {
      lines.push(words.slice(start, idx));
      start = idx;
      w = 0;
    }
    w += width(word.word) + width(word.whitespace);
  }
  lines.push(words.slice(start));
  return lines;
}

/** One line of the message, wrapped to `lineWidth` (the width less the 4-column indent). */
function wrap(line: string, lineWidth: number): string[] {
  const words = breakWords(splitWords(findWords(line)), lineWidth);
  // The first word may not fit the first line; an empty one lets first-fit decide.
  words.unshift({ word: "", whitespace: "" });
  return firstFit(words, lineWidth).map((ws) => {
    const last = ws.length - 1;
    return ws.map((w, i) => (i === last ? w.word : w.word + w.whitespace)).join("");
  });
}

/** The report, ending in a newline; `main` adds `eprintln!`'s own newline after it. */
export function renderReport(message: string, width = reportWidth()): string {
  const lines: string[] = [];
  for (const line of message.split("\n")) {
    for (const w of wrap(line, width - 4))
      lines.push(`${lines.length === 0 ? "  × " : "  │ "}${w}`);
  }
  return `${lines.join("\n")}\n`;
}
