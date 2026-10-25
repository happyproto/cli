//! `hpy happyview` against a fake HappyView release (a shell script in a
//! `.tar.xz`) and, where a command needs one, a fake registry.

use std::path::{Path, PathBuf};

use assert_cmd::Command;
use predicates::prelude::*;
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const VERSION: &str = "3.0.0-alpha.12";

/// Records its arguments, its working directory, and `PLUGIN_DIR` when it
/// arrives. With `HV_MODE=trap` it runs until a SIGTERM, which it records.
/// With `HV_MODE=signals` it records every SIGTERM, SIGHUP, SIGINT and
/// SIGQUIT, one line each, and runs on until `$HV_LOG.quit` exists, so a
/// second copy of a signal is recorded too; it then exits 7 if a SIGTERM
/// came and 0 otherwise. Waiting on a background `sleep` lets a trap run as
/// its signal arrives. With `HV_MODE=die` a signal ends it.
const FAKE_HAPPYVIEW: &str = r#"#!/bin/sh
echo "$*" >> "$HV_LOG"
pwd -P > "$HV_LOG.cwd"
if [ -n "${PLUGIN_DIR+set}" ]; then
  echo "PLUGIN_DIR=$PLUGIN_DIR" >> "$HV_LOG"
fi
if [ "$HV_MODE" = trap ]; then
  trap 'echo got >> "$HV_LOG.term"; exit 7' TERM
  echo $$ > "$HV_LOG.ready"
  while :; do sleep 0.1; done
fi
if [ "$HV_MODE" = signals ]; then
  code=0
  trap 'echo TERM >> "$HV_LOG.sig"; code=7' TERM
  trap 'echo HUP >> "$HV_LOG.sig"' HUP
  trap 'echo INT >> "$HV_LOG.sig"' INT
  trap 'echo QUIT >> "$HV_LOG.sig"' QUIT
  echo $$ > "$HV_LOG.ready"
  while [ ! -e "$HV_LOG.quit" ]; do sleep 0.1 & wait $!; done
  exit $code
fi
if [ "$HV_MODE" = die ]; then
  kill -KILL $$
fi
exit "${HV_EXIT:-0}"
"#;

/// The asset hpy asks for: musl on Linux, the build triple elsewhere. This
/// repeats `binary::HOST_TARGET`, which an integration test cannot import.
fn target() -> String {
    if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        "x86_64-unknown-linux-musl".into()
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-musl".into()
    } else {
        env!("HPY_TARGET").into()
    }
}

fn tar_xz(name: &str, body: &[u8]) -> Vec<u8> {
    let mut builder = tar::Builder::new(xz2::write::XzEncoder::new(Vec::new(), 6));
    let mut header = tar::Header::new_gnu();
    header.set_size(body.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    builder.append_data(&mut header, name, body).unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

/// Serves the fake release's asset for `target`.
fn serve_release(rt: &tokio::runtime::Runtime, server: &MockServer, target: &str) {
    let asset = format!("happyview-{target}.tar.xz");
    let archive = tar_xz(
        &format!("happyview-{target}/happyview"),
        FAKE_HAPPYVIEW.as_bytes(),
    );
    let sum = data_encoding::HEXLOWER.encode(&Sha256::digest(&archive));
    rt.block_on(async {
        Mock::given(method("GET"))
            .and(path(format!("/dl/v{VERSION}/{asset}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(archive))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/dl/v{VERSION}/{asset}.sha256")))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!("{sum}  {asset}\n")))
            .mount(server)
            .await;
    });
}

struct Stack {
    /// The runtime the mock server runs on, and that tests mount more mocks on.
    rt: tokio::runtime::Runtime,
    server: MockServer,
    config: tempfile::TempDir,
    cache: tempfile::TempDir,
    project: tempfile::TempDir,
    log: PathBuf,
}

impl Stack {
    fn new() -> Stack {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let server = rt.block_on(MockServer::start());
        serve_release(&rt, &server, &target());
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("happyview.toml"),
            format!("[happyview]\nversion = \"{VERSION}\"\n"),
        )
        .unwrap();
        std::fs::write(
            project.path().join("happyview.lock"),
            format!("version = 2\n\n[happyview]\nversion = \"{VERSION}\"\n"),
        )
        .unwrap();
        let log = project.path().join("hv.log");
        // A cache directory the user names must be theirs alone.
        let cache = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(cache.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Stack {
            rt,
            server,
            config: tempfile::tempdir().unwrap(),
            cache,
            project,
            log,
        }
    }

    fn hpy(&self) -> Command {
        let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
        self.env(&mut cmd);
        Command::from_std(cmd)
    }

    fn env(&self, cmd: &mut std::process::Command) {
        cmd.env("XDG_CONFIG_HOME", self.config.path())
            .env("APPDATA", self.config.path())
            .env_remove("HPY_CREDENTIAL")
            .env_remove("PLUGIN_DIR")
            .env("HPY_CREDENTIAL_STORE", "file")
            .env("HPY_NO_UPDATE_CHECK", "1")
            .env("HPY_REGISTRY_URL", self.server.uri())
            .env("HPY_CACHE_DIR", self.cache.path())
            .env("HPY_DATA_DIR", self.cache.path().join("data"))
            .env(
                "HPY_HAPPYVIEW_DOWNLOAD",
                format!("{}/dl", self.server.uri()),
            )
            .env("HPY_GITHUB_API", self.server.uri())
            .env("HV_LOG", &self.log)
            .current_dir(self.project.path());
    }

    #[cfg(unix)]
    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

/// Waits for the fake binary under `hpy` to report its pid, or answers why it
/// did not. Fetching and placing the binary has a budget of its own, and the
/// readiness deadline starts once it is in place: a cold run on a loaded
/// machine can spend longer starting `hpy` and fetching than everything these
/// tests check, and how long that takes is not what they are about.
#[cfg(unix)]
fn await_binary(stack: &Stack, hpy: &mut std::process::Child) -> Result<libc::pid_t, &'static str> {
    use std::time::{Duration, Instant};

    let placed = stack
        .cache
        .path()
        .join(format!("happyview/{VERSION}/happyview"));
    let ready = stack.log.with_extension("log.ready");
    let mut deadline = Instant::now() + Duration::from_secs(120);
    let mut in_place = false;
    loop {
        // The file can be seen before its line is written.
        if let Some(pid) = std::fs::read_to_string(&ready)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            return Ok(pid);
        }
        if !in_place && placed.exists() {
            in_place = true;
            deadline = Instant::now() + Duration::from_secs(30);
        }
        if hpy.try_wait().unwrap().is_some() {
            return Err("hpy exited before the binary was ready");
        }
        if Instant::now() >= deadline {
            return Err("the binary never became ready");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Output that holds `needle` once an error report's wrapping is undone. A
/// report wraps to the terminal's width, breaking long words as well, so
/// where its lines break moves with the length of any path in it; both sides
/// are compared without whitespace or the report's `│` gutter.
fn says(needle: impl Into<String>) -> impl Predicate<[u8]> {
    fn flat(text: &str) -> String {
        text.chars()
            .filter(|c| !c.is_whitespace() && *c != '│')
            .collect()
    }
    let needle = flat(&needle.into());
    predicate::function(move |out: &[u8]| flat(&String::from_utf8_lossy(out)).contains(&needle))
}

#[cfg(unix)]
#[test]
fn check_runs_the_pinned_binary_and_passes_its_exit_code_through() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["happyview", "check"])
        .env("HV_EXIT", "3")
        .assert()
        .code(3)
        .stderr(predicate::str::contains("Error").not());
    assert_eq!(stack.log().trim(), "check .");
    assert!(
        stack
            .cache
            .path()
            .join(format!("happyview/{VERSION}/happyview"))
            .is_file()
    );
    assert!(stack.project.path().join(".happyview/plugins").is_dir());
}

/// The lock entry `hpy` writes for `version` of `name` as `version_json`
/// describes it.
#[cfg(unix)]
fn lock_entry(name: &str, key: &str, version: &serde_json::Value) -> String {
    let artifact = &version["artifact"];
    format!(
        "[[plugin]]\nid = \"{name}\"\nkind = \"interpreter\"\nkeys = [\"{key}\"]\n\
         project = \"at://{HV_DID}/software.release.project/{name}\"\nversion = \"{}\"\n\
         channel = \"latest\"\nversion_uri = \"{}\"\nmanifest_cid = \"{}\"\npackage_cid = \"{}\"\n\
         manifest_blob_cid = \"{}\"\ndependencies = []\n",
        version["version"].as_str().unwrap(),
        version["uri"].as_str().unwrap(),
        version["manifest"]["cid"].as_str().unwrap(),
        artifact["package"]["ref"]["$link"].as_str().unwrap(),
        artifact["manifest"]["ref"]["$link"].as_str().unwrap(),
    )
}

#[cfg(unix)]
fn lua_project(stack: &Stack) -> serde_json::Value {
    let lua = Plugin::interpreter("happyview-lua", "lua", b"\0asm lua");
    let version = lua.version_json();
    mount_registry(stack, &[lua]);
    std::fs::write(
        stack.project.path().join("happyview.toml"),
        format!(
            "[happyview]\nversion = \"{VERSION}\"\n[interpreters]\n\
             lua = {{ did = \"{HV_DID}\", name = \"happyview-lua\", channel = \"latest\" }}\n"
        ),
    )
    .unwrap();
    std::fs::write(
        stack.project.path().join("happyview.lock"),
        format!(
            "version = 2\n\n[happyview]\nversion = \"{VERSION}\"\n\n{}",
            lock_entry("happyview-lua", "lua", &version)
        ),
    )
    .unwrap();
    version
}

#[cfg(unix)]
#[test]
fn check_places_and_verifies_locked_plugins() {
    let stack = Stack::new();
    lua_project(&stack);
    let lock = read(&stack.project.path().join("happyview.lock"));
    stack
        .hpy()
        .args(["hv", "check", "--locked"])
        .assert()
        .success();
    assert_eq!(read(&stack.project.path().join("happyview.lock")), lock);
    assert_eq!(stack.log().trim(), "check .");
    assert_eq!(
        std::fs::read(
            stack
                .cache
                .path()
                .join("plugins/happyview-lua/1.4.2/happyview-lua.wasm")
        )
        .unwrap(),
        b"\0asm lua"
    );
    let placed = stack
        .project
        .path()
        .join(".happyview/plugins/happyview-lua/manifest.json");
    let manifest = read(&placed);
    assert!(manifest.contains("\"language_id\": \"lua\""), "{manifest}");
    assert!(manifest.contains("\"name\": \"Lua\""), "{manifest}");
}

