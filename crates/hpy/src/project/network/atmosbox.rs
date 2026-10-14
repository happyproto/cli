//! Atmosphere in a Box, pinned. Each project gets its own checkout in `hpy`'s
//! data directory, never inside the project: the checkout's `state/` holds the
//! sandbox's private CA key, and the project is bind-mounted into a container.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::failure::Failure;
use crate::project::network::runner::{Runner, must_with_env};

pub const VERSION: &str = "v0.7.1";
pub const DENO_FLOOR: &str = "2.8.0";

pub struct Pinned<'a> {
    pub url: &'a str,
    pub sha256: &'a str,
    /// The archive's single top-level directory.
    pub top: &'a str,
}

pub const PINNED: Pinned<'static> = Pinned {
    url: "https://tangled.org/kandake.africa/atmosphereinabox/archive/v0.7.1",
    sha256: "73bd22ac78ba137a2b5e9b8ffb88944232f1d25f0df42cdd5ab70e8d12bb526c",
    top: "atmosphereinabox-v0.7.1",
};

/// Holds the sha256 of the archive the checkout was installed from, so a
/// checkout from any other archive is installed again.
const INSTALLED: &str = ".hpy-installed";

/// The third octet Atmosphere in a Box's own default subnet uses, which a
/// sandbox created by hand would already hold.
const DEFAULT_SUBNET_OCTET: u8 = 249;

pub struct NetworkDir {
    pub dir: PathBuf,
    /// The sandbox's Compose project name: Atmosphere in a Box requires
    /// `^[a-z][a-z0-9-]*$`.
    pub project: String,
    /// The sandbox's network, chosen here because Atmosphere in a Box's
    /// `--subnet auto` needs a local Linux Docker engine and refuses Docker
    /// Desktop. Derived from the project's path, so it never changes for one
    /// project and two projects rarely share one.
    pub subnet: String,
}

fn subnet_for(digest: &[u8]) -> String {
    let octet = match digest[0] {
        DEFAULT_SUBNET_OCTET => DEFAULT_SUBNET_OCTET + 1,
        n => n,
    };
    format!("172.30.{octet}.0/24")
}

pub fn data_root() -> Result<PathBuf, Failure> {
    if let Some(dir) = std::env::var_os("HPY_DATA_DIR").filter(|d| !d.is_empty()) {
        return Ok(dir.into());
    }
    use etcetera::BaseStrategy;
    let strategy = etcetera::choose_base_strategy().map_err(Failure::runtime)?;
    Ok(strategy.data_dir().join("hpy"))
}

/// One sandbox per project, keyed by the project's canonical path so `.`,
/// symlinks and trailing slashes all land on the same one.
pub fn network_dir(data_root: &Path, project_root: &Path) -> Result<NetworkDir, Failure> {
    let canonical = std::fs::canonicalize(project_root).map_err(Failure::runtime)?;
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let hash = data_encoding::HEXLOWER.encode(&digest);
    let name: String = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name: String = name
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    // Truncating can leave a dangling separator.
    let name: String = name.chars().take(24).collect();
    let name = name.trim_end_matches('-');
    let slug = format!(
        "{}-{}",
        if name.is_empty() { "project" } else { name },
        &hash[..8]
    );
    Ok(NetworkDir {
        dir: data_root.join("networks").join(&slug),
        project: format!("hv-{slug}"),
        subnet: subnet_for(&digest),
    })
}

pub fn parse_deno_version(out: &str) -> Option<semver::Version> {
    let first = out.lines().next()?;
    let v = first.strip_prefix("deno ")?.split_whitespace().next()?;
    semver::Version::parse(v).ok()
}

pub async fn check_tools(r: &dyn Runner, cwd: &Path) -> Result<(), Failure> {
    let floor = semver::Version::parse(DENO_FLOOR).expect("floor parses");
    let deno = r
        .capture("deno", &["--version".into()], cwd)
        .await
        .map_err(|_| {
            Failure::usage(format!(
                "--network local needs Deno {DENO_FLOOR} or later: https://docs.deno.com/runtime/getting_started/installation/"
            ))
        })?;
    match parse_deno_version(&deno) {
        Some(v) if v >= floor => {}
        found => {
            return Err(Failure::usage(format!(
                "--network local needs Deno 2.8 or later (found {}); run `deno upgrade`",
                found
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "an unreadable version".into())
            )));
        }
    }
    r.capture("docker", &["compose".into(), "version".into()], cwd)
        .await
        .map_err(|_| {
            Failure::usage(
                "--network local needs Docker with Docker Compose v2 (`docker compose version` failed)",
            )
        })?;
    Ok(())
}

fn installed(checkout: &Path, pinned: &Pinned<'_>) -> bool {
    std::fs::read_to_string(checkout.join(INSTALLED)).is_ok_and(|sum| sum.trim() == pinned.sha256)
}

