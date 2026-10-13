//! A plugin's `manifest.json`, rebuilt from its registry release. The release
//! extension is the manifest moved into the signed record, and `requires`
//! holds what the manifest's `dependencies` would.

use hpy_plugin::manifest::ReleaseExtension;
use hpy_plugin::{EXTENSION_NSID, PROFILE_NSID, Problem};
use serde_json::{Value, json};

pub fn package_uri(did: &str, slug: &str) -> String {
    format!("at://{did}/{PROFILE_NSID}/{slug}")
}

/// `(did, slug)` from a profile URI. A handle in the authority is refused:
/// a lock has to name the publisher in a way that never changes hands.
pub fn parse_package_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("at://")?;
    let (did, rest) = rest.split_once('/')?;
    let slug = rest.strip_prefix(PROFILE_NSID)?.strip_prefix('/')?;
    (did.starts_with("did:") && !slug.is_empty() && !slug.contains('/'))
        .then(|| (did.to_string(), slug.to_string()))
}

pub fn wasm_file(id: &str) -> String {
    format!("{id}.wasm")
}

pub fn release_extension(record: &Value) -> Result<ReleaseExtension, Problem> {
    let ext = record["extensions"][EXTENSION_NSID].clone();
    serde_json::from_value(ext).map_err(|e| {
        Problem::new(
            format!("release.extensions[\"{EXTENSION_NSID}\"]"),
            format!("is not readable: {e}"),
        )
    })
}

/// The package checksum the release states, refusing a hash function `hpy`
/// cannot check rather than installing bytes it never verified.
pub fn release_checksum(record: &Value) -> Result<String, Problem> {
    const PATH: &str = "release.artifacts.package.checksum";
    let sum = record["artifacts"]["package"]["checksum"]
        .as_str()
        .ok_or_else(|| Problem::new(PATH, "is missing"))?;
    if hpy_plugin::checksum::sha256_digest(sum).is_none() {
        return Err(Problem::new(
            PATH,
            format!("`{sum}` is not a sha2-256 multihash, the only hash hpy can verify"),
        ));
    }
    Ok(sum.to_string())
}

/// `requires` entries that name other packages, as `(profile URI, range)`.
pub fn package_requirements(record: &Value) -> Vec<(String, String)> {
    let Some(map) = record["requires"].as_object() else {
        return Vec::new();
    };
    map.iter()
        .filter(|(key, _)| parse_package_uri(key).is_some())
        .filter_map(|(key, range)| Some((key.clone(), range.as_str()?.to_string())))
        .collect()
}

pub fn happyview_requirement(record: &Value) -> Option<String> {
    record["requires"]["env:happyview"]
        .as_str()
        .map(str::to_string)
}

