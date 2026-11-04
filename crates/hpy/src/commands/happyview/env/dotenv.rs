//! A project's `.env`, read the way HappyView reads it for `ctx.env` (with
//! dotenvy 0.15, whose syntax this follows), so `hpy hv env push` sends what
//! `hpy hv dev` would give a script.
//!
//! One difference: a `$NAME` in a value is filled only from the keys set
//! above it in the file, never from the process environment, so what is sent
//! does not depend on the shell `hpy` runs in. A name the file does not set
//! is filled with nothing, and reported, so the caller can say so.
//!
//! Nothing here prints, and no error carries text from the file: a line that
//! does not parse is usually a secret, so it is named by its number only.

use std::collections::HashMap;

/// One `KEY=VALUE`.
pub struct Entry {
    pub key: String,
    pub value: String,
    /// The 1-based line it starts on.
    pub line: usize,
    /// The `$NAME`s in its value that no key above it sets.
    pub unset: Vec<String>,
}

impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The value is a secret; never print it.
        f.debug_struct("Entry")
            .field("key", &self.key)
            .field("line", &self.line)
            .finish_non_exhaustive()
    }
}

/// A line that is not a `KEY=VALUE` HappyView can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadLine {
    pub line: usize,
    pub why: &'static str,
}

pub const KEY_RULE: &str = "a key starts with a letter or _, and has only letters, digits, _ and .";

/// Whether `key` is one HappyView's `.env` reader accepts. The admin API
/// itself takes any string, so this is the rule a key has to meet to be the
/// same key in `.env` and on the instance.
pub fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Every entry in `text`, in order, or every line that doesn't parse.
pub fn parse(text: &str) -> Result<Vec<Entry>, Vec<BadLine>> {
    // A Windows editor's byte-order mark would otherwise begin the first key.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut entries = Vec::new();
    let mut bad = Vec::new();
    let mut known: HashMap<String, Option<String>> = HashMap::new();
    for logical in logical_lines(text) {
        let (line, body) = match logical {
            Ok(l) => l,
            Err(b) => {
                bad.push(b);
                continue;
            }
        };
        match parse_line(&body, &mut known) {
            Ok(Some((key, value, unset))) => entries.push(Entry {
                key,
                value,
                line,
                unset,
            }),
            Ok(None) => {}
            Err(why) => bad.push(BadLine { line, why }),
        }
    }
    if bad.is_empty() {
        Ok(entries)
    } else {
        Err(bad)
    }
}

#[derive(Clone, Copy)]
enum State {
    Complete,
    Escape,
    StrongOpen,
    StrongOpenEscape,
    WeakOpen,
    WeakOpenEscape,
    Comment,
    WhiteSpace,
}

/// Where a physical line leaves a logical one, and where a trailing comment
/// starts.
fn end_state(from: State, buf: &str) -> (usize, State) {
    let mut state = from;
    let mut at = 0;
    for (pos, c) in buf.char_indices() {
        at = pos;
        state = match state {
            State::WhiteSpace => match c {
                '#' => return (at, State::Comment),
                '\\' => State::Escape,
                '"' => State::WeakOpen,
                '\'' => State::StrongOpen,
                _ => State::Complete,
            },
            State::Escape => State::Complete,
            State::Complete => match c {
                c if c.is_whitespace() && c != '\n' && c != '\r' => State::WhiteSpace,
                '\\' => State::Escape,
                '"' => State::WeakOpen,
                '\'' => State::StrongOpen,
                _ => State::Complete,
            },
            State::WeakOpen => match c {
                '\\' => State::WeakOpenEscape,
                '"' => State::Complete,
                _ => State::WeakOpen,
            },
            State::WeakOpenEscape => State::WeakOpen,
            State::StrongOpen => match c {
                '\\' => State::StrongOpenEscape,
                '\'' => State::Complete,
                _ => State::StrongOpen,
            },
            State::StrongOpenEscape => State::StrongOpen,
            State::Comment => unreachable!("returned as it was found"),
        };
    }
    (at, state)
}

