//! A plugin as a whole, apart from any release: what `putProject` writes as
//! the `software.release.project`, its `site.standard.publication` and its
//! `at.happyproto.registry.project` sidecar.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::artifact::blob_problem;
use crate::validate::{graphemes, is_project_name, too_long};
use crate::{PLUGIN_TYPES, Problem};

/// The publication's icon limit, which is the standard.site lexicon's and so
/// a decimal megabyte, unlike the artifact's images.
pub const MAX_ICON_BYTES: usize = 1_000_000;
pub const MAX_KEYWORDS: usize = 20;
pub const MAX_PUBLICATION_NAME: usize = 64;
pub const MAX_PUBLICATION_DESCRIPTION: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Author {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Contact {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// The `site.standard.publication` half of `putProject`; the gateway adds its
/// `url`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PublicationInput {
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<Value>,
}

/// Everything `putProject` sends.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProjectDetails {
    pub name: String,
    pub publication: PublicationInput,
    pub plugin_type: String,
    pub keywords: Vec<String>,
    pub authors: Vec<Author>,
    pub security: Vec<Contact>,
}

pub(crate) fn looks_like_uri(s: &str) -> bool {
    s.split_once(':').is_some_and(|(scheme, rest)| {
        !scheme.is_empty()
            && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
            && !rest.is_empty()
    })
}

impl ProjectDetails {
    /// Everything the gateway would refuse, each located by its path in the
    /// `putProject` input.
    pub fn problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        if !is_project_name(&self.name) {
            out.push(Problem::new(
                "name",
                format!(
                    "`{}` must be 1 to 64 lowercase letters, digits and interior `-`",
                    self.name
                ),
            ));
        }
        if self.publication.name.trim().is_empty() {
            out.push(Problem::new("publication.name", "is required"));
        } else if graphemes(&self.publication.name) > MAX_PUBLICATION_NAME {
            out.push(Problem::new(
                "publication.name",
                format!("is longer than {MAX_PUBLICATION_NAME} characters"),
            ));
        }
        if let Some(d) = &self.publication.description
            && graphemes(d) > MAX_PUBLICATION_DESCRIPTION
        {
            out.push(Problem::new(
                "publication.description",
                format!("is longer than {MAX_PUBLICATION_DESCRIPTION} characters"),
            ));
        }
        if let Some(icon) = &self.publication.icon {
            let mime = icon["mimeType"].as_str().unwrap_or_default();
            let problem = if mime.starts_with("image/") {
                blob_problem(icon, &[mime], MAX_ICON_BYTES)
            } else {
                Some(format!("is {mime:?}; it must be an image"))
            };
            if let Some(p) = problem {
                out.push(Problem::new("publication.icon", p));
            }
        }
        if !PLUGIN_TYPES.contains(&self.plugin_type.as_str()) {
            out.push(Problem::new(
                "project.pluginType",
                format!(
                    "must be auth, library or interpreter (got {:?})",
                    self.plugin_type
                ),
            ));
        }
        if self.keywords.len() > MAX_KEYWORDS {
            out.push(Problem::new(
                "project.keywords",
                format!("has more than {MAX_KEYWORDS} keywords"),
            ));
        }
        for (i, k) in self.keywords.iter().enumerate() {
            too_long(&mut out, &format!("project.keywords[{i}]"), k, 32, 320);
        }
        if self.authors.is_empty() {
            out.push(Problem::new("project.authors", "needs at least one author"));
        }
        for (i, a) in self.authors.iter().enumerate() {
            let path = format!("project.authors[{i}]");
            if a.name.trim().is_empty() {
                out.push(Problem::new(format!("{path}.name"), "is required"));
            } else if graphemes(&a.name) > 128 {
                out.push(Problem::new(
                    format!("{path}.name"),
                    "is longer than 128 characters",
                ));
            }
            if a.url.as_ref().is_some_and(|u| !looks_like_uri(u)) {
                out.push(Problem::new(format!("{path}.url"), "is not a URI"));
            }
        }
        if self.security.is_empty() {
            out.push(Problem::new(
                "project.security",
                "needs at least one contact: a plugin runs as native code in an operator's process",
            ));
        }
        for (i, c) in self.security.iter().enumerate() {
            let path = format!("project.security[{i}]");
            let given = |f: &Option<String>| f.as_deref().is_some_and(|s| !s.trim().is_empty());
            if !given(&c.url) && !given(&c.email) {
                out.push(Problem::new(&path, "needs a url or an email"));
            }
            if given(&c.url) && c.url.as_ref().is_some_and(|u| !looks_like_uri(u)) {
                out.push(Problem::new(format!("{path}.url"), "is not a URI"));
            }
        }
        out
    }

    /// The `putProject` input, without `swapCid` or `validateOnly`, which
    /// depend on the call rather than the project.
    pub fn to_input(&self) -> Value {
        let mut publication = json!({ "name": self.publication.name });
        if let Some(d) = &self.publication.description {
            publication["description"] = d.clone().into();
        }
        if let Some(icon) = &self.publication.icon {
            publication["icon"] = icon.clone();
        }
        // Validation counts a blank url or email as absent, so none is sent.
        let given = |f: &Option<String>| f.clone().filter(|s| !s.trim().is_empty());
        let authors: Vec<Author> = self
            .authors
            .iter()
            .map(|a| Author {
                name: a.name.clone(),
                url: given(&a.url),
                email: given(&a.email),
            })
            .collect();
        let security: Vec<Contact> = self
            .security
            .iter()
            .map(|c| Contact {
                url: given(&c.url),
                email: given(&c.email),
            })
            .collect();
        let mut project = json!({
            "pluginType": self.plugin_type,
            "authors": authors,
            "security": security,
        });
        if !self.keywords.is_empty() {
            project["keywords"] = json!(self.keywords);
        }
        json!({
            "name": self.name,
            "publication": publication,
            "project": project,
        })
    }
}

