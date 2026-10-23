use std::collections::BTreeMap;
use std::path::Path;

use hpy_atproto::Registry;
use hpy_plugin::TRACKS;
use hpy_plugin::validate::{parse_project_uri, version_problem};
use hpy_project::config::{
    CONFIG_FILE, Pin, PluginEntry, PluginKind, ProjectToml, find_root, set_plugin, write_if_changed,
};
use hpy_project::lock::Lockfile;
use serde_json::{Value, json};

use crate::cli::AddArgs;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::prepare::choose_with_prompter;
use crate::project::resolve::{Candidate, Choose, Resolver, candidates, resolve_lock};
use crate::project::{cache, plugins};

#[derive(Debug, Clone, PartialEq)]
pub struct Addition {
    pub kind: PluginKind,
    pub key: String,
    /// What `happyview.toml` gets.
    pub entry: PluginEntry,
    /// The version the entry resolves to today.
    pub version: String,
}

impl Addition {
    pub fn to_json(&self) -> Value {
        let mut out = json!({
            "kind": self.kind.plugin_type(),
            "key": self.key,
            "project": self.entry.project_uri(),
            "version": self.version,
        });
        if let Pin::Channel(c) = &self.entry.pin {
            out["channel"] = c.clone().into();
        }
        out
    }
}

/// The channel a new entry follows when none is named: `latest`, else the
/// only one the project has, so a plugin with nothing but prereleases can
/// still be added.
fn default_channel(channels: &[&str]) -> Option<String> {
    TRACKS
        .iter()
        .find(|t| channels.contains(t))
        .map(|t| t.to_string())
}

/// The pin `--channel`/`--version` ask for.
pub fn requested_pin(channel: Option<&str>, version: Option<&str>) -> Result<Option<Pin>, Failure> {
    match (channel, version) {
        (Some(_), Some(_)) => Err(Failure::usage(
            "--channel and --version both choose the version; pass one",
        )),
        (Some(c), None) if !TRACKS.contains(&c) => Err(Failure::usage(format!(
            "--channel: `{c}` is not one of {}",
            TRACKS.join(", ")
        ))),
        (Some(c), None) => Ok(Some(Pin::Channel(c.into()))),
        (None, Some(v)) => match version_problem(v) {
            Some(p) => Err(Failure::usage(format!("--version: {p}"))),
            None => Ok(Some(Pin::Version(v.into()))),
        },
        (None, None) => Ok(None),
    }
}

