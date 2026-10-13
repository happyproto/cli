//! HappyView as an Atmosphere in a Box managed application: a container on
//! the sandbox network running the Linux release binary over the
//! bind-mounted project, behind a sandbox HTTPS route.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::failure::Failure;

pub const APP_ID: &str = "happyview";
/// The sandbox route HappyView's `PUBLIC_URL` is read from.
pub const ROUTE_ID: &str = "happyview";
/// A full name rather than a label under the sandbox's `.test` domain: the
/// sandbox PDS refuses an OAuth `client_id` on the `.test` TLD.
pub const ROUTE_HOSTNAME: &str = "happyview.atmosbox.internal";
pub const PUBLIC_URL: &str = "https://happyview.atmosbox.internal";
pub const SUPERADMIN_ENV: &str = "SUPERADMIN_DID";
pub const BACKFILL_ENV: &str = "HAPPYVIEW_DEV_BACKFILL";
/// Tells HappyView it is the sandboxed instance, not one on the real network.
pub const NETWORK_ENV: &str = "HAPPYVIEW_NETWORK";
/// Polling interval for HappyView's project watcher, in milliseconds.
pub const WATCH_POLL_ENV: &str = "HAPPYVIEW_WATCH_POLL_MS";
/// Whether the sandbox relay can drive backfill's discovery
/// (`listReposByCollection`).
pub const BACKFILL_ON_LOCAL: bool = false;
/// Polling instead of file events. Docker Desktop's VirtioFS share delivers
/// no CLOSE_WRITE, MOVED_TO or delete events for the bind-mounted project, so
/// an editor's save never reaches an event watcher. `None` would leave the
/// watcher on events.
pub const WATCH_POLL_MS: Option<u32> = Some(500);
/// The local network's database and plugin cache, kept apart from the one
/// `dev` uses against the real network so their records never mix.
pub const LOCAL_DB_DIR: &str = ".happyview/local-network";

const STACK_FILE: &str = "stacks/happyview.yaml";
const DEFINITION_FILE: &str = "stacks/happyview.definition.json";
const BUILD_DIR: &str = "stacks/happyview";
const BINARY_NAME: &str = "happyview";

pub struct AppConfig {
    pub project_root: PathBuf,
    /// The Linux release binary; copied into the build context, never mounted.
    pub binary: PathBuf,
    pub uid: u32,
    pub gid: u32,
    pub superadmin: Option<String>,
    /// `[dev] backfill` from the project.
    pub backfill: bool,
}

pub fn stack_json(c: &AppConfig) -> Value {
    let mut env = json!({
        "HOST": "0.0.0.0",
        "PORT": "3000",
        // Service names over plain transport: the network is internal, and
        // HappyView's WebSocket client trusts only a compiled-in root list.
        "JETSTREAM_URL": "ws://full-stack-jetstream:8080",
        "RELAY_URL": "http://full-stack-relay:2470",
        "DATABASE_URL": format!("sqlite:///project/{LOCAL_DB_DIR}/happyview.db?mode=rwc"),
        "HV_UID": c.uid.to_string(),
        "HV_GID": c.gid.to_string(),
        BACKFILL_ENV: (c.backfill && BACKFILL_ON_LOCAL).to_string(),
        NETWORK_ENV: "local",
    });
    if let Some(did) = &c.superadmin {
        env[SUPERADMIN_ENV] = did.clone().into();
    }
    if let Some(ms) = WATCH_POLL_MS {
        env[WATCH_POLL_ENV] = ms.to_string().into();
    }
    json!({
        "services": {
            APP_ID: {
                "build": { "context": format!("./{BUILD_DIR}") },
                "working_dir": "/project",
                "command": ["dev", "."],
                "environment": env,
                "volumes": [{
                    "type": "bind",
                    "source": c.project_root.display().to_string(),
                    "target": "/project",
                }],
                "restart": "no",
            }
        }
    })
}

pub fn definition_json() -> Value {
    json!({
        "version": 1,
        "id": APP_ID,
        "services": [{
            "service": APP_ID,
            "environment": [
                { "name": "PUBLIC_URL", "source": { "kind": "route-url", "route": ROUTE_ID } },
                { "name": "PLC_URL", "source": { "kind": "plc-url" } }
            ]
        }],
        // Atmosphere in a Box takes exactly one of `host` (a label under its
        // domain) and `hostname` (a full name).
        "routes": [{ "id": ROUTE_ID, "service": APP_ID, "hostname": ROUTE_HOSTNAME, "port": 3000 }],
        "secrets": []
    })
}

