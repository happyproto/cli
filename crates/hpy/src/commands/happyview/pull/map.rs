//! Where each thing an instance holds goes in a project, decided from the
//! thing alone: no network, no disk.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use hpy_project::scaffold::{LexiconSettings, ScriptSettings};
use regex::Regex;

/// What a script handles, as the codemod's `--kind` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    Procedure,
    Record,
    Job,
    Label,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Query => "query",
            Kind::Procedure => "procedure",
            Kind::Record => "record",
            Kind::Job => "job",
            Kind::Label => "label",
        }
    }
}

/// A trigger id split into what it fires on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trigger {
    pub kind: Kind,
    /// `create`, `update`, `delete` or `index` for a record trigger.
    pub event: Option<&'static str>,
    /// The NSID, job type or `_actor` after the colon.
    pub target: String,
}

impl Trigger {
    /// The lexicon it needs on the instance, for the kinds that have one.
    pub fn lexicon(&self) -> Option<&str> {
        match self.kind {
            Kind::Query | Kind::Procedure | Kind::Record => Some(&self.target),
            Kind::Job | Kind::Label => None,
        }
    }
}

/// The prefixes HappyView's `ParsedTrigger::parse` takes, in v2 and v3 alike.
pub fn parse_trigger(id: &str) -> Option<Trigger> {
    let (prefix, target) = id.split_once(':')?;
    let (kind, event) = match prefix {
        "xrpc.query" => (Kind::Query, None),
        "xrpc.procedure" => (Kind::Procedure, None),
        "record.create" => (Kind::Record, Some("create")),
        "record.update" => (Kind::Record, Some("update")),
        "record.delete" => (Kind::Record, Some("delete")),
        "record.index" => (Kind::Record, Some("index")),
        "job.run" => (Kind::Job, None),
        "labeler.apply" => (Kind::Label, None),
        _ => return None,
    };
    Some(Trigger {
        kind,
        event,
        target: target.to_string(),
    })
}

/// An NSID that can be a path under `src/lexicons/`: dot-separated segments
/// of letters, digits and `-`, nothing that could climb out.
fn nsid_ok(nsid: &str) -> bool {
    nsid.split('.').count() >= 3
        && nsid
            .split('.')
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// A whole file name under `src/jobs/` or `src/labels/`.
fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// `src/lexicons/com/example/hello.json` for `com.example.hello`.
pub fn lexicon_path(nsid: &str) -> Result<String, String> {
    if !nsid_ok(nsid) {
        return Err(format!("`{nsid}` is not an NSID a file can be named by"));
    }
    Ok(format!("src/lexicons/{}.json", nsid.replace('.', "/")))
}

/// Where a trigger's handler goes, as HappyView's `project/layout.rs` reads
/// it back.
pub fn handler_path(t: &Trigger, ext: &str) -> Result<String, String> {
    let lexicon_base = |nsid: &str| -> Result<String, String> {
        lexicon_path(nsid).map(|p| p.trim_end_matches(".json").to_string())
    };
    match (t.kind, t.event) {
        (Kind::Query | Kind::Procedure, _) => Ok(format!("{}.{ext}", lexicon_base(&t.target)?)),
        (Kind::Record, Some(event)) => Ok(format!("{}.{event}.{ext}", lexicon_base(&t.target)?)),
        (Kind::Record, None) => Err("a record trigger without its event".into()),
        (Kind::Job | Kind::Label, _) => {
            if !name_ok(&t.target) {
                return Err(format!("`{}` cannot be a file name", t.target));
            }
            let dir = if t.kind == Kind::Job {
                "jobs"
            } else {
                "labels"
            };
            Ok(format!("src/{dir}/{}.{ext}", t.target))
        }
    }
}

/// A path the instance gave, if it is one a project can hold: relative,
/// under `src/`, with nothing that climbs out.
pub fn safe_src_path(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let ok = path.starts_with("src/")
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    ok.then_some(path)
}

/// The extension a language's files take: the one its interpreter claims
/// first, else the usual one, else (`false`) the language id itself.
pub fn extension(language: &str, claimed: &BTreeMap<String, String>) -> (String, bool) {
    if let Some(ext) = claimed.get(language) {
        return (ext.clone(), true);
    }
    match language {
        "lua" => ("lua".into(), true),
        "typescript" => ("ts".into(), true),
        "javascript" => ("js".into(), true),
        other => (other.to_string(), false),
    }
}

/// `[lexicons."<nsid>"]` with only what differs from a project lexicon's
/// defaults: no backfill, no token cost, indexed (`project/lexicons.rs`).
/// Backfill and indexing are about a collection, so they are kept only for
/// a record lexicon (or one whose type the instance didn't say): v2 sets
/// backfill on every lexicon it stores.
pub fn lexicon_settings(
    lexicon_type: Option<&str>,
    backfill: bool,
    token_cost: Option<i64>,
    indexed: Option<bool>,
) -> LexiconSettings {
    let collection = lexicon_type.is_none_or(|t| t == "record");
    LexiconSettings {
        backfill: (collection && backfill).then_some(true),
        token_cost,
        indexed: indexed.filter(|i| collection && !i),
    }
}

/// `.env.example`: each script variable's key with no value. Values never
/// leave the instance.
pub fn env_example(keys: &[String]) -> String {
    let mut out = String::from(
        "# The script variables the instance has. `hpy happyview pull` copies\n\
         # their names, never their values: copy this file to .env and fill them in.\n",
    );
    for key in keys {
        out.push_str(&format!("{key}=\n"));
    }
    out
}

static XRPC_CALL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"xrpc\.(?:query|procedure)\(\s*["']([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)["']"#)
        .expect("regex")
});
static LINE_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*--").expect("regex"));
static BLOCK_COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"--\[\[[\s\S]*?\]\]").expect("regex"));

