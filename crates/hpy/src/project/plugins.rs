use std::path::{Path, PathBuf};

use hpy_atproto::Registry;
use hpy_plugin::checksum::{checksum, same_digest};
use hpy_project::lock::LockedPlugin;
use hpy_project::manifest::{parse_package_uri, release_checksum, synthesize, wasm_file};
use serde_json::Value;

use crate::failure::Failure;
use crate::project::cache;

/// Records the hash of the synthesized `manifest.json`, so a hit can tell the
/// manifest HappyView will read is still the one `hpy` wrote.
const MANIFEST_SUM: &str = ".manifest.sha256";

/// Whether `dir` holds exactly what a verified install wrote. A hit is
/// re-hashed every time: it costs milliseconds and catches accidental edits
/// and corruption. The sidecar is not a MAC, so it is no defence against
/// someone who can write the directory; the cache's 0700 permissions are.
fn is_intact(dir: &Path, wasm: &str, expected: &str) -> bool {
    let sum_of = |name: &str| std::fs::read(dir.join(name)).map(|b| checksum(&b));
    let Ok(module) = sum_of(wasm) else {
        return false;
    };
    let (Ok(manifest), Ok(recorded)) = (
        sum_of("manifest.json"),
        std::fs::read_to_string(dir.join(MANIFEST_SUM)),
    ) else {
        return false;
    };
    same_digest(&module, expected) && same_digest(&manifest, recorded.trim())
}

