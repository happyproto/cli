//! `hpy happyview scaffold`: a starter handler beside each query or
//! procedure lexicon that has none, naming the collection it serves, since
//! HappyView no longer infers one.

use std::path::{Path, PathBuf};

use hpy_project::config::{CONFIG_FILE, ProjectToml};
use hpy_project::handlers::{
    Lexicon, LexiconKind, check_nsid, first_interpreter, handler_extension, render_handler, scan,
};
use serde_json::json;

use crate::cli::{AddArgs, ScaffoldArgs};
use crate::commands::happyview::add::{add_in, added_line};
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::cache;
use crate::project::prepare::{choose_with_prompter, project_root};

/// A project-relative path as messages and `--json` show it: with `/` on
/// every platform, as the lexicon paths in docs and NSIDs read.
fn shown(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// The command that writes a handler for `nsid`, for messages that point
/// at it.
pub fn hint(nsid: &str) -> String {
    format!("run `hpy hv scaffold {nsid}`")
}

/// The lexicons this run is about: every query and procedure, or the ones
/// named, each of which must be one.
fn targets<'a>(lexicons: &'a [Lexicon], nsids: &[String]) -> Result<Vec<&'a Lexicon>, Failure> {
    if nsids.is_empty() {
        return Ok(lexicons.iter().filter(|l| l.kind.is_method()).collect());
    }
    let mut out: Vec<&Lexicon> = Vec::new();
    for nsid in nsids {
        let Some(lexicon) = lexicons.iter().find(|l| &l.nsid == nsid) else {
            return Err(Failure::usage(format!(
                "`{nsid}` is not a lexicon under src/"
            )));
        };
        if !lexicon.kind.is_method() {
            return Err(Failure::usage(format!(
                "`{nsid}` is a {} lexicon ({}); only queries and procedures have handlers",
                lexicon.kind.label(),
                shown(&lexicon.path)
            )));
        }
        if !out.iter().any(|l| l.nsid == lexicon.nsid) {
            out.push(lexicon);
        }
    }
    Ok(out)
}

/// The collection a handler names: `--collection`'s, else one chosen among
/// the project's record lexicons or typed, else none.
fn collection_for(
    ctx: &Ctx,
    lexicon: &Lexicon,
    given: Option<&str>,
    records: &[String],
) -> Result<Option<String>, Failure> {
    if let Some(c) = given {
        return Ok(Some(c.to_string()));
    }
    if !ctx.prompter.is_interactive() {
        return Ok(None);
    }
    let label = format!(
        "Which collection does {} {}?",
        lexicon.nsid,
        lexicon.kind.verb().trim_end_matches('s')
    );
    let typed = |label: &str| {
        ctx.prompter
            .required("--collection", label, None, None, check_nsid)
            .map(Some)
    };
    if records.is_empty() {
        return typed(&label);
    }
    let mut options = records.to_vec();
    options.push("Another collection…".into());
    let i = ctx.prompter.choose("--collection", &label, &options)?;
    if i < records.len() {
        return Ok(Some(records[i].clone()));
    }
    typed("Collection NSID:")
}

/// Writes `body` at `path` only if nothing is there, so a handler made since
/// the scan is not replaced either.
fn write_new_file(path: &Path, body: &str) -> Result<bool, Failure> {
    use std::io::Write;
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => {
            return Err(Failure::runtime(format!("writing {}: {e}", path.display())));
        }
    };
    file.write_all(body.as_bytes())
        .map_err(|e| Failure::runtime(format!("writing {}: {e}", path.display())))?;
    Ok(true)
}

struct Written {
    nsid: String,
    path: PathBuf,
    kind: LexiconKind,
    collection: Option<String>,
}

