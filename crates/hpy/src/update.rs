//! Update checks, on the first command of each UTC day, and the installing
//! that `hpy update` and `hpy channel` share. Only the newest release on the
//! channel being followed counts (see `channel`).
//!
//! The check runs in the background while the command does its work, and the
//! command waits for it at most a couple of seconds at the end. A copy of `hpy`
//! installed by the shell/PowerShell installer (it left an install receipt)
//! updates itself by re-running the new release's installer into the same
//! place; one installed by Homebrew, apt, dnf or cargo belongs to that package
//! manager, so `hpy` only says how to upgrade it.
//!
//! Never in CI, without a terminal, or with `HPY_NO_UPDATE_CHECK` set.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::channel::{self, Channel, Release, Version};
use crate::clock;

const REPO: &str = "happyproto/cli";
const GITHUB_API: &str = "https://api.github.com";
/// The name dist's installers use for receipts and artifacts: the package's.
const APP: &str = "hpy-cli";
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const WAIT: Duration = Duration::from_secs(2);
/// The apt and yum repositories, on GitHub Pages.
const PACKAGES: &str = "https://happyproto.github.io/cli";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Install {
    Script,
    Homebrew,
    Apt,
    Dnf,
    Cargo,
    Unknown,
}

/// What `detect` decides from, gathered by `facts`.
pub struct Facts {
    pub exe: PathBuf,
    pub script_receipt: bool,
    pub dpkg_owned: bool,
    pub rpm_owned: bool,
}

pub fn due(last_checked: Option<&str>, today: &str) -> bool {
    last_checked != Some(today)
}

pub fn enabled(env: &dyn Fn(&str) -> Option<String>, terminal: bool) -> bool {
    terminal && env("CI").is_none() && env("HPY_NO_UPDATE_CHECK").is_none()
}

pub fn detect(f: &Facts) -> Install {
    if f.script_receipt {
        return Install::Script;
    }
    let path = f.exe.to_string_lossy();
    if path.contains("/Cellar/")
        || path.starts_with("/opt/homebrew/")
        || path.contains("/.linuxbrew/")
    {
        Install::Homebrew
    } else if f.dpkg_owned {
        Install::Apt
    } else if f.rpm_owned {
        Install::Dnf
    } else if path.contains("/.cargo/bin/") || path.contains("\\.cargo\\bin\\") {
        Install::Cargo
    } else {
        Install::Unknown
    }
}

/// The Homebrew formula each channel is published as.
pub fn formula(channel: Channel) -> String {
    match channel {
        Channel::Stable => "hpy".into(),
        other => format!("hpy-{other}"),
    }
}

/// The yum repository definition for each channel.
fn yum_repo(channel: Channel) -> String {
    match channel {
        Channel::Stable => format!("{PACKAGES}/hpy.repo"),
        other => format!("{PACKAGES}/hpy-{other}.repo"),
    }
}

/// A version as a .deb names it: nfpm writes a prerelease after `~`, which
/// sorts before the release it precedes.
fn deb_version(v: &Version) -> String {
    if v.pre.is_empty() {
        v.to_string()
    } else {
        format!("{}.{}.{}~{}", v.major, v.minor, v.patch, v.pre)
    }
}

fn release_page(version: &Version) -> String {
    format!("https://github.com/{REPO}/releases/tag/v{version}")
}

/// How to upgrade to `version`, the newest on `channel`, when a package
/// manager owns this copy of hpy.
pub fn upgrade_hint(install: Install, channel: Channel, version: &Version) -> String {
    match install {
        Install::Homebrew => format!("brew upgrade {}", formula(channel)),
        Install::Apt => "sudo apt update && sudo apt install --only-upgrade hpy".into(),
        Install::Dnf => "sudo dnf upgrade hpy".into(),
        Install::Cargo => format!(
            "cargo install --git https://github.com/{REPO} --tag v{version} hpy-cli --force"
        ),
        Install::Script | Install::Unknown => {
            format!("download it from {}", release_page(version))
        }
    }
}

