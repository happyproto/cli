//! An instance's script variables, the values its scripts read as `ctx.env`.
//!
//! A variable's value is a secret. It goes out in the body of the request
//! that sets it and nowhere else: the instance only ever answers with a
//! masked preview, and the errors here are built from the call's name and the
//! instance's answer, never from what was sent.

use serde::Deserialize;
use serde_json::json;

use super::Admin;
use crate::{Error, Result};

/// A variable as `GET /admin/script-variables` lists it. The masked preview is
/// left out: it is the same fixed mask for every variable.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ScriptVariable {
    pub key: String,
    /// The instance can't read the stored value with its current key, so
    /// setting the variable again is the only way to recover it.
    #[serde(default)]
    pub unreadable: bool,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl Admin {
    /// Every variable the instance has, without its value.
    pub async fn script_variables(&self) -> Result<Vec<ScriptVariable>> {
        let out = self
            .send(
                "listing script variables",
                reqwest::Method::GET,
                "/script-variables",
                None,
            )
            .await?;
        serde_json::from_value(out).map_err(|e| {
            Error::Other(format!(
                "{} listed its script variables unreadably: {e}",
                self.base
            ))
        })
    }

    /// Creates the variable `key`, or replaces its value.
    pub async fn set_script_variable(&self, key: &str, value: &str) -> Result<()> {
        let body = json!({ "key": key, "value": value });
        self.send(
            &format!("setting {key}"),
            reqwest::Method::POST,
            "/script-variables",
            Some(&body),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const KEY: &str = "hv_0123456789abcdef0123456789abcdef";
    const SECRET: &str = "sk-live-do-not-print-7f3a9c";

    #[tokio::test]
    async fn lists_variables_without_their_values() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/admin/script-variables"))
            .and(header("authorization", format!("Bearer {KEY}").as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"key": "API_TOKEN", "preview": "****", "unreadable": false,
                 "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z"},
                {"key": "OLD", "preview": "****", "unreadable": true,
                 "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z"}
            ])))
            .mount(&server)
            .await;
        let vars = Admin::new(&server.uri(), KEY)
            .script_variables()
            .await
            .unwrap();
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].key, "API_TOKEN");
        assert!(!vars[0].unreadable);
        assert!(vars[1].unreadable);
    }

    #[tokio::test]
    async fn sets_a_variable_with_its_key_and_value() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/admin/script-variables"))
            .and(body_json(json!({"key": "API_TOKEN", "value": SECRET})))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        Admin::new(&server.uri(), KEY)
            .set_script_variable("API_TOKEN", SECRET)
            .await
            .unwrap();
    }

    /// The error names the key and says what the instance answered, and
    /// carries nothing of the request body.
    #[tokio::test]
    async fn a_refused_set_names_the_key_but_never_the_value() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500).set_body_json(json!({
                "error": "InternalError", "message": "failed to upsert script variable"
            })))
            .mount(&server)
            .await;
        let err = Admin::new(&server.uri(), KEY)
            .set_script_variable("API_TOKEN", SECRET)
            .await
            .unwrap_err();
        let text = format!("{err} {err:?}");
        assert!(text.contains("API_TOKEN"), "{text}");
        assert!(text.contains("failed to upsert"), "{text}");
        assert!(!text.contains(SECRET), "{text}");
    }
}