#[cfg(unix)]
#[test]
fn check_refuses_bytes_that_do_not_match_their_cid() {
    let stack = Stack::new();
    let version = lua_project(&stack);
    let package = version["artifact"]["package"]["ref"]["$link"]
        .as_str()
        .unwrap()
        .to_string();
    stack.rt.block_on(async {
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getArtifact"))
            .and(wiremock::matchers::query_param("cid", package.as_str()))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/wasm")
                    .set_body_bytes(b"\0asm evil".to_vec()),
            )
            .with_priority(1)
            .mount(&stack.server)
            .await;
    });
    stack
        .hpy()
        .args(["hv", "check"])
        .assert()
        .code(1)
        .stderr(says(package.clone()))
        .stderr(says(hpy_plugin::checksum::raw_cid(b"\0asm evil")));
    assert!(stack.log().is_empty(), "the binary ran");
    assert!(
        !stack
            .cache
            .path()
            .join("plugins/happyview-lua/1.4.2")
            .exists()
    );
}

#[test]
fn a_lock_from_before_the_registry_moved_says_to_delete_it() {
    let stack = Stack::new();
    std::fs::write(
        stack.project.path().join("happyview.lock"),
        format!("version = 1\n\n[happyview]\nversion = \"{VERSION}\"\n"),
    )
    .unwrap();
    stack.hpy().args(["hv", "check"]).assert().code(2).stderr(says(
        "happyview.lock predates the software.release registry; delete it and run hpy happyview check",
    ));
}

#[test]
fn a_bare_version_in_happyview_toml_names_the_table_form() {
    let stack = Stack::new();
    std::fs::write(
        stack.project.path().join("happyview.toml"),
        format!("[happyview]\nversion = \"{VERSION}\"\n[interpreters]\nlua = \"*\"\n"),
    )
    .unwrap();
    stack
        .hpy()
        .args(["hv", "check"])
        .assert()
        .code(2)
        .stderr(says("interpreters.lua"))
        .stderr(says("did = "));
}

#[cfg(unix)]
#[test]
fn an_inherited_plugin_dir_is_named_and_kept_from_the_binary() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["hv", "check"])
        .env("PLUGIN_DIR", "/elsewhere")
        .assert()
        .success()
        .stderr(predicate::str::contains("warning: ignoring PLUGIN_DIR"));
    assert_eq!(stack.log().trim(), "check .");
}

#[cfg(unix)]
#[test]
fn test_passes_watch_and_filter_and_hv_is_an_alias() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["hv", "test", "--watch", "getArtifact"])
        .assert()
        .success();
    assert_eq!(stack.log().trim(), "test . --watch getArtifact");
}

#[cfg(unix)]
#[test]
fn check_and_test_build_the_modules_then_run_the_binary() {
    use std::os::unix::fs::PermissionsExt;

    let stack = Stack::new();
    let root = stack.project.path();
    std::fs::write(
        root.join("happyview.toml"),
        format!(
            "[happyview]\nversion = \"{VERSION}\"\n\
             [modules.registry]\nlanguage = \"rust\"\npath = \"modules/registry\"\n"
        ),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("modules/registry")).unwrap();
    std::fs::write(
        root.join("modules/registry/Cargo.toml"),
        "[package]\nname = \"registry\"\n[profile.release]\npanic = \"abort\"\n",
    )
    .unwrap();
    let built = root.join("built.wasm");
    let cargo = root.join("cargo");
    std::fs::write(
        &cargo,
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then exit 0; fi\n\
             if [ -n \"$NET_LOG\" ]; then echo 'cargo build' >> \"$NET_LOG\"; fi\n\
             manifest=''; while [ $# -gt 0 ]; do [ \"$1\" = --manifest-path ] && manifest=\"$2\"; shift; done\n\
             printf '{{\"reason\":\"compiler-artifact\",\"manifest_path\":\"%s\",\"target\":{{\"crate_types\":[\"cdylib\"]}},\"filenames\":[\"{}\"]}}\\n' \"$manifest\"\n",
            built.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&cargo, std::fs::Permissions::from_mode(0o755)).unwrap();
    let dest = root.join(".happyview/build/registry.wasm");
    for (command, version) in [("check", b"\0asm-1"), ("test", b"\0asm-2")] {
        std::fs::write(&built, version).unwrap();
        stack
            .hpy()
            .args(["hv", command])
            .env("HPY_CARGO", &cargo)
            .env("HPY_RUSTUP", "/nonexistent/rustup")
            .assert()
            .success();
        assert_eq!(std::fs::read(&dest).unwrap(), version, "{command}");
        assert!(stack.log().trim_end().ends_with(&format!("{command} .")));
    }
}

#[cfg(unix)]
#[test]
fn commands_find_the_project_from_a_subdirectory() {
    let stack = Stack::new();
    let deep = stack.project.path().join("src/lexicons");
    std::fs::create_dir_all(&deep).unwrap();
    stack
        .hpy()
        .current_dir(&deep)
        .args(["hv", "check"])
        .assert()
        .success();
    assert_eq!(stack.log().trim(), "check .");
    assert_eq!(
        read(&stack.log.with_extension("log.cwd")).trim(),
        std::fs::canonicalize(stack.project.path())
            .unwrap()
            .display()
            .to_string()
    );
}

#[cfg(unix)]
#[test]
fn a_failing_check_exits_with_its_code_and_hpy_adds_nothing() {
    let stack = Stack::new();
    // The first run downloads the binary and says so.
    stack.hpy().args(["hv", "check"]).assert().success();
    stack
        .hpy()
        .args(["hv", "check"])
        .env("HV_EXIT", "5")
        .assert()
        .code(5)
        .stderr(predicate::str::is_empty());
}

#[cfg(unix)]
#[test]
fn a_sigterm_to_hpy_reaches_the_binary_once_and_its_exit_code_comes_back() {
    use std::time::{Duration, Instant};

    let stack = Stack::new();
    let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
    stack.env(&mut cmd);
    let mut child = cmd
        .args(["hv", "check"])
        .env("HV_MODE", "trap")
        .stdin(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let binary = await_binary(&stack, &mut child).unwrap_or_else(|why| {
        let _ = child.kill();
        panic!("{why}")
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    // SAFETY: kill(2) with the pid of a child this test spawned and has not reaped.
    assert_eq!(
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) },
        0
    );
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("hpy did not exit after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // A binary still alive here was orphaned, and would hold this test's
    // output open; it is stopped before anything is asserted.
    // SAFETY: kill(2) on a pid the fake binary reported for itself.
    if unsafe { libc::kill(binary, 0) } == 0 {
        unsafe { libc::kill(binary, libc::SIGKILL) };
        panic!("hpy exited ({status}) and left the binary running");
    }
    assert_eq!(
        binary,
        child.id() as libc::pid_t,
        "hpy did not become the binary"
    );
    assert_eq!(status.code(), Some(7));
    assert_eq!(read(&stack.log.with_extension("log.term")), "got\n");
}

#[test]
fn outside_a_project_is_a_usage_error() {
    let stack = Stack::new();
    let elsewhere = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .current_dir(elsewhere.path())
        .args(["hv", "check"])
        .assert()
        .code(2)
        .stderr(says("hpy happyview create"));
}

#[test]
fn locked_refuses_a_lock_that_no_longer_matches() {
    let stack = Stack::new();
    std::fs::write(
        stack.project.path().join("happyview.toml"),
        format!(
            "[happyview]\nversion = \"{VERSION}\"\n[interpreters]\n\
             lua = {{ did = \"{HV_DID}\", name = \"happyview-lua\", channel = \"latest\" }}\n"
        ),
    )
    .unwrap();
    stack
        .hpy()
        .args(["hv", "check", "--locked"])
        .assert()
        .code(2)
        .stderr(says("interpreter `lua` is not in the lock"));
    assert!(!read(&stack.project.path().join("happyview.lock")).contains("lua"));
}

#[cfg(unix)]
#[test]
fn dev_runs_happyview_dev_in_the_project() {
    let stack = Stack::new();
    stack.hpy().args(["hv", "dev"]).assert().success();
    assert_eq!(stack.log().trim(), "dev .");
    assert_eq!(
        read(&stack.log.with_extension("log.cwd")).trim(),
        std::fs::canonicalize(stack.project.path())
            .unwrap()
            .display()
            .to_string()
    );
}

#[cfg(unix)]
#[test]
fn dev_passes_the_childs_exit_code_through() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["hv", "dev"])
        .env("HV_EXIT", "6")
        .assert()
        .code(6);
}

#[cfg(unix)]
#[test]
fn dev_does_not_hand_the_binary_a_plugin_dir() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["hv", "dev"])
        .env("PLUGIN_DIR", "/elsewhere")
        .assert()
        .success();
    assert!(!stack.log().contains("PLUGIN_DIR"), "{}", stack.log());
}

