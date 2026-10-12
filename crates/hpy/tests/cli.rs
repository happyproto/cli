use assert_cmd::Command;
use predicates::prelude::*;

fn hpy(config: &std::path::Path) -> Command {
    let mut cmd = Command::cargo_bin("hpy").unwrap();
    cmd.env("XDG_CONFIG_HOME", config)
        .env("APPDATA", config)
        .env_remove("HPY_CREDENTIAL")
        .env("HPY_CREDENTIAL_STORE", "file")
        .env("HPY_REGISTRY_URL", "http://127.0.0.1:9");
    cmd
}

#[test]
fn help_lists_groups() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("registry"));
    hpy(dir.path())
        .args(["registry", "--help"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("login")
                .and(predicate::str::contains("whoami"))
                .and(predicate::str::contains("plugin")),
        );
    hpy(dir.path())
        .args(["registry", "plugin", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("publish").and(predicate::str::contains("init")));
}

#[test]
fn whoami_when_logged_out_exits_3() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .args(["registry", "whoami"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("hpy registry login"));
}

fn exported_credential(did: &str) -> String {
    hpy_atproto::credential::export(&hpy_atproto::credential::Credential {
        registry: "https://api.happyproto.at".into(),
        client_key: "hvc_test".into(),
        did: did.into(),
        handle: Some("alice.test".into()),
        pds: "https://pds.test".into(),
        scopes: "atproto".into(),
        access_token: "tok".into(),
        dpop_key: hpy_atproto::dpop::DpopKey::generate(),
    })
}

#[test]
fn whoami_reads_an_exported_credential() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .env("HPY_CREDENTIAL", exported_credential("did:plc:ci"))
        .args(["registry", "whoami", "--json"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("\"did\": \"did:plc:ci\"")
                .and(predicate::str::contains("environment")),
        );
}

#[test]
fn whoami_reads_the_file_without_the_keychain() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("hpy")).unwrap();
    std::fs::write(
        dir.path().join("hpy/credentials.json"),
        r#"{"v":1,"registry":"https://api.happyproto.at","client_key":"hvc_test","did":"did:plc:abc","handle":"alice.test","pds":"https://pds.test","scopes":"atproto","access_token":"t","dpop_key":{"keychain":true}}"#,
    )
    .unwrap();
    hpy(dir.path())
        .args(["registry", "whoami"])
        .assert()
        .success()
        .stdout(predicate::str::contains("@alice.test"));
}

#[test]
fn corrupt_credentials_mean_log_in_again_and_logout_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("hpy")).unwrap();
    std::fs::write(dir.path().join("hpy/credentials.json"), "{garbage").unwrap();
    hpy(dir.path())
        .args(["registry", "whoami"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("hpy registry login"));
    hpy(dir.path())
        .args(["registry", "logout"])
        .assert()
        .success();
    assert!(!dir.path().join("hpy/credentials.json").exists());
}

#[test]
fn login_offers_export_and_no_app_passwords() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .args(["registry", "login", "--help"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains("--export")
                .and(predicate::str::contains("app-password").not()),
        );
}

#[test]
fn login_without_tty_needs_identifier() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .args(["registry", "login", "--no-input"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("<IDENTIFIER>"));
}

#[test]
fn logout_when_logged_out_is_fine() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .args(["registry", "logout"])
        .assert()
        .success();
}

#[test]
fn profile_init_without_tty_names_missing_flag() {
    let config = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    std::fs::write(
        plugin.path().join("manifest.json"),
        r#"{"id":"my-plugin","name":"Mine"}"#,
    )
    .unwrap();
    hpy(config.path())
        .args([
            "registry",
            "plugin",
            "init",
            "--no-input",
            "--local-only",
            "-C",
        ])
        .arg(plugin.path())
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--license"));
}

