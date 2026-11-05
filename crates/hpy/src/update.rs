//! Update checks, on the first command of each UTC day, and the installing
//! that `hpy update` and `hpy channel` share. Only the newest release on the
//! channel being followed counts (see `channel`).
//!
//! The check runs in the background while the command does its work, and the
//! command waits for it at most a couple of seconds at the end. A copy of `hpy`
//! installed by the shell/PowerShell installer (it left an install receipt)
//! updates itself by re-running the new release's installer into the same
//! place, or, where that place is not writable (the shell installer's
//! `/usr/local/bin`), by running it into a temporary directory and asking sudo
//! to copy the binary over this one; one installed by Homebrew, apt, dnf or
//! cargo belongs to that package manager, so `hpy` only says how to upgrade it.
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
        // `--locked`: without it cargo re-resolves from scratch and builds
        // a dependency set nobody tested, which is also how a yanked
        // transitive dependency makes the build fail outright.
        Install::Cargo => format!(
            "cargo install --git https://github.com/{REPO} --tag v{version} --locked hpy-cli --force"
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

/// Where a self-update may write, or `None` when something else owns this
/// copy and has to be the one to replace it.
///
/// Homebrew, apt and dnf keep a database of the files they own: a binary
/// swapped underneath one leaves its records describing a version that is no
/// longer there, and its next upgrade reverts the swap. Those are told how to
/// upgrade with the manager instead. Nothing defends the other two —
/// `cargo install` builds and copies into a directory the user owns, and an
/// unknown install is a binary sitting somewhere — so for those the prefix is
/// the directory this executable is in, when it can be written to. Falling
/// back to the hint on a read-only directory keeps the failure a sentence
/// rather than a half-finished install.
pub fn self_update_prefix(install: Install, exe: &Path) -> Option<PathBuf> {
    match install {
        Install::Script => script_prefix(exe),
        Install::Cargo | Install::Unknown => {
            exe.parent().filter(|dir| writable(dir)).map(PathBuf::from)
        }
        Install::Homebrew | Install::Apt | Install::Dnf => None,
    }
}

/// Whether a directory can be written to, answered by writing to it: the
/// permission bits alone do not account for an owner, an ACL or a read-only
/// mount.
fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".hpy-update-{}", std::process::id()));
    // `create_new` so a name that somehow exists is never truncated.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
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
    pub exe: PathBuf,
    pub install: Install,
    pub prefix: Option<PathBuf>,
}

pub fn this_install() -> Option<This> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let install = detect(&facts(exe.clone()));
    let prefix = self_update_prefix(install, &exe);
    Some(This {
        exe,
        install,
        prefix,
    })
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
    let here_writable = this.exe.parent().is_some_and(writable);
    Some(match (this.install, this.prefix) {
        // Replacing it would need sudo, which is `hpy update`'s to ask for,
        // not a password prompt at the end of some other command.
        (_, Some(_)) if !here_writable && !cfg!(windows) => Found::Notice {
            hint: "hpy update".into(),
            latest,
        },
        (_, Some(prefix)) => Found::SelfUpdate { latest, prefix },
        (install, _) => Found::Notice {
            hint: upgrade_hint(install, channel, &latest),
            latest,
        },
    })
}

/// Whether a self-update may ask sudo to replace a copy of hpy in a
/// directory this user cannot write to (the shell installer's
/// `/usr/local/bin`). `hpy update` and `hpy channel` may; the daily check,
/// which runs behind another command, never does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Escalate {
    Never,
    Ask,
}

/// Why a self-update did not happen.
#[derive(Debug)]
pub enum SelfUpdateError {
    /// The download or the installer failed.
    Failed(String),
    /// This copy is in a directory only root can write to, and sudo could not
    /// be used: there is no terminal for its password prompt, it failed, or
    /// the caller does not allow it. The message says exactly what to run.
    /// This copy of hpy is untouched.
    NeedsRoot(String),
}