#[cfg(unix)]
#[test]
fn dev_receives_sigterm_and_exits_with_the_childs_code() {
    use std::time::{Duration, Instant};

    let stack = Stack::new();
    let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
    stack.env(&mut cmd);
    let mut child = cmd
        .args(["hv", "dev"])
        .env("HV_MODE", "trap")
        .stdin(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let binary = await_binary(&stack, &mut child).unwrap_or_else(|why| {
        let _ = child.kill();
        panic!("{why}")
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    // Without modules there is nothing for `hpy` to do alongside the binary.
    if binary != child.id() as libc::pid_t {
        // SAFETY: kill(2) on the pids this test spawned or was told of.
        unsafe {
            libc::kill(binary, libc::SIGKILL);
            libc::kill(child.id() as libc::pid_t, libc::SIGKILL);
        }
        panic!("hpy did not become the binary");
    }
    // SAFETY: kill(2) with the pid of a child this test spawned and has not reaped.
    assert_eq!(
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) },
        0
    );
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("hpy did not exit after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(7));
    assert_eq!(read(&stack.log.with_extension("log.term")), "got\n");
}

/// Declares one Rust module whose builds, by a fake cargo that `HPY_CARGO`
/// names, install whatever `built.wasm` holds at the time. Answers the
/// environment that fake needs, and the path the module installs to.
#[cfg(unix)]
fn declare_module(stack: &Stack) -> (Vec<(&'static str, PathBuf)>, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let root = stack.project.path();
    std::fs::write(
        root.join("happyview.toml"),
        format!(
            "[happyview]\nversion = \"{VERSION}\"\n\
             [modules.registry]\nlanguage = \"rust\"\npath = \"modules/registry\"\n"
        ),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("modules/registry/src")).unwrap();
    std::fs::write(
        root.join("modules/registry/Cargo.toml"),
        "[package]\nname = \"registry\"\n[profile.release]\npanic = \"abort\"\n",
    )
    .unwrap();
    std::fs::write(root.join("modules/registry/src/lib.rs"), "").unwrap();
    let built = root.join("built.wasm");
    std::fs::write(&built, b"\0asm-1").unwrap();
    let cargo = root.join("cargo");
    std::fs::write(
        &cargo,
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then exit 0; fi\n\
             if [ -n \"$NET_LOG\" ]; then echo 'cargo build' >> \"$NET_LOG\"; fi\n\
             manifest=''; while [ $# -gt 0 ]; do [ \"$1\" = --manifest-path ] && manifest=\"$2\"; shift; done\n\
             printf '{{\"reason\":\"compiler-artifact\",\"manifest_path\":\"%s\",\"target\":{{\"crate_types\":[\"cdylib\"]}},\"filenames\":[\"{}\"]}}\\n' \"$manifest\"\n",
            built.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&cargo, std::fs::Permissions::from_mode(0o755)).unwrap();
    (
        vec![
            ("HPY_CARGO", cargo),
            ("HPY_RUSTUP", PathBuf::from("/nonexistent/rustup")),
        ],
        root.join(".happyview/build/registry.wasm"),
    )
}

/// A running `hpy` and the fake binary under it.
#[cfg(unix)]
struct Running {
    hpy: std::process::Child,
    binary: libc::pid_t,
}

#[cfg(unix)]
impl Running {
    /// Starts `hpy` with `args` in a process group of its own, as a terminal
    /// would, and waits until the fake binary in `HV_MODE=signals` is up.
    fn start(stack: &Stack, args: &[&str], envs: &[(&str, PathBuf)]) -> Running {
        use std::os::unix::process::CommandExt;

        let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
        stack.env(&mut cmd);
        let mut hpy = cmd
            .args(args)
            .envs(envs.iter().map(|(k, v)| (*k, v)))
            .env("HV_MODE", "signals")
            .stdin(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let binary = await_binary(stack, &mut hpy).unwrap_or_else(|why| {
            // SAFETY: kill(2) on the group of a child this test spawned.
            unsafe { libc::kill(-(hpy.id() as libc::pid_t), libc::SIGKILL) };
            panic!("{why}")
        });
        if binary == hpy.id() as libc::pid_t {
            // SAFETY: as above.
            unsafe { libc::kill(-binary, libc::SIGKILL) };
            panic!("hpy became the binary instead of watching the modules");
        }
        Running { hpy, binary }
    }

    fn signal(&self, signal: libc::c_int) {
        // SAFETY: kill(2) on a child this test spawned and has not reaped.
        assert_eq!(
            unsafe { libc::kill(self.hpy.id() as libc::pid_t, signal) },
            0
        );
    }

    fn signal_group(&self, signal: libc::c_int) {
        // SAFETY: as above, on its process group.
        assert_eq!(
            unsafe { libc::kill(-(self.hpy.id() as libc::pid_t), signal) },
            0
        );
    }

    /// Lets any further copy of a signal just sent land, then tells the
    /// binary to exit, and answers `hpy`'s exit status.
    fn settle_and_quit(self, stack: &Stack) -> std::process::ExitStatus {
        // Long enough for a forwarded copy to land after the first has been
        // handled, rather than merging with it while pending.
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::fs::write(stack.log.with_extension("log.quit"), "").unwrap();
        self.wait()
    }

    /// `hpy`'s exit status, after which the binary must be gone too.
    fn wait(mut self) -> std::process::ExitStatus {
        use std::time::{Duration, Instant};

        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = self.hpy.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                self.signal_group(libc::SIGKILL);
                panic!("hpy did not exit");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        // SAFETY: kill(2) on a pid the fake binary reported for itself.
        if unsafe { libc::kill(self.binary, 0) } == 0 {
            unsafe { libc::kill(self.binary, libc::SIGKILL) };
            panic!("hpy exited ({status}) and left the binary running");
        }
        status
    }
}

#[cfg(unix)]
fn signals_received(stack: &Stack) -> String {
    std::fs::read_to_string(stack.log.with_extension("log.sig")).unwrap_or_default()
}

#[cfg(unix)]
#[test]
fn dev_with_modules_passes_the_childs_exit_code_through() {
    let stack = Stack::new();
    let (envs, _) = declare_module(&stack);
    let mut cmd = stack.hpy();
    cmd.args(["hv", "dev"]).env("HV_EXIT", "3");
    for (k, v) in &envs {
        cmd.env(k, v);
    }
    cmd.assert().code(3);
    assert_eq!(stack.log().trim(), "dev .");
}

#[cfg(unix)]
#[test]
fn dev_with_modules_reports_a_signal_death_as_a_shell_does() {
    let stack = Stack::new();
    let (envs, _) = declare_module(&stack);
    let mut cmd = stack.hpy();
    cmd.args(["hv", "dev"]).env("HV_MODE", "die");
    for (k, v) in &envs {
        cmd.env(k, v);
    }
    // A `hpy` that had become the binary would itself die by the signal and
    // have no exit code at all.
    cmd.assert().code(128 + libc::SIGKILL);
}

#[cfg(unix)]
#[test]
fn dev_with_modules_forwards_one_sigterm_and_exits_with_the_childs_code() {
    let stack = Stack::new();
    let (envs, _) = declare_module(&stack);
    let running = Running::start(&stack, &["hv", "dev"], &envs);
    running.signal(libc::SIGTERM);
    assert_eq!(running.settle_and_quit(&stack).code(), Some(7));
    assert_eq!(signals_received(&stack), "TERM\n");
}

#[cfg(unix)]
#[test]
fn dev_with_modules_forwards_a_sighup_once() {
    let stack = Stack::new();
    let (envs, _) = declare_module(&stack);
    let running = Running::start(&stack, &["hv", "dev"], &envs);
    running.signal(libc::SIGHUP);
    assert_eq!(running.settle_and_quit(&stack).code(), Some(0));
    assert_eq!(signals_received(&stack), "HUP\n");
}

#[cfg(unix)]
#[test]
fn ctrl_c_reaches_the_binary_once_through_the_terminals_group() {
    let stack = Stack::new();
    let (envs, _) = declare_module(&stack);
    let running = Running::start(&stack, &["hv", "dev"], &envs);
    running.signal_group(libc::SIGINT);
    // `hpy` outlived the Ctrl-C, and reports the binary's own exit.
    assert_eq!(running.settle_and_quit(&stack).code(), Some(0));
    assert_eq!(signals_received(&stack), "INT\n");
}

#[cfg(unix)]
#[test]
fn ctrl_backslash_reaches_the_binary_once_through_the_terminals_group() {
    let stack = Stack::new();
    let (envs, _) = declare_module(&stack);
    let running = Running::start(&stack, &["hv", "dev"], &envs);
    running.signal_group(libc::SIGQUIT);
    assert_eq!(running.settle_and_quit(&stack).code(), Some(0));
    assert_eq!(signals_received(&stack), "QUIT\n");
}

#[cfg(target_os = "linux")]
#[test]
fn a_killed_hpy_takes_the_binary_with_it() {
    use std::time::{Duration, Instant};

    let stack = Stack::new();
    let (envs, _) = declare_module(&stack);
    let mut running = Running::start(&stack, &["hv", "dev"], &envs);
    running.hpy.kill().unwrap();
    running.hpy.wait().unwrap();
    // A zombie is already dead; it stays one only under a parent that does
    // not reap, as a container's first process may not.
    let alive = |pid: libc::pid_t| {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
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
            .unwrap_or(false)
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(running.binary) {
        if Instant::now() >= deadline {
            // SAFETY: kill(2) on a pid the fake binary reported for itself.
            unsafe { libc::kill(running.binary, libc::SIGKILL) };
            panic!("the binary outlived hpy");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn a_failed_module_build_shows_cargos_own_diagnostics() {
    use std::os::unix::fs::PermissionsExt;

    let stack = Stack::new();
    let (mut envs, _) = declare_module(&stack);
    let cargo = stack.project.path().join("cargo-broken");
    std::fs::write(
        &cargo,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then exit 0; fi\n\
         echo 'error[E0425]: cannot find value `answr` in this scope' >&2\nexit 101\n",
    )
    .unwrap();
    std::fs::set_permissions(&cargo, std::fs::Permissions::from_mode(0o755)).unwrap();
    envs[0].1 = cargo;
    let mut cmd = stack.hpy();
    cmd.args(["hv", "build"]);
    for (k, v) in &envs {
        cmd.env(k, v);
    }
    cmd.assert().code(1).stderr(
        says("error[E0425]: cannot find value `answr` in this scope")
            .and(says("'registry' failed to build")),
    );
}

/// Changes the module's source with `next` as what its next build installs,
/// and waits for `dest` to hold it.
#[cfg(unix)]
fn edit_and_await_rebuild(stack: &Stack, dest: &Path, next: &[u8]) {
    use std::time::{Duration, Instant};

    let root = stack.project.path();
    std::fs::write(root.join("built.wasm"), next).unwrap();
    std::fs::write(root.join("modules/registry/src/lib.rs"), "// edited\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while std::fs::read(dest).ok().as_deref() != Some(next) {
        assert!(Instant::now() < deadline, "the module was never rebuilt");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
#[test]
fn dev_rebuilds_a_module_when_its_source_changes() {
    let stack = Stack::new();
    let (envs, dest) = declare_module(&stack);
    let running = Running::start(&stack, &["hv", "dev"], &envs);
    assert_eq!(std::fs::read(&dest).unwrap(), b"\0asm-1");
    edit_and_await_rebuild(&stack, &dest, b"\0asm-2");
    assert_eq!(running.settle_and_quit(&stack).code(), Some(0));
}

#[cfg(unix)]
#[test]
fn test_watch_rebuilds_a_module_when_its_source_changes() {
    let stack = Stack::new();
    let (envs, dest) = declare_module(&stack);
    let running = Running::start(&stack, &["hv", "test", "--watch"], &envs);
    assert_eq!(std::fs::read(&dest).unwrap(), b"\0asm-1");
    edit_and_await_rebuild(&stack, &dest, b"\0asm-2");
    assert_eq!(running.settle_and_quit(&stack).code(), Some(0));
    assert_eq!(stack.log().trim(), "test . --watch");
}

#[test]
fn add_validates_the_project_before_touching_the_network() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["hv", "add", "lua", "--project", "not-a-uri"])
        .assert()
        .code(2)
        .stderr(says("--project"));
    assert!(!read(&stack.project.path().join("happyview.toml")).contains("lua"));
}

const HV_DID: &str = "did:plc:hv";

/// One plugin the fake registry serves: a single version, 1.4.2, which its
/// `latest` channel points at.
struct Plugin {
    name: String,
    plugin_type: &'static str,
    display_name: String,
    fields: serde_json::Value,
    wasm: Vec<u8>,
    manifest: Vec<u8>,
}

impl Plugin {
    fn interpreter(name: &str, language: &str, wasm: &[u8]) -> Plugin {
        Plugin {
            name: name.into(),
            plugin_type: "interpreter",
            display_name: "Lua".into(),
            fields: serde_json::json!({
                "pluginType": "interpreter", "apiVersion": "2", "languageId": language,
                "fileExtensions": [language], "capabilities": ["script:host"]
            }),
            wasm: wasm.to_vec(),
            manifest: format!("{{\"id\":\"{name}\"}}").into_bytes(),
        }
    }

    fn library(name: &str, namespace: &str, wasm: &[u8]) -> Plugin {
        Plugin {
            name: name.into(),
            plugin_type: "library",
            display_name: "HTTP".into(),
            fields: serde_json::json!({
                "pluginType": "library", "apiVersion": "2", "namespace": namespace,
                "capabilities": []
            }),
            wasm: wasm.to_vec(),
            manifest: format!("{{\"id\":\"{name}\"}}").into_bytes(),
        }
    }

    fn version_json(&self) -> serde_json::Value {
        use hpy_plugin::artifact::predicted_blob;
        use hpy_plugin::checksum::raw_cid;
        let mut artifact = serde_json::json!({
            "$type": "at.happyproto.plugin.v1",
            "package": predicted_blob(&self.wasm, "application/wasm"),
            "manifest": predicted_blob(&self.manifest, "application/json"),
            "capabilities": [],
            "license": "MIT",
            "sections": { "description": "A plugin." },
        });
        for (k, v) in self.fields.as_object().unwrap() {
            artifact[k] = v.clone();
        }
        let name = &self.name;
        serde_json::json!({
            "uri": format!("at://{HV_DID}/software.release.version/{name}:1.4.2"),
            "cid": raw_cid(format!("version {name}").as_bytes()),
            "did": HV_DID, "name": name, "version": "1.4.2",
            "manifest": {
                "uri": format!("at://{HV_DID}/software.release.manifest/3l{name}"),
                "cid": raw_cid(artifact.to_string().as_bytes()),
            },
            "artifact": artifact,
            "availability": "available",
            "suspect": false,
            "lifecycle": { "state": "active", "installable": true, "events": [] },
            "indexedAt": "2026-10-23T00:00:00Z"
        })
    }

    fn project_json(&self) -> serde_json::Value {
        let name = &self.name;
        let version = self.version_json();
        serde_json::json!({
            "uri": format!("at://{HV_DID}/software.release.project/{name}"),
            "did": HV_DID, "name": name,
            "sidecar": { "uri": format!("at://{HV_DID}/at.happyproto.registry.project/{name}") },
            "publication": {
                "uri": format!("at://{HV_DID}/site.standard.publication/{name}"),
                "cid": "bafypublication", "name": self.display_name,
                "url": format!("https://happyproto.at/plugins/{HV_DID}/{name}")
            },
            "pluginType": self.plugin_type,
            "channels": { "latest": {
                "version": "1.4.2", "uri": version["uri"], "cid": version["cid"],
                "state": "active", "availability": "available"
            } },
            "lifecycle": { "state": "active" },
            "indexedAt": "2026-10-23T00:00:00Z"
        })
    }
}

/// A registry serving `plugins` through the read API, with the not-found
/// answers the real one gives for anything else.
fn mount_registry(stack: &Stack, plugins: &[Plugin]) {
    use wiremock::matchers::query_param;
    let get = |nsid: &str| {
        Mock::given(method("GET")).and(path(format!("/xrpc/at.happyproto.registry.{nsid}")))
    };
    stack.rt.block_on(async {
        for plugin_type in ["interpreter", "library"] {
            let projects: Vec<serde_json::Value> = plugins
                .iter()
                .filter(|p| p.plugin_type == plugin_type)
                .map(Plugin::project_json)
                .collect();
            get("searchProjects")
                .and(query_param("pluginType", plugin_type))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({ "projects": projects })),
                )
                .mount(&stack.server)
                .await;
        }
        for p in plugins {
            let version = p.version_json();
            let name = p.name.as_str();
            get("getProject")
                .and(query_param("name", name))
                .respond_with(ResponseTemplate::new(200).set_body_json(p.project_json()))
                .mount(&stack.server)
                .await;
            get("resolveChannel")
                .and(query_param("name", name))
                .and(query_param("channel", "latest"))
                .respond_with(ResponseTemplate::new(200).set_body_json(version.clone()))
                .mount(&stack.server)
                .await;
            get("getVersion")
                .and(query_param("name", name))
                .and(query_param("version", "1.4.2"))
                .respond_with(ResponseTemplate::new(200).set_body_json(version.clone()))
                .mount(&stack.server)
                .await;
            get("listVersions")
                .and(query_param("name", name))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({ "versions": [version] })),
                )
                .mount(&stack.server)
                .await;
            for bytes in [&p.wasm, &p.manifest] {
                get("getArtifact")
                    .and(query_param(
                        "cid",
                        hpy_plugin::checksum::raw_cid(bytes).as_str(),
                    ))
                    .respond_with(
                        ResponseTemplate::new(200)
                            .insert_header("content-type", "application/octet-stream")
                            .set_body_bytes(bytes.clone()),
                    )
                    .mount(&stack.server)
                    .await;
            }
        }
        for (nsid, error) in [
            ("getProject", "ProjectNotFound"),
            ("resolveChannel", "ChannelNotFound"),
            ("getVersion", "VersionNotFound"),
            ("listVersions", "ProjectNotFound"),
            ("getArtifact", "ArtifactNotHeld"),
        ] {
            get(nsid)
                .respond_with(
                    ResponseTemplate::new(400)
                        .set_body_json(serde_json::json!({ "error": error, "message": "no" })),
                )
                .with_priority(10)
                .mount(&stack.server)
                .await;
        }
    });
}

fn mount_lua(stack: &Stack) {
    mount_registry(
        stack,
        &[Plugin::interpreter("happyview-lua", "lua", b"\0asm lua")],
    );
}

const LUA_ENTRY: &str =
    "lua = { did = \"did:plc:hv\", name = \"happyview-lua\", channel = \"latest\" }";

#[test]
fn add_writes_the_entry_and_the_lock_and_downloads() {
    let stack = Stack::new();
    mount_lua(&stack);
    stack
        .hpy()
        .args(["hv", "add", "lua", "--json"])
        .assert()
        .success()
        .stdout(says("\"channel\": \"latest\""))
        .stdout(says("\"version\": \"1.4.2\""));
    let toml = read(&stack.project.path().join("happyview.toml"));
    assert!(toml.contains(LUA_ENTRY), "{toml}");
    let lock = read(&stack.project.path().join("happyview.lock"));
    assert!(lock.contains("version = 2"), "{lock}");
    assert!(
        lock.contains("project = \"at://did:plc:hv/software.release.project/happyview-lua\""),
        "{lock}"
    );
    assert!(
        stack
            .cache
            .path()
            .join("plugins/happyview-lua/1.4.2/happyview-lua.wasm")
            .is_file()
    );
}

#[test]
fn create_writes_a_project_and_its_lock_without_downloading_anything() {
    let stack = Stack::new();
    mount_lua(&stack);
    let parent = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "my-app",
            "--no-input",
            "--superadmin",
            "did:plc:me",
            "--happyview-version",
            VERSION,
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("hpy happyview dev"));
    let app = parent.path().join("my-app");
    let toml = read(&app.join("happyview.toml"));
    assert!(
        toml.contains(LUA_ENTRY) && toml.contains("app_name = \"my-app\""),
        "{toml}"
    );
    let lock = read(&app.join("happyview.lock"));
    assert!(
        lock.contains("id = \"happyview-lua\"") && lock.contains("keys = [\"lua\"]"),
        "{lock}"
    );
    assert!(app.join("src/lexicons/com/example/hello.lua").is_file());
    assert_eq!(read(&app.join(".gitignore")), ".env\n.happyview/\n");
    assert!(
        std::fs::read_dir(stack.cache.path())
            .unwrap()
            .next()
            .is_none(),
        "create downloaded something"
    );
}

#[test]
fn create_resolves_before_writing_anything() {
    let stack = Stack::new();
    mount_lua(&stack);
    let parent = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "my-app",
            "--no-input",
            "--superadmin",
            "did:plc:me",
            "--happyview-version",
            VERSION,
            "--interpreter",
            "lua",
            "--library",
            "happyview.nope",
        ])
        .assert()
        .code(2)
        .stderr(says("happyview.nope"));
    assert!(!parent.path().join("my-app").exists());
}

#[test]
fn create_writes_nothing_when_resolution_refuses_the_release() {
    let stack = Stack::new();
    // An interpreter from before project mode: no file extensions.
    let mut lua = Plugin::interpreter("happyview-lua", "lua", b"\0asm lua");
    lua.fields.as_object_mut().unwrap().remove("fileExtensions");
    mount_registry(&stack, &[lua]);
    let parent = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "my-app",
            "--no-input",
            "--superadmin",
            "did:plc:me",
            "--happyview-version",
            VERSION,
        ])
        .assert()
        .code(2)
        .stderr(says("declares no file extensions"));
    assert!(!parent.path().join("my-app").exists());
}

