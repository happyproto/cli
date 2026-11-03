//! The HappyView binary a project pins, from HappyView's GitHub releases.
//! The archive is checked against the `.sha256` published beside it. That
//! catches a corrupt or truncated download; it is not a signature, since both
//! come from the same release.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::failure::Failure;
use crate::project::cache;

/// The release asset for this machine. On Linux that is always the static
/// musl build, which runs on any distribution, whatever libc hpy itself was
/// built against; elsewhere it is the triple hpy was built for.
pub const HOST_TARGET: &str = if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
    "x86_64-unknown-linux-musl"
} else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
    "aarch64-unknown-linux-musl"
} else {
    env!("HPY_TARGET")
};
pub const DEFAULT_REPO: &str = "gamesgamesgamesgamesgames/happyview";

pub struct ReleaseSource {
    pub api: String,
    pub download: String,
    pub repo: String,
}

impl ReleaseSource {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> ReleaseSource {
        let repo = env("HPY_HAPPYVIEW_REPO").unwrap_or_else(|| DEFAULT_REPO.into());
        ReleaseSource {
            api: env("HPY_GITHUB_API").unwrap_or_else(|| "https://api.github.com".into()),
            download: env("HPY_HAPPYVIEW_DOWNLOAD")
                .unwrap_or_else(|| format!("https://github.com/{repo}/releases/download")),
            repo,
        }
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

pub const BINARY_NAME: &str = "happyview";

/// HappyView ships no Windows build, so a Windows host can't run it.
fn runs_locally(target: &str) -> bool {
    !target.contains("windows")
}

/// The refusal for a host HappyView has no build for, given before anything
/// is looked up or downloaded.
fn require_local_build(target: &str) -> Result<(), Failure> {
    if runs_locally(target) {
        Ok(())
    } else {
        Err(Failure::usage(
            "running HappyView locally isn't supported on Windows; use WSL",
        ))
    }
}

pub fn asset_name(target: &str) -> String {
    format!("happyview-{target}.tar.xz")
}

/// Where the binary sits inside the release archive: cargo-dist nests a
/// tarball's contents under `happyview-<triple>/`.
fn archive_entry(target: &str) -> String {
    format!("happyview-{target}/{BINARY_NAME}")
}

/// The digest in a `.sha256` file, which leads with the hex digest and may
/// follow it with the file name.
pub fn parse_sha256(text: &str) -> Option<[u8; 32]> {
    let token = text.split_whitespace().next()?;
    let bytes = data_encoding::HEXLOWER_PERMISSIVE
        .decode(token.as_bytes())
        .ok()?;
    bytes.try_into().ok()
}

/// A name that climbs out of, or starts above, wherever the archive would be
/// unpacked. Judged on the text with both separators, so a Windows-shaped
/// name is caught too.
fn escapes(name: &str) -> bool {
    let bytes = name.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    name.starts_with(['/', '\\']) || drive || name.split(['/', '\\']).any(|part| part == "..")
}

/// One archive entry, as far as the extraction rules care.
struct Entry {
    name: String,
    link: bool,
    file: bool,
}

/// The release archive is refused whole if any entry could write outside its
/// own directory or is a link, even though only one entry is ever read: an
/// archive shaped like that did not come from HappyView's release build.
fn check_entry(entry: &Entry, want: &str) -> Result<bool, Failure> {
    if escapes(&entry.name) {
        return Err(Failure::runtime(format!(
            "the release archive holds `{}`, which points outside the archive; nothing was installed",
            entry.name
        )));
    }
    if entry.link {
        return Err(Failure::runtime(format!(
            "the release archive holds a link at `{}`; nothing was installed",
            entry.name
        )));
    }
    Ok(entry.file && entry.name == want)
}

/// The bytes of the `happyview` binary in a release archive, taken from the
/// one entry cargo-dist puts it at and nowhere else.
pub fn extract_binary(archive: &[u8], target: &str) -> Result<Vec<u8>, Failure> {
    let want = archive_entry(target);
    let mut found: Option<Vec<u8>> = None;
    let take = |found: &mut Option<Vec<u8>>, reader: &mut dyn Read| {
        if found.is_some() {
            return Err(Failure::runtime(format!(
                "the release archive holds `{want}` more than once; nothing was installed"
            )));
        }
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).map_err(Failure::runtime)?;
        *found = Some(bytes);
        Ok(())
    };
    let mut tar = tar::Archive::new(xz2::read::XzDecoder::new(archive));
    for entry in tar.entries().map_err(Failure::runtime)? {
        let mut entry = entry.map_err(Failure::runtime)?;
        let kind = entry.header().entry_type();
        let described = Entry {
            name: String::from_utf8_lossy(&entry.path_bytes()).into_owned(),
            link: kind.is_symlink() || kind.is_hard_link(),
            file: kind.is_file(),
        };
        if check_entry(&described, &want)? {
            take(&mut found, &mut entry)?;
        }
    }
    found.ok_or_else(|| Failure::runtime(format!("the release archive holds no `{want}`")))
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

/// How many pages of releases `latest_version` reads before giving up. At a
/// hundred a page that is far more releases than the repository will have.
const MAX_RELEASE_PAGES: usize = 20;

/// The `rel="next"` target of a GitHub `Link` header.
fn next_page(link: &str) -> Option<String> {
    link.split(',').find_map(|part| {
        let (url, params) = part.split_once(';')?;
        let is_next = params
            .split(';')
            .any(|p| p.trim().eq_ignore_ascii_case("rel=\"next\""));
        let url = url.trim().strip_prefix('<')?.strip_suffix('>')?;
        is_next.then(|| url.to_string())
    })
}

/// The newest stable release carrying a binary for `target`, or the newest
/// prerelease when no stable one does. Releases from before HappyView shipped
/// native binaries carry none, so they never qualify. A host HappyView has no
/// build for still pins a version for a project it only deploys, so its
/// releases are judged by the Linux build. Every page is read, because a
/// stable release can sit behind a long run of prereleases.
pub async fn latest_version(
    http: &reqwest::Client,
    src: &ReleaseSource,
    target: &str,
) -> Result<String, Failure> {
    let target = if runs_locally(target) {
        target
    } else {
        "x86_64-unknown-linux-musl"
    };
    let asset = asset_name(target);
    let mut shipped: Vec<semver::Version> = Vec::new();
    let mut url = Some(format!(
        "{}/repos/{}/releases?per_page=100",
        src.api, src.repo
    ));
    let mut pages = 0;
    while let Some(page) = url.take() {
        if pages == MAX_RELEASE_PAGES {
            return Err(Failure::runtime(format!(
                "HappyView lists more than {MAX_RELEASE_PAGES} pages of releases; \
                 set [happyview] version in happyview.toml instead"
            )));
        }
        pages += 1;
        let resp = http
            .get(&page)
            .header("accept", "application/vnd.github+json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| Failure::runtime(format!("could not list HappyView releases: {e}")))?;
        url = resp
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|v| v.to_str().ok())
            .and_then(next_page);
        let releases: Vec<GithubRelease> = resp
            .json()
            .await
            .map_err(|e| Failure::runtime(format!("could not read HappyView releases: {e}")))?;
        shipped.extend(
            releases
                .iter()
                .filter(|r| !r.draft && r.assets.iter().any(|a| a.name == asset))
                .filter_map(|r| semver::Version::parse(r.tag_name.trim_start_matches('v')).ok()),
        );
    }
    let stable = shipped.iter().filter(|v| v.pre.is_empty()).max();
    stable
        .or_else(|| shipped.iter().max())
        .map(|v| v.to_string())
        .ok_or_else(|| Failure::runtime(format!("no HappyView release ships {asset} yet")))
}

async fn fetch(http: &reqwest::Client, url: &str) -> Result<Option<Vec<u8>>, Failure> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| Failure::runtime(format!("could not download {url}: {e}")))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let resp = resp
        .error_for_status()
        .map_err(|e| Failure::runtime(format!("could not download {url}: {e}")))?;
    resp.bytes()
        .await
        .map(|b| Some(b.to_vec()))
        .map_err(|e| Failure::runtime(format!("could not download {url}: {e}")))
}

