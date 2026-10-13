//! The HappyView binary as a foreground child: its output goes straight to
//! this terminal, signals meant for `hpy` reach it, and its exit code becomes
//! `hpy`'s.

use std::ffi::OsString;
use std::path::Path;
use std::process::{ExitStatus, Stdio};

use crate::failure::Failure;

pub async fn run_foreground(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &[(String, String)],
) -> Result<i32, Failure> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| Failure::runtime(format!("could not start {}: {e}", program.display())))?;
    let status = wait_forwarding(&mut child).await?;
    Ok(exit_code(status))
}

#[cfg(unix)]
async fn wait_forwarding(child: &mut tokio::process::Child) -> Result<ExitStatus, Failure> {
    use std::io::IsTerminal;
    use tokio::signal::unix::{SignalKind, signal};

    let pid = child.id().map(|p| p as libc::pid_t);
    let forward = |sig: libc::c_int| {
        if let Some(pid) = pid {
            // SAFETY: kill(2) with a pid we spawned and a valid signal number.
            unsafe { libc::kill(pid, sig) };
        }
    };
    let mut term = signal(SignalKind::terminate()).map_err(Failure::runtime)?;
    let mut hup = signal(SignalKind::hangup()).map_err(Failure::runtime)?;
    let mut int = signal(SignalKind::interrupt()).map_err(Failure::runtime)?;
    // A terminal delivers Ctrl-C to the whole foreground process group, so the
    // child already has it; a second copy reads as "stop now" to most servers.
    // Without a terminal the SIGINT was aimed at hpy alone, so it is passed on.
    let from_terminal = std::io::stdin().is_terminal();
    loop {
        tokio::select! {
            status = child.wait() => return status.map_err(Failure::runtime),
            _ = term.recv() => forward(libc::SIGTERM),
            _ = hup.recv() => forward(libc::SIGHUP),
            _ = int.recv() => if !from_terminal { forward(libc::SIGINT) },
        }
    }
}

#[cfg(not(unix))]
async fn wait_forwarding(child: &mut tokio::process::Child) -> Result<ExitStatus, Failure> {
    // The console sends Ctrl-C to every process attached to it; hpy only has
    // to outlive the child to report its code.
    loop {
        tokio::select! {
            status = child.wait() => return status.map_err(Failure::runtime),
            _ = tokio::signal::ctrl_c() => {}
        }
    }
}

pub fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
    }
    1
}

pub fn finish(code: i32) -> Result<(), Failure> {
    match code {
        0 => Ok(()),
        c => Err(Failure::exit(u8::try_from(c).unwrap_or(1))),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("happyview");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn passes_args_cwd_env_and_the_exit_code_through() {
        let dir = tempfile::tempdir().unwrap();
        let bin = script(
            dir.path(),
            "echo \"$PWD|$*|$HV_FLAVOUR\" > \"$HV_OUT\"; exit 3",
        );
        let out = dir.path().join("out");
        let code = run_foreground(
            &bin,
            &["check".into(), ".".into()],
            dir.path(),
            &[
                ("HV_OUT".into(), out.display().to_string()),
                ("HV_FLAVOUR".into(), "dev".into()),
            ],
        )
        .await
        .unwrap();
        assert_eq!(code, 3);
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&out).unwrap().trim(),
            format!("{}|check .|dev", canonical.display())
        );
    }

    #[tokio::test]
    async fn a_child_killed_by_a_signal_exits_128_plus_it() {
        let dir = tempfile::tempdir().unwrap();
        let bin = script(dir.path(), "kill -TERM $$");
        assert_eq!(
            run_foreground(&bin, &[], dir.path(), &[]).await.unwrap(),
            143
        );
    }

    #[tokio::test]
    async fn a_missing_binary_says_which() {
        let dir = tempfile::tempdir().unwrap();
        let err = run_foreground(&dir.path().join("nope"), &[], dir.path(), &[])
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
