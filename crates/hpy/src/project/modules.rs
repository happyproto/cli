//! A project's compiled script modules: which there are and whether the
//! toolchain can build them. HappyView never runs a compiler; it reads what
//! `hpy` writes to `.happyview/build/<module>.wasm`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

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
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
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
                    "module '{name}' needs a name of lowercase letters, digits, '-' and '_', \
                     since it names its build file"
                )));
            }
            if !is_contained_path(&entry.path) {
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
            "[package]\nname = \"registry\"\n",
        )
        .unwrap();
        dir
    }

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
}
