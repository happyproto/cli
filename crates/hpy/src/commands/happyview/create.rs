use std::collections::BTreeMap;

use hpy_plugin::validate::parse_project_uri;
use hpy_project::config::{HappyviewTable, Pin, PluginEntry, PluginKind, ProjectToml};
use hpy_project::lock::{LOCK_FILE, Lockfile};
use hpy_project::scaffold::{Scaffold, render, starter_handler, write_new};
use serde_json::{Value, json};

use crate::cli::CreateArgs;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::binary::{HOST_TARGET, ReleaseSource, http_client, latest_version};
use crate::project::prepare::choose_with_prompter;
use crate::project::resolve::{Candidate, Choose, Resolver, candidates, resolve_lock};

/// atproto's DID syntax, which HappyView checks `superadmin` against at boot.
fn check_did(s: &str) -> Result<(), String> {
    let bad = || Err(format!("`{s}` is not a DID"));
    if s.len() > 2048 {
        return bad();
    }
    let Some((method, id)) = s.strip_prefix("did:").and_then(|r| r.split_once(':')) else {
        return bad();
    };
    let method_ok = !method.is_empty() && method.bytes().all(|b| b.is_ascii_lowercase());
    let id_ok = id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b".-_:%".contains(&b))
        && id.bytes().last().is_some_and(|b| b != b':' && b != b'%');
    if method_ok && id_ok { Ok(()) } else { bad() }
}

fn check_name(s: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        Err("must not be empty".into())
    } else {
        Ok(())
    }
}

fn check_version(s: &str) -> Result<(), String> {
    semver::Version::parse(s)
        .map(|_| ())
        .map_err(|e| format!("`{s}` is not a version: {e}"))
}

/// Lua first, since it is preselected and its handler is the starter's,
/// then the rest in name order.
pub fn order_languages(found: &[String]) -> Vec<String> {
    let mut rest: Vec<String> = found.iter().filter(|l| *l != "lua").cloned().collect();
    rest.sort();
    rest.dedup();
    let mut out: Vec<String> = found
        .iter()
        .filter(|l| *l == "lua")
        .take(1)
        .cloned()
        .collect();
    out.extend(rest);
    out
}

/// Which chosen key each `--project` answers. One that answers none, or a
/// key two of them answer, is refused rather than guessed at.
fn match_projects(
    projects: &[String],
    chosen: &[(PluginKind, &[String], &[Candidate])],
) -> Result<BTreeMap<(PluginKind, String), String>, Failure> {
    let mut pins = BTreeMap::new();
    for uri in projects {
        let mut answered = false;
        for (kind, keys, found) in chosen {
            for key in keys.iter() {
                if !found
                    .iter()
                    .any(|c| &c.project == uri && c.answers(*kind, key))
                {
                    continue;
                }
                answered = true;
                if let Some(other) = pins.insert((*kind, key.clone()), uri.clone()) {
                    return Err(Failure::usage(format!(
                        "--project: {other} and {uri} both answer to `{key}`; pass one"
                    )));
                }
            }
        }
        if !answered {
            return Err(Failure::usage(format!(
                "--project: {uri} answers to none of the chosen interpreters or libraries"
            )));
        }
    }
    Ok(pins)
}

/// The libraries to add: `--library` values, each a namespace or a project
/// name as `add` takes them, else a choice among the namespaces found.
fn choose_libraries(
    ctx: &Ctx,
    given: Vec<String>,
    found: &[Candidate],
) -> Result<Vec<String>, Failure> {
    let mut keys: Vec<String> = found.iter().map(|c| c.key(PluginKind::Library)).collect();
    keys.sort();
    keys.dedup();
    if given.is_empty() {
        return ctx
            .prompter
            .multi("--library", "Libraries:", given, &keys, &[]);
    }
    // With nothing found, resolution names the one nobody answers to.
    if !found.is_empty()
        && let Some(bad) = given
            .iter()
            .find(|v| !found.iter().any(|c| c.answers(PluginKind::Library, v)))
    {
        return Err(Failure::usage(format!(
            "--library: `{bad}` is not one of {}",
            keys.join(", ")
        )));
    }
    Ok(given)
}

