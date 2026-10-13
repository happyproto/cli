use std::collections::BTreeMap;
use std::path::Path;

use hpy_atproto::{Registry, ReleaseView};
use hpy_project::config::{
    CONFIG_FILE, PluginKind, ProjectToml, find_root, set_plugin, write_if_changed,
};
use hpy_project::lock::Lockfile;
use hpy_project::manifest::parse_package_uri;
use serde_json::json;

use crate::cli::AddArgs;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::prepare::choose_with_prompter;
use crate::project::resolve::{
    Candidate, Choose, Resolver, candidates, pick_version, resolve_lock,
};
use crate::project::{cache, plugins};

#[derive(Debug, Clone, PartialEq)]
pub struct Addition {
    pub kind: PluginKind,
    pub key: String,
    /// The requirement written to `happyview.toml`; the lock picks the highest
    /// release satisfying it, as it would for a hand-edited file.
    pub version: String,
    pub package: String,
}

pub fn parse_spec(spec: &str) -> (String, Option<String>) {
    match spec.rsplit_once('@') {
        Some((name, version)) if !name.is_empty() => (name.into(), Some(version.into())),
        _ => (spec.into(), None),
    }
}

/// The newest active stable release. A prerelease is offered only when
/// nothing else is published, since a project asking for no version in
/// particular should not land on one that has not been released.
fn newest(releases: &[ReleaseView]) -> Option<semver::Version> {
    let active: Vec<semver::Version> = releases
        .iter()
        .filter(|r| r.status == "active")
        .filter_map(|r| semver::Version::parse(r.record["version"].as_str()?).ok())
        .collect();
    active
        .iter()
        .filter(|v| v.pre.is_empty())
        .max()
        .or_else(|| active.iter().max())
        .cloned()
}

/// Which package each spec means and the requirement to write for it. A key
/// the lock already records keeps the lock's package unless `package` names
/// another: searching by name again could land on a second publisher's.
pub async fn plan_additions(
    reg: &dyn Registry,
    specs: &[String],
    kind: Option<PluginKind>,
    package: Option<&str>,
    previous: Option<&Lockfile>,
    choose: Choose<'_>,
) -> Result<Vec<Addition>, Failure> {
    let kinds: Vec<PluginKind> = match kind {
        Some(k) => vec![k],
        None => vec![PluginKind::Interpreter, PluginKind::Library],
    };
    let mut found: BTreeMap<PluginKind, Vec<Candidate>> = BTreeMap::new();
    let mut out = Vec::new();
    for spec in specs {
        let (key, version) = parse_spec(spec);
        if let Some(req) = &version
            && semver::VersionReq::parse(req).is_err()
        {
            return Err(Failure::usage(format!(
                "`{spec}`: `{req}` is not a version or version range"
            )));
        }
        let locked: Vec<(PluginKind, String)> = match (package, previous) {
            (None, Some(lock)) => kinds
                .iter()
                .filter_map(|k| lock.find_key(*k, &key).map(|p| (*k, p.package.clone())))
                .collect(),
            _ => Vec::new(),
        };
        let (kind, uri) = match locked.as_slice() {
            [one] => one.clone(),
            [_, _, ..] => {
                return Err(Failure::usage(format!(
                    "happyview.lock has `{key}` as both an interpreter and a library; \
                     pass --interpreter or --library"
                )));
            }
            [] => search(reg, &mut found, &kinds, kind, &key, package, choose).await?,
        };
        let (did, slug) = parse_package_uri(&uri)
            .ok_or_else(|| Failure::usage(format!("`{uri}` is not a registry package URI")))?;
        let releases = reg.list_releases(&did, &slug).await?;
        let version = match version {
            None => newest(&releases)
                .ok_or_else(|| Failure::usage(format!("{slug} has no active release")))?
                .to_string(),
            Some(req) => {
                if pick_version(&releases, std::slice::from_ref(&req)).is_none() {
                    return Err(Failure::usage(format!(
                        "no active version of {slug} matches {req}"
                    )));
                }
                req
            }
        };
        out.push(Addition {
            kind,
            key,
            version,
            package: uri,
        });
    }
    Ok(out)
}

