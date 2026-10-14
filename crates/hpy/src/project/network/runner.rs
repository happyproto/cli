//! External commands (`deno`, `docker`) behind a trait, so the sandbox
//! driver is testable without either installed.
//!
//! Every child runs in a process group of its own with no stdin, so a
//! terminal's Ctrl-C reaches `hpy` alone. Atmosphere in a Box installs no
//! signal handler: a `deno` stopped mid-operation leaves `state/cli.lock`
//! behind, which refuses every later command until someone removes it. `hpy`
//! decides when each child is done instead.

use std::path::Path;

use async_trait::async_trait;

use crate::failure::Failure;

#[async_trait]
pub trait Runner: Send + Sync {
    /// Runs to completion with its output on this terminal; answers the exit code.
    async fn show(&self, program: &str, args: &[String], cwd: &Path) -> Result<Exit, Failure> {
        self.show_with_env(program, args, &[], cwd).await
    }
    /// As `show`, with `env` added to the child's environment.
    async fn show_with_env(
        &self,
        program: &str,
        args: &[String],
        env: &[(&str, &str)],
        cwd: &Path,
    ) -> Result<Exit, Failure>;
    /// As `show`, with the child's stdout sent to this process's stderr, for
    /// output that must stay off a stdout reserved for JSON.
    async fn show_on_stderr(
        &self,
        program: &str,
        args: &[String],
        cwd: &Path,
    ) -> Result<Exit, Failure>;
    /// Runs to completion and answers its stdout; a non-zero exit is a
    /// failure carrying its stderr.
    async fn capture(&self, program: &str, args: &[String], cwd: &Path) -> Result<String, Failure>;
}

/// How a shown child ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Exit {
    /// The exit code, or 128 plus the signal number for a child a signal
    /// ended, as a shell reports it.
    pub code: i32,
    /// The signal that ended the child, if one did. Kept apart from `code`
    /// because a child may also exit with a code above 128 of its own accord.
    pub signal: Option<i32>,
}

impl Exit {
    pub fn code(code: i32) -> Exit {
        Exit { code, signal: None }
    }

    fn from_status(status: std::process::ExitStatus) -> Exit {
        use std::os::unix::process::ExitStatusExt;
        match (status.code(), status.signal()) {
            (Some(code), _) => Exit::code(code),
            (None, Some(signal)) => Exit {
                code: 128 + signal,
                signal: Some(signal),
            },
            (None, None) => Exit::code(1),
        }
    }

    /// A failure naming the command for anything but a clean exit.
    pub fn check(self, program: &str, args: &[String]) -> Result<(), Failure> {
        let command = format!("`{program} {}`", args.join(" "));
        match self {
            Exit { code: 0, .. } => Ok(()),
            Exit {
                signal: Some(signal),
                ..
            } => Err(Failure::runtime(format!(
                "{command} was ended by signal {signal}"
            ))),
            Exit { code, .. } => Err(Failure::runtime(format!("{command} exited with {code}"))),
        }
    }
}

fn not_installed(program: &str) -> Failure {
    Failure::usage(format!("`{program}` is not installed or not on PATH"))
}

#[derive(Default)]
pub struct SystemRunner {
    /// Sends every `show` child's stdout to stderr, for a run whose stdout
    /// is reserved for one JSON document.
    pub stdout_to_stderr: bool,
}

#[async_trait]
impl Runner for SystemRunner {
    async fn show_with_env(
        &self,
        program: &str,
        args: &[String],
        env: &[(&str, &str)],
        cwd: &Path,
    ) -> Result<Exit, Failure> {
        spawn_and_wait(program, args, env, cwd, self.stdout_to_stderr).await
    }

    async fn show_on_stderr(
        &self,
        program: &str,
        args: &[String],
        cwd: &Path,
    ) -> Result<Exit, Failure> {
        spawn_and_wait(program, args, &[], cwd, true).await
    }

