//! A v2 script through `happyview-codemod --stdin`, as `src/bin/codemod.rs`
//! on HappyView's alpha documents it: the rewrite on stdout, notes on
//! stderr, and exit 0 when clean, 2 when it left `-- codemod:` markers, 1 on
//! an error.

use std::path::Path;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;

use super::map::{Kind, has_codemod_marker};
use crate::failure::Failure;

#[derive(Debug, Clone, PartialEq)]
pub enum Rewrite {
    /// Rewritten with nothing left to do.
    Clean(String),
    /// Rewritten, with markers where a person has to finish it.
    Marked(String),
    /// Refused; the v2 source is kept, and this is why.
    Failed(String),
}

pub async fn rewrite(
    codemod: &Path,
    body: &str,
    kind: Kind,
    collection: Option<&str>,
) -> Result<Rewrite, Failure> {
    let mut cmd = tokio::process::Command::new(codemod);
    cmd.args(["--stdin", "--kind", kind.as_str()]);
    if let Some(collection) = collection {
        cmd.args(["--collection", collection]);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Failure::runtime(format!("could not run {}: {e}", codemod.display())))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = body.to_string();
    // Written beside the wait, so a large script cannot fill the pipe while
    // nothing reads the output.
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(input.as_bytes()).await;
        drop(stdin);
    });
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| Failure::runtime(format!("running {}: {e}", codemod.display())))?;
    let _ = writer.await;
    let source = String::from_utf8_lossy(&out.stdout).into_owned();
    let notes = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Ok(match out.status.code() {
        Some(0) if has_codemod_marker(&source) => Rewrite::Marked(source),
        Some(0) => Rewrite::Clean(source),
        Some(2) => Rewrite::Marked(source),
        _ if notes.is_empty() => Rewrite::Failed(format!("it exited with {}", out.status)),
        _ => Rewrite::Failed(notes),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn script(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("codemod");
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn passes_kind_and_collection_and_reads_each_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let echo = script(dir.path(), "echo \"$*\"; cat\n");
        assert_eq!(
            rewrite(&echo, "body\n", Kind::Query, Some("com.example.post"))
                .await
                .unwrap(),
            Rewrite::Clean("--stdin --kind query --collection com.example.post\nbody\n".into())
        );
        let marked = script(dir.path(), "cat; echo '-- codemod: fix me'; exit 2\n");
        assert!(matches!(
            rewrite(&marked, "x\n", Kind::Job, None).await.unwrap(),
            Rewrite::Marked(s) if s.contains("-- codemod: fix me")
        ));
        let broken = script(dir.path(), "echo 'cannot parse' >&2; exit 1\n");
        assert_eq!(
            rewrite(&broken, "x", Kind::Label, None).await.unwrap(),
            Rewrite::Failed("cannot parse".into())
        );
    }
}
