use std::path::PathBuf;

use serde_json::json;

use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::modules::{self, Toolchain};
use crate::project::prepare::project_root;

pub async fn run(ctx: &Ctx) -> Result<(), Failure> {
    let root = project_root(ctx)?;
    let built = build_modules(root.clone()).await?;
    if built.is_empty() {
        ctx.out.done(
            "no [modules] in happyview.toml; nothing to build",
            json!({ "modules": [] }),
        );
        return Ok(());
    }
    let lines: Vec<String> = built
        .iter()
        .map(|(name, path)| {
            let shown = path.strip_prefix(&root).unwrap_or(path);
            format!("built {name} → {}", shown.display())
        })
        .collect();
    let json_modules: Vec<_> = built
        .iter()
        .map(|(name, path)| json!({ "name": name, "path": path }))
        .collect();
    ctx.out
        .done(&lines.join("\n"), json!({ "modules": json_modules }));
    Ok(())
}

/// Every module in the project at `root`, built off the async runtime since
/// a build blocks for as long as cargo runs.
pub async fn build_modules(root: PathBuf) -> Result<Vec<(String, PathBuf)>, Failure> {
    tokio::task::spawn_blocking(move || modules::build_all(&Toolchain::from_env(), &root))
        .await
        .map_err(Failure::runtime)?
}
