//! The HappyView binary in the foreground: its output goes straight to this
//! terminal, signals meant for `hpy` reach it, and its exit code becomes
//! `hpy`'s.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::failure::Failure;
use crate::project::modules::{self, ModuleSpec, Toolchain};
use crate::project::prepare::REMOVED_ENV;

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

/// Runs the binary as a child that `hpy` waits for, for a run where `hpy`
/// has work of its own to do while the binary runs and so cannot `exec`.
/// It stays in `hpy`'s process group, so a terminal's Ctrl-C and Ctrl-\
/// reach it directly and are not passed on a second time; a SIGTERM or
/// SIGHUP is passed on once. A handler cannot tell a signal sent to `hpy`
/// alone from one sent to its whole group, so a SIGTERM or SIGHUP sent to
/// the group, as a closing terminal's hangup is, reaches the binary twice.
/// The exit code is the child's, or 128 plus the signal that ended it, as a
/// shell reports it.
#[cfg(unix)]
pub async fn run_supervised(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &[(String, String)],
    remove_env: &[&str],
) -> Result<i32, Failure> {
    use tokio::signal::unix::{SignalKind, signal};

    // Installed before the child exists, so no signal can arrive while `hpy`
    // still has the default action of dying and leaving the child behind.
    let mut term = signal(SignalKind::terminate()).map_err(Failure::runtime)?;
    let mut hup = signal(SignalKind::hangup()).map_err(Failure::runtime)?;
    let mut int = signal(SignalKind::interrupt()).map_err(Failure::runtime)?;
    let mut quit = signal(SignalKind::quit()).map_err(Failure::runtime)?;

    let mut cmd = tokio::process::Command::new(program);
    for key in remove_env {
        cmd.env_remove(key);
    }
    cmd.args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .kill_on_drop(true);
    // Covers an `hpy` that dies without unwinding, which `kill_on_drop` does
    // not. The kernel fires it when the thread that forked exits, and the
    // fork happens on whichever runtime thread polls this future, which
    // lives as long as `hpy`. Called inside `spawn_blocking` it would fork on
    // a pool thread that exits once idle, killing the binary with it. macOS
    // has no equivalent, so there any signal `hpy` does not handle (SIGKILL,
    // but also SIGUSR1 or SIGALRM) ends `hpy` and leaves the binary running.
    #[cfg(target_os = "linux")]
    {
        let parent = std::process::id();
        // SAFETY: the closure makes only async-signal-safe calls.
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                // A parent that died before the call above went unnoticed.
                if libc::getppid() as u32 != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn().map_err(|e| could_not_start(program, e))?;
    let pid = child
        .id()
        .ok_or_else(|| Failure::runtime("the binary exited before it could be watched"))?;
    let forward = |sig: libc::c_int| {
        // SAFETY: kill(2) on a child not yet reaped, whose pid therefore
        // still names it.
        unsafe { libc::kill(pid as libc::pid_t, sig) };
    };
    loop {
        tokio::select! {
            status = child.wait() => return Ok(exit_code(status.map_err(Failure::runtime)?)),
            _ = term.recv() => forward(libc::SIGTERM),
            _ = hup.recv() => forward(libc::SIGHUP),
            _ = int.recv() => {}
            _ = quit.recv() => {}
        }
    }
}

/// Windows already waits for the child, and the console reaches it directly.
#[cfg(not(unix))]
pub async fn run_supervised(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &[(String, String)],
    remove_env: &[&str],
) -> Result<i32, Failure> {
    run_foreground(program, args, cwd, envs, remove_env).await
}

/// Runs the binary while rebuilding each of `specs` whenever its source
/// changes, and answers the binary's exit code. Without modules there is
/// nothing to watch, and the binary replaces `hpy` as `run_foreground` does.
pub async fn run_rebuilding_modules(
    binary: &Path,
    args: &[OsString],
    root: &Path,
    specs: Vec<ModuleSpec>,
) -> Result<i32, Failure> {
    let Some(watcher) = ModuleWatcher::spawn(root, specs) else {
        return run_foreground(binary, args, root, &[], REMOVED_ENV).await;
    };
    let exit = run_supervised(binary, args, root, &[], REMOVED_ENV).await;
    watcher.stop().await;
    exit
}

/// Rebuilds a project's modules as their sources change, on a thread of its
/// own, until stopped.
pub struct ModuleWatcher {
    stop: Arc<AtomicBool>,
    thread: tokio::task::JoinHandle<()>,
}

impl ModuleWatcher {
    /// `None` when there are no modules to watch.
    pub fn spawn(root: &Path, specs: Vec<ModuleSpec>) -> Option<ModuleWatcher> {
        if specs.is_empty() {
            return None;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (stop, root) = (stop.clone(), PathBuf::from(root));
            tokio::task::spawn_blocking(move || {
                modules::watch(
                    &Toolchain::from_env(),
                    &root,
                    &specs,
                    Duration::from_millis(300),
                    &stop,
                    &mut |module, result| match result {
                        Ok(_) => eprintln!("rebuilt module '{}'", module.name),
                        Err(f) => eprintln!(
                            "{:?}\nmodule '{}' failed to build; the previous build keeps serving",
                            f.report, module.name
                        ),
                    },
                )
            })
        };
        Some(ModuleWatcher { stop, thread })
    }

    /// Ends the watch, stopping a rebuild under way rather than waiting it
    /// out.
    pub async fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.thread.await;
    }
}

/// Builds every module in `specs` once, reporting each failure without
/// stopping: HappyView names a module that has no build, and a watcher
/// retries it on the next save.
pub async fn first_build(root: &Path, specs: &[ModuleSpec]) -> Result<(), Failure> {
    let (root, specs) = (PathBuf::from(root), specs.to_vec());
    tokio::task::spawn_blocking(move || {
        let toolchain = Toolchain::from_env();
        for module in &specs {
            if let Err(f) = modules::build_module(&toolchain, &root, module) {
                eprintln!("{:?}", f.report);
            }
        }
    })
    .await
    .map_err(Failure::runtime)
}

fn could_not_start(program: &Path, e: std::io::Error) -> Failure {
    Failure::runtime(format!("could not start {}: {e}", program.display()))
}

#[cfg(not(unix))]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

#[cfg(unix)]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .or_else(|| status.signal().map(|s| 128 + s))
        .unwrap_or(1)
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
