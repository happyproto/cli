//! A plugin's `manifest.json`, rebuilt from its registry version. The
//! artifact carries the plugin fields the registry validated, the project its
//! display name, and `requires` what the manifest's `dependencies` would.

use hpy_plugin::Problem;
use hpy_plugin::artifact::PluginArtifact;
use hpy_plugin::validate::{is_project_name, parse_project_uri};
use serde_json::{Value, json};

pub fn wasm_file(id: &str) -> String {
    format!("{id}.wasm")
}

/// What a manifest is rebuilt from: one version of one project.
pub struct Published<'a> {
    pub did: &'a str,
    pub name: &'a str,
    pub version: &'a str,
    pub artifact: &'a PluginArtifact,
    /// The publication's name and description.
    pub display_name: Option<&'a str>,
    pub description: Option<&'a str>,
    /// The `manifest.json` the publisher shipped beside the module.
    pub manifest: &'a Value,
}

/// `requires` entries that name other projects, as `(project URI, range)`.
pub fn project_requirements(artifact: &PluginArtifact) -> Vec<(String, String)> {
    artifact
        .requires
        .iter()
        .filter(|(key, _)| parse_project_uri(key).is_some())
        .map(|(key, range)| (key.clone(), range.clone()))
        .collect()
}

pub fn happyview_requirement(artifact: &PluginArtifact) -> Option<String> {
    artifact.requires.get("env:happyview").cloned()
}