#[test]
fn create_without_a_login_or_flag_names_superadmin() {
    let stack = Stack::new();
    let parent = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args(["hv", "create", "--name", "my-app", "--no-input"])
        .assert()
        .code(2)
        .stderr(says("--superadmin"));
}

#[test]
fn create_refuses_a_directory_with_files_in_it() {
    let stack = Stack::new();
    let parent = tempfile::tempdir().unwrap();
    std::fs::create_dir(parent.path().join("taken")).unwrap();
    std::fs::write(parent.path().join("taken/notes.txt"), "mine").unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "taken",
            "--no-input",
            "--superadmin",
            "did:plc:me",
        ])
        .assert()
        .code(2)
        .stderr(says("not empty"));
    assert_eq!(read(&parent.path().join("taken/notes.txt")), "mine");
}

#[test]
fn create_takes_a_project_where_several_answer() {
    let stack = Stack::new();
    mount_registry(
        &stack,
        &[
            Plugin::interpreter("happyview-lua", "lua", b"\0asm lua"),
            Plugin::interpreter("other-lua", "lua", b"\0asm other"),
        ],
    );
    let parent = tempfile::tempdir().unwrap();
    let create = |name: &str, project: Option<&str>| {
        let mut cmd = stack.hpy();
        cmd.current_dir(parent.path()).args([
            "hv",
            "create",
            "--name",
            name,
            "--no-input",
            "--superadmin",
            "did:plc:me",
            "--happyview-version",
            VERSION,
        ]);
        if let Some(uri) = project {
            cmd.args(["--project", uri]);
        }
        cmd.assert()
    };
    create("asked", None)
        .code(2)
        .stderr(says("pass --project <AT-URI> to choose"));
    let other = "at://did:plc:hv/software.release.project/other-lua";
    create("pinned", Some(other)).success();
    let lock = read(&parent.path().join("pinned/happyview.lock"));
    assert!(
        lock.contains("id = \"other-lua\"") && lock.contains(other),
        "{lock}"
    );
    let toml = read(&parent.path().join("pinned/happyview.toml"));
    assert!(toml.contains("name = \"other-lua\""), "{toml}");
    create(
        "stray",
        Some("at://did:plc:hv/software.release.project/nobody"),
    )
    .code(2)
    .stderr(says("nobody answers to"));
    assert!(!parent.path().join("stray").exists());
}

