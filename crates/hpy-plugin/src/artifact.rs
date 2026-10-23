//! `at.happyproto.plugin.v1`: the one entry in a `software.release.manifest`'s
//! `artifacts` that makes a release a HappyView plugin, and the checks on the
//! bytes it points at.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::checksum::raw_cid;
use crate::manifest::Manifest;
use crate::validate::{range_problem, requires_key_problem, too_long};
use crate::{ARTIFACT_TYPE, PLUGIN_TYPES, Problem};

pub const MAX_WASM_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 1024 * 1024;
pub const MAX_SCREENSHOTS: usize = 8;
pub const WASM_MIME: &str = "application/wasm";
/// `manifest.json`, published beside the module it describes.
pub const MANIFEST_MIME: &str = "application/json";
pub const IMAGE_MIMES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
];

pub fn wasm_problem(bytes: &[u8]) -> Option<String> {
    if !bytes.starts_with(b"\0asm") {
        return Some("is not a WebAssembly module (no `\\0asm` header)".into());
    }
    if bytes.len() > MAX_WASM_BYTES {
        return Some(format!(
            "is {} bytes; the registry accepts at most 16 MiB",
            bytes.len()
        ));
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// The type and size of a presentation image. SVG and anything else the
/// registry does not accept is refused.
pub fn inspect_image(bytes: &[u8]) -> Result<ImageInfo, String> {
    use imagesize::{Compression, ImageType};
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "is {} bytes; images may be at most 1 MiB",
            bytes.len()
        ));
    }
    let mime = match imagesize::image_type(bytes) {
        Ok(ImageType::Png) => "image/png",
        Ok(ImageType::Jpeg) => "image/jpeg",
        Ok(ImageType::Webp) => "image/webp",
        Ok(ImageType::Gif) => "image/gif",
        Ok(ImageType::Heif(Compression::Av1)) => "image/avif",
        _ => return Err("must be PNG, JPEG, WebP, GIF or AVIF (SVG is not accepted)".into()),
    };
    let size =
        imagesize::blob_size(bytes).map_err(|e| format!("cannot read its dimensions: {e}"))?;
    Ok(ImageInfo {
        mime,
        width: size.width as u32,
        height: size.height as u32,
    })
}

/// The blob ref a PDS will answer an upload of these bytes with. Building the
/// artifact from it before uploading lets `--dry-run` show exactly what would
/// be published, and the upload is then checked against it.
pub fn predicted_blob(bytes: &[u8], mime: &str) -> Value {
    json!({
        "$type": "blob",
        "ref": { "$link": raw_cid(bytes) },
        "mimeType": mime,
        "size": bytes.len(),
    })
}

/// Why `blob` is not a blob ref of one of `mimes` and at most `max` bytes.
pub(crate) fn blob_problem(blob: &Value, mimes: &[&str], max: usize) -> Option<String> {
    let link = blob["ref"]["$link"].as_str().unwrap_or_default();
    if blob["$type"] != "blob" || link.is_empty() {
        return Some("must be a blob uploaded to your PDS".into());
    }
    let mime = blob["mimeType"].as_str().unwrap_or_default();
    if !mimes.contains(&mime) {
        return Some(format!("is {mime:?}; it must be {}", mimes.join(", ")));
    }
    match blob["size"].as_u64() {
        None => Some("has no size".into()),
        Some(size) if size > max as u64 => {
            Some(format!("is {size} bytes; at most {max} are accepted"))
        }
        Some(_) => None,
    }
}

