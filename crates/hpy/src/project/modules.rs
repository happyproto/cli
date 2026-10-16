//! A project's compiled script modules: which there are and whether the
//! toolchain can build them. HappyView never runs a compiler; it reads what
//! `hpy` writes to `.happyview/build/<module>.wasm`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;

use crate::failure::Failure;

pub const TARGET: &str = "wasm32-wasip1";
pub const BUILD_DIR: &str = ".happyview/build";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleSpec {
    pub name: String,
    pub language: String,
    pub path: PathBuf,
}

/// Only what a build needs. HappyView validates the whole file; reading
/// anything else here would be a second, drifting copy of its rules.
#[derive(Deserialize)]
struct ProjectFile {
    #[serde(default)]
    modules: BTreeMap<String, ModuleEntry>,
}

#[derive(Deserialize)]
struct ModuleEntry {
    language: String,
    path: String,
}

/// HappyView refuses the same paths, so a project one accepts the other does.
fn is_contained_path(raw: &str) -> bool {
    let path = Path::new(raw);
    !raw.trim().is_empty()
        && !path.has_root()
        && !path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
}

/// The name becomes `.happyview/build/<name>.wasm`, so it is limited to what
/// cannot leave that directory. HappyView applies the same rule.
fn is_valid_module_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Whether `raw` still names somewhere inside `project` once symlinks are
/// followed. A path that does not exist yet has nothing to follow, and is
/// left to the build to report as missing.
fn resolves_inside(project: &Path, raw: &str) -> Result<bool, Failure> {
    let Ok(dir) = project.join(raw).canonicalize() else {
        return Ok(true);
    };
    let root = project.canonicalize().map_err(Failure::runtime)?;
    Ok(dir.starts_with(root))
}

pub fn read_modules(project: &Path) -> Result<Vec<ModuleSpec>, Failure> {
    let file = project.join("happyview.toml");
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(Failure::usage(format!(
                "{} not found; run this in a HappyView project",
                file.display()
            )));
        }
        Err(e) => return Err(Failure::runtime(e)),
    };
    let parsed: ProjectFile =
        toml::from_str(&text).map_err(|e| Failure::usage(format!("{}: {e}", file.display())))?;
    parsed
        .modules
        .into_iter()
        .map(|(name, entry)| {
            if !is_valid_module_name(&name) {
                return Err(Failure::usage(format!(
                    "module '{name}' must be lowercase letters, digits, '-' or '_', starting \
                     with a letter"
                )));
            }
            if !is_contained_path(&entry.path) || !resolves_inside(project, &entry.path)? {
                return Err(Failure::usage(format!(
                    "module '{name}': module path '{}' must be relative to the project root \
                     and stay inside it",
                    entry.path
                )));
            }
            Ok(ModuleSpec {
                name,
                language: entry.language,
                path: entry.path.into(),
            })
        })
        .collect()
}

/// The two programs a Rust module build runs.
pub struct Toolchain {
    pub cargo: OsString,
    pub rustup: OsString,
}

impl Toolchain {
    /// `HPY_CARGO` and `HPY_RUSTUP` replace the two programs, for a toolchain
    /// installed under another name and for tests.
    pub fn from_env() -> Self {
        Self {
            cargo: std::env::var_os("HPY_CARGO").unwrap_or_else(|| "cargo".into()),
            rustup: std::env::var_os("HPY_RUSTUP").unwrap_or_else(|| "rustup".into()),
        }
    }
}

pub fn check_toolchain(tc: &Toolchain, project: &Path, module: &ModuleSpec) -> Result<(), Failure> {
    if module.language != "rust" {
        return Err(Failure::usage(format!(
            "module '{}': hpy builds only rust modules, not '{}'",
            module.name, module.language
        )));
    }
    let dir = project.join(&module.path);
    if !dir.join("Cargo.toml").is_file() {
        return Err(Failure::usage(format!(
            "module '{}': no Cargo.toml in {}",
            module.name,
            module.path.display()
        )));
    }
    // Probed from the module's directory so a pinned toolchain is the one
    // that answers.
    match Command::new(&tc.cargo)
        .arg("--version")
        .current_dir(&dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(Failure::usage(
                "cargo was not found; install Rust from https://rustup.rs",
            ));
        }
        Err(e) => return Err(Failure::runtime(e)),
        Ok(status) if !status.success() => {
            return Err(Failure::usage(format!(
                "cargo does not run for module '{}'; install Rust from https://rustup.rs",
                module.name
            )));
        }
        Ok(_) => {}
    }
    // rustup answers for the module's own rust-toolchain.toml only when asked
    // from inside the module.
    let listed = match Command::new(&tc.rustup)
        .args(["target", "list", "--installed"])
        .current_dir(&dir)
        .stderr(Stdio::null())
        .output()
    {
        // A toolchain without rustup is managed by hand; cargo's own error
        // is the best there is.
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(Failure::runtime(e)),
        Ok(out) if !out.status.success() => return Ok(()),
        Ok(out) => out.stdout,
    };
    if String::from_utf8_lossy(&listed)
        .lines()
        .any(|l| l.trim() == TARGET)
    {
        return Ok(());
    }
    Err(Failure::usage(format!(
        "module '{}': the {TARGET} target is not installed for its toolchain; install it with\n  \
         (cd {} && rustup target add {TARGET})",
        module.name,
        module.path.display()
    )))
}

pub fn build_module(
    tc: &Toolchain,
    project: &Path,
    module: &ModuleSpec,
) -> Result<PathBuf, Failure> {
    build_module_unless(tc, project, module, &AtomicBool::new(false), false)
}

