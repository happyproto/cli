//! `hpy happyview login/logout/whoami` and `deploy`, against a stand-in
//! for an instance's admin API.

use assert_cmd::Command;
use hpy_project::config::PluginKind;
use hpy_project::lock::{LockedHappyview, LockedPlugin, Lockfile};
use predicates::prelude::*;
use serde_json::{Value, json};
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const KEY: &str = "hv_0123456789abcdef0123456789abcdef";
const PUB: &str = "did:plc:publisher";

fn hpy(config: &std::path::Path) -> Command {
    let mut cmd = Command::cargo_bin("hpy").unwrap();
    cmd.env("XDG_CONFIG_HOME", config)
        .env("APPDATA", config)
        .env_remove("HPY_CREDENTIAL")
        .env_remove("HPY_HV_API_KEY")
        .env_remove("HPY_HV_URL")
        .env("HPY_CREDENTIAL_STORE", "file")
        .env("HPY_REGISTRY_URL", "http://127.0.0.1:9");
    cmd
}

async fn instance() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[])))
        .with_priority(10)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "Unauthorized"})))
        .with_priority(20)
        .mount(&server)
        .await;
    server
}

fn installed(id: &str, version: &str) -> Value {
    json!({
        "id": id, "name": id, "version": version, "source": "registry", "enabled": true,
        "plugin_type": "interpreter", "capabilities": {},
        "registry": {
            "did": PUB, "name": id, "channel": null, "unresolved": false,
            "version_uri": hpy_plugin::validate::version_uri(PUB, id, version)
        }
    })
}

fn plugins(list: &[Value]) -> Value {
    json!({ "plugins": list, "encryption_configured": true })
}

fn login(config: &std::path::Path, url: &str) {
    hpy(config)
        .args(["hv", "login", "--url", url, "--key-stdin"])
        .write_stdin(format!("{KEY}\n"))
        .assert()
        .success();
}