/// Downloads and unpacks the pinned archive unless the checkout is already
/// there. Runs no child, so it can be abandoned part way; `install_checkout`
/// finishes the job.
pub async fn fetch_checkout(
    http: &reqwest::Client,
    pinned: &Pinned<'_>,
    net: &NetworkDir,
    status: &dyn Fn(&str),
) -> Result<PathBuf, Failure> {
    let checkout = net.dir.join(pinned.top);
    if installed(&checkout, pinned) {
        return Ok(checkout);
    }
    // A checkout with state in it is a sandbox; re-extracting over it could
    // pair its state with files it was not made from. Finish the install instead.
    if !checkout.join("state").exists() {
        status(&format!("downloading Atmosphere in a Box {VERSION}"));
        let bytes = http
            .get(pinned.url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| Failure::runtime(format!("could not download Atmosphere in a Box: {e}")))?
            .bytes()
            .await
            .map_err(|e| {
                Failure::runtime(format!("could not download Atmosphere in a Box: {e}"))
            })?;
        let got = data_encoding::HEXLOWER.encode(&Sha256::digest(&bytes));
        if got != pinned.sha256 {
            return Err(Failure::runtime(format!(
                "the Atmosphere in a Box archive has sha256 {got}, which does not match the pinned {}; nothing was installed",
                pinned.sha256
            )));
        }
        std::fs::create_dir_all(&net.dir).map_err(Failure::runtime)?;
        if checkout.exists() {
            std::fs::remove_dir_all(&checkout).map_err(Failure::runtime)?;
        }
        // `unpack` refuses entries that would land outside the destination,
        // which is what makes unpacking a downloaded archive safe.
        tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..]))
            .unpack(&net.dir)
            .map_err(|e| Failure::runtime(format!("could not unpack Atmosphere in a Box: {e}")))?;
    }
    Ok(checkout)
}

