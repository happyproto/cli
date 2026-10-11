//! Update checks, on the first command of each UTC day.
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

use crate::clock;

const REPO: &str = "happyproto/cli";
const GITHUB_API: &str = "https://api.github.com";
/// The name dist's installers use for receipts and artifacts: the package's.
const APP: &str = "hpy-cli";
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const WAIT: Duration = Duration::from_secs(2);

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

pub fn upgrade_hint(install: Install) -> String {
    match install {
        Install::Homebrew => "brew upgrade hpy".into(),
        Install::Apt => "sudo apt update && sudo apt install --only-upgrade hpy".into(),
        Install::Dnf => "sudo dnf upgrade hpy".into(),
        Install::Cargo => format!("cargo install --git https://github.com/{REPO} hpy-cli --force"),
        Install::Script | Install::Unknown => {
            format!("download it from https://github.com/{REPO}/releases/latest")
        }
    }
}

/// The latest version when it is a stable release newer than `current`.
pub fn newer(current: &str, latest_tag: &str) -> Option<String> {
    let latest = semver::Version::parse(latest_tag.trim_start_matches('v')).ok()?;
    let current = semver::Version::parse(current).ok()?;
    (latest.pre.is_empty() && latest > current).then(|| latest.to_string())
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

/// The tag of the latest stable release, or `None` on any failure: an update
/// check must never get in the way of the command.
pub async fn latest_tag(api_base: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }
    let resp = http()?
        .get(format!("{api_base}/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Release>().await.ok().map(|r| r.tag_name)
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

enum Found {
    SelfUpdate { latest: String, prefix: PathBuf },
    Notice { latest: String, hint: String },
}

async fn check() -> Option<Found> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let install = detect(&facts(exe.clone()));
    let latest = newer(CURRENT, &latest_tag(GITHUB_API).await?)?;
    Some(match install {
        Install::Script => Found::SelfUpdate {
            latest,
            prefix: script_prefix(&exe)?,
        },
        install => Found::Notice {
            latest,
            hint: upgrade_hint(install),
        },
    })
}

/// Downloads the release's installer and runs it into the same prefix.
async fn self_update(latest: &str, prefix: &Path) -> Result<(), String> {
    let windows = cfg!(windows);
    let script = http()
        .ok_or("no HTTP client")?
        .get(installer_url(latest, windows))
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
pub fn start(state_file: PathBuf) -> Option<Pending> {
    if !enabled(&env_var, std::io::stderr().is_terminal()) {
        return None;
    }
    let today = clock::today_utc();
    if !due(read_last_checked(&state_file).as_deref(), &today) {
        return None;
    }
    // Recorded up front, so a failed or slow check is not retried by every
    // command for the rest of the day.
    let _ = write_last_checked(&state_file, &today);
    Some(Pending(tokio::spawn(check())))
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
                Err(e) => eprintln!(
                    "Could not update hpy automatically ({e}). To update by hand: \
                     curl -fsSL https://happyproto.github.io/cli/install.sh | sh"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn tells_package_manager_users_how_to_upgrade() {
        assert!(upgrade_hint(Install::Homebrew).contains("brew upgrade hpy"));
        assert!(upgrade_hint(Install::Apt).contains("apt install --only-upgrade hpy"));
        assert!(upgrade_hint(Install::Dnf).contains("dnf upgrade hpy"));
        assert!(upgrade_hint(Install::Cargo).contains("cargo install"));
        assert!(upgrade_hint(Install::Unknown).contains("releases/latest"));
    }

    #[test]
    fn only_newer_stable_versions_count() {
        assert_eq!(newer("0.1.0", "v0.2.0"), Some("0.2.0".to_string()));
        assert_eq!(newer("0.2.0", "v0.2.0"), None);
        assert_eq!(newer("0.3.0", "v0.2.0"), None);
        assert_eq!(newer("0.2.0-beta.1", "v0.2.0"), Some("0.2.0".to_string()));
        assert_eq!(newer("0.1.0", "garbage"), None);
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
    async fn reads_the_latest_release_tag() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/happyproto/cli/releases/latest"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "tag_name": "v1.4.0" })),
            )
            .mount(&server)
            .await;
        assert_eq!(latest_tag(&server.uri()).await.as_deref(), Some("v1.4.0"));
        assert_eq!(latest_tag("http://127.0.0.1:9").await, None);
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