/// As `build_module`, but a set `stop` ends cargo at once rather than
/// waiting out the build, and nothing is installed. With `own_group`, cargo
/// runs in a process group of its own, which a terminal's Ctrl-C does not
/// reach, and `stop` ends the whole group, since killing cargo alone leaves
/// its rustc children running.
fn build_module_unless(
    tc: &Toolchain,
    project: &Path,
    module: &ModuleSpec,
    stop: &AtomicBool,
    own_group: bool,
) -> Result<PathBuf, Failure> {
    check_toolchain(tc, project, module)?;
    let dir = project.join(&module.path);
    let manifest = dir.join("Cargo.toml");
    require_panic_abort(project, module)?;
    // Diagnostics render to stderr, which the developer sees as they would
    // from cargo itself; stdout carries the JSON that names the artifact.
    let mut cmd = Command::new(&tc.cargo);
    #[cfg(unix)]
    if own_group {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = own_group;
    let mut child = cmd
        .args([
            "build",
            "--release",
            "--target",
            TARGET,
            "--message-format=json-render-diagnostics",
            "--manifest-path",
        ])
        .arg(&manifest)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(Failure::runtime)?;
    let mut pipe = child.stdout.take().expect("stdout is piped");
    // Drained on its own thread, so a full pipe cannot stall cargo while
    // this one watches for `stop`.
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        pipe.read_to_end(&mut out).map(|_| out)
    });
    let status = loop {
        if let Some(status) = child.try_wait().map_err(Failure::runtime)? {
            break status;
        }
        if stop.load(Ordering::SeqCst) {
            #[cfg(unix)]
            if own_group {
                // SAFETY: killpg(2) on the group cargo leads, which exists
                // while cargo is unreaped.
                unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL) };
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::runtime(format!(
                "the build of module '{}' was stopped",
                module.name
            )));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = reader
        .join()
        .map_err(|_| Failure::runtime("reading cargo's output panicked"))?
        .map_err(Failure::runtime)?;
    if !status.success() {
        return Err(Failure::runtime(format!(
            "module '{}' failed to build",
            module.name
        )));
    }
    let built = find_artifact(&stdout, &manifest).ok_or_else(|| {
        Failure::usage(format!(
            "module '{}' built no wasm library; set crate-type = [\"cdylib\"] under [lib] in {}",
            module.name,
            module.path.join("Cargo.toml").display()
        ))
    })?;
    install_artifact(project, &module.name, &built)
}

/// A module that unwinds can carry exception-handling tags HappyView refuses
/// at load, so it is refused here, where the fix is a line in a manifest.
fn require_panic_abort(project: &Path, module: &ModuleSpec) -> Result<(), Failure> {
    let manifest = profile_manifest(&project.join(&module.path))?;
    let parsed = read_manifest(&manifest)?;
    let release = parsed.get("profile").and_then(|p| p.get("release"));
    if release
        .and_then(|r| r.get("panic"))
        .and_then(|v| v.as_str())
        == Some("abort")
    {
        return Ok(());
    }
    let project = project.canonicalize().map_err(Failure::runtime)?;
    let shown = manifest.strip_prefix(&project).unwrap_or(&manifest);
    let fix = if release.is_some() {
        format!(
            "set `panic = \"abort\"` under the existing `[profile.release]` in {}",
            shown.display()
        )
    } else {
        format!(
            "add to {}:\n  [profile.release]\n  panic = \"abort\"",
            shown.display()
        )
    };
    Err(Failure::usage(format!(
        "module '{}' must build with panic = \"abort\", since HappyView refuses a module that \
         unwinds; {fix}",
        module.name
    )))
}

fn read_manifest(path: &Path) -> Result<toml::Table, Failure> {
    let text = std::fs::read_to_string(path).map_err(Failure::runtime)?;
    toml::from_str(&text).map_err(|e| Failure::usage(format!("{}: {e}", path.display())))
}

/// The manifest whose `[profile]` cargo applies when building the crate in
/// `dir`: a workspace member's own profile is ignored in favour of the
/// workspace root's.
fn profile_manifest(dir: &Path) -> Result<PathBuf, Failure> {
    let dir = dir.canonicalize().map_err(Failure::runtime)?;
    let own = dir.join("Cargo.toml");
    let manifest = read_manifest(&own)?;
    if manifest.contains_key("workspace") {
        return Ok(own);
    }
    if let Some(root) = manifest
        .get("package")
        .and_then(|p| p.get("workspace"))
        .and_then(|w| w.as_str())
    {
        return Ok(normalize(&dir.join(root)).join("Cargo.toml"));
    }
    // Cargo keeps looking above a workspace that excludes the crate, unless
    // the crate is also one of its members.
    for ancestor in dir.ancestors().skip(1) {
        let candidate = ancestor.join("Cargo.toml");
        if !candidate.is_file() {
            continue;
        }
        let Some(workspace) = read_manifest(&candidate)?
            .get("workspace")
            .and_then(|w| w.as_table())
            .cloned()
        else {
            continue;
        };
        let listed = |key: &str| {
            workspace
                .get(key)
                .and_then(|e| e.as_array())
                .into_iter()
                .flatten()
                .filter_map(|e| e.as_str())
                .map(|e| normalize(&ancestor.join(e)))
                .collect::<Vec<_>>()
        };
        let excluded = listed("exclude").iter().any(|e| dir.starts_with(e));
        // Cargo compares a member literally here, without expanding a glob.
        let member = listed("members").iter().any(|m| dir.starts_with(m));
        if excluded && !member {
            continue;
        }
        return Ok(candidate);
    }
    Ok(own)
}

