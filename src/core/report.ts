// How `main` prints a failure: miette's graphical report as `eprintln!("{:?}",
// report)` renders it without colour. The first line starts `  × `, every
// following line (wrapped, or from a newline in the message) starts `  │ `.
// Lines wrap at the terminal's width less two (78 without a terminal), and a
// word longer than a line is broken, as textwrap does with `break_words`.

export function reportWidth(): number {
  const cols = process.stderr.isTTY ? process.stderr.columns : undefined;
  return (cols && cols > 0 ? cols : 80) - 2;
}

function wrap(line: string, width: number): string[] {
  if ([...line].length <= width) return [line];
  const out: string[] = [];
  let cur = "";
  const len = (s: string) => [...s].length;
  for (const word of line.split(" ")) {
    let w = word;
    if (cur !== "" && len(cur) + 1 + len(w) <= width) {
      cur += ` ${w}`;
      continue;
    }
    if (cur !== "") out.push(cur);
    cur = "";
    while (len(w) > width) {
      const chars = [...w];
      out.push(chars.slice(0, width).join(""));
      w = chars.slice(width).join("");
    }
    cur = w;
  }
  out.push(cur);
  return out;
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
