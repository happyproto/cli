//! Handlers for a project's queries and procedures: which lexicons have
//! none, and the starter `hpy happyview scaffold` writes beside one.
//!
//! HappyView answers a query lexicon that has no handler only for `?uri=`,
//! and refuses everything else with `501 MethodNotImplemented`; a procedure
//! with none is refused outright. Neither is told which collection it serves,
//! so a handler names its collection itself.

use std::path::{Path, PathBuf};

use hpy_plugin::Problem;

/// Stands in the templates for the collection a handler reads or writes.
pub const PLACEHOLDER: &str = "COLLECTION";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LexiconKind {
    Query,
    Procedure,
    Record,
    Other,
}

impl LexiconKind {
    fn of(main_type: &str) -> LexiconKind {
        match main_type {
            "query" => LexiconKind::Query,
            "procedure" => LexiconKind::Procedure,
            "record" => LexiconKind::Record,
            _ => LexiconKind::Other,
        }
    }

    /// Whether HappyView runs a handler for it.
    pub fn is_method(self) -> bool {
        matches!(self, LexiconKind::Query | LexiconKind::Procedure)
    }

    pub fn label(self) -> &'static str {
        match self {
            LexiconKind::Query => "query",
            LexiconKind::Procedure => "procedure",
            LexiconKind::Record => "record",
            LexiconKind::Other => "lexicon",
        }
    }

    /// The library a starter handler of this kind calls.
    pub fn library(self) -> Option<&'static str> {
        match self {
            LexiconKind::Query => Some("happyview.db"),
            LexiconKind::Procedure => Some("happyview.record"),
            _ => None,
        }
    }

    /// What a handler of this kind does with its collection, for prompts and
    /// the placeholder's comment.
    pub fn verb(self) -> &'static str {
        match self {
            LexiconKind::Procedure => "writes",
            _ => "reads",
        }
    }
}

/// One lexicon file under `src/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lexicon {
    pub nsid: String,
    pub kind: LexiconKind,
    /// Relative to the project root.
    pub path: PathBuf,
    /// Whether its main def declares query parameters, so HappyView's types
    /// export a `Params` for it.
    pub has_params: bool,
    /// Whether its main def declares an input schema, so the types export an
    /// `Input`.
    pub has_input: bool,
}

impl Lexicon {
    /// Reads a lexicon document; `None` for JSON that is not one.
    pub fn parse(path: PathBuf, text: &str) -> Option<Lexicon> {
        let doc: serde_json::Value = serde_json::from_str(text).ok()?;
        let nsid = doc.get("id")?.as_str()?.to_string();
        let main = doc.get("defs")?.get("main")?;
        let kind = LexiconKind::of(main.get("type")?.as_str()?);
        // As HappyView decides (src/project/declarations/lexicon.rs): a
        // `parameters` block, even an empty one, exports `Params`. `Input` is
        // imported only for a schema, though any `input` exports one, since
        // only a schema's types fit a record.
        let has_params = main.get("parameters").is_some();
        let has_input = main.get("input").and_then(|i| i.get("schema")).is_some();
        Some(Lexicon {
            nsid,
            kind,
            path,
            has_params,
            has_input,
        })
    }

    /// The file beside it, with its basename, that a handler in `language`
    /// would be.
    pub fn handler_path(&self, extension: &str) -> PathBuf {
        self.path.with_extension(extension)
    }

    /// A handler already beside it, in any language: a file sharing its
    /// basename with any extension but `.json`.
    pub fn existing_handler(&self, root: &Path) -> Option<PathBuf> {
        let stem = self.path.file_stem()?;
        let dir = self.path.parent().unwrap_or(Path::new(""));
        let mut found: Vec<PathBuf> = std::fs::read_dir(root.join(dir))
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_stem() == Some(stem)
                    && p.extension().is_some_and(|e| e != "json")
                    && !p.is_dir()
            })
            .map(|p| dir.join(p.file_name().expect("a file has a name")))
            .collect();
        found.sort();
        found.into_iter().next()
    }
}

