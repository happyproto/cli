//! What a session was granted, read before asking it to do something.
//!
//! An authorization server fixes a session's scopes when it issues it, so a
//! grant that is missing something cannot be widened by retrying — the only
//! remedy is a new authorization. A publish uploads several blobs and then
//! writes one record, and each upload is a separate request, so a scope that
//! covers the first mime type and not the second fails halfway: the earlier
//! blobs are already on the PDS with no record referring to them, and the
//! version is half-published. Checking the grant before the first upload is
//! what keeps that from happening.
//!
//! The grammar here is only as much of proposal 0011 as `hpy` needs: a
//! space-separated grant string, `blob:` permissions whose parameter is a
//! mime pattern, and `repo:` permissions whose parameter is a collection.
//! The rest is the server's business.

use hpy_plugin::{
    CHANNEL_NSID, DOCUMENT_NSID, MANIFEST_NSID, PROJECT_NSID, PUBLICATION_NSID, SIDECAR_NSID,
    STATUS_NSID, VERSION_NSID,
};

/// The collections a publish writes to through the gateway. Checked up front
/// for the same reason as blobs: the gateway writes several records in turn,
/// so a grant that omits a later one fails with the earlier ones already
/// written.
pub const PUBLISH_COLLECTIONS: [&str; 8] = [
    PROJECT_NSID,
    MANIFEST_NSID,
    VERSION_NSID,
    CHANNEL_NSID,
    STATUS_NSID,
    SIDECAR_NSID,
    PUBLICATION_NSID,
    DOCUMENT_NSID,
];

/// Whether `granted` carries a `repo:` permission covering `collection`.
pub fn covers_repo(granted: &str, collection: &str) -> bool {
    granted
        .split_whitespace()
        .filter_map(|token| token.strip_prefix("repo:"))
        // `repo:a.b.c?action=create` names the collection before its
        // parameters, which narrow the actions rather than the collection.
        .map(|permission| permission.split('?').next().unwrap_or(permission))
        .any(|named| named == "*" || named == collection)
}

/// The collections among `collections` that `granted` cannot write to, in the
/// order given and without repeats, as the `repo:` scopes a new authorization
/// would have to ask for.
pub fn missing_repo_scopes<'a>(
    granted: &str,
    collections: impl IntoIterator<Item = &'a str>,
) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    for collection in collections {
        let scope = format!("repo:{collection}");
        if !covers_repo(granted, collection) && !missing.contains(&scope) {
            missing.push(scope);
        }
    }
    missing
}

/// Whether `granted` carries a `blob:` permission covering `mime`.
///
/// Patterns are matched the way `blob:image/*` is written in the default
/// scope: an exact type, a subtype wildcard, or `*/*` for anything.
pub fn covers_blob(granted: &str, mime: &str) -> bool {
    let mime = normalize(mime);
    granted
        .split_whitespace()
        .filter_map(|token| token.strip_prefix("blob:"))
        .any(|pattern| pattern_matches(&normalize(pattern), &mime))
}

/// The mime types among `mimes` that `granted` cannot upload, in the order
/// given and without repeats, as the `blob:` scopes a new authorization would
/// have to ask for.
pub fn missing_blob_scopes<'a>(
    granted: &str,
    mimes: impl IntoIterator<Item = &'a str>,
) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    for mime in mimes {
        let scope = format!("blob:{}", normalize(mime));
        if !covers_blob(granted, mime) && !missing.contains(&scope) {
            missing.push(scope);
        }
    }
    missing
}

/// A mime type's parameters say nothing about which blobs a scope admits, and
/// its case is not significant, so neither reaches the comparison.
fn normalize(mime: &str) -> String {
    mime.split(';').next().unwrap_or(mime).trim().to_lowercase()
}