/// The file's logical lines, each with the line it starts on: a quoted value
/// may run over several.
fn logical_lines(text: &str) -> Vec<Result<(usize, String), BadLine>> {
    let mut out = Vec::new();
    let mut physical = text.split_inclusive('\n').enumerate();
    'logical: loop {
        let mut buf = String::new();
        let mut state = State::Complete;
        let mut start = 0;
        loop {
            let Some((i, line)) = physical.next() else {
                match state {
                    State::Complete => {}
                    // Trailing blanks on a last line with no newline.
                    State::WhiteSpace => out.push(Ok((start, buf))),
                    _ => out.push(Err(BadLine {
                        line: start,
                        why: "a quote is never closed",
                    })),
                }
                break 'logical;
            };
            if buf.is_empty() {
                start = i + 1;
            }
            let from = buf.len();
            buf.push_str(line);
            if buf.trim_start().starts_with('#') {
                continue 'logical;
            }
            let (at, next) = end_state(state, &buf[from..]);
            state = next;
            match state {
                State::Complete => {
                    if buf.ends_with('\n') {
                        buf.pop();
                        if buf.ends_with('\r') {
                            buf.pop();
                        }
                    }
                    out.push(Ok((start, buf)));
                    continue 'logical;
                }
                State::Comment => {
                    buf.truncate(from + at);
                    out.push(Ok((start, buf)));
                    continue 'logical;
                }
                _ => {}
            }
        }
    }
    out
}

type Parsed = Option<(String, String, Vec<String>)>;

fn parse_line(
    line: &str,
    known: &mut HashMap<String, Option<String>>,
) -> Result<Parsed, &'static str> {
    let mut rest = line.trim_end().trim_start();
    if rest.is_empty() || rest.starts_with('#') {
        return Ok(None);
    }
    let mut key = take_key(&mut rest)?;
    rest = rest.trim_start();
    // `export` is either a prefix or a key of its own.
    if key == "export" && !rest.starts_with('=') {
        key = take_key(&mut rest)?;
        rest = rest.trim_start();
    }
    rest = rest.strip_prefix('=').ok_or(if rest.contains('=') {
        KEY_RULE
    } else {
        "expected KEY=VALUE"
    })?;
    rest = rest.trim_start();
    if rest.is_empty() || rest.starts_with('#') {
        known.insert(key.clone(), None);
        return Ok(Some((key, String::new(), Vec::new())));
    }
    let (value, unset) = parse_value(rest, known)?;
    known.insert(key.clone(), Some(value.clone()));
    Ok(Some((key, value, unset)))
}

fn take_key(rest: &mut &str) -> Result<String, &'static str> {
    if !rest.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        return Err(KEY_RULE);
    }
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
        .unwrap_or(rest.len());
    let key = rest[..end].to_string();
    *rest = &rest[end..];
    Ok(key)
}

#[derive(PartialEq)]
enum Sub {
    None,
    Block,
    Braced,
}

fn fill(
    known: &HashMap<String, Option<String>>,
    name: &mut String,
    out: &mut String,
    unset: &mut Vec<String>,
) {
    let name = std::mem::take(name);
    match known.get(&name) {
        Some(value) => out.push_str(value.as_deref().unwrap_or_default()),
        None if !name.is_empty() && !unset.contains(&name) => unset.push(name),
        None => {}
    }
}