#[test]
fn create_refuses_a_superadmin_that_is_not_a_did() {
    let stack = Stack::new();
    let parent = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "my-app",
            "--no-input",
            "--superadmin",
            "did:PLC:me",
        ])
        .assert()
        .code(2)
        .stderr(says("--superadmin"))
        .stderr(says("is not a DID"));
    assert!(!parent.path().join("my-app").exists());
}

#[test]
fn create_refuses_a_blank_app_name() {
    let stack = Stack::new();
    mount_lua(&stack);
    let parent = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "my-app",
            "--no-input",
            "--superadmin",
            "did:plc:me",
            "--happyview-version",
            VERSION,
            "--app-name",
            "   ",
        ])
        .assert()
        .code(2)
        .stderr(says("--app-name"))
        .stderr(says("must not be empty"));
    assert!(!parent.path().join("my-app").exists());
}

#[test]
fn create_fills_an_existing_empty_directory() {
    let stack = Stack::new();
    mount_lua(&stack);
    let parent = tempfile::tempdir().unwrap();
    std::fs::create_dir(parent.path().join("my-app")).unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "my-app",
            "--no-input",
            "--superadmin",
            "did:plc:me",
            "--happyview-version",
            VERSION,
        ])
        .assert()
        .success();
    let app = parent.path().join("my-app");
    assert!(app.join("happyview.toml").is_file() && app.join("happyview.lock").is_file());
    let names: Vec<_> = std::fs::read_dir(parent.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        names,
        ["my-app"],
        "a temporary directory was left beside it"
    );
}

#[test]
fn create_fills_the_directory_it_is_run_in() {
    let stack = Stack::new();
    mount_lua(&stack);
    let parent = tempfile::tempdir().unwrap();
    let app = parent.path().join("my-app");
    std::fs::create_dir(&app).unwrap();
    stack
        .hpy()
        .current_dir(&app)
        .args([
            "hv",
            "create",
            "--name",
            ".",
            "--no-input",
            "--superadmin",
            "did:plc:me",
            "--happyview-version",
            VERSION,
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("cd .").not());
    let toml = read(&app.join("happyview.toml"));
    assert!(toml.contains("app_name = \"my-app\""), "{toml}");
    assert!(app.join("happyview.lock").is_file());
    let names: Vec<_> = std::fs::read_dir(parent.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, ["my-app"]);
}

#[test]
fn create_refuses_a_name_that_is_a_file() {
    let stack = Stack::new();
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(parent.path().join("my-app"), "mine").unwrap();
    stack
        .hpy()
        .current_dir(parent.path())
        .args([
            "hv",
            "create",
            "--name",
            "my-app",
            "--no-input",
            "--superadmin",
            "did:plc:me",
        ])
        .assert()
        .code(2)
        .stderr(says("is not a directory"));
    assert_eq!(read(&parent.path().join("my-app")), "mine");
}

#[test]
fn create_takes_a_library_by_namespace_or_name() {
    let stack = Stack::new();
    mount_registry(
        &stack,
        &[
            Plugin::interpreter("happyview-lua", "lua", b"\0asm lua"),
            Plugin::library("http-lib", "happyview.http", b"\0asm http"),
        ],
    );
    let parent = tempfile::tempdir().unwrap();
    let create = |name: &str, library: &str| {
        stack
            .hpy()
            .current_dir(parent.path())
            .args([
                "hv",
                "create",
                "--name",
                name,
                "--no-input",
                "--superadmin",
                "did:plc:me",
                "--happyview-version",
                VERSION,
                "--library",
                library,
            ])
            .assert()
    };
    for (name, library) in [("by-namespace", "happyview.http"), ("by-name", "http-lib")] {
        create(name, library).success();
        let toml = read(&parent.path().join(name).join("happyview.toml"));
        let entry = "{ did = \"did:plc:hv\", name = \"http-lib\", channel = \"latest\" }";
        assert!(
            toml.contains(&format!("\"{library}\" = {entry}"))
                || toml.contains(&format!("{library} = {entry}")),
            "{toml}"
        );
        let lock = read(&parent.path().join(name).join("happyview.lock"));
        assert!(lock.contains("id = \"http-lib\""), "{lock}");
    }
    create("neither", "happyview.nope")
        .code(2)
        .stderr(says("--library: `happyview.nope`"));
    assert!(!parent.path().join("neither").exists());
}

#[cfg(unix)]
#[test]
fn a_loose_cache_directory_the_user_named_is_refused_not_changed() {
    use std::os::unix::fs::PermissionsExt;
    let stack = Stack::new();
    std::fs::set_permissions(stack.cache.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    stack
        .hpy()
        .args(["hv", "check"])
        .assert()
        .code(1)
        .stderr(says("chmod 700"));
    let mode = std::fs::metadata(stack.cache.path())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o755);
    assert_eq!(std::fs::read_dir(stack.cache.path()).unwrap().count(), 0);
}

#[test]
fn reset_needs_the_local_network() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["hv", "dev", "--reset"])
        .assert()
        .code(2)
        .stderr(says("--network"));
}

#[cfg(unix)]
#[test]
fn local_without_deno_names_what_to_install() {
    let stack = Stack::new();
    let empty_path = tempfile::tempdir().unwrap();
    stack
        .hpy()
        .env("PATH", empty_path.path())
        .args(["hv", "dev", "--network", "local"])
        .assert()
        .code(2)
        .stderr(says("Deno 2.8"));
}

/// A `deno` standing in for Atmosphere in a Box's CLI: it logs every call and
/// writes the state files the real one would. Like the real one it refuses
/// every sandbox command while `state/cli.lock` exists.
#[cfg(unix)]
const FAKE_DENO: &str = r#"echo "deno $*" >> "$NET_LOG"
case "$*" in
  "task sandbox"*)
    if [ -d state/cli.lock ]; then
      echo "CLI locked; inspect state/cli.lock before removing it after a crash" >&2
      echo "deno refused: locked" >> "$NET_LOG"
      exit 1
    fi ;;
esac
# The real CLI reports progress on stdout; `access hosts` is read by hpy and
# prints only its block.
if [ "$1" = install ]; then
  echo "deno install saw DENO_NO_PACKAGE_JSON=$DENO_NO_PACKAGE_JSON" >> "$NET_LOG"
fi
case "$*" in
  "task sandbox access hosts") ;;
  task*) echo "sandbox progress: $*" ;;
esac
case "$*" in
  --version) echo "deno 2.8.3 (stable, release)" ;;
  "task sandbox create"*)
    mkdir -p state/ca
    echo '{"applications":[]}' > state/manifest.json
    echo fake-ca > state/ca/root.crt ;;
  "task sandbox apply --app happyview")
    echo '{"applications":["happyview"]}' > state/manifest.json ;;
  "task sandbox seed")
    # Fails part way, leaving a step pending.
    if [ -n "$NET_SEED_FAILS" ]; then echo '{}' > state/pending-apply.json; exit 1; fi
    # Waits for `NET_STEP_RELEASE` to appear once it has said it started.
    if [ -n "$NET_SEED_BLOCK" ]; then
      if [ "$NET_SEED_BLOCK" = pending ]; then echo '{}' > state/pending-apply.json; fi
      echo seeding > "$NET_STEP_STARTED"
      while [ ! -f "$NET_STEP_RELEASE" ]; do sleep 0.05; done
    fi
    echo '{"version":1,"accounts":{"user1.pds1.atmosbox.test":{"handle":"user1.pds1.atmosbox.test","password":"seeded-secret-pw","phase":"ready","did":"did:plc:user1"}}}' > state/accounts.json
    echo "deno seed finished" >> "$NET_LOG" ;;
  "task sandbox resume")
    rm -f state/pending-create.json state/pending-apply.json
    mkdir -p state/ca
    [ -f state/manifest.json ] || echo '{"applications":[]}' > state/manifest.json
    echo fake-ca > state/ca/root.crt ;;
  "task sandbox destroy --accept-destructive")
    # The real one reads the project's name from the manifest.
    [ -f state/manifest.json ] || { echo "no manifest" >&2; exit 1; }
    rm -f state/manifest.json state/accounts.json state/pending-create.json state/pending-apply.json ;;
  "task sandbox access hosts")
    if [ -n "$NET_HOSTS" ]; then printf '%s\n' '# begin' "$NET_HOSTS" '# end'; fi ;;
  "task sandbox up"*)
    # Dies holding the lock, as a deno killed mid-operation does.
    if [ -n "$NET_UP_CRASHES" ]; then mkdir state/cli.lock; kill -KILL $$; fi
    # Another command takes the lock first, and this one refuses with an
    # ordinary exit, as the real CLI's "CLI locked" does.
    if [ -n "$NET_UP_CONTENDED" ]; then
      mkdir state/cli.lock
      echo "CLI locked; inspect state/cli.lock before removing it after a crash" >&2
      exit 1
    fi
    if [ -n "$NET_UP_FAILS" ] && grep -q happyview state/manifest.json; then exit 1; fi
    # The `up` that brings HappyView in, blocked as `seed` is above.
    if [ -n "$NET_UP_BLOCK" ] && grep -q happyview state/manifest.json; then
      echo up > "$NET_STEP_STARTED"
      while [ ! -f "$NET_STEP_RELEASE" ]; do sleep 0.05; done
    fi ;;
