//! `at.happyproto.plugin.profile`: the package, as its publisher writes it.

use serde::{Deserialize, Serialize};

use crate::validate::graphemes;
use crate::{PLUGIN_KIND, PROFILE_NSID, Problem};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Sections {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security: Option<String>,
}

impl Sections {
    pub fn entries(&self) -> [(&'static str, &Option<String>); 4] {
        [
            ("description", &self.description),
            ("installation", &self.installation),
            ("changelog", &self.changelog),
            ("security", &self.security),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub authors: Vec<Author>,
    #[serde(default)]
    pub security: Vec<Contact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Sections>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
    /// Fields this version of `hpy` does not know about, kept so that an edit
    /// never drops what a newer client (or a hand edit) wrote.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Records a problem when `s` exceeds a lexicon's `maxGraphemes` or
/// `maxLength` (bytes), naming whichever it broke.
pub(crate) fn too_long(
    out: &mut Vec<Problem>,
    path: &str,
    s: &str,
    max_graphemes: usize,
    max_bytes: usize,
) {
    if graphemes(s) > max_graphemes {
        out.push(Problem::new(
            path,
            format!("is longer than {max_graphemes} characters"),
        ));
    } else if s.len() > max_bytes {
        out.push(Problem::new(
            path,
            format!("is longer than {max_bytes} bytes"),
        ));
    }
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

impl Profile {
    pub fn new_plugin() -> Profile {
        Profile {
            kind: PLUGIN_KIND.into(),
            license: String::new(),
            authors: Vec::new(),
            security: Vec::new(),
            name: None,
            description: None,
            keywords: Vec::new(),
            sections: None,
            last_updated: None,
            extra: serde_json::Map::new(),
        }
    }

    pub fn problems(&self) -> Vec<Problem> {
        let mut out = Vec::new();
        if self.kind != PLUGIN_KIND {
            out.push(Problem::new(
                "profile.type",
                format!("must be \"{PLUGIN_KIND}\""),
            ));
        }
        if self.license.trim().is_empty() {
            out.push(Problem::new(
                "profile.license",
                "is required (an SPDX expression, or \"proprietary\")",
            ));
        } else if self.license.len() > 256 {
            out.push(Problem::new(
                "profile.license",
                "is longer than 256 characters",
            ));
        }
        if self.authors.is_empty() {
            out.push(Problem::new("profile.authors", "needs at least one author"));
        }
        for (i, a) in self.authors.iter().enumerate() {
            let path = format!("profile.authors[{i}]");
            if a.name.trim().is_empty() {
                out.push(Problem::new(&path, "needs a name"));
            }
            too_long(&mut out, &format!("{path}.name"), &a.name, 64, 640);
            if a.url.as_ref().is_some_and(|u| !looks_like_uri(u)) {
                out.push(Problem::new(format!("{path}.url"), "is not a URI"));
            }
            if a.email.as_ref().is_some_and(|e| e.len() > 320) {
                out.push(Problem::new(
                    format!("{path}.email"),
                    "is longer than 320 characters",
                ));
            }
        }
        if self.security.is_empty() {
            out.push(Problem::new(
                "profile.security",
                "needs at least one contact: a plugin runs as native code in an operator's process",
            ));
        }
        for (i, c) in self.security.iter().enumerate() {
            let path = format!("profile.security[{i}]");
            if c.url.is_none() && c.email.is_none() {
                out.push(Problem::new(&path, "needs a url or an email"));
            }
            if c.url.as_ref().is_some_and(|u| !looks_like_uri(u)) {
                out.push(Problem::new(format!("{path}.url"), "is not a URI"));
            }
            if c.email.as_ref().is_some_and(|e| e.len() > 320) {
                out.push(Problem::new(
                    format!("{path}.email"),
                    "is longer than 320 characters",
                ));
            }
        }
        if let Some(name) = &self.name {
            too_long(&mut out, "profile.name", name, 64, 640);
        }
        if let Some(d) = &self.description {
            too_long(&mut out, "profile.description", d, 300, 3000);
        }
        if self.keywords.len() > 20 {
            out.push(Problem::new(
                "profile.keywords",
                "has more than 20 keywords",
            ));
        }
        for (i, k) in self.keywords.iter().enumerate() {
            too_long(&mut out, &format!("profile.keywords[{i}]"), k, 32, 320);
        }
        if let Some(sections) = &self.sections {
            for (name, text) in sections.entries() {
                if let Some(text) = text {
                    too_long(
                        &mut out,
                        &format!("profile.sections.{name}"),
                        text,
                        2000,
                        20000,
                    );
                }
            }
        }
        out
    }

    pub fn to_record(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).expect("profile serializes");
        value["$type"] = PROFILE_NSID.into();
        value
    }

    pub fn from_record(mut value: serde_json::Value) -> Result<Profile, String> {
        if let Some(obj) = value.as_object_mut() {
            obj.remove("$type");
        }
        serde_json::from_value(value)
            .map_err(|e| format!("the profile record is not readable: {e}"))
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

    fn valid() -> Profile {
        Profile {
            license: "MIT".into(),
            authors: vec![Author {
                name: "Trezy".into(),
                url: None,
                email: Some("tre@trezy.com".into()),
            }],
            security: vec![Contact {
                url: None,
                email: Some("security@happyproto.at".into()),
            }],
            ..Profile::new_plugin()
        }
    }

    #[test]
    fn valid_profile_has_no_problems_and_serializes_camel_case() {
        let mut p = valid();
        p.last_updated = Some("2026-10-09T00:00:00Z".into());
        assert!(p.problems().is_empty());
        let r = p.to_record();
        assert_eq!(r["$type"], "at.happyproto.plugin.profile");
        assert_eq!(r["type"], "happyview-plugin");
        assert_eq!(r["lastUpdated"], "2026-10-09T00:00:00Z");
        assert!(r.get("keywords").is_none());
        assert_eq!(Profile::from_record(r).unwrap(), p);
    }

    #[test]
    fn required_fields() {
        let p = Profile::new_plugin();
        let paths: Vec<_> = p.problems().into_iter().map(|p| p.path).collect();
        assert!(paths.contains(&"profile.license".to_string()));
        assert!(paths.contains(&"profile.authors".to_string()));
        assert!(paths.contains(&"profile.security".to_string()));
    }

    #[test]
    fn limits() {
        let mut p = valid();
        p.name = Some("n".repeat(65));
        p.keywords = (0..21).map(|i| format!("k{i}")).collect();
        p.security = vec![Contact {
            url: None,
            email: None,
        }];
        let paths: Vec<_> = p.problems().into_iter().map(|p| p.path).collect();
        assert!(paths.contains(&"profile.name".to_string()));
        assert!(paths.contains(&"profile.keywords".to_string()));
        assert!(paths.contains(&"profile.security[0]".to_string()));
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

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let mut r = valid().to_record();
        r["homepage"] = "https://example.com".into();
        let mut p = Profile::from_record(r).unwrap();
        p.name = Some("Renamed".into());
        let out = p.to_record();
        assert_eq!(out["homepage"], "https://example.com");
        assert_eq!(out["name"], "Renamed");
    }

    #[test]
    fn too_long_names_the_limit_that_tripped() {
        let mut p = valid();
        p.name = Some("n".repeat(65));
        let msg = p
            .problems()
            .into_iter()
            .find(|x| x.path == "profile.name")
            .unwrap()
            .message;
        assert!(msg.contains("64 characters"), "{msg}");
        // 64 graphemes, but each a 4-byte emoji repeated with joiners: over 640 bytes
        p.name = Some("👩‍👩‍👧".repeat(40));
        let msg = p
            .problems()
            .into_iter()
            .find(|x| x.path == "profile.name")
            .unwrap()
            .message;
        assert!(msg.contains("640 bytes"), "{msg}");
    }
}