impl Author {
    pub fn display(&self) -> String {
        let mut s = self.name.clone();
        if let Some(e) = &self.email {
            s.push_str(&format!(" <{e}>"));
        }
        if let Some(u) = &self.url {
            s.push_str(&format!(" ({u})"));
        }
        s
    }
}

impl Contact {
    pub fn display(&self) -> String {
        match (&self.email, &self.url) {
            (Some(e), Some(u)) => format!("{e} ({u})"),
            (Some(e), None) => e.clone(),
            (None, Some(u)) => u.clone(),
            (None, None) => "(empty)".into(),
        }
    }
}

/// Cuts the first `open … close` span out of `s`, answering its trimmed
/// contents when non-empty.
fn take_delimited(s: &mut String, open: char, close: char) -> Option<String> {
    let start = s.find(open)?;
    let end = s[start..].find(close)? + start;
    let inner = s[start + open.len_utf8()..end].trim().to_string();
    s.replace_range(start..end + close.len_utf8(), "");
    Some(inner).filter(|s| !s.is_empty())
}

/// `Name <email> (url)`, as npm writes authors; email and url are optional.
pub fn parse_author(s: &str) -> Result<Author, String> {
    let mut rest = s.trim().to_string();
    let email = take_delimited(&mut rest, '<', '>');
    let url = take_delimited(&mut rest, '(', ')');
    let name = rest.trim().to_string();
    if name.is_empty() {
        return Err(
            "an author needs a name, e.g. `Ada <ada@example.com> (https://ada.dev)`".into(),
        );
    }
    Ok(Author { name, email, url })
}