esac
exit 0"#;

/// A `docker` answering what `hpy` asks of it. `NET_RELAY` names a running
/// access relay; `NET_BLOCK` keeps `logs --follow` open far longer than any
/// test waits, so only `hpy` ending it lets the test finish.
#[cfg(unix)]
const FAKE_DOCKER: &str = r#"echo "docker $*" >> "$NET_LOG"
case "$*" in
  "compose version"*) echo "Docker Compose version v2.40.0" ;;
  "network ls"*) echo bridge ;;
  "network inspect"*) echo "bridge 172.17.0.0/16 " ;;
  "ps --filter label=com.docker.compose.service=host-access"*)
    if [ -n "$NET_RELAY" ]; then echo "$NET_RELAY"; fi ;;
  "ps --filter label=com.docker.compose.project="*)
    printf '%s\n' "hv-test-dns-1 dns" "hv-test-gateway-1 gateway" "hv-test-pds1-1 pds1" \
      "hv-test-plc-1 plc" "hv-test-happyview-1 happyview" ;;
  "info"*) echo aarch64 ;;
  "ps -a"*)
    if grep -q happyview state/manifest.json 2>/dev/null; then echo hv-test-happyview-1; fi ;;
  "logs --tail"*) echo "happyview: could not open the database" ;;
  "logs --follow"*)
    echo "happyview log line"
    if [ -n "$NET_BLOCK" ]; then echo following > "$NET_FOLLOWING"; exec sleep 120; fi ;;
  "inspect"*) echo "true 0" ;;
esac
exit 0"#;

/// A project ready for `dev --network local` against fakes: `deno` and
/// `docker` on PATH, the Linux release served, an installed checkout (so
/// nothing is downloaded), and the access walkthrough already done.
#[cfg(unix)]
struct LocalNet {
    stack: Stack,
    bin: tempfile::TempDir,
    log: PathBuf,
    checkout: PathBuf,
    /// The sandbox's Compose project name.
    project: String,
    /// The subnet `hpy` derives for this project.
    subnet: String,
    /// A port nothing listens on, standing in for 443.
    free_addr: String,
    /// Holds `free_addr` bound, without listening, so nothing else on the
    /// machine can take it while the test runs.
    _reserved: std::os::fd::OwnedFd,
}

#[cfg(unix)]
impl LocalNet {
    fn new() -> LocalNet {
        use std::os::unix::fs::PermissionsExt;

        let stack = Stack::new();
        serve_release(&stack.rt, &stack.server, "aarch64-unknown-linux-musl");
        let bin = tempfile::tempdir().unwrap();
        for (name, body) in [("deno", FAKE_DENO), ("docker", FAKE_DOCKER)] {
            let p = bin.path().join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (net, subnet) = network_dir(&stack.cache.path().join("data"), stack.project.path());
        let checkout = net.join("atmosphereinabox-v0.7.1");
        let project = format!("hv-{}", net.file_name().unwrap().to_string_lossy());
        std::fs::create_dir_all(checkout.join("stacks")).unwrap();
        std::fs::write(checkout.join("stacks/components.json"), "[]").unwrap();
        // The pinned archive's sha256, which marks the checkout installed.
        std::fs::write(
            checkout.join(".hpy-installed"),
            "73bd22ac78ba137a2b5e9b8ffb88944232f1d25f0df42cdd5ab70e8d12bb526c",
        )
        .unwrap();
        let ca = data_encoding::HEXLOWER.encode(&Sha256::digest(b"fake-ca\n"));
        std::fs::write(net.join("access.toml"), format!("ca_sha256 = \"{ca}\"\n")).unwrap();
        let (_reserved, free_addr) = reserve_port();
        let log = bin.path().join("net.log");
        LocalNet {
            stack,
            bin,
            log,
            checkout,
            project,
            subnet,
            free_addr,
            _reserved,
        }
    }

    fn env(&self, cmd: &mut std::process::Command) {
        self.stack.env(cmd);
        cmd.env(
            "PATH",
            format!("{}:/usr/bin:/bin", self.bin.path().display()),
        )
        .env("NET_LOG", &self.log)
        .env("NET_FOLLOWING", self.marker("following"))
        .env("NET_STEP_STARTED", self.marker("step-started"))
        .env("NET_STEP_RELEASE", self.marker("step-release"))
        .env("HPY_NETWORK_ACCESS_ADDR", &self.free_addr)
        .env_remove("NET_RELAY")
        .env_remove("NET_BLOCK")
        .env_remove("NET_UP_FAILS")
        .env_remove("NET_UP_CRASHES")
        .env_remove("NET_UP_CONTENDED")
        .env_remove("NET_SEED_FAILS")
        .env_remove("NET_UP_BLOCK")
        .env_remove("NET_HOSTS")
        .env_remove("NET_SEED_BLOCK");
    }

    /// A file a fake writes, or waits for, to coordinate with a test.
    fn marker(&self, name: &str) -> PathBuf {
        self.bin.path().join(name)
    }

    fn hpy(&self) -> Command {
        let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
        self.env(&mut cmd);
        cmd.args(["hv", "dev", "--network", "local"]);
        Command::from_std(cmd)
    }

    /// The sandbox commands run, in order.
    fn sandbox_calls(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.strip_prefix("deno task sandbox "))
            .map(str::to_string)
            .collect()
    }

