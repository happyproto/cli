use std::path::Path;

use hpy_atproto::session::Session;
use hpy_atproto::{Registry, WriteResult};
use hpy_plugin::PROFILE_NSID;
use hpy_plugin::config::{self, HpyToml, ProfileConfig, SectionSource};
use hpy_plugin::manifest::Manifest;
use hpy_plugin::profile::{Profile, parse_author, parse_contact};
use hpy_plugin::validate::is_slug;
use serde_json::{Value, json};

use crate::cli::{ProfileEditArgs, ProfileFields, ProfileInitArgs, SlugArg};
use crate::clock::now;
use crate::ctx::Ctx;
use crate::failure::Failure;

pub(crate) fn resolve_slug(dir: &Path, flag: Option<String>) -> Result<String, Failure> {
    let slug = match flag {
        Some(s) => s,
        None => {
            let manifest = Manifest::load(dir).ok();
            let toml = HpyToml::load(dir)?.unwrap_or_default();
            toml.slug(manifest.as_ref()).ok_or_else(|| {
                Failure::usage("no package slug: pass --slug, or run in a directory with manifest.json or hpy.toml")
            })?
        }
    };
    if !is_slug(&slug) {
        return Err(Failure::usage(format!(
            "`{slug}` is not a valid slug: 1–128 characters, a letter first, then letters, digits, `-` or `.`"
        )));
    }
    Ok(slug)
}

/// The profile as a record, stamped with `lastUpdated`.
pub(crate) fn profile_record(profile: &Profile) -> serde_json::Value {
    let mut p = profile.clone();
    p.last_updated = Some(now());
    p.to_record()
}

/// Asks the registry to check the profile, then to write it to the user's
/// repo. Answers the record's URI.
pub(crate) async fn create_profile(
    registry: &dyn Registry,
    slug: &str,
    profile: &Profile,
) -> Result<String, Failure> {
    let record = profile_record(profile);
    registry.publish_profile(slug, record.clone(), true).await?;
    let written = registry
        .publish_profile(slug, record, false)
        .await?
        .ok_or_else(|| {
            Failure::runtime("the registry created the profile but answered no record")
        })?;
    Ok(written.uri)
}

fn non_empty(s: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        Err("required".into())
    } else {
        Ok(())
    }
}

fn check_slug(s: &str) -> Result<(), String> {
    if is_slug(s) {
        Ok(())
    } else {
        Err("a letter first, then letters, digits, `-` or `.`".into())
    }
}

