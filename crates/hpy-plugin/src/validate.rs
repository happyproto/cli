//! The registry's grammar for names, versions, ranges and `requires` keys.
//! The registry refuses what breaks these, so the CLI refuses it first and
//! says why. Where a Rust crate is the real authority (`semver` is what
//! HappyView parses ranges with), it is used instead of a shape check.

use unicode_segmentation::UnicodeSegmentation;

use crate::{PROJECT_NSID, VERSION_NSID};

const MAX_NAME: usize = 64;
const MAX_VERSION: usize = 64;

/// A project name: the record key of the project, its publication and its
/// sidecar, and the first half of a version's and a channel's, so it must
/// survive a record key, a URL segment and a split on `:`.
pub fn is_project_name(s: &str) -> bool {
    let edge = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = s.as_bytes();
    (1..=MAX_NAME).contains(&bytes.len())
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|b| edge(b) || *b == b'-')
}

/// Why `s` is not a publishable version, or `None` when it is: a semver core
/// and an optional lowercase prerelease. The version is half of a record
/// key, which cannot hold `+`, and keys compare byte for byte, so case would
/// make two keys for one version.
pub fn version_problem(s: &str) -> Option<String> {
    if s.starts_with(['v', 'V']) {
        return Some(format!("`{s}` must not start with `v`; use `{}`", &s[1..]));
    }
    if s.contains('+') {
        return Some(format!(
            "`{s}` carries build metadata (`+…`), which cannot appear in a record key; drop it"
        ));
    }
    if s.len() > MAX_VERSION {
        return Some(format!("is longer than {MAX_VERSION} characters"));
    }
    let (core, pre) = match s.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (s, None),
    };
    let number = |n: &&str| {
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && (*n == "0" || !n.starts_with('0'))
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 || !parts.iter().all(number) {
        return Some(format!(
            "`{s}` must be MAJOR.MINOR.PATCH, numbers without leading zeros (e.g. `1.2.0`)"
        ));
    }
    let identifier = |i: &str| {
        !i.is_empty()
            && i.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    // `semver` refuses a numeric identifier with a leading zero, so a version
    // with one would publish but never install.
    let leading_zero =
        |i: &str| i.len() > 1 && i.starts_with('0') && i.bytes().all(|b| b.is_ascii_digit());
    if let Some(pre) = pre
        && pre.split('.').any(leading_zero)
    {
        return Some(format!(
            "`{s}` has a numeric prerelease identifier with a leading zero (e.g. `alpha.01`); write `alpha.1`"
        ));
    }
    if let Some(pre) = pre
        && !pre.split('.').all(identifier)
    {
        return Some(format!(
            "`{s}` has a prerelease that is not dot-separated lowercase letters, digits and `-` (e.g. `1.2.0-alpha.3`)"
        ));
    }
    None
}

/// Why `s` is not a version requirement HappyView can resolve, or `None`.
pub fn range_problem(s: &str) -> Option<String> {
    if s.trim().is_empty() {
        return Some("is empty".into());
    }
    if s.contains("||") {
        return Some(
            "uses `||`, which Cargo's semver does not support; give one range with \
             comma-separated bounds, or publish one release per major"
                .into(),
        );
    }
    match semver::VersionReq::parse(s) {
        Ok(_) => None,
        Err(e) => Some(format!("`{s}` is not a semver range: {e}")),
    }
}

/// Why `key` is not a valid `requires` key, or `None`.
pub fn requires_key_problem(key: &str) -> Option<String> {
    if let Some(name) = key.strip_prefix("env:")
        && !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return None;
    }
    if parse_project_uri(key).is_some() {
        return None;
    }
    Some(format!(
        "`{key}` must be `env:<name>` or `at://<did>/{PROJECT_NSID}/<name>`"
    ))
}

pub fn project_uri(did: &str, name: &str) -> String {
    format!("at://{did}/{PROJECT_NSID}/{name}")
}

pub fn version_uri(did: &str, name: &str, version: &str) -> String {
    format!("at://{did}/{VERSION_NSID}/{name}:{version}")
}

/// The DID and name in a `software.release.project` URI, or `None` for any
/// other URI.
pub fn parse_project_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("at://")?;
    let (did, name) = rest.split_once(&format!("/{PROJECT_NSID}/"))?;
    (is_did(did) && is_project_name(name)).then(|| (did.to_string(), name.to_string()))
}

/// atproto DID syntax: `did:<lowercase method>:<identifier>`, at most 2048
/// characters, and the identifier never ends in `:` or `%`.
pub fn is_did(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("did:") else {
        return false;
    };
    let Some((method, id)) = rest.split_once(':') else {
        return false;
    };
    s.len() <= 2048
        && !method.is_empty()
        && method.chars().all(|c| c.is_ascii_lowercase())
        && !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:%-".contains(c))
        && !id.ends_with([':', '%'])
}