    fn calls(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

/// A loopback port bound but never listened on: a connection to it is
/// refused, and no other socket can bind it while the descriptor lives.
#[cfg(unix)]
fn reserve_port() -> (std::os::fd::OwnedFd, String) {
    use std::os::fd::FromRawFd;

    // SAFETY: socket(2) with constant arguments; the descriptor it answers is
    // owned from here on.
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    assert!(fd >= 0, "{}", std::io::Error::last_os_error());
    // SAFETY: `fd` is a fresh descriptor nothing else owns.
    let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    // SAFETY: zeroed is a valid sockaddr_in, filled in below.
    let mut addr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    addr.sin_family = libc::AF_INET as libc::sa_family_t;
    addr.sin_addr.s_addr = u32::from(std::net::Ipv4Addr::LOCALHOST).to_be();
    let mut len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
    // SAFETY: bind(2) and getsockname(2) on the descriptor above, with a
    // sockaddr_in and its true length.
    unsafe {
        assert_eq!(
            libc::bind(fd, (&raw const addr).cast(), len),
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        assert_eq!(
            libc::getsockname(fd, (&raw mut addr).cast(), &mut len),
            0,
            "{}",
            std::io::Error::last_os_error()
        );
    }
    (owned, format!("127.0.0.1:{}", u16::from_be(addr.sin_port)))
}

/// `atmosbox::network_dir` (the directory and the subnet), which an
/// integration test cannot import.
#[cfg(unix)]
fn network_dir(data: &Path, project: &Path) -> (PathBuf, String) {
    let canonical = std::fs::canonicalize(project).unwrap();
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let hash = data_encoding::HEXLOWER.encode(&digest);
    let octet = if digest[0] == 249 { 250 } else { digest[0] };
    let name: String = canonical
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let name: String = name.chars().take(24).collect();
    let name = name.trim_end_matches('-');
    let name = if name.is_empty() { "project" } else { name };
    (
        data.join("networks").join(format!("{name}-{}", &hash[..8])),
        format!("172.30.{octet}.0/24"),
    )
}

#[cfg(unix)]
#[test]
fn a_local_run_without_a_terminal_prints_no_password() {
    let net = LocalNet::new();
    net.hpy().assert().code(0).stderr(
        predicate::str::contains("seeded-secret-pw")
            .not()
            .and(predicate::str::contains(
                net.checkout
                    .join("state/accounts.json")
                    .display()
                    .to_string(),
            ))
            .and(predicate::str::contains(
                "https://happyview.atmosbox.internal",
            )),
    );
    // HappyView joins only after the seed, so it first boots knowing its
    // superadmin; the walkthrough then starts the relay, and the end stops
    // everything.
    assert_eq!(
        net.sandbox_calls(),
        [
            format!(
                "create --pds 1 --users-per-pds 1 --project {} --preset full-stack --subnet {}",
                net.project, net.subnet
            ),
            "check".into(),
            "up --build --wait-timeout 600".into(),
            "seed".into(),
            "apply --app happyview".into(),
            "check".into(),
            "up --build --wait-timeout 600".into(),
            "access hosts".into(),
            "access start".into(),
            "access stop".into(),
            "down".into(),
        ]
    );
    let calls = net.calls();
    // Its subnet was checked against Docker's before `create` asked for it.
    let checked = calls.find("docker network inspect").unwrap();
    assert!(checked < calls.find("deno task sandbox create").unwrap());
    // Adding HappyView's route restarts the services that read routes only
    // at start, once the network carrying the route is up.
    let restart = "docker restart hv-test-dns-1 hv-test-gateway-1 hv-test-pds1-1\n";
    let restarted = calls.find(restart).unwrap_or_else(|| panic!("{calls}"));
    assert!(restarted > calls.rfind("deno task sandbox up").unwrap());
    assert!(
        !calls.contains("deno install"),
        "an installed checkout was installed again"
    );
    let stack_file = read(&net.checkout.join("stacks/happyview.yaml"));
    assert!(stack_file.contains("did:plc:user1"), "{stack_file}");
    // The release for the fake Docker's architecture, which the cache files
    // beside the host's own release, under its target, unless it is the
    // host's.
    assert!(net.checkout.join("stacks/happyview/happyview").is_file());
    let docker_target = "aarch64-unknown-linux-musl";
    let releases = net.stack.cache.path().join(format!("happyview/{VERSION}"));
    let release = if target() == docker_target {
        releases
    } else {
        releases.join(docker_target)
    };
    assert!(release.join("happyview").is_file(), "{}", release.display());
    assert!(
        net.stack
            .project
            .path()
            .join(".happyview/local-network")
            .is_dir()
    );
    // The network directory names its project, so it can be found again
    // once the project has moved.
    assert_eq!(
        PathBuf::from(read(&net.checkout.parent().unwrap().join("project"))),
        std::fs::canonicalize(net.stack.project.path()).unwrap()
    );

    // A second run finds the sandbox seeded and only brings it up; its route
    // is unchanged, so nothing restarts and no subnet is checked.
    std::fs::write(&net.log, "").unwrap();
    net.hpy().assert().code(0);
    assert!(!net.calls().contains("docker restart"), "{}", net.calls());
    assert!(!net.calls().contains("docker network"), "{}", net.calls());
    assert_eq!(
        net.sandbox_calls(),
        [
            "check",
            "up --build --wait-timeout 600",
            "access hosts",
            "access start",
            "access stop",
            "down"
        ]
    );
}

#[cfg(unix)]
#[test]
fn under_json_stdout_holds_only_the_result() {
    let net = LocalNet::new();
    let out = net
        .hpy()
        .arg("--json")
        .assert()
        .code(0)
        .get_output()
        .clone();
    let stdout = String::from_utf8(out.stdout).unwrap();
    let documents: Vec<serde_json::Value> = serde_json::Deserializer::from_str(&stdout)
        .into_iter()
        .collect::<Result<_, _>>()
        .unwrap_or_else(|e| panic!("stdout is not JSON alone ({e}): {stdout}"));
    assert_eq!(documents.len(), 1, "{stdout}");
    let result = &documents[0];
    assert_eq!(result["url"], "https://happyview.atmosbox.internal");
    assert_eq!(result["handle"], "user1.pds1.atmosbox.test");
    assert!(!stdout.contains("seeded-secret-pw"));
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(stderr.contains("happyview log line"), "{stderr}");
    // The sandbox's own progress is there too, not on stdout.
    assert!(
        stderr.contains("sandbox progress: task sandbox up"),
        "{stderr}"
    );
}

#[cfg(unix)]
#[test]
fn a_second_network_is_refused_while_one_runs() {
    // A fake `docker` that reports another sandbox holding the access relay.
    let stack = Stack::new();
    let bin = tempfile::tempdir().unwrap();
    let write = |name: &str, body: &str| {
        use std::os::unix::fs::PermissionsExt;
        let p = bin.path().join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    write("deno", "echo 'deno 2.8.3 (stable, release)'");
    write(
        "docker",
        r#"case "$*" in
  "compose version"*) echo "Docker Compose version v2.40.0" ;;
  "ps --filter label=com.docker.compose.service=host-access"*) echo "hv-other-12345678" ;;
  *) exit 0 ;;
esac"#,
    );
    stack
        .hpy()
        .env("PATH", format!("{}:/usr/bin:/bin", bin.path().display()))
        .args(["hv", "dev", "--network", "local"])
        .assert()
        .code(2)
        .stderr(says("hv-other-12345678").and(says("127.0.0.1:443")));

    // Anything else on the relay's port is refused before the relay starts,
    // and the network that was brought up is stopped again.
    let net = LocalNet::new();
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = taken.local_addr().unwrap().to_string();
    net.hpy()
        .env("HPY_NETWORK_ACCESS_ADDR", &addr)
        .assert()
        .code(2)
        .stderr(says(format!("something else is listening on {addr}")));
    let calls = net.sandbox_calls();
    assert!(!calls.iter().any(|c| c == "access start"), "{calls:?}");
    assert_eq!(calls[calls.len() - 2..], ["access stop", "down"]);
}

#[cfg(unix)]
#[test]
fn a_failed_up_shows_happyviews_last_log_lines_and_stops_the_network() {
    let net = LocalNet::new();
    net.hpy()
        .env("NET_UP_FAILS", "1")
        .assert()
        .code(1)
        .stderr(says("could not open the database").and(says("deno task sandbox up")));
    assert!(
        net.calls()
            .contains("docker logs --tail 50 hv-test-happyview-1")
    );
    let calls = net.sandbox_calls();
    assert_eq!(calls[calls.len() - 2..], ["access stop", "down"]);
}

#[cfg(unix)]
#[test]
fn a_local_network_builds_modules_before_happyview_boots_and_rebuilds_them() {
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    let net = LocalNet::new();
    let (envs, dest) = declare_module(&net.stack);
    let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
    net.env(&mut cmd);
    let mut child = cmd
        .args(["hv", "dev", "--network", "local"])
        .envs(envs.iter().map(|(k, v)| (*k, v)))
        .env("NET_BLOCK", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let group = child.id() as libc::pid_t;
    let following = net.marker("following");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !following.exists() {
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            // SAFETY: kill(2) on the process group of a child this test spawned.
            unsafe { libc::kill(-group, libc::SIGKILL) };
            panic!("hpy never followed the logs: {}", net.calls());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(std::fs::read(&dest).unwrap(), b"\0asm-1");
    let calls = net.calls();
    let built = calls
        .find("cargo build")
        .unwrap_or_else(|| panic!("{calls}"));
    assert!(
        built < calls.find("deno task sandbox up").unwrap(),
        "{calls}"
    );

    edit_and_await_rebuild(&net.stack, &dest, b"\0asm-2");

    // SAFETY: as above.
    assert_eq!(unsafe { libc::kill(-group, libc::SIGINT) }, 0);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            // SAFETY: as above.
            unsafe { libc::kill(-group, libc::SIGKILL) };
            panic!("hpy did not exit after Ctrl-C: {}", net.calls());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(0), "{}", net.calls());
    let calls = net.sandbox_calls();
    assert_eq!(calls[calls.len() - 2..], ["access stop", "down"]);
}

#[cfg(unix)]
#[test]
fn ctrl_c_while_following_stops_the_network() {
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    let net = LocalNet::new();
    let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
    net.env(&mut cmd);
    let mut child = cmd
        .args(["hv", "dev", "--network", "local"])
        .env("NET_BLOCK", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Its own group, which a terminal's Ctrl-C signals as a whole.
        .process_group(0)
        .spawn()
        .unwrap();
    let following = net.marker("following");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !following.exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "hpy exited before following the logs: {}",
            net.calls()
        );
        assert!(Instant::now() < deadline, "hpy never followed the logs");
        std::thread::sleep(Duration::from_millis(20));
    }
    let group = child.id() as libc::pid_t;
    // SAFETY: kill(2) on the process group of a child this test spawned and has not reaped.
    assert_eq!(unsafe { libc::kill(-group, libc::SIGINT) }, 0);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            // SAFETY: as above.
            unsafe { libc::kill(-group, libc::SIGKILL) };
            panic!("hpy did not exit after Ctrl-C: {}", net.calls());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // `docker logs` never saw the signal and would have followed for two
    // minutes; `hpy` ended it.
    assert_eq!(status.code(), Some(0), "{}", net.calls());
    let calls = net.sandbox_calls();
    assert_eq!(calls[calls.len() - 2..], ["access stop", "down"]);
}

#[cfg(unix)]
#[test]
fn without_a_terminal_a_missing_hosts_entry_stops_before_the_relay() {
    let net = LocalNet::new();
    let line = "127.0.0.1 happyview.hpy-missing-host.atmosbox.test";
    net.hpy()
        .env("NET_HOSTS", line)
        .assert()
        .code(2)
        .stderr(says(line).and(says("/etc/hosts")));
    let calls = net.sandbox_calls();
    assert!(calls.iter().any(|c| c == "access hosts"), "{calls:?}");
    assert!(!calls.iter().any(|c| c == "access start"), "{calls:?}");
    assert_eq!(calls[calls.len() - 2..], ["access stop", "down"]);

    // A CA nobody has confirmed trusting is refused the same way; this case
    // leaves the machine's real /etc/hosts out of it.
    let net = LocalNet::new();
    std::fs::remove_file(net.checkout.parent().unwrap().join("access.toml")).unwrap();
    net.hpy().assert().code(2).stderr(
        says("cannot reach the local network yet")
            .and(says("state/ca/root.crt"))
            // How to ask again once that trust is gone.
            .and(says("access.toml"))
            .and(says("delete that file")),
    );
    let calls = net.sandbox_calls();
    assert!(!calls.iter().any(|c| c == "access start"), "{calls:?}");
    assert_eq!(calls[calls.len() - 2..], ["access stop", "down"]);
}

#[cfg(unix)]
#[test]
fn an_interrupted_first_create_is_resumed_not_created_again() {
    let net = LocalNet::new();
    std::fs::create_dir_all(net.checkout.join("state")).unwrap();
    std::fs::write(net.checkout.join("state/pending-create.json"), "{}").unwrap();
    assert!(!net.checkout.join("state/manifest.json").exists());
    net.hpy().assert().code(0);
    let calls = net.sandbox_calls();
    assert_eq!(calls[0], "resume", "{calls:?}");
    assert!(!calls.iter().any(|c| c.starts_with("create")), "{calls:?}");
}

#[cfg(unix)]
#[test]
fn reset_destroys_only_a_sandbox_that_exists_or_is_pending() {
    let destroyed = |net: &LocalNet| {
        net.sandbox_calls()
            .iter()
            .any(|c| c == "destroy --accept-destructive")
    };
    // Nothing there yet: nothing to destroy.
    let net = LocalNet::new();
    net.hpy().args(["--reset", "--yes"]).assert().code(0);
    assert!(!destroyed(&net), "{:?}", net.sandbox_calls());

    // Only pending state, with no manifest.
    let net = LocalNet::new();
    std::fs::create_dir_all(net.checkout.join("state")).unwrap();
    std::fs::write(net.checkout.join("state/pending-create.json"), "{}").unwrap();
    net.hpy().args(["--reset", "--yes"]).assert().code(0);
    // `resume` writes the manifest that `destroy` needs.
    assert_eq!(
        net.sandbox_calls()[..2],
        ["resume", "destroy --accept-destructive"]
    );

    // A created sandbox.
    std::fs::write(&net.log, "").unwrap();
    net.hpy().args(["--reset", "--yes"]).assert().code(0);
    assert_eq!(net.sandbox_calls()[0], "destroy --accept-destructive");

    // Created and pending: the sandbox refuses `destroy` until `resume`.
    std::fs::write(net.checkout.join("state/pending-apply.json"), "{}").unwrap();
    assert!(net.checkout.join("state/manifest.json").is_file());
    std::fs::write(&net.log, "").unwrap();
    net.hpy().args(["--reset", "--yes"]).assert().code(0);
    assert_eq!(
        net.sandbox_calls()[..2],
        ["resume", "destroy --accept-destructive"]
    );
}

#[cfg(unix)]
#[test]
fn a_checkout_installed_from_another_archive_is_installed_again_frozen() {
    let net = LocalNet::new();
    // What an earlier hpy wrote: a version, which a re-tagged archive keeps.
    let marker = net.checkout.join(".hpy-installed");
    std::fs::write(&marker, "v0.7.1").unwrap();
    net.hpy().assert().code(0);
    let calls = net.calls();
    let install = "deno install --frozen --entrypoint bin/sandbox.ts runtime/accounts.mjs\n";
    let installed = calls.find(install).unwrap_or_else(|| panic!("{calls}"));
    assert!(
        calls.contains("deno install saw DENO_NO_PACKAGE_JSON=1"),
        "{calls}"
    );
    assert!(
        installed < calls.find("deno task sandbox").unwrap(),
        "{calls}"
    );
    assert_eq!(
        read(&marker),
        "73bd22ac78ba137a2b5e9b8ffb88944232f1d25f0df42cdd5ab70e8d12bb526c"
    );
}

#[cfg(unix)]
#[test]
fn a_failure_that_leaves_a_step_pending_stops_nothing() {
    let net = LocalNet::new();
    net.hpy()
        .env("NET_SEED_FAILS", "1")
        .assert()
        .code(1)
        .stderr(says("until the next run resumes it"));
    // The sandbox would refuse both while the step is pending.
    assert_eq!(net.sandbox_calls().last().map(String::as_str), Some("seed"));
}

#[cfg(unix)]
#[test]
fn a_lock_found_at_start_is_refused_before_any_sandbox_command() {
    let net = LocalNet::new();
    let lock = net.checkout.join("state/cli.lock");
    std::fs::create_dir_all(&lock).unwrap();
    let out = net.hpy().assert().code(2).get_output().clone();
    // The report is wrapped to the terminal's width, path and all.
    let flat: String = String::from_utf8_lossy(&out.stderr)
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '│')
        .collect();
    assert!(flat.contains(&lock.display().to_string()), "{flat}");
    assert!(flat.contains("inspectthatlock,removeit"), "{flat}");
    assert!(net.sandbox_calls().is_empty(), "{}", net.calls());
    assert!(lock.is_dir(), "a lock hpy did not take was removed");
}