/// Every lexicon under `root/src`, in path order. JSON that is not a
/// lexicon is passed over: `happyview check` is what reports a broken one.
pub fn scan(root: &Path) -> Result<Vec<Lexicon>, Problem> {
    let mut out = Vec::new();
    let src = root.join("src");
    if src.is_dir() {
        walk(root, &src, &mut out)?;
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<Lexicon>) -> Result<(), Problem> {
    let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_path_buf();
    let entries = std::fs::read_dir(dir)
        .map_err(|e| Problem::new(rel(dir).display().to_string(), format!("reading it: {e}")))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk(root, &path, out)?;
        } else if path.extension().is_some_and(|e| e == "json")
            && let Ok(text) = std::fs::read_to_string(&path)
            && let Some(lexicon) = Lexicon::parse(rel(&path), &text)
        {
            out.push(lexicon);
        }
    }
    Ok(())
}

/// The first `[interpreters]` key in `happyview.toml` as written, which is
/// the language `scaffold` writes handlers in.
pub fn first_interpreter(text: &str) -> Option<String> {
    let doc: toml_edit::DocumentMut = text.parse().ok()?;
    doc.get("interpreters")?
        .as_table_like()?
        .iter()
        .next()
        .map(|(k, _)| k.to_string())
}

/// The extension of a handler in `language`, when hpy has a template in it.
pub fn handler_extension(language: &str) -> Option<&'static str> {
    match language {
        "lua" => Some("lua"),
        "typescript" => Some("ts"),
        "javascript" => Some("js"),
        _ => None,
    }
}

fn template(language: &str, kind: LexiconKind) -> Option<&'static str> {
    Some(match (language, kind) {
        ("lua", LexiconKind::Query) => include_str!("../templates/query.lua"),
        ("lua", LexiconKind::Procedure) => include_str!("../templates/procedure.lua"),
        ("typescript", LexiconKind::Query) => include_str!("../templates/query.ts"),
        ("typescript", LexiconKind::Procedure) => include_str!("../templates/procedure.ts"),
        ("javascript", LexiconKind::Query) => include_str!("../templates/query.js"),
        ("javascript", LexiconKind::Procedure) => include_str!("../templates/procedure.js"),
        _ => return None,
    })
}

/// The lexicon type a TypeScript or JavaScript handler's input is declared
/// as, and the import TypeScript needs for it. HappyView's types export
/// `Params` and `Input` only for a lexicon that declares them, so one that
/// does not gets a plain type instead.
fn input_type(language: &str, lexicon: &Lexicon) -> (String, String) {
    let module = format!("happyview:lexicons/{}", lexicon.nsid);
    let (name, declared, fallback) = match lexicon.kind {
        LexiconKind::Query => ("Params", lexicon.has_params, "Query"),
        _ => ("Input", lexicon.has_input, "{ [key: string]: unknown }"),
    };
    // A query's handler reads `uri`, `did`, `limit` and `cursor` whatever
    // the lexicon declares, so its input is the lexicon's params and those.
    let extra = if lexicon.kind == LexiconKind::Query {
        " & Query"
    } else {
        ""
    };
    match (declared, language) {
        (false, _) => (String::new(), fallback.to_string()),
        (true, "typescript") => (
            format!("import type {{ {name} }} from \"{module}\";\n"),
            format!("{name}{extra}"),
        ),
        (true, _) => (String::new(), format!("import(\"{module}\").{name}{extra}")),
    }
}

/// A starter handler for `lexicon` in `language`, naming `collection`, or the
/// placeholder under a comment saying to replace it when there is none.
pub fn render_handler(
    language: &str,
    lexicon: &Lexicon,
    collection: Option<&str>,
) -> Option<String> {
    let body = template(language, lexicon.kind)?;
    let (import, input) = input_type(language, lexicon);
    let body = body
        .replace("LEXICON_IMPORT", &import)
        .replace("INPUT_TYPE", &input);
    let quoted = format!("\"{PLACEHOLDER}\"");
    Some(match collection {
        Some(c) => body.replace(&quoted, &format!("\"{c}\"")),
        None => {
            let comment = if language == "lua" { "--" } else { "//" };
            let mut out = String::new();
            for line in body.split_inclusive('\n') {
                if line.contains(&quoted) {
                    let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                    out.push_str(&format!(
                        "{indent}{comment} TODO: name the collection this {}\n",
                        lexicon.kind.verb()
                    ));
                }
                out.push_str(line);
            }
            out
        }
    })
}

