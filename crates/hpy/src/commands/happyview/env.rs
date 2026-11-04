//! `hpy hv env push`: the project's `.env` to the deployed instance's script
//! variables, one key at a time.
//!
//! A value is a secret. It is read from the file and goes out in the body of
//! the request that sets it, and nowhere else: not in a prompt, a line of
//! output, `--json` or an error. Keys are only ever read from the file, never
//! from the process environment.

mod dotenv;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use hpy_atproto::admin::Admin;
use serde_json::json;

use crate::cli::{EnvCommand, EnvPushArgs};
use crate::commands::happyview::instance;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::prepare::project_root;

use dotenv::Entry;

pub async fn run(ctx: &Ctx, command: EnvCommand) -> Result<(), Failure> {
    match command {
        EnvCommand::Push(a) => push(ctx, a).await,
    }
}

/// What the instance has under a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Existing {
    New,
    Replaces { unreadable: bool },
}

impl Existing {
    fn label(self) -> &'static str {
        match self {
            Existing::New => "new",
            Existing::Replaces { .. } => "replaces existing",
        }
    }

    fn json(self) -> &'static str {
        match self {
            Existing::New => "new",
            Existing::Replaces { .. } => "replace",
        }
    }
}

/// A key to send, and what it would do on the instance.
struct Planned<'a> {
    entry: &'a Entry,
    existing: Existing,
}

/// The question asked before a key is sent; the prompt adds `(y/N)`.
fn question(p: &Planned) -> String {
    let key = &p.entry.key;
    match p.existing {
        Existing::Replaces { unreadable: true } => {
            format!("send {key} (replaces existing, whose value the instance can't read)?")
        }
        e => format!("send {key} ({})?", e.label()),
    }
}

/// `text` with `secret` taken out, for an instance's answer that quotes what
/// it was sent. A value too short to be a secret could match by chance, and
/// taking it out would only garble the message.
fn redact(text: &str, secret: &str) -> String {
    if secret.chars().count() < 4 {
        return text.to_string();
    }
    text.replace(secret, "[value hidden]")
}

/// Where the keys are read from: `--env-file`, else `.env` in the project.
fn env_file(ctx: &Ctx, given: Option<&Path>) -> Result<PathBuf, Failure> {
    match given {
        Some(p) => Ok(ctx.dir.join(p)),
        None => Ok(project_root(ctx)?.join(".env")),
    }
}

/// The file's entries, the last of each key winning as it does in HappyView.
fn read_entries(path: &Path) -> Result<Vec<Entry>, Failure> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Failure::usage(format!(
                "there is no {}; write the keys to send there, or name another file with --env-file",
                path.display()
            )));
        }
        Err(e) => {
            return Err(Failure::runtime(format!(
                "could not read {}: {e}",
                path.display()
            )));
        }
    };
    let entries = dotenv::parse(&text).map_err(|bad| {
        let lines: Vec<String> = bad
            .iter()
            .map(|b| format!("  {}:{}: {}", path.display(), b.line, b.why))
            .collect();
        Failure::usage(format!(
            "{} has lines HappyView can't read, so nothing was sent:\n{}",
            path.display(),
            lines.join("\n")
        ))
    })?;
    let mut last: BTreeMap<String, usize> = BTreeMap::new();
    for (i, e) in entries.iter().enumerate() {
        last.insert(e.key.clone(), i);
    }
    Ok(entries
        .into_iter()
        .enumerate()
        .filter(|(i, e)| last[&e.key] == *i)
        .map(|(_, e)| e)
        .collect())
}

/// The entries to send: every one, or the ones `named`, in the order named.
fn select(entries: &[Entry], named: &[String], path: &Path) -> Result<Vec<usize>, Failure> {
    if named.is_empty() {
        return Ok((0..entries.len()).collect());
    }
    let mut chosen = Vec::new();
    let mut missing = Vec::new();
    for key in named {
        if !dotenv::valid_key(key) {
            return Err(Failure::usage(format!(
                "`{key}` is not a key: {}",
                dotenv::KEY_RULE
            )));
        }
        match entries.iter().position(|e| &e.key == key) {
            Some(i) if !chosen.contains(&i) => chosen.push(i),
            Some(_) => {}
            None => missing.push(key.as_str()),
        }
    }
    if !missing.is_empty() {
        return Err(Failure::usage(format!(
            "{} doesn't set {}, so nothing was sent",
            path.display(),
            missing.join(", ")
        )));
    }
    Ok(chosen)
}

/// What became of each key.
#[derive(Debug, Default, PartialEq)]
struct Outcome {
    sent: Vec<String>,
    skipped: Vec<String>,
    /// Each with the instance's answer, values taken out.
    failed: Vec<(String, String)>,
}