fn pattern_matches(pattern: &str, mime: &str) -> bool {
    if pattern == "*/*" || pattern == mime {
        return true;
    }
    // `image/*` covers `image/png`; a bare `image` is not a pattern and is
    // deliberately not read as one.
    pattern
        .strip_suffix("/*")
        .is_some_and(|prefix| !prefix.is_empty() && mime.starts_with(&format!("{prefix}/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::DEFAULT_SCOPE;

    #[test]
    fn an_exact_type_covers_only_itself() {
        assert!(covers_blob("blob:application/wasm", "application/wasm"));
        assert!(!covers_blob("blob:application/wasm", "application/json"));
    }

    #[test]
    fn a_subtype_wildcard_covers_its_type() {
        assert!(covers_blob("blob:image/*", "image/png"));
        assert!(!covers_blob("blob:image/*", "application/json"));
        // Not a prefix match: `image/*` must not admit `imagefoo/png`.
        assert!(!covers_blob("blob:image/*", "imagefoo/png"));
    }

    #[test]
    fn the_full_wildcard_covers_anything() {
        assert!(covers_blob("blob:*/*", "application/json"));
        assert!(covers_blob("atproto blob:*/*", "image/png"));
    }

    #[test]
    fn only_blob_permissions_are_read() {
        assert!(!covers_blob(
            "atproto repo:application/json",
            "application/json"
        ));
        assert!(!covers_blob("", "application/json"));
    }

    #[test]
    fn parameters_and_case_do_not_decide_a_match() {
        assert!(covers_blob(
            "blob:application/json",
            "application/json; charset=utf-8"
        ));
        assert!(covers_blob("blob:application/JSON", "application/json"));
    }

    #[test]
    fn the_missing_scopes_are_named_once_each_in_order() {
        let granted = "atproto blob:application/wasm";
        assert_eq!(
            missing_blob_scopes(granted, ["application/wasm", "image/png", "image/png"]),
            vec!["blob:image/png".to_string()]
        );
        assert!(missing_blob_scopes(granted, ["application/wasm"]).is_empty());
    }

    #[test]
    fn a_repo_permission_covers_its_collection_and_a_wildcard_covers_all() {
        assert!(covers_repo("repo:a.b.c", "a.b.c"));
        assert!(!covers_repo("repo:a.b.c", "a.b.d"));
        // Action and other parameters narrow what may be done, not which
        // collection; a grant that names the collection counts.
        assert!(covers_repo("atproto repo:a.b.c?action=create", "a.b.c"));
        assert!(covers_repo("repo:*", "a.b.c"));
        assert!(!covers_repo("blob:a.b.c", "a.b.c"));
        assert!(!covers_repo("", "a.b.c"));
    }

    #[test]
    fn the_missing_repo_scopes_are_named_once_each_in_order() {
        assert_eq!(
            missing_repo_scopes("atproto repo:a.b", ["a.b", "c.d", "c.d", "e.f"]),
            vec!["repo:c.d".to_string(), "repo:e.f".to_string()]
        );
    }

    #[test]
    fn the_default_scope_covers_every_collection_a_publish_writes() {
        assert!(missing_repo_scopes(DEFAULT_SCOPE, PUBLISH_COLLECTIONS).is_empty());
        assert_eq!(PUBLISH_COLLECTIONS.len(), 8);
        // A grant from before the registry moved collections cannot publish.
        let old = "atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm";
        assert_eq!(missing_repo_scopes(old, PUBLISH_COLLECTIONS).len(), 8);
    }

    /// The scope a login asks for has to cover what a publish uploads, or
    /// every publish fails at the first blob the grant omits.
    #[test]
    fn the_default_scope_covers_every_artifact_a_publish_uploads() {
        for mime in [
            "application/wasm",
            "application/json",
            "image/png",
            "image/jpeg",
            "image/webp",
        ] {
            assert!(
                covers_blob(DEFAULT_SCOPE, mime),
                "the default scope cannot upload {mime}"
            );
        }
    }
}