/// An NSID as atproto writes one: at least three dot-separated segments, the
/// domain ones letters, digits and `-`, the last letters and digits.
pub fn check_nsid(s: &str) -> Result<(), String> {
    let bad = || Err(format!("`{s}` is not an NSID, such as com.example.note"));
    let parts: Vec<&str> = s.split('.').collect();
    if s.len() > 317 || parts.len() < 3 {
        return bad();
    }
    let (name, domain) = parts.split_last().expect("three parts");
    let domain_ok = domain.iter().all(|p| {
        !p.is_empty()
            && p.len() <= 63
            && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !p.starts_with('-')
            && !p.ends_with('-')
    });
    let name_ok = name.len() <= 63
        && name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name.bytes().all(|b| b.is_ascii_alphanumeric());
    if domain_ok && name_ok { Ok(()) } else { bad() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexicon(kind: LexiconKind, has_params: bool, has_input: bool) -> Lexicon {
        Lexicon {
            nsid: "com.example.listNotes".into(),
            kind,
            path: "src/lexicons/com/example/listNotes.json".into(),
            has_params,
            has_input,
        }
    }

    #[test]
    fn the_lua_bodies_are_the_dashboards_with_the_collection_named() {
        let query = render_handler(
            "lua",
            &lexicon(LexiconKind::Query, true, false),
            Some("com.example.note"),
        )
        .unwrap();
        assert_eq!(
            query,
            include_str!("../templates/query.lua").replace("COLLECTION", "com.example.note")
        );
        assert!(query.contains("return db.records(\"com.example.note\")\n"));
        assert!(query.contains("local db = require(\"happyview.db\")"));
        let procedure = render_handler(
            "lua",
            &lexicon(LexiconKind::Procedure, false, true),
            Some("com.example.note"),
        )
        .unwrap();
        assert!(
            procedure.contains("record.create(\"com.example.note\", input)"),
            "{procedure}"
        );
        assert!(!procedure.contains(PLACEHOLDER));
    }

    #[test]
    fn without_a_collection_the_placeholder_has_a_comment_above_it() {
        let query = render_handler("lua", &lexicon(LexiconKind::Query, true, false), None).unwrap();
        assert!(
            query.contains(
                "  -- TODO: name the collection this reads\n  return db.records(\"COLLECTION\")\n"
            ),
            "{query}"
        );
        let ts = render_handler(
            "typescript",
            &lexicon(LexiconKind::Procedure, false, true),
            None,
        )
        .unwrap();
        assert!(
            ts.contains(
                "  // TODO: name the collection this writes\n  const ref = await record.create(\"COLLECTION\", input);\n"
            ),
            "{ts}"
        );
    }

    #[test]
    fn typescript_imports_only_the_lexicon_types_that_exist() {
        let with = render_handler(
            "typescript",
            &lexicon(LexiconKind::Query, true, false),
            Some("com.example.note"),
        )
        .unwrap();
        assert!(
            with.starts_with(
                "import db from \"happyview.db\";\n\
             import type { Params } from \"happyview:lexicons/com.example.listNotes\";\n\
             import type { QueryCtx } from \"happyview:ctx\";\n"
            ),
            "{with}"
        );
        assert!(
            with.contains("handle(input: Params & Query, ctx: QueryCtx)"),
            "{with}"
        );
        let without = render_handler(
            "typescript",
            &lexicon(LexiconKind::Query, false, false),
            Some("a.b.c"),
        )
        .unwrap();
        assert!(!without.contains("happyview:lexicons"), "{without}");
        assert!(
            without.contains("handle(input: Query, ctx: QueryCtx)"),
            "{without}"
        );
        let procedure = render_handler(
            "typescript",
            &lexicon(LexiconKind::Procedure, false, true),
            Some("a.b.c"),
        )
        .unwrap();
        assert!(
            procedure.contains(
                "import type { Input } from \"happyview:lexicons/com.example.listNotes\";\n"
            ),
            "{procedure}"
        );
        assert!(
            procedure.contains("handle(input: Input, ctx: ProcedureCtx)"),
            "{procedure}"
        );
        for body in [&with, &without, &procedure] {
            assert!(
                !body.contains("LEXICON_IMPORT") && !body.contains("INPUT_TYPE"),
                "{body}"
            );
        }
    }

    #[test]
    fn javascript_names_the_types_in_jsdoc() {
        let js = render_handler(
            "javascript",
            &lexicon(LexiconKind::Query, true, false),
            Some("a.b.c"),
        )
        .unwrap();
        assert!(
            js.contains(" * @param {import(\"happyview:lexicons/com.example.listNotes\").Params & Query} input\n"),
            "{js}"
        );
        let procedure = render_handler(
            "javascript",
            &lexicon(LexiconKind::Procedure, false, false),
            Some("a.b.c"),
        )
        .unwrap();
        assert!(
            procedure.contains(" * @param {{ [key: string]: unknown }} input\n"),
            "{procedure}"
        );
        assert!(
            render_handler("python", &lexicon(LexiconKind::Query, true, false), None).is_none()
        );
        assert!(render_handler("lua", &lexicon(LexiconKind::Record, false, false), None).is_none());
    }

    #[test]
    fn a_lexicon_is_read_for_its_kind_and_declared_types() {
        let q = Lexicon::parse(
            "a.json".into(),
            r#"{"lexicon":1,"id":"com.example.q","defs":{"main":{"type":"query",
                "parameters":{"type":"params","properties":{"limit":{"type":"integer"}}}}}}"#,
        )
        .unwrap();
        assert_eq!(
            (q.kind, q.has_params, q.has_input),
            (LexiconKind::Query, true, false)
        );
        let p = Lexicon::parse(
            "b.json".into(),
            r#"{"lexicon":1,"id":"com.example.p","defs":{"main":{"type":"procedure",
                "input":{"encoding":"application/json","schema":{"type":"object"}}}}}"#,
        )
        .unwrap();
        assert_eq!(
            (p.kind, p.has_params, p.has_input),
            (LexiconKind::Procedure, false, true)
        );
        assert!(Lexicon::parse("c.json".into(), r#"{"name":"not a lexicon"}"#).is_none());
        assert!(Lexicon::parse("d.json".into(), "not json").is_none());
    }

    #[test]
    fn scan_finds_lexicons_and_their_handlers_under_src() {
        let dir = tempfile::tempdir().unwrap();
        let lex = dir.path().join("src/lexicons/com/example");
        std::fs::create_dir_all(&lex).unwrap();
        let doc = |id: &str, ty: &str| {
            format!(r#"{{"lexicon":1,"id":"{id}","defs":{{"main":{{"type":"{ty}"}}}}}}"#)
        };
        std::fs::write(
            lex.join("listNotes.json"),
            doc("com.example.listNotes", "query"),
        )
        .unwrap();
        std::fs::write(lex.join("note.json"), doc("com.example.note", "record")).unwrap();
        std::fs::write(lex.join("hello.json"), doc("com.example.hello", "query")).unwrap();
        std::fs::write(lex.join("hello.ts"), "").unwrap();
        std::fs::write(lex.join("listNotes.test.lua"), "").unwrap();
        std::fs::write(dir.path().join("src/tsconfig.json"), "{}").unwrap();
        let found = scan(dir.path()).unwrap();
        let ids: Vec<&str> = found.iter().map(|l| l.nsid.as_str()).collect();
        assert_eq!(
            ids,
            [
                "com.example.hello",
                "com.example.listNotes",
                "com.example.note"
            ]
        );
        assert_eq!(
            found[0].existing_handler(dir.path()),
            Some(PathBuf::from("src/lexicons/com/example/hello.ts"))
        );
        // A test file beside it is not its handler.
        assert_eq!(found[1].existing_handler(dir.path()), None);
        assert_eq!(
            found[1].handler_path("lua"),
            Path::new("src/lexicons/com/example/listNotes.lua")
        );
        assert!(scan(&dir.path().join("nowhere")).unwrap().is_empty());
    }

    #[test]
    fn the_first_interpreter_is_the_first_written() {
        let text = "[happyview]\nversion = \"3.0.0\"\n\n[interpreters]\n\
                    typescript = { did = \"did:plc:a\", name = \"ts\", channel = \"latest\" }\n\
                    lua = { did = \"did:plc:a\", name = \"lua\", channel = \"latest\" }\n";
        assert_eq!(first_interpreter(text).as_deref(), Some("typescript"));
        assert_eq!(first_interpreter("[happyview]\n"), None);
        assert_eq!(first_interpreter("[interpreters]\n"), None);
    }

    #[test]
    fn nsids_follow_the_atproto_grammar() {
        for ok in ["com.example.note", "app.bsky.feed.post", "a-b.c.d1"] {
            assert_eq!(check_nsid(ok), Ok(()), "{ok}");
        }
        for bad in [
            "com.example",
            "com..note",
            "com.example.1note",
            "com.example.no-te",
            "-a.b.c",
            "",
        ] {
            assert!(check_nsid(bad).is_err(), "{bad}");
        }
    }
}