/// The XRPC methods a script calls, as HappyView derives them when nothing
/// overrides them (`lua_analysis::extract_outbound_xrpcs`, copied exactly),
/// so a list that only repeats it is left out of `happyview.toml`.
pub fn derived_outbound(source: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let stripped = BLOCK_COMMENT.replace_all(source, "");
    for line in stripped.lines() {
        if LINE_COMMENT.is_match(line) {
            continue;
        }
        for cap in XRPC_CALL.captures_iter(line) {
            let method = cap[1].to_string();
            if seen.insert(method.clone()) {
                out.push(method);
            }
        }
    }
    out
}

/// The first paragraph of the comment a file opens with, which HappyView
/// reads as its description (`project/describe.rs`, `leading_description`).
pub fn leading_description(source: &str) -> Option<String> {
    let mut text = source;
    if text.starts_with("#!") {
        text = text.split_once('\n').map_or("", |(_, rest)| rest);
    }
    let text = text.trim_start();
    let block_line = |l: &str| l.trim().trim_start_matches('*').trim().to_string();
    let lines: Vec<String> = if let Some(rest) = text.strip_prefix("--[") {
        let level = rest.len() - rest.trim_start_matches('=').len();
        match rest[level..].strip_prefix('[') {
            Some(rest) => {
                let close = format!("]{}]", "=".repeat(level));
                let body = rest
                    .split_once(close.as_str())
                    .map_or(rest, |(body, _)| body);
                body.lines().map(block_line).collect()
            }
            None => line_comments(text),
        }
    } else if let Some(rest) = text.strip_prefix("/*") {
        let body = rest.split_once("*/").map_or(rest, |(body, _)| body);
        body.lines().map(block_line).collect()
    } else {
        line_comments(text)
    };
    let paragraph: Vec<&str> = lines
        .iter()
        .map(|l| l.trim())
        .skip_while(|l| l.is_empty())
        .take_while(|l| !l.is_empty())
        .collect();
    (!paragraph.is_empty()).then(|| paragraph.join(" "))
}

fn line_comments(text: &str) -> Vec<String> {
    text.lines()
        .map_while(|line| {
            let line = line.trim_start();
            line.strip_prefix("--")
                .or_else(|| line.strip_prefix("//"))
                .map(|rest| rest.trim_start_matches(['-', '/', '!']).trim().to_string())
        })
        .collect()
}