/// A banner or screenshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Image {
    #[serde(rename = "image")]
    pub blob: Value,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sections {
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginArtifact {
    pub package: Value,
    /// The module's `manifest.json`. A module published as a blob has no
    /// directory beside it to hold a sibling file, so without this nothing
    /// says how to load it.
    pub manifest: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banner: Option<Image>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshots: Vec<Image>,
    pub plugin_type: String,
    pub api_version: String,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_extensions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_hosts: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub requires: BTreeMap<String, String>,
    pub license: String,
    pub sections: Sections,
}

impl PluginArtifact {
    /// The artifact for a module and its manifest, with the plugin fields
    /// copied from the manifest. Banner, screenshots and `requires` start
    /// empty for the caller to fill.
    pub fn from_manifest(
        manifest: &Manifest,
        package: Value,
        manifest_blob: Value,
        license: String,
        sections: Sections,
    ) -> PluginArtifact {
        let interpreter = manifest.plugin_type.as_deref() == Some("interpreter");
        PluginArtifact {
            package,
            manifest: manifest_blob,
            banner: None,
            screenshots: Vec::new(),
            plugin_type: manifest.plugin_type.clone().unwrap_or_default(),
            api_version: manifest.api_version.clone().unwrap_or_default(),
            capabilities: manifest.capabilities.clone().unwrap_or_default(),
            namespace: manifest.namespace.clone(),
            language_id: manifest.language_id.clone(),
            // Only an interpreter claims extensions; anything else listing
            // them would compete for scripts it cannot run.
            file_extensions: if interpreter {
                manifest
                    .effective_extensions()
                    .into_iter()
                    .map(String::from)
                    .collect()
            } else {
                Vec::new()
            },
            allowed_hosts: manifest.allowed_hosts.clone(),
            requires: BTreeMap::new(),
            license,
            sections,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("an artifact serializes");
        value["$type"] = ARTIFACT_TYPE.into();
        value
    }

    pub fn from_value(value: &Value) -> Result<PluginArtifact, String> {
        if value["$type"] != ARTIFACT_TYPE {
            return Err(format!(
                "is not an {ARTIFACT_TYPE} (its $type is {})",
                value["$type"]
            ));
        }
        serde_json::from_value(value.clone()).map_err(|e| format!("is not readable: {e}"))
    }

    /// Everything the registry would refuse, so a publish fails here, with
    /// every reason at once, instead of at the gateway one at a time.
    pub fn problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        let blob = |out: &mut Vec<Problem>, path: &str, value: &Value, mimes: &[&str], max| {
            if let Some(p) = blob_problem(value, mimes, max) {
                out.push(Problem::new(path, p));
            }
        };
        blob(
            &mut out,
            "artifact.package",
            &self.package,
            &[WASM_MIME],
            MAX_WASM_BYTES,
        );
        blob(
            &mut out,
            "artifact.manifest",
            &self.manifest,
            &[MANIFEST_MIME],
            MAX_MANIFEST_BYTES,
        );
        let images = self
            .banner
            .iter()
            .map(|i| ("artifact.banner".to_string(), i))
            .chain(
                self.screenshots
                    .iter()
                    .enumerate()
                    .map(|(n, i)| (format!("artifact.screenshots[{n}]"), i)),
            );
        for (path, image) in images {
            blob(
                &mut out,
                &format!("{path}.image"),
                &image.blob,
                &IMAGE_MIMES,
                MAX_IMAGE_BYTES,
            );
            if let Some(alt) = &image.alt {
                too_long(&mut out, &format!("{path}.alt"), alt, 300, 3000);
            }
        }
        if self.screenshots.len() > MAX_SCREENSHOTS {
            out.push(Problem::new(
                "artifact.screenshots",
                format!("has more than {MAX_SCREENSHOTS} screenshots"),
            ));
        }

        let max = |out: &mut Vec<Problem>, path: String, value: &str, limit: usize| {
            if value.len() > limit {
                out.push(Problem::new(
                    path,
                    format!("is longer than {limit} characters"),
                ));
            }
        };
        if !PLUGIN_TYPES.contains(&self.plugin_type.as_str()) {
            out.push(Problem::new(
                "artifact.pluginType",
                format!(
                    "must be auth, library or interpreter (got {:?})",
                    self.plugin_type
                ),
            ));
        }
        let major = self
            .api_version
            .split('.')
            .next()
            .and_then(|m| m.parse::<u32>().ok());
        if self.api_version.len() > 16 {
            max(
                &mut out,
                "artifact.apiVersion".into(),
                &self.api_version,
                16,
            );
        } else if !matches!(major, Some(m) if m >= 2) {
            out.push(Problem::new(
                "artifact.apiVersion",
                "must be \"2\" or later",
            ));
        }
        for (i, c) in self.capabilities.iter().enumerate() {
            max(&mut out, format!("artifact.capabilities[{i}]"), c, 128);
        }
        match &self.namespace {
            Some(ns) => max(&mut out, "artifact.namespace".into(), ns, 256),
            None if self.plugin_type == "library" => out.push(Problem::new(
                "artifact.namespace",
                "a library must declare its namespace",
            )),
            None => {}
        }
        if self.plugin_type == "interpreter" {
            self.interpreter_problems(&mut out);
        }
        for (i, h) in self.allowed_hosts.iter().enumerate() {
            max(&mut out, format!("artifact.allowedHosts[{i}]"), h, 256);
        }
        for (key, range) in &self.requires {
            let path = format!("artifact.requires[{key:?}]");
            if let Some(p) = requires_key_problem(key) {
                out.push(Problem::new(&path, p));
            }
            if let Some(p) = range_problem(range) {
                out.push(Problem::new(&path, p));
            }
        }
        if self.license.trim().is_empty() {
            out.push(Problem::new(
                "artifact.license",
                "is required (an SPDX expression, or \"proprietary\")",
            ));
        } else {
            max(&mut out, "artifact.license".into(), &self.license, 256);
        }
        if self.sections.description.trim().is_empty() {
            out.push(Problem::new("artifact.sections.description", "is required"));
        }
        let sections = [
            ("description", Some(&self.sections.description)),
            ("installation", self.sections.installation.as_ref()),
            ("security", self.sections.security.as_ref()),
        ];
        for (name, text) in sections {
            if let Some(text) = text {
                too_long(
                    &mut out,
                    &format!("artifact.sections.{name}"),
                    text,
                    2000,
                    20000,
                );
            }
        }
        out
    }

    fn interpreter_problems(&self, out: &mut Vec<Problem>) {
        if self.language_id.is_none() {
            out.push(Problem::new(
                "artifact.languageId",
                "an interpreter must declare its language_id",
            ));
        }
        if !(1..=8).contains(&self.file_extensions.len()) {
            out.push(Problem::new(
                "artifact.fileExtensions",
                "an interpreter must claim 1 to 8 file extensions",
            ));
        }
        for (i, e) in self.file_extensions.iter().enumerate() {
            let path = format!("artifact.fileExtensions[{i}]");
            if !is_file_extension(e) {
                out.push(Problem::new(
                    path,
                    "must be 1 to 16 lowercase letters or digits, without the dot, and not `json`",
                ));
            } else if self.file_extensions[..i].contains(e) {
                out.push(Problem::new(path, format!("`{e}` is listed twice")));
            }
        }
    }
}

/// `json` names lexicons in a project, so it cannot name a script language.
pub(crate) fn is_file_extension(e: &str) -> bool {
    (1..=16).contains(&e.len())
        && e.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && e != "json"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ARTIFACT_TYPE;
    use crate::manifest::Manifest;

    // 1x1 PNG
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0,
        0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44,
        0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    const WASM: &[u8] = b"\0asm\x01\0\0\0";

    #[test]
    fn wasm_magic_and_size() {
        assert_eq!(wasm_problem(WASM), None);
        assert!(
            wasm_problem(b"PK\x03\x04")
                .unwrap()
                .contains("not a WebAssembly")
        );
        let mut big = WASM.to_vec();
        big.resize(MAX_WASM_BYTES + 1, 0);
        assert!(wasm_problem(&big).unwrap().contains("16 MiB"));
    }

    #[test]
    fn png_is_inspected() {
        let info = inspect_image(PNG).unwrap();
        assert_eq!((info.mime, info.width, info.height), ("image/png", 1, 1));
    }

    #[test]
    fn svg_and_oversize_refused() {
        assert!(inspect_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(inspect_image(&big).unwrap_err().contains("1 MiB"));
    }

    fn image(alt: Option<&str>) -> Image {
        Image {
            blob: predicted_blob(PNG, "image/png"),
            width: 1,
            height: 1,
            alt: alt.map(String::from),
        }
    }

    /// A valid interpreter, the most constrained plugin type.
    fn valid() -> PluginArtifact {
        PluginArtifact {
            package: predicted_blob(WASM, WASM_MIME),
            manifest: predicted_blob(b"{\"id\":\"happyview-lua\"}", MANIFEST_MIME),
            banner: Some(image(Some("the Lua logo"))),
            screenshots: vec![image(None)],
            plugin_type: "interpreter".into(),
            api_version: "2".into(),
            capabilities: vec!["library:call".into()],
            namespace: None,
            language_id: Some("lua".into()),
            file_extensions: vec!["lua".into()],
            allowed_hosts: vec!["example.com".into()],
            requires: [("env:happyview".to_string(), ">=3.0.0-alpha.24".to_string())].into(),
            license: "MIT".into(),
            sections: Sections {
                description: "Lua scripts.".into(),
                installation: None,
                security: None,
            },
        }
    }

    fn paths(a: &PluginArtifact) -> Vec<String> {
        a.problems().into_iter().map(|p| p.path).collect()
    }

    fn has(a: &PluginArtifact, path: &str) {
        let got = paths(a);
        assert!(got.iter().any(|p| p == path), "{path} missing from {got:?}");
    }

    #[test]
    fn a_valid_interpreter_has_no_problems() {
        assert_eq!(valid().problems(), vec![]);
    }

    #[test]
    fn serializes_without_checksums_or_urls() {
        let v = valid().to_value();
        assert_eq!(v["$type"], ARTIFACT_TYPE);
        assert_eq!(v["$type"], "at.happyproto.plugin.v1");
        assert_eq!(v["package"]["$type"], "blob");
        assert_eq!(
            v["package"]["ref"]["$link"],
            "bafkreieturf3xfwhkeqy4taa2r46jqkdlajcuoe2zsqwebnr4tinyx4uoy"
        );
        assert_eq!(v["package"]["mimeType"], "application/wasm");
        assert_eq!(v["package"]["size"], 8);
        assert_eq!(v["manifest"]["mimeType"], "application/json");
        assert_eq!(v["banner"]["image"]["mimeType"], "image/png");
        assert_eq!(v["banner"]["alt"], "the Lua logo");
        assert_eq!(v["screenshots"][0]["width"], 1);
        assert!(v["screenshots"][0].get("alt").is_none());
        assert_eq!(v["pluginType"], "interpreter");
        assert_eq!(v["apiVersion"], "2");
        assert_eq!(v["languageId"], "lua");
        assert_eq!(v["fileExtensions"], serde_json::json!(["lua"]));
        assert_eq!(v["allowedHosts"], serde_json::json!(["example.com"]));
        assert_eq!(v["requires"]["env:happyview"], ">=3.0.0-alpha.24");
        assert_eq!(v["license"], "MIT");
        assert_eq!(v["sections"]["description"], "Lua scripts.");
        assert!(v["sections"].get("installation").is_none());
        assert!(v.get("namespace").is_none());
        let text = v.to_string();
        assert!(!text.contains("checksum"), "{text}");
        assert!(!text.contains("\"url\""), "{text}");
        assert_eq!(PluginArtifact::from_value(&v).unwrap(), valid());
    }

    #[test]
    fn capabilities_are_written_even_when_empty() {
        let mut a = valid();
        a.capabilities.clear();
        assert_eq!(a.to_value()["capabilities"], serde_json::json!([]));
    }

    #[test]
    fn from_value_refuses_another_type() {
        let mut v = valid().to_value();
        v["$type"] = "at.happyproto.plugin.v2".into();
        assert!(PluginArtifact::from_value(&v).is_err());
    }

    #[test]
    fn package_must_be_a_wasm_blob() {
        let mut a = valid();
        a.package = serde_json::json!({ "url": "https://example.com/x.wasm" });
        has(&a, "artifact.package");
        let mut a = valid();
        a.package = predicted_blob(WASM, "application/octet-stream");
        has(&a, "artifact.package");
    }

    #[test]
    fn package_at_most_16_mib() {
        let mut a = valid();
        a.package["size"] = (MAX_WASM_BYTES + 1).into();
        has(&a, "artifact.package");
        a.package["size"] = MAX_WASM_BYTES.into();
        assert_eq!(a.problems(), vec![]);
    }

    #[test]
    fn manifest_must_be_a_json_blob_of_at_most_1_mib() {
        let mut a = valid();
        a.manifest["mimeType"] = "text/plain".into();
        has(&a, "artifact.manifest");
        let mut a = valid();
        a.manifest["size"] = (MAX_MANIFEST_BYTES + 1).into();
        has(&a, "artifact.manifest");
    }

    #[test]
    fn images_are_raster_and_at_most_1_mib() {
        let mut a = valid();
        a.banner.as_mut().unwrap().blob["mimeType"] = "image/svg+xml".into();
        has(&a, "artifact.banner.image");
        let mut a = valid();
        a.screenshots[0].blob["size"] = (MAX_IMAGE_BYTES + 1).into();
        has(&a, "artifact.screenshots[0].image");
        for mime in [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "image/avif",
        ] {
            let mut a = valid();
            a.screenshots[0].blob["mimeType"] = mime.into();
            assert_eq!(a.problems(), vec![], "{mime}");
        }
    }

    #[test]
    fn at_most_8_screenshots() {
        let mut a = valid();
        a.screenshots = (0..8).map(|_| image(None)).collect();
        assert_eq!(a.problems(), vec![]);
        a.screenshots.push(image(None));
        has(&a, "artifact.screenshots");
    }

    #[test]
    fn alt_text_has_a_limit() {
        let mut a = valid();
        a.banner = Some(image(Some(&"a".repeat(301))));
        has(&a, "artifact.banner.alt");
        let mut a = valid();
        // 300 graphemes, but over 3000 bytes
        a.screenshots = vec![image(Some(&"👩‍👩‍👧".repeat(300)))];
        has(&a, "artifact.screenshots[0].alt");
    }

    #[test]
    fn plugin_type_is_one_of_three() {
        let mut a = valid();
        a.plugin_type = "theme".into();
        has(&a, "artifact.pluginType");
    }

    #[test]
    fn api_version_is_2_or_later_and_short() {
        for bad in ["1", "1.9", "", "x", &format!("2{}", "0".repeat(16))] {
            let mut a = valid();
            a.api_version = bad.into();
            has(&a, "artifact.apiVersion");
        }
        let mut a = valid();
        a.api_version = "12.1".into();
        assert_eq!(a.problems(), vec![]);
    }

    #[test]
    fn capabilities_have_a_limit() {
        let mut a = valid();
        a.capabilities = vec!["c".repeat(129)];
        has(&a, "artifact.capabilities[0]");
    }

    #[test]
    fn a_library_needs_a_namespace_of_at_most_256() {
        let mut a = valid();
        a.plugin_type = "library".into();
        a.language_id = None;
        a.file_extensions.clear();
        has(&a, "artifact.namespace");
        a.namespace = Some("n".repeat(257));
        has(&a, "artifact.namespace");
        a.namespace = Some("happyview.lua".into());
        assert_eq!(a.problems(), vec![]);
    }

    #[test]
    fn an_interpreter_needs_a_language_id() {
        let mut a = valid();
        a.language_id = None;
        has(&a, "artifact.languageId");
    }

    #[test]
    fn an_interpreter_needs_1_to_8_file_extensions() {
        let mut a = valid();
        a.file_extensions.clear();
        has(&a, "artifact.fileExtensions");
        a.file_extensions = (0..9).map(|i| format!("e{i}")).collect();
        has(&a, "artifact.fileExtensions");
    }

    #[test]
    fn file_extensions_have_a_shape() {
        for bad in [".lua", "LUA", "toolongextension1", "json", ""] {
            let mut a = valid();
            a.file_extensions = vec![bad.into()];
            has(&a, "artifact.fileExtensions[0]");
        }
        let mut a = valid();
        a.file_extensions = vec!["ts".into(), "mts".into(), "ts".into()];
        assert_eq!(paths(&a), ["artifact.fileExtensions[2]"]);
    }

    #[test]
    fn allowed_hosts_have_a_limit() {
        let mut a = valid();
        a.allowed_hosts = vec!["h".repeat(257)];
        has(&a, "artifact.allowedHosts[0]");
    }

    #[test]
    fn requires_keys_and_ranges() {
        let mut a = valid();
        a.requires = [
            (
                "at://did:plc:abc/at.happyproto.plugin.profile/happyview-http".to_string(),
                "^1.0".to_string(),
            ),
            ("env:happyview".to_string(), "^1 || ^2".to_string()),
            (
                "at://did:plc:abc/software.release.project/happyview-http".to_string(),
                "^1.0".to_string(),
            ),
        ]
        .into();
        assert_eq!(
            paths(&a),
            [
                "artifact.requires[\"at://did:plc:abc/at.happyproto.plugin.profile/happyview-http\"]",
                "artifact.requires[\"env:happyview\"]",
            ]
        );
    }

    #[test]
    fn license_is_required_and_at_most_256() {
        let mut a = valid();
        a.license = " ".into();
        has(&a, "artifact.license");
        a.license = "l".repeat(257);
        has(&a, "artifact.license");
    }

    #[test]
    fn sections_description_is_required() {
        let mut a = valid();
        a.sections.description = String::new();
        has(&a, "artifact.sections.description");
    }

    #[test]
    fn sections_have_a_limit() {
        let mut a = valid();
        a.sections.installation = Some("i".repeat(2001));
        has(&a, "artifact.sections.installation");
        let mut a = valid();
        a.sections.security = Some("👩‍👩‍👧".repeat(2000));
        has(&a, "artifact.sections.security");
    }

    #[test]
    fn from_manifest_copies_the_plugin_fields() {
        let manifest: Manifest = serde_json::from_str(
            r#"{"id":"happyview-lua","api_version":"2","plugin_type":"interpreter",
                "language_id":"lua","file_extension":"lua","capabilities":["library:call"],
                "allowed_hosts":["example.com"]}"#,
        )
        .unwrap();
        let a = PluginArtifact::from_manifest(
            &manifest,
            predicted_blob(WASM, WASM_MIME),
            predicted_blob(b"{\"id\":\"happyview-lua\"}", MANIFEST_MIME),
            "MIT".into(),
            Sections {
                description: "Lua scripts.".into(),
                installation: None,
                security: None,
            },
        );
        assert_eq!(
            a,
            PluginArtifact {
                banner: None,
                screenshots: vec![],
                requires: Default::default(),
                ..valid()
            }
        );
    }

    #[test]
    fn a_library_from_a_manifest_has_no_file_extensions() {
        let manifest: Manifest = serde_json::from_str(
            r#"{"id":"x","api_version":"2","plugin_type":"library","namespace":"a.b",
                "extensions":["lua"],"capabilities":[]}"#,
        )
        .unwrap();
        let a = PluginArtifact::from_manifest(
            &manifest,
            predicted_blob(WASM, WASM_MIME),
            predicted_blob(b"{}", MANIFEST_MIME),
            "MIT".into(),
            Sections::default(),
        );
        assert!(a.file_extensions.is_empty());
        assert_eq!(a.namespace.as_deref(), Some("a.b"));
    }
}
