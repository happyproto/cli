//! `at.happyproto.plugin.release`: one immutable version of a package.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::checksum::{checksum, raw_cid};
use crate::manifest::ReleaseExtension;
use crate::validate::{range_problem, requires_key_problem};
use crate::{EXTENSION_NSID, Problem, RELEASE_NSID};

pub fn release_rkey(slug: &str, version: &str) -> String {
    format!("{slug}:{version}")
}

/// The blob ref a PDS will answer an upload of these bytes with. Building the
/// record from it before uploading lets `--dry-run` show the exact record,
/// and the upload is then checked against it.
pub fn predicted_blob(bytes: &[u8], mime: &str) -> Value {
    json!({
        "$type": "blob",
        "ref": { "$link": raw_cid(bytes) },
        "mimeType": mime,
        "size": bytes.len(),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Artifact {
    pub blob: Option<Value>,
    pub url: Option<String>,
    pub checksum: String,
    pub content_type: String,
}

impl Artifact {
    pub fn from_bytes(bytes: &[u8], mime: &str) -> Artifact {
        Artifact {
            blob: Some(predicted_blob(bytes, mime)),
            url: None,
            checksum: checksum(bytes),
            content_type: mime.into(),
        }
    }

    fn to_value(&self) -> Map<String, Value> {
        let mut m = Map::new();
        if let Some(b) = &self.blob {
            m.insert("blob".into(), b.clone());
        }
        if let Some(u) = &self.url {
            m.insert("url".into(), u.clone().into());
        }
        m.insert("checksum".into(), self.checksum.clone().into());
        m.insert("contentType".into(), self.content_type.clone().into());
        m
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageArtifact {
    pub artifact: Artifact,
    pub width: u32,
    pub height: u32,
    pub alt: Option<String>,
}

impl ImageArtifact {
    fn to_value(&self) -> Value {
        let mut m = self.artifact.to_value();
        m.insert("width".into(), self.width.into());
        m.insert("height".into(), self.height.into());
        if let Some(alt) = &self.alt {
            m.insert("alt".into(), alt.clone().into());
        }
        Value::Object(m)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub slug: String,
    pub version: String,
    pub repo: Option<String>,
    pub requires: BTreeMap<String, String>,
    pub extension: ReleaseExtension,
    pub package: Artifact,
    pub icon: Option<ImageArtifact>,
    pub banner: Option<ImageArtifact>,
    pub screenshots: Vec<ImageArtifact>,
}

impl Release {
    /// What the release lexicon would refuse beyond the manifest and
    /// `requires`: a repo that is not a URI, alt text over its limit.
    pub fn problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        if let Some(repo) = &self.repo
            && !crate::profile::looks_like_uri(repo)
        {
            out.push(Problem::new(
                "release.repo",
                format!("`{repo}` is not a URI"),
            ));
        }
        let images = self
            .icon
            .iter()
            .map(|i| ("release.artifacts.icon".to_string(), i))
            .chain(
                self.banner
                    .iter()
                    .map(|i| ("release.artifacts.banner".to_string(), i)),
            )
            .chain(
                self.screenshots
                    .iter()
                    .enumerate()
                    .map(|(n, i)| (format!("release.artifacts.screenshots[{n}]"), i)),
            );
        for (path, image) in images {
            if let Some(alt) = &image.alt {
                crate::profile::too_long(&mut out, &format!("{path}.alt"), alt, 300, 3000);
            }
        }
        out
    }

    pub fn rkey(&self) -> String {
        release_rkey(&self.slug, &self.version)
    }

    pub fn to_record(&self) -> Value {
        let mut artifacts = Map::new();
        artifacts.insert("package".into(), Value::Object(self.package.to_value()));
        if let Some(i) = &self.icon {
            artifacts.insert("icon".into(), i.to_value());
        }
        if let Some(b) = &self.banner {
            artifacts.insert("banner".into(), b.to_value());
        }
        if !self.screenshots.is_empty() {
            artifacts.insert(
                "screenshots".into(),
                self.screenshots
                    .iter()
                    .map(ImageArtifact::to_value)
                    .collect(),
            );
        }
        let mut record = json!({
            "$type": RELEASE_NSID,
            "package": self.slug,
            "version": self.version,
            "artifacts": artifacts,
            "extensions": { EXTENSION_NSID: self.extension },
        });
        if !self.requires.is_empty() {
            record["requires"] = json!(self.requires);
        }
        if let Some(repo) = &self.repo {
            record["repo"] = repo.clone().into();
        }
        record
    }
}

pub fn requires_problems(requires: &BTreeMap<String, String>) -> Vec<Problem> {
    let mut out = Vec::new();
    for (key, range) in requires {
        let path = format!("release.requires[{key:?}]");
        if let Some(p) = requires_key_problem(key) {
            out.push(Problem::new(&path, p));
        }
        if let Some(p) = range_problem(range) {
            out.push(Problem::new(&path, p));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::ReleaseExtension;

    fn ext() -> ReleaseExtension {
        ReleaseExtension {
            plugin_type: "library".into(),
            api_version: "2".into(),
            namespace: Some("x.y".into()),
            language_id: None,
            capabilities: vec![],
            allowed_hosts: vec![],
        }
    }

    #[test]
    fn builds_record() {
        let wasm = b"\0asm\x01\0\0\0";
        let release = Release {
            slug: "x".into(),
            version: "1.0.0".into(),
            repo: Some("https://github.com/x/y".into()),
            requires: [("env:happyview".to_string(), ">=3".to_string())].into(),
            extension: ext(),
            package: Artifact::from_bytes(wasm, "application/wasm"),
            icon: None,
            banner: None,
            screenshots: vec![],
        };
        let r = release.to_record();
        assert_eq!(r["$type"], "at.happyproto.plugin.release");
        assert_eq!(r["package"], "x");
        assert_eq!(r["version"], "1.0.0");
        assert_eq!(r["requires"]["env:happyview"], ">=3");
        assert_eq!(
            r["extensions"]["at.happyproto.plugin.releaseExtension"]["pluginType"],
            "library"
        );
        let pkg = &r["artifacts"]["package"];
        assert_eq!(
            pkg["checksum"],
            "bciqjhjclxolmoujbrzgabvdz4taugwasfi4jvtfbmic3dzgq3rpzi5q"
        );
        assert_eq!(pkg["blob"]["$type"], "blob");
        assert_eq!(
            pkg["blob"]["ref"]["$link"],
            "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy"
        );
        assert_eq!(pkg["blob"]["mimeType"], "application/wasm");
        assert_eq!(pkg["blob"]["size"], 8);
        assert!(r["artifacts"].get("icon").is_none());
        assert!(r["artifacts"].get("screenshots").is_none());
        assert_eq!(release_rkey("x", "1.0.0"), "x:1.0.0");
    }

    #[test]
    fn requires_validation_collects_all() {
        let map = [
            ("env:happyview".to_string(), "^1 || ^2".to_string()),
            ("nope".to_string(), ">=1".to_string()),
        ]
        .into();
        let problems = requires_problems(&map);
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(
            problems
                .iter()
                .any(|p| p.path == "release.requires[\"env:happyview\"]")
        );
    }

    #[test]
    fn repo_must_be_a_uri_and_alt_text_has_a_limit() {
        let wasm = b"\0asm\x01\0\0\0";
        let image = ImageArtifact {
            artifact: Artifact::from_bytes(b"png", "image/png"),
            width: 1,
            height: 1,
            alt: Some("a".repeat(301)),
        };
        let release = Release {
            slug: "x".into(),
            version: "1.0.0".into(),
            repo: Some("not a uri".into()),
            requires: Default::default(),
            extension: ext(),
            package: Artifact::from_bytes(wasm, "application/wasm"),
            icon: Some(image),
            banner: None,
            screenshots: vec![],
        };
        let paths: Vec<_> = release.problems().into_iter().map(|p| p.path).collect();
        assert_eq!(paths, ["release.repo", "release.artifacts.icon.alt"]);
    }
}
