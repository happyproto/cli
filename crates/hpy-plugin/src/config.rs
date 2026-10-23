//! `hpy.toml`: the registry metadata that lives in a plugin's repo beside
//! `manifest.json`. `[project]` describes the plugin as a whole (its
//! publication and sidecar), `[release]` what each published version carries.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Problem;
use crate::artifact::Sections;
use crate::changelog::changelog_entry;
use crate::manifest::Manifest;
use crate::project::{Author, Contact, ProjectDetails, PublicationInput};

pub const FILE_NAME: &str = "hpy.toml";

/// A table that an older `hpy` wrote and this one cannot map field for field,
/// since its fields now split between `[project]` and `[release]`.
const RETIRED_PROFILE: &str = "uses [profile], which the software.release registry replaced; move its fields to [project] and [release] (see hpy's README)";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HpyToml {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<ReleaseConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectConfig {
    /// The project name; the manifest's `id` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The publication's name; the manifest's `name` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// The publication's description; the manifest's when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<ImageConfig>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<Author>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security: Vec<Contact>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReleaseConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// A Markdown file whose entry for the version being published becomes
    /// that version's changelog document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub requires: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "SectionsConfig::is_empty")]
    pub sections: SectionsConfig,
    #[serde(default)]
    pub artifacts: ArtifactsConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<SectionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<SectionSource>,
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

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ArtifactsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banner: Option<ImageConfig>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshots: Vec<ImageConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ImageConfig {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
        self.description.is_none() && self.installation.is_none() && self.security.is_none()
    }
}

impl HpyToml {
    /// `Ok(None)` when there is no `hpy.toml`.
    pub fn load(dir: &Path) -> Result<Option<HpyToml>, Problem> {
        let path = dir.join(FILE_NAME);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Ok(None);
        };
        let invalid = |e: toml::de::Error| Problem::new(FILE_NAME, format!("is not valid: {e}"));
        let table: toml::Table = toml::from_str(&text).map_err(invalid)?;
        // Ignoring it would publish without the license, authors and
        // sections it holds, so it is refused until moved.
        if table.contains_key("profile") {
            return Err(Problem::new(FILE_NAME, RETIRED_PROFILE));
        }
        // The icon now belongs to the project, not each release; ignoring
        // it here would publish a plugin without one.
        if table
            .get("release")
            .and_then(|r| r.get("artifacts"))
            .and_then(|a| a.get("icon"))
            .is_some()
        {
            return Err(Problem::new(
                "release.artifacts.icon",
                "moved to [project] icon, since the icon belongs to the plugin rather than a release",
            ));
        }
        table.try_into().map(Some).map_err(invalid)
    }

    /// `[project] name`, else the manifest's `id`.
    pub fn name(&self, manifest: Option<&Manifest>) -> Option<String> {
        self.project
            .as_ref()
            .and_then(|p| p.name.clone())
            .or_else(|| manifest.map(|m| m.id.clone()))
    }
}

impl ProjectConfig {
    /// What `putProject` sends for this config, with the manifest's `name`,
    /// `description` and `plugin_type` filling in. `icon` is the blob of
    /// `self.icon`'s file, which the caller reads and uploads. Check the
    /// result with `ProjectDetails::problems`.
    pub fn to_details(
        &self,
        name: &str,
        manifest: Option<&Manifest>,
        icon: Option<Value>,
    ) -> ProjectDetails {
        ProjectDetails {
            name: name.into(),
            publication: PublicationInput {
                name: self
                    .display_name
                    .clone()
                    .or_else(|| manifest.and_then(|m| m.name.clone()))
                    .unwrap_or_default(),
                description: self
                    .description
                    .clone()
                    .or_else(|| manifest.and_then(|m| m.description.clone())),
                icon,
            },
            plugin_type: manifest
                .and_then(|m| m.plugin_type.clone())
                .unwrap_or_default(),
            keywords: self.keywords.clone(),
            authors: self.authors.clone(),
            security: self.security.clone(),
        }
    }
}

impl ReleaseConfig {
    /// The artifact's sections, read from their files, plus a problem for
    /// each file that cannot be read. A missing description is left empty
    /// for `PluginArtifact::problems` to report.
    pub fn sections(&self, dir: &Path) -> (Sections, Vec<Problem>) {
        let mut problems = Vec::new();
        let s = &self.sections;
        let sections = Sections {
            description: read_section(dir, "description", &s.description, &mut problems)
                .unwrap_or_default(),
            installation: read_section(dir, "installation", &s.installation, &mut problems),
            security: read_section(dir, "security", &s.security, &mut problems),
        };
        (sections, problems)
    }

