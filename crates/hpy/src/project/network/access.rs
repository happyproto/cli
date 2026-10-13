//! Reaching the sandbox from this computer's browser, which OAuth needs. The
//! steps stay the developer's: `hpy` prints them, checks what it can, and
//! never edits the hosts file or a trust store.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::network::sandbox::Sandbox;

const RECORD: &str = "access.toml";

pub fn parse_hosts_block(out: &str) -> Vec<(String, String)> {
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .collect()
}

pub fn missing_hosts(hosts_file: &str, wanted: &[(String, String)]) -> Vec<String> {
    let present: Vec<(String, Vec<String>)> = hosts_file
        .lines()
        .map(|l| l.split('#').next().unwrap_or_default())
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let ip = parts.next()?.to_string();
            Some((ip, parts.map(str::to_string).collect()))
        })
        .collect();
    wanted
        .iter()
        .filter(|(ip, host)| {
            !present
                .iter()
                .any(|(i, names)| i == ip && names.contains(host))
        })
        .map(|(ip, host)| format!("{ip} {host}"))
        .collect()
}

/// A change to the CA's file means a new CA, which has to be trusted again.
pub fn ca_sha256(checkout: &Path) -> Result<String, Failure> {
    let bytes = std::fs::read(checkout.join("state/ca/root.crt")).map_err(|e| {
        Failure::runtime(format!(
            "the sandbox has no public CA yet (state/ca/root.crt: {e})"
        ))
    })?;
    Ok(data_encoding::HEXLOWER.encode(&Sha256::digest(&bytes)))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AccessRecord {
    /// The CA the developer last confirmed trusting.
    pub ca_sha256: String,
}

impl AccessRecord {
    pub fn load(dir: &Path) -> Option<AccessRecord> {
        toml::from_str(&std::fs::read_to_string(dir.join(RECORD)).ok()?).ok()
    }

    pub fn save(&self, dir: &Path) -> Result<(), Failure> {
        std::fs::create_dir_all(dir).map_err(Failure::runtime)?;
        std::fs::write(
            dir.join(RECORD),
            toml::to_string(self).expect("a record serializes"),
        )
        .map_err(Failure::runtime)
    }
}

pub struct AccessCheck {
    pub missing_hosts: Vec<String>,
    pub ca_trusted: bool,
}

pub fn assess(
    block: &str,
    hosts_file: &str,
    ca: &str,
    record: Option<&AccessRecord>,
) -> AccessCheck {
    AccessCheck {
        missing_hosts: missing_hosts(hosts_file, &parse_hosts_block(block)),
        ca_trusted: record.is_some_and(|r| r.ca_sha256 == ca),
    }
}

pub fn walkthrough_text(check: &AccessCheck, ca_path: &Path) -> String {
    let mut out = Vec::new();
    if !check.missing_hosts.is_empty() {
        out.push(format!(
            "Add these lines to /etc/hosts (it needs sudo; hpy does not edit it):\n\n  {}\n",
            check.missing_hosts.join("\n  ")
        ));
    }
    if !check.ca_trusted {
        out.push(format!(
            "Trust the sandbox's certificate authority in your browser or OS (hpy does not edit trust stores):\n\n  {}\n\n\
             On macOS: open it in Keychain Access, add it to the System keychain, and set it to Always Trust.\n\
             On Linux: import it in your browser's certificate settings, under Authorities.\n\
             Import only this file; never the sandbox's private key.",
            ca_path.display()
        ));
    }
    out.join("\n")
}

pub async fn ensure_access(
    ctx: &Ctx,
    sandbox: &Sandbox<'_>,
    network_dir: &Path,
    hosts_path: &Path,
) -> Result<(), Failure> {
    let ca_path = sandbox.checkout.join("state/ca/root.crt");
    loop {
        let block = sandbox.hosts_block().await?;
        let hosts = std::fs::read_to_string(hosts_path).unwrap_or_default();
        let ca = ca_sha256(&sandbox.checkout)?;
        let record = AccessRecord::load(network_dir);
        let check = assess(&block, &hosts, &ca, record.as_ref());
        let text = walkthrough_text(&check, &ca_path);
        if text.is_empty() {
            break;
        }
        if !ctx.prompter.is_interactive() {
            return Err(Failure::usage(format!(
                "this computer cannot reach the local network yet:\n\n{text}\n\nthen run this again from a terminal"
            )));
        }
        ctx.out.status(&format!(
            "\nOne-time setup, so your browser can reach the local network:\n\n{text}\n"
        ));
        if !ctx.prompter.confirm("Done?", false)? {
            return Err(Failure::runtime("cancelled"));
        }
        // Hosts are checked again on the next pass; trust cannot be checked
        // from here, so the developer's word is recorded against this CA.
        if !check.ca_trusted {
            AccessRecord { ca_sha256: ca }.save(network_dir)?;
        }
    }
    sandbox.access_start().await
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: &str = "# sandbox hv-app host access: begin\n127.0.0.1 happyview.atmosbox.test\n127.0.0.1 pds1.atmosbox.test\n# sandbox hv-app host access: end\n";

    #[test]
    fn the_block_parses_to_entries() {
        assert_eq!(
            parse_hosts_block(BLOCK),
            [
                (
                    "127.0.0.1".to_string(),
                    "happyview.atmosbox.test".to_string()
                ),
                ("127.0.0.1".to_string(), "pds1.atmosbox.test".to_string()),
            ]
        );
    }

    #[test]
    fn hosts_lines_match_by_ip_and_any_name_and_ignore_comments() {
        let wanted = parse_hosts_block(BLOCK);
        let hosts = "127.0.0.1 localhost\n# 127.0.0.1 pds1.atmosbox.test\n127.0.0.1\tfoo happyview.atmosbox.test # mine\n";
        assert_eq!(
            missing_hosts(hosts, &wanted),
            ["127.0.0.1 pds1.atmosbox.test"]
        );
        assert!(missing_hosts(&format!("{hosts}{BLOCK}"), &wanted).is_empty());
    }

    #[test]
    fn a_changed_ca_needs_trusting_again() {
        let hosts = BLOCK;
        let record = AccessRecord {
            ca_sha256: "aaa".into(),
        };
        assert!(assess(BLOCK, hosts, "aaa", Some(&record)).ca_trusted);
        assert!(!assess(BLOCK, hosts, "bbb", Some(&record)).ca_trusted);
        assert!(!assess(BLOCK, hosts, "aaa", None).ca_trusted);
    }

    #[test]
    fn the_walkthrough_says_what_to_do_and_never_offers_to_do_it() {
        let check = AccessCheck {
            missing_hosts: vec!["127.0.0.1 pds1.atmosbox.test".into()],
            ca_trusted: false,
        };
        let text = walkthrough_text(&check, Path::new("/data/x/state/ca/root.crt"));
        assert!(text.contains("127.0.0.1 pds1.atmosbox.test"));
        assert!(text.contains("/data/x/state/ca/root.crt"));
        assert!(text.contains("hpy does not edit"));
        let done = walkthrough_text(
            &AccessCheck {
                missing_hosts: vec![],
                ca_trusted: true,
            },
            Path::new("/x"),
        );
        assert!(done.is_empty());
    }

    #[test]
    fn the_record_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert!(AccessRecord::load(dir.path()).is_none());
        AccessRecord {
            ca_sha256: "abc".into(),
        }
        .save(dir.path())
        .unwrap();
        assert_eq!(AccessRecord::load(dir.path()).unwrap().ca_sha256, "abc");
    }
}