    async fn capture(&self, program: &str, args: &[String], cwd: &Path) -> Result<String, Failure> {
        let out = detached(program)
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

/// A command in its own process group, reading nothing: a background
/// group's read from the terminal would stop it with SIGTTIN.
fn detached(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.process_group(0).stdin(std::process::Stdio::null());
    cmd
}

// Not `run_foreground`: that replaces this process on unix, and the caller
// has more to do once the child is done.
async fn spawn_and_wait(
    program: &str,
    args: &[String],
    env: &[(&str, &str)],
    cwd: &Path,
    stdout_to_stderr: bool,
) -> Result<Exit, Failure> {
    if which(program).is_none() {
        return Err(not_installed(program));
    }
    let mut cmd = detached(program);
    cmd.args(args)
        .envs(env.iter().copied())
        .current_dir(cwd)
        .kill_on_drop(true);
    if stdout_to_stderr {
        cmd.stdout(std::io::stderr());
    }
    let mut child = cmd.spawn().map_err(|e| {
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
    Ok(Exit::from_status(status))
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

pub async fn must_with_env(
    r: &dyn Runner,
    program: &str,
    args: &[String],
    env: &[(&str, &str)],
    cwd: &Path,
) -> Result<(), Failure> {
    r.show_with_env(program, args, env, cwd)
        .await?
        .check(program, args)
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
        self.answer_with_env(program, args, &[])
    }

    /// Records the call as a shell line would read: any `env` first.
    fn answer_with_env(
        &self,
        program: &str,
        args: &[String],
        env: &[(&str, &str)],
    ) -> Result<String, String> {
        let line = env
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .chain(std::iter::once(program.to_string()))
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
    async fn show_with_env(
        &self,
        program: &str,
        args: &[String],
        env: &[(&str, &str)],
        _: &Path,
    ) -> Result<Exit, Failure> {
        Ok(Exit::code(
            if self.answer_with_env(program, args, env).is_ok() {
                0
            } else {
                1
            },
        ))
    }

    async fn show_on_stderr(
        &self,
        program: &str,
        args: &[String],
        cwd: &Path,
    ) -> Result<Exit, Failure> {
        self.show(program, args, cwd).await
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
        let out = SystemRunner::default()
            .capture("sh", &["-c".into(), "echo hi".into()], dir.path())
            .await
            .unwrap();
        assert_eq!(out, "hi\n");
        let err = SystemRunner::default()
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
        let err = SystemRunner::default()
            .capture("no-such-tool-hpy", &[], dir.path())
            .await
            .unwrap_err();
        assert!(format!("{:?}", err.report).contains("`no-such-tool-hpy` is not installed"));
        assert_eq!(err.code, 2);
    }

    #[tokio::test]
    async fn must_turns_a_non_zero_show_into_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let err = must_with_env(
            &SystemRunner::default(),
            "sh",
            &["-c".into(), "exit 5".into()],
            &[],
            dir.path(),
        )
        .await
        .unwrap_err();
        assert!(format!("{:?}", err.report).contains("`sh -c exit 5` exited with 5"));
    }

    /// A shell that succeeds only as the leader of its own process group,
    /// with nothing to read.
    const DETACHED: &str = r#"[ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ] && ! read -r line"#;

    #[tokio::test]
    async fn every_child_leads_its_own_group_and_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let script = format!(r#"{DETACHED} && [ "$HPY_RUNNER_TEST" = set ]"#);
        let code = SystemRunner::default()
            .show_with_env(
                "sh",
                &["-c".into(), script],
                &[("HPY_RUNNER_TEST", "set")],
                dir.path(),
            )
            .await
            .unwrap();
        assert_eq!(
            code,
            Exit::code(0),
            "a shown child shares hpy's group or its stdin"
        );
        SystemRunner::default()
            .capture("sh", &["-c".into(), DETACHED.into()], dir.path())
            .await
            .expect("a captured child shares hpy's group or its stdin");
    }

    #[tokio::test]
    async fn a_signal_death_is_reported_apart_from_an_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let run = |script: &str| {
            let args = vec!["-c".to_string(), script.to_string()];
            let dir = dir.path().to_path_buf();
            async move {
                SystemRunner::default()
                    .show("sh", &args, &dir)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(
            run("kill -TERM $$").await,
            Exit {
                code: 128 + libc::SIGTERM,
                signal: Some(libc::SIGTERM)
            }
        );
        // The same number from an ordinary exit is not a signal.
        assert_eq!(run("exit 143").await, Exit::code(143));
        let err = run("kill -TERM $$")
            .await
            .check("sh", &["-c".into()])
            .unwrap_err();
        assert!(
            err.report.to_string().contains("signal 15"),
            "{}",
            err.report
        );
    }
}
