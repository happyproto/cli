//! The registry's input rules, ported from the lexicons repo's Lua prelude
//! (`src/shared/prelude.lua`, blocks `validate` and `plugin`). The registry
//! enforces these by silently refusing to index, so the CLI enforces them
//! loudly first. Where a Rust crate is the real authority (`semver` is what
//! HappyView parses ranges with), it is used instead of a shape check.

use unicode_segmentation::UnicodeSegmentation;

/// A package slug: the profile's record key and the first half of a
/// release's, so it must survive a record key, a URL segment and a split on
/// `:`.
pub fn is_slug(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.starts_with(|c: char| c.is_ascii_alphabetic())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// Why `s` is not a publishable version, or `None` when it is.
pub fn version_problem(s: &str) -> Option<String> {
    if s.starts_with(['v', 'V']) {
        return Some(format!("`{s}` must not start with `v`; use `{}`", &s[1..]));
    }
    if s.contains('+') {
        return Some(format!(
            "`{s}` carries build metadata (`+…`), which cannot appear in a record key; drop it"
        ));
    }
    if s.len() > 256 {
        return Some("is longer than 256 characters".into());
    }
    match semver::Version::parse(s) {
        Ok(_) => None,
        Err(e) => Some(format!("`{s}` is not a semver 2.0 version: {e}")),
    }
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
    if let Some(rest) = key.strip_prefix("at://")
        && let Some((did, slug)) = rest.split_once("/at.happyproto.plugin.profile/")
        && is_did(did)
        && is_slug(slug)
    {
        return None;
    }
    Some(format!(
        "`{key}` must be `env:<name>` or `at://<did>/at.happyproto.plugin.profile/<slug>`"
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert!(is_slug("happyview-atproto"));
        assert!(is_slug("a"));
        assert!(is_slug("My.Plugin-2"));
        assert!(!is_slug(""));
        assert!(!is_slug("2fast"));
        assert!(!is_slug("has:colon"));
        assert!(!is_slug("under_score"));
        assert!(!is_slug(&"a".repeat(129)));
    }

    #[test]
    fn versions() {
        assert_eq!(version_problem("1.2.3"), None);
        assert_eq!(version_problem("1.2.3-rc.1"), None);
        assert!(
            version_problem("1.2.3+build")
                .unwrap()
                .contains("build metadata")
        );
        assert!(version_problem("v1.2.3").unwrap().contains("`v`"));
        assert!(version_problem("1.2").is_some());
        assert!(version_problem("01.2.3").is_some());
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
            requires_key_problem("at://did:plc:abc123/at.happyproto.plugin.profile/happyview-http"),
            None
        );
        assert!(requires_key_problem("env:").is_some());
        assert!(requires_key_problem("happyview-http").is_some());
        assert!(requires_key_problem("at://did:plc:abc/app.bsky.feed.post/x").is_some());
        assert!(requires_key_problem("at://notadid/at.happyproto.plugin.profile/x").is_some());
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