#[tokio::test]
async fn login_checks_the_key_and_whoami_shows_where_without_it() {
    let config = tempfile::tempdir().unwrap();
    let server = instance().await;
    hpy(config.path())
        .args(["hv", "login", "--url", &server.uri(), "--key-stdin"])
        .write_stdin(format!("{KEY}\n"))
        .assert()
        .success()
        .stdout(predicate::str::contains(server.uri()));
    let saved = std::fs::read_to_string(config.path().join("hpy/instances.json")).unwrap();
    assert!(saved.contains(&server.uri()), "{saved}");
    hpy(config.path())
        .args(["hv", "whoami", "--json"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains(server.uri())
                .and(predicate::str::contains("hv_01234"))
                .and(predicate::str::contains(KEY).not()),
        );
}

#[tokio::test]
async fn a_refused_key_is_not_saved() {
    let config = tempfile::tempdir().unwrap();
    let server = instance().await;
    hpy(config.path())
        .args(["hv", "login", "--url", &server.uri(), "--key-stdin"])
        .write_stdin("hv_ffffffffffffffffffffffffffffffff\n")
        .assert()
        .code(3)
        .stderr(predicate::str::contains("refused the API key"));
    assert!(!config.path().join("hpy/instances.json").exists());
}

#[test]
fn login_without_a_terminal_needs_a_handle_or_a_key() {
    let config = tempfile::tempdir().unwrap();
    hpy(config.path())
        .args(["hv", "login", "--url", "https://api.example.com"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("<IDENTIFIER>"));
    // An API key is never taken as an argument.
    hpy(config.path())
        .args([
            "hv",
            "login",
            "--url",
            "https://api.example.com",
            "--key",
            KEY,
        ])
        .assert()
        .code(2);
}

#[tokio::test]
async fn logout_forgets_the_instance() {
    let config = tempfile::tempdir().unwrap();
    let server = instance().await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .args(["hv", "logout"])
        .assert()
        .success()
        .stdout(predicate::str::contains(server.uri()));
    hpy(config.path())
        .args(["hv", "whoami"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("hpy hv login --url"));
}

/// A project whose lock holds `lua` 1.1.0 and `std` 2.0.0, which `lua`
/// depends on.
fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("happyview.toml"),
        format!(
            "[happyview]\nversion = \"3.0.0\"\n\n[interpreters]\nlua = {{ did = \"{PUB}\", name = \"lua\", version = \"1.1.0\" }}\n\n[libraries]\nstd = {{ did = \"{PUB}\", name = \"std\", version = \"2.0.0\" }}\n"
        ),
    )
    .unwrap();
    let plugin = |id: &str, kind: PluginKind, version: &str, deps: &[&str]| LockedPlugin {
        id: id.into(),
        kind,
        keys: vec![id.into()],
        project: hpy_plugin::validate::project_uri(PUB, id),
        version: version.into(),
        channel: None,
        version_uri: hpy_plugin::validate::version_uri(PUB, id, version),
        manifest_cid: "bafyreimanifest".into(),
        package_cid: "bafkreipackage".into(),
        manifest_blob_cid: "bafkreimanifestblob".into(),
        dependencies: deps.iter().map(|d| d.to_string()).collect(),
        capabilities: Some(vec!["kv:read".into()]),
    };
    Lockfile {
        version: 2,
        happyview: LockedHappyview {
            version: "3.0.0".into(),
        },
        plugins: vec![
            plugin("lua", PluginKind::Interpreter, "1.1.0", &["std"]),
            plugin("std", PluginKind::Library, "2.0.0", &[]),
        ],
    }
    .write(dir.path())
    .unwrap();
    dir
}

fn project_answer(dry_run: bool, lexicons_added: &[&str]) -> Value {
    json!({
        "sha256": "new", "dry_run": dry_run,
        "deployed_at": if dry_run { Value::Null } else { json!("2026-10-28T20:00:00Z") },
        "changes": {
            "lexicons": {"added": lexicons_added, "changed": [], "removed": []},
            "scripts": {"added": [], "changed": [], "removed": []}
        },
        "backfills": [],
        "warnings": []
    })
}

/// The project endpoints: nothing deployed yet, and a bundle that adds
/// `lexicons_added`.
async fn mount_project(server: &MockServer, lexicons_added: &[&str]) {
    Mock::given(method("GET"))
        .and(path("/admin/project"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "NoProject"})))
        .mount(server)
        .await;
    for dry_run in [true, false] {
        Mock::given(method("PUT"))
            .and(path("/admin/project"))
            .and(query_param("dry_run", dry_run.to_string()))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(project_answer(dry_run, lexicons_added)),
            )
            .mount(server)
            .await;
    }
}

async fn instance_with(list: &[Value]) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(list)))
        .mount(&server)
        .await;
    mount_project(&server, &["com.example.hello"]).await;
    server
}

/// The project requests the instance received, in order, as `PUT dry_run=…`.
async fn project_puts(server: &MockServer) -> Vec<String> {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "PUT")
        .map(|r| format!("PUT {}", r.url.query().unwrap_or("")))
        .collect()
}

#[tokio::test]
async fn a_dry_run_shows_the_plugin_changes_and_sends_none() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = instance_with(&[installed("lua", "1.0.0"), installed("old", "1.0.0")]).await;
    login(config.path(), &server.uri());
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--dry-run"])
        .assert()
        .success()
        .stderr(
            predicate::str::contains("install std 2.0.0")
                .and(predicate::str::contains("move lua 1.0.0 → 1.1.0"))
                .and(predicate::str::contains("old"))
                .and(predicate::str::contains("--prune-plugins"))
                .and(predicate::str::contains("+ lexicon com.example.hello")),
        );
    assert_eq!(project_puts(&server).await, ["PUT dry_run=true"]);
}