pub fn synthesize(p: &Published<'_>) -> Result<Value, Problem> {
    // The name names a file in the plugin directory, so it has to be the
    // registry's own grammar rather than anything a record happens to carry.
    if !is_project_name(p.name) {
        return Err(Problem::new(
            "name",
            format!("`{}` is not a project name", p.name),
        ));
    }
    let a = p.artifact;
    if a.plugin_type == "interpreter" && a.file_extensions.is_empty() {
        return Err(Problem::new(
            format!("{}@{}", p.name, p.version),
            "declares no file extensions, so no project file can name it; \
             it predates project mode, so pick a later version",
        ));
    }
    // HappyView refuses dependencies on an interpreter or an auth plugin, so
    // only a library carries them.
    let dependencies: Vec<Value> = if a.plugin_type == "library" {
        project_requirements(a)
            .into_iter()
            .filter_map(|(uri, range)| {
                let (_, dep) = parse_project_uri(&uri)?;
                Some(json!({ "id": dep, "version": range }))
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut m = json!({
        "id": p.name,
        "name": p.display_name.unwrap_or(p.name),
        "version": p.version,
        "api_version": a.api_version,
        "plugin_type": a.plugin_type,
        "capabilities": a.capabilities,
        "allowed_hosts": a.allowed_hosts,
        "dependencies": dependencies,
        "publisher": p.did,
        "wasm_file": wasm_file(p.name),
    });
    if let Some(d) = p.description {
        m["description"] = d.into();
    }
    if let Some(ns) = &a.namespace {
        m["namespace"] = ns.clone().into();
    }
    if let Some(lang) = &a.language_id {
        m["language_id"] = lang.clone().into();
        m["monaco_language"] = lang.clone().into();
    }
    if let Some(first) = a.file_extensions.first() {
        m["file_extension"] = first.clone().into();
        m["extensions"] = json!(a.file_extensions);
    }
    // The artifact carries everything HappyView reads except an
    // interpreter's `supports_libraries`, which only the shipped manifest
    // does. Left out, HappyView reads `["*"]`.
    if let Some(libraries) = p.manifest.get("supports_libraries") {
        m["supports_libraries"] = libraries.clone();
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hpy_plugin::artifact::{PluginArtifact, Sections};
    use serde_json::json;

    const DID: &str = "did:plc:abc";

    fn artifact(fields: Value, requires: Value) -> PluginArtifact {
        let mut value = json!({
            "$type": "at.happyproto.plugin.v1",
            "package": { "$type": "blob", "ref": { "$link": "bafkreipkg" }, "mimeType": "application/wasm", "size": 1 },
            "manifest": { "$type": "blob", "ref": { "$link": "bafkreiman" }, "mimeType": "application/json", "size": 1 },
            "capabilities": [],
            "license": "MIT",
            "sections": { "description": "d" },
            "requires": requires,
        });
        for (k, v) in fields.as_object().unwrap() {
            value[k] = v.clone();
        }
        PluginArtifact::from_value(&value).unwrap()
    }

    fn published<'a>(
        name: &'a str,
        artifact: &'a PluginArtifact,
        manifest: &'a Value,
    ) -> Published<'a> {
        Published {
            did: DID,
            name,
            version: "1.4.2",
            artifact,
            display_name: None,
            description: None,
            manifest,
        }
    }

    #[test]
    fn an_interpreter_manifest_carries_its_language_and_extensions() {
        let a = artifact(
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua",
                    "fileExtensions": ["lua"],
                    "capabilities": ["library:call", "script:host"] }),
            json!({ "env:happyview": ">=3.0.0" }),
        );
        let m = synthesize(&Published {
            display_name: Some("Lua"),
            description: Some("Lua 5.4 for HappyView scripts."),
            ..published("happyview-lua", &a, &json!({}))
        })
        .unwrap();
        assert_eq!(
            m,
            json!({
                "id": "happyview-lua", "name": "Lua", "version": "1.4.2",
                "description": "Lua 5.4 for HappyView scripts.",
                "api_version": "2", "plugin_type": "interpreter",
                "language_id": "lua", "monaco_language": "lua",
                "extensions": ["lua"], "file_extension": "lua",
                "capabilities": ["library:call", "script:host"], "allowed_hosts": [],
                "dependencies": [], "publisher": "did:plc:abc",
                "wasm_file": "happyview-lua.wasm"
            })
        );
    }

    #[test]
    fn a_library_manifest_has_the_exact_shape_happyview_loads() {
        let a = artifact(
            json!({ "pluginType": "library", "apiVersion": "2", "namespace": "happyview.record",
                    "capabilities": ["records:read"], "allowedHosts": ["api.example.com"] }),
            json!({
                "env:happyview": ">=3.0.0",
                "at://did:plc:abc/software.release.project/happyview-db": "^0.1"
            }),
        );
        let m = synthesize(&published("happyview-record", &a, &json!({}))).unwrap();
        assert_eq!(
            m,
            json!({
                "id": "happyview-record", "name": "happyview-record", "version": "1.4.2",
                "api_version": "2", "plugin_type": "library",
                "namespace": "happyview.record",
                "capabilities": ["records:read"], "allowed_hosts": ["api.example.com"],
                "dependencies": [{ "id": "happyview-db", "version": "^0.1" }],
                "publisher": "did:plc:abc", "wasm_file": "happyview-record.wasm"
            })
        );
    }

    #[test]
    fn only_a_library_carries_dependencies() {
        let a = artifact(
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua",
                    "fileExtensions": ["lua"] }),
            json!({ "at://did:plc:abc/software.release.project/happyview-db": "^0.1" }),
        );
        let m = synthesize(&published("happyview-lua", &a, &json!({}))).unwrap();
        assert_eq!(m["dependencies"], json!([]));
    }

    #[test]
    fn the_published_manifest_supplies_the_library_list() {
        let a = artifact(
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua",
                    "fileExtensions": ["lua"] }),
            json!({}),
        );
        let shipped =
            json!({ "supports_libraries": ["happyview.http"], "capabilities": ["everything"] });
        let m = synthesize(&published("happyview-lua", &a, &shipped)).unwrap();
        assert_eq!(m["supports_libraries"], json!(["happyview.http"]));
        // Everything else comes from the artifact the registry validated.
        assert_eq!(m["capabilities"], json!([]));
    }

    #[test]
    fn an_interpreter_without_file_extensions_is_refused() {
        let a = artifact(
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua" }),
            json!({}),
        );
        let err = synthesize(&published("happyview-lua", &a, &json!({}))).unwrap_err();
        assert!(err.message.contains("no file extensions"), "{err}");
    }

    #[test]
    fn requires_splits_into_projects_and_happyview() {
        let a = artifact(
            json!({ "pluginType": "library", "apiVersion": "2", "namespace": "x" }),
            json!({
                "env:happyview": ">=3.0.0",
                "env:other": "1",
                "at://did:plc:abc/software.release.project/happyview-db": "^0.1"
            }),
        );
        assert_eq!(
            project_requirements(&a),
            [(
                "at://did:plc:abc/software.release.project/happyview-db".to_string(),
                "^0.1".to_string()
            )]
        );
        assert_eq!(happyview_requirement(&a).as_deref(), Some(">=3.0.0"));
    }

    #[test]
    fn a_name_that_could_leave_the_plugin_directory_is_refused() {
        let a = artifact(
            json!({ "pluginType": "library", "apiVersion": "2", "namespace": "x" }),
            json!({}),
        );
        for name in ["../evil", "a/b", "a\\b", "..", ".hidden", ""] {
            let err = synthesize(&published(name, &a, &json!({}))).unwrap_err();
            assert!(err.message.contains("not a project name"), "{name}: {err}");
        }
    }

    // Pins the round trip against the real interpreter manifest: publishing it
    // yields this artifact, and rebuilding from that must give the manifest
    // back. A field HappyView needs that neither the artifact nor the shipped
    // manifest carries shows up here as a difference.
    #[test]
    fn the_real_lua_manifest_survives_a_publish_and_rebuild() {
        let text = include_str!("../tests/fixtures/happyview-lua-manifest.json");
        let original: Value = serde_json::from_str(text).unwrap();
        let parsed: hpy_plugin::manifest::Manifest = serde_json::from_str(text).unwrap();
        assert!(parsed.problems().is_empty());
        let a = PluginArtifact::from_manifest(
            &parsed,
            json!({}),
            json!({}),
            "MIT".into(),
            Sections::default(),
        );
        let mut rebuilt = synthesize(&Published {
            did: DID,
            name: "happyview-lua",
            version: original["version"].as_str().unwrap(),
            artifact: &a,
            display_name: original["name"].as_str(),
            description: original["description"].as_str(),
            manifest: &original,
        })
        .unwrap();
        assert_eq!(rebuilt["publisher"], "did:plc:abc");
        rebuilt.as_object_mut().unwrap().remove("publisher");
        assert_eq!(rebuilt, original);
    }
}