/// `path` with `.` and `..` resolved lexically, without following symlinks.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

#[derive(Deserialize)]
struct CargoMessage {
    reason: String,
    #[serde(default)]
    manifest_path: Option<PathBuf>,
    #[serde(default)]
    target: Option<CargoTarget>,
    #[serde(default)]
    filenames: Vec<PathBuf>,
}

#[derive(Deserialize)]
struct CargoTarget {
    crate_types: Vec<String>,
}

/// The `.wasm` cargo built for the module's own package; a module in a
/// workspace also builds its siblings, which are not it.
fn find_artifact(stdout: &[u8], manifest: &Path) -> Option<PathBuf> {
    let manifest = manifest.canonicalize().ok()?;
    stdout
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<CargoMessage>(line).ok())
        .filter(|m| m.reason == "compiler-artifact")
        .filter(|m| {
            m.manifest_path
                .as_deref()
                .and_then(|p| p.canonicalize().ok())
                .as_deref()
                == Some(manifest.as_path())
        })
        .filter(|m| {
            m.target
                .as_ref()
                .is_some_and(|t| t.crate_types.iter().any(|c| c == "cdylib"))
        })
        .flat_map(|m| m.filenames)
        .find(|f| f.extension().is_some_and(|e| e == "wasm"))
}

/// Copy `built` into place by staging it beside the destination and renaming
/// over it. HappyView's dev watcher rebuilds on any name ending `.wasm`, so
/// the staging name must not end that way, and a rename within one directory
/// is atomic; until it happens the previous build keeps serving.
pub fn install_artifact(project: &Path, name: &str, built: &Path) -> Result<PathBuf, Failure> {
    let dir = project.join(BUILD_DIR);
    std::fs::create_dir_all(&dir).map_err(Failure::runtime)?;
    let dest = dir.join(format!("{name}.wasm"));
    let staging = dir.join(format!(".{name}.wasm.partial"));
    let installed = std::fs::copy(built, &staging).and_then(|_| std::fs::rename(&staging, &dest));
    if let Err(e) = installed {
        let _ = std::fs::remove_file(&staging);
        return Err(Failure::runtime(e));
    }
    Ok(dest)
}

/// Build every module, carrying on past a failure so one run reports all of
/// them. The error keeps the first failure's exit code, so a missing target
/// stays a usage error.
pub fn build_all(tc: &Toolchain, project: &Path) -> Result<Vec<(String, PathBuf)>, Failure> {
    let mut built = Vec::new();
    let mut failed = Vec::new();
    let mut code = None;
    for module in read_modules(project)? {
        match build_module(tc, project, &module) {
            Ok(path) => built.push((module.name, path)),
            Err(f) => {
                eprintln!("{:?}", f.report);
                code.get_or_insert(f.code);
                failed.push(module.name);
            }
        }
    }
    match code {
        None => Ok(built),
        Some(code) => Err(Failure {
            code,
            report: miette::miette!(
                "{} module(s) failed to build: {}",
                failed.len(),
                failed.join(", ")
            ),
            quiet: false,
        }),
    }
}

pub type Fingerprint = BTreeMap<PathBuf, (u64, std::time::SystemTime)>;

/// Every file under a module's crate that a build reads, with its size and
/// modification time. A module is tens of files, so polling this is cheaper
/// than a platform watcher's dependency and gives every platform the same
/// behaviour. `target/` and dot-directories are build output and tooling.
pub fn fingerprint(dir: &Path) -> Fingerprint {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                if name != "target" && !name.starts_with('.') {
                    stack.push(path);
                }
            } else if let Ok(modified) = meta.modified() {
                out.insert(path, (meta.len(), modified));
            }
        }
    }
    out
}

/// A project's modules with their sources as they stood when it was taken.
/// A watch compares against this rather than against whatever it finds when
/// its thread first runs, so a save made after `take` returns is rebuilt
/// however late that thread starts. Taken before the first build, it also
/// catches a save made while that build runs.
pub struct Snapshot {
    modules: Vec<ModuleSpec>,
    seen: Vec<Fingerprint>,
}

impl Snapshot {
    pub fn take(project: &Path, modules: Vec<ModuleSpec>) -> Snapshot {
        let seen = modules
            .iter()
            .map(|m| fingerprint(&project.join(&m.path)))
            .collect();
        Snapshot { modules, seen }
    }

    pub fn modules(&self) -> &[ModuleSpec] {
        &self.modules
    }
}

/// Build each module in turn until `stop` is set. Setting it ends the build
/// under way, cargo's whole process group with it, and starts no further
/// module, so a caller that handles Ctrl-C itself does not sit through the
/// rest of the list. A build that `stop` cut short is not reported.
#[cfg(unix)]
pub fn build_each(
    tc: &Toolchain,
    project: &Path,
    modules: &[ModuleSpec],
    stop: &AtomicBool,
    on_build: &mut dyn FnMut(&ModuleSpec, Result<PathBuf, Failure>),
) {
    for module in modules {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let result = build_module_unless(tc, project, module, stop, true);
        if stop.load(Ordering::SeqCst) {
            return;
        }
        on_build(module, result);
    }
}