#[cfg(unix)]
#[test]
fn a_lock_another_command_holds_is_never_removed() {
    let net = LocalNet::new();
    net.hpy().env("NET_UP_CONTENDED", "1").assert().code(1);
    assert!(
        net.checkout.join("state/cli.lock").is_dir(),
        "the other command's lock was removed: {}",
        net.calls()
    );
    // Cleanup ran into that lock rather than taking it away.
    assert!(
        net.calls().contains("deno refused: locked"),
        "{}",
        net.calls()
    );
}

#[cfg(unix)]
#[test]
fn a_lock_our_crashed_command_left_is_removed_and_cleanup_runs() {
    let net = LocalNet::new();
    net.hpy().env("NET_UP_CRASHES", "1").assert().code(1);
    let calls = net.sandbox_calls();
    assert_eq!(calls[calls.len() - 2..], ["access stop", "down"]);
    assert!(
        !net.calls().contains("deno refused: locked"),
        "cleanup ran into the crashed command's lock: {}",
        net.calls()
    );
    assert!(!net.checkout.join("state/cli.lock").exists());
}

/// Runs `dev --network local` with `block` (`NET_SEED_BLOCK` or
/// `NET_UP_BLOCK`) set to `mode`, and sends Ctrl-C to its process group, as a
/// terminal does, once that step is under way. The step is let finish only
/// after `hpy` has had time to act on the signal. Answers the exit code and
/// what `hpy` wrote to stderr.
#[cfg(unix)]
fn interrupt_during(net: &LocalNet, block: &str, mode: &str) -> (Option<i32>, String) {
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    let stderr = net.marker("stderr");
    let mut cmd = std::process::Command::new(assert_cmd::cargo::cargo_bin("hpy"));
    net.env(&mut cmd);
    let mut child = cmd
        .args(["hv", "dev", "--network", "local"])
        .env(block, mode)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&stderr).unwrap())
        .process_group(0)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !net.marker("step-started").exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "hpy exited before the step: {}",
            net.calls()
        );
        assert!(Instant::now() < deadline, "hpy never reached the step");
        std::thread::sleep(Duration::from_millis(20));
    }
    let group = child.id() as libc::pid_t;
    // SAFETY: kill(2) on the process group of a child this test spawned and has not reaped.
    assert_eq!(unsafe { libc::kill(-group, libc::SIGINT) }, 0);
    // `hpy` waits for the step rather than ending it or itself. The step is
    // released before anything is asserted, so a failure leaves no fake
    // waiting behind it.
    std::thread::sleep(Duration::from_millis(500));
    let waited = child.try_wait().unwrap().is_none();
    let calls_while_waiting = net.calls();
    std::fs::write(net.marker("step-release"), "").unwrap();
    assert!(
        waited,
        "hpy did not wait for the step: {calls_while_waiting}"
    );
    assert!(
        !calls_while_waiting.contains("access stop"),
        "{calls_while_waiting}"
    );
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return (status.code(), read(&stderr));
        }
        if Instant::now() >= deadline {
            // SAFETY: as above.
            unsafe { libc::kill(-group, libc::SIGKILL) };
            panic!("hpy did not exit after Ctrl-C: {}", net.calls());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn ctrl_c_during_setup_lets_the_step_finish_then_stops_unless_a_step_is_pending() {
    let net = LocalNet::new();
    let (code, stderr) = interrupt_during(&net, "NET_SEED_BLOCK", "1");
    assert_eq!(code, Some(130), "{}", net.calls());
    assert!(
        stderr.contains("Ctrl-C: stopping once creating the sandbox's accounts has finished"),
        "{stderr}"
    );
    // The seed was not killed: it finished, and only then did `hpy` stop
    // the network, starting nothing new in between.
    let calls = net.calls();
    let finished = calls.find("deno seed finished").expect(&calls);
    assert!(finished < calls.find("deno task sandbox access stop").expect(&calls));
    let sandbox = net.sandbox_calls();
    assert_eq!(
        sandbox[sandbox.len() - 3..],
        ["seed", "access stop", "down"]
    );

    // A pending step leaves the sandbox for `resume`, which is all it accepts.
    let net = LocalNet::new();
    let (code, _) = interrupt_during(&net, "NET_SEED_BLOCK", "pending");
    assert_eq!(code, Some(130), "{}", net.calls());
    assert!(
        net.calls().contains("deno seed finished"),
        "{}",
        net.calls()
    );
    assert_eq!(net.sandbox_calls().last().map(String::as_str), Some("seed"));

    // The last step before the logs, on a second run where nothing follows
    // `up`: the run stops there and never reaches the access setup or the
    // logs.
    let net = LocalNet::new();
    net.hpy().assert().code(0);
    std::fs::write(&net.log, "").unwrap();
    let (code, stderr) = interrupt_during(&net, "NET_UP_BLOCK", "1");
    assert_eq!(code, Some(130), "{}\n{stderr}", net.calls());
    let sandbox = net.sandbox_calls();
    assert_eq!(
        sandbox[sandbox.len() - 3..],
        ["up --build --wait-timeout 600", "access stop", "down"]
    );
    assert!(!net.calls().contains("docker logs"), "{}", net.calls());
}

/// `args` under a pseudo-terminal from script(1).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn script_command(args: &[String]) -> std::process::Command {
    let mut cmd = std::process::Command::new("script");
    if cfg!(target_os = "macos") {
        cmd.args(["-q", "/dev/null"]).args(args);
    } else {
        let line = args
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', r"'\''")))
            .collect::<Vec<_>>()
            .join(" ");
        cmd.args(["-qec", &line, "/dev/null"]);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd
}

/// Why this host cannot give a child a pseudo-terminal, or `None` when it
/// can: script(1) is missing, or it ran without a terminal to hand over.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn no_pty_reason() -> Option<String> {
    const MARK: &str = "hpy-pty-ok";
    let probe = ["sh", "-c", "test -t 0 && test -t 2 && echo hpy-pty-ok"].map(String::from);
    match script_command(&probe).output() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Some("script(1) is not installed".into())
        }
        Err(e) => Some(format!("script(1) could not run: {e}")),
        Ok(out) if !String::from_utf8_lossy(&out.stdout).contains(MARK) => Some(format!(
            "script(1) could not open a pseudo-terminal: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Ok(_) => None,
    }
}

/// `dev --network local` under a pseudo-terminal, answering everything the
/// terminal showed; `None` when this host has no pseudo-terminal to give,
/// which `HPY_REQUIRE_PTY_TEST=1` (set in CI) turns into a failure so a
/// green run cannot hide a test that never ran.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_on_a_terminal(net: &LocalNet, extra: &[&str]) -> Option<String> {
    if let Some(why) = no_pty_reason() {
        assert!(
            std::env::var_os("HPY_REQUIRE_PTY_TEST").is_none_or(|v| v != "1"),
            "HPY_REQUIRE_PTY_TEST=1 but {why}"
        );
        eprintln!("skipped: {why}");
        return None;
    }
    let hpy = assert_cmd::cargo::cargo_bin("hpy");
    let mut args = vec![hpy.display().to_string()];
    args.extend(
        ["hv", "dev", "--network", "local"]
            .iter()
            .chain(extra)
            .map(|a| a.to_string()),
    );
    let mut cmd = script_command(&args);
    net.env(&mut cmd);
    let out = cmd.output().unwrap();
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn a_terminal_shows_the_password_but_never_under_json() {
    let net = LocalNet::new();
    // Without --json the terminal gets it, which shows the pty is real.
    let Some(shown) = run_on_a_terminal(&net, &[]) else {
        return;
    };
    assert!(shown.contains("seeded-secret-pw"), "{shown}");
    let Some(json) = run_on_a_terminal(&net, &["--json"]) else {
        return;
    };
    assert!(json.contains("\"url\""), "{json}");
    assert!(!json.contains("seeded-secret-pw"), "{json}");
}