/// The cached binary for `version`, downloaded and verified first if it is
/// not there yet.
pub async fn ensure_binary(
    http: &reqwest::Client,
    src: &ReleaseSource,
    root: &Path,
    version: &str,
    target: &str,
    status: &dyn Fn(&str),
) -> Result<PathBuf, Failure> {
    require_local_build(target)?;
    // The version names a cache directory, so anything but a version could
    // point it somewhere else.
    if semver::Version::parse(version).is_err() {
        return Err(Failure::usage(format!(
            "`{version}` is not a HappyView version; set [happyview] version in happyview.toml to one, like 3.0.0"
        )));
    }
    let path = cache::binary_path(root, version, target);
    if path.is_file() {
        return Ok(path);
    }
    let asset = asset_name(target);
    let url = format!("{}/v{version}/{asset}", src.download);
    let missing = || {
        Failure::usage(format!(
            "HappyView {version} has no {asset}; pick another [happyview] version in happyview.toml"
        ))
    };
    let sum = fetch(http, &format!("{url}.sha256"))
        .await?
        .ok_or_else(missing)?;
    let want = parse_sha256(&String::from_utf8_lossy(&sum))
        .ok_or_else(|| Failure::runtime(format!("{asset}.sha256 holds no sha256 digest")))?;
    status(&format!("downloading HappyView {version} for {target}"));
    let archive = fetch(http, &url).await?.ok_or_else(missing)?;
    let got: [u8; 32] = Sha256::digest(&archive).into();
    if got != want {
        return Err(Failure::runtime(format!(
            "the downloaded {asset} does not match its published .sha256; nothing was installed"
        )));
    }
    let binary = extract_binary(&archive, target)?;
    cache::install_file(&path, &binary, true).map_err(Failure::runtime)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::tar_xz;
    use sha2::{Digest, Sha256};
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const LINUX: &str = "x86_64-unknown-linux-musl";
    const WINDOWS: &str = "x86_64-pc-windows-msvc";
    const LINUX_ENTRY: &str = "happyview-x86_64-unknown-linux-musl/happyview";

    fn hex(bytes: &[u8]) -> String {
        data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
    }

    fn source(server: &MockServer) -> ReleaseSource {
        ReleaseSource {
            api: server.uri(),
            download: format!("{}/dl", server.uri()),
            repo: "o/happyview".into(),
        }
    }

    fn error_text(f: Failure) -> String {
        f.report.to_string()
    }

    /// A `.tar.xz` whose names and entry types are written into the header
    /// as given, which `tar::Builder`'s own path setters refuse to do for
    /// the names these tests need.
    fn raw_tar_xz(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(xz2::write::XzEncoder::new(Vec::new(), 6));
        for (name, kind, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
            header.set_entry_type(*kind);
            if kind.is_symlink() {
                header.set_link_name("/etc/passwd").unwrap();
            }
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append(&header, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn asset_names_follow_the_target() {
        assert_eq!(
            asset_name(LINUX),
            "happyview-x86_64-unknown-linux-musl.tar.xz"
        );
        assert_eq!(
            asset_name("aarch64-apple-darwin"),
            "happyview-aarch64-apple-darwin.tar.xz"
        );
    }

    #[test]
    fn sha256_files_are_read_by_their_first_token() {
        let want = hex(b"x");
        // cargo-dist's own form: binary-mode `sha256sum` output.
        assert!(parse_sha256(&format!("{want} *happyview-x.tar.xz\n")).is_some());
        assert!(parse_sha256(&format!("{want}  happyview-x.tar.xz\n")).is_some());
        assert!(parse_sha256(&want.to_uppercase()).is_some());
        assert!(parse_sha256("nothex").is_none());
        assert!(parse_sha256(&want[..62]).is_none());
        assert!(parse_sha256("").is_none());
    }

    #[test]
    fn extracts_only_the_binary_at_its_release_path() {
        // Releases carry helper binaries beside `happyview`, and a
        // `happyview` anywhere but cargo-dist's path is not the one wanted.
        let tar = tar_xz(&[
            (
                "happyview-x86_64-unknown-linux-musl/README.md",
                b"readme",
                0o644,
            ),
            (
                "happyview-x86_64-unknown-linux-musl/happyview-codemod",
                b"NOT IT",
                0o755,
            ),
            ("elsewhere/happyview", b"NOT IT EITHER", 0o755),
            (LINUX_ENTRY, b"ELF", 0o755),
        ]);
        assert_eq!(extract_binary(&tar, LINUX).unwrap(), b"ELF");
        let misplaced = tar_xz(&[("README.md", b"r", 0o644), ("happyview", b"ELF", 0o755)]);
        assert!(
            error_text(extract_binary(&misplaced, LINUX).unwrap_err())
                .contains(&format!("no `{LINUX_ENTRY}`"))
        );
    }

    #[test]
    fn an_archive_reaching_outside_itself_is_refused() {
        use tar::EntryType::{Regular, Symlink};
        for (entries, says) in [
            (
                vec![
                    ("../happyview", Regular, &b"x"[..]),
                    (LINUX_ENTRY, Regular, b"ELF"),
                ],
                "outside",
            ),
            (
                vec![
                    ("/tmp/happyview", Regular, &b"x"[..]),
                    (LINUX_ENTRY, Regular, b"ELF"),
                ],
                "outside",
            ),
            (
                vec![
                    ("..\\happyview", Regular, &b"x"[..]),
                    (LINUX_ENTRY, Regular, b"ELF"),
                ],
                "outside",
            ),
            (
                vec![
                    ("C:\\happyview", Regular, &b"x"[..]),
                    (LINUX_ENTRY, Regular, b"ELF"),
                ],
                "outside",
            ),
            (vec![(LINUX_ENTRY, Symlink, &b""[..])], "link"),
        ] {
            let err = extract_binary(&raw_tar_xz(&entries), LINUX).unwrap_err();
            assert!(error_text(err).contains(says), "{entries:?}");
        }
        let twice = raw_tar_xz(&[
            (LINUX_ENTRY, Regular, b"one"),
            (LINUX_ENTRY, Regular, b"two"),
        ]);
        assert!(error_text(extract_binary(&twice, LINUX).unwrap_err()).contains("more than once"));
    }

    #[tokio::test]
    async fn downloads_verifies_and_caches_once() {
        let server = MockServer::start().await;
        let archive = tar_xz(&[(LINUX_ENTRY, b"#!/bin/sh\n", 0o755)]);
        let asset = asset_name(LINUX);
        Mock::given(method("GET"))
            .and(path(format!("/dl/v3.0.0/{asset}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(archive.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/dl/v3.0.0/{asset}.sha256")))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(format!("{} *{asset}\n", hex(&archive))),
            )
            .expect(1)
            .mount(&server)
            .await;
        let cache = tempfile::tempdir().unwrap();
        let http = http_client();
        let got = ensure_binary(
            &http,
            &source(&server),
            cache.path(),
            "3.0.0",
            LINUX,
            &|_| {},
        )
        .await
        .unwrap();
        assert_eq!(got, cache::binary_path(cache.path(), "3.0.0", LINUX));
        assert_eq!(std::fs::read(&got).unwrap(), b"#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&got).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        ensure_binary(
            &http,
            &source(&server),
            cache.path(),
            "3.0.0",
            LINUX,
            &|_| {},
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_checksum_mismatch_installs_nothing() {
        let server = MockServer::start().await;
        let asset = asset_name(LINUX);
        Mock::given(method("GET"))
            .and(path(format!("/dl/v3.0.0/{asset}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(tar_xz(&[(
                LINUX_ENTRY,
                b"x",
                0o755,
            )])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/dl/v3.0.0/{asset}.sha256")))
            .respond_with(ResponseTemplate::new(200).set_body_string(hex(b"something else")))
            .mount(&server)
            .await;
        let cache = tempfile::tempdir().unwrap();
        let err = ensure_binary(
            &http_client(),
            &source(&server),
            cache.path(),
            "3.0.0",
            LINUX,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert!(error_text(err).contains("does not match"));
        assert!(!cache::binary_path(cache.path(), "3.0.0", LINUX).exists());
    }

    #[tokio::test]
    async fn a_version_without_an_asset_is_a_usage_error() {
        let server = MockServer::start().await;
        let cache = tempfile::tempdir().unwrap();
        let err = ensure_binary(
            &http_client(),
            &source(&server),
            cache.path(),
            "2.9.0",
            LINUX,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, 2);
        assert!(error_text(err).contains("[happyview] version"));
    }

    #[tokio::test]
    async fn a_version_that_is_not_one_is_refused_before_any_download() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let cache = tempfile::tempdir().unwrap();
        let err = ensure_binary(
            &http_client(),
            &source(&server),
            cache.path(),
            "../../x",
            LINUX,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn windows_is_refused_before_anything_is_looked_up() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let cache = tempfile::tempdir().unwrap();
        // Even a binary already in the cache is not one HappyView ships.
        let cached = cache::binary_path(cache.path(), "3.0.0", WINDOWS);
        std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
        std::fs::write(&cached, b"MZ").unwrap();
        let err = ensure_binary(
            &http_client(),
            &source(&server),
            cache.path(),
            "3.0.0",
            WINDOWS,
            &|_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(
            error_text(err),
            "running HappyView locally isn't supported on Windows; use WSL"
        );
    }

    #[tokio::test]
    async fn latest_for_windows_is_judged_by_the_linux_build() {
        let server = MockServer::start().await;
        let linux = asset_name(LINUX);
        Mock::given(method("GET"))
            .and(path("/repos/o/happyview/releases"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "tag_name": "v3.1.0", "draft": false, "assets": [] },
                { "tag_name": "v3.0.0", "draft": false, "assets": [{ "name": linux }] }
            ])))
            .mount(&server)
            .await;
        let version = latest_version(&http_client(), &source(&server), WINDOWS)
            .await
            .unwrap();
        assert_eq!(version, "3.0.0");
    }

    #[tokio::test]
    async fn latest_skips_drafts_and_releases_without_a_binary() {
        let asset = asset_name(LINUX);
        let latest = |releases: serde_json::Value| async move {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/repos/o/happyview/releases"))
                .respond_with(ResponseTemplate::new(200).set_body_json(releases))
                .mount(&server)
                .await;
            latest_version(&http_client(), &source(&server), LINUX)
                .await
                .unwrap()
        };
        let only_prereleases = serde_json::json!([
            { "tag_name": "v3.1.0", "draft": true, "assets": [{ "name": asset }] },
            { "tag_name": "v3.0.0-alpha.12", "draft": false, "assets": [{ "name": asset }] },
            { "tag_name": "v3.0.0-alpha.13", "draft": false, "assets": [] },
            { "tag_name": "v2.9.0", "draft": false, "assets": [] }
        ]);
        assert_eq!(latest(only_prereleases).await, "3.0.0-alpha.12");
        // A stable release wins over a newer prerelease.
        let with_stable = serde_json::json!([
            { "tag_name": "v3.1.0-alpha.1", "draft": false, "assets": [{ "name": asset }] },
            { "tag_name": "v3.0.0", "draft": false, "assets": [{ "name": asset }] },
            { "tag_name": "v2.9.0", "draft": false, "assets": [] }
        ]);
        assert_eq!(latest(with_stable).await, "3.0.0");
    }

    #[tokio::test]
    async fn latest_reads_every_page_of_releases() {
        let server = MockServer::start().await;
        let asset = asset_name(LINUX);
        let releases = "/repos/o/happyview/releases";
        let next = format!(
            "<{}{releases}?per_page=100&page=2>; rel=\"next\", <{}{releases}?per_page=100&page=2>; rel=\"last\"",
            server.uri(),
            server.uri()
        );
        Mock::given(method("GET"))
            .and(path(releases))
            .and(query_param("page", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "tag_name": "v3.0.0", "draft": false, "assets": [{ "name": asset }] }
            ])))
            .with_priority(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(releases))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("link", next.as_str())
                    .set_body_json(serde_json::json!([
                        { "tag_name": "v3.1.0-alpha.2", "draft": false, "assets": [{ "name": asset }] }
                    ])),
            )
            .expect(1)
            .mount(&server)
            .await;
        assert_eq!(
            latest_version(&http_client(), &source(&server), LINUX)
                .await
                .unwrap(),
            "3.0.0"
        );
    }

    #[tokio::test]
    async fn latest_stops_at_the_page_cap() {
        let server = MockServer::start().await;
        let releases = "/repos/o/happyview/releases";
        let next = format!("<{}{releases}?page=again>; rel=\"next\"", server.uri());
        Mock::given(method("GET"))
            .and(path(releases))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("link", next.as_str())
                    .set_body_json(serde_json::json!([])),
            )
            .expect(MAX_RELEASE_PAGES as u64)
            .mount(&server)
            .await;
        let err = latest_version(&http_client(), &source(&server), LINUX)
            .await
            .unwrap_err();
        assert!(error_text(err).contains("[happyview] version"));
    }

    #[test]
    fn the_next_page_is_read_from_the_link_header() {
        let link = r#"<https://a/r?page=1>; rel="prev", <https://a/r?page=3>; rel="next", <https://a/r?page=9>; rel="last""#;
        assert_eq!(next_page(link).as_deref(), Some("https://a/r?page=3"));
        assert_eq!(next_page(r#"<https://a/r?page=9>; rel="last""#), None);
    }
}