pub fn synthesize(
    did: &str,
    slug: &str,
    record: &Value,
    profile: &Value,
) -> Result<Value, Problem> {
    // The slug names a file in the plugin directory, so it has to be the
    // registry's own grammar rather than anything a record happens to carry.
    if !hpy_plugin::validate::is_slug(slug) {
        return Err(Problem::new(
            "slug",
            format!("`{slug}` is not a valid package slug"),
        ));
    }
    let ext = release_extension(record)?;
    let version = record["version"]
        .as_str()
        .ok_or_else(|| Problem::new("release.version", "is missing"))?;
    if ext.plugin_type == "interpreter" && ext.file_extensions.is_empty() {
        return Err(Problem::new(
            format!("{slug}@{version}"),
            "declares no file extensions, so no project file can name it; \
             it predates project mode, so pick a later version",
        ));
    }
    // HappyView refuses dependencies on an interpreter or an auth plugin, so
    // only a library carries them.
    let dependencies: Vec<Value> = if ext.plugin_type == "library" {
        package_requirements(record)
            .into_iter()
            .filter_map(|(uri, range)| {
                let (_, dep) = parse_package_uri(&uri)?;
                Some(json!({ "id": dep, "version": range }))
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut m = json!({
        "id": slug,
        "name": profile["name"].as_str().unwrap_or(slug),
        "version": version,
        "api_version": ext.api_version,
        "plugin_type": ext.plugin_type,
        "capabilities": ext.capabilities,
        "allowed_hosts": ext.allowed_hosts,
        "dependencies": dependencies,
        "publisher": did,
        "wasm_file": wasm_file(slug),
    });
    if let Some(d) = profile["description"].as_str() {
        m["description"] = d.into();
    }
    if let Some(ns) = &ext.namespace {
        m["namespace"] = ns.clone().into();
    }
    if let Some(lang) = &ext.language_id {
        m["language_id"] = lang.clone().into();
        m["monaco_language"] = lang.clone().into();
    }
    if let Some(first) = ext.file_extensions.first() {
        m["file_extension"] = first.clone().into();
        m["extensions"] = json!(ext.file_extensions);
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SUM: &str = "bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i";

    fn release(ext: Value, requires: Value) -> Value {
        json!({
            "package": "happyview-lua",
            "version": "1.4.2",
            "artifacts": { "package": { "checksum": SUM } },
            "extensions": { "at.happyproto.plugin.releaseExtension": ext },
            "requires": requires,
        })
    }

    #[test]
    fn package_uris_round_trip_and_reject_other_shapes() {
        let uri = package_uri("did:plc:abc", "happyview-lua");
        assert_eq!(
            uri,
            "at://did:plc:abc/at.happyproto.plugin.profile/happyview-lua"
        );
        assert_eq!(
            parse_package_uri(&uri),
            Some(("did:plc:abc".into(), "happyview-lua".into()))
        );
        assert_eq!(
            parse_package_uri("at://did:plc:abc/app.bsky.feed.post/x"),
            None
        );
        assert_eq!(
            parse_package_uri("at://alice.test/at.happyproto.plugin.profile/x"),
            None
        );
        assert_eq!(parse_package_uri("env:happyview"), None);
    }

    #[test]
    fn an_interpreter_manifest_carries_its_language_and_extensions() {
        let record = release(
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua",
                    "fileExtensions": ["lua"],
                    "capabilities": ["library:call", "script:host"] }),
            json!({ "env:happyview": ">=3.0.0" }),
        );
        let profile = json!({ "name": "Lua", "description": "Lua 5.4 for HappyView scripts." });
        let m = synthesize("did:plc:abc", "happyview-lua", &record, &profile).unwrap();
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
        let record = release(
            json!({ "pluginType": "library", "apiVersion": "2", "namespace": "happyview.record",
                    "capabilities": ["records:read"], "allowedHosts": ["api.example.com"] }),
            json!({
                "env:happyview": ">=3.0.0",
                "at://did:plc:abc/at.happyproto.plugin.profile/happyview-db": "^0.1"
            }),
        );
        let m = synthesize("did:plc:abc", "happyview-record", &record, &json!({})).unwrap();
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
        let record = release(
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua",
                    "fileExtensions": ["lua"], "capabilities": [] }),
            json!({ "at://did:plc:abc/at.happyproto.plugin.profile/happyview-db": "^0.1" }),
        );
        let m = synthesize("did:plc:abc", "happyview-lua", &record, &json!({})).unwrap();
        assert_eq!(m["dependencies"], json!([]));
    }

    #[test]
    fn an_interpreter_without_file_extensions_is_refused() {
        let record = release(
            json!({ "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua",
                    "capabilities": [] }),
            json!({}),
        );
        let err = synthesize("did:plc:abc", "happyview-lua", &record, &json!({})).unwrap_err();
        assert!(err.message.contains("no file extensions"), "{err}");
    }

    #[test]
    fn checksums_must_be_sha256_multihashes() {
        assert_eq!(
            release_checksum(&release(json!({}), json!({}))).unwrap(),
            SUM
        );
        let bad = json!({ "artifacts": { "package": { "checksum": "zQmNotSha256" } } });
        assert!(
            release_checksum(&bad)
                .unwrap_err()
                .message
                .contains("sha2-256")
        );
        assert!(
            release_checksum(&json!({}))
                .unwrap_err()
                .message
                .contains("missing")
        );
    }

    #[test]
    fn requires_splits_into_packages_and_happyview() {
        let record = release(
            json!({}),
            json!({
                "env:happyview": ">=3.0.0",
                "env:other": "1",
                "at://did:plc:abc/at.happyproto.plugin.profile/happyview-db": "^0.1"
            }),
        );
        assert_eq!(
            package_requirements(&record),
            [(
                "at://did:plc:abc/at.happyproto.plugin.profile/happyview-db".to_string(),
                "^0.1".to_string()
            )]
        );
        assert_eq!(happyview_requirement(&record).as_deref(), Some(">=3.0.0"));
    }

    #[test]
    fn a_slug_that_could_leave_the_plugin_directory_is_refused() {
        let record = release(
            json!({ "pluginType": "library", "apiVersion": "2", "capabilities": [] }),
            json!({}),
        );
        for slug in ["../evil", "a/b", "a\\b", "..", ".hidden", ""] {
            let err = synthesize("did:plc:abc", slug, &record, &json!({})).unwrap_err();
            assert!(
                err.message.contains("not a valid package slug"),
                "{slug}: {err}"
            );
        }
    }

    // Pins the round trip against the real interpreter manifest: publishing it
    // yields this release extension, and rebuilding from that must give the
    // manifest back. A field HappyView needs that the release cannot carry
    // shows up here as a difference.
    #[test]
    fn the_real_lua_manifest_survives_a_publish_and_rebuild() {
        let text = include_str!("../tests/fixtures/happyview-lua-manifest.json");
        let original: Value = serde_json::from_str(text).unwrap();
        let parsed: hpy_plugin::manifest::Manifest = serde_json::from_str(text).unwrap();
        assert!(parsed.extension_problems().is_empty());
        let record = json!({
            "version": original["version"],
            "artifacts": { "package": { "checksum": SUM } },
            "extensions": { EXTENSION_NSID: parsed.extension() },
            "requires": { "env:happyview": ">=3.0.0" },
        });
        let profile = json!({
            "name": original["name"], "description": original["description"],
        });
        let mut rebuilt = synthesize("did:plc:abc", "happyview-lua", &record, &profile).unwrap();
        assert_eq!(rebuilt["publisher"], "did:plc:abc");
        rebuilt.as_object_mut().unwrap().remove("publisher");
        // No release field carries the bridge list, and HappyView defaults it.
        let mut expected = original;
        expected
            .as_object_mut()
            .unwrap()
            .remove("supports_libraries");
        assert_eq!(rebuilt, expected);
    }
}