#[tokio::test]
async fn deploy_installs_dependencies_first_then_moves() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = instance_with(&[installed("lua", "1.0.0")]).await;
    login(config.path(), &server.uri());
    Mock::given(method("POST"))
        .and(path("/admin/plugins"))
        .and(body_json(json!({
            "registry": {"did": PUB, "name": "std", "version": "2.0.0"},
            "accepted_capabilities": ["kv:read"]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(installed("std", "2.0.0")))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/plugins/lua/reload"))
        .and(body_json(json!({
            "registry": {"version": "1.1.0"},
            "accepted_capabilities": ["kv:read"]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(installed("lua", "1.1.0")))
        .expect(1)
        .mount(&server)
        .await;
    let out = hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let out: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(out["instance"], json!(server.uri()));
    assert_eq!(
        out["plugins"]["applied"],
        json!(["install std 2.0.0", "move lua 1.0.0 → 1.1.0"])
    );
    let order: Vec<String> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() != "GET")
        .map(|r| format!("{} {}", r.method, r.url.path()))
        .collect();
    assert_eq!(
        order,
        [
            "PUT /admin/project",
            "POST /admin/plugins",
            "POST /admin/plugins/lua/reload",
            "PUT /admin/project"
        ]
    );
    assert_eq!(
        project_puts(&server).await,
        ["PUT dry_run=true", "PUT dry_run=false"]
    );
    assert_eq!(
        out["project"]["changes"]["lexicons"]["added"],
        json!(["com.example.hello"])
    );
}

#[tokio::test]
async fn deploy_stops_at_the_first_refusal_and_says_what_was_done() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = instance_with(&[]).await;
    login(config.path(), &server.uri());
    Mock::given(method("POST"))
        .and(path("/admin/plugins"))
        .and(body_json(json!({
            "registry": {"did": PUB, "name": "std", "version": "2.0.0"},
            "accepted_capabilities": ["kv:read"]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(installed("std", "2.0.0")))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/plugins"))
        .and(body_json(json!({
            "registry": {"did": PUB, "name": "lua", "version": "1.1.0"},
            "accepted_capabilities": ["kv:read"]
        })))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "NotInstallable", "message": "lua 1.1.0 reached end of life"
        })))
        .mount(&server)
        .await;
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes"])
        .assert()
        .code(1)
        .stderr(
            predicate::str::contains("end of life")
                .and(predicate::str::contains("install std 2.0.0")),
        );
}

#[tokio::test]
async fn deploy_needs_the_lock_to_match() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    std::fs::remove_file(project.path().join("happyview.lock")).unwrap();
    let server = instance_with(&[]).await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--dry-run"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("happyview.lock"));
}

/// A lock from an hpy that did not record capabilities is refused rather than
/// deployed with an invented set: HappyView reads an absent
/// `accepted_capabilities` as accepting nothing, and an empty one sent on the
/// operator's behalf would be a claim nobody made.
#[tokio::test]
async fn deploy_refuses_a_lock_that_records_no_capabilities() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let lock = project.path().join("happyview.lock");
    let stripped: String = std::fs::read_to_string(&lock)
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with("capabilities"))
        .map(|l| format!("{l}\n"))
        .collect();
    std::fs::write(&lock, stripped).unwrap();
    let server = instance_with(&[]).await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes"])
        .assert()
        .code(2)
        .stderr(
            predicate::str::contains("lua")
                .and(predicate::str::contains("std"))
                .and(predicate::str::contains("hpy happyview check")),
        );
}

#[tokio::test]
async fn ci_signs_in_from_the_environment() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[
            installed("lua", "1.1.0"),
            installed("std", "2.0.0"),
        ])))
        .mount(&server)
        .await;
    mount_project(&server, &[]).await;
    hpy(config.path())
        .current_dir(project.path())
        .env("HPY_HV_URL", server.uri())
        .env("HPY_HV_API_KEY", KEY)
        .args(["hv", "deploy", "--dry-run"])
        .assert()
        .success()
        .stderr(predicate::str::contains("up to date"));
}

