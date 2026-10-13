//! The HappyView binary in the foreground: its output goes straight to this
//! terminal, signals meant for `hpy` reach it, and its exit code becomes
//! `hpy`'s.

use std::ffi::OsString;
use std::path::Path;

use crate::failure::Failure;

/// On unix this replaces `hpy` with the binary and returns only if that
/// fails. The process then *is* HappyView, so the kernel delivers every
/// signal and reports the exit status exactly as it would had HappyView been
/// started by hand, and there is no parent left to die and orphan it. Nothing
/// `hpy` would have done after the child exits runs.
#[cfg(unix)]
pub async fn run_foreground(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &[(String, String)],
    remove_env: &[&str],
) -> Result<i32, Failure> {
    use std::os::unix::process::CommandExt;

    let mut cmd = std::process::Command::new(program);
    for key in remove_env {
        cmd.env_remove(key);
    }
    cmd.args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    let e = cmd.exec();
    Err(could_not_start(program, e))
}

/// Windows has no `exec`, so `hpy` waits for the child. The console sends
/// Ctrl-C to every process attached to it; `hpy` only has to outlive the
/// child to report its code.
#[cfg(not(unix))]
pub async fn run_foreground(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &[(String, String)],
    remove_env: &[&str],
) -> Result<i32, Failure> {
    let mut cmd = tokio::process::Command::new(program);
    for key in remove_env {
        cmd.env_remove(key);
    }
    cmd.args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| could_not_start(program, e))?;
    loop {
        tokio::select! {
            status = child.wait() => return Ok(exit_code(status.map_err(Failure::runtime)?)),
            _ = tokio::signal::ctrl_c() => {}
        }
    }
}

fn could_not_start(program: &Path, e: std::io::Error) -> Failure {
    Failure::runtime(format!("could not start {}: {e}", program.display()))
}

#[cfg(not(unix))]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

pub fn finish(code: i32) -> Result<(), Failure> {
    match code {
        0 => Ok(()),
        c => Err(Failure::exit(u8::try_from(c).unwrap_or(1))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The rest of this path ends in `exec`, which would replace the test
    // process; `tests/happyview.rs` drives it through the binary instead.
    #[tokio::test]
    async fn a_missing_binary_says_which() {
        let dir = tempfile::tempdir().unwrap();
        let err = run_foreground(&dir.path().join("nope"), &[], dir.path(), &[], &[])
            .await
            .unwrap_err();
        assert!(format!("{:?}", err.report).contains("could not start"));
    }

    #[test]
    fn finish_maps_codes() {
        assert!(finish(0).is_ok());
        assert_eq!(finish(4).unwrap_err().code, 4);
        assert_eq!(finish(300).unwrap_err().code, 1);
    }
}