/// User-perceived characters, which is what lexicon `maxGraphemes` counts.
pub fn graphemes(s: &str) -> usize {
    s.graphemes(true).count()
}

/// Records a problem when `s` exceeds a lexicon's `maxGraphemes` or
/// `maxLength` (bytes), naming whichever it broke.
pub(crate) fn too_long(
    out: &mut Vec<crate::Problem>,
    path: &str,
    s: &str,
    max_graphemes: usize,
    max_bytes: usize,
) {
    if graphemes(s) > max_graphemes {
        out.push(crate::Problem::new(
            path,
            format!("is longer than {max_graphemes} characters"),
        ));
    } else if s.len() > max_bytes {
        out.push(crate::Problem::new(
            path,
            format!("is longer than {max_bytes} bytes"),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_names() {
        for ok in ["a", "happyview-lua", "0", "a-b-c", &"a".repeat(64)] {
            assert!(is_project_name(ok), "{ok} should be a name");
        }
        for bad in ["", "-a", "a-", "A", "a.b", "a:b", "a_b", &"a".repeat(65)] {
            assert!(!is_project_name(bad), "{bad} should not be a name");
        }
    }

    #[test]
    fn versions() {
        for ok in [
            "1.2.0",
            "1.2.0-alpha.3",
            "0.0.0",
            "10.20.30-rc-1.x",
            "1.0.0-0",
            "1.0.0-alpha.0",
            "1.0.0-0a",
            "1.0.0-alpha.10",
        ] {
            assert_eq!(version_problem(ok), None, "{ok}");
        }
        assert!(version_problem("v1.2.0").unwrap().contains("`v`"));
        assert!(
            version_problem("1.2.0+b")
                .unwrap()
                .contains("build metadata")
        );
        for bad in [
            "1.2",
            "1.2.0-Alpha",
            "01.2.3",
            "1.2.0-",
            "1.2.0-a..b",
            "1.2.x",
            "1.0.0-alpha.01",
            "1.0.0-01",
            "1.0.0-00",
        ] {
            assert!(version_problem(bad).is_some(), "{bad} should be refused");
        }
        let long = format!("1.0.0-{}", "a".repeat(59));
        assert!(version_problem(&long).unwrap().contains("64"));
    }

    #[test]
    fn ranges() {
        assert_eq!(range_problem(">=3.0.0"), None);
        assert_eq!(range_problem("^0.1"), None);
        assert_eq!(range_problem(">=1.0, <2.0"), None);
        assert_eq!(range_problem("*"), None);
        assert!(range_problem("^1 || ^2").unwrap().contains("||"));
        assert!(range_problem("").is_some());
        assert!(range_problem("latest").is_some());
    }

    #[test]
    fn requires_keys() {
        assert_eq!(requires_key_problem("env:happyview"), None);
        assert_eq!(
            requires_key_problem("at://did:plc:abc123/software.release.project/happyview-http"),
            None
        );
        assert!(
            requires_key_problem("at://did:plc:abc123/at.happyproto.plugin.profile/happyview-http")
                .is_some()
        );
        assert!(requires_key_problem("env:").is_some());
        assert!(requires_key_problem("happyview-http").is_some());
        assert!(requires_key_problem("at://notadid/software.release.project/x").is_some());
        assert!(requires_key_problem("at://did:plc:abc/software.release.project/Bad").is_some());
    }

    #[test]
    fn uris() {
        assert_eq!(
            project_uri("did:plc:abc", "happyview-lua"),
            "at://did:plc:abc/software.release.project/happyview-lua"
        );
        assert_eq!(
            version_uri("did:plc:abc", "happyview-lua", "1.2.0"),
            "at://did:plc:abc/software.release.version/happyview-lua:1.2.0"
        );
        assert_eq!(
            parse_project_uri("at://did:plc:abc/software.release.project/happyview-lua"),
            Some(("did:plc:abc".into(), "happyview-lua".into()))
        );
        assert_eq!(
            parse_project_uri("at://did:plc:abc/software.release.version/x:1.0.0"),
            None
        );
        assert_eq!(
            parse_project_uri("did:plc:abc/software.release.project/x"),
            None
        );
    }

    #[test]
    fn dids() {
        assert!(is_did("did:plc:4jrld6fwpnwqehtce56qshzv"));
        assert!(is_did("did:web:example.com"));
        assert!(!is_did("did:PLC:abc"));
        assert!(!is_did("did:plc:abc:"));
        assert!(!is_did("plc:abc"));
    }

    #[test]
    fn grapheme_count() {
        assert_eq!(graphemes("abc"), 3);
        assert_eq!(graphemes("👩‍👩‍👧"), 1);
    }
}