/// `components.json` with HappyView registered, or `None` when it already is.
pub fn register_component(components: &str) -> Result<Option<String>, Failure> {
    let mut list: Vec<Value> = serde_json::from_str(components)
        .map_err(|e| Failure::runtime(format!("stacks/components.json is not readable: {e}")))?;
    if list.iter().any(|c| c["id"] == APP_ID) {
        return Ok(None);
    }
    list.push(json!({
        "id": APP_ID,
        "file": STACK_FILE,
        "application": APP_ID,
        "definition": DEFINITION_FILE,
    }));
    Ok(Some(
        serde_json::to_string_pretty(&list).expect("json serializes") + "\n",
    ))
}

fn write_if_changed(path: &Path, body: &str) -> Result<bool, Failure> {
    if std::fs::read_to_string(path).is_ok_and(|old| old == body) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(Failure::runtime)?;
    }
    std::fs::write(path, body).map_err(Failure::runtime)?;
    Ok(true)
}

fn sha256_of(path: &Path) -> Option<[u8; 32]> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hasher.finalize().into())
}

/// Copies the binary into the build context unless the copy already there has
/// the same size and hash. The executable bit comes from the Dockerfile.
fn copy_binary(from: &Path, to: &Path) -> Result<bool, Failure> {
    let wanted = std::fs::metadata(from)
        .map_err(|e| Failure::runtime(format!("cannot read {}: {e}", from.display())))?;
    if std::fs::metadata(to).is_ok_and(|have| have.len() == wanted.len())
        && sha256_of(to).is_some_and(|have| Some(have) == sha256_of(from))
    {
        return Ok(false);
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(Failure::runtime)?;
    }
    std::fs::copy(from, to).map_err(Failure::runtime)?;
    Ok(true)
}

/// What `write_app` changed on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Written {
    pub any: bool,
    /// The application definition, which carries HappyView's route.
    pub definition: bool,
}