/// Which project each spec means and how to pin it. A key the lock already
/// records keeps the lock's project unless `project` names another:
/// searching by name again could land on a second publisher's.
pub async fn plan_additions(
    reg: &dyn Registry,
    specs: &[String],
    kind: Option<PluginKind>,
    project: Option<&str>,
    pin: Option<Pin>,
    previous: Option<&Lockfile>,
    choose: Choose<'_>,
) -> Result<Vec<Addition>, Failure> {
    let kinds: Vec<PluginKind> = match kind {
        Some(k) => vec![k],
        None => vec![PluginKind::Interpreter, PluginKind::Library],
    };
    let mut found: BTreeMap<PluginKind, Vec<Candidate>> = BTreeMap::new();
    let mut out = Vec::new();
    for key in specs {
        if let Some((name, version)) = key.rsplit_once('@') {
            return Err(Failure::usage(format!(
                "`{key}`: pass the version as --version {version} (`{name}` follows a channel otherwise)"
            )));
        }
        let locked: Vec<(PluginKind, String)> = match (project, previous) {
            (None, Some(lock)) => kinds
                .iter()
                .filter_map(|k| lock.find_key(*k, key).map(|p| (*k, p.project.clone())))
                .collect(),
            _ => Vec::new(),
        };
        let (kind, uri, channels) = match locked.as_slice() {
            [one] => {
                let (did, name) = parse_project_uri(&one.1).ok_or_else(|| {
                    Failure::usage(format!("happyview.lock: `{}` is not a project URI", one.1))
                })?;
                let channels: Vec<String> = reg
                    .get_project(&did, &name)
                    .await?
                    .map(|p| p.channels.keys().cloned().collect())
                    .unwrap_or_default();
                (one.0, one.1.clone(), channels)
            }
            [_, _, ..] => {
                return Err(Failure::usage(format!(
                    "happyview.lock has `{key}` as both an interpreter and a library; \
                     pass --interpreter or --library"
                )));
            }
            [] => {
                let (kind, c) = search(reg, &mut found, &kinds, kind, key, project, choose).await?;
                (kind, c.project, vec![c.channel])
            }
        };
        let (did, name) = parse_project_uri(&uri)
            .ok_or_else(|| Failure::usage(format!("`{uri}` is not a project URI")))?;
        let pin = match &pin {
            Some(pin) => pin.clone(),
            None => {
                let channels: Vec<&str> = channels.iter().map(String::as_str).collect();
                Pin::Channel(default_channel(&channels).ok_or_else(|| {
                    Failure::usage(format!("{name} has no channel to follow; pass --version"))
                })?)
            }
        };
        let view = match &pin {
            Pin::Channel(c) => reg
                .resolve_channel(&did, &name, c)
                .await?
                .ok_or_else(|| Failure::usage(format!("{name} has no {c} channel")))?,
            Pin::Version(v) => reg
                .get_version(&did, &name, v)
                .await?
                .ok_or_else(|| Failure::usage(format!("the registry has no {name} {v}")))?,
        };
        out.push(Addition {
            kind,
            key: key.clone(),
            entry: PluginEntry { did, name, pin },
            version: view.version,
        });
    }
    Ok(out)
}

/// The kind and candidate the registry answers `key` with, asking `choose`
/// when several projects do and `project` names none of them.
async fn search(
    reg: &dyn Registry,
    found: &mut BTreeMap<PluginKind, Vec<Candidate>>,
    kinds: &[PluginKind],
    flag: Option<PluginKind>,
    key: &str,
    project: Option<&str>,
    choose: Choose<'_>,
) -> Result<(PluginKind, Candidate), Failure> {
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
    let chosen = match project {
        Some(uri) => matches
            .iter()
            .find(|c| c.project == uri)
            .ok_or_else(|| Failure::usage(format!("{uri} does not answer to `{key}`")))?,
        None if matches.len() == 1 => &matches[0],
        None => &matches[choose(key, matches)?],
    };
    Ok((*kind, chosen.clone()))
}