fn parse_value(
    input: &str,
    known: &HashMap<String, Option<String>>,
) -> Result<(String, Vec<String>), &'static str> {
    let mut strong = false;
    let mut weak = false;
    let mut escaped = false;
    let mut expecting_end = false;
    let mut out = String::new();
    let mut unset = Vec::new();
    let mut sub = Sub::None;
    let mut name = String::new();

    for c in input.chars() {
        if expecting_end {
            if c == ' ' || c == '\t' {
                continue;
            } else if c == '#' {
                break;
            }
            return Err("the value has a space in it; quote it");
        } else if escaped {
            match c {
                '\\' | '\'' | '"' | '$' | ' ' => out.push(c),
                'n' => out.push('\n'),
                _ => return Err("the value has a \\ escape .env doesn't support"),
            }
            escaped = false;
        } else if strong {
            if c == '\'' {
                strong = false;
            } else {
                out.push(c);
            }
        } else if sub != Sub::None {
            if c.is_alphanumeric() {
                name.push(c);
            } else if sub == Sub::Block {
                if c == '{' && name.is_empty() {
                    sub = Sub::Braced;
                } else {
                    fill(known, &mut name, &mut out, &mut unset);
                    if c == '$' {
                        sub = Sub::Block;
                    } else {
                        sub = Sub::None;
                        out.push(c);
                    }
                }
            } else if c == '}' {
                sub = Sub::None;
                fill(known, &mut name, &mut out, &mut unset);
            } else {
                name.push(c);
            }
        } else if c == '$' {
            sub = Sub::Block;
        } else if weak {
            if c == '"' {
                weak = false;
            } else if c == '\\' {
                escaped = true;
            } else {
                out.push(c);
            }
        } else if c == '\'' {
            strong = true;
        } else if c == '"' {
            weak = true;
        } else if c == '\\' {
            escaped = true;
        } else if c == ' ' || c == '\t' {
            expecting_end = true;
        } else {
            out.push(c);
        }
    }
    if sub == Sub::Braced {
        return Err("a ${ is never closed");
    }
    if strong || weak {
        return Err("a quote is never closed");
    }
    fill(known, &mut name, &mut out, &mut unset);
    Ok((out, unset))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(text: &str) -> Vec<(String, String, usize)> {
        parse(text)
            .unwrap()
            .into_iter()
            .map(|e| (e.key, e.value, e.line))
            .collect()
    }

    fn p(key: &str, value: &str, line: usize) -> (String, String, usize) {
        (key.into(), value.into(), line)
    }

    /// The cases dotenvy's own tests read, with the values it reads them as.
    #[test]
    fn reads_what_happyview_reads() {
        let text = "\nKEY=1\nKEY2=\"2\"\nKEY3='3'\nKEY4='fo ur'\nKEY5=\"fi ve\"\nKEY6=s\\ ix\nKEY7=\nKEY8=     \nKEY9=   # foo\nKEY10  =\"whitespace before =\"\nKEY11=    \"whitespace after =\"\nexport=\"export as key\"\nexport   SHELL_LOVER=1\n";
        assert_eq!(
            pairs(text),
            [
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
            ]
        );
    }

    #[test]
    fn comments_blank_lines_crlf_and_a_bom_are_skipped() {
        let text = "\u{feff}# a comment\r\nA=1\r\n\r\n  # indented\r\nB=two # trailing\r\nC=x#not-a-comment";
        assert_eq!(
            pairs(text),
            [
                p("A", "1", 2),
                p("B", "two", 5),
                p("C", "x#not-a-comment", 6)
            ]
        );
    }

    #[test]
    fn a_quoted_value_runs_over_lines_and_keeps_its_first_line() {
        let text = "A=1\nCERT=\"line one\nline two\"\nB='x\ny'\nC=3\n";
        assert_eq!(
            pairs(text),
            [
                p("A", "1", 1),
                p("CERT", "line one\nline two", 2),
                p("B", "x\ny", 4),
                p("C", "3", 6),
            ]
        );
    }

    #[test]
    fn escapes_in_double_quotes_and_none_in_single() {
        assert_eq!(
            pairs("A=\"a\\nb \\\"q\\\" \\$x\"\nB='a\\nb $x'\n"),
            [p("A", "a\nb \"q\" $x", 1), p("B", "a\\nb $x", 2)]
        );
    }

    /// Filled from the file only: the process environment is never read, so
    /// even a name every shell sets is reported as unset.
    #[test]
    fn a_reference_is_filled_from_keys_above_it_and_never_the_environment() {
        let entries =
            parse("HOST=example.com\nURL=https://${HOST}/x\nP=$HOME/y\nQ=a$HOSTb\n").unwrap();
        assert_eq!(entries[1].value, "https://example.com/x");
        assert!(entries[1].unset.is_empty());
        assert_eq!(entries[2].value, "/y");
        assert_eq!(entries[2].unset, ["HOME"]);
        // As dotenvy reads it: the name runs to the first non-alphanumeric.
        assert_eq!(entries[3].unset, ["HOSTb"]);
    }

    #[test]
    fn a_trailing_blank_on_a_last_line_without_a_newline_is_fine() {
        assert_eq!(pairs("A=1 "), [p("A", "1", 1)]);
    }

    /// Every bad line is named by number, and no text from it is kept.
    #[test]
    fn bad_lines_are_named_by_number_only() {
        let text = "OK=1\n1BAD=x\nMY-KEY=y\njust-a-secret-token\nSPACE=a b\nOPEN=\"never closed\n";
        let bad = parse(text).unwrap_err();
        assert_eq!(
            bad,
            [
                BadLine {
                    line: 2,
                    why: KEY_RULE
                },
                BadLine {
                    line: 3,
                    why: KEY_RULE
                },
                BadLine {
                    line: 4,
                    why: "expected KEY=VALUE"
                },
                BadLine {
                    line: 5,
                    why: "the value has a space in it; quote it"
                },
                BadLine {
                    line: 6,
                    why: "a quote is never closed"
                },
            ]
        );
    }

    #[test]
    fn an_entry_never_prints_its_value() {
        let e = parse("API_TOKEN=sk-live-shown-nowhere\n").unwrap();
        let shown = format!("{e:?}");
        assert!(shown.contains("API_TOKEN"), "{shown}");
        assert!(!shown.contains("sk-live-shown-nowhere"), "{shown}");
    }

    #[test]
    fn the_key_rule() {
        for ok in ["A", "_x", "api.token", "A_1"] {
            assert!(valid_key(ok), "{ok}");
        }
        for bad in ["", "1A", "MY-KEY", "A B", ".a", "é"] {
            assert!(!valid_key(bad), "{bad}");
        }
    }
}