pub fn write_app(checkout: &Path, c: &AppConfig) -> Result<Written, Failure> {
    let build = checkout.join(BUILD_DIR);
    let mut changed = false;
    changed |= write_if_changed(
        &build.join("Dockerfile"),
        include_str!("../../../templates/network/Dockerfile"),
    )?;
    changed |= write_if_changed(
        &build.join("entrypoint.sh"),
        include_str!("../../../templates/network/entrypoint.sh"),
    )?;
    changed |= copy_binary(&c.binary, &build.join(BINARY_NAME))?;
    // YAML is a superset of JSON, so the stack is written as JSON and every
    // value is quoted correctly without a YAML writer.
    let stack = serde_json::to_string_pretty(&stack_json(c)).expect("json serializes") + "\n";
    changed |= write_if_changed(&checkout.join(STACK_FILE), &stack)?;
    let definition =
        serde_json::to_string_pretty(&definition_json()).expect("json serializes") + "\n";
    let definition = write_if_changed(&checkout.join(DEFINITION_FILE), &definition)?;
    changed |= definition;
    let components = checkout.join("stacks/components.json");
    let text = std::fs::read_to_string(&components).map_err(Failure::runtime)?;
    if let Some(updated) = register_component(&text)? {
        std::fs::write(&components, updated).map_err(Failure::runtime)?;
        changed = true;
    }
    Ok(Written {
        any: changed,
        definition,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(superadmin: Option<&str>) -> AppConfig {
        AppConfig {
            project_root: "/work/my-app".into(),
            binary: "/cache/happyview/3.0.0/x86_64-unknown-linux-musl/happyview".into(),
            uid: 501,
            gid: 20,
            superadmin: superadmin.map(str::to_string),
            backfill: true,
        }
    }

    fn checkout_with(binary: &[u8]) -> (tempfile::TempDir, AppConfig) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("stacks")).unwrap();
        std::fs::write(dir.path().join("stacks/components.json"), "[]").unwrap();
        let bin = dir.path().join("hv-binary");
        std::fs::write(&bin, binary).unwrap();
        let mut c = config(None);
        c.binary = bin;
        (dir, c)
    }

    #[test]
    fn the_stack_mounts_the_project_and_points_at_sandbox_services() {
        let s = stack_json(&config(Some("did:plc:user1")));
        let svc = &s["services"][APP_ID];
        assert_eq!(svc["command"], json!(["dev", "."]));
        assert_eq!(svc["working_dir"], "/project");
        assert_eq!(
            svc["volumes"],
            json!([{ "type": "bind", "source": "/work/my-app", "target": "/project" }])
        );
        let env = &svc["environment"];
        assert_eq!(env["JETSTREAM_URL"], "ws://full-stack-jetstream:8080");
        assert_eq!(env["RELAY_URL"], "http://full-stack-relay:2470");
        assert_eq!(env[SUPERADMIN_ENV], "did:plc:user1");
        assert_eq!(env[NETWORK_ENV], "local");
        assert_eq!(env["HV_UID"], "501");
        assert!(
            svc.get("ports").is_none(),
            "a managed app must not publish ports"
        );
    }

    #[test]
    fn the_local_database_is_separate() {
        let env = &stack_json(&config(None))["services"][APP_ID]["environment"];
        assert_eq!(
            env["DATABASE_URL"],
            format!("sqlite:///project/{LOCAL_DB_DIR}/happyview.db?mode=rwc")
        );
        assert_ne!(LOCAL_DB_DIR, ".happyview");
        assert!(env.get(SUPERADMIN_ENV).is_none());
        assert_eq!(env.get(WATCH_POLL_ENV).is_some(), WATCH_POLL_MS.is_some());
        assert_eq!(env[WATCH_POLL_ENV], "500");
    }

    #[test]
    fn backfill_follows_the_recorded_decision() {
        let env = &stack_json(&config(None))["services"][APP_ID]["environment"];
        let want = if BACKFILL_ON_LOCAL { "true" } else { "false" };
        assert_eq!(env[BACKFILL_ENV], want);
    }

    #[test]
    fn the_definition_routes_happyview_and_supplies_its_urls() {
        let d = definition_json();
        assert_eq!(d["id"], APP_ID);
        assert_eq!(
            d["routes"][0],
            json!({
                "id": "happyview",
                "service": APP_ID,
                "hostname": "happyview.atmosbox.internal",
                "port": 3000
            })
        );
        assert!(d["routes"][0].get("host").is_none());
        assert_eq!(PUBLIC_URL, format!("https://{ROUTE_HOSTNAME}"));
        let env = d["services"][0]["environment"].as_array().unwrap();
        assert!(env.iter().any(|e| e["name"] == "PUBLIC_URL"
            && e["source"]["kind"] == "route-url"
            && e["source"]["route"] == ROUTE_ID));
        assert!(
            env.iter()
                .any(|e| e["name"] == "PLC_URL" && e["source"]["kind"] == "plc-url")
        );
    }

    #[test]
    fn registering_is_idempotent_and_keeps_the_rest() {
        let base = r#"[{ "id": "networking", "file": "compose/networking.yaml" }]"#;
        let once = register_component(base).unwrap().unwrap();
        let parsed: Value = serde_json::from_str(&once).unwrap();
        assert_eq!(parsed[0]["id"], "networking");
        assert_eq!(parsed[1]["definition"], "stacks/happyview.definition.json");
        assert!(register_component(&once).unwrap().is_none());
    }

    #[test]
    fn write_app_reports_changes_only_when_something_changed() {
        let (checkout, mut c) = checkout_with(b"binary");
        assert_eq!(
            write_app(checkout.path(), &c).unwrap(),
            Written {
                any: true,
                definition: true
            }
        );
        assert_eq!(write_app(checkout.path(), &c).unwrap(), Written::default());
        c.superadmin = Some("did:plc:user1".into());
        // The stack changed; the route did not.
        assert_eq!(
            write_app(checkout.path(), &c).unwrap(),
            Written {
                any: true,
                definition: false
            }
        );
        std::fs::write(checkout.path().join(DEFINITION_FILE), "{}").unwrap();
        assert!(write_app(checkout.path(), &c).unwrap().definition);
        assert!(
            checkout
                .path()
                .join("stacks/happyview/Dockerfile")
                .is_file()
        );
        assert!(
            checkout
                .path()
                .join("stacks/happyview/entrypoint.sh")
                .is_file()
        );
    }

    #[test]
    fn a_new_binary_changes_the_build_context_not_the_volumes() {
        let (checkout, c) = checkout_with(b"one");
        write_app(checkout.path(), &c).unwrap();
        let stack_path = checkout.path().join(STACK_FILE);
        let before = std::fs::read_to_string(&stack_path).unwrap();
        let copied = checkout.path().join("stacks/happyview/happyview");
        assert_eq!(std::fs::read(&copied).unwrap(), b"one");

        // Same size, different content: the hash must catch it.
        std::fs::write(&c.binary, b"two").unwrap();
        assert!(write_app(checkout.path(), &c).unwrap().any);
        assert_eq!(std::fs::read(&copied).unwrap(), b"two");
        assert_eq!(std::fs::read_to_string(&stack_path).unwrap(), before);
        assert!(!write_app(checkout.path(), &c).unwrap().any);
    }
}