/// The kind and package URI the registry answers `key` with, asking `choose`
/// when several packages do and `package` names none of them.
async fn search(
    reg: &dyn Registry,
    found: &mut BTreeMap<PluginKind, Vec<Candidate>>,
    kinds: &[PluginKind],
    flag: Option<PluginKind>,
    key: &str,
    package: Option<&str>,
    choose: Choose<'_>,
) -> Result<(PluginKind, String), Failure> {
    let mut answering: Vec<(PluginKind, Vec<Candidate>)> = Vec::new();
    for k in kinds {
        if !found.contains_key(k) {
            found.insert(*k, candidates(reg, *k).await?);
        }
        let matches: Vec<Candidate> = found[k]
            .iter()
            .filter(|c| c.answers(*k, key))
            .cloned()
            .collect();
        if !matches.is_empty() {
            answering.push((*k, matches));
        }
    }
    let (kind, matches) = match answering.as_slice() {
        [] => {
            let what = match flag {
                Some(k) => k.plugin_type(),
                None => "interpreter or library",
            };
            return Err(Failure::usage(format!(
                "no {what} in the registry answers to `{key}`"
            )));
        }
        [one] => one,
        _ => {
            return Err(Failure::usage(format!(
                "`{key}` names both an interpreter and a library; pass --interpreter or --library"
            )));
        }
    };
    let chosen = match package {
        Some(uri) => matches
            .iter()
            .find(|c| c.package == uri)
            .ok_or_else(|| Failure::usage(format!("{uri} does not answer to `{key}`")))?,
        None if matches.len() == 1 => &matches[0],
        None => &matches[choose(key, matches)?],
    };
    Ok((*kind, chosen.package.clone()))
}

pub fn apply_additions(text: &str, additions: &[Addition]) -> Result<String, Failure> {
    let mut text = text.to_string();
    for a in additions {
        text = set_plugin(&text, a.kind, &a.key, &a.version)?;
    }
    Ok(text)
}

/// Adds `args.plugins` to the project at `root`, rewrites its lock and
/// downloads every locked plugin into `cache_root`.
pub async fn add_in(
    root: &Path,
    registry: &dyn Registry,
    cache_root: &Path,
    args: &AddArgs,
    choose: Choose<'_>,
    warn: &(dyn Fn(&str) + Sync),
) -> Result<(Vec<Addition>, Lockfile), Failure> {
    if let Some(uri) = &args.package
        && parse_package_uri(uri).is_none()
    {
        return Err(Failure::usage(format!(
            "--package: `{uri}` is not an at://<did>/at.happyproto.plugin.profile/<slug> URI"
        )));
    }
    let kind = match (args.interpreter, args.library) {
        (true, _) => Some(PluginKind::Interpreter),
        (_, true) => Some(PluginKind::Library),
        _ => None,
    };
    let previous = Lockfile::load(root)?;
    let additions = plan_additions(
        registry,
        &args.plugins,
        kind,
        args.package.as_deref(),
        previous.as_ref(),
        choose,
    )
    .await?;
    let path = root.join(CONFIG_FILE);
    let text = std::fs::read_to_string(&path).map_err(Failure::runtime)?;
    let text = apply_additions(&text, &additions)?;
    let config = ProjectToml::parse(&text)?;
    // What was just named wins over whatever package the lock recorded for
    // the same key; otherwise the lock's choice would quietly survive.
    let pins = additions
        .iter()
        .map(|a| ((a.kind, a.key.clone()), a.package.clone()))
        .collect();
    let r = Resolver {
        registry,
        choose,
        warn,
        pins,
    };
    let lock = resolve_lock(&r, &config, previous.as_ref()).await?;
    // Everything that can fail on the network happens before either file is
    // written, so a refusal or a failed download leaves the project as it was.
    // A plugin cached for a run that then fails is reused by the next one.
    for p in &lock.plugins {
        plugins::ensure_plugin(registry, cache_root, p).await?;
    }
    write_if_changed(&path, &text).map_err(Failure::runtime)?;
    lock.write(root).map_err(Failure::runtime)?;
    Ok((additions, lock))
}