pub async fn init(ctx: &Ctx, args: ProfileInitArgs) -> Result<(), Failure> {
    let manifest = Manifest::load(&ctx.dir).ok();
    let existing = HpyToml::load(&ctx.dir)?
        .and_then(|t| t.profile)
        .unwrap_or_default();
    let p = &ctx.prompter;
    let f = args.fields;

    let default_slug = existing
        .slug
        .clone()
        .or(manifest.as_ref().map(|m| m.id.clone()));
    let slug = p.required(
        "--slug",
        "Package slug:",
        args.slug.slug,
        default_slug,
        check_slug,
    )?;
    let name = p.optional(
        "Display name:",
        f.name,
        existing
            .name
            .clone()
            .or(manifest.as_ref().and_then(|m| m.name.clone())),
    )?;
    let description = p.optional(
        "One-line description:",
        f.description,
        existing
            .description
            .clone()
            .or(manifest.as_ref().and_then(|m| m.description.clone())),
    )?;
    let license = p.required(
        "--license",
        "License (SPDX, or \"proprietary\"):",
        f.license,
        existing.license.clone(),
        non_empty,
    )?;
    let authors = p.list(
        "--author",
        "Author (Name <email> (url)):",
        f.authors,
        existing.authors.clone(),
        parse_author,
        1,
    )?;
    let security = p.list(
        "--security",
        "Security contact (email or URL):",
        f.security,
        existing.security.clone(),
        parse_contact,
        1,
    )?;
    let keywords = if !f.keywords.is_empty() {
        f.keywords
    } else if p.is_interactive() && existing.keywords.is_empty() {
        p.optional("Keywords (comma-separated):", None, None)?
            .map(|s| {
                s.split(',')
                    .map(|k| k.trim().to_string())
                    .filter(|k| !k.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        existing.keywords.clone()
    };

    let cfg = ProfileConfig {
        slug: Some(slug.clone()),
        name,
        description,
        license: Some(license),
        keywords,
        authors,
        security,
        sections: existing.sections.clone(),
    };
    let (profile, problems) = cfg.to_profile(&ctx.dir, manifest.as_ref());
    if !problems.is_empty() {
        return Err(Failure::problems("the profile is not valid:", &problems));
    }
    config::write_profile(&ctx.dir, &cfg).map_err(Failure::runtime)?;
    ctx.out.status(&format!(
        "Wrote {}",
        ctx.dir.join(config::FILE_NAME).display()
    ));

    if args.local_only {
        ctx.out.done(
            "",
            json!({ "slug": slug, "created": false, "localOnly": true }),
        );
        return Ok(());
    }
    let session = ctx.session()?;
    if session
        .repo
        .get_record(PROFILE_NSID, &slug)
        .await?
        .is_some()
    {
        return Err(Failure::usage(format!(
            "a profile for `{slug}` already exists on your PDS; use `hpy registry plugin edit` or `hpy registry plugin pull`"
        )));
    }
    if !ctx.prompter.confirm(
        &format!("Create the `{slug}` profile on your PDS?"),
        args.yes,
    )? {
        return Err(Failure::runtime("cancelled"));
    }
    let uri = create_profile(&session.registry(), &slug, &profile).await?;
    ctx.out.done(
        &format!("Created {uri}"),
        json!({ "slug": slug, "uri": uri, "created": true }),
    );
    Ok(())
}

fn summary(slug: &str, p: &Profile) -> String {
    let mut lines = vec![format!("{} ({slug})", p.name.as_deref().unwrap_or(slug))];
    if let Some(d) = &p.description {
        lines.push(d.clone());
    }
    lines.push(format!("license:  {}", p.license));
    lines.push(format!(
        "authors:  {}",
        p.authors
            .iter()
            .map(|a| a.display())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    lines.push(format!(
        "security: {}",
        p.security
            .iter()
            .map(|c| c.display())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    if !p.keywords.is_empty() {
        lines.push(format!("keywords: {}", p.keywords.join(", ")));
    }
    if let Some(u) = &p.last_updated {
        lines.push(format!("updated:  {u}"));
    }
    lines.join("\n")
}

struct Fetched {
    slug: String,
    session: Session,
    profile: Profile,
    cid: Option<String>,
}

async fn fetch(ctx: &Ctx, slug_flag: Option<String>) -> Result<Fetched, Failure> {
    let slug = resolve_slug(&ctx.dir, slug_flag)?;
    let session = ctx.session()?;
    let stored = session
        .repo
        .get_record(PROFILE_NSID, &slug)
        .await?
        .ok_or_else(|| {
            Failure::usage(format!(
                "no profile for `{slug}` on your PDS; run `hpy registry plugin init`"
            ))
        })?;
    let profile = Profile::from_record(stored.value).map_err(Failure::runtime)?;
    Ok(Fetched {
        slug,
        session,
        profile,
        cid: stored.cid,
    })
}

pub async fn show(ctx: &Ctx, args: SlugArg) -> Result<(), Failure> {
    let f = fetch(ctx, args.slug).await?;
    ctx.out
        .done(&summary(&f.slug, &f.profile), f.profile.to_record());
    Ok(())
}

/// Replaces the profile through the registry, which holds the edit to the
/// rules it indexes by and refuses it if the profile changed since `cid`.
pub(crate) async fn update(
    registry: &dyn Registry,
    slug: &str,
    record: Value,
    cid: Option<&str>,
) -> Result<WriteResult, Failure> {
    registry
        .update_profile(slug, record, cid)
        .await
        .map_err(put_error)
}

/// A swap conflict means someone changed the profile mid-edit; say so.
pub(crate) fn put_error(e: hpy_atproto::Error) -> Failure {
    match &e {
        hpy_atproto::Error::Xrpc { name, .. } if name.contains("InvalidSwap") => Failure::runtime(
            "the profile changed on your PDS while you were editing; run the edit again",
        ),
        _ => Failure::from(e),
    }
}

pub(crate) fn apply_edits(
    p: &mut Profile,
    f: &ProfileFields,
    remove_keywords: &[String],
) -> Result<(), Failure> {
    if let Some(n) = &f.name {
        p.name = Some(n.clone());
    }
    if let Some(d) = &f.description {
        p.description = Some(d.clone());
    }
    if let Some(l) = &f.license {
        p.license = l.clone();
    }
    for a in &f.authors {
        p.authors
            .push(parse_author(a).map_err(|e| Failure::usage(format!("--author: {e}")))?);
    }
    for c in &f.security {
        p.security
            .push(parse_contact(c).map_err(|e| Failure::usage(format!("--security: {e}")))?);
    }
    p.keywords.retain(|k| !remove_keywords.contains(k));
    for k in &f.keywords {
        if !p.keywords.contains(k) {
            p.keywords.push(k.clone());
        }
    }
    Ok(())
}

pub(crate) fn to_editable(slug: &str, p: &Profile) -> Result<String, Failure> {
    let mut body = p.clone();
    body.last_updated = None;
    let toml = toml::to_string_pretty(&body).map_err(Failure::runtime)?;
    Ok(format!(
        "# Editing the `{slug}` profile on your PDS. Save and close to publish the change;\n\
         # empty the file to cancel. `type` must stay \"happyview-plugin\".\n\n{toml}"
    ))
}

pub(crate) fn from_editable(text: &str) -> Result<Profile, String> {
    toml::from_str(text).map_err(|e| e.to_string())
}

fn run_editor(path: &Path) -> Result<(), Failure> {
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "notepad".into()
            } else {
                "vi".into()
            }
        });
    let status = if cfg!(windows) {
        std::process::Command::new(&editor).arg(path).status()
    } else {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("{editor} \"$1\""))
            .arg("sh")
            .arg(path)
            .status()
    }
    .map_err(|e| Failure::runtime(format!("could not start `{editor}`: {e}")))?;
    if !status.success() {
        return Err(Failure::runtime(format!("`{editor}` exited with {status}")));
    }
    Ok(())
}

/// Opens the profile in `$VISUAL`/`$EDITOR` until it is valid or abandoned.
fn edit_in_editor(ctx: &Ctx, slug: &str, profile: &Profile) -> Result<Profile, Failure> {
    let path = std::env::temp_dir().join(format!("hpy-profile-{slug}-{}.toml", std::process::id()));
    std::fs::write(&path, to_editable(slug, profile)?).map_err(Failure::runtime)?;
    let result = loop {
        if let Err(e) = run_editor(&path) {
            break Err(e);
        }
        let text = std::fs::read_to_string(&path).map_err(Failure::runtime)?;
        if text
            .lines()
            .all(|l| l.trim().is_empty() || l.trim_start().starts_with('#'))
        {
            break Err(Failure::runtime("cancelled"));
        }
        let problems = match from_editable(&text) {
            Ok(p) if p.problems().is_empty() => break Ok(p),
            Ok(p) => p
                .problems()
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>(),
            Err(e) => vec![e],
        };
        for p in &problems {
            eprintln!("  • {p}");
        }
        match ctx
            .prompter
            .confirm("The profile is not valid. Edit again?", false)
        {
            Ok(true) => continue,
            Ok(false) => break Err(Failure::runtime("cancelled")),
            Err(e) => break Err(e),
        }
    };
    let _ = std::fs::remove_file(&path);
    result
}

pub async fn edit(ctx: &Ctx, args: ProfileEditArgs) -> Result<(), Failure> {
    let Fetched {
        slug,
        session,
        mut profile,
        cid,
    } = fetch(ctx, args.slug.slug).await?;
    let f = &args.fields;
    let has_flags = f.name.is_some()
        || f.description.is_some()
        || f.license.is_some()
        || !f.authors.is_empty()
        || !f.security.is_empty()
        || !f.keywords.is_empty()
        || !args.remove_keywords.is_empty();

    if has_flags {
        apply_edits(&mut profile, f, &args.remove_keywords)?;
        let problems = profile.problems();
        if !problems.is_empty() {
            return Err(Failure::problems(
                "the edited profile is not valid:",
                &problems,
            ));
        }
    } else if ctx.prompter.is_interactive() {
        profile = edit_in_editor(ctx, &slug, &profile)?;
    } else {
        return Err(Failure::usage(
            "pass field flags (e.g. --name, --license) to edit without a terminal",
        ));
    }

    let result = update(
        &session.registry(),
        &slug,
        profile_record(&profile),
        cid.as_deref(),
    )
    .await?;
    ctx.out.done(
        &format!("Updated {}", result.uri),
        json!({ "uri": result.uri, "cid": result.cid }),
    );
    Ok(())
}

/// Where the author keeps a section in a file, writes the pulled text into
/// that file and keeps pointing at it rather than inlining it.
pub(crate) fn keep_section_files(
    dir: &Path,
    existing: &ProfileConfig,
    pulled: &mut ProfileConfig,
) -> Result<(), Failure> {
    let pairs = [
        (
            &existing.sections.description,
            &mut pulled.sections.description,
        ),
        (
            &existing.sections.installation,
            &mut pulled.sections.installation,
        ),
        (&existing.sections.changelog, &mut pulled.sections.changelog),
        (&existing.sections.security, &mut pulled.sections.security),
    ];
    for (old, new) in pairs {
        if let (Some(SectionSource::Path(path)), Some(SectionSource::Inline { text })) =
            (old, new.as_ref())
        {
            std::fs::write(dir.join(path), text).map_err(Failure::runtime)?;
            *new = Some(SectionSource::Path(path.clone()));
        }
    }
    Ok(())
}

pub async fn pull(ctx: &Ctx, args: SlugArg) -> Result<(), Failure> {
    let Fetched { slug, profile, .. } = fetch(ctx, args.slug).await?;
    let mut cfg = ProfileConfig::from_profile(&slug, &profile);
    if let Some(existing) = HpyToml::load(&ctx.dir)?.and_then(|t| t.profile) {
        keep_section_files(&ctx.dir, &existing, &mut cfg)?;
    }
    config::write_profile(&ctx.dir, &cfg).map_err(Failure::runtime)?;
    let path = ctx.dir.join(config::FILE_NAME);
    ctx.out.done(
        &format!("Wrote the `{slug}` profile to {}", path.display()),
        json!({ "slug": slug, "path": path }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::ProfileFields;
    use hpy_plugin::PROFILE_NSID;
    use hpy_plugin::profile::{Author, Contact, Profile};

    fn profile() -> Profile {
        Profile {
            license: "MIT".into(),
            authors: vec![Author {
                name: "A".into(),
                ..Default::default()
            }],
            security: vec![Contact {
                email: Some("s@x.io".into()),
                url: None,
            }],
            ..Profile::new_plugin()
        }
    }

    #[test]
    fn profile_record_stamps_last_updated() {
        let r = profile_record(&profile());
        assert_eq!(r["license"], "MIT");
        assert_eq!(r["$type"], PROFILE_NSID);
        assert!(r["lastUpdated"].as_str().unwrap().ends_with('Z'));
    }

    #[tokio::test]
    async fn create_profile_validates_then_writes() {
        let reg = crate::testing::FakeRegistry::default();
        let uri = create_profile(&reg, "x", &profile()).await.unwrap();
        assert!(uri.ends_with("/at.happyproto.plugin.profile/x"), "{uri}");
        assert_eq!(
            reg.calls.lock().unwrap().clone(),
            [("profile", true), ("profile", false)]
        );
        assert_eq!(
            reg.published_profiles.lock().unwrap()[0].1["license"],
            "MIT"
        );
    }

    #[test]
    fn apply_edits_adds_and_replaces() {
        let mut p = profile();
        p.keywords = vec!["old".into(), "keep".into()];
        let fields = ProfileFields {
            name: Some("New".into()),
            authors: vec!["B <b@x.io>".into()],
            keywords: vec!["new".into()],
            ..Default::default()
        };
        apply_edits(&mut p, &fields, &["old".to_string()]).unwrap();
        assert_eq!(p.name.as_deref(), Some("New"));
        assert_eq!(p.authors.len(), 2);
        assert_eq!(p.keywords, vec!["keep".to_string(), "new".to_string()]);
    }

    #[test]
    fn slug_resolution_order() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_slug(dir.path(), None).is_err());
        std::fs::write(
            dir.path().join("manifest.json"),
            r#"{"id":"from-manifest"}"#,
        )
        .unwrap();
        assert_eq!(resolve_slug(dir.path(), None).unwrap(), "from-manifest");
        std::fs::write(
            dir.path().join("hpy.toml"),
            "[profile]\nslug = \"from-toml\"\n",
        )
        .unwrap();
        assert_eq!(resolve_slug(dir.path(), None).unwrap(), "from-toml");
        assert_eq!(
            resolve_slug(dir.path(), Some("flag".into())).unwrap(),
            "flag"
        );
        assert!(resolve_slug(dir.path(), Some("bad:slug".into())).is_err());
    }

    #[test]
    fn editor_toml_roundtrip() {
        let p = profile();
        let text = to_editable("x", &p).unwrap();
        assert_eq!(from_editable(&text).unwrap(), p);
        assert!(from_editable("license = 3").is_err());
    }

    #[tokio::test]
    async fn an_edit_writes_through_the_registry_with_the_cid_it_read() {
        let registry = crate::testing::FakeRegistry::default();
        let w = update(&registry, "p", json!({ "name": "P" }), Some("bafyold"))
            .await
            .unwrap();
        assert_eq!(
            w.uri,
            "at://did:plc:testuser/at.happyproto.plugin.profile/p"
        );
        assert_eq!(
            *registry.updated_profiles.lock().unwrap(),
            [(
                "p".to_string(),
                json!({ "name": "P" }),
                Some("bafyold".to_string())
            )]
        );
        let err = update(&registry, "p", json!({}), Some(crate::testing::STALE_CID))
            .await
            .err()
            .unwrap();
        assert!(
            format!("{:?}", err.report).contains("changed on your PDS"),
            "{:?}",
            err.report
        );
    }

    #[test]
    fn a_swap_conflict_says_the_profile_changed() {
        let f = put_error(hpy_atproto::Error::Xrpc {
            method: "com.atproto.repo.putRecord".into(),
            name: "InvalidSwap".into(),
            message: None,
        });
        assert!(
            format!("{:?}", f.report).contains("changed on your PDS"),
            "{:?}",
            f.report
        );
        let f = put_error(hpy_atproto::Error::SessionExpired);
        assert_eq!(f.code, 3);
    }

    #[test]
    fn pull_writes_sections_back_to_their_files() {
        use hpy_plugin::config::{ProfileConfig, SectionSource, SectionsConfig};
        let dir = tempfile::tempdir().unwrap();
        let existing = ProfileConfig {
            sections: SectionsConfig {
                description: Some(SectionSource::Path("README.md".into())),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pulled = ProfileConfig {
            sections: SectionsConfig {
                description: Some(SectionSource::Inline {
                    text: "from the PDS".into(),
                }),
                changelog: Some(SectionSource::Inline {
                    text: "inline stays inline".into(),
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        keep_section_files(dir.path(), &existing, &mut pulled).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("README.md")).unwrap(),
            "from the PDS"
        );
        assert_eq!(
            pulled.sections.description,
            Some(SectionSource::Path("README.md".into()))
        );
        assert_eq!(
            pulled.sections.changelog,
            Some(SectionSource::Inline {
                text: "inline stays inline".into()
            })
        );
    }
}
