//! The admin API's answers, as `pull` reads them. Built from HappyView's own
//! handlers: v2 is `origin/beta` (v2.17.0) and v3 is `origin/alpha`, both in
//! `src/admin/`. Every field either version may leave out is optional, and
//! fields neither needs are not named, so an answer with more in it still
//! reads.

use serde::Deserialize;
use serde_json::Value;

/// A row of `GET /admin/lexicons` (`types.rs`, `LexiconSummary`), and of
/// `GET /admin/lexicons/{id}`, which adds `lexicon_json`.
#[derive(Debug, Clone, Deserialize)]
pub struct Lexicon {
    pub id: String,
    /// `record`, `query`, `procedure`, … as both versions name it.
    #[serde(default)]
    pub lexicon_type: Option<String>,
    #[serde(default)]
    pub backfill: bool,
    #[serde(default)]
    pub token_cost: Option<i64>,
    /// v3 only; v2 indexes every record lexicon.
    #[serde(default)]
    pub indexed: Option<bool>,
    /// `manual` or `network` in both; v3 also says `project`, and repeats it
    /// as `layer`.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub layer: Option<String>,
    /// v2 only: what the codemod needs to name a query's collection.
    #[serde(default)]
    pub target_collection: Option<String>,
    /// Only in the single-lexicon answer.
    #[serde(default)]
    pub lexicon_json: Option<Value>,
}

impl Lexicon {
    /// Fetched from the network, so the project names it rather than
    /// carrying a copy.
    pub fn is_network(&self) -> bool {
        self.layer.as_deref().or(self.source.as_deref()) == Some("network")
    }
}

/// A compiled module's handler (`catalog/scripts.rs`, `ModuleRow`); v3 only.
#[derive(Debug, Clone, Deserialize)]
pub struct ModuleRow {
    pub module: String,
    pub path: String,
    #[serde(default)]
    pub handler: String,
}

/// A row of `GET /admin/scripts` (`scripts.rs`, `ScriptResponse`).
#[derive(Debug, Clone, Deserialize)]
pub struct Script {
    /// The trigger, e.g. `xrpc.query:com.example.hello`.
    pub id: String,
    #[serde(default = "lua")]
    pub script_type: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub outbound_xrpcs: Option<Vec<String>>,
    /// v3: the project file, for a project script.
    #[serde(default)]
    pub path: Option<String>,
    /// v3: set for a compiled module's handler, which has no body.
    #[serde(default)]
    pub module: Option<ModuleRow>,
}

fn lua() -> String {
    "lua".into()
}

/// A row of `GET /admin/scripts/modules` (`scripts.rs`,
/// `ModuleSourceResponse`); v3, from the HappyView that added the route. An
/// interpreter module: a file under `src/` that scripts import.
#[derive(Debug, Clone, Deserialize)]
pub struct ModuleSource {
    pub id: String,
    /// Project-relative and `/`-separated.
    pub path: String,
    pub source: String,
}

/// `GET /admin/script-variables` (`ScriptVariableSummary`). Only the key is
/// read; the preview is a mask, and is ignored all the same.
#[derive(Debug, Clone, Deserialize)]
pub struct Variable {
    pub key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Secret {
    pub key: String,
}

/// `registry` on a v3 plugin (`PluginRegistryStatus`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PluginRegistry {
    #[serde(default)]
    pub did: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// `None` when the install is pinned to its version.
    #[serde(default)]
    pub channel: Option<String>,
}

/// A plugin of `GET /admin/plugins` (`PluginSummary`, under `plugins`).
#[derive(Debug, Clone, Deserialize)]
pub struct Plugin {
    pub id: String,
    #[serde(default)]
    pub version: String,
    /// `registry`, `url` or `file`.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub required_secrets: Vec<Secret>,
    /// v3 only.
    #[serde(default)]
    pub registry: Option<PluginRegistry>,
    #[serde(default)]
    pub plugin_type: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PluginList {
    #[serde(default)]
    pub plugins: Vec<Plugin>,
}

/// `GET /admin/settings` (`SettingEntry`).
#[derive(Debug, Clone, Deserialize)]
pub struct Setting {
    pub key: String,
    #[serde(default)]
    pub value: String,
}

/// `GET /admin/users` (`UserSummary`).
#[derive(Debug, Clone, Deserialize)]
pub struct User {
    pub did: String,
    #[serde(default)]
    pub is_super: bool,
}

/// `GET /admin/labelers` (`LabelerSummary`).
#[derive(Debug, Clone, Deserialize)]
pub struct Labeler {
    pub did: String,
    #[serde(default)]
    pub status: String,
}

/// `GET /admin/network-lexicons` (`NetworkLexiconSummary`).
#[derive(Debug, Clone, Deserialize)]
pub struct NetworkLexicon {
    pub nsid: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Shaped as v2's `get_lexicon` answers, field for field.
    #[test]
    fn reads_a_v2_lexicon() {
        let l: Lexicon = serde_json::from_value(json!({
            "id": "com.example.listPosts", "revision": 2,
            "lexicon_json": {"lexicon": 1, "id": "com.example.listPosts"},
            "lexicon_type": "query", "backfill": true, "action": null,
            "target_collection": "com.example.post", "source": "manual",
            "authority_did": null, "last_fetched_at": null,
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "token_cost": null
        }))
        .unwrap();
        assert!(l.backfill);
        assert_eq!(l.target_collection.as_deref(), Some("com.example.post"));
        assert!(!l.is_network());
        assert!(l.lexicon_json.is_some());
    }

    #[test]
    fn reads_a_v3_network_lexicon_by_its_layer() {
        let l: Lexicon = serde_json::from_value(json!({
            "id": "com.other.post", "revision": 1, "lexicon_type": "record",
            "backfill": false, "source": "network", "layer": "network", "path": null,
            "shadows_stored": false, "declared": true, "authority_did": "did:plc:o",
            "last_fetched_at": null, "created_at": null, "updated_at": null,
            "token_cost": null, "indexed": true
        }))
        .unwrap();
        assert!(l.is_network());
        assert_eq!(l.indexed, Some(true));
    }

    #[test]
    fn a_v3_module_row_has_no_body() {
        let s: Script = serde_json::from_value(json!({
            "id": "xrpc.query:com.example.score", "script_type": "rust", "body": "",
            "description": null, "outbound_xrpcs": null, "created_at": null,
            "updated_at": null, "layer": "project", "path": "modules/scoring",
            "shadows_stored": false, "recreatable": true, "needs_migration": [],
            "runnable": true,
            "module": {"module": "scoring", "path": "modules/scoring", "handler": "score", "hash": "ab"}
        }))
        .unwrap();
        assert_eq!(s.module.unwrap().module, "scoring");
    }
}