/// Caches the checkout's dependencies at exactly the versions its shipped
/// `deno.lock` names, once per archive.
///
/// This is the `install` task's own command rather than `deno task install
/// --frozen`: the task runner also reads `package.json`, whose
/// devDependencies the shipped lock leaves out, so it refuses a frozen
/// install of the pristine v0.7.1 archive.
pub async fn install_checkout(
    r: &dyn Runner,
    pinned: &Pinned<'_>,
    checkout: &Path,
) -> Result<(), Failure> {
    if installed(checkout, pinned) {
        return Ok(());
    }
    must_with_env(
        r,
        "deno",
        &[
            "install",
            "--frozen",
            "--entrypoint",
            "bin/sandbox.ts",
            "runtime/accounts.mjs",
        ]
        .map(String::from),
        &[("DENO_NO_PACKAGE_JSON", "1")],
        checkout,
    )
    .await?;
    std::fs::write(checkout.join(INSTALLED), pinned.sha256).map_err(Failure::runtime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::network::runner::FakeRunner;
    use sha2::{Digest, Sha256};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const FROZEN_INSTALL: &str = "DENO_NO_PACKAGE_JSON=1 deno install --frozen --entrypoint bin/sandbox.ts runtime/accounts.mjs";

    #[test]
    fn deno_versions_parse() {
        assert_eq!(
            parse_deno_version("deno 2.8.3 (stable, release, aarch64-apple-darwin)\nv8 14.0\n"),
            Some(semver::Version::new(2, 8, 3))
        );
        assert_eq!(parse_deno_version("something else"), None);
    }

    #[tokio::test]
    async fn an_old_deno_or_no_compose_is_a_usage_error() {
        let dir = tempfile::tempdir().unwrap();
        let old = FakeRunner::answering(&[("deno --version", Ok("deno 2.7.9 (stable)\n"))]);
        let err = check_tools(&old, dir.path()).await.unwrap_err();
        assert!(
            format!("{:?}", err.report).contains("Deno 2.8"),
            "{:?}",
            err.report
        );
        let no_compose = FakeRunner::answering(&[
            ("deno --version", Ok("deno 2.8.3 (stable)\n")),
            ("docker compose version", Err("unknown command")),
        ]);
        let err = check_tools(&no_compose, dir.path()).await.unwrap_err();
        assert!(format!("{:?}", err.report).contains("Docker Compose"));
    }

    #[test]
    fn the_network_dir_is_stable_for_one_project() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let app = project.path().join("My_Cool.App");
        std::fs::create_dir(&app).unwrap();
        let a = network_dir(data.path(), &app).unwrap();
        let b = network_dir(data.path(), &app.join(".")).unwrap();
        assert_eq!(a.dir, b.dir);
        assert!(a.project.starts_with("hv-my-cool-app-"), "{}", a.project);
        assert!(
            a.project
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        );
        assert!(a.dir.starts_with(data.path().join("networks")));
        assert_eq!(a.subnet, b.subnet);
    }

    #[test]
    fn each_project_gets_its_own_subnet_and_never_the_default() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let subnets: std::collections::BTreeSet<String> = (0..64)
            .map(|i| {
                let app = project.path().join(format!("app-{i}"));
                std::fs::create_dir(&app).unwrap();
                network_dir(data.path(), &app).unwrap().subnet
            })
            .collect();
        // Derived from a hash: 64 projects land on well over one /24.
        assert!(subnets.len() > 32, "{subnets:?}");
        for subnet in &subnets {
            assert!(subnet.starts_with("172.30.") && subnet.ends_with(".0/24"));
        }
        assert_eq!(subnet_for(&[249]), "172.30.250.0/24");
        assert_eq!(subnet_for(&[7]), "172.30.7.0/24");
    }

    #[test]
    fn truncating_a_long_name_leaves_no_dangling_separator() {
        let data = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        // The 24th character is a separator.
        let app = project.path().join(format!("{}-tail", "a".repeat(23)));
        std::fs::create_dir(&app).unwrap();
        let net = network_dir(data.path(), &app).unwrap();
        assert!(net.project.starts_with(&format!("hv-{}-", "a".repeat(23))));
        assert!(!net.project.contains("--"), "{}", net.project);
    }

    fn archive(top: &str) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let body = b"{\"tasks\":{}}";
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, format!("{top}/deno.json"), &body[..])
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[tokio::test]
    async fn installs_once_and_refuses_a_wrong_archive() {
        let server = MockServer::start().await;
        let bytes = archive("atmosphereinabox-v0.7.1");
        Mock::given(method("GET"))
            .and(path("/archive/v0.7.1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
            .mount(&server)
            .await;
        let sum = data_encoding::HEXLOWER.encode(&Sha256::digest(&bytes));
        let url = format!("{}/archive/v0.7.1", server.uri());
        let data = tempfile::tempdir().unwrap();
        let net = NetworkDir {
            dir: data.path().join("networks/x"),
            project: "hv-x".into(),
            subnet: "172.30.1.0/24".into(),
        };
        let runner = FakeRunner::default();
        let good = Pinned {
            url: &url,
            sha256: &sum,
            top: "atmosphereinabox-v0.7.1",
        };
        let http = crate::project::binary::http_client();
        let checkout = fetch_checkout(&http, &good, &net, &|_| {}).await.unwrap();
        assert!(checkout.join("deno.json").is_file());
        assert!(runner.calls().is_empty(), "fetching runs nothing");
        install_checkout(&runner, &good, &checkout).await.unwrap();
        assert_eq!(runner.calls(), [FROZEN_INSTALL]);
        assert_eq!(
            std::fs::read_to_string(checkout.join(INSTALLED)).unwrap(),
            sum
        );
        fetch_checkout(&http, &good, &net, &|_| {}).await.unwrap();
        install_checkout(&runner, &good, &checkout).await.unwrap();
        assert_eq!(runner.calls().len(), 1, "a second run reinstalled");

        // A marker from another archive (or the version-only marker an
        // earlier hpy wrote) is not this archive's install.
        std::fs::write(checkout.join(INSTALLED), VERSION).unwrap();
        install_checkout(&runner, &good, &checkout).await.unwrap();
        assert_eq!(runner.calls().len(), 2, "a stale marker was trusted");

        let other = NetworkDir {
            dir: data.path().join("networks/y"),
            project: "hv-y".into(),
            subnet: "172.30.2.0/24".into(),
        };
        let bad = Pinned {
            url: &url,
            sha256: &"0".repeat(64),
            top: "atmosphereinabox-v0.7.1",
        };
        let err = fetch_checkout(&http, &bad, &other, &|_| {})
            .await
            .unwrap_err();
        assert!(format!("{:?}", err.report).contains("does not match the pinned"));
        assert!(!other.dir.join("atmosphereinabox-v0.7.1").exists());
    }

    #[tokio::test]
    async fn an_interrupted_install_never_touches_state() {
        let server = MockServer::start().await;
        let data = tempfile::tempdir().unwrap();
        let net = NetworkDir {
            dir: data.path().join("networks/x"),
            project: "hv-x".into(),
            subnet: "172.30.1.0/24".into(),
        };
        let checkout = net.dir.join("atmosphereinabox-v0.7.1");
        std::fs::create_dir_all(checkout.join("state")).unwrap();
        std::fs::write(checkout.join("state/accounts.json"), "{}").unwrap();
        let runner = FakeRunner::default();
        let url = format!("{}/never", server.uri());
        let pinned = Pinned {
            url: &url,
            sha256: &"0".repeat(64),
            top: "atmosphereinabox-v0.7.1",
        };
        let fetched = fetch_checkout(
            &crate::project::binary::http_client(),
            &pinned,
            &net,
            &|_| {},
        )
        .await
        .unwrap();
        install_checkout(&runner, &pinned, &fetched).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(checkout.join("state/accounts.json")).unwrap(),
            "{}"
        );
        assert_eq!(runner.calls(), [FROZEN_INSTALL]);
    }
}