/// How to move a package manager's copy of hpy from channel `from` to `to`,
/// whose newest release is `version` (possibly older than the one installed).
pub fn switch_hint(install: Install, from: Channel, to: Channel, version: &Version) -> String {
    match install {
        Install::Homebrew => format!(
            "brew uninstall {} && brew install happyproto/tap/{}",
            formula(from),
            formula(to)
        ),
        Install::Apt => [
            format!(
                "sudo sed -i 's#/deb [a-z]* main#/deb {to} main#' /etc/apt/sources.list.d/hpy.list"
            ),
            "sudo apt update".into(),
            format!(
                "sudo apt install --allow-downgrades hpy={}",
                deb_version(version)
            ),
        ]
        .join(" && "),
        // distro-sync moves to the newest the enabled repository has, down
        // as well as up.
        Install::Dnf => format!(
            "sudo curl -fsSL {} -o /etc/yum.repos.d/hpy.repo && sudo dnf distro-sync hpy",
            yum_repo(to)
        ),
        install => upgrade_hint(install, to, version),
    }
}

/// The newest release on `channel`, when it is newer than `current`.
pub fn available(current: &Version, channel: Channel, releases: &[Release]) -> Option<Version> {
    channel::latest_on(channel, releases).filter(|latest| latest > current)
}

/// The running version.
pub fn current() -> Version {
    Version::parse(CURRENT).expect("the crate version is semver")
}

#[derive(Serialize, Deserialize)]
struct State {
    last_checked: String,
}

pub fn read_last_checked(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    toml::from_str::<State>(&text).ok().map(|s| s.last_checked)
}

pub fn write_last_checked(path: &Path, day: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = toml::to_string(&State {
        last_checked: day.into(),
    })
    .map_err(std::io::Error::other)?;
    std::fs::write(path, text)
}

/// Where dist's installers write their receipt (the same place `axoupdater`
/// reads it from).
pub fn receipt_path(env: &dyn Fn(&str) -> Option<String>, windows: bool) -> Option<PathBuf> {
    let base = if windows {
        PathBuf::from(env("LOCALAPPDATA")?)
    } else {
        match env("XDG_CONFIG_HOME") {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(env("HOME")?).join(".config"),
        }
    };
    Some(base.join(APP).join(format!("{APP}-receipt.json")))
}

pub fn receipt_prefix(receipt: &str) -> Option<PathBuf> {
    #[derive(Deserialize)]
    struct Receipt {
        install_prefix: PathBuf,
    }
    serde_json::from_str::<Receipt>(receipt)
        .ok()
        .map(|r| r.install_prefix)
}

/// Whether `exe` is the binary a receipt with this install prefix put there,
/// and not, say, a package manager's copy on a machine that also once ran the
/// installer. The installer puts binaries in `<prefix>/bin` or `<prefix>`.
pub fn installed_by_receipt(exe: &Path, prefix: &Path) -> bool {
    let (Ok(exe), Ok(prefix)) = (exe.canonicalize(), prefix.canonicalize()) else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    dir == prefix
        || (dir.file_name().is_some_and(|n| n == "bin") && dir.parent() == Some(prefix.as_path()))
}

pub fn installer_url(version: &str, windows: bool) -> String {
    let ext = if windows { "ps1" } else { "sh" };
    format!("https://github.com/{REPO}/releases/download/v{version}/{APP}-installer.{ext}")
}

fn http() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("hpy/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .ok()
}

/// The repo's newest releases, or `None` on any failure: an update check must
/// never get in the way of the command.
pub async fn list_releases(api_base: &str) -> Option<Vec<Release>> {
    let resp = http()?
        .get(format!("{api_base}/repos/{REPO}/releases"))
        .query(&[("per_page", "100")])
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Vec<Release>>().await.ok()
}

/// The releases, for a command that cannot go on without them.
pub async fn releases() -> Result<Vec<Release>, String> {
    list_releases(GITHUB_API)
        .await
        .ok_or_else(|| format!("could not list hpy's releases on GitHub (github.com/{REPO})"))
}

fn env_var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

/// The install prefix, when this executable came from the installer.
fn script_prefix(exe: &Path) -> Option<PathBuf> {
    let receipt = std::fs::read_to_string(receipt_path(&env_var, cfg!(windows))?).ok()?;
    let prefix = receipt_prefix(&receipt)?;
    installed_by_receipt(exe, &prefix).then_some(prefix)
}