#[test]
fn profile_init_local_only_from_flags_writes_hpy_toml() {
    let config = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    std::fs::write(
        plugin.path().join("manifest.json"),
        r#"{"id":"my-plugin","name":"Mine"}"#,
    )
    .unwrap();
    hpy(config.path())
        .args([
            "registry",
            "plugin",
            "init",
            "--no-input",
            "--local-only",
            "--license",
            "MIT",
            "--author",
            "Ada <ada@x.io>",
            "--security",
            "sec@x.io",
            "-C",
        ])
        .arg(plugin.path())
        .assert()
        .success();
    let text = std::fs::read_to_string(plugin.path().join("hpy.toml")).unwrap();
    assert!(
        text.contains("license = \"MIT\"") && text.contains("Ada"),
        "{text}"
    );
}

#[test]
fn publish_validation_errors_exit_2_before_login() {
    let config = tempfile::tempdir().unwrap();
    let plugin = tempfile::tempdir().unwrap();
    std::fs::write(plugin.path().join("manifest.json"), r#"{"id":"p","version":"1.0.0+meta","api_version":"2","plugin_type":"library","namespace":"p","capabilities":[]}"#).unwrap();
    std::fs::write(plugin.path().join("p.wasm"), b"\0asm\x01\0\0\0").unwrap();
    hpy(config.path())
        .args(["registry", "plugin", "publish", "--no-input", "--wasm"])
        .arg(plugin.path().join("p.wasm"))
        .arg("-C")
        .arg(plugin.path())
        .assert()
        .code(2)
        .stderr(predicate::str::contains("build metadata"));
}

#[test]
fn logging_out_an_already_revoked_ci_credential_is_fine() {
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let rt = tokio::runtime::Runtime::new().unwrap();
    let server = rt.block_on(async {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(serde_json::json!({ "error": "session not found" })),
            )
            .mount(&server)
            .await;
        server
    });
    let credential = hpy_atproto::credential::export(&hpy_atproto::credential::Credential {
        registry: server.uri(),
        client_key: "hvc_test".into(),
        did: "did:plc:ci".into(),
        handle: None,
        pds: "https://pds.test".into(),
        scopes: "atproto".into(),
        access_token: "tok".into(),
        dpop_key: hpy_atproto::dpop::DpopKey::generate(),
    });
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .env("HPY_CREDENTIAL", credential)
        .args(["registry", "logout"])
        .assert()
        .success()
        .stdout(predicate::str::contains("already"));
    drop(rt);
}

#[test]
fn registry_commands_are_not_top_level() {
    let dir = tempfile::tempdir().unwrap();
    for cmd in ["login", "logout", "whoami", "plugin"] {
        hpy(dir.path()).arg(cmd).assert().code(2);
    }
}

#[test]
fn listing_commands_sit_directly_under_plugin() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .args(["registry", "plugin", "profile", "--help"])
        .assert()
        .code(2);
    for cmd in ["init", "show", "edit", "pull"] {
        hpy(dir.path())
            .args(["registry", "plugin", cmd, "--help"])
            .assert()
            .success();
    }
}

#[test]
fn channel_defaults_to_the_installed_versions() {
    let dir = tempfile::tempdir().unwrap();
    let expected = match env!("CARGO_PKG_VERSION").split_once('-') {
        Some((_, pre)) => pre.split('.').next().unwrap().to_string(),
        None => "stable".into(),
    };
    hpy(dir.path())
        .args(["--json", "channel"])
        .assert()
        .success()
        .stdout(
            predicate::str::contains(format!("\"channel\": \"{expected}\""))
                .and(predicate::str::contains("\"chosen\": false")),
        );
}

#[test]
fn choosing_the_channel_already_followed_records_it_without_the_network() {
    let dir = tempfile::tempdir().unwrap();
    let current = hpy(dir.path())
        .args(["--json", "channel"])
        .output()
        .unwrap();
    let current: serde_json::Value = serde_json::from_slice(&current.stdout).unwrap();
    let current = current["channel"].as_str().unwrap().to_string();
    hpy(dir.path())
        .args(["channel", &current])
        .assert()
        .success()
        .stdout(predicate::str::contains("Already on"));
    hpy(dir.path())
        .args(["--json", "channel"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"chosen\": true"));
}

#[test]
fn an_unknown_channel_is_a_usage_error() {
    let dir = tempfile::tempdir().unwrap();
    hpy(dir.path())
        .args(["channel", "nightly"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("stable, beta or alpha"));
}
