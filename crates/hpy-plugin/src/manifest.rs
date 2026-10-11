//! `manifest.json`, the file HappyView's loader reads, and its image in a
//! release: `extensions["at.happyproto.plugin.releaseExtension"]`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Problem;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Manifest {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub api_version: Option<String>,
    #[serde(default)]
    pub plugin_type: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub language_id: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub wasm_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseExtension {
    pub plugin_type: String,
    pub api_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language_id: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_hosts: Vec<String>,
}

const PLUGIN_TYPES: [&str; 3] = ["auth", "library", "interpreter"];

impl Manifest {
    pub fn load(dir: &Path) -> Result<Manifest, Problem> {
        let path = dir.join("manifest.json");
        let text = std::fs::read_to_string(&path).map_err(|_| {
            Problem::new(
                "manifest.json",
                format!("no manifest.json in {}", dir.display()),
            )
        })?;
        serde_json::from_str(&text)
            .map_err(|e| Problem::new("manifest.json", format!("is not valid: {e}")))
    }

    /// Everything the registry would refuse in the manifest half of a release.
    pub fn extension_problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        match self.plugin_type.as_deref() {
            Some(t) if PLUGIN_TYPES.contains(&t) => {}
            other => out.push(Problem::new(
                "manifest.plugin_type",
                format!("must be auth, library or interpreter (got {other:?})"),
            )),
        }
        let major = self
            .api_version
            .as_deref()
            .and_then(|v| v.split('.').next())
            .and_then(|m| m.parse::<u32>().ok());
        if !matches!(major, Some(m) if m >= 2) {
            out.push(Problem::new(
                "manifest.api_version",
                "must be \"2\" or later",
            ));
        }
        // The lexicon's length limits (releaseExtension.json).
        let max = |out: &mut Vec<Problem>, path: String, value: &str, limit: usize| {
            if value.len() > limit {
                out.push(Problem::new(
                    path,
                    format!("is longer than {limit} characters"),
                ));
            }
        };
        if let Some(v) = &self.api_version {
            max(&mut out, "manifest.api_version".into(), v, 16);
        }
        if let Some(ns) = &self.namespace {
            max(&mut out, "manifest.namespace".into(), ns, 256);
        }
        for (i, c) in self.capabilities.iter().flatten().enumerate() {
            max(&mut out, format!("manifest.capabilities[{i}]"), c, 128);
        }
        for (i, h) in self.allowed_hosts.iter().enumerate() {
            max(&mut out, format!("manifest.allowed_hosts[{i}]"), h, 256);
        }
        if self.capabilities.is_none() {
            out.push(Problem::new(
                "manifest.capabilities",
                "must be declared, even when empty",
            ));
        }
        if self.plugin_type.as_deref() == Some("library") && self.namespace.is_none() {
            out.push(Problem::new(
                "manifest.namespace",
                "a library must declare its namespace",
            ));
        }
        if self.plugin_type.as_deref() == Some("interpreter") {
            match self.language_id.as_deref() {
                None => out.push(Problem::new(
                    "manifest.language_id",
                    "an interpreter must declare its language_id",
                )),
                Some(id) if !is_language_id(id) => out.push(Problem::new(
                    "manifest.language_id",
                    "must be lowercase letters, digits, `-` or `_`, starting with a letter",
                )),
                Some(_) => {}
            }
        }
        out
    }

    /// The release extension. Call after `extension_problems` is empty.
    pub fn extension(&self) -> ReleaseExtension {
        ReleaseExtension {
            plugin_type: self.plugin_type.clone().unwrap_or_default(),
            api_version: self.api_version.clone().unwrap_or_default(),
            namespace: self.namespace.clone(),
            language_id: self.language_id.clone(),
            capabilities: self.capabilities.clone().unwrap_or_default(),
            allowed_hosts: self.allowed_hosts.clone(),
        }
    }
}

fn is_language_id(s: &str) -> bool {
    s.len() <= 64
        && s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(json: &str) -> Manifest {
        serde_json::from_str(json).unwrap()
    }

    const ATPROTO: &str = r#"{
      "id": "happyview-atproto", "name": "Atproto", "version": "0.1.0",
      "api_version": "2", "plugin_type": "library", "namespace": "happyview.atproto",
      "description": "AT Protocol helpers.", "capabilities": ["atproto:read", "attest:sign"],
      "allowed_hosts": [], "dependencies": [], "wasm_file": "happyview-atproto.wasm"
    }"#;

    #[test]
    fn maps_to_extension() {
        let m = manifest(ATPROTO);
        assert!(m.extension_problems().is_empty());
        let ext = serde_json::to_value(m.extension()).unwrap();
        assert_eq!(
            ext,
            serde_json::json!({
                "pluginType": "library", "apiVersion": "2", "namespace": "happyview.atproto",
                "capabilities": ["atproto:read", "attest:sign"]
            })
        );
    }

    #[test]
    fn interpreter_needs_language_id() {
        let m = manifest(
            r#"{"id":"x","api_version":"2","plugin_type":"interpreter","capabilities":[]}"#,
        );
        let problems = m.extension_problems();
        assert!(
            problems.iter().any(|p| p.path == "manifest.language_id"),
            "{problems:?}"
        );
    }

    #[test]
    fn rejects_old_api_and_unknown_type_and_missing_capabilities() {
        let m = manifest(r#"{"id":"x","api_version":"1","plugin_type":"theme"}"#);
        let paths: Vec<_> = m.extension_problems().into_iter().map(|p| p.path).collect();
        assert!(paths.contains(&"manifest.api_version".to_string()));
        assert!(paths.contains(&"manifest.plugin_type".to_string()));
        assert!(paths.contains(&"manifest.capabilities".to_string()));
    }

    #[test]
    fn language_id_shape() {
        let m = manifest(
            r#"{"id":"x","api_version":"2","plugin_type":"interpreter","language_id":"Lua","capabilities":[]}"#,
        );
        assert!(
            m.extension_problems()
                .iter()
                .any(|p| p.path == "manifest.language_id")
        );
    }

    #[test]
    fn load_reports_missing_and_malformed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            Manifest::load(dir.path())
                .unwrap_err()
                .message
                .contains("no manifest.json")
        );
        std::fs::write(dir.path().join("manifest.json"), "{").unwrap();
        assert!(
            Manifest::load(dir.path())
                .unwrap_err()
                .message
                .contains("not valid")
        );
        std::fs::write(dir.path().join("manifest.json"), ATPROTO).unwrap();
        assert_eq!(Manifest::load(dir.path()).unwrap().id, "happyview-atproto");
    }

    #[test]
    fn lexicon_length_limits() {
        let long = |n: usize| "x".repeat(n);
        let m = Manifest {
            id: "x".into(),
            api_version: Some(format!("2{}", long(16))),
            plugin_type: Some("library".into()),
            namespace: Some(long(257)),
            capabilities: Some(vec![long(129)]),
            allowed_hosts: vec![long(257)],
            ..Default::default()
        };
        let paths: Vec<_> = m.extension_problems().into_iter().map(|p| p.path).collect();
        for want in [
            "manifest.api_version",
            "manifest.namespace",
            "manifest.capabilities[0]",
            "manifest.allowed_hosts[0]",
        ] {
            assert!(
                paths.contains(&want.to_string()),
                "{want} missing from {paths:?}"
            );
        }
    }
}