/// Asks `decide` about each key in turn and sends the ones it accepts,
/// reporting a line for each through `say`. A failed send is recorded and the
/// rest go on.
async fn send_each(
    admin: &Admin,
    plan: &[Planned<'_>],
    mut decide: impl FnMut(&Planned) -> Result<bool, Failure>,
    say: impl Fn(&str),
) -> Result<Outcome, Failure> {
    let mut out = Outcome::default();
    for p in plan {
        let key = &p.entry.key;
        if !decide(p)? {
            say(&format!("skipped {key}"));
            out.skipped.push(key.clone());
            continue;
        }
        match admin.set_script_variable(key, &p.entry.value).await {
            Ok(()) => {
                say(&format!("sent {key}"));
                out.sent.push(key.clone());
            }
            Err(e) => {
                let why = redact(&e.to_string(), &p.entry.value);
                say(&format!("failed {key}: {why}"));
                out.failed.push((key.clone(), why));
            }
        }
    }
    Ok(out)
}

fn count(n: usize) -> String {
    if n == 1 {
        "1 key".into()
    } else {
        format!("{n} keys")
    }
}

pub async fn push(ctx: &Ctx, args: EnvPushArgs) -> Result<(), Failure> {
    let path = env_file(ctx, args.env_file.as_deref())?;
    let entries = read_entries(&path)?;
    let chosen = select(&entries, &args.keys, &path)?;
    // Before anything is read from the instance, so a run that can't ask
    // touches nothing.
    if !args.dry_run && !args.yes && !ctx.prompter.is_interactive() {
        return Err(Failure::usage(
            "hpy asks before sending each key, and can't ask here (no terminal, or --no-input); \
             pass --yes to send them without asking. Nothing was sent",
        ));
    }
    let admin = instance::admin(ctx, &args.instance)?;
    let url = admin.base().to_string();
    let file = path.display().to_string();
    if chosen.is_empty() {
        ctx.out.done(
            &format!("{file} sets no keys; nothing to send"),
            json!({ "instance": url, "file": file, "dryRun": args.dry_run, "keys": [] }),
        );
        return Ok(());
    }

    let existing: BTreeMap<String, bool> = admin
        .script_variables()
        .await?
        .into_iter()
        .map(|v| (v.key, v.unreadable))
        .collect();
    let plan: Vec<Planned> = chosen
        .iter()
        .map(|&i| {
            let entry = &entries[i];
            let existing = match existing.get(&entry.key) {
                Some(&unreadable) => Existing::Replaces { unreadable },
                None => Existing::New,
            };
            Planned { entry, existing }
        })
        .collect();
    for p in &plan {
        if !p.entry.unset.is_empty() {
            let names: Vec<String> = p.entry.unset.iter().map(|n| format!("${n}")).collect();
            ctx.out.status(&format!(
                "warning: {file}:{}: {}'s value uses {}, which no line above it sets; hpy fills it with nothing and never reads your shell's",
                p.entry.line,
                p.entry.key,
                names.join(", ")
            ));
        }
    }

    if args.dry_run {
        ctx.out
            .status(&format!("Would send to {url}, from {file}:"));
        for p in &plan {
            ctx.out
                .status(&format!("  {} {}", p.existing.label(), p.entry.key));
        }
        ctx.out.status(
            "The instance shows values masked, so whether a value would change can't be known: \
             \"replaces existing\" may resend the value it already has.",
        );
        let keys: Vec<_> = plan
            .iter()
            .map(|p| json!({ "key": p.entry.key, "status": p.existing.json() }))
            .collect();
        ctx.out.done(
            "Dry run: nothing was sent.",
            json!({ "instance": url, "file": file, "dryRun": true, "keys": keys }),
        );
        return Ok(());
    }

    ctx.out.status(&format!("Sending to {url}, from {file}"));
    let yes = args.yes;
    let outcome = send_each(
        &admin,
        &plan,
        |p| ctx.prompter.confirm(&question(p), yes),
        |line| ctx.out.status(line),
    )
    .await?;

    let summary = format!(
        "Sent {} to {url}; skipped {}, failed {}",
        count(outcome.sent.len()),
        outcome.skipped.len(),
        outcome.failed.len()
    );
    let failed: Vec<_> = outcome
        .failed
        .iter()
        .map(|(key, error)| json!({ "key": key, "error": error }))
        .collect();
    ctx.out.done(
        &summary,
        json!({
            "instance": url,
            "file": file,
            "dryRun": false,
            "sent": outcome.sent,
            "skipped": outcome.skipped,
            "failed": failed,
        }),
    );
    if !outcome.failed.is_empty() {
        let keys: Vec<&str> = outcome.failed.iter().map(|(k, _)| k.as_str()).collect();
        return Err(Failure::runtime(format!(
            "{} not sent: {}",
            count(keys.len()),
            keys.join(", ")
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SECRET: &str = "sk-live-unit-secret-91c2";

    fn entries(text: &str) -> Vec<Entry> {
        dotenv::parse(text).unwrap()
    }

    async fn posted_keys(server: &MockServer) -> Vec<String> {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method.as_str() == "POST")
            .map(|r| {
                let body: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
                body["key"].as_str().unwrap().to_string()
            })
            .collect()
    }

    /// The interactive path can't be driven from an integration test, since
    /// the prompt needs a terminal; this is its decision logic, with the
    /// answers scripted.
    #[tokio::test]
    async fn asks_about_each_key_and_sends_only_the_ones_accepted() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/admin/script-variables"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let admin = Admin::new(&server.uri(), "hv_0123456789abcdef0123456789abcdef");
        let es = entries(&format!("A={SECRET}\nB=2\nC=3\n"));
        let plan = vec![
            Planned {
                entry: &es[0],
                existing: Existing::New,
            },
            Planned {
                entry: &es[1],
                existing: Existing::Replaces { unreadable: false },
            },
            Planned {
                entry: &es[2],
                existing: Existing::Replaces { unreadable: true },
            },
        ];
        let asked = RefCell::new(Vec::new());
        let lines = RefCell::new(Vec::new());
        let outcome = send_each(
            &admin,
            &plan,
            |p| {
                asked.borrow_mut().push(question(p));
                Ok(p.entry.key != "B")
            },
            |l| lines.borrow_mut().push(l.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(
            asked.into_inner(),
            [
                "send A (new)?",
                "send B (replaces existing)?",
                "send C (replaces existing, whose value the instance can't read)?",
            ]
        );
        assert_eq!(lines.into_inner(), ["sent A", "skipped B", "sent C"]);
        assert_eq!(outcome.sent, ["A", "C"]);
        assert_eq!(outcome.skipped, ["B"]);
        assert_eq!(posted_keys(&server).await, ["A", "C"]);
    }

    /// Cancelling a question stops there: nothing after it is asked or sent.
    #[tokio::test]
    async fn a_cancelled_question_stops_the_run() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let admin = Admin::new(&server.uri(), "hv_0123456789abcdef0123456789abcdef");
        let es = entries("A=1\nB=2\n");
        let plan: Vec<Planned> = es
            .iter()
            .map(|entry| Planned {
                entry,
                existing: Existing::New,
            })
            .collect();
        let err = send_each(
            &admin,
            &plan,
            |_| Err(Failure::runtime("cancelled")),
            |_| {},
        )
        .await
        .err()
        .unwrap();
        assert_eq!(err.report.to_string(), "cancelled");
        assert!(posted_keys(&server).await.is_empty());
    }

    /// An instance that quotes the value back has it taken out.
    #[tokio::test]
    async fn a_failure_that_quotes_the_value_has_it_taken_out() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": "BadRequest", "message": format!("cannot store {SECRET}")
            })))
            .mount(&server)
            .await;
        let admin = Admin::new(&server.uri(), "hv_0123456789abcdef0123456789abcdef");
        let es = entries(&format!("A={SECRET}\n"));
        let plan = vec![Planned {
            entry: &es[0],
            existing: Existing::New,
        }];
        let lines = RefCell::new(Vec::new());
        let outcome = send_each(
            &admin,
            &plan,
            |_| Ok(true),
            |l| lines.borrow_mut().push(l.to_string()),
        )
        .await
        .unwrap();
        let shown = format!("{:?} {:?}", lines.into_inner(), outcome);
        assert!(shown.contains("failed A: "), "{shown}");
        assert!(shown.contains("[value hidden]"), "{shown}");
        assert!(!shown.contains(SECRET), "{shown}");
    }

    #[test]
    fn named_keys_must_be_in_the_file() {
        let es = entries("A=1\nB=2\nC=3\n");
        let p = Path::new(".env");
        assert_eq!(select(&es, &[], p).unwrap(), [0, 1, 2]);
        assert_eq!(
            select(&es, &["C".into(), "A".into(), "C".into()], p).unwrap(),
            [2, 0]
        );
        let err = select(&es, &["A".into(), "X".into(), "Y".into()], p).unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(
            err.report.to_string(),
            ".env doesn't set X, Y, so nothing was sent"
        );
        let err = select(&es, &["MY-KEY".into()], p).unwrap_err();
        assert!(err.report.to_string().contains(dotenv::KEY_RULE));
    }

    #[test]
    fn a_short_value_is_not_taken_out_of_a_message() {
        assert_eq!(redact("HTTP 500", "5"), "HTTP 500");
        assert_eq!(redact("got abcd!", "abcd"), "got [value hidden]!");
    }
}