/// Where the binary sits relative to the install prefix: dist's installer
/// puts it in `<prefix>/bin` (its `cargo-home` layout, the default and
/// `HPY_CLI_INSTALL_DIR`), or in `<prefix>` itself (the `flat` layout the
/// shell installer's `/usr/local/bin` copy is recorded with).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    Flat,
    Bin,
}

pub fn layout(exe: &Path, prefix: &Path) -> Option<Layout> {
    let (Ok(exe), Ok(prefix)) = (exe.canonicalize(), prefix.canonicalize()) else {
        return None;
    };
    let dir = exe.parent()?;
    if dir == prefix {
        Some(Layout::Flat)
    } else if dir == prefix.join("bin") {
        Some(Layout::Bin)
    } else {
        None
    }
}

/// Everything a self-update depends on, so that tests can stand in for each:
/// the installer's URL, the copy being replaced, whether there is a terminal,
/// and the program run as sudo.
pub(crate) struct Job<'a> {
    pub installer_url: String,
    /// This executable, canonical.
    pub exe: &'a Path,
    pub prefix: &'a Path,
    pub version: &'a Version,
    /// Whether sudo could ask for a password: `/dev/tty` opens.
    pub terminal: bool,
    /// `sudo`, found on PATH; a test points this at a shim.
    pub sudo: &'a std::ffi::OsStr,
    pub escalate: Escalate,
    /// The install receipt, whose version is brought up to date as this user.
    pub receipt: Option<PathBuf>,
}

/// Downloads the release's installer and runs it to replace this copy of hpy
/// where it is.
pub async fn self_update(
    latest: &Version,
    prefix: &Path,
    escalate: Escalate,
) -> Result<(), SelfUpdateError> {
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| SelfUpdateError::Failed(e.to_string()))?;
    run_job(Job {
        installer_url: installer_url(&latest.to_string(), cfg!(windows)),
        exe: &exe,
        prefix,
        version: latest,
        terminal: has_terminal(),
        sudo: std::ffi::OsStr::new("sudo"),
        escalate,
        receipt: receipt_path(&env_var, cfg!(windows)),
    })
    .await
}

