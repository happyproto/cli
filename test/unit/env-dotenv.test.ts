// commands/happyview/env/dotenv.rs tests.
import { inspect } from "node:util";
import { expect, it } from "vitest";
import { BadLines, KEY_RULE, parse, validKey } from "../../src/commands/env/dotenv.ts";

const pairs = (text: string) => parse(text).map((e) => [e.key, e.value, e.line]);
const p = (key: string, value: string, line: number) => [key, value, line];

it("reads_what_happyview_reads", () => {
  const text =
    '\nKEY=1\nKEY2="2"\nKEY3=\'3\'\nKEY4=\'fo ur\'\nKEY5="fi ve"\nKEY6=s\\ ix\nKEY7=\nKEY8=     \nKEY9=   # foo\nKEY10  ="whitespace before ="\nKEY11=    "whitespace after ="\nexport="export as key"\nexport   SHELL_LOVER=1\n';
  expect(pairs(text)).toEqual([
    p("KEY", "1", 2),
    p("KEY2", "2", 3),
    p("KEY3", "3", 4),
    p("KEY4", "fo ur", 5),
    p("KEY5", "fi ve", 6),
    p("KEY6", "s ix", 7),
    p("KEY7", "", 8),
    p("KEY8", "", 9),
    p("KEY9", "", 10),
    p("KEY10", "whitespace before =", 11),
    p("KEY11", "whitespace after =", 12),
    p("export", "export as key", 13),
    p("SHELL_LOVER", "1", 14),
  ]);
});

it("comments_blank_lines_crlf_and_a_bom_are_skipped", () => {
  const text =
    "\u{feff}# a comment\r\nA=1\r\n\r\n  # indented\r\nB=two # trailing\r\nC=x#not-a-comment";
  expect(pairs(text)).toEqual([p("A", "1", 2), p("B", "two", 5), p("C", "x#not-a-comment", 6)]);
});

it("a_quoted_value_runs_over_lines_and_keeps_its_first_line", () => {
  const text = "A=1\nCERT=\"line one\nline two\"\nB='x\ny'\nC=3\n";
  expect(pairs(text)).toEqual([
    p("A", "1", 1),
    p("CERT", "line one\nline two", 2),
    p("B", "x\ny", 4),
    p("C", "3", 6),
  ]);
});

it("escapes_in_double_quotes_and_none_in_single", () => {
  expect(pairs('A="a\\nb \\"q\\" \\$x"\nB=\'a\\nb $x\'\n')).toEqual([
    p("A", 'a\nb "q" $x', 1),
    p("B", "a\\nb $x", 2),
  ]);
});

it("a_reference_is_filled_from_keys_above_it_and_never_the_environment", () => {
  const entries = parse("HOST=example.com\nURL=https://${HOST}/x\nP=$HOME/y\nQ=a$HOSTb\n");
  expect(entries[1]?.value).toBe("https://example.com/x");
  expect(entries[1]?.unset).toEqual([]);
  expect(entries[2]?.value).toBe("/y");
  expect(entries[2]?.unset).toEqual(["HOME"]);
  // As dotenvy reads it: the name runs to the first non-alphanumeric.
  expect(entries[3]?.unset).toEqual(["HOSTb"]);
});

it("a_trailing_blank_on_a_last_line_without_a_newline_is_fine", () => {
  expect(pairs("A=1 ")).toEqual([p("A", "1", 1)]);
});

it("bad_lines_are_named_by_number_only", () => {
  const text = 'OK=1\n1BAD=x\nMY-KEY=y\njust-a-secret-token\nSPACE=a b\nOPEN="never closed\n';
  let bad: unknown;
  try {
    parse(text);
  } catch (e) {
    bad = e;
  }
  expect(bad).toBeInstanceOf(BadLines);
  expect((bad as BadLines).bad).toEqual([
    { line: 2, why: KEY_RULE },
    { line: 3, why: KEY_RULE },
    { line: 4, why: "expected KEY=VALUE" },
    { line: 5, why: "the value has a space in it; quote it" },
    { line: 6, why: "a quote is never closed" },
  ]);
});

it("an_entry_never_prints_its_value", () => {
  const e = parse("API_TOKEN=sk-live-shown-nowhere\n");
  for (const shown of [inspect(e), String(e[0]), JSON.stringify(e)]) {
    expect(shown).toContain("API_TOKEN");
    expect(shown).not.toContain("sk-live-shown-nowhere");
  }
});

it("the_key_rule", () => {
  for (const ok of ["A", "_x", "api.token", "A_1"]) expect(validKey(ok), ok).toBe(true);
  for (const bad of ["", "1A", "MY-KEY", "A B", ".a", "é"]) expect(validKey(bad), bad).toBe(false);
});