/// The entry each key gets: the project that answers to it, following its
/// channel as `add` would.
fn pick(
    kind: PluginKind,
    keys: &[String],
    found: &[Candidate],
    pins: &BTreeMap<(PluginKind, String), String>,
    choose: Choose<'_>,
) -> Result<BTreeMap<String, PluginEntry>, Failure> {
    let mut out = BTreeMap::new();
    for key in keys {
        let matches: Vec<Candidate> = found
            .iter()
            .filter(|c| c.answers(kind, key))
            .filter(|c| {
                pins.get(&(kind, key.clone()))
                    .is_none_or(|uri| &c.project == uri)
            })
            .cloned()
            .collect();
        let chosen = match matches.len() {
            0 => {
                return Err(Failure::usage(format!(
                    "no {} in the registry answers to `{key}`",
                    kind.plugin_type()
                )));
            }
            1 => &matches[0],
            _ => &matches[choose(key, &matches)?],
        };
        out.insert(
            key.clone(),
            PluginEntry {
                did: chosen.did.clone(),
                name: chosen.name.clone(),
                pin: Pin::Channel(chosen.channel.clone()),
            },
        );
    }
    Ok(out)
}

/// The `--json` answer.
pub fn report(dir: &std::path::Path, version: &str, toml: &ProjectToml, lock: &Lockfile) -> Value {
    let entries = |table: &BTreeMap<String, PluginEntry>| -> Value {
        table
            .iter()
            .map(|(key, e)| {
                let pin = match &e.pin {
                    Pin::Channel(c) => json!({ "channel": c }),
                    Pin::Version(v) => json!({ "version": v }),
                };
                let mut entry = json!({ "project": e.project_uri() });
                entry
                    .as_object_mut()
                    .expect("an object")
                    .extend(pin.as_object().expect("an object").clone());
                (key.clone(), entry)
            })
            .collect::<serde_json::Map<_, _>>()
            .into()
    };
    json!({
        "dir": dir,
        "happyview": version,
        "interpreters": entries(&toml.interpreters),
        "libraries": entries(&toml.libraries),
        "plugins": lock.plugins.iter().map(|p| json!({ "id": p.id, "version": p.version })).collect::<Vec<_>>(),
    })
}

