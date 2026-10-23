use std::path::{Path, PathBuf};

use hpy_atproto::Registry;
use hpy_plugin::checksum::raw_cid;
use hpy_plugin::validate::parse_project_uri;
use hpy_project::lock::LockedPlugin;
use hpy_project::manifest::{Published, synthesize, wasm_file};
use serde_json::Value;

use crate::failure::Failure;
use crate::project::cache;
use crate::project::resolve::artifact_of;

/// The `manifest.json` the publisher shipped, kept beside the one `hpy`
/// writes so a hit can check it against the lock's CID.
const PUBLISHED_MANIFEST: &str = ".manifest.published.json";
/// The CID of the `manifest.json` `hpy` wrote, so a hit can tell the
/// manifest HappyView will read is still that one.
const MANIFEST_CID: &str = ".manifest.cid";

/// Whether `dir` holds exactly what a verified install wrote. A hit is
/// re-hashed every time: it costs milliseconds and catches accidental edits
/// and corruption. The sidecar is not a MAC, so it is no defence against
/// someone who can write the directory; the cache's 0700 permissions are.
fn is_intact(dir: &Path, wasm: &str, p: &LockedPlugin) -> bool {
    let cid_of = |name: &str| std::fs::read(dir.join(name)).map(|b| raw_cid(&b));
    let (Ok(module), Ok(published), Ok(manifest), Ok(recorded)) = (
        cid_of(wasm),
        cid_of(PUBLISHED_MANIFEST),
        cid_of("manifest.json"),
        std::fs::read_to_string(dir.join(MANIFEST_CID)),
    ) else {
        return false;
    };
    module == p.package_cid && published == p.manifest_blob_cid && manifest == recorded.trim()
}

/// The blob with this CID, refused unless its bytes hash to it.
async fn verified_blob(
    reg: &dyn Registry,
    p: &LockedPlugin,
    what: &str,
    cid: &str,
) -> Result<Vec<u8>, Failure> {
    let bytes = reg.get_artifact(cid).await?;
    let got = raw_cid(&bytes);
    if got != cid {
        return Err(Failure::runtime(format!(
            "the {what} of {}@{} downloaded as {got}, but happyview.lock records {cid}; nothing was installed",
            p.id, p.version
        )));
    }
    Ok(bytes)
}