pub fn apply_additions(text: &str, additions: &[Addition]) -> Result<String, Failure> {
    let mut text = text.to_string();
    for a in additions {
        text = set_plugin(&text, a.kind, &a.key, &a.entry)?;
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
    if let Some(uri) = &args.project
        && parse_project_uri(uri).is_none()
    {
        return Err(Failure::usage(format!(
            "--project: `{uri}` is not an at://<did>/software.release.project/<name> URI"
        )));
    }
    let pin = requested_pin(args.channel.as_deref(), args.version.as_deref())?;
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
        args.project.as_deref(),
        pin,
        previous.as_ref(),
        choose,
    )
    .await?;
    let path = root.join(CONFIG_FILE);
    let text = std::fs::read_to_string(&path).map_err(Failure::runtime)?;
    let text = apply_additions(&text, &additions)?;
    let config = ProjectToml::parse(&text)?;
    // What was just added resolves afresh, so adding a plugin again moves
    // it to its channel's current version; everything else keeps its lock.
    let previous = previous.map(|mut lock| {
        lock.plugins.retain(|p| {
            !additions
                .iter()
                .any(|a| a.kind == p.kind && p.keys.contains(&a.key))
        });
        lock
    });
    let r = Resolver { registry, warn };
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

/// The `--json` answer.
pub fn report(additions: &[Addition], lock: &Lockfile) -> Value {
    json!({
        "added": additions.iter().map(Addition::to_json).collect::<Vec<_>>(),
        "locked": lock.plugins.iter().map(|p| json!({ "id": p.id, "version": p.version })).collect::<Vec<_>>(),
    })
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
    let lines: Vec<String> = additions
        .iter()
        .map(|a| {
            let mut line = format!(
                "added {} `{}`: {} {} ({})",
                a.kind.plugin_type(),
                a.key,
                a.entry.name,
                a.entry.pin_label(),
                a.version,
            );
            if matches!(&a.entry.pin, Pin::Channel(c) if c != "latest") {
                line.push_str("\n  it has no latest channel, so this follows a prerelease one");
            }
            line
        })
        .collect();
    let human = if lines.is_empty() {
        format!("{} plugins locked and downloaded", lock.plugins.len())
    } else {
        lines.join("\n")
    };
    ctx.out.done(&human, report(&additions, &lock));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{RegistryFixture, interpreter_ext, library_ext};
    use hpy_plugin::validate::project_uri;

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

    async fn plan(
        reg: &RegistryFixture,
        specs: &[&str],
        kind: Option<PluginKind>,
        project: Option<&str>,
        pin: Option<Pin>,
    ) -> Result<Vec<Addition>, Failure> {
        let specs: Vec<String> = specs.iter().map(|s| s.to_string()).collect();
        plan_additions(reg, &specs, kind, project, pin, None, &never).await
    }

    #[tokio::test]
    async fn the_kind_is_found_from_the_registry_and_the_latest_channel_followed() {
        let reg = registry();
        let adds = plan(&reg, &["lua", "happyview.http"], None, None, None)
            .await
            .unwrap();
        assert_eq!(
            adds.iter()
                .map(|a| (
                    a.kind,
                    a.key.as_str(),
                    a.entry.name.as_str(),
                    a.version.as_str()
                ))
                .collect::<Vec<_>>(),
            [
                (PluginKind::Interpreter, "lua", "happyview-lua", "1.5.0"),
                (
                    PluginKind::Library,
                    "happyview.http",
                    "happyview-http",
                    "1.0.3"
                )
            ]
        );
        assert_eq!(adds[0].entry.pin, Pin::Channel("latest".into()));
        assert_eq!(adds[0].entry.did, HV);
    }

    #[tokio::test]
    async fn a_channel_or_version_given_is_written_and_must_exist() {
        let reg = registry();
        let adds = plan(
            &reg,
            &["lua"],
            None,
            None,
            Some(Pin::Version("1.4.0".into())),
        )
        .await
        .unwrap();
        assert_eq!(adds[0].entry.pin, Pin::Version("1.4.0".into()));
        assert_eq!(adds[0].version, "1.4.0");
        let err = plan(
            &reg,
            &["lua"],
            None,
            None,
            Some(Pin::Version("9.0.0".into())),
        )
        .await
        .unwrap_err();
        assert!(
            err.report.to_string().contains("no happyview-lua 9.0.0"),
            "{}",
            err.report
        );
        let err = plan(
            &reg,
            &["lua"],
            None,
            None,
            Some(Pin::Channel("beta".into())),
        )
        .await
        .unwrap_err();
        assert!(
            err.report.to_string().contains("no beta channel"),
            "{}",
            err.report
        );
    }

    #[test]
    fn the_pin_flags_are_checked() {
        assert_eq!(requested_pin(None, None).unwrap(), None);
        assert_eq!(
            requested_pin(Some("beta"), None).unwrap(),
            Some(Pin::Channel("beta".into()))
        );
        assert_eq!(
            requested_pin(None, Some("1.0.0")).unwrap(),
            Some(Pin::Version("1.0.0".into()))
        );
        for (c, v) in [
            (Some("stable"), None),
            (None, Some("^1")),
            (Some("beta"), Some("1.0.0")),
        ] {
            assert_eq!(requested_pin(c, v).unwrap_err().code, 2, "{c:?} {v:?}");
        }
    }

    #[tokio::test]
    async fn the_old_at_version_spelling_points_at_the_flag() {
        let err = plan(&registry(), &["lua@1.4.0"], None, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, 2);
        assert!(
            err.report.to_string().contains("--version 1.4.0"),
            "{}",
            err.report
        );
    }

    #[tokio::test]
    async fn a_project_with_only_prereleases_follows_its_channel() {
        let mut reg = registry();
        for v in ["0.1.0-alpha.1", "0.1.0-alpha.3"] {
            reg.publish(
                HV,
                "happyview-js",
                v,
                interpreter_ext("js", "js"),
                json!({}),
                v.as_bytes(),
            );
        }
        let adds = plan(&reg, &["js"], None, None, None).await.unwrap();
        assert_eq!(adds[0].entry.pin, Pin::Channel("alpha".into()));
        assert_eq!(adds[0].version, "0.1.0-alpha.3");
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
        let err = plan(&reg, &["lua"], None, None, None).await.unwrap_err();
        assert!(
            err.report
                .to_string()
                .contains("--interpreter or --library")
        );
        let adds = plan(&reg, &["lua"], Some(PluginKind::Library), None, None)
            .await
            .unwrap();
        assert_eq!(adds[0].entry.project_uri(), project_uri("did:plc:x", "lua"));
    }

    #[tokio::test]
    async fn project_picks_among_several() {
        let mut reg = registry();
        reg.publish(
            "did:plc:x",
            "other-lua",
            "3.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"e",
        );
        let uri = project_uri("did:plc:x", "other-lua");
        let adds = plan(&reg, &["lua"], None, Some(&uri), None).await.unwrap();
        assert_eq!(
            (adds[0].entry.project_uri(), adds[0].version.as_str()),
            (uri, "3.0.0")
        );
        let err = plan(
            &reg,
            &["lua"],
            None,
            Some(&project_uri("did:plc:nobody", "x")),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.report.to_string().contains("does not answer to `lua`"));
    }

    #[test]
    fn applying_keeps_the_rest_of_the_file() {
        let text = "# mine\n[happyview]\nversion = \"3.0.0\"\n\n[interpreters]\nlua = { did = \"did:plc:happyview\", name = \"happyview-lua\", channel = \"latest\" } # keep\n";
        let out = apply_additions(
            text,
            &[Addition {
                kind: PluginKind::Library,
                key: "happyview.http".into(),
                entry: PluginEntry {
                    did: HV.into(),
                    name: "happyview-http".into(),
                    pin: Pin::Version("1.0.3".into()),
                },
                version: "1.0.3".into(),
            }],
        )
        .unwrap();
        assert!(out.starts_with("# mine\n"), "{out}");
        assert!(out.contains("channel = \"latest\" } # keep"), "{out}");
        assert!(
            out.contains("\"happyview.http\" = { did = \"did:plc:happyview\", name = \"happyview-http\", version = \"1.0.3\" }"),
            "{out}"
        );
    }

    fn project(toml: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), toml).unwrap();
        dir
    }

    fn args(plugins: &[&str], project: Option<&str>) -> AddArgs {
        AddArgs {
            plugins: plugins.iter().map(|s| s.to_string()).collect(),
            interpreter: false,
            library: false,
            channel: None,
            version: None,
            project: project.map(Into::into),
        }
    }

    #[tokio::test]
    async fn adding_writes_the_entry_the_lock_and_the_json() {
        let reg = registry();
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = crate::testing::private_tempdir();
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
        let cfg = ProjectToml::load(dir.path()).unwrap();
        assert_eq!(cfg.interpreters["lua"], adds[0].entry);
        assert_eq!(lock.plugins[0].version, "1.5.0");
        assert!(dir.path().join("happyview.lock").exists());
        assert_eq!(
            report(&adds, &lock),
            json!({
                "added": [{ "kind": "interpreter", "key": "lua",
                            "project": project_uri(HV, "happyview-lua"),
                            "channel": "latest", "version": "1.5.0" }],
                "locked": [{ "id": "happyview-lua", "version": "1.5.0" }]
            })
        );
        assert_eq!(
            std::fs::read(
                cache
                    .path()
                    .join("plugins/happyview-lua/1.5.0/happyview-lua.wasm")
            )
            .unwrap(),
            b"b"
        );
    }

    #[tokio::test]
    async fn a_named_project_replaces_the_one_the_lock_recorded() {
        let mut reg = registry();
        reg.publish(
            "did:plc:x",
            "other-lua",
            "3.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"other",
        );
        let first = project_uri(HV, "happyview-lua");
        let second = project_uri("did:plc:x", "other-lua");
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = crate::testing::private_tempdir();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua"], Some(&first)),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&["lua"], Some(&second)),
            &never,
            &|_| {},
        )
        .await
        .unwrap();
        let lock = Lockfile::load(dir.path()).unwrap().unwrap();
        let lua = lock.find_key(PluginKind::Interpreter, "lua").unwrap();
        assert_eq!(
            (lua.project.as_str(), lua.version.as_str()),
            (second.as_str(), "3.0.0")
        );
    }

    #[tokio::test]
    async fn a_locked_key_keeps_its_project_without_searching_and_moves_to_the_channel_head() {
        let mut reg = registry();
        reg.publish(
            "did:plc:x",
            "other-lua",
            "3.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"other",
        );
        let original = project_uri(HV, "happyview-lua");
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = crate::testing::private_tempdir();
        let mut pinned = args(&["lua"], Some(&original));
        pinned.version = Some("1.4.0".into());
        add_in(dir.path(), &reg, cache.path(), &pinned, &never, &|_| {})
            .await
            .unwrap();
        reg.calls.lock().unwrap().clear();
        // Two projects answer to `lua`, and `never` panics if asked.
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
        assert_eq!(adds[0].entry.project_uri(), original);
        let lua = lock.find_key(PluginKind::Interpreter, "lua").unwrap();
        assert_eq!(
            (lua.project.as_str(), lua.version.as_str()),
            (original.as_str(), "1.5.0")
        );
        assert!(
            !reg.calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("searchProjects")),
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
        let cache = crate::testing::private_tempdir();
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
    async fn a_refused_resolution_leaves_both_files_alone() {
        let reg = registry();
        let toml = format!(
            "[happyview]\nversion = \"3.0.0\"\n\n[interpreters]\nlua = {{ did = \"{HV}\", name = \"happyview-lua\", version = \"1.4.0\" }}\n"
        );
        let dir = project(&toml);
        let cache = crate::testing::private_tempdir();
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
        // A hand edit no version satisfies; adding beside it must not write.
        let broken = toml.replace("1.4.0", "7.0.0");
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
    async fn a_failed_download_leaves_both_files_alone() {
        let mut reg = registry();
        let dir = project("[happyview]\nversion = \"3.0.0\"\n");
        let cache = crate::testing::private_tempdir();
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
        reg.blobs.remove(&hpy_plugin::checksum::raw_cid(b"c"));
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

    #[tokio::test]
    async fn an_old_style_entry_is_refused_before_the_network() {
        let reg = registry();
        let dir = project("[happyview]\nversion = \"3.0.0\"\n[interpreters]\nlua = \"^1\"\n");
        let cache = crate::testing::private_tempdir();
        let err = add_in(
            dir.path(),
            &reg,
            cache.path(),
            &args(&[], None),
            &never,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, 2);
        assert!(
            err.report.to_string().contains("interpreters.lua"),
            "{}",
            err.report
        );
    }
}