/// The cache directory holding this plugin, downloaded and verified on a miss.
pub async fn ensure_plugin(
    reg: &dyn Registry,
    root: &Path,
    p: &LockedPlugin,
) -> Result<PathBuf, Failure> {
    // The id and version become path components of the cache, and the lock is
    // a file anyone can edit.
    if !hpy_plugin::validate::is_slug(&p.id) || semver::Version::parse(&p.version).is_err() {
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
    if is_intact(&dir, &wasm, &p.checksum) {
        return Ok(dir);
    }
    let (did, slug) = parse_package_uri(&p.package).ok_or_else(|| {
        Failure::usage(format!(
            "happyview.lock: `{}` is not a registry package URI",
            p.package
        ))
    })?;
    let withdrawn = || {
        Failure::runtime(format!(
            "the registry no longer has {}@{}; it was withdrawn, so pick another version",
            p.id, p.version
        ))
    };
    let release = match reg.get_release(&did, &slug, &p.version).await {
        Ok(Some(release)) => release,
        Ok(None) => return Err(withdrawn()),
        Err(hpy_atproto::Error::Xrpc { name, .. }) if name == "ReleaseNotFound" => {
            return Err(withdrawn());
        }
        Err(e) => return Err(e.into()),
    };
    let stated = release_checksum(&release.record)?;
    if !same_digest(&stated, &p.checksum) {
        return Err(Failure::runtime(format!(
            "the registry states checksum {stated} for {}@{}, but happyview.lock records {}; \
             a published version must never change, so hpy refuses it",
            p.id, p.version, p.checksum
        )));
    }
    let profile = reg
        .get_package(&did, &slug)
        .await?
        .map(|v| v.record)
        .unwrap_or(Value::Null);
    let manifest = synthesize(&did, &slug, &release.record, &profile)?;
    let bytes = match reg.get_artifact(&did, &slug, &p.version).await {
        Ok(bytes) => bytes,
        Err(hpy_atproto::Error::Xrpc { name, .. }) if name == "ReleaseNotFound" => {
            return Err(withdrawn());
        }
        Err(e) => return Err(e.into()),
    };
    let got = checksum(&bytes);
    if !same_digest(&got, &p.checksum) {
        return Err(Failure::runtime(format!(
            "{}@{} downloaded with checksum {got}, but happyview.lock records {}",
            p.id, p.version, p.checksum
        )));
    }
    let manifest = serde_json::to_vec_pretty(&manifest).expect("a manifest serializes");
    let manifest_sum = checksum(&manifest);
    cache::install_dir(
        &dir,
        &[
            ("manifest.json", &manifest),
            (MANIFEST_SUM, manifest_sum.as_bytes()),
            (&wasm, &bytes),
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
    use hpy_project::config::ProjectToml;
    use serde_json::json;
    use std::collections::BTreeMap;

    async fn locked(reg: &RegistryFixture) -> LockedPlugin {
        let cfg =
            ProjectToml::parse("[happyview]\nversion = \"3.0.0\"\n[interpreters]\nlua = \"*\"\n")
                .unwrap();
        let never = |_: &str, _: &[crate::project::resolve::Candidate]| -> Result<usize, Failure> {
            unreachable!()
        };
        let r = Resolver {
            registry: reg,
            choose: &never,
            warn: &|_| {},
            pins: BTreeMap::new(),
        };
        resolve_lock(&r, &cfg, None)
            .await
            .unwrap()
            .plugins
            .remove(0)
    }

    fn registry() -> RegistryFixture {
        let mut reg = RegistryFixture::default();
        reg.publish(
            "did:plc:hv",
            "happyview-lua",
            "1.0.0",
            interpreter_ext("lua", "lua"),
            json!({}),
            b"\0asm lua",
        );
        reg
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
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["language_id"], "lua");
        assert_eq!(manifest["wasm_file"], "happyview-lua.wasm");
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
        std::fs::write(dir.join("happyview-lua.wasm"), b"tampered").unwrap();
        ensure_plugin(&reg, cache.path(), &p).await.unwrap();
        assert_eq!(
            std::fs::read(dir.join("happyview-lua.wasm")).unwrap(),
            b"\0asm lua"
        );
    }

    #[tokio::test]
    async fn a_tampered_manifest_is_written_again() {
        let reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        let dir = ensure_plugin(&reg, cache.path(), &p).await.unwrap();
        let original = std::fs::read(dir.join("manifest.json")).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            b"{\"capabilities\":[\"everything\"]}",
        )
        .unwrap();
        ensure_plugin(&reg, cache.path(), &p).await.unwrap();
        assert_eq!(std::fs::read(dir.join("manifest.json")).unwrap(), original);
    }

    #[tokio::test]
    async fn bytes_that_do_not_match_the_lock_install_nothing() {
        let mut reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        reg.artifacts.insert(
            ("did:plc:hv".into(), "happyview-lua".into(), "1.0.0".into()),
            b"evil".to_vec(),
        );
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        assert!(format!("{:?}", err.report).contains("happyview.lock records"));
        assert!(!cache.path().join("plugins/happyview-lua/1.0.0").exists());
    }

    #[tokio::test]
    async fn a_record_whose_checksum_changed_is_refused() {
        let reg = registry();
        let cache = crate::testing::private_tempdir();
        let mut p = locked(&reg).await;
        p.checksum = hpy_plugin::checksum::checksum(b"what the lock remembers");
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        assert!(format!("{:?}", err.report).contains("must never change"));
    }

    #[tokio::test]
    async fn a_withdrawn_release_is_named() {
        let mut reg = registry();
        let cache = crate::testing::private_tempdir();
        let p = locked(&reg).await;
        reg.releases.clear();
        let err = ensure_plugin(&reg, cache.path(), &p).await.unwrap_err();
        assert!(format!("{:?}", err.report).contains("happyview-lua@1.0.0"));
        assert!(format!("{:?}", err.report).contains("withdrawn"));
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

    /// A registry whose release or artifact query answers the error a real
    /// registry gives for a version it no longer has.
    struct Gone<'a> {
        inner: &'a RegistryFixture,
        release: bool,
    }

    fn not_found() -> hpy_atproto::Error {
        hpy_atproto::Error::Xrpc {
            method: "getRelease".into(),
            name: "ReleaseNotFound".into(),
            message: None,
        }
    }

    #[async_trait::async_trait]
    impl Registry for Gone<'_> {
        async fn get_package(
            &self,
            d: &str,
            s: &str,
        ) -> hpy_atproto::Result<Option<hpy_atproto::registry::PackageView>> {
            self.inner.get_package(d, s).await
        }
        async fn get_release(
            &self,
            d: &str,
            s: &str,
            v: &str,
        ) -> hpy_atproto::Result<Option<hpy_atproto::registry::ReleaseView>> {
            if self.release {
                Err(not_found())
            } else {
                self.inner.get_release(d, s, v).await
            }
        }
        async fn list_releases(
            &self,
            d: &str,
            s: &str,
        ) -> hpy_atproto::Result<Vec<hpy_atproto::registry::ReleaseView>> {
            self.inner.list_releases(d, s).await
        }
        async fn search_packages(
            &self,
            t: &str,
        ) -> hpy_atproto::Result<Vec<hpy_atproto::registry::PackageView>> {
            self.inner.search_packages(t).await
        }
        async fn get_artifact(&self, d: &str, s: &str, v: &str) -> hpy_atproto::Result<Vec<u8>> {
            if self.release {
                self.inner.get_artifact(d, s, v).await
            } else {
                Err(not_found())
            }
        }
        async fn publish_profile(
            &self,
            _: &str,
            _: Value,
            _: bool,
        ) -> hpy_atproto::Result<Option<hpy_atproto::repo::WriteResult>> {
            unreachable!()
        }
        async fn publish_release(
            &self,
            _: Value,
            _: bool,
        ) -> hpy_atproto::Result<Option<hpy_atproto::repo::WriteResult>> {
            unreachable!()
        }
        async fn update_profile(
            &self,
            _: &str,
            _: Value,
            _: Option<&str>,
        ) -> hpy_atproto::Result<hpy_atproto::repo::WriteResult> {
            unreachable!()
        }
        async fn withdraw_release(&self, _: &str, _: &str) -> hpy_atproto::Result<bool> {
            unreachable!()
        }
        async fn retry_release(&self, _: &str, _: &str) -> hpy_atproto::Result<Option<String>> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn release_not_found_errors_read_as_withdrawn() {
        let reg = registry();
        let p = locked(&reg).await;
        for release in [true, false] {
            let cache = crate::testing::private_tempdir();
            let err = ensure_plugin(
                &Gone {
                    inner: &reg,
                    release,
                },
                cache.path(),
                &p,
            )
            .await
            .unwrap_err();
            let text = format!("{:?}", err.report);
            assert!(
                text.contains("happyview-lua@1.0.0") && text.contains("withdrawn"),
                "{text}"
            );
            assert!(!cache.path().join("plugins/happyview-lua/1.0.0").exists());
        }
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
