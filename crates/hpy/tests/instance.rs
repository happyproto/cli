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