/// `[scripts."<trigger>"]` with only what the body doesn't already say: a
/// description other than its leading comment's, and calls other than the
/// ones HappyView finds in it. `outbound` is `None` for a script the codemod
/// rewrote, whose v2 list was derived from a body that no longer exists.
pub fn script_settings(
    body: &str,
    description: Option<&str>,
    outbound: Option<&[String]>,
) -> ScriptSettings {
    let description = description
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .filter(|d| leading_description(body).as_deref() != Some(*d))
        .map(str::to_string);
    let outbound_xrpcs = outbound
        .filter(|o| !o.is_empty())
        .filter(|o| *o != derived_outbound(body).as_slice())
        .map(<[String]>::to_vec);
    ScriptSettings {
        description,
        outbound_xrpcs,
    }
}

static HAPPYVIEW_REQUIRE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"require\s*\(?\s*["'](happyview\.[A-Za-z0-9_.]+)["']"#).expect("regex")
});

/// The `happyview.*` libraries a script requires, which v3 provides as
/// library plugins under those namespaces.
pub fn happyview_requires(source: &str) -> BTreeSet<String> {
    HAPPYVIEW_REQUIRE
        .captures_iter(source)
        .map(|c| c[1].to_string())
        .collect()
}

/// A rewrite the codemod left a `-- codemod:` marker in, for a person to
/// finish.
pub fn has_codemod_marker(source: &str) -> bool {
    source
        .lines()
        .any(|l| l.trim_start().starts_with("-- codemod:"))
}