/// The cache directory holding this plugin, downloaded and verified on a miss.
pub async fn ensure_plugin(
    reg: &dyn Registry,
    root: &Path,
    p: &LockedPlugin,
) -> Result<PathBuf, Failure> {
    // The id and version become path components of the cache, and the lock is
    // a file anyone can edit.
    if !hpy_plugin::validate::is_project_name(&p.id) || semver::Version::parse(&p.version).is_err()
    {
        return Err(Failure::usage(format!(
            "happyview.lock: `{}@{}` is not a plugin id and version hpy can cache",
            p.id, p.version
        )));
    }
    // `root` came from `cache_root`, which has already tightened a default
    // root, so a loose one here is refused rather than changed.
    cache::prepare_root(root, cache::RootOrigin::Named).map_err(|e| {
        Failure::runtime(format!(
            "the cache directory {} cannot be trusted: {e}",
            root.display()
        ))
    })?;
    let dir = cache::plugin_dir(root, &p.id, &p.version);
    let wasm = wasm_file(&p.id);
    if is_intact(&dir, &wasm, p) {
        return Ok(dir);
    }
    let (did, name) = parse_project_uri(&p.project).ok_or_else(|| {
        Failure::usage(format!(
            "happyview.lock: `{}` is not a software.release.project URI",
            p.project
        ))
    })?;
    let view = reg
        .get_version(&did, &name, &p.version)
        .await?
        .ok_or_else(|| {
            Failure::runtime(format!(
                "the registry no longer has {}@{}; pick another version",
                p.id, p.version
            ))
        })?;
    let artifact = artifact_of(&view)?;
    let names = |blob: &Value, cid: &str| blob["ref"]["$link"].as_str() == Some(cid);
    if view.manifest.cid != p.manifest_cid
        || !names(&artifact.package, &p.package_cid)
        || !names(&artifact.manifest, &p.manifest_blob_cid)
    {
        return Err(Failure::runtime(format!(
            "the registry's {} {} no longer matches happyview.lock",
            p.id, p.version
        )));
    }
    let module = verified_blob(reg, p, "module", &p.package_cid).await?;
    let published = verified_blob(reg, p, "manifest.json", &p.manifest_blob_cid).await?;
    let shipped: Value = serde_json::from_slice(&published).map_err(|e| {
        Failure::runtime(format!(
            "the manifest.json of {}@{} is not JSON: {e}",
            p.id, p.version
        ))
    })?;
    let project = reg.get_project(&did, &name).await?;
    let manifest = synthesize(&Published {
        did: &did,
        name: &name,
        version: &p.version,
        artifact: &artifact,
        display_name: project.as_ref().map(|v| v.publication.name.as_str()),
        description: project
            .as_ref()
            .and_then(|v| v.publication.description.as_deref()),
        manifest: &shipped,
    })?;
    let manifest = serde_json::to_vec_pretty(&manifest).expect("a manifest serializes");
    let manifest_cid = raw_cid(&manifest);
    cache::install_dir(
        &dir,
        &[
            ("manifest.json", &manifest),
            (MANIFEST_CID, manifest_cid.as_bytes()),
            (PUBLISHED_MANIFEST, &published),
            (&wasm, &module),
        ],
    )
    .map_err(Failure::runtime)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::resolve::{Resolver, resolve_lock};
    use crate::testing::{RegistryFixture, interpreter_ext};
    use hpy_plugin::checksum::raw_cid;
    use hpy_project::config::ProjectToml;
    use serde_json::json;

    const HV: &str = "did:plc:hv";

    async fn locked(reg: &RegistryFixture) -> LockedPlugin {
        let cfg = ProjectToml::parse(&format!(
            "[happyview]\nversion = \"3.0.0\"\n[interpreters]\nlua = {{ did = \"{HV}\", name = \"happyview-lua\", channel = \"latest\" }}\n"
        ))
        .unwrap();
        let r = Resolver {
            registry: reg,
            warn: &|_| {},
        };
        resolve_lock(&r, &cfg, None)
            .await
            .unwrap()
            .plugins
            .remove(0)
    }

    fn registry() -> RegistryFixture {
        let mut reg = RegistryFixture::default();
        reg.publish_with_manifest(
            HV,
            "happyview-lua",
            "1.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"\0asm lua",
            br#"{"id":"happyview-lua","supports_libraries":["happyview.http"]}"#,
        );
        reg.projects[0].publication.name = "Lua".into();
        reg
    }

    fn installed(dir: &Path) -> bool {
        dir.exists()
    }

    #[tokio::test]
    async fn downloads_verifies_and_writes_the_manifest() {
        let reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        let dir = ensure_plugin(&reg, cache.path(), &p).await.unwrap();
        assert_eq!(dir, cache.path().join("plugins/happyview-lua/1.0.0"));
        assert_eq!(
            std::fs::read(dir.join("happyview-lua.wasm")).unwrap(),
            b"\0asm lua"
        );
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["language_id"], "lua");
        assert_eq!(manifest["name"], "Lua");
        assert_eq!(manifest["wasm_file"], "happyview-lua.wasm");
        assert_eq!(manifest["supports_libraries"], json!(["happyview.http"]));
        assert_eq!(
            raw_cid(&std::fs::read(dir.join(PUBLISHED_MANIFEST)).unwrap()),
            p.manifest_blob_cid
        );
    }

    #[tokio::test]
    async fn a_cache_hit_asks_the_registry_nothing() {
        let reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        ensure_plugin(&reg, cache.path(), &p).await.unwrap();
        reg.calls.lock().unwrap().clear();
        ensure_plugin(&reg, cache.path(), &p).await.unwrap();
        assert!(reg.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_tampered_cache_entry_is_fetched_again() {
        let reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        let dir = ensure_plugin(&reg, cache.path(), &p).await.unwrap();
        for (file, junk) in [
            ("happyview-lua.wasm", &b"tampered"[..]),
            ("manifest.json", br#"{"capabilities":["everything"]}"#),
            (PUBLISHED_MANIFEST, b"{}"),
        ] {
            let original = std::fs::read(dir.join(file)).unwrap();
            std::fs::write(dir.join(file), junk).unwrap();
            reg.calls.lock().unwrap().clear();
            ensure_plugin(&reg, cache.path(), &p).await.unwrap();
            assert_eq!(std::fs::read(dir.join(file)).unwrap(), original, "{file}");
            assert!(!reg.calls.lock().unwrap().is_empty(), "{file}");
        }
    }

    #[tokio::test]
    async fn module_bytes_that_do_not_match_their_cid_install_nothing() {
        let mut reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        reg.blobs.insert(p.package_cid.clone(), b"evil".to_vec());
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        let text = err.report.to_string();
        assert!(text.contains(&p.package_cid), "{text}");
        assert!(text.contains(&raw_cid(b"evil")), "{text}");
        assert!(!installed(
            &cache.path().join("plugins/happyview-lua/1.0.0")
        ));
    }

    #[tokio::test]
    async fn manifest_bytes_that_do_not_match_their_cid_install_nothing() {
        let mut reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        reg.blobs.insert(
            p.manifest_blob_cid.clone(),
            br#"{"supports_libraries":["*"]}"#.to_vec(),
        );
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        let text = err.report.to_string();
        assert!(text.contains(&p.manifest_blob_cid), "{text}");
        assert!(text.contains("manifest.json"), "{text}");
        assert!(!installed(
            &cache.path().join("plugins/happyview-lua/1.0.0")
        ));
    }

    #[tokio::test]
    async fn a_version_whose_manifest_record_changed_is_refused() {
        let reg = registry();
        let cache = crate::testing::private_tempdir();
        let mut p = locked(&reg).await;
        p.manifest_cid = "bafyreisomethingelse".into();
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        assert_eq!(
            err.report.to_string(),
            "the registry's happyview-lua 1.0.0 no longer matches happyview.lock"
        );
    }

    #[tokio::test]
    async fn a_version_the_registry_no_longer_has_is_named() {
        let mut reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        reg.versions.clear();
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        let text = err.report.to_string();
        assert!(text.contains("happyview-lua@1.0.0"), "{text}");
    }

    #[tokio::test]
    async fn a_lock_naming_a_path_is_refused() {
        let reg = registry();
        let cache = crate::testing::private_tempdir();
        let mut p = locked(&reg).await;
        p.version = "../../x".into();
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        assert_eq!(err.code, 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlinked_cache_root_is_refused() {
        let reg = registry();
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir(base.path().join("real")).unwrap();
        std::os::unix::fs::symlink(base.path().join("real"), base.path().join("link")).unwrap();
        let p = locked(&reg).await;
        let err = ensure_plugin(&reg, &base.path().join("link"), &p)
            .await
            .unwrap_err();
        assert!(format!("{:?}", err.report).contains("cannot be trusted"));
        // Refused before anything was made through the link.
        assert_eq!(
            std::fs::read_dir(base.path().join("real")).unwrap().count(),
            0
        );
    }
}
