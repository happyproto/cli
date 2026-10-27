//! A version's entry in a plugin's `CHANGELOG.md`, which becomes the
//! changelog document published with the release.

/// The text under the `## [version](…)` or `## version` heading, up to the
/// next `## ` heading, trimmed; `None` when there is no such heading or
/// nothing under it.
pub fn changelog_entry(changelog_md: &str, version: &str) -> Option<String> {
    let mut lines = changelog_md.lines();
    lines.find(|line| {
        line.strip_prefix("## ")
            .is_some_and(|heading| names_version(heading, version))
    })?;
    let body: Vec<&str> = lines.take_while(|line| !line.starts_with("## ")).collect();
    let entry = body.join("\n").trim().to_string();
    (!entry.is_empty()).then_some(entry)
}

/// Whether a heading is for exactly `version`, so `1.1.0` never matches
/// `1.1.0-alpha.1` or `1.1`.
fn names_version(heading: &str, version: &str) -> bool {
    let heading = heading.trim_start();
    match heading.strip_prefix('[') {
        // `[1.1.0](…) (date)` and `[1.1.0 (date)](…)` both occur.
        Some(linked) => linked
            .strip_prefix(version)
            .is_some_and(|rest| rest.starts_with(']') || rest.starts_with(char::is_whitespace)),
        None => heading
            .strip_prefix(version)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape semantic-release writes in the plugins repo.
    const PLUGINS: &str = "\
## [1.1.0](https://github.com/happyproto/plugins/releases/tag/happyview-lua-v1.1.0) (2026-10-10)

- **Library calls can run together.** The new `internal.async` module.
- **Tracebacks name the library bridge.** It's labelled `[library bridge]` now.

## [1.0.0](https://github.com/happyproto/plugins/releases/tag/happyview-lua-v1.0.0) (2026-10-07)

- **First release on HappyView v3's plugin API.**
";

    #[test]
    fn reads_the_bullets_under_a_linked_heading() {
        assert_eq!(
            changelog_entry(PLUGINS, "1.1.0").as_deref(),
            Some(
                "- **Library calls can run together.** The new `internal.async` module.\n\
                 - **Tracebacks name the library bridge.** It's labelled `[library bridge]` now."
            )
        );
        assert_eq!(
            changelog_entry(PLUGINS, "1.0.0").as_deref(),
            Some("- **First release on HappyView v3's plugin API.**")
        );
    }

    #[test]
    fn reads_a_heading_with_the_date_inside_the_link() {
        let jobs = "\
## [1.1.0 (2026-10-08)](https://github.com/happyproto/plugins/releases/tag/happyview-jobs-v1.1.0)

- **Scripts can read jobs.**

## [1.0.0 (2026-10-07)](https://github.com/happyproto/plugins/releases/tag/happyview-jobs-v1.0.0)

- **First release.**
";
        assert_eq!(
            changelog_entry(jobs, "1.1.0").as_deref(),
            Some("- **Scripts can read jobs.**")
        );
        assert_eq!(
            changelog_entry(jobs, "1.0.0").as_deref(),
            Some("- **First release.**")
        );
        assert_eq!(changelog_entry(jobs, "1.1"), None);
    }

    #[test]
    fn reads_a_bare_heading() {
        let md =
            "# Changelog\n\n## 2.0.0 (2026-01-01)\n\n### Fixes\n\n- a fix\n\n## 1.0.0\n\n- first\n";
        assert_eq!(
            changelog_entry(md, "2.0.0").as_deref(),
            Some("### Fixes\n\n- a fix")
        );
        assert_eq!(changelog_entry(md, "1.0.0").as_deref(), Some("- first"));
    }

    #[test]
    fn a_version_must_match_whole() {
        assert_eq!(changelog_entry(PLUGINS, "1.1"), None);
        assert_eq!(changelog_entry(PLUGINS, "1.1.0-alpha.1"), None);
        let md = "## 1.1.0-alpha.1\n\n- pre\n\n## 1.1.0\n\n- final\n";
        assert_eq!(changelog_entry(md, "1.1.0").as_deref(), Some("- final"));
        assert_eq!(
            changelog_entry(md, "1.1.0-alpha.1").as_deref(),
            Some("- pre")
        );
    }

    #[test]
    fn an_empty_or_missing_entry_is_none() {
        assert_eq!(
            changelog_entry("## 1.0.0\n\n## 0.9.0\n- x\n", "1.0.0"),
            None
        );
        assert_eq!(changelog_entry("", "1.0.0"), None);
    }
}
