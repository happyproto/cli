//! The sandbox's lifecycle, through the CLI Atmosphere in a Box documents.

use std::path::PathBuf;

use crate::failure::Failure;
use crate::project::network::app::APP_ID;
use crate::project::network::runner::{Runner, must};

pub struct Sandbox<'a> {
    pub runner: &'a dyn Runner,
    pub checkout: PathBuf,
    pub project: String,
}

impl Sandbox<'_> {
    fn args(rest: &[&str]) -> Vec<String> {
        ["task", "sandbox"]
            .iter()
            .chain(rest)
            .map(|s| s.to_string())
            .collect()
    }

    async fn task(&self, rest: &[&str]) -> Result<(), Failure> {
        must(self.runner, "deno", &Self::args(rest), &self.checkout).await
    }

    pub fn created(&self) -> bool {
        self.checkout.join("state/manifest.json").is_file()
    }

    /// Whether the sandbox's own record of selected applications names
    /// HappyView. An unreadable manifest reads as "not applied", which only
    /// costs a redundant `apply`.
    pub fn applied(&self) -> bool {
        std::fs::read_to_string(self.checkout.join("state/manifest.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|manifest| {
                manifest
                    .get("applications")
                    .and_then(|a| a.as_array())
                    .map(|apps| apps.iter().any(|a| a.as_str() == Some(APP_ID)))
            })
            .unwrap_or(false)
    }

    /// An interrupted `create` or `apply` leaves one of these behind, and the
    /// sandbox refuses everything else until `resume` has finished it.
    pub fn pending(&self) -> bool {
        ["pending-create.json", "pending-apply.json"]
            .iter()
            .any(|f| self.checkout.join("state").join(f).is_file())
    }

    pub async fn resume(&self) -> Result<(), Failure> {
        self.task(&["resume"]).await
    }

    pub async fn create(&self) -> Result<(), Failure> {
        self.task(&[
            "create",
            "--pds",
            "1",
            "--users-per-pds",
            "1",
            "--project",
            &self.project,
            "--preset",
            "full-stack",
        ])
        .await?;
        self.task(&["apply", "--app", APP_ID]).await
    }

    pub async fn sync(&self, changed: bool) -> Result<(), Failure> {
        if !self.applied() {
            return self.task(&["apply", "--app", APP_ID]).await;
        }
        if changed {
            self.task(&["apply", "--component", APP_ID]).await?;
        }
        Ok(())
    }

    pub async fn up(&self) -> Result<(), Failure> {
        self.task(&["check"]).await?;
        // The first start pulls every full-stack image; the CLI's 120 s default is too short for that.
        self.task(&["up", "--build", "--wait-timeout", "600"]).await
    }

    pub async fn seed(&self) -> Result<(), Failure> {
        self.task(&["seed"]).await
    }

    pub async fn down(&self) -> Result<(), Failure> {
        self.task(&["down"]).await
    }

    pub async fn destroy(&self) -> Result<(), Failure> {
        self.task(&["destroy", "--accept-destructive"]).await
    }

    pub async fn access_start(&self) -> Result<(), Failure> {
        self.task(&["access", "start"]).await
    }

    pub async fn access_stop(&self) -> Result<(), Failure> {
        self.task(&["access", "stop"]).await
    }

    pub async fn hosts_block(&self) -> Result<String, Failure> {
        self.runner
            .capture("deno", &Self::args(&["access", "hosts"]), &self.checkout)
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::project::network::runner::FakeRunner;

    fn sandbox<'a>(runner: &'a FakeRunner, dir: &Path) -> Sandbox<'a> {
        Sandbox {
            runner,
            checkout: dir.to_path_buf(),
            project: "hv-app-1234abcd".into(),
        }
    }

    fn write_manifest(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir.join("state")).unwrap();
        std::fs::write(dir.join("state/manifest.json"), body).unwrap();
    }

    #[tokio::test]
    async fn a_new_sandbox_is_created_with_the_full_stack_then_happyview() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let s = sandbox(&runner, dir.path());
        assert!(!s.created());
        s.create().await.unwrap();
        assert_eq!(
            runner.calls(),
            [
                "deno task sandbox create --pds 1 --users-per-pds 1 --project hv-app-1234abcd --preset full-stack",
                "deno task sandbox apply --app happyview",
            ]
        );
        // The fake runs nothing, so stand in for what the real `apply` records.
        write_manifest(dir.path(), r#"{"applications":["happyview"]}"#);
        runner.calls.lock().unwrap().clear();
        s.sync(false).await.unwrap();
        assert!(runner.calls().is_empty());
        s.sync(true).await.unwrap();
        assert_eq!(
            runner.calls(),
            ["deno task sandbox apply --component happyview"]
        );
    }

    #[tokio::test]
    async fn an_existing_sandbox_without_happyview_gets_it_applied() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), r#"{"applications":[]}"#);
        let runner = FakeRunner::default();
        let s = sandbox(&runner, dir.path());
        assert!(s.created());
        assert!(!s.applied());
        s.sync(true).await.unwrap();
        assert_eq!(runner.calls(), ["deno task sandbox apply --app happyview"]);
    }

    #[tokio::test]
    async fn a_manifest_without_applications_reads_as_not_applied() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), "{}");
        let runner = FakeRunner::default();
        assert!(!sandbox(&runner, dir.path()).applied());
    }

    #[tokio::test]
    async fn an_interrupted_create_or_apply_is_pending_and_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let s = sandbox(&runner, dir.path());
        assert!(!s.pending());
        for file in ["pending-create.json", "pending-apply.json"] {
            std::fs::create_dir_all(dir.path().join("state")).unwrap();
            std::fs::write(dir.path().join("state").join(file), "{}").unwrap();
            assert!(s.pending(), "{file}");
            std::fs::remove_file(dir.path().join("state").join(file)).unwrap();
            assert!(!s.pending());
        }
        s.resume().await.unwrap();
        assert_eq!(runner.calls(), ["deno task sandbox resume"]);
    }

    #[tokio::test]
    async fn up_checks_first_and_waits_long_enough_for_a_cold_start() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        sandbox(&runner, dir.path()).up().await.unwrap();
        assert_eq!(
            runner.calls(),
            [
                "deno task sandbox check",
                "deno task sandbox up --build --wait-timeout 600"
            ]
        );
    }

    #[tokio::test]
    async fn a_failed_step_names_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::answering(&[("deno task sandbox check", Err("bad"))]);
        let err = sandbox(&runner, dir.path()).up().await.unwrap_err();
        assert!(format!("{:?}", err.report).contains("deno task sandbox check"));
        assert_eq!(runner.calls().len(), 1);
    }
}