/// Poll each module's crate every `interval` and rebuild the ones that
/// changed since `from`, until `stop` is set. A build that fails leaves the
/// previous module installed, so HappyView keeps serving it. Edits made
/// during a build are seen by the next poll. Setting `stop` ends a build
/// under way, so whoever sets it waits only for cargo to die, not for it to
/// finish.
pub fn watch(
    tc: &Toolchain,
    project: &Path,
    from: Snapshot,
    interval: Duration,
    stop: &AtomicBool,
    on_build: &mut dyn FnMut(&ModuleSpec, Result<PathBuf, Failure>),
) {
    let Snapshot { modules, mut seen } = from;
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(interval);
        for (module, seen) in modules.iter().zip(seen.iter_mut()) {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            let now = fingerprint(&project.join(&module.path));
            if now != *seen {
                *seen = now;
                let result = build_module_unless(tc, project, module, stop, true);
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                on_build(module, result);
            }
        }
    }
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    pub(crate) fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    pub(crate) fn project(toml: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("happyview.toml"), toml).unwrap();
        std::fs::create_dir_all(dir.path().join("modules/registry/src")).unwrap();
        std::fs::write(
            dir.path().join("modules/registry/Cargo.toml"),
            format!("[package]\nname = \"registry\"\n{ABORT}"),
        )
        .unwrap();
        dir
    }

    pub(crate) const ABORT: &str = "[profile.release]\npanic = \"abort\"\n";

    pub(crate) const REGISTRY: &str = "[modules.registry]\nlanguage = \"rust\"\npath = \"modules/registry\"\ncapabilities = [\"library:call\"]\n";

    pub(crate) fn toolchain(dir: &Path, targets: &str) -> Toolchain {
        Toolchain {
            cargo: script(dir, "cargo", "echo 'cargo 1.96.1 (fake)'").into(),
            rustup: script(dir, "rustup", &format!("printf '%s\\n' {targets}")).into(),
        }
    }

    #[test]
    fn modules_are_read_and_other_keys_ignored() {
        let p = project(&format!("[instance]\napp_name = \"x\"\n\n{REGISTRY}"));
        assert_eq!(
            read_modules(p.path()).unwrap(),
            vec![ModuleSpec {
                name: "registry".into(),
                language: "rust".into(),
                path: "modules/registry".into(),
            }]
        );
    }

    #[test]
    fn a_project_without_modules_has_none() {
        let p = project("[instance]\napp_name = \"x\"\n");
        assert!(read_modules(p.path()).unwrap().is_empty());
    }

    #[test]
    fn a_missing_happyview_toml_is_a_usage_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_modules(dir.path()).unwrap_err();
        assert_eq!(err.code, 2);
        assert!(err.report.to_string().contains("happyview.toml"));
    }

    #[test]
    fn a_module_name_that_could_leave_the_build_directory_is_refused() {
        let p = project("[modules.\"../x\"]\nlanguage = \"rust\"\npath = \"modules/registry\"\n");
        let err = read_modules(p.path()).unwrap_err();
        assert_eq!(err.code, 2);
        assert!(err.report.to_string().contains("'../x'"));
    }

    #[test]
    fn a_module_name_must_start_with_a_letter_as_happyview_requires() {
        let p = project("[modules.2fa]\nlanguage = \"rust\"\npath = \"modules/registry\"\n");
        let err = read_modules(p.path()).unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(
            err.report.to_string(),
            "module '2fa' must be lowercase letters, digits, '-' or '_', starting with a letter"
        );
        let p = project("[modules.t2-f_a]\nlanguage = \"rust\"\npath = \"modules/registry\"\n");
        assert_eq!(read_modules(p.path()).unwrap()[0].name, "t2-f_a");
    }

    #[test]
    fn a_module_path_whose_symlink_leaves_the_project_is_refused() {
        let outside = tempfile::tempdir().unwrap();
        let p = project("[modules.registry]\nlanguage = \"rust\"\npath = \"modules/link\"\n");
        std::os::unix::fs::symlink(outside.path(), p.path().join("modules/link")).unwrap();
        let err = read_modules(p.path()).unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(
            err.report.to_string(),
            "module 'registry': module path 'modules/link' must be relative to the project root \
             and stay inside it"
        );

        // A symlink that stays inside is only another name for the module.
        std::fs::remove_file(p.path().join("modules/link")).unwrap();
        std::os::unix::fs::symlink(
            p.path().join("modules/registry"),
            p.path().join("modules/link"),
        )
        .unwrap();
        assert_eq!(
            read_modules(p.path()).unwrap()[0].path,
            PathBuf::from("modules/link")
        );
    }

    #[test]
    fn an_installed_target_passes() {
        let p = project(REGISTRY);
        let tc = toolchain(p.path(), "aarch64-apple-darwin wasm32-wasip1");
        let module = &read_modules(p.path()).unwrap()[0];
        check_toolchain(&tc, p.path(), module).unwrap();
    }

    #[test]
    fn a_missing_target_names_the_command_that_installs_it() {
        let p = project(REGISTRY);
        let tc = toolchain(p.path(), "aarch64-apple-darwin");
        let module = &read_modules(p.path()).unwrap()[0];
        let err = check_toolchain(&tc, p.path(), module).unwrap_err();
        assert_eq!(err.code, 2);
        let text = err.report.to_string();
        assert!(text.contains("rustup target add wasm32-wasip1"), "{text}");
        assert!(text.contains("modules/registry"), "{text}");
    }

    #[test]
    fn a_missing_cargo_says_how_to_install_rust() {
        let p = project(REGISTRY);
        let tc = Toolchain {
            cargo: "/nonexistent/cargo".into(),
            rustup: "/nonexistent/rustup".into(),
        };
        let module = &read_modules(p.path()).unwrap()[0];
        let err = check_toolchain(&tc, p.path(), module).unwrap_err();
        assert!(err.report.to_string().contains("https://rustup.rs"));
    }

    #[test]
    fn without_rustup_the_target_check_is_left_to_cargo() {
        let p = project(REGISTRY);
        let mut tc = toolchain(p.path(), "");
        tc.rustup = "/nonexistent/rustup".into();
        let module = &read_modules(p.path()).unwrap()[0];
        check_toolchain(&tc, p.path(), module).unwrap();
    }

    #[test]
    fn an_unsupported_language_is_named() {
        let p = project("[modules.registry]\nlanguage = \"go\"\npath = \"modules/registry\"\n");
        let tc = toolchain(p.path(), "wasm32-wasip1");
        let module = &read_modules(p.path()).unwrap()[0];
        let err = check_toolchain(&tc, p.path(), module).unwrap_err();
        assert!(err.report.to_string().contains("'go'"));
    }

    #[test]
    fn a_module_path_that_leaves_the_project_is_refused() {
        for bad in ["/etc/x", "../outside", "modules/../../x", ""] {
            let p = project(&format!(
                "[modules.registry]\nlanguage = \"rust\"\npath = \"{bad}\"\n"
            ));
            let err = read_modules(p.path()).unwrap_err();
            assert_eq!(err.code, 2, "{bad}");
            let text = err.report.to_string();
            assert!(
                text.contains("registry") && text.contains(&format!("'{bad}'")),
                "{text}"
            );
            assert!(text.contains("stay inside it"), "{text}");
        }
    }

    #[test]
    fn a_nested_module_path_is_accepted() {
        let p = project("[modules.registry]\nlanguage = \"rust\"\npath = \"modules/a/b\"\n");
        assert_eq!(
            read_modules(p.path()).unwrap()[0].path,
            PathBuf::from("modules/a/b")
        );
    }

    #[test]
    fn a_cargo_that_exits_non_zero_is_a_failure_with_the_install_hint() {
        let p = project(REGISTRY);
        let mut tc = toolchain(p.path(), "wasm32-wasip1");
        tc.cargo = script(p.path(), "badcargo", "exit 1").into();
        let module = &read_modules(p.path()).unwrap()[0];
        let err = check_toolchain(&tc, p.path(), module).unwrap_err();
        assert_eq!(err.code, 2);
        assert!(err.report.to_string().contains("https://rustup.rs"));
    }

    #[test]
    fn cargo_and_rustup_run_in_the_module_directory() {
        let p = project(REGISTRY);
        let mut tc = toolchain(p.path(), "wasm32-wasip1");
        tc.cargo = script(
            p.path(),
            "pwdcargo",
            "[ \"$(basename \"$PWD\")\" = registry ] || exit 1",
        )
        .into();
        tc.rustup = script(
            p.path(),
            "pwdrustup",
            "[ \"$(basename \"$PWD\")\" = registry ] || exit 1; echo wasm32-wasip1",
        )
        .into();
        let module = &read_modules(p.path()).unwrap()[0];
        check_toolchain(&tc, p.path(), module).unwrap();
    }

    #[test]
    fn a_rustup_that_fails_leaves_the_target_check_to_cargo() {
        let p = project(REGISTRY);
        let mut tc = toolchain(p.path(), "");
        tc.rustup = script(p.path(), "badrustup", "exit 1").into();
        let module = &read_modules(p.path()).unwrap()[0];
        check_toolchain(&tc, p.path(), module).unwrap();
    }

    #[test]
    fn a_module_without_a_cargo_toml_is_named() {
        let p = project(REGISTRY);
        std::fs::remove_file(p.path().join("modules/registry/Cargo.toml")).unwrap();
        let tc = toolchain(p.path(), "wasm32-wasip1");
        let module = &read_modules(p.path()).unwrap()[0];
        let err = check_toolchain(&tc, p.path(), module).unwrap_err();
        assert_eq!(err.code, 2);
        assert_eq!(
            err.report.to_string(),
            "module 'registry': no Cargo.toml in modules/registry"
        );
    }

    /// A cargo that reports `wasm` as the cdylib of whatever manifest it was
    /// given, or fails like a compile error when `fail` is set. Every build
    /// appends a line to `count`.
    pub(crate) fn fake_cargo(dir: &Path, wasm: &Path, fail: bool, count: &Path) -> Toolchain {
        let build = if fail {
            "exit 101".to_string()
        } else {
            format!(
                "printf '{{\"reason\":\"compiler-artifact\",\"manifest_path\":\"%s\",\"target\":{{\"crate_types\":[\"cdylib\"]}},\"filenames\":[\"{wasm}\"]}}\\n' \"$manifest\"\n\
                 echo '{{\"reason\":\"build-finished\",\"success\":true}}'",
                wasm = wasm.display()
            )
        };
        let body = format!(
            "if [ \"$1\" = --version ]; then echo 'cargo 1.96.1 (fake)'; exit 0; fi\n\
             echo build >> '{count}'\n\
             manifest=''\n\
             while [ $# -gt 0 ]; do [ \"$1\" = --manifest-path ] && manifest=\"$2\"; shift; done\n\
             {build}",
            count = count.display()
        );
        Toolchain {
            cargo: script(dir, if fail { "cargo-fail" } else { "cargo-ok" }, &body).into(),
            rustup: script(dir, "rustup", "echo wasm32-wasip1").into(),
        }
    }

    #[test]
    fn a_build_installs_the_cdylib_under_the_module_name() {
        let p = project(REGISTRY);
        let wasm = p.path().join("built.wasm");
        std::fs::write(&wasm, b"\0asm-new").unwrap();
        let tc = fake_cargo(p.path(), &wasm, false, &p.path().join("count"));
        let module = &read_modules(p.path()).unwrap()[0];
        let dest = build_module(&tc, p.path(), module).unwrap();
        assert_eq!(dest, p.path().join(".happyview/build/registry.wasm"));
        assert_eq!(std::fs::read(dest).unwrap(), b"\0asm-new");
    }

    #[test]
    fn a_failed_build_leaves_the_previous_module_in_place() {
        let p = project(REGISTRY);
        let dest = p.path().join(".happyview/build/registry.wasm");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, b"\0asm-old").unwrap();
        let tc = fake_cargo(
            p.path(),
            Path::new("/unused"),
            true,
            &p.path().join("count"),
        );
        let module = &read_modules(p.path()).unwrap()[0];
        let err = build_module(&tc, p.path(), module).unwrap_err();
        assert!(format!("{:?}", err.report).contains("'registry' failed to build"));
        assert_eq!(std::fs::read(&dest).unwrap(), b"\0asm-old");
    }

    #[test]
    fn a_build_with_no_cdylib_says_which_setting_is_missing() {
        let p = project(REGISTRY);
        let body = "if [ \"$1\" = --version ]; then exit 0; fi\necho '{\"reason\":\"build-finished\",\"success\":true}'";
        let tc = Toolchain {
            cargo: script(p.path(), "cargo-nolib", body).into(),
            rustup: script(p.path(), "rustup", "echo wasm32-wasip1").into(),
        };
        let module = &read_modules(p.path()).unwrap()[0];
        let err = build_module(&tc, p.path(), module).unwrap_err();
        assert!(format!("{:?}", err.report).contains("crate-type = [\"cdylib\"]"));
    }

    #[test]
    fn build_all_builds_every_module_and_reports_each_failure() {
        let p = project(&format!(
            "{REGISTRY}\n[modules.other]\nlanguage = \"rust\"\npath = \"modules/other\"\n"
        ));
        let wasm = p.path().join("built.wasm");
        std::fs::write(&wasm, b"\0asm").unwrap();
        let tc = fake_cargo(p.path(), &wasm, false, &p.path().join("count"));
        // `other` has no Cargo.toml, so it fails before cargo runs.
        let err = build_all(&tc, p.path()).unwrap_err();
        assert!(format!("{:?}", err.report).contains("other"));
        assert!(p.path().join(".happyview/build/registry.wasm").exists());
    }

    #[test]
    fn a_module_that_unwinds_is_refused_before_cargo_builds_it() {
        for (manifest, fix) in [
            (
                "[package]\nname = \"registry\"\n",
                "add to modules/registry/Cargo.toml:\n  [profile.release]\n  panic = \"abort\"",
            ),
            (
                "[package]\nname = \"registry\"\n[profile.release]\npanic = \"unwind\"\n",
                "set `panic = \"abort\"` under the existing `[profile.release]` in \
                 modules/registry/Cargo.toml",
            ),
            (
                "[package]\nname = \"registry\"\n[profile.release]\nopt-level = 3\n",
                "set `panic = \"abort\"` under the existing `[profile.release]` in \
                 modules/registry/Cargo.toml",
            ),
        ] {
            let p = project(REGISTRY);
            std::fs::write(p.path().join("modules/registry/Cargo.toml"), manifest).unwrap();
            let count = p.path().join("count");
            let tc = fake_cargo(p.path(), Path::new("/unused"), false, &count);
            let module = &read_modules(p.path()).unwrap()[0];
            let err = build_module(&tc, p.path(), module).unwrap_err();
            assert_eq!(err.code, 2);
            let text = err.report.to_string();
            assert!(text.contains("'registry'"), "{text}");
            assert!(text.ends_with(fix), "{text}");
            assert!(!count.exists(), "cargo built a module that unwinds");
        }
    }

    #[test]
    fn a_workspace_member_is_judged_by_the_workspace_profile() {
        let p = project(REGISTRY);
        let wasm = p.path().join("built.wasm");
        std::fs::write(&wasm, b"\0asm").unwrap();
        let tc = fake_cargo(p.path(), &wasm, false, &p.path().join("count"));
        // Cargo ignores a member's own profile, so the one that counts is the
        // workspace root's.
        std::fs::write(
            p.path().join("modules/Cargo.toml"),
            "[workspace]\nmembers = [\"registry\"]\n",
        )
        .unwrap();
        let module = &read_modules(p.path()).unwrap()[0];
        let err = build_module(&tc, p.path(), module).unwrap_err();
        let text = err.report.to_string();
        assert!(text.contains("modules/Cargo.toml"), "{text}");
        assert!(!text.contains("modules/registry/Cargo.toml"), "{text}");

        std::fs::write(
            p.path().join("modules/Cargo.toml"),
            format!("[workspace]\nmembers = [\"registry\"]\n{ABORT}"),
        )
        .unwrap();
        std::fs::write(
            p.path().join("modules/registry/Cargo.toml"),
            "[package]\nname = \"registry\"\n",
        )
        .unwrap();
        build_module(&tc, p.path(), module).unwrap();
    }

    #[test]
    fn a_module_excluded_from_an_enclosing_workspace_keeps_its_own_profile() {
        let p = project(REGISTRY);
        let wasm = p.path().join("built.wasm");
        std::fs::write(&wasm, b"\0asm").unwrap();
        let tc = fake_cargo(p.path(), &wasm, false, &p.path().join("count"));
        std::fs::write(
            p.path().join("Cargo.toml"),
            "[workspace]\nexclude = [\"modules\"]\n",
        )
        .unwrap();
        let module = &read_modules(p.path()).unwrap()[0];
        build_module(&tc, p.path(), module).unwrap();
    }

    #[test]
    fn the_root_search_passes_an_excluding_workspace_unless_it_also_lists_the_member() {
        let p = project(REGISTRY);
        let tc = fake_cargo(
            p.path(),
            Path::new("/unused"),
            false,
            &p.path().join("count"),
        );
        let module = &read_modules(p.path()).unwrap()[0];
        // Cargo carries on above the workspace that excludes the crate and
        // finds the one that lists it, whose profile is the one it applies.
        std::fs::write(
            p.path().join("modules/Cargo.toml"),
            "[workspace]\nexclude = [\"registry\"]\n",
        )
        .unwrap();
        std::fs::write(
            p.path().join("Cargo.toml"),
            "[workspace]\nmembers = [\"modules/registry\"]\n",
        )
        .unwrap();
        let text = build_module(&tc, p.path(), module)
            .unwrap_err()
            .report
            .to_string();
        assert!(text.contains("add to Cargo.toml:"), "{text}");

        // Listed as a member as well, the crate belongs to the nearer one.
        std::fs::write(
            p.path().join("modules/Cargo.toml"),
            "[workspace]\nmembers = [\"registry\"]\nexclude = [\"registry\"]\n",
        )
        .unwrap();
        let text = build_module(&tc, p.path(), module)
            .unwrap_err()
            .report
            .to_string();
        assert!(text.contains("add to modules/Cargo.toml:"), "{text}");
    }

    #[test]
    fn a_package_workspace_path_is_named_without_dot_segments() {
        let p = project(REGISTRY);
        let tc = fake_cargo(
            p.path(),
            Path::new("/unused"),
            false,
            &p.path().join("count"),
        );
        let module = &read_modules(p.path()).unwrap()[0];
        std::fs::write(
            p.path().join("modules/registry/Cargo.toml"),
            "[package]\nname = \"registry\"\nworkspace = \"./../\"\n",
        )
        .unwrap();
        std::fs::write(
            p.path().join("modules/Cargo.toml"),
            "[workspace]\nmembers = [\"registry\"]\n",
        )
        .unwrap();
        let text = build_module(&tc, p.path(), module)
            .unwrap_err()
            .report
            .to_string();
        assert!(text.contains("add to modules/Cargo.toml:"), "{text}");
    }

    #[test]
    fn a_failed_install_leaves_no_staging_file_and_the_previous_build() {
        let p = project(REGISTRY);
        let built = p.path().join("built.wasm");
        std::fs::write(&built, b"\0asm").unwrap();
        // A non-empty directory where the module goes makes the rename fail.
        let dest = p.path().join(".happyview/build/registry.wasm");
        std::fs::create_dir_all(dest.join("kept")).unwrap();
        install_artifact(p.path(), "registry", &built).unwrap_err();
        assert!(dest.join("kept").is_dir());
        let left: Vec<_> = std::fs::read_dir(p.path().join(".happyview/build"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["registry.wasm"]);
    }

    #[test]
    fn the_fingerprint_sees_a_source_change_and_ignores_build_output() {
        let p = project(REGISTRY);
        let dir = p.path().join("modules/registry");
        std::fs::write(dir.join("src/lib.rs"), "a").unwrap();
        let before = fingerprint(&dir);

        std::fs::create_dir_all(dir.join("target/release")).unwrap();
        std::fs::write(dir.join("target/release/x.wasm"), "built").unwrap();
        assert_eq!(fingerprint(&dir), before, "build output is not source");

        std::fs::write(dir.join("src/lib.rs"), "ab").unwrap();
        assert_ne!(fingerprint(&dir), before);
    }

    #[test]
    fn watch_rebuilds_a_changed_module_once_and_keeps_the_old_build_on_failure() {
        use std::sync::atomic::AtomicBool;
        use std::time::Duration;

        let p = project(REGISTRY);
        let dest = p.path().join(".happyview/build/registry.wasm");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, b"\0asm-old").unwrap();
        let count = p.path().join("count");
        let tc = fake_cargo(p.path(), Path::new("/unused"), true, &count);
        let stop = AtomicBool::new(false);
        let src = p.path().join("modules/registry/src/lib.rs");
        std::fs::write(&src, "a").unwrap();
        let from = Snapshot::take(p.path(), read_modules(p.path()).unwrap());

        let mut outcomes = Vec::new();
        std::thread::scope(|s| {
            s.spawn(|| {
                std::fs::write(&src, "changed").unwrap();
                // A build still under way when `stop` is set is not
                // reported, so the polls that follow are timed from the
                // build rather than from the edit.
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while !count.exists() && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::thread::sleep(Duration::from_millis(400));
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            watch(
                &tc,
                p.path(),
                from,
                Duration::from_millis(50),
                &stop,
                &mut |m, r| {
                    outcomes.push((m.name.clone(), r.is_ok()));
                },
            );
        });

        assert_eq!(outcomes, vec![("registry".to_string(), false)]);
        assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
        assert_eq!(std::fs::read(&dest).unwrap(), b"\0asm-old");
    }

    #[test]
    fn build_each_starts_no_module_once_stopped() {
        let p = project(&format!(
            "{REGISTRY}\n[modules.other]\nlanguage = \"rust\"\npath = \"modules/other\"\ncapabilities = [\"library:call\"]\n"
        ));
        std::fs::create_dir_all(p.path().join("modules/other/src")).unwrap();
        std::fs::write(
            p.path().join("modules/other/Cargo.toml"),
            format!("[package]\nname = \"other\"\n{ABORT}"),
        )
        .unwrap();
        let wasm = p.path().join("built.wasm");
        std::fs::write(&wasm, b"\0asm").unwrap();
        let inner = fake_cargo(p.path(), &wasm, false, &p.path().join("count"));
        // Counted at the version probe, which finishes before a build starts:
        // a build that `stop` kills may die before it records itself.
        let probes = p.path().join("probes");
        let tc = Toolchain {
            cargo: script(
                p.path(),
                "cargo-probed",
                &format!(
                    "[ \"$1\" = --version ] && echo probe >> '{}'\nexec '{}' \"$@\"",
                    probes.display(),
                    inner.cargo.display()
                ),
            )
            .into(),
            rustup: inner.rustup,
        };
        let modules = read_modules(p.path()).unwrap();
        assert_eq!(modules.len(), 2);
        let started = || {
            std::fs::read_to_string(&probes)
                .map(|s| s.lines().count())
                .unwrap_or(0)
        };

        let stop = AtomicBool::new(false);
        let mut built = Vec::new();
        build_each(&tc, p.path(), &modules, &stop, &mut |m, r| {
            built.push((m.name.clone(), r.is_ok()));
            stop.store(true, Ordering::SeqCst);
        });
        assert_eq!(built, vec![(modules[0].name.clone(), true)]);
        assert_eq!(started(), 1);

        build_each(&tc, p.path(), &modules, &stop, &mut |_, _| {
            panic!("nothing is built once stopped")
        });
        assert_eq!(started(), 1);
    }

    /// Sets `stop` when dropped, so a test thread that panics still ends the
    /// watch it is driving instead of leaving it to run forever.
    struct StopOnDrop<'a>(&'a AtomicBool);

    impl Drop for StopOnDrop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// A zombie is already dead; on Linux it stays one under a subreaper
    /// that does not reap, which a CI runner can be.
    fn alive(pid: libc::pid_t) -> bool {
        if cfg!(target_os = "linux") {
            return std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    let state = stat
                        .rsplit_once(')')?
                        .1
                        .split_whitespace()
                        .next()?
                        .to_owned();
                    Some(state != "Z")
                })
                .unwrap_or(false);
        }
        // SAFETY: kill(2) with signal 0 only asks whether the pid exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn stopping_the_watch_ends_a_build_under_way_with_its_children() {
        use std::time::{Duration, Instant};

        let p = project(REGISTRY);
        let pid = p.path().join("cargo.pid");
        let grandchild = p.path().join("rustc.pid");
        // A cargo that starts a child of its own, as cargo starts rustc.
        let body = format!(
            "if [ \"$1\" = --version ]; then exit 0; fi\n\
             sleep 30 &\necho $! > '{}'\necho $$ > '{}'\nwait",
            grandchild.display(),
            pid.display()
        );
        let tc = Toolchain {
            cargo: script(p.path(), "cargo-slow", &body).into(),
            rustup: script(p.path(), "rustup", "echo wasm32-wasip1").into(),
        };
        let stop = AtomicBool::new(false);
        let src = p.path().join("modules/registry/src/lib.rs");
        std::fs::write(&src, "a").unwrap();
        let from = Snapshot::take(p.path(), read_modules(p.path()).unwrap());

        let mut outcomes = 0;
        let (cargo, rustc, stopped_at) = std::thread::scope(|s| {
            let stopper = s.spawn(|| {
                let _stop = StopOnDrop(&stop);
                std::fs::write(&src, "changed").unwrap();
                let deadline = Instant::now() + Duration::from_secs(10);
                let read = |path: &Path| -> Option<libc::pid_t> {
                    std::fs::read_to_string(path).ok()?.trim().parse().ok()
                };
                let cargo = loop {
                    if let Some(pid) = read(&pid) {
                        break pid;
                    }
                    assert!(Instant::now() < deadline, "cargo never started");
                    std::thread::sleep(Duration::from_millis(20));
                };
                let rustc = read(&grandchild).expect("cargo's child is written first");
                stop.store(true, Ordering::SeqCst);
                (cargo, rustc, Instant::now())
            });
            watch(
                &tc,
                p.path(),
                from,
                Duration::from_millis(50),
                &stop,
                &mut |_, _| {
                    outcomes += 1;
                },
            );
            stopper.join().unwrap()
        });
        let waited = stopped_at.elapsed();
        // An orphan is reaped by whichever process adopts it, which takes a
        // moment after the kill.
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(rustc) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let (cargo_alive, rustc_alive) = (alive(cargo), alive(rustc));
        for pid in [cargo, rustc] {
            // SAFETY: ending the fakes this test started, if still running.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        assert!(!cargo_alive, "the stopped build's cargo is still running");
        assert!(!rustc_alive, "the stopped build's child is still running");
        assert!(
            waited < Duration::from_secs(5),
            "watch waited {waited:?} for the build"
        );
        assert_eq!(outcomes, 0, "a stopped build is not reported");
    }

    #[test]
    #[ignore = "builds a real crate; needs cargo and the wasm32-wasip1 target"]
    fn a_real_cargo_build_produces_a_wasm_module() {
        let p = project(REGISTRY);
        std::fs::write(
            p.path().join("modules/registry/Cargo.toml"),
            format!("[package]\nname = \"registry\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[lib]\ncrate-type = [\"cdylib\"]\n[workspace]\n{ABORT}"),
        )
        .unwrap();
        std::fs::write(
            p.path().join("modules/registry/src/lib.rs"),
            "#[no_mangle] pub extern \"C\" fn answer() -> i32 { 42 }\n",
        )
        .unwrap();
        let module = &read_modules(p.path()).unwrap()[0];
        let dest = build_module(&Toolchain::from_env(), p.path(), module).unwrap();
        assert_eq!(&std::fs::read(dest).unwrap()[..4], b"\0asm");
    }
}