/// Where a run of dist's installer puts hpy.
enum Target<'a> {
    /// `<dir>/bin/hpy`, with a receipt naming `<dir>`.
    CargoHome(&'a Path),
    /// `<dir>/hpy`, with no receipt and no change to shell profiles.
    Flat(&'a Path),
}

pub(crate) async fn run_job(job: Job<'_>) -> Result<(), SelfUpdateError> {
    use SelfUpdateError::{Failed, NeedsRoot};
    let windows = cfg!(windows);
    let script = http()
        .ok_or_else(|| Failed("no HTTP client".into()))?
        .get(&job.installer_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| Failed(e.to_string()))?
        .bytes()
        .await
        .map_err(|e| Failed(e.to_string()))?;
    // A fresh directory only this user can reach (0700), never a name
    // another user could have created first.
    let stage = tempfile::Builder::new()
        .prefix("hpy-update-")
        .tempdir()
        .map_err(|e| Failed(e.to_string()))?;
    let installer = stage.path().join(if windows {
        "installer.ps1"
    } else {
        "installer.sh"
    });
    std::fs::write(&installer, &script).map_err(|e| Failed(e.to_string()))?;

    if windows {
        return run_installer(&installer, Target::CargoHome(job.prefix)).map_err(Failed);
    }

    let dir = job
        .exe
        .parent()
        .ok_or_else(|| Failed("this copy of hpy is not in a directory".into()))?;
    let layout = layout(job.exe, job.prefix).ok_or_else(|| {
        Failed(format!(
            "{} is in neither {} nor its bin directory, where it was installed",
            job.exe.display(),
            job.prefix.display()
        ))
    })?;

    // Writable: the release's installer, into the same place, as before.
    if writable(dir) {
        match layout {
            // dist's installer writes the receipt itself.
            Layout::Bin => {
                run_installer(&installer, Target::CargoHome(job.prefix)).map_err(Failed)?
            }
            Layout::Flat => {
                run_installer(&installer, Target::Flat(job.prefix)).map_err(Failed)?;
                record_version(job.receipt.as_deref(), job.prefix, job.version);
            }
        }
        return Ok(());
    }

    // Not writable: only root can replace this copy.
    if job.escalate == Escalate::Never {
        return Err(NeedsRoot(format!(
            "{} is not writable by you; run `hpy update`, which asks sudo to replace it",
            dir.display()
        )));
    }
    let staged_dir = stage.path().join("bin");
    run_installer(&installer, Target::Flat(&staged_dir)).map_err(Failed)?;
    let staged = staged_dir.join("hpy");
    if !staged.is_file() {
        return Err(Failed(format!(
            "the installer did not leave hpy in {}",
            staged_dir.display()
        )));
    }
    let command = format!(
        "sudo install -m 0755 {} {}",
        shell_quote(&staged),
        shell_quote(job.exe)
    );
    if !job.terminal {
        // Kept, so the command stays runnable.
        let _ = stage.keep();
        return Err(NeedsRoot(format!(
            "{} is not writable by you, and with no terminal sudo cannot ask for your \
             password. hpy {} is downloaded; to put it in place of this copy, run:\n\n  \
             {command}\n\nThis copy of hpy was left as it was.",
            dir.display(),
            job.version,
        )));
    }
    eprintln!(
        "{} is not writable by you, so sudo will ask for your password to copy hpy {} over {}.",
        dir.display(),
        job.version,
        job.exe.display()
    );
    // The only command run as root: the copy. stdin and stderr stay the
    // terminal's, so sudo can prompt; stdout stays clear for `--json`.
    let status = std::process::Command::new(job.sudo)
        .args(["install", "-m", "0755"])
        .arg(&staged)
        .arg(job.exe)
        .stdout(std::process::Stdio::null())
        .status();
    if !status.is_ok_and(|s| s.success()) {
        let _ = stage.keep();
        return Err(NeedsRoot(format!(
            "sudo did not replace {}. To try again, run:\n\n  {command}\n\n\
             This copy of hpy was left as it was.",
            job.exe.display()
        )));
    }
    record_version(job.receipt.as_deref(), job.prefix, job.version);
    Ok(())
}

fn run_installer(installer: &Path, into: Target) -> Result<(), String> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(installer);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg(installer).arg("--quiet");
        c
    };
    // dist's installer takes HPY_CLI_INSTALL_DIR over the others, so one left
    // in the environment from an install must not redirect this one.
    cmd.env_remove("HPY_CLI_INSTALL_DIR")
        .env_remove("CARGO_DIST_FORCE_INSTALL_DIR")
        .env_remove("HPY_CLI_UNMANAGED_INSTALL");
    match into {
        Target::CargoHome(dir) => cmd.env("CARGO_DIST_FORCE_INSTALL_DIR", dir),
        Target::Flat(dir) => cmd.env("HPY_CLI_UNMANAGED_INSTALL", dir),
    };
    let output = cmd
        // PATH was set up by the first install; don't touch shell profiles again.
        .env("INSTALLER_NO_MODIFY_PATH", "1")
        .env("HPY_CLI_NO_MODIFY_PATH", "1")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Brings the receipt's version up to date after a copy dist's installer did
/// not record (a flat layout), as this user. Only a receipt for this prefix
/// is touched, and a failure is a warning: hpy itself is already replaced.
fn record_version(receipt: Option<&Path>, prefix: &Path, version: &Version) {
    let Some(receipt) = receipt else {
        return;
    };
    if let Err(e) = write_receipt_version(receipt, prefix, version) {
        eprintln!(
            "warning: could not record hpy {version} in {}: {e}",
            receipt.display()
        );
    }
}

