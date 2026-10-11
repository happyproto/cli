//! `hpy.toml`: the registry metadata that lives in a plugin's repo beside
//! `manifest.json`. It seeds the profile; once the profile exists on the PDS,
//! the PDS wins.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Problem;
use crate::manifest::Manifest;
use crate::profile::{Author, Contact, Profile, Sections};

pub const FILE_NAME: &str = "hpy.toml";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HpyToml {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<ProfileConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<ReleaseConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProfileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<Author>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security: Vec<Contact>,
    #[serde(default, skip_serializing_if = "SectionsConfig::is_empty")]
    pub sections: SectionsConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<SectionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<SectionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<SectionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<SectionSource>,
}

/// A long-form section: a path to a Markdown file relative to `hpy.toml`, or
/// the text inline (`{ text = "…" }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SectionSource {
    Path(String),
    Inline { text: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReleaseConfig {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub requires: BTreeMap<String, String>,
    #[serde(default)]
    pub artifacts: ArtifactsConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArtifactsConfig {
    #[serde(default)]
    pub icon: Option<ImageConfig>,
    #[serde(default)]
    pub banner: Option<ImageConfig>,
    #[serde(default)]
    pub screenshots: Vec<ImageConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImageConfig {
    pub path: String,
    #[serde(default)]
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BuildConfig {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub wasm: Option<String>,
}

impl SectionsConfig {
    pub fn is_empty(&self) -> bool {
        self.description.is_none()
            && self.installation.is_none()
            && self.changelog.is_none()
            && self.security.is_none()
    }
}

impl HpyToml {
    /// `Ok(None)` when there is no `hpy.toml`.
    pub fn load(dir: &Path) -> Result<Option<HpyToml>, Problem> {
        let path = dir.join(FILE_NAME);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Ok(None);
        };
        toml::from_str(&text)
            .map(Some)
            .map_err(|e| Problem::new(FILE_NAME, format!("is not valid: {e}")))
    }

    /// `[profile] slug`, else the manifest's `id`.
    pub fn slug(&self, manifest: Option<&Manifest>) -> Option<String> {
        self.profile
            .as_ref()
            .and_then(|p| p.slug.clone())
            .or_else(|| manifest.map(|m| m.id.clone()))
    }
}

fn read_section(
    dir: &Path,
    name: &str,
    source: &Option<SectionSource>,
    out: &mut Vec<Problem>,
) -> Option<String> {
    match source {
        None => None,
        Some(SectionSource::Inline { text }) => Some(text.clone()),
        Some(SectionSource::Path(p)) => match std::fs::read_to_string(dir.join(p)) {
            Ok(text) => Some(text),
            Err(e) => {
                out.push(Problem::new(
                    format!("profile.sections.{name}"),
                    format!("cannot read `{p}`: {e}"),
                ));
                None
            }
        },
    }
}

impl ProfileConfig {
    /// The profile this config describes, with manifest `name`/`description`
    /// as defaults, plus every problem with it (including the record's own).
    pub fn to_profile(&self, dir: &Path, manifest: Option<&Manifest>) -> (Profile, Vec<Problem>) {
        let mut problems = Vec::new();
        let s = &self.sections;
        let sections = Sections {
            description: read_section(dir, "description", &s.description, &mut problems),
            installation: read_section(dir, "installation", &s.installation, &mut problems),
            changelog: read_section(dir, "changelog", &s.changelog, &mut problems),
            security: read_section(dir, "security", &s.security, &mut problems),
        };
        let profile = Profile {
            license: self.license.clone().unwrap_or_default(),
            authors: self.authors.clone(),
            security: self.security.clone(),
            name: self
                .name
                .clone()
                .or_else(|| manifest.and_then(|m| m.name.clone())),
            description: self
                .description
                .clone()
                .or_else(|| manifest.and_then(|m| m.description.clone())),
            keywords: self.keywords.clone(),
            sections: (sections != Sections::default()).then_some(sections),
            ..Profile::new_plugin()
        };
        problems.extend(profile.problems());
        (profile, problems)
    }

    pub fn from_profile(slug: &str, profile: &Profile) -> ProfileConfig {
        let inline = |t: &Option<String>| t.clone().map(|text| SectionSource::Inline { text });
        let sections = profile.sections.clone().unwrap_or_default();
        ProfileConfig {
            slug: Some(slug.into()),
            name: profile.name.clone(),
            description: profile.description.clone(),
            license: Some(profile.license.clone()).filter(|l| !l.is_empty()),
            keywords: profile.keywords.clone(),
            authors: profile.authors.clone(),
            security: profile.security.clone(),
            sections: SectionsConfig {
                description: inline(&sections.description),
                installation: inline(&sections.installation),
                changelog: inline(&sections.changelog),
                security: inline(&sections.security),
            },
        }
    }
}

/// Replaces the `[profile]` table of `dir/hpy.toml`, creating the file if
/// needed and leaving every other table and comment alone.
pub fn write_profile(dir: &Path, cfg: &ProfileConfig) -> std::io::Result<()> {
    let invalid = |e: String| std::io::Error::new(std::io::ErrorKind::InvalidData, e);
    let path = dir.join(FILE_NAME);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = existing
        .parse()
        .map_err(|e| invalid(format!("{FILE_NAME}: {e}")))?;
    let table = toml_edit::ser::to_document(cfg).map_err(|e| invalid(e.to_string()))?;
    let mut new = table.as_table().clone();
    // Comments above `[profile]` belong to its header; keep them, and keep
    // the table where the author put it.
    if let Some(old) = doc.get("profile").and_then(|i| i.as_table()) {
        *new.decor_mut() = old.decor().clone();
        new.set_position(old.position());
    }
    doc["profile"] = toml_edit::Item::Table(new);
    std::fs::write(path, doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOML: &str = r#"
# keep me
[profile]
license = "MIT"
keywords = ["atproto"]
authors = [{ name = "Trezy" }]
security = [{ email = "security@happyproto.at" }]

[profile.sections]
description = "README.md"
changelog = { text = "first" }

[release]
repo = "https://github.com/x/y"

[release.requires]
"env:happyview" = ">=3.0.0"

[release.artifacts]
icon = { path = "icon.png", alt = "logo" }

[build]
wasm = "plugin.wasm"
"#;

    #[test]
    fn loads_and_builds_profile_with_manifest_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), TOML).unwrap();
        std::fs::write(dir.path().join("README.md"), "# Hello").unwrap();
        let cfg = HpyToml::load(dir.path()).unwrap().unwrap();
        let manifest = Manifest {
            id: "happyview-atproto".into(),
            name: Some("Atproto".into()),
            description: Some("d".into()),
            ..Default::default()
        };
        assert_eq!(
            cfg.slug(Some(&manifest)).as_deref(),
            Some("happyview-atproto")
        );
        let (profile, problems) = cfg
            .profile
            .as_ref()
            .unwrap()
            .to_profile(dir.path(), Some(&manifest));
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(profile.name.as_deref(), Some("Atproto"));
        let sections = profile.sections.unwrap();
        assert_eq!(sections.description.as_deref(), Some("# Hello"));
        assert_eq!(sections.changelog.as_deref(), Some("first"));
        let release = cfg.release.unwrap();
        assert_eq!(release.requires["env:happyview"], ">=3.0.0");
        assert_eq!(release.artifacts.icon.unwrap().alt.as_deref(), Some("logo"));
        assert_eq!(cfg.build.unwrap().wasm.as_deref(), Some("plugin.wasm"));
    }

    #[test]
    fn missing_section_file_is_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ProfileConfig {
            sections: SectionsConfig {
                description: Some(SectionSource::Path("NOPE.md".into())),
                ..Default::default()
            },
            ..Default::default()
        };
        let (_, problems) = cfg.to_profile(dir.path(), None);
        assert!(
            problems
                .iter()
                .any(|p| p.path == "profile.sections.description")
        );
    }

    #[test]
    fn write_profile_preserves_other_tables_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), TOML).unwrap();
        let mut cfg = HpyToml::load(dir.path()).unwrap().unwrap().profile.unwrap();
        cfg.license = Some("Apache-2.0".into());
        write_profile(dir.path(), &cfg).unwrap();
        let text = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        assert!(text.contains("# keep me"));
        assert!(text.contains("Apache-2.0"));
        assert!(text.contains("[build]"));
        let reloaded = HpyToml::load(dir.path()).unwrap().unwrap();
        assert_eq!(
            reloaded.profile.unwrap().license.as_deref(),
            Some("Apache-2.0")
        );
    }

    #[test]
    fn write_profile_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ProfileConfig {
            slug: Some("x".into()),
            license: Some("MIT".into()),
            ..Default::default()
        };
        write_profile(dir.path(), &cfg).unwrap();
        let loaded = HpyToml::load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.profile.unwrap().slug.as_deref(), Some("x"));
    }

    #[test]
    fn from_profile_inlines_sections() {
        let p = Profile {
            license: "MIT".into(),
            sections: Some(Sections {
                description: Some("long".into()),
                ..Default::default()
            }),
            ..Profile::new_plugin()
        };
        let cfg = ProfileConfig::from_profile("slug", &p);
        assert_eq!(
            cfg.sections.description,
            Some(SectionSource::Inline {
                text: "long".into()
            })
        );
        assert_eq!(cfg.slug.as_deref(), Some("slug"));
    }

    #[test]
    fn malformed_toml_is_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), "[profile\n").unwrap();
        assert_eq!(HpyToml::load(dir.path()).unwrap_err().path, "hpy.toml");
        let empty = tempfile::tempdir().unwrap();
        assert!(HpyToml::load(empty.path()).unwrap().is_none());
    }
}