pub async fn run(ctx: &Ctx, args: AddArgs) -> Result<(), Failure> {
    let root = find_root(&ctx.dir).ok_or_else(|| {
        Failure::usage(format!(
            "no {CONFIG_FILE} in {} or any directory above it; start one with `hpy happyview create`",
            ctx.dir.display()
        ))
    })?;
    let cache_root = cache::cache_root()?;
    let registry = ctx.registry();
    let choose = choose_with_prompter(ctx);
    let warn = |m: &str| ctx.out.status(&format!("warning: {m}"));
    let (additions, lock) = add_in(&root, &registry, &cache_root, &args, &choose, &warn).await?;
    let lines: Vec<String> = args
        .plugins
        .iter()
        .zip(&additions)
        .map(|(spec, a)| {
            let mut line = format!(
                "added {} `{}` {} ({})",
                a.kind.plugin_type(),
                a.key,
                a.version,
                a.package
            );
            if parse_spec(spec).1.is_none()
                && semver::Version::parse(&a.version).is_ok_and(|v| !v.pre.is_empty())
            {
                line.push_str("\n  it has only prereleases, so this range accepts them");
            }
            line
        })
        .collect();
    let human = if lines.is_empty() {
        format!("{} plugins locked and downloaded", lock.plugins.len())
    } else {
        lines.join("\n")
    };
    ctx.out.done(
        &human,
        json!({
            "added": additions.iter().map(|a| json!({
                "kind": a.kind.plugin_type(), "key": a.key, "version": a.version, "package": a.package
            })).collect::<Vec<_>>(),
            "locked": lock.plugins.iter().map(|p| json!({ "id": p.id, "version": p.version })).collect::<Vec<_>>(),
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{RegistryFixture, interpreter_ext, library_ext};
    use serde_json::json;

    const HV: &str = "did:plc:happyview";

    fn never(_: &str, _: &[Candidate]) -> Result<usize, Failure> {
        panic!("nothing should be ambiguous here")
    }

    fn registry() -> RegistryFixture {
        let mut reg = RegistryFixture::default();
        reg.publish(
            HV,
            "happyview-lua",
            "1.4.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"a",
        );
        reg.publish(
            HV,
            "happyview-lua",
            "1.5.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"b",
        );
        reg.publish(
            HV,
            "happyview-http",
            "1.0.3",
            library_ext("happyview.http"),
            json!({}),
            b"c",
        );
        reg
    }

    #[test]
    fn specs_split_on_the_last_at() {
        assert_eq!(parse_spec("lua"), ("lua".into(), None));
        assert_eq!(
            parse_spec("lua@1.4.0"),
            ("lua".into(), Some("1.4.0".into()))
        );
    }

    #[tokio::test]
    async fn the_kind_is_found_from_the_registry() {
        let reg = registry();
        let adds = plan_additions(
            &reg,
            &["lua".into(), "happyview.http".into()],
            None,
            None,
            None,
            &never,
        )
        .await
        .unwrap();
        assert_eq!(
            adds.iter()
                .map(|a| (a.kind, a.key.as_str(), a.version.as_str()))
                .collect::<Vec<_>>(),
            [
                (PluginKind::Interpreter, "lua", "1.5.0"),
                (PluginKind::Library, "happyview.http", "1.0.3")
            ]
        );
    }

    #[tokio::test]
    async fn an_explicit_version_must_exist() {
        let reg = registry();
        let ok = plan_additions(&reg, &["lua@1.4.0".into()], None, None, None, &never)
            .await
            .unwrap();
        assert_eq!(ok[0].version, "1.4.0");
        let err = plan_additions(&reg, &["lua@9".into()], None, None, None, &never)
            .await
            .unwrap_err();
        assert!(
            err.report
                .to_string()
                .contains("no active version of happyview-lua matches 9")
        );
        let err = plan_additions(&reg, &["lua@one".into()], None, None, None, &never)
            .await
            .unwrap_err();
        assert_eq!(err.code, 2);
        assert!(err.report.to_string().contains("`one` is not a version"));
    }

    #[tokio::test]
    async fn no_version_means_the_newest_stable_release() {
        let mut reg = registry();
        reg.publish(
            HV,
            "happyview-lua",
            "1.6.0-beta.1",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"beta",
        );
        let adds = plan_additions(&reg, &["lua".into()], None, None, None, &never)
            .await
            .unwrap();
        assert_eq!(adds[0].version, "1.5.0");
    }

    #[tokio::test]
    async fn only_prereleases_are_offered_when_nothing_else_is_published() {
        let mut reg = registry();
        for v in ["0.1.0-alpha.1", "0.1.0-alpha.3", "0.1.0-alpha.2"] {
            reg.publish(
                HV,
                "happyview-js",
                v,
                interpreter_ext("js", "js"),
                json!({}),
                v.as_bytes(),
            );
        }
        let adds = plan_additions(&reg, &["js".into()], None, None, None, &never)
            .await
            .unwrap();
        assert_eq!(adds[0].version, "0.1.0-alpha.3");
        assert!(hpy_project::config::version_matches(
            &adds[0].version,
            "0.1.0-alpha.3"
        ));
    }

    #[tokio::test]
    async fn a_named_prerelease_is_written_as_given() {
        let mut reg = registry();
        reg.publish(
            HV,
            "happyview-lua",
            "1.6.0-beta.1",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"beta",
        );
        let adds = plan_additions(&reg, &["lua@1.6.0-beta.1".into()], None, None, None, &never)
            .await
            .unwrap();
        assert_eq!(adds[0].version, "1.6.0-beta.1");
        let releases = reg.list_releases(HV, "happyview-lua").await.unwrap();
        assert_eq!(
            pick_version(&releases, &[adds[0].version.clone()]).map(|(v, _)| v),
            Some("1.6.0-beta.1".into())
        );
    }

    #[tokio::test]
    async fn a_name_both_kinds_answer_needs_a_flag() {
        let mut reg = registry();
        reg.publish(
            "did:plc:x",
            "lua",
            "1.0.0",
            library_ext("lua"),
            json!({}),
            b"d",
        );
        let err = plan_additions(&reg, &["lua".into()], None, None, None, &never)
            .await
            .unwrap_err();
        assert!(
            err.report
                .to_string()
                .contains("--interpreter or --library")
        );
        let adds = plan_additions(
            &reg,
            &["lua".into()],
            Some(PluginKind::Library),
            None,
            None,
            &never,
        )
        .await
        .unwrap();
        assert_eq!(
            adds[0].package,
            "at://did:plc:x/at.happyproto.plugin.profile/lua"
        );
    }

    #[tokio::test]
    async fn package_picks_among_several() {
        let mut reg = registry();
        reg.publish(
            "did:plc:x",
            "other-lua",
            "3.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"e",
        );
        let uri = "at://did:plc:x/at.happyproto.plugin.profile/other-lua";
        let adds = plan_additions(&reg, &["lua".into()], None, Some(uri), None, &never)
            .await
            .unwrap();
        assert_eq!(
            (adds[0].package.as_str(), adds[0].version.as_str()),
            (uri, "3.0.0")
        );
        let err = plan_additions(
            &reg,
            &["lua".into()],
            None,
            Some("at://did:plc:nobody/at.happyproto.plugin.profile/x"),
            None,
            &never,
        )
        .await
        .unwrap_err();
        assert!(err.report.to_string().contains("does not answer to `lua`"));
    }

    #[test]
    fn applying_keeps_the_rest_of_the_file() {
        let text =
            "# mine\n[happyview]\nversion = \"3.0.0\"\n\n[interpreters]\nlua = \"1.4.0\" # keep\n";
        let out = apply_additions(
            text,
            &[Addition {
                kind: PluginKind::Library,
                key: "happyview.http".into(),
                version: "1.0.3".into(),
                package: "at://did:plc:happyview/at.happyproto.plugin.profile/happyview-http"
                    .into(),
            }],
        )
        .unwrap();
        assert!(out.starts_with("# mine\n"), "{out}");
        assert!(out.contains("lua = \"1.4.0\" # keep"), "{out}");
        assert!(out.contains("\"happyview.http\" = \"1.0.3\""), "{out}");
    }

    #[test]
    fn a_key_happyview_would_refuse_is_a_usage_error() {
        let err = apply_additions(
            "[happyview]\nversion = \"3.0.0\"\n",
            &[Addition {
                kind: PluginKind::Interpreter,
                key: "Lua".into(),
                version: "1.0.0".into(),
                package: "at://did:plc:x/at.happyproto.plugin.profile/lua".into(),
            }],
        )
        .unwrap_err();
        assert_eq!(err.code, 2);
        assert!(
            err.report.to_string().contains("must be lowercase"),
            "{:?}",
            err.report
        );
    }

    fn project(toml: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), toml).unwrap();
        dir
    }

    fn args(plugins: &[&str], package: Option<&str>) -> AddArgs {
        AddArgs {
            plugins: plugins.iter().map(|s| s.to_string()).collect(),
            interpreter: false,
            library: false,
            package: package.map(Into::into),
        }
    }

    #[tokio::test]
    async fn a_named_package_replaces_the_one_the_lock_recorded() {
        let mut reg = registry();
        reg.publish(
            "did:plc:x",
            "other-lua",
            "3.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"other",
        );
        let first = "at://did:plc:happyview/at.happyproto.plugin.profile/happyview-lua";
        let second = "at://did:plc:x/at.happyproto.plugin.profile/other-lua";
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = tempfile::tempdir().unwrap();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua"], Some(first)),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        let lock = Lockfile::load(dir.path()).unwrap().unwrap();
        assert_eq!(
            lock.find_key(PluginKind::Interpreter, "lua")
                .unwrap()
                .package,
            first
        );

        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua"], Some(second)),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        let lock = Lockfile::load(dir.path()).unwrap().unwrap();
        let lua = lock.find_key(PluginKind::Interpreter, "lua").unwrap();
        assert_eq!(
            (lua.package.as_str(), lua.version.as_str()),
            (second, "3.0.0")
        );
        assert!(
            std::fs::read_to_string(dir.path().join(CONFIG_FILE))
                .unwrap()
                .contains("lua = \"3.0.0\"")
        );
        assert_eq!(
            std::fs::read(cache.path().join("plugins/other-lua/3.0.0/other-lua.wasm")).unwrap(),
            b"other"
        );
    }

    #[tokio::test]
    async fn adding_nothing_locks_and_downloads_what_the_file_names() {
        let reg = registry();
        let dir = project("[happyview]\nversion = \"3.0.0\"\n\n[interpreters]\nlua = \"=1.4.0\"\n");
        let cache = tempfile::tempdir().unwrap();
        let (adds, lock) = add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&[], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        assert!(adds.is_empty());
        assert_eq!(lock.plugins[0].version, "1.4.0");
        assert!(dir.path().join("happyview.lock").exists());
        assert_eq!(
            std::fs::read(
                cache
                    .path()
                    .join("plugins/happyview-lua/1.4.0/happyview-lua.wasm")
            )
            .unwrap(),
            b"a"
        );
    }

    #[tokio::test]
    async fn a_refused_resolution_leaves_both_files_alone() {
        let reg = registry();
        let toml = "[happyview]\nversion = \"3.0.0\"\n\n[interpreters]\nlua = \"=1.4.0\"\n";
        let dir = project(toml);
        let cache = tempfile::tempdir().unwrap();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&[], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        let lock = std::fs::read_to_string(dir.path().join("happyview.lock")).unwrap();
        // A hand edit no release satisfies; adding beside it must not write.
        let broken = toml.replace("=1.4.0", "=7.0.0");
        std::fs::write(dir.path().join(CONFIG_FILE), &broken).unwrap();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["happyview.http"], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap(),
            broken
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("happyview.lock")).unwrap(),
            lock
        );
    }

    #[tokio::test]
    async fn a_locked_key_keeps_its_package_without_searching() {
        let mut reg = registry();
        reg.publish(
            "did:plc:x",
            "other-lua",
            "3.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"other",
        );
        let original = "at://did:plc:happyview/at.happyproto.plugin.profile/happyview-lua";
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = tempfile::tempdir().unwrap();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua@1.4.0"], Some(original)),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        reg.calls.lock().unwrap().clear();
        // Two packages answer to `lua`, and `never` panics if asked.
        let (adds, lock) = add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua"], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!(
            (adds[0].package.as_str(), adds[0].version.as_str()),
            (original, "1.5.0")
        );
        let lua = lock.find_key(PluginKind::Interpreter, "lua").unwrap();
        assert_eq!(
            (lua.package.as_str(), lua.version.as_str()),
            (original, "1.5.0")
        );
        assert!(
            !reg.calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("searchPackages")),
            "{:?}",
            reg.calls.lock().unwrap()
        );
    }

    #[tokio::test]
    async fn installing_keeps_the_locked_version_and_touches_no_file() {
        let mut reg = RegistryFixture::default();
        reg.publish(
            HV,
            "happyview-lua",
            "1.4.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"a",
        );
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = tempfile::tempdir().unwrap();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua"], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        reg.publish(
            HV,
            "happyview-lua",
            "1.5.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"b",
        );
        let toml_path = dir.path().join(CONFIG_FILE);
        let lock_path = dir.path().join("happyview.lock");
        assert!(
            std::fs::read_to_string(&toml_path)
                .unwrap()
                .contains("lua = \"1.4.0\"")
        );
        let lock_text = std::fs::read_to_string(&lock_path).unwrap();
        let long_ago =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        for path in [&toml_path, &lock_path] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(long_ago)
                .unwrap();
        }
        std::fs::remove_dir_all(cache.path().join("plugins")).unwrap();

        let (adds, lock) = add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&[], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        assert!(adds.is_empty());
        assert_eq!(lock.plugins[0].version, "1.4.0");
        assert_eq!(std::fs::read_to_string(&lock_path).unwrap(), lock_text);
        for path in [&toml_path, &lock_path] {
            assert_eq!(
                std::fs::metadata(path).unwrap().modified().unwrap(),
                long_ago,
                "{}",
                path.display()
            );
        }
        assert_eq!(
            std::fs::read(
                cache
                    .path()
                    .join("plugins/happyview-lua/1.4.0/happyview-lua.wasm")
            )
            .unwrap(),
            b"a"
        );
    }

    #[tokio::test]
    async fn a_failed_download_leaves_both_files_alone() {
        let mut reg = registry();
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = tempfile::tempdir().unwrap();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua"], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        let toml = std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        let lock = std::fs::read_to_string(dir.path().join("happyview.lock")).unwrap();
        reg.artifacts
            .retain(|(_, slug, _), _| slug != "happyview-http");
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["happyview.http"], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap(),
            toml
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("happyview.lock")).unwrap(),
            lock
        );
    }
}