pub(crate) fn write_receipt_version(
    receipt: &Path,
    prefix: &Path,
    version: &Version,
) -> std::io::Result<bool> {
    let text = match std::fs::read_to_string(receipt) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let same = receipt_prefix(&text).is_some_and(|p| {
        p == prefix || matches!((p.canonicalize(), prefix.canonicalize()), (Ok(a), Ok(b)) if a == b)
    });
    if !same {
        return Ok(false);
    }
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(std::io::Error::other)?;
    value["version"] = serde_json::Value::String(version.to_string());
    let tmp = receipt.with_extension("json.hpy-update");
    std::fs::write(&tmp, format!("{value}\n"))?;
    std::fs::rename(&tmp, receipt)?;
    Ok(true)
}

/// Whether there is a terminal sudo could prompt on.
fn has_terminal() -> bool {
    cfg!(unix)
        && std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .is_ok()
}

/// A path as a shell word, for a command printed to be pasted.
fn shell_quote(path: &Path) -> String {
    let s = path.to_string_lossy();
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._+-".contains(c))
    {
        s.into_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
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
            match self_update(&latest, &prefix, Escalate::Never).await {
                Ok(()) => eprintln!("Updated hpy to {latest}."),
                Err(e) => eprintln!("{}", self_update_failed(&latest, &e)),
            }
        }
    }
}

pub fn self_update_failed(latest: &Version, error: &SelfUpdateError) -> String {
    match error {
        SelfUpdateError::NeedsRoot(how) => format!("Could not update hpy: {how}"),
        SelfUpdateError::Failed(error) => format!(
            "Could not update hpy automatically ({error}). To update by hand: curl -fsSL {} | sh",
            install_script_url(latest)
        ),
    }
}

/// The shell installer for `version`'s channel, which installs the newest
/// release on it into /usr/local/bin.
pub fn install_script_url(version: &Version) -> String {
    match channel::Channel::of(version) {
        Some(Channel::Stable) => format!("{PACKAGES}/install.sh"),
        Some(other) => format!("{PACKAGES}/install-{other}.sh"),
        None => installer_url(&version.to_string(), false),
    }
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
        let cargo = upgrade_hint(Install::Cargo, Channel::Alpha, &alpha);
        assert!(cargo.contains("--tag v1.1.0-alpha.2"), "{cargo}");
        // A from-source build that re-resolves builds an untested dependency
        // set, and fails outright when one has been yanked.
        assert!(cargo.contains("--locked"), "{cargo}");
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

#[cfg(test)]
mod self_update_policy {
    use super::*;

    /// `cargo install` copies into a directory the user owns, so hpy can
    /// replace that copy itself rather than asking for a build from source.
    #[test]
    fn a_cargo_install_is_replaced_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("hpy");
        assert_eq!(
            self_update_prefix(Install::Cargo, &exe),
            Some(dir.path().to_path_buf())
        );
    }

    #[test]
    fn an_unknown_install_is_replaced_when_its_directory_is_writable() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("hpy");
        assert_eq!(
            self_update_prefix(Install::Unknown, &exe),
            Some(dir.path().to_path_buf())
        );
        // Nowhere to write means the hint, not a half-finished install.
        assert_eq!(
            self_update_prefix(Install::Unknown, Path::new("/nonexistent-xyz/hpy")),
            None
        );
    }

    /// These keep a database of the files they own, and their next upgrade
    /// would revert anything swapped underneath them.
    #[test]
    fn a_managed_install_is_left_to_its_manager() {
        for install in [Install::Homebrew, Install::Apt, Install::Dnf] {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(
                self_update_prefix(install, &dir.path().join("hpy")),
                None,
                "{install:?} must be upgraded by its own manager"
            );
        }
    }
}

/// The update decision for a copy of hpy the shell installer put in a
/// directory only root can write to, against a stand-in installer (served by
/// wiremock) and a stand-in sudo that records how it was called and runs the
/// command without escalating.
#[cfg(all(test, unix))]
mod sudo_boundary {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct World {
        _dir: tempfile::TempDir,
        root: PathBuf,
        server: MockServer,
        /// One line per installer run: its layout and where it installed.
        installs: PathBuf,
        /// One line per sudo call: its arguments.
        sudo_calls: PathBuf,
        sudo: PathBuf,
        receipt: PathBuf,
    }