/// The directory `pull` creates when none is named: the instance's host.
pub fn default_dir(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .map(|h| h.trim_matches(['[', ']']).replace(':', "-"))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "happyview-project".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(id: &str, ext: &str) -> (Kind, String) {
        let t = parse_trigger(id).unwrap();
        (t.kind, handler_path(&t, ext).unwrap())
    }

    #[test]
    fn each_trigger_goes_where_layout_reads_it_back() {
        for (id, ext, kind, path) in [
            (
                "xrpc.query:com.example.listPosts",
                "lua",
                Kind::Query,
                "src/lexicons/com/example/listPosts.lua",
            ),
            (
                "xrpc.procedure:com.example.createPost",
                "ts",
                Kind::Procedure,
                "src/lexicons/com/example/createPost.ts",
            ),
            (
                "record.create:com.example.post",
                "lua",
                Kind::Record,
                "src/lexicons/com/example/post.create.lua",
            ),
            (
                "record.update:com.example.post",
                "lua",
                Kind::Record,
                "src/lexicons/com/example/post.update.lua",
            ),
            (
                "record.delete:com.example.post",
                "js",
                Kind::Record,
                "src/lexicons/com/example/post.delete.js",
            ),
            (
                "record.index:com.example.post",
                "lua",
                Kind::Record,
                "src/lexicons/com/example/post.index.lua",
            ),
            ("job.run:nightly", "lua", Kind::Job, "src/jobs/nightly.lua"),
            (
                "job.run:reindex.posts",
                "lua",
                Kind::Job,
                "src/jobs/reindex.posts.lua",
            ),
            (
                "labeler.apply:com.example.post",
                "lua",
                Kind::Label,
                "src/labels/com.example.post.lua",
            ),
            (
                "labeler.apply:_actor",
                "lua",
                Kind::Label,
                "src/labels/_actor.lua",
            ),
        ] {
            assert_eq!(place(id, ext), (kind, path.to_string()), "{id}");
        }
    }

    #[test]
    fn the_codemod_kinds_are_its_own_names() {
        let kinds: Vec<&str> = [
            "xrpc.query:a.b.c",
            "xrpc.procedure:a.b.c",
            "record.create:a.b.c",
            "job.run:x",
            "labeler.apply:_actor",
        ]
        .iter()
        .map(|id| parse_trigger(id).unwrap().kind.as_str())
        .collect();
        assert_eq!(kinds, ["query", "procedure", "record", "job", "label"]);
    }

    #[test]
    fn a_trigger_that_could_climb_out_has_no_path() {
        for id in [
            "xrpc.query:com..evil",
            "xrpc.query:com.example/../../x",
            "job.run:../../etc/passwd",
            "labeler.apply:.hidden",
            "record.create:com.example",
        ] {
            let t = parse_trigger(id).unwrap();
            assert!(handler_path(&t, "lua").is_err(), "{id}");
        }
        assert_eq!(parse_trigger("hook.before:x"), None);
        assert_eq!(parse_trigger("nocolon"), None);
        assert_eq!(
            safe_src_path("src/lexicons/a/b.lua").as_deref(),
            Some("src/lexicons/a/b.lua")
        );
        assert_eq!(safe_src_path("../src/x.lua"), None);
        assert_eq!(safe_src_path("src/../x.lua"), None);
        assert_eq!(safe_src_path("/src/x.lua"), None);
    }

    #[test]
    fn the_extension_is_the_interpreters_else_the_usual_one() {
        let claimed = BTreeMap::from([("typescript".to_string(), "mts".to_string())]);
        assert_eq!(extension("typescript", &claimed), ("mts".into(), true));
        assert_eq!(extension("lua", &claimed), ("lua".into(), true));
        assert_eq!(
            extension("javascript", &BTreeMap::new()),
            ("js".into(), true)
        );
        assert_eq!(
            extension("python", &BTreeMap::new()),
            ("python".into(), false)
        );
    }

    #[test]
    fn lexicon_defaults_are_left_out() {
        let record = Some("record");
        assert!(lexicon_settings(record, false, None, Some(true)).is_empty());
        assert!(lexicon_settings(record, false, None, None).is_empty());
        let s = lexicon_settings(record, true, Some(2), Some(false));
        assert_eq!(s.backfill, Some(true));
        assert_eq!(s.token_cost, Some(2));
        assert_eq!(s.indexed, Some(false));
        // A query has no collection to backfill or index; a cost it keeps.
        let q = lexicon_settings(Some("query"), true, Some(1), Some(false));
        assert_eq!((q.backfill, q.token_cost, q.indexed), (None, Some(1), None));
        assert_eq!(
            lexicon_settings(None, true, None, None).backfill,
            Some(true)
        );
    }

    #[test]
    fn the_env_example_names_keys_without_values() {
        let text = env_example(&["API_TOKEN".into(), "WEBHOOK".into()]);
        assert!(text.ends_with("API_TOKEN=\nWEBHOOK=\n"), "{text}");
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            assert!(line.ends_with('='), "{line}");
        }
    }

    #[test]
    fn only_what_the_body_does_not_say_is_kept() {
        let body = "-- Lists posts.\n-- Newest first.\n\nlocal x = xrpc.query(\"com.other.get\")\n-- xrpc.query(\"com.commented.out\")\n";
        assert_eq!(
            leading_description(body).as_deref(),
            Some("Lists posts. Newest first.")
        );
        assert_eq!(derived_outbound(body), ["com.other.get"]);
        let same = script_settings(
            body,
            Some("Lists posts. Newest first."),
            Some(&["com.other.get".to_string()]),
        );
        assert_eq!(same, ScriptSettings::default());
        let other = script_settings(body, Some("Something else"), Some(&["com.x.y".to_string()]));
        assert_eq!(other.description.as_deref(), Some("Something else"));
        assert_eq!(other.outbound_xrpcs.unwrap(), ["com.x.y"]);
        assert_eq!(
            script_settings(body, Some("Something else"), None).outbound_xrpcs,
            None
        );
        assert_eq!(
            leading_description("--[[\n  Block one.\n]]\nreturn 1").as_deref(),
            Some("Block one.")
        );
        assert_eq!(
            leading_description("/**\n * Says hi.\n */\nexport function handle() {}").as_deref(),
            Some("Says hi.")
        );
        assert_eq!(leading_description("local x = 1"), None);
    }

    #[test]
    fn happyview_requires_are_found_in_any_quoting() {
        let found = happyview_requires(
            "local db = require(\"happyview.db\")\nlocal r = require 'happyview.record'\nlocal l = require(\"internal.logging\")",
        );
        assert_eq!(
            found.into_iter().collect::<Vec<_>>(),
            ["happyview.db", "happyview.record"]
        );
    }

    #[test]
    fn markers_are_codemod_comment_lines() {
        assert!(has_codemod_marker(
            "x\n  -- codemod: db.query has options\n"
        ));
        assert!(!has_codemod_marker("-- not a codemod: line\n"));
    }

    #[test]
    fn the_default_directory_is_the_host() {
        assert_eq!(default_dir("https://api.example.com"), "api.example.com");
        assert_eq!(default_dir("http://127.0.0.1:8080"), "127.0.0.1");
    }
}
