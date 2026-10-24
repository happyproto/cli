use std::collections::BTreeMap;

use hpy_atproto::Registry;
use hpy_project::config::{HappyviewTable, PluginKind, ProjectToml};
use hpy_project::lock::LOCK_FILE;
use hpy_project::manifest::parse_package_uri;
use hpy_project::scaffold::{Scaffold, render, starter_handler, write_new};
use serde_json::json;

use crate::cli::CreateArgs;
use crate::commands::happyview::add::newest;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::binary::{HOST_TARGET, ReleaseSource, http_client, latest_version};
use crate::project::prepare::{PACKAGE_FLAG, choose_with_prompter};
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

/// Which chosen key each `--package` answers. One that answers none, or a
/// key two of them answer, is refused rather than guessed at.
fn match_packages(
    packages: &[String],
    chosen: &[(PluginKind, &[String], &[Candidate])],
) -> Result<BTreeMap<(PluginKind, String), String>, Failure> {
    let mut pins = BTreeMap::new();
    for uri in packages {
        let mut answered = false;
        for (kind, keys, found) in chosen {
            for key in keys.iter() {
                if !found
                    .iter()
                    .any(|c| &c.package == uri && c.answers(*kind, key))
                {
                    continue;
                }
                answered = true;
                if let Some(other) = pins.insert((*kind, key.clone()), uri.clone()) {
                    return Err(Failure::usage(format!(
                        "--package: {other} and {uri} both answer to `{key}`; pass one"
                    )));
                }
            }
        }
        if !answered {
            return Err(Failure::usage(format!(
                "--package: {uri} answers to none of the chosen interpreters or libraries"
            )));
        }
    }
    Ok(pins)
}

/// The libraries to add: `--library` values, each a namespace or a package
/// id as `add` takes them, else a choice among the namespaces found.
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

/// The package each key means and its newest release, as `add` would write
/// it: the newest stable, else the newest prerelease.
async fn pick(
    reg: &dyn Registry,
    kind: PluginKind,
    keys: &[String],
    found: &[Candidate],
    pins: &mut BTreeMap<(PluginKind, String), String>,
    choose: Choose<'_>,
) -> Result<BTreeMap<String, String>, Failure> {
    let mut out = BTreeMap::new();
    for key in keys {
        let package = match pins.get(&(kind, key.clone())) {
            Some(uri) => uri.clone(),
            None => {
                let matches: Vec<Candidate> = found
                    .iter()
                    .filter(|c| c.answers(kind, key))
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
                chosen.package.clone()
            }
        };
        let (did, slug) = parse_package_uri(&package)
            .ok_or_else(|| Failure::usage(format!("`{package}` is not a registry package URI")))?;
        let version = newest(&reg.list_releases(&did, &slug).await?)
            .ok_or_else(|| Failure::usage(format!("{slug} has no active release")))?;
        // Resolution then takes this package rather than searching again.
        pins.insert((kind, key.clone()), package);
        out.insert(key.clone(), version.to_string());
    }
    Ok(out)
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
        .packages
        .iter()
        .find(|u| parse_package_uri(u).is_none())
    {
        return Err(Failure::usage(format!(
            "--package: `{uri}` is not an at://<did>/at.happyproto.plugin.profile/<slug> URI"
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
    let mut pins = match_packages(
        &args.packages,
        &[
            (PluginKind::Interpreter, &interpreters, &interpreters_found),
            (PluginKind::Library, &libraries, &libraries_found),
        ],
    )?;
    let choose = choose_with_prompter(ctx, PACKAGE_FLAG);
    let interpreter_versions = pick(
        &registry,
        PluginKind::Interpreter,
        &interpreters,
        &interpreters_found,
        &mut pins,
        &choose,
    )
    .await?;
    let library_versions = pick(
        &registry,
        PluginKind::Library,
        &libraries,
        &libraries_found,
        &mut pins,
        &choose,
    )
    .await?;
    let wanted = ProjectToml {
        happyview: HappyviewTable {
            version: Some(version.clone()),
        },
        interpreters: interpreter_versions.clone(),
        libraries: library_versions.clone(),
        dev: Default::default(),
    };
    let warn = |m: &str| ctx.out.status(&format!("warning: {m}"));
    let r = Resolver {
        registry: &registry,
        choose: &choose,
        warn: &warn,
        pins,
    };
    let lock = resolve_lock(&r, &wanted, None).await?;
    let handler_language = interpreters.first().cloned();
    let scaffold = Scaffold {
        app_name,
        superadmin,
        happyview_version: version.clone(),
        interpreters: interpreter_versions.clone(),
        libraries: library_versions.clone(),
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
    for (key, v) in interpreter_versions.iter().chain(&library_versions) {
        if semver::Version::parse(v).is_ok_and(|v| !v.pre.is_empty()) {
            human.push_str(&format!(
                "\n  `{key}` has only prereleases, so happyview.toml accepts them from {v}"
            ));
        }
    }
    human.push_str("\n\n");
    if args.name != std::path::Path::new(".") {
        human.push_str(&format!("  cd {}\n", args.name.display()));
    }
    human.push_str("  hpy happyview dev");
    ctx.out.done(
        &human,
        json!({
            "dir": dir,
            "happyview": version,
            "plugins": lock.plugins.iter().map(|p| json!({ "id": p.id, "version": p.version })).collect::<Vec<_>>(),
        }),
    );
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

    fn candidate(package: &str, language: &str) -> Candidate {
        let (did, slug) = parse_package_uri(package).unwrap();
        Candidate {
            package: package.into(),
            did,
            slug: slug.clone(),
            handle: None,
            name: slug,
            version: "1.0.0".into(),
            language_id: Some(language.into()),
            namespace: None,
        }
    }

    #[test]
    fn a_package_is_pinned_to_the_key_it_answers() {
        let one = "at://did:plc:a/at.happyproto.plugin.profile/lua-one";
        let two = "at://did:plc:b/at.happyproto.plugin.profile/lua-two";
        let found = [candidate(one, "lua"), candidate(two, "lua")];
        let keys = ["lua".to_string()];
        let chosen = [(PluginKind::Interpreter, &keys[..], &found[..])];
        let pins = match_packages(&[two.into()], &chosen).unwrap();
        assert_eq!(
            pins.get(&(PluginKind::Interpreter, "lua".into()))
                .map(String::as_str),
            Some(two)
        );
        let both = match_packages(&[one.into(), two.into()], &chosen).unwrap_err();
        assert!(both.report.to_string().contains("both answer to `lua`"));
        let none = match_packages(
            &["at://did:plc:c/at.happyproto.plugin.profile/js".into()],
            &chosen,
        )
        .unwrap_err();
        assert_eq!(none.code, 2);
        assert!(none.report.to_string().contains("answers to none"));
    }
}
