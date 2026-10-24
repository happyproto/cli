//! The editor settings that point a language server at the declarations
//! HappyView writes under `.happyview/types/`: `tsconfig.json` for TypeScript
//! and JavaScript, `.luarc.json` for LuaLS.
//!
//! A file the project already has is never rewritten. It may hold settings
//! of the author's own, so instead of editing it hpy says what to add when it
//! does not already name the types directory.

use std::path::Path;

use serde_json::{Value, json};

const TYPES_DIR: &str = ".happyview/types";

/// The language ids of the interpreters placed in the project, sorted, as
/// their manifests name them.
pub fn languages(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root.join(".happyview").join("plugins")) else {
        return Vec::new();
    };
    let mut found: Vec<String> = entries
        .flatten()
        .filter_map(|entry| std::fs::read(entry.path().join("manifest.json")).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|manifest| manifest["plugin_type"] == "interpreter")
        .filter_map(|manifest| manifest["language_id"].as_str().map(str::to_string))
        .collect();
    found.sort();
    found.dedup();
    found
}

/// One settings file a language server reads.
struct Settings {
    name: &'static str,
    /// The directory it has to name, which is how an existing one is judged.
    types: String,
    /// Where in an existing file the directory goes, for the line saying so.
    place: &'static str,
    config: Value,
}

fn settings(languages: &[String]) -> Vec<Settings> {
    let has = |id: &str| languages.iter().any(|l| l == id);
    let mut out = Vec::new();

    // Both front ends render the same modules, and a program that included
    // both directories would declare each twice.
    let script = if has("typescript") {
        Some("typescript")
    } else if has("javascript") {
        Some("javascript")
    } else {
        None
    };
    if let Some(dir) = script {
        let types = format!("{TYPES_DIR}/{dir}");
        out.push(Settings {
            name: "tsconfig.json",
            place: "its include",
            config: json!({
                "compilerOptions": {
                    "strict": true,
                    "noEmit": true,
                    "target": "es2022",
                    "module": "es2022",
                    "moduleResolution": "bundler",
                    "lib": ["es2022"],
                    "types": [],
                    "allowJs": true,
                    "checkJs": has("javascript"),
                },
                "include": ["src", types],
            }),
            types,
        });
    }

    if has("lua") {
        let types = format!("{TYPES_DIR}/lua");
        out.push(Settings {
            name: ".luarc.json",
            place: "its workspace.library",
            config: json!({
                "$schema": "https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json",
                "runtime.version": "Lua 5.4",
                "workspace.library": [types],
                "workspace.ignoreDir": [".happyview"],
                // What a handler defines and what a test file is given;
                // HappyView calls the first and supplies the rest.
                "diagnostics.globals": [
                    "handle", "describe", "it", "pending", "before_each", "after_each", "test"
                ],
            }),
            types,
        });
    }
    out
}

fn text(config: &Value) -> String {
    let mut text = serde_json::to_string_pretty(config).unwrap_or_default();
    text.push('\n');
    text
}

/// The settings files a new project with `languages` starts with.
pub fn editor_files(languages: &[String]) -> Vec<(std::path::PathBuf, String)> {
    settings(languages)
        .into_iter()
        .map(|s| (s.name.into(), text(&s.config)))
        .collect()
}

/// Write whichever settings files `languages` need and the project lacks.
/// Answers a line for each file written and each existing one that does not
/// name its types directory.
pub fn write_editor_config(root: &Path, languages: &[String]) -> std::io::Result<Vec<String>> {
    let mut lines = Vec::new();
    for s in settings(languages) {
        let path = root.join(s.name);
        match std::fs::read_to_string(&path) {
            Ok(existing) if existing.contains(&s.types) => {}
            Ok(_) => lines.push(format!(
                "{} does not name {}; add it to {} for editor types",
                s.name, s.types, s.place
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::write(&path, text(&s.config))?;
                lines.push(format!(
                    "wrote {}, which points editors at {}",
                    s.name, s.types
                ));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn langs(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn each_language_gets_its_settings_once() {
        let dir = tempfile::tempdir().unwrap();
        let lines = write_editor_config(dir.path(), &langs(&["lua", "typescript"])).unwrap();
        assert_eq!(
            lines,
            [
                "wrote tsconfig.json, which points editors at .happyview/types/typescript",
                "wrote .luarc.json, which points editors at .happyview/types/lua",
            ]
        );
        let ts: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("tsconfig.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(ts["include"], json!(["src", ".happyview/types/typescript"]));
        assert_eq!(ts["compilerOptions"]["checkJs"], false);
        let lua: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".luarc.json")).unwrap())
                .unwrap();
        assert_eq!(lua["workspace.library"], json!([".happyview/types/lua"]));

        // A second run finds both naming their directory and says nothing.
        assert!(
            write_editor_config(dir.path(), &langs(&["lua", "typescript"]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn javascript_alone_checks_javascript() {
        let dir = tempfile::tempdir().unwrap();
        write_editor_config(dir.path(), &langs(&["javascript"])).unwrap();
        let ts: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("tsconfig.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(ts["include"], json!(["src", ".happyview/types/javascript"]));
        assert_eq!(ts["compilerOptions"]["checkJs"], true);
        assert!(!dir.path().join(".luarc.json").exists());
    }

    #[test]
    fn an_existing_file_is_left_alone_and_named() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("tsconfig.json"),
            "{\"include\": [\"lib\"]}\n",
        )
        .unwrap();
        let lines = write_editor_config(dir.path(), &langs(&["typescript"])).unwrap();
        assert_eq!(
            lines,
            [
                "tsconfig.json does not name .happyview/types/typescript; add it to its include for editor types"
            ]
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tsconfig.json")).unwrap(),
            "{\"include\": [\"lib\"]}\n"
        );
    }

    #[test]
    fn a_new_project_starts_with_the_same_files() {
        let files = editor_files(&langs(&["lua"]));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, std::path::PathBuf::from(".luarc.json"));
        assert!(
            files[0].1.contains(".happyview/types/lua"),
            "{}",
            files[0].1
        );
    }

    #[test]
    fn no_interpreter_means_no_settings() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_editor_config(dir.path(), &[]).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn languages_come_from_the_placed_interpreters() {
        let dir = tempfile::tempdir().unwrap();
        for (id, manifest) in [
            (
                "lua",
                json!({"plugin_type": "interpreter", "language_id": "lua"}),
            ),
            (
                "db",
                json!({"plugin_type": "library", "namespace": "happyview.db"}),
            ),
            (
                "ts",
                json!({"plugin_type": "interpreter", "language_id": "typescript"}),
            ),
        ] {
            let plugin = dir.path().join(".happyview/plugins").join(id);
            std::fs::create_dir_all(&plugin).unwrap();
            std::fs::write(plugin.join("manifest.json"), manifest.to_string()).unwrap();
        }
        assert_eq!(languages(dir.path()), ["lua", "typescript"]);
        assert!(languages(&dir.path().join("missing")).is_empty());
    }
}