pub async fn run(ctx: &Ctx, args: CreateArgs) -> Result<(), Failure> {
    let dir = ctx.dir.join(&args.name);
    if std::fs::metadata(&dir).is_ok_and(|m| !m.is_dir()) {
        return Err(Failure::usage(format!(
            "{} already exists and is not a directory",
            dir.display()
        )));
    }
    if std::fs::read_dir(&dir).is_ok_and(|mut d| d.next().is_some()) {
        return Err(Failure::usage(format!(
            "{} already exists and is not empty",
            dir.display()
        )));
    }
    if let Some(uri) = args
        .projects
        .iter()
        .find(|u| parse_project_uri(u).is_none())
    {
        return Err(Failure::usage(format!(
            "--project: `{uri}` is not an at://<did>/software.release.project/<name> URI"
        )));
    }
    let signed_in = hpy_atproto::session::current(&ctx.settings, ctx.keystore())
        .ok()
        .flatten()
        .map(|s| s.credential.did);
    let superadmin = ctx.prompter.required(
        "--superadmin",
        "Superadmin DID:",
        args.superadmin,
        signed_in,
        check_did,
    )?;
    let registry = ctx.registry();
    let interpreters_found = candidates(&registry, PluginKind::Interpreter).await?;
    let languages = order_languages(
        &interpreters_found
            .iter()
            .map(|c| c.key(PluginKind::Interpreter))
            .collect::<Vec<_>>(),
    );
    let interpreters = ctx.prompter.multi(
        "--interpreter",
        "Interpreters:",
        args.interpreters,
        &languages,
        &["lua".into()],
    )?;
    if interpreters.is_empty() {
        return Err(Failure::usage(
            "choose at least one interpreter: without one, no script can run",
        ));
    }
    let libraries_found = candidates(&registry, PluginKind::Library).await?;
    let libraries = choose_libraries(ctx, args.libraries, &libraries_found)?;
    // `--name .` names the directory it is run in.
    let default_name = std::fs::canonicalize(&dir)
        .unwrap_or_else(|_| dir.clone())
        .file_name()
        .map(|n| n.to_string_lossy().into_owned());
    let app_name = ctx.prompter.required(
        "--app-name",
        "App name:",
        args.app_name,
        default_name,
        check_name,
    )?;
    let version = match args.happyview_version {
        Some(v) => {
            check_version(&v).map_err(|e| Failure::usage(format!("--happyview-version: {e}")))?;
            v
        }
        None => {
            let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
            latest_version(&http_client(), &ReleaseSource::from_env(&env), HOST_TARGET).await?
        }
    };

    // Resolve before writing, so a refusal leaves no half-made project behind.
    let pins = match_projects(
        &args.projects,
        &[
            (PluginKind::Interpreter, &interpreters, &interpreters_found),
            (PluginKind::Library, &libraries, &libraries_found),
        ],
    )?;
    let choose = choose_with_prompter(ctx);
    let interpreter_entries = pick(
        PluginKind::Interpreter,
        &interpreters,
        &interpreters_found,
        &pins,
        &choose,
    )?;
    let library_entries = pick(
        PluginKind::Library,
        &libraries,
        &libraries_found,
        &pins,
        &choose,
    )?;
    let wanted = ProjectToml {
        happyview: HappyviewTable {
            version: Some(version.clone()),
        },
        interpreters: interpreter_entries.clone(),
        libraries: library_entries.clone(),
        dev: Default::default(),
    };
    let warn = |m: &str| ctx.out.status(&format!("warning: {m}"));
    let r = Resolver {
        registry: &registry,
        warn: &warn,
    };
    let lock = resolve_lock(&r, &wanted, None).await?;
    let handler_language = interpreters.first().cloned();
    let scaffold = Scaffold {
        app_name,
        superadmin,
        happyview_version: version.clone(),
        interpreters: interpreter_entries.clone(),
        libraries: library_entries.clone(),
        handler_language: handler_language.clone(),
    };
    let mut files = render(&scaffold);
    files.push((LOCK_FILE.into(), lock.render()));
    files.extend(crate::project::editor::editor_files(&interpreters));
    // The directory was checked as absent or empty above, so a failure here
    // is the disk's rather than the user's.
    write_new(&dir, &files).map_err(Failure::runtime)?;
    if let Some(lang) = &handler_language
        && starter_handler(lang).is_none()
    {
        ctx.out.status(&format!(
            "hpy has no starter handler for `{lang}`; add one beside src/lexicons/com/example/hello.json"
        ));
    }
    let mut human = format!("created {}", dir.display());
    for (key, e) in interpreter_entries.iter().chain(&library_entries) {
        if let Pin::Channel(c) = &e.pin
            && c != "latest"
        {
            human.push_str(&format!(
                "\n  `{key}` has no latest channel, so happyview.toml follows its {c} channel"
            ));
        }
    }
    human.push_str("\n\n");
    if args.name != std::path::Path::new(".") {
        human.push_str(&format!("  cd {}\n", args.name.display()));
    }
    human.push_str("  hpy happyview dev");
    ctx.out.done(&human, report(&dir, &version, &wanted, &lock));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dids_follow_the_atproto_grammar() {
        for ok in [
            "did:plc:z72i7hdynmk6r22z27h6tvur",
            "did:web:example.com",
            "did:web:localhost%3A8080",
            "did:example:a:b_c-d.e",
        ] {
            assert_eq!(check_did(ok), Ok(()), "{ok}");
        }
        for bad in [
            "did:PLC:x",
            "did:plc:",
            "did::x",
            "did:plc:x:",
            "did:plc:x%",
            "did:plc:x y",
            "plc:x",
            "did:plc",
        ] {
            assert!(check_did(bad).is_err(), "{bad}");
        }
        assert!(check_did(&format!("did:plc:{}", "a".repeat(2048))).is_err());
    }

    #[test]
    fn lua_comes_first_then_name_order() {
        let found: Vec<String> = ["typescript", "lua", "javascript", "typescript", "lua"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(order_languages(&found), ["lua", "javascript", "typescript"]);
        assert_eq!(order_languages(&["js".into()]), ["js"]);
    }

    fn candidate(project: &str, language: &str) -> Candidate {
        let (did, name) = parse_project_uri(project).unwrap();
        Candidate {
            project: project.into(),
            did,
            name: name.clone(),
            handle: None,
            display_name: name,
            channel: "latest".into(),
            version: "1.0.0".into(),
            language_id: Some(language.into()),
            namespace: None,
        }
    }

    const ONE: &str = "at://did:plc:a/software.release.project/lua-one";
    const TWO: &str = "at://did:plc:b/software.release.project/lua-two";

    #[test]
    fn a_project_is_pinned_to_the_key_it_answers() {
        let found = [candidate(ONE, "lua"), candidate(TWO, "lua")];
        let keys = ["lua".to_string()];
        let chosen = [(PluginKind::Interpreter, &keys[..], &found[..])];
        let pins = match_projects(&[TWO.into()], &chosen).unwrap();
        assert_eq!(
            pins.get(&(PluginKind::Interpreter, "lua".into()))
                .map(String::as_str),
            Some(TWO)
        );
        let both = match_projects(&[ONE.into(), TWO.into()], &chosen).unwrap_err();
        assert!(both.report.to_string().contains("both answer to `lua`"));
        let none = match_projects(
            &["at://did:plc:c/software.release.project/js".into()],
            &chosen,
        )
        .unwrap_err();
        assert_eq!(none.code, 2);
        assert!(none.report.to_string().contains("answers to none"));
    }

    fn never(_: &str, _: &[Candidate]) -> Result<usize, Failure> {
        panic!("nothing should be ambiguous here")
    }

    #[test]
    fn each_key_follows_its_projects_channel_and_a_pin_settles_several() {
        let mut alpha = candidate(TWO, "lua");
        alpha.channel = "alpha".into();
        let found = [candidate(ONE, "lua"), alpha];
        let keys = ["lua".to_string()];
        let pins = BTreeMap::from([(
            (PluginKind::Interpreter, "lua".to_string()),
            TWO.to_string(),
        )]);
        let entries = pick(PluginKind::Interpreter, &keys, &found, &pins, &never).unwrap();
        assert_eq!(
            entries["lua"],
            PluginEntry {
                did: "did:plc:b".into(),
                name: "lua-two".into(),
                pin: Pin::Channel("alpha".into()),
            }
        );
        let choose_first = |_: &str, _: &[Candidate]| -> Result<usize, Failure> { Ok(0) };
        let entries = pick(
            PluginKind::Interpreter,
            &keys,
            &found,
            &BTreeMap::new(),
            &choose_first,
        )
        .unwrap();
        assert_eq!(entries["lua"].name, "lua-one");
        let err = pick(
            PluginKind::Interpreter,
            &["python".to_string()],
            &found,
            &BTreeMap::new(),
            &never,
        )
        .unwrap_err();
        assert!(err.report.to_string().contains("answers to `python`"));
    }

    #[test]
    fn the_json_names_each_entry_and_what_was_locked() {
        let toml = ProjectToml {
            happyview: HappyviewTable {
                version: Some("3.0.0".into()),
            },
            interpreters: BTreeMap::from([(
                "lua".to_string(),
                PluginEntry {
                    did: "did:plc:a".into(),
                    name: "lua-one".into(),
                    pin: Pin::Channel("latest".into()),
                },
            )]),
            libraries: BTreeMap::new(),
            dev: Default::default(),
        };
        let lock = Lockfile {
            version: hpy_project::lock::LOCK_VERSION,
            happyview: hpy_project::lock::LockedHappyview {
                version: "3.0.0".into(),
            },
            plugins: vec![],
        };
        assert_eq!(
            report(std::path::Path::new("app"), "3.0.0", &toml, &lock),
            json!({
                "dir": "app", "happyview": "3.0.0",
                "interpreters": { "lua": { "project": ONE, "channel": "latest" } },
                "libraries": {},
                "plugins": []
            })
        );
    }
}