/// A security contact: an email address or a URI.
pub fn parse_contact(s: &str) -> Result<Contact, String> {
    let s = s.trim();
    if s.contains("://") || s.starts_with("mailto:") {
        Ok(Contact {
            url: Some(s.into()),
            email: None,
        })
    } else if s.contains('@') && !s.contains(' ') {
        Ok(Contact {
            url: None,
            email: Some(s.into()),
        })
    } else {
        Err(format!("`{s}` is neither an email address nor a URL"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::predicted_blob;

    fn valid() -> ProjectDetails {
        ProjectDetails {
            name: "happyview-lua".into(),
            publication: PublicationInput {
                name: "Lua".into(),
                description: Some("Lua scripts for HappyView.".into()),
                icon: Some(predicted_blob(b"png", "image/png")),
            },
            plugin_type: "interpreter".into(),
            keywords: vec!["lua".into()],
            authors: vec![Author {
                name: "Trezy".into(),
                url: None,
                email: Some("tre@trezy.com".into()),
            }],
            security: vec![Contact {
                url: Some("https://github.com/happyproto/plugins/security".into()),
                email: None,
            }],
        }
    }

    fn paths(d: &ProjectDetails) -> Vec<String> {
        d.problems().into_iter().map(|p| p.path).collect()
    }

    #[test]
    fn valid_details_have_no_problems_and_become_put_project_input() {
        let d = valid();
        assert_eq!(d.problems(), vec![]);
        let input = d.to_input();
        assert_eq!(
            input,
            serde_json::json!({
                "name": "happyview-lua",
                "publication": {
                    "name": "Lua",
                    "description": "Lua scripts for HappyView.",
                    "icon": predicted_blob(b"png", "image/png"),
                },
                "project": {
                    "pluginType": "interpreter",
                    "keywords": ["lua"],
                    "authors": [{ "name": "Trezy", "email": "tre@trezy.com" }],
                    "security": [{ "url": "https://github.com/happyproto/plugins/security" }],
                },
            })
        );
    }

    #[test]
    fn blank_contact_fields_are_left_out_of_the_input() {
        let mut d = valid();
        d.authors[0].url = Some(String::new());
        d.security = vec![Contact {
            url: Some("https://example.com/security".into()),
            email: Some(" ".into()),
        }];
        let input = d.to_input();
        assert_eq!(
            input["project"]["authors"],
            serde_json::json!([{ "name": "Trezy", "email": "tre@trezy.com" }])
        );
        assert_eq!(
            input["project"]["security"],
            serde_json::json!([{ "url": "https://example.com/security" }])
        );
    }

    #[test]
    fn optional_input_is_left_out() {
        let mut d = valid();
        d.publication.description = None;
        d.publication.icon = None;
        d.keywords.clear();
        let input = d.to_input();
        assert!(input["publication"].get("description").is_none());
        assert!(input["publication"].get("icon").is_none());
        assert!(input["project"].get("keywords").is_none());
    }

    #[test]
    fn name_follows_the_project_grammar() {
        let mut d = valid();
        d.name = "HappyView.Lua".into();
        assert_eq!(paths(&d), ["name"]);
    }

    #[test]
    fn publication_needs_a_name() {
        let mut d = valid();
        d.publication.name = "  ".into();
        assert_eq!(paths(&d), ["publication.name"]);
    }

    #[test]
    fn publication_name_is_at_most_64() {
        let mut d = valid();
        d.publication.name = "n".repeat(64);
        assert_eq!(d.problems(), vec![]);
        d.publication.name = "n".repeat(65);
        assert_eq!(paths(&d), ["publication.name"]);
    }

    #[test]
    fn publication_description_is_at_most_300() {
        let mut d = valid();
        d.publication.description = Some("d".repeat(300));
        assert_eq!(d.problems(), vec![]);
        d.publication.description = Some("d".repeat(301));
        assert_eq!(paths(&d), ["publication.description"]);
    }

    #[test]
    fn an_empty_security_url_or_email_counts_as_absent() {
        let mut d = valid();
        d.security = vec![Contact {
            url: Some(String::new()),
            email: Some(" ".into()),
        }];
        assert_eq!(paths(&d), ["project.security[0]"]);
    }

    #[test]
    fn icon_is_an_image_of_at_most_1_mb() {
        let mut d = valid();
        d.publication.icon.as_mut().unwrap()["mimeType"] = "application/pdf".into();
        assert_eq!(paths(&d), ["publication.icon"]);
        let mut d = valid();
        d.publication.icon.as_mut().unwrap()["size"] = 1_000_001.into();
        assert_eq!(paths(&d), ["publication.icon"]);
        d.publication.icon.as_mut().unwrap()["size"] = 1_000_000.into();
        assert_eq!(d.problems(), vec![]);
    }

    #[test]
    fn plugin_type_is_one_of_three() {
        let mut d = valid();
        d.plugin_type = "theme".into();
        assert_eq!(paths(&d), ["project.pluginType"]);
    }

    #[test]
    fn at_most_20_keywords() {
        let mut d = valid();
        d.keywords = (0..20).map(|i| format!("k{i}")).collect();
        assert_eq!(d.problems(), vec![]);
        d.keywords.push("one-too-many".into());
        assert_eq!(paths(&d), ["project.keywords"]);
    }

    #[test]
    fn keywords_have_a_limit() {
        let mut d = valid();
        d.keywords = vec!["k".repeat(33)];
        assert_eq!(paths(&d), ["project.keywords[0]"]);
        // 32 graphemes, over 320 bytes
        d.keywords = vec!["👩‍👩‍👧".repeat(32)];
        let problems = d.problems();
        assert_eq!(problems.len(), 1);
        assert!(problems[0].message.contains("320 bytes"), "{problems:?}");
    }

    #[test]
    fn at_least_one_author_with_a_name_of_at_most_128() {
        let mut d = valid();
        d.authors.clear();
        assert_eq!(paths(&d), ["project.authors"]);
        d.authors = vec![Author {
            name: " ".into(),
            ..Default::default()
        }];
        assert_eq!(paths(&d), ["project.authors[0].name"]);
        d.authors[0].name = "n".repeat(129);
        assert_eq!(paths(&d), ["project.authors[0].name"]);
        d.authors[0].name = "n".repeat(128);
        assert_eq!(d.problems(), vec![]);
    }

    #[test]
    fn at_least_one_security_contact_with_a_url_or_email() {
        let mut d = valid();
        d.security.clear();
        assert_eq!(paths(&d), ["project.security"]);
        d.security = vec![Contact::default()];
        assert_eq!(paths(&d), ["project.security[0]"]);
    }

    #[test]
    fn parses_npm_style_authors_and_contacts() {
        assert_eq!(
            parse_author("Trezy <tre@trezy.com> (https://trezy.com)").unwrap(),
            Author {
                name: "Trezy".into(),
                email: Some("tre@trezy.com".into()),
                url: Some("https://trezy.com".into())
            }
        );
        assert_eq!(parse_author("Just A Name").unwrap().name, "Just A Name");
        assert!(parse_author("  ").is_err());
        assert_eq!(
            parse_contact("security@x.io").unwrap().email.as_deref(),
            Some("security@x.io")
        );
        assert_eq!(
            parse_contact("https://x.io/sec").unwrap().url.as_deref(),
            Some("https://x.io/sec")
        );
        assert!(parse_contact("nope").is_err());
    }
}