fn facts(exe: PathBuf) -> Facts {
    let under_usr = exe.starts_with("/usr/");
    let dpkg_owned = under_usr && Path::new("/var/lib/dpkg/info/hpy.list").exists();
    let rpm_owned = under_usr
        && !dpkg_owned
        && std::process::Command::new("rpm")
            .arg("-qf")
            .arg(&exe)
            .output()
            .is_ok_and(|o| o.status.success());
    Facts {
        script_receipt: script_prefix(&exe).is_some(),
        exe,
        dpkg_owned,
        rpm_owned,
    }
}

/// How this copy of hpy was installed; for the installer's, where to.
pub struct This {
    pub install: Install,
    pub prefix: Option<PathBuf>,
}

pub fn this_install() -> Option<This> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let install = detect(&facts(exe.clone()));
    let prefix = (install == Install::Script)
        .then(|| script_prefix(&exe))
        .flatten();
    Some(This { install, prefix })
}

/// The channel to follow, given the config directory.
pub fn following(config_dir: &Path) -> Channel {
    channel::effective(channel::read(&channel_file(config_dir)), &current())
}

pub fn channel_file(config_dir: &Path) -> PathBuf {
    config_dir.join("channel.toml")
}

enum Found {
    SelfUpdate { latest: Version, prefix: PathBuf },
    Notice { latest: Version, hint: String },
}

async fn check(config_dir: PathBuf) -> Option<Found> {
    let this = this_install()?;
    let channel = following(&config_dir);
    let latest = available(&current(), channel, &list_releases(GITHUB_API).await?)?;
    Some(match (this.install, this.prefix) {
        (Install::Script, Some(prefix)) => Found::SelfUpdate { latest, prefix },
        (install, _) => Found::Notice {
            hint: upgrade_hint(install, channel, &latest),
            latest,
        },
    })
}