    /// The changelog entry for `version`, or `None` when no changelog is
    /// configured or it has no entry for that version.
    pub fn changelog(&self, dir: &Path, version: &str) -> Result<Option<String>, Problem> {
        let Some(path) = &self.changelog else {
            return Ok(None);
        };
        let text = std::fs::read_to_string(dir.join(path))
            .map_err(|e| Problem::new("release.changelog", format!("cannot read `{path}`: {e}")))?;
        Ok(changelog_entry(&text, version))
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
                    format!("release.sections.{name}"),
                    format!("cannot read `{p}`: {e}"),
                ));
                None
            }
        },
    }
}

/// Replaces the `[project]` table of `dir/hpy.toml`, creating the file if
/// needed and leaving every other table and comment alone.
pub fn write_project(dir: &Path, cfg: &ProjectConfig) -> std::io::Result<()> {
    let invalid = |e: String| std::io::Error::new(std::io::ErrorKind::InvalidData, e);
    let path = dir.join(FILE_NAME);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = existing
        .parse()
        .map_err(|e| invalid(format!("{FILE_NAME}: {e}")))?;
    let table = toml_edit::ser::to_document(cfg).map_err(|e| invalid(e.to_string()))?;
    let mut new = table.as_table().clone();
    // Comments above `[project]` belong to its header; keep them, and keep
    // the table where the author put it.
    if let Some(old) = doc.get("project").and_then(|i| i.as_table()) {
        *new.decor_mut() = old.decor().clone();
        new.set_position(old.position());
    }
    doc["project"] = toml_edit::Item::Table(new);
    std::fs::write(path, doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::predicted_blob;

    const TOML: &str = r#"
# keep me
[project]
display_name = "Lua"
icon = { path = "icon.png", alt = "the Lua logo" }
keywords = ["lua"]
authors = [{ name = "Trezy", email = "tre@trezy.com" }]
security = [{ url = "https://github.com/happyproto/plugins/security" }]

[release]
license = "MIT"
changelog = "CHANGELOG.md"

[release.requires]
"env:happyview" = ">=3.0.0"

[release.sections]
description = "DESCRIPTION.md"
installation = { text = "hpy add happyview-lua" }

[release.artifacts]
banner = { path = "banner.png", alt = "a banner" }
screenshots = [{ path = "shot.png" }]

[build]
wasm = "plugin.wasm"
"#;

    const CHANGELOG: &str = "## [1.1.0](https://example.com/v1.1.0) (2026-10-10)\n\n- **Async.** Calls run together.\n\n## [1.0.0](https://example.com/v1.0.0) (2026-10-07)\n\n- First.\n";

    fn lua_manifest() -> Manifest {
        Manifest {
            id: "happyview-lua".into(),
            name: Some("Lua (manifest)".into()),
            description: Some("Lua scripts.".into()),
            plugin_type: Some("interpreter".into()),
            ..Default::default()
        }
    }

    fn load(text: &str) -> (tempfile::TempDir, HpyToml) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), text).unwrap();
        let cfg = HpyToml::load(dir.path()).unwrap().unwrap();
        (dir, cfg)
    }

    #[test]
    fn loads_the_project_table_with_manifest_defaults() {
        let (_dir, cfg) = load(TOML);
        let manifest = lua_manifest();
        assert_eq!(cfg.name(Some(&manifest)).as_deref(), Some("happyview-lua"));
        let project = cfg.project.as_ref().unwrap();
        let icon = project.icon.as_ref().unwrap();
        assert_eq!(
            (icon.path.as_str(), icon.alt.as_deref()),
            ("icon.png", Some("the Lua logo"))
        );
        let blob = predicted_blob(b"png", "image/png");
        let details = project.to_details("happyview-lua", Some(&manifest), Some(blob.clone()));
        assert_eq!(details.name, "happyview-lua");
        assert_eq!(details.publication.name, "Lua");
        // the manifest's description, since hpy.toml gives none
        assert_eq!(
            details.publication.description.as_deref(),
            Some("Lua scripts.")
        );
        assert_eq!(details.publication.icon, Some(blob));
        assert_eq!(details.plugin_type, "interpreter");
        assert_eq!(details.keywords, ["lua"]);
        assert_eq!(details.authors[0].name, "Trezy");
        assert_eq!(details.problems(), vec![]);
    }

    #[test]
    fn project_name_and_display_name_can_be_set() {
        let (_dir, cfg) = load("[project]\nname = \"lua\"\n");
        let manifest = lua_manifest();
        assert_eq!(cfg.name(Some(&manifest)).as_deref(), Some("lua"));
        let details = cfg
            .project
            .unwrap()
            .to_details("lua", Some(&manifest), None);
        assert_eq!(details.publication.name, "Lua (manifest)");
        assert_eq!(details.publication.icon, None);
    }

    #[test]
    fn loads_the_release_table() {
        let (dir, cfg) = load(TOML);
        std::fs::write(dir.path().join("DESCRIPTION.md"), "# Lua").unwrap();
        let release = cfg.release.as_ref().unwrap();
        assert_eq!(release.license.as_deref(), Some("MIT"));
        assert_eq!(release.requires["env:happyview"], ">=3.0.0");
        let (sections, problems) = release.sections(dir.path());
        assert_eq!(problems, vec![]);
        assert_eq!(
            sections,
            Sections {
                description: "# Lua".into(),
                installation: Some("hpy add happyview-lua".into()),
                security: None,
            }
        );
        let banner = release.artifacts.banner.as_ref().unwrap();
        assert_eq!(banner.alt.as_deref(), Some("a banner"));
        assert_eq!(release.artifacts.screenshots[0].path, "shot.png");
        assert_eq!(cfg.build.unwrap().wasm.as_deref(), Some("plugin.wasm"));
    }

    #[test]
    fn a_missing_section_file_is_a_problem() {
        let (dir, cfg) = load(TOML);
        let (sections, problems) = cfg.release.unwrap().sections(dir.path());
        assert_eq!(sections.description, "");
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].path, "release.sections.description");
    }

    #[test]
    fn the_changelog_entry_for_a_version_is_read() {
        let (dir, cfg) = load(TOML);
        std::fs::write(dir.path().join("CHANGELOG.md"), CHANGELOG).unwrap();
        let release = cfg.release.unwrap();
        assert_eq!(
            release.changelog(dir.path(), "1.1.0").unwrap().as_deref(),
            Some("- **Async.** Calls run together.")
        );
        assert_eq!(release.changelog(dir.path(), "2.0.0").unwrap(), None);
        assert_eq!(
            ReleaseConfig::default()
                .changelog(dir.path(), "1.1.0")
                .unwrap(),
            None
        );
    }

    #[test]
    fn an_unreadable_changelog_is_a_problem() {
        let (dir, cfg) = load(TOML);
        let err = cfg
            .release
            .unwrap()
            .changelog(dir.path(), "1.1.0")
            .unwrap_err();
        assert_eq!(err.path, "release.changelog");
    }

    #[test]
    fn a_profile_table_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("hpy.toml"),
            "[profile]\nlicense = \"MIT\"\n",
        )
        .unwrap();
        let err = HpyToml::load(dir.path()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "hpy.toml: uses [profile], which the software.release registry replaced; move its fields to [project] and [release] (see hpy's README)"
        );
    }

    #[test]
    fn a_release_icon_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("hpy.toml"),
            "[release.artifacts]\nicon = { path = \"icon.png\" }\n",
        )
        .unwrap();
        let err = HpyToml::load(dir.path()).unwrap_err();
        assert_eq!(err.path, "release.artifacts.icon");
        assert!(err.message.contains("[project] icon"), "{err}");
    }

    #[test]
    fn write_project_preserves_other_tables_and_comments() {
        let (dir, cfg) = load(TOML);
        let mut project = cfg.project.unwrap();
        project.display_name = Some("Lua 5.4".into());
        write_project(dir.path(), &project).unwrap();
        let text = std::fs::read_to_string(dir.path().join("hpy.toml")).unwrap();
        assert!(text.contains("# keep me"), "{text}");
        assert!(text.contains("[build]"), "{text}");
        let reloaded = HpyToml::load(dir.path()).unwrap().unwrap();
        assert_eq!(
            reloaded.project.unwrap().display_name.as_deref(),
            Some("Lua 5.4")
        );
        assert_eq!(reloaded.release.unwrap().license.as_deref(), Some("MIT"));
    }

    #[test]
    fn write_project_creates_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let project = ProjectConfig {
            name: Some("x".into()),
            ..Default::default()
        };
        write_project(dir.path(), &project).unwrap();
        let loaded = HpyToml::load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.project.unwrap().name.as_deref(), Some("x"));
    }

    #[test]
    fn malformed_toml_is_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hpy.toml"), "[project\n").unwrap();
        assert_eq!(HpyToml::load(dir.path()).unwrap_err().path, "hpy.toml");
        let empty = tempfile::tempdir().unwrap();
        assert!(HpyToml::load(empty.path()).unwrap().is_none());
    }
}