#[tokio::test]
async fn deploy_sends_the_version_it_compared_against() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[
            installed("lua", "1.1.0"),
            installed("std", "2.0.0"),
        ])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/admin/project"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sha256": "deployed", "deployed_at": "2026-10-27T00:00:00Z", "deployed_by": "did:plc:me"
        })))
        .mount(&server)
        .await;
    for dry_run in [true, false] {
        Mock::given(method("PUT"))
            .and(path("/admin/project"))
            .and(query_param("dry_run", dry_run.to_string()))
            .and(header("if-match", "\"deployed\""))
            .and(header("content-type", "application/gzip"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(project_answer(dry_run, &["com.example.hello"])),
            )
            .expect(1)
            .mount(&server)
            .await;
    }
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Deployed"));
}

#[tokio::test]
async fn an_unchanged_project_is_up_to_date_and_not_sent_again() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = instance_with(&[installed("lua", "1.1.0"), installed("std", "2.0.0")]).await;
    // Replace the default project mocks' answer: nothing to change.
    server.reset().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[
            installed("lua", "1.1.0"),
            installed("std", "2.0.0"),
        ])))
        .mount(&server)
        .await;
    // The instance already serves this bundle (the stand-in answers its
    // sha256 as `new`).
    Mock::given(method("GET"))
        .and(path("/admin/project"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"sha256": "new"})))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/admin/project"))
        .and(query_param("dry_run", "true"))
        .respond_with(ResponseTemplate::new(200).set_body_json(project_answer(true, &[])))
        .mount(&server)
        .await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy"])
        .assert()
        .success()
        .stdout(predicate::str::contains("up to date"));
    assert_eq!(project_puts(&server).await, ["PUT dry_run=true"]);
}

#[tokio::test]
async fn an_invalid_project_changes_nothing() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[
            installed("lua", "1.1.0"),
            installed("std", "2.0.0"),
        ])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/admin/project"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "NoProject"})))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "error": "InvalidProject",
            "problems": [{"path": "src/lexicons/com/example/hello.json", "message": "id does not match the path"}]
        })))
        .mount(&server)
        .await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "src/lexicons/com/example/hello.json: id does not match the path",
        ));
    assert_eq!(project_puts(&server).await, ["PUT dry_run=true"]);
}

#[tokio::test]
async fn a_project_the_instance_could_not_boot_is_shown() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[
            installed("lua", "1.1.0"),
            installed("std", "2.0.0"),
        ])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/admin/project"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sha256": "deployed",
            "error": {"problems": [{"path": "src/x.ts", "message": "no interpreter claims .ts"}]}
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(project_answer(true, &[])))
        .mount(&server)
        .await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--dry-run"])
        .assert()
        .success()
        .stderr(
            predicate::str::contains("serving no project").and(predicate::str::contains(
                "src/x.ts: no interpreter claims .ts",
            )),
        );
}

#[tokio::test]
async fn a_project_check_that_needs_pending_plugins_waits_for_them() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(plugins(&[installed("std", "2.0.0")])),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/admin/project"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "NoProject"})))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(query_param("dry_run", "true"))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({
            "error": "InvalidProject",
            "problems": [{"path": "src/lexicons/com/example/hello.lua", "message": "no interpreter claims .lua"}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(query_param("dry_run", "false"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(project_answer(false, &["com.example.hello"])),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(installed("lua", "1.1.0")))
        .expect(1)
        .mount(&server)
        .await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes"])
        .assert()
        .success()
        .stderr(predicate::str::contains("after the plugins"));
}

#[tokio::test]
async fn a_first_deploy_with_nothing_to_show_is_still_sent() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[
            installed("lua", "1.1.0"),
            installed("std", "2.0.0"),
        ])))
        .mount(&server)
        .await;
    mount_project(&server, &[]).await;
    login(config.path(), &server.uri());
    hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Deployed"));
    assert_eq!(
        project_puts(&server).await,
        ["PUT dry_run=true", "PUT dry_run=false"]
    );
}