    fn chmod(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn script(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        chmod(path, 0o755);
    }

    fn lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .map(|s| s.lines().map(String::from).collect())
            .unwrap_or_default()
    }

    fn root_user() -> bool {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() == 0 }
    }

    async fn world(sudo_fails: bool) -> World {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let installs = root.join("installs.log");
        let sudo_calls = root.join("sudo.log");
        // dist's installer, as far as this decision cares: the flat layout
        // for an unmanaged install, `<dir>/bin` for a forced one.
        let installer = format!(
            r#"#!/bin/sh
set -eu
if [ -n "${{HPY_CLI_UNMANAGED_INSTALL:-}}" ]; then
  d=$HPY_CLI_UNMANAGED_INSTALL; how=flat
elif [ -n "${{CARGO_DIST_FORCE_INSTALL_DIR:-}}" ]; then
  d=$CARGO_DIST_FORCE_INSTALL_DIR/bin; how=cargo-home
else
  exit 3
fi
printf '%s %s\n' "$how" "$d" >> '{}'
mkdir -p "$d"
printf 'new\n' > "$d/hpy"
chmod 755 "$d/hpy"
"#,
            installs.display()
        );
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/installer.sh"))
            .respond_with(ResponseTemplate::new(200).set_body_string(installer))
            .mount(&server)
            .await;
        // Runs the command as this user, making the target's directory
        // writable for just that long, as root would find it.
        let sudo = root.join("sudo");
        script(
            &sudo,
            &format!(
                r#"#!/bin/sh
printf '%s\n' "$*" >> '{}'
{}
for a; do last=$a; done
d=$(dirname "$last")
chmod u+w "$d"
"$@"
rc=$?
chmod 555 "$d"
exit $rc
"#,
                sudo_calls.display(),
                if sudo_fails { "exit 1" } else { "" }
            ),
        );
        let receipt = root.join("config/hpy-cli/hpy-cli-receipt.json");
        World {
            _dir: dir,
            root,
            server,
            installs,
            sudo_calls,
            sudo,
            receipt,
        }
    }

    impl World {
        /// A copy of hpy at `<root>/<rel>/hpy`, recorded in the receipt the
        /// shell installer writes, with `prefix` as its install prefix.
        fn installed(&self, rel: &str, prefix: &Path, layout: &str) -> PathBuf {
            let dir = self.root.join(rel);
            std::fs::create_dir_all(&dir).unwrap();
            let exe = dir.join("hpy");
            std::fs::write(&exe, "old\n").unwrap();
            chmod(&exe, 0o755);
            std::fs::create_dir_all(self.receipt.parent().unwrap()).unwrap();
            std::fs::write(
                &self.receipt,
                format!(
                    r#"{{"binaries":["hpy"],"binary_aliases":{{}},"cdylibs":[],"cstaticlibs":[],"install_layout":"{layout}","install_prefix":"{}","modify_path":false,"provider":{{"source":"cargo-dist","version":"0.32.0"}},"source":{{"app_name":"hpy-cli","name":"cli","owner":"happyproto","release_type":"github"}},"version":"1.0.0-alpha.1"}}"#,
                    prefix.display()
                ),
            )
            .unwrap();
            exe
        }

        async fn update(
            &self,
            exe: &Path,
            prefix: &Path,
            terminal: bool,
            escalate: Escalate,
        ) -> Result<(), SelfUpdateError> {
            run_job(Job {
                installer_url: format!("{}/installer.sh", self.server.uri()),
                exe,
                prefix,
                version: &Version::parse("1.0.0-alpha.2").unwrap(),
                terminal,
                sudo: self.sudo.as_os_str(),
                escalate,
                receipt: Some(self.receipt.clone()),
            })
            .await
        }

        fn receipt_version(&self) -> String {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&self.receipt).unwrap()).unwrap();
            v["version"].as_str().unwrap().to_string()
        }
    }

    fn contents(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    /// The receipt the shell installer writes for its /usr/local/bin copy
    /// makes this a Script install with that directory as its prefix.
    #[test]
    fn the_shell_installers_receipt_is_recognised() {
        let dir = tempfile::tempdir().unwrap();
        let sys = dir.path().join("usr/local/bin");
        std::fs::create_dir_all(&sys).unwrap();
        std::fs::write(sys.join("hpy"), "").unwrap();
        let receipt = format!(
            r#"{{"binaries":["hpy"],"binary_aliases":{{}},"cdylibs":[],"cstaticlibs":[],"install_layout":"flat","install_prefix":"{}","modify_path":false,"provider":{{"source":"cargo-dist","version":"0.32.0"}},"source":{{"app_name":"hpy-cli","name":"cli","owner":"happyproto","release_type":"github"}},"version":"1.0.0-alpha.30"}}"#,
            sys.display()
        );
        let prefix = receipt_prefix(&receipt).unwrap();
        assert!(installed_by_receipt(&sys.join("hpy"), &prefix));
        assert_eq!(layout(&sys.join("hpy"), &prefix), Some(Layout::Flat));
        assert_eq!(
            detect(&Facts {
                exe: sys.join("hpy"),
                script_receipt: true,
                dpkg_owned: false,
                rpm_owned: false,
            }),
            Install::Script
        );
    }

    #[tokio::test]
    async fn a_writable_flat_install_runs_the_installer_into_its_prefix() {
        let w = world(false).await;
        let sys = w.root.join("sys");
        let exe = w.installed("sys", &sys, "flat");
        w.update(&exe, &sys, true, Escalate::Ask).await.unwrap();
        assert_eq!(lines(&w.installs), [format!("flat {}", sys.display())]);
        assert_eq!(contents(&exe), "new\n");
        assert!(
            lines(&w.sudo_calls).is_empty(),
            "no sudo for a writable directory"
        );
        assert_eq!(w.receipt_version(), "1.0.0-alpha.2");
    }

    /// `~/.cargo/bin` and `HPY_CLI_INSTALL_DIR` installs: unchanged, the
    /// installer into the prefix, which writes its own receipt.
    #[tokio::test]
    async fn a_writable_bin_install_runs_the_installer_into_its_prefix() {
        let w = world(false).await;
        let cargo = w.root.join("cargo");
        let exe = w.installed("cargo/bin", &cargo, "cargo-home");
        w.update(&exe, &cargo, false, Escalate::Ask).await.unwrap();
        assert_eq!(
            lines(&w.installs),
            [format!("cargo-home {}/bin", cargo.display())]
        );
        assert_eq!(contents(&exe), "new\n");
        assert!(lines(&w.sudo_calls).is_empty());
    }

    #[tokio::test]
    async fn an_unwritable_install_with_a_terminal_is_copied_with_sudo() {
        if root_user() {
            return;
        }
        let w = world(false).await;
        let sys = w.root.join("sys");
        let exe = w.installed("sys", &sys, "flat");
        chmod(&sys, 0o555);
        let result = w.update(&exe, &sys, true, Escalate::Ask).await;
        chmod(&sys, 0o755);
        result.unwrap();

        // The installer ran unprivileged, into a staging directory
        // elsewhere; sudo was asked for exactly one thing, the copy.
        let installs = lines(&w.installs);
        assert_eq!(installs.len(), 1, "{installs:?}");
        let staged_dir = installs[0].strip_prefix("flat ").unwrap();
        assert!(!Path::new(staged_dir).starts_with(&sys), "{staged_dir}");
        assert_eq!(
            lines(&w.sudo_calls),
            [format!(
                "install -m 0755 {staged_dir}/hpy {}",
                exe.display()
            )]
        );
        assert_eq!(contents(&exe), "new\n");
        assert_eq!(
            std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // The staging directory is gone, and the receipt says what is there.
        assert!(!Path::new(staged_dir).exists());
        assert_eq!(w.receipt_version(), "1.0.0-alpha.2");
        assert!(
            std::fs::read_dir(&sys).unwrap().count() == 1,
            "no second copy"
        );
    }

    #[tokio::test]
    async fn an_unwritable_install_without_a_terminal_prints_the_command() {
        if root_user() {
            return;
        }
        let w = world(false).await;
        let sys = w.root.join("sys");
        let exe = w.installed("sys", &sys, "flat");
        chmod(&sys, 0o555);
        let result = w.update(&exe, &sys, false, Escalate::Ask).await;
        chmod(&sys, 0o755);

        let Err(SelfUpdateError::NeedsRoot(msg)) = result else {
            panic!("expected NeedsRoot, got {result:?}");
        };
        assert!(
            lines(&w.sudo_calls).is_empty(),
            "no sudo without a terminal"
        );
        assert_eq!(contents(&exe), "old\n", "the binary is untouched");
        assert_eq!(w.receipt_version(), "1.0.0-alpha.1");
        let staged_dir = lines(&w.installs)[0]
            .strip_prefix("flat ")
            .unwrap()
            .to_string();
        let command = format!("sudo install -m 0755 {staged_dir}/hpy {}", exe.display());
        assert!(msg.contains(&command), "{msg}");
        // The command works: the staged binary was kept for it.
        assert_eq!(contents(&Path::new(&staged_dir).join("hpy")), "new\n");
        std::fs::remove_dir_all(Path::new(&staged_dir).parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn a_failing_sudo_leaves_the_binary_untouched() {
        if root_user() {
            return;
        }
        let w = world(true).await;
        let sys = w.root.join("sys");
        let exe = w.installed("sys", &sys, "flat");
        chmod(&sys, 0o555);
        let result = w.update(&exe, &sys, true, Escalate::Ask).await;
        chmod(&sys, 0o755);

        let Err(SelfUpdateError::NeedsRoot(msg)) = result else {
            panic!("expected NeedsRoot, got {result:?}");
        };
        assert_eq!(lines(&w.sudo_calls).len(), 1);
        assert_eq!(contents(&exe), "old\n", "the binary is untouched");
        assert_eq!(w.receipt_version(), "1.0.0-alpha.1");
        assert!(msg.contains("sudo install -m 0755 "), "{msg}");
        let staged_dir = lines(&w.installs)[0]
            .strip_prefix("flat ")
            .unwrap()
            .to_string();
        std::fs::remove_dir_all(Path::new(&staged_dir).parent().unwrap()).unwrap();
    }

    /// The daily check runs behind another command, and never prompts.
    #[tokio::test]
    async fn the_background_update_never_asks_for_sudo() {
        if root_user() {
            return;
        }
        let w = world(false).await;
        let sys = w.root.join("sys");
        let exe = w.installed("sys", &sys, "flat");
        chmod(&sys, 0o555);
        let result = w.update(&exe, &sys, true, Escalate::Never).await;
        chmod(&sys, 0o755);
        assert!(matches!(result, Err(SelfUpdateError::NeedsRoot(_))));
        assert!(lines(&w.installs).is_empty());
        assert!(lines(&w.sudo_calls).is_empty());
        assert_eq!(contents(&exe), "old\n");
    }

    #[test]
    fn a_receipt_for_another_prefix_is_not_touched() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = dir.path().join("r.json");
        std::fs::write(
            &receipt,
            r#"{"install_prefix":"/somewhere/else","version":"1.0.0"}"#,
        )
        .unwrap();
        let v = Version::parse("1.0.1").unwrap();
        assert!(!write_receipt_version(&receipt, dir.path(), &v).unwrap());
        assert!(contents(&receipt).contains(r#""version":"1.0.0""#));
        assert!(!write_receipt_version(&dir.path().join("none.json"), dir.path(), &v).unwrap());
    }

    #[test]
    fn printed_paths_are_quoted_when_they_need_it() {
        assert_eq!(
            shell_quote(Path::new("/usr/local/bin/hpy")),
            "/usr/local/bin/hpy"
        );
        assert_eq!(shell_quote(Path::new("/a b/it's")), r"'/a b/it'\''s'");
    }
}
