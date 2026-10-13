//! External commands (`deno`, `docker`) behind a trait, so the sandbox
//! driver is testable without either installed.

use std::path::Path;

use async_trait::async_trait;

use crate::failure::Failure;

#[async_trait]
pub trait Runner: Send + Sync {
    /// Runs to completion with its output on this terminal; answers the exit code.
    async fn show(&self, program: &str, args: &[String], cwd: &Path) -> Result<i32, Failure>;
    /// Runs to completion and answers its stdout; a non-zero exit is a
    /// failure carrying its stderr.
    async fn capture(&self, program: &str, args: &[String], cwd: &Path) -> Result<String, Failure>;
}

fn not_installed(program: &str) -> Failure {
    Failure::usage(format!("`{program}` is not installed or not on PATH"))
}

pub struct SystemRunner;

#[async_trait]
impl Runner for SystemRunner {
    // Not `run_foreground`: that replaces this process on unix, and the
    // caller has more to do once the child is done.
    async fn show(&self, program: &str, args: &[String], cwd: &Path) -> Result<i32, Failure> {
        if which(program).is_none() {
            return Err(not_installed(program));
        }
        let mut child = tokio::process::Command::new(program)
            .args(args)
            .current_dir(cwd)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    not_installed(program)
                } else {
                    Failure::runtime(format!("could not run `{program}`: {e}"))
                }
            })?;
        let status = child
            .wait()
            .await
            .map_err(|e| Failure::runtime(format!("could not wait for `{program}`: {e}")))?;
        Ok(status.code().unwrap_or(1))
    }

    async fn capture(&self, program: &str, args: &[String], cwd: &Path) -> Result<String, Failure> {
        let out = tokio::process::Command::new(program)
            .args(args)
            .current_dir(cwd)
            .output()
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    not_installed(program)
                } else {
                    Failure::runtime(format!("could not run `{program}`: {e}"))
                }
            })?;
        if !out.status.success() {
            return Err(Failure::runtime(format!(
                "`{program} {}` failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// `program` on PATH, so a missing tool is a usage error naming it rather
/// than a spawn error from deep inside the spawn.
fn which(program: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    })
}

pub async fn must(
    r: &dyn Runner,
    program: &str,
    args: &[String],
    cwd: &Path,
) -> Result<(), Failure> {
    match r.show(program, args, cwd).await? {
        0 => Ok(()),
        code => Err(Failure::runtime(format!(
            "`{program} {}` exited with {code}",
            args.join(" ")
        ))),
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct FakeRunner {
    pub calls: std::sync::Mutex<Vec<String>>,
    pub answers: Vec<(String, Result<String, String>)>,
}

#[cfg(test)]
impl FakeRunner {
    pub fn answering(answers: &[(&str, Result<&str, &str>)]) -> FakeRunner {
        FakeRunner {
            calls: Default::default(),
            answers: answers
                .iter()
                .map(|(p, a)| (p.to_string(), a.map(str::to_string).map_err(str::to_string)))
                .collect(),
        }
    }

    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn answer(&self, program: &str, args: &[String]) -> Result<String, String> {
        let line = std::iter::once(program.to_string())
            .chain(args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
        self.calls.lock().unwrap().push(line.clone());
        self.answers
            .iter()
            .find(|(prefix, _)| line.starts_with(prefix.as_str()))
            .map(|(_, a)| a.clone())
            .unwrap_or_else(|| Ok(String::new()))
    }
}

#[cfg(test)]
#[async_trait]
impl Runner for FakeRunner {
    async fn show(&self, program: &str, args: &[String], _: &Path) -> Result<i32, Failure> {
        Ok(if self.answer(program, args).is_ok() {
            0
        } else {
            1
        })
    }

    async fn capture(&self, program: &str, args: &[String], _: &Path) -> Result<String, Failure> {
        self.answer(program, args).map_err(Failure::runtime)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn capture_answers_stdout_and_failures_carry_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let out = SystemRunner
            .capture("sh", &["-c".into(), "echo hi".into()], dir.path())
            .await
            .unwrap();
        assert_eq!(out, "hi\n");
        let err = SystemRunner
            .capture(
                "sh",
                &["-c".into(), "echo nope >&2; exit 4".into()],
                dir.path(),
            )
            .await
            .unwrap_err();
        assert!(format!("{:?}", err.report).contains("nope"));
    }

    #[tokio::test]
    async fn a_missing_program_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let err = SystemRunner
            .capture("no-such-tool-hpy", &[], dir.path())
            .await
            .unwrap_err();
        assert!(format!("{:?}", err.report).contains("`no-such-tool-hpy` is not installed"));
        assert_eq!(err.code, 2);
    }

    #[tokio::test]
    async fn must_turns_a_non_zero_show_into_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let err = must(
            &SystemRunner,
            "sh",
            &["-c".into(), "exit 5".into()],
            dir.path(),
        )
        .await
        .unwrap_err();
        assert!(format!("{:?}", err.report).contains("`sh -c exit 5` exited with 5"));
    }
}
