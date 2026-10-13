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

struct Stack {
    /// The runtime the mock server runs on. Only unix tests mount more mocks
    /// on it, so elsewhere it is held only to keep the server alive.
    _rt: tokio::runtime::Runtime,
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
        let asset = format!("happyview-{}.tar.xz", target());
        let archive = tar_xz(
            &format!("happyview-{}/happyview", target()),
            FAKE_HAPPYVIEW.as_bytes(),
        );
        let sum = data_encoding::HEXLOWER.encode(&Sha256::digest(&archive));
        rt.block_on(async {
            Mock::given(method("GET"))
                .and(path(format!("/dl/v{VERSION}/{asset}")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(archive))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(path(format!("/dl/v{VERSION}/{asset}.sha256")))
                .respond_with(
                    ResponseTemplate::new(200).set_body_string(format!("{sum}  {asset}\n")),
                )
                .mount(&server)
                .await;
        });
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("happyview.toml"),
            format!("[happyview]\nversion = \"{VERSION}\"\n"),
        )
        .unwrap();
        std::fs::write(
            project.path().join("happyview.lock"),
            format!("version = 1\n\n[happyview]\nversion = \"{VERSION}\"\n"),
        )
        .unwrap();
        let log = project.path().join("hv.log");
        Stack {
            _rt: rt,
            server,
            config: tempfile::tempdir().unwrap(),
            cache: tempfile::tempdir().unwrap(),
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

#[cfg(unix)]
#[test]
fn check_places_and_verifies_locked_plugins() {
    use serde_json::json;
    use wiremock::matchers::query_param;

    const DID: &str = "did:plc:hv";
    const SLUG: &str = "happyview-lua";
    const PLUGIN: &str = "1.0.0";
    let stack = Stack::new();
    let wasm = b"\0asm lua";
    let sum = hpy_plugin::checksum::checksum(wasm);
    let package = format!("at://{DID}/at.happyproto.plugin.profile/{SLUG}");
    let release = json!({
        "uri": format!("at://{DID}/at.happyproto.plugin.release/{SLUG}:{PLUGIN}"),
        "status": "active",
        "record": {
            "version": PLUGIN,
            "artifacts": { "package": { "checksum": sum } },
            "extensions": { "at.happyproto.plugin.releaseExtension": {
                "pluginType": "interpreter", "apiVersion": "2", "languageId": "lua",
                "fileExtensions": ["lua"], "capabilities": ["script:host"]
            } }
        }
    });
    let profile = json!({ "uri": package, "status": "active", "record": { "name": "Lua" } });
    stack._rt.block_on(async {
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getRelease"))
            .and(query_param("version", PLUGIN))
            .respond_with(ResponseTemplate::new(200).set_body_json(release))
            .mount(&stack.server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getPackage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(profile))
            .mount(&stack.server)
            .await;
        Mock::given(method("GET"))
            .and(path("/xrpc/at.happyproto.registry.getArtifact"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/wasm")
                    .set_body_bytes(wasm.to_vec()),
            )
            .mount(&stack.server)
            .await;
    });
    std::fs::write(
        stack.project.path().join("happyview.toml"),
        format!("[happyview]\nversion = \"{VERSION}\"\n[interpreters]\nlua = \"*\"\n"),
    )
    .unwrap();
    std::fs::write(
        stack.project.path().join("happyview.lock"),
        format!(
            "version = 1\n\n[happyview]\nversion = \"{VERSION}\"\n\n[[plugin]]\nid = \"{SLUG}\"\n\
             kind = \"interpreter\"\nkeys = [\"lua\"]\npackage = \"{package}\"\n\
             version = \"{PLUGIN}\"\nchecksum = \"{sum}\"\n"
        ),
    )
    .unwrap();
    stack.hpy().args(["hv", "check"]).assert().success();
    assert_eq!(stack.log().trim(), "check .");
    assert_eq!(
        std::fs::read(
            stack
                .cache
                .path()
                .join(format!("plugins/{SLUG}/{PLUGIN}/{SLUG}.wasm"))
        )
        .unwrap(),
        wasm
    );
    let placed = stack
        .project
        .path()
        .join(format!(".happyview/plugins/{SLUG}/manifest.json"));
    assert!(read(&placed).contains("\"language_id\": \"lua\""));
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
    let ready = stack.log.with_extension("log.ready");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !ready.exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "hpy exited before the binary was ready"
        );
        assert!(Instant::now() < deadline, "the binary never became ready");
        std::thread::sleep(Duration::from_millis(20));
    }
    let binary: libc::pid_t = loop {
        // The file can be seen before its line is written.
        if let Ok(pid) = read(&ready).trim().parse() {
            break pid;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
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
        .stderr(predicate::str::contains("hpy happyview create"));
}

#[test]
fn locked_refuses_a_lock_that_no_longer_matches() {
    let stack = Stack::new();
    std::fs::write(
        stack.project.path().join("happyview.toml"),
        format!("[happyview]\nversion = \"{VERSION}\"\n[interpreters]\nlua = \"*\"\n"),
    )
    .unwrap();
    stack
        .hpy()
        .args(["hv", "check", "--locked"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "interpreter `lua` is not in the lock",
        ));
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
    let ready = stack.log.with_extension("log.ready");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !ready.exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "hpy exited before the binary was ready"
        );
        assert!(Instant::now() < deadline, "the binary never became ready");
        std::thread::sleep(Duration::from_millis(20));
    }
    // The pid file can be seen before its line is written.
    while read(&ready).trim().is_empty() {
        std::thread::sleep(Duration::from_millis(20));
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

#[test]
fn add_validates_package_before_touching_the_network() {
    let stack = Stack::new();
    stack
        .hpy()
        .args(["hv", "add", "lua", "--package", "not-a-uri"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--package"));
    assert!(!read(&stack.project.path().join("happyview.toml")).contains("lua"));
}
