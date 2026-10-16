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
//! space-separated grant string, and `blob:` permissions whose parameter is a
//! mime pattern. `repo:` and the rest are the server's business.

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