pub async fn run(ctx: &Ctx, args: ScaffoldArgs) -> Result<(), Failure> {
    let root = project_root(ctx)?;
    if let Some(c) = &args.collection {
        check_nsid(c).map_err(|e| Failure::usage(format!("--collection: {e}")))?;
    }
    let text = std::fs::read_to_string(root.join(CONFIG_FILE)).map_err(Failure::runtime)?;
    let config = ProjectToml::parse(&text)?;
    let language = first_interpreter(&text).ok_or_else(|| {
        Failure::usage(format!(
            "{CONFIG_FILE} has no [interpreters], so there is no language to write a handler in; add one with `hpy hv add lua`"
        ))
    })?;
    let extension = handler_extension(&language).ok_or_else(|| {
        Failure::usage(format!(
            "hpy has no handler template for `{language}`, the first of [interpreters] in {CONFIG_FILE}"
        ))
    })?;
    let lexicons = scan(&root)?;
    let targets = targets(&lexicons, &args.nsids)?;
    let records: Vec<String> = lexicons
        .iter()
        .filter(|l| l.kind == LexiconKind::Record)
        .map(|l| l.nsid.clone())
        .collect();

    let mut written: Vec<Written> = Vec::new();
    let mut skipped: Vec<(String, PathBuf)> = Vec::new();
    for lexicon in targets {
        if let Some(existing) = lexicon.existing_handler(&root) {
            skipped.push((lexicon.nsid.clone(), existing));
            continue;
        }
        let collection = collection_for(ctx, lexicon, args.collection.as_deref(), &records)?;
        let body = render_handler(&language, lexicon, collection.as_deref())
            .expect("a template for every language with an extension");
        let path = lexicon.handler_path(extension);
        if !write_new_file(&root.join(&path), &body)? {
            skipped.push((lexicon.nsid.clone(), path));
            continue;
        }
        if collection.is_none() {
            ctx.out.status(&format!(
                "warning: {} names no collection yet; replace COLLECTION in it with the NSID it {}",
                shown(&path),
                lexicon.kind.verb()
            ));
        }
        written.push(Written {
            nsid: lexicon.nsid.clone(),
            path,
            kind: lexicon.kind,
            collection,
        });
    }

    // The libraries the written handlers call that the project lacks.
    let mut missing: Vec<String> = Vec::new();
    for w in &written {
        if let Some(lib) = w.kind.library()
            && !config.libraries.contains_key(lib)
            && !missing.iter().any(|m| m == lib)
        {
            missing.push(lib.to_string());
        }
    }
    let command = format!("hpy hv add {}", missing.join(" "));
    let mut added = Vec::new();
    let mut declined = false;
    if !missing.is_empty() {
        let question = format!(
            "The new handlers call {}, which {CONFIG_FILE} doesn't declare. Add {}?",
            missing.join(" and "),
            if missing.len() == 1 { "it" } else { "them" }
        );
        match ctx.prompter.offer(&question)? {
            Some(true) => {
                let add = AddArgs {
                    plugins: missing.clone(),
                    interpreter: false,
                    library: true,
                    channel: None,
                    version: None,
                    project: None,
                };
                let cache_root = cache::cache_root()?;
                let registry = ctx.registry();
                let choose = choose_with_prompter(ctx);
                let warn = |m: &str| ctx.out.status(&format!("warning: {m}"));
                let (additions, _) =
                    add_in(&root, &registry, &cache_root, &add, &choose, &warn).await?;
                added = additions;
                missing.clear();
            }
            Some(false) => declined = true,
            None => ctx.out.status(&format!(
                "warning: the new handlers call {}, which {CONFIG_FILE} doesn't declare; add {} with `{command}`",
                missing.join(" and "),
                if missing.len() == 1 { "it" } else { "them" }
            )),
        }
    }

    let mut lines: Vec<String> = Vec::new();
    for w in &written {
        let names = match &w.collection {
            Some(c) => format!("{} {c}", w.kind.verb()),
            None => "collection still to name".into(),
        };
        lines.push(format!("wrote {} ({names})", shown(&w.path)));
    }
    for (nsid, path) in &skipped {
        lines.push(format!("skipped {nsid}: {} is its handler", shown(path)));
    }
    for a in &added {
        lines.push(added_line(a, true));
    }
    // Without a terminal the warning above already gave the command.
    if declined {
        lines.push(format!("not added: {} (`{command}`)", missing.join(", ")));
    }
    if lines.is_empty() {
        lines.push("no query or procedure lexicons under src/".into());
    }
    let report = json!({
        "language": language,
        "written": written.iter().map(|w| json!({
            "nsid": w.nsid,
            "path": shown(&w.path),
            "collection": w.collection,
        })).collect::<Vec<_>>(),
        "skipped": skipped.iter().map(|(nsid, path)| json!({ "nsid": nsid, "handler": shown(path) })).collect::<Vec<_>>(),
        "added": added.iter().map(|a| a.to_json()).collect::<Vec<_>>(),
        "missing_libraries": missing,
    });
    ctx.out.done(&lines.join("\n"), report);
    Ok(())
}

/// One line per query or procedure lexicon under `root/src` with no handler
/// beside it, for `check` to warn with. A project it cannot read has none:
/// HappyView's own check reports what is wrong with it.
pub fn missing_handler_warnings(root: &Path) -> Vec<String> {
    let Ok(lexicons) = scan(root) else {
        return Vec::new();
    };
    lexicons
        .iter()
        .filter(|l| l.kind.is_method() && l.existing_handler(root).is_none())
        .map(|l| {
            let answer = match l.kind {
                LexiconKind::Query => "HappyView answers it only for ?uri=",
                _ => "HappyView refuses every call to it",
            };
            format!(
                "warning: {} {} has no handler beside {}, so {answer}; {}",
                l.kind.label(),
                l.nsid,
                shown(&l.path),
                hint(&l.nsid)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexicon(nsid: &str, kind: LexiconKind) -> Lexicon {
        Lexicon {
            nsid: nsid.into(),
            kind,
            path: format!("src/{nsid}.json").into(),
            has_params: false,
            has_input: false,
        }
    }

    #[test]
    fn named_lexicons_must_be_queries_or_procedures_here() {
        let all = [
            lexicon("com.example.list", LexiconKind::Query),
            lexicon("com.example.note", LexiconKind::Record),
            lexicon("com.example.save", LexiconKind::Procedure),
        ];
        let every: Vec<&str> = targets(&all, &[])
            .unwrap()
            .iter()
            .map(|l| l.nsid.as_str())
            .collect();
        assert_eq!(every, ["com.example.list", "com.example.save"]);
        let named = targets(
            &all,
            &["com.example.save".into(), "com.example.save".into()],
        )
        .unwrap();
        assert_eq!(named.len(), 1);
        let record = targets(&all, &["com.example.note".into()]).unwrap_err();
        assert_eq!(record.code, 2);
        assert!(
            record.report.to_string().contains("is a record lexicon"),
            "{:?}",
            record.report
        );
        let absent = targets(&all, &["com.example.gone".into()]).unwrap_err();
        assert!(
            absent
                .report
                .to_string()
                .contains("not a lexicon under src/"),
            "{:?}",
            absent.report
        );
    }

    #[test]
    fn a_file_made_since_the_scan_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.lua");
        assert!(write_new_file(&path, "new").unwrap());
        assert!(!write_new_file(&path, "newer").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }
}