/// Downloads the release's installer and runs it into the same prefix.
pub async fn self_update(latest: &Version, prefix: &Path) -> Result<(), String> {
    let windows = cfg!(windows);
    let script = http()
        .ok_or("no HTTP client")?
        .get(installer_url(&latest.to_string(), windows))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let dir = tempfile_dir()?;
    let path = dir.join(if windows {
        "installer.ps1"
    } else {
        "installer.sh"
    });
    std::fs::write(&path, &script).map_err(|e| e.to_string())?;
    let mut cmd = if windows {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg(&path).arg("--quiet");
        c
    };
    let output = cmd
        .env("CARGO_DIST_FORCE_INSTALL_DIR", prefix)
        // PATH was set up by the first install; don't touch shell profiles again.
        .env("INSTALLER_NO_MODIFY_PATH", "1")
        .env("HPY_CLI_NO_MODIFY_PATH", "1")
        .output()
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&dir);
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn tempfile_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("hpy-update-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A check started by `start`, finished by `finish`.
pub struct Pending(tokio::task::JoinHandle<Option<Found>>);

/// Starts today's check if this is the first command of the UTC day.
pub fn start(config_dir: PathBuf) -> Option<Pending> {
    if !enabled(&env_var, std::io::stderr().is_terminal()) {
        return None;
    }
    let state_file = config_dir.join("update-check.toml");
    let today = clock::today_utc();
    if !due(read_last_checked(&state_file).as_deref(), &today) {
        return None;
    }
    // Recorded up front, so a failed or slow check is not retried by every
    // command for the rest of the day.
    let _ = write_last_checked(&state_file, &today);
    Some(Pending(tokio::spawn(check(config_dir))))
}

/// Waits briefly for the check, then updates or says how to.
pub async fn finish(pending: Option<Pending>) {
    let Some(Pending(handle)) = pending else {
        return;
    };
    let Ok(Ok(Some(found))) = tokio::time::timeout(WAIT, handle).await else {
        return;
    };
    match found {
        Found::Notice { latest, hint } => {
            eprintln!("\nhpy {latest} is available (you have {CURRENT}). To upgrade: {hint}");
        }
        Found::SelfUpdate { latest, prefix } => {
            eprintln!("\nUpdating hpy {CURRENT} → {latest}…");
            match self_update(&latest, &prefix).await {
                Ok(()) => eprintln!("Updated hpy to {latest}."),
                Err(e) => eprintln!("{}", self_update_failed(&latest, &e)),
            }
        }
    }
}

pub fn self_update_failed(latest: &Version, error: &str) -> String {
    format!(
        "Could not update hpy automatically ({error}). To update by hand: curl -fsSL {} | sh",
        installer_url(&latest.to_string(), false)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::Release;
    use std::path::PathBuf;

    fn facts(exe: &str) -> Facts {
        Facts {
            exe: PathBuf::from(exe),
            script_receipt: false,
            dpkg_owned: false,
            rpm_owned: false,
        }
    }

    #[test]
    fn checks_on_the_first_command_of_each_utc_day() {
        assert!(due(None, "2026-10-09"));
        assert!(!due(Some("2026-10-09"), "2026-10-09"));
        assert!(due(Some("2026-10-08"), "2026-10-09"));
        // a clock that went backwards still checks once on the new day
        assert!(due(Some("2026-10-10"), "2026-10-09"));
    }

    #[test]
    fn never_checks_in_ci_or_when_disabled_or_without_a_terminal() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(enabled(&env(&[]), true));
        assert!(!enabled(&env(&[]), false));
        assert!(!enabled(&env(&[("CI", "true")]), true));
        assert!(!enabled(&env(&[("HPY_NO_UPDATE_CHECK", "1")]), true));
    }

    #[test]
    fn detects_how_hpy_was_installed() {
        assert_eq!(
            detect(&Facts {
                script_receipt: true,
                ..facts("/Users/a/.cargo/bin/hpy")
            }),
            Install::Script
        );
        assert_eq!(
            detect(&facts("/opt/homebrew/Cellar/hpy/0.1.0/bin/hpy")),
            Install::Homebrew
        );
        assert_eq!(
            detect(&facts(
                "/home/linuxbrew/.linuxbrew/Cellar/hpy/0.1.0/bin/hpy"
            )),
            Install::Homebrew
        );
        assert_eq!(
            detect(&Facts {
                dpkg_owned: true,
                ..facts("/usr/bin/hpy")
            }),
            Install::Apt
        );
        assert_eq!(
            detect(&Facts {
                rpm_owned: true,
                ..facts("/usr/bin/hpy")
            }),
            Install::Dnf
        );
        assert_eq!(detect(&facts("/Users/a/.cargo/bin/hpy")), Install::Cargo);
        assert_eq!(detect(&facts("/tmp/hpy")), Install::Unknown);
    }

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn releases(tags: &[&str]) -> Vec<Release> {
        tags.iter()
            .map(|t| Release {
                tag: t.to_string(),
                draft: false,
            })
            .collect()
    }

    #[test]
    fn tells_package_manager_users_how_to_upgrade_on_their_channel() {
        let alpha = v("1.1.0-alpha.2");
        assert_eq!(
            upgrade_hint(Install::Homebrew, Channel::Stable, &v("1.1.0")),
            "brew upgrade hpy"
        );
        assert_eq!(
            upgrade_hint(Install::Homebrew, Channel::Alpha, &alpha),
            "brew upgrade hpy-alpha"
        );
        assert!(
            upgrade_hint(Install::Apt, Channel::Alpha, &alpha)
                .contains("apt install --only-upgrade hpy")
        );
        assert!(upgrade_hint(Install::Dnf, Channel::Alpha, &alpha).contains("dnf upgrade hpy"));
        assert!(
            upgrade_hint(Install::Cargo, Channel::Alpha, &alpha).contains("--tag v1.1.0-alpha.2")
        );
        assert!(
            upgrade_hint(Install::Unknown, Channel::Alpha, &alpha)
                .ends_with("/releases/tag/v1.1.0-alpha.2")
        );
    }

    #[test]
    fn tells_package_manager_users_how_to_switch_channel() {
        let alpha = v("1.1.0-alpha.2");
        assert_eq!(
            switch_hint(Install::Homebrew, Channel::Stable, Channel::Alpha, &alpha),
            "brew uninstall hpy && brew install happyproto/tap/hpy-alpha"
        );
        let apt = switch_hint(Install::Apt, Channel::Stable, Channel::Alpha, &alpha);
        assert!(apt.contains("/deb alpha main"), "{apt}");
        // apt never picks a lower version on its own, so name it exactly
        assert!(apt.contains("hpy=1.1.0~alpha.2"), "{apt}");
        let dnf = switch_hint(Install::Dnf, Channel::Alpha, Channel::Stable, &v("1.0.0"));
        assert!(dnf.contains("/hpy.repo"), "{dnf}");
        assert!(dnf.contains("dnf distro-sync hpy"), "{dnf}");
        assert!(
            switch_hint(
                Install::Dnf,
                Channel::Stable,
                Channel::Beta,
                &v("1.1.0-beta.1")
            )
            .contains("/hpy-beta.repo")
        );
    }

    #[test]
    fn only_newer_versions_on_the_channel_count() {
        let all = releases(&["v1.0.0", "v1.1.0", "v1.2.0-alpha.1", "v1.2.0-alpha.2"]);
        assert_eq!(
            available(&v("1.0.0"), Channel::Stable, &all),
            Some(v("1.1.0"))
        );
        assert_eq!(available(&v("1.1.0"), Channel::Stable, &all), None);
        assert_eq!(
            available(&v("1.2.0-alpha.1"), Channel::Alpha, &all),
            Some(v("1.2.0-alpha.2"))
        );
        // strict: a newer stable is not offered on alpha
        let later = releases(&["v1.2.0-alpha.2", "v2.0.0"]);
        assert_eq!(available(&v("1.2.0-alpha.2"), Channel::Alpha, &later), None);
        assert_eq!(available(&v("1.0.0"), Channel::Beta, &all), None);
    }

    #[test]
    fn state_round_trips_and_a_corrupt_file_reads_as_never_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hpy/update-check.toml");
        assert_eq!(read_last_checked(&path), None);
        write_last_checked(&path, "2026-10-09").unwrap();
        assert_eq!(read_last_checked(&path).as_deref(), Some("2026-10-09"));
        std::fs::write(&path, "not toml [").unwrap();
        assert_eq!(read_last_checked(&path), None);
    }

    #[tokio::test]
    async fn lists_the_releases_skipping_drafts_downstream() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/happyproto/cli/releases"))
            .and(query_param("per_page", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "tag_name": "v1.4.0-alpha.1", "draft": false, "prerelease": true },
                { "tag_name": "v1.3.0", "draft": false, "prerelease": false }
            ])))
            .mount(&server)
            .await;
        let found = list_releases(&server.uri()).await.unwrap();
        assert_eq!(
            found.iter().map(|r| r.tag.as_str()).collect::<Vec<_>>(),
            ["v1.4.0-alpha.1", "v1.3.0"]
        );
        assert!(list_releases("http://127.0.0.1:9").await.is_none());
    }

    #[test]
    fn finds_the_installer_receipt() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(
            receipt_path(&env(&[("XDG_CONFIG_HOME", "/x"), ("HOME", "/h")]), false),
            Some(PathBuf::from("/x/hpy-cli/hpy-cli-receipt.json"))
        );
        assert_eq!(
            receipt_path(&env(&[("HOME", "/h")]), false),
            Some(PathBuf::from("/h/.config/hpy-cli/hpy-cli-receipt.json"))
        );
        assert_eq!(
            receipt_path(&env(&[("LOCALAPPDATA", "C:/l")]), true),
            Some(PathBuf::from("C:/l/hpy-cli/hpy-cli-receipt.json"))
        );
        assert_eq!(receipt_path(&env(&[]), false), None);
    }

    #[test]
    fn a_receipt_counts_only_for_the_binary_it_installed() {
        let dir = tempfile::tempdir().unwrap();
        let prefix = dir.path().join(".cargo");
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        std::fs::write(prefix.join("bin/hpy"), "").unwrap();
        let receipt = format!(
            r#"{{"install_prefix":{:?},"version":"0.1.0","binaries":["hpy"]}}"#,
            prefix.to_str().unwrap()
        );
        let prefix_read = receipt_prefix(&receipt).unwrap();
        assert!(installed_by_receipt(&prefix.join("bin/hpy"), &prefix_read));
        let elsewhere = dir.path().join("usr/bin");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("hpy"), "").unwrap();
        assert!(!installed_by_receipt(&elsewhere.join("hpy"), &prefix_read));
        assert_eq!(receipt_prefix("{"), None);
    }

    #[test]
    fn the_installer_url_follows_the_release() {
        assert_eq!(
            installer_url("1.4.0", false),
            "https://github.com/happyproto/cli/releases/download/v1.4.0/hpy-cli-installer.sh"
        );
        assert!(installer_url("1.4.0", true).ends_with("/v1.4.0/hpy-cli-installer.ps1"));
    }
}
