//! `hpy happyview login/logout/whoami` and `deploy`, against a stand-in
//! for an instance's admin API.

use assert_cmd::Command;
use hpy_project::config::PluginKind;
use hpy_project::lock::{LockedHappyview, LockedPlugin, Lockfile};
use predicates::prelude::*;
use serde_json::{Value, json};
use wiremock::matchers::{body_json, header, method, path};
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
fn login_never_takes_the_key_as_an_argument() {
    let config = tempfile::tempdir().unwrap();
    hpy(config.path())
        .args(["hv", "login", "--url", "https://api.example.com"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--key-stdin"));
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

async fn instance_with(list: &[Value]) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/admin/plugins"))
        .respond_with(ResponseTemplate::new(200).set_body_json(plugins(list)))
        .mount(&server)
        .await;
    server
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
                .and(predicate::str::contains("--prune-plugins")),
        );
}

#[tokio::test]
async fn deploy_installs_dependencies_first_then_moves() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = instance_with(&[installed("lua", "1.0.0")]).await;
    login(config.path(), &server.uri());
    Mock::given(method("POST"))
        .and(path("/admin/plugins"))
        .and(body_json(
            json!({"registry": {"did": PUB, "name": "std", "version": "2.0.0"}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(installed("std", "2.0.0")))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/plugins/lua/reload"))
        .and(body_json(json!({"registry": {"version": "1.1.0"}})))
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
        .filter(|r| r.method.as_str() == "POST")
        .map(|r| r.url.path().to_string())
        .collect();
    assert_eq!(order, ["/admin/plugins", "/admin/plugins/lua/reload"]);
}

#[tokio::test]
async fn deploy_stops_at_the_first_refusal_and_says_what_was_done() {
    let config = tempfile::tempdir().unwrap();
    let project = project();
    let server = instance_with(&[]).await;
    login(config.path(), &server.uri());
    Mock::given(method("POST"))
        .and(path("/admin/plugins"))
        .and(body_json(
            json!({"registry": {"did": PUB, "name": "std", "version": "2.0.0"}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(installed("std", "2.0.0")))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/admin/plugins"))
        .and(body_json(
            json!({"registry": {"did": PUB, "name": "lua", "version": "1.1.0"}}),
        ))
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
    hpy(config.path())
        .current_dir(project.path())
        .env("HPY_HV_URL", server.uri())
        .env("HPY_HV_API_KEY", KEY)
        .args(["hv", "deploy", "--dry-run"])
        .assert()
        .success()
        .stderr(predicate::str::contains("up to date"));
}