// `hpy hv env push`

/// Distinctive, so finding it anywhere in the output is a leak.
const SECRET: &str = "sk-live-7Q9zX-never-shown-41d8";

/// An instance that has `B` already, and accepts every set.
async fn variables_instance() -> MockServer {
    let server = MockServer::start().await;
    // What `hpy hv login --key-stdin` checks the key against.
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(&[])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/admin/script-variables"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"key": "B", "preview": "****", "unreadable": false,
             "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z"}
        ])))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/script-variables"))
        .respond_with(ResponseTemplate::new(204))
        .with_priority(10)
        .mount(&server)
        .await;
    server
}

/// A project whose `.env` holds `text`.
fn env_project(text: &str) -> tempfile::TempDir {
    let dir = project();
    std::fs::write(dir.path().join(".env"), text).unwrap();
    dir
}

fn env_text() -> String {
    format!("# keys for scripts\nA={SECRET}\nB=\"second {SECRET}\"\n")
}

/// The sets the instance received, as `(key, value)`.
async fn sets(server: &MockServer) -> Vec<(String, String)> {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .map(|r| {
            let body: Value = serde_json::from_slice(&r.body).unwrap();
            (
                body["key"].as_str().unwrap().to_string(),
                body["value"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// Runs `hpy hv env push` with `args`, and checks the value appears nowhere
/// in what it printed.
fn push(
    config: &std::path::Path,
    project: &std::path::Path,
    args: &[&str],
) -> assert_cmd::assert::Assert {
    let assert = hpy(config)
        .current_dir(project)
        .args(["hv", "env", "push"])
        .args(args)
        .assert();
    let out = assert.get_output();
    let shown = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!shown.contains(SECRET), "the value was printed:\n{shown}");
    assert
}

#[tokio::test]
async fn env_push_with_yes_sends_every_key() {
    let config = tempfile::tempdir().unwrap();
    let project = env_project(&env_text());
    let server = variables_instance().await;
    login(config.path(), &server.uri());
    push(config.path(), project.path(), &["--yes"])
        .success()
        .stderr(
            predicate::str::contains("sent A")
                .and(predicate::str::contains("sent B"))
                .and(predicate::str::contains(server.uri())),
        )
        .stdout(predicate::str::contains("Sent 2 keys"));
    assert_eq!(
        sets(&server).await,
        [
            ("A".to_string(), SECRET.to_string()),
            ("B".to_string(), format!("second {SECRET}")),
        ]
    );

    // And as JSON, still without a value.
    push(config.path(), project.path(), &["--yes", "--json"])
        .success()
        .stdout(
            predicate::str::contains(r#""sent": ["#)
                .and(predicate::str::contains(r#""dryRun": false"#)),
        );
}

#[tokio::test]
async fn env_push_without_a_terminal_or_yes_sends_nothing() {
    let config = tempfile::tempdir().unwrap();
    let project = env_project(&env_text());
    let server = variables_instance().await;
    login(config.path(), &server.uri());
    let before = server.received_requests().await.unwrap().len();
    push(config.path(), project.path(), &[]).code(2).stderr(
        predicate::str::contains("pass --yes").and(predicate::str::contains("Nothing was sent")),
    );
    assert_eq!(server.received_requests().await.unwrap().len(), before);
}

#[tokio::test]
async fn env_push_dry_run_labels_each_key_and_sends_nothing() {
    let config = tempfile::tempdir().unwrap();
    let project = env_project(&env_text());
    let server = variables_instance().await;
    login(config.path(), &server.uri());
    let assert = push(config.path(), project.path(), &["--dry-run"])
        .success()
        .stderr(
            predicate::str::contains("  new A\n")
                .and(predicate::str::contains("  replaces existing B\n")),
        )
        .stdout(predicate::str::contains("nothing was sent"));
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr).into_owned();
    assert_eq!(stderr.matches("masked").count(), 1, "{stderr}");
    push(config.path(), project.path(), &["--dry-run", "--json"])
        .success()
        .stdout(
            predicate::str::contains(r#""status": "new""#)
                .and(predicate::str::contains(r#""status": "replace""#)),
        );
    assert!(sets(&server).await.is_empty());
}

#[tokio::test]
async fn env_push_sends_only_the_keys_named() {
    let config = tempfile::tempdir().unwrap();
    let project = env_project(&env_text());
    let server = variables_instance().await;
    login(config.path(), &server.uri());
    push(config.path(), project.path(), &["B", "--yes"])
        .success()
        .stderr(predicate::str::contains("sent B").and(predicate::str::contains("sent A").not()));
    assert_eq!(
        sets(&server).await,
        [("B".to_string(), format!("second {SECRET}"))]
    );

    // A key the file doesn't set is refused, and nothing is sent.
    push(config.path(), project.path(), &["A", "MISSING", "--yes"])
        .code(2)
        .stderr(predicate::str::contains("doesn't set MISSING"));
    assert_eq!(sets(&server).await.len(), 1);
}

#[tokio::test]
async fn env_push_refuses_a_bad_key_by_its_line() {
    let config = tempfile::tempdir().unwrap();
    let project = env_project(&format!("A=1\nMY-TOKEN={SECRET}\n{SECRET}\n"));
    let server = variables_instance().await;
    login(config.path(), &server.uri());
    let before = server.received_requests().await.unwrap().len();
    let stderr = push(config.path(), project.path(), &["--yes"])
        .code(2)
        .get_output()
        .stderr
        .clone();
    // The report wraps at the terminal width, and a long temp path (as on
    // Windows) moves the breaks: compare the words, not the layout.
    let words = String::from_utf8_lossy(&stderr)
        .replace(['│', '×', '├', '└', '─', '╭', '╰'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for wanted in [
        ".env:2: a key starts with a letter or _",
        ".env:3: expected KEY=VALUE",
        "nothing was sent",
    ] {
        assert!(words.contains(wanted), "{wanted:?} not in {words:?}");
    }
    assert_eq!(server.received_requests().await.unwrap().len(), before);
}

#[tokio::test]
async fn env_push_reports_a_failed_key_and_exits_non_zero() {
    let config = tempfile::tempdir().unwrap();
    let project = env_project(&env_text());
    let server = variables_instance().await;
    Mock::given(method("POST"))
        .and(path("/admin/script-variables"))
        .and(wiremock::matchers::body_partial_json(json!({"key": "A"})))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({
            "error": "InternalError", "message": format!("failed to upsert script variable: {SECRET}")
        })))
        .with_priority(1)
        .mount(&server)
        .await;
    login(config.path(), &server.uri());
    push(config.path(), project.path(), &["--yes"])
        .code(1)
        .stderr(
            predicate::str::contains("failed A: ")
                .and(predicate::str::contains("failed to upsert script variable"))
                .and(predicate::str::contains("sent B"))
                .and(predicate::str::contains("1 key not sent: A")),
        )
        .stdout(predicate::str::contains("skipped 0, failed 1"));
    push(config.path(), project.path(), &["--yes", "--json"])
        .code(1)
        .stdout(predicate::str::contains(r#""failed": ["#));
}

#[tokio::test]
async fn env_push_signed_out_is_refused_as_deploy_is() {
    let config = tempfile::tempdir().unwrap();
    let project = env_project(&env_text());
    let deploy = hpy(config.path())
        .current_dir(project.path())
        .args(["hv", "deploy", "--yes"])
        .assert()
        .code(3);
    let pushed = push(config.path(), project.path(), &["--yes"]).code(3);
    let said = |a: &assert_cmd::assert::Assert| {
        String::from_utf8_lossy(&a.get_output().stderr).into_owned()
    };
    assert_eq!(said(&pushed), said(&deploy));
    assert!(said(&pushed).contains("hpy hv login"), "{}", said(&pushed));
}
