//! `dev --network local`: the project's HappyView inside a private atproto
//! network, with its logs in the foreground.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Waker};
use std::time::Duration;

use hpy_project::config::{CONFIG_FILE, ProjectToml, find_root};
use hpy_project::place::PlaceMode;
use serde_json::json;
use tokio::signal::unix::{Signal, SignalKind, signal};

use crate::cli::DevArgs;
use crate::ctx::Ctx;
use crate::failure::Failure;
use crate::project::binary::http_client;
use crate::project::modules::{self, Snapshot};
use crate::project::network::access::{ensure_access, record_path};
use crate::project::network::accounts::{SeededAccount, accounts_path, seeded_superadmin};
use crate::project::network::app::{
    APP_ID, AppConfig, BACKFILL_ON_LOCAL, LOCAL_DB_DIR, PUBLIC_URL, write_app,
};
use crate::project::network::atmosbox::{
    NetworkDir, PINNED, check_tools, data_root, fetch_checkout, install_checkout, network_dir,
};
use crate::project::network::runner::{Runner, SystemRunner};
use crate::project::network::sandbox::Sandbox;
use crate::project::prepare::{PrepareOptions, prepare};
use crate::project::run::{ModuleWatcher, finish, first_build_until};

/// Where the sandbox's access relay listens. Only one process on this
/// computer can hold it.
const ACCESS_ADDR: &str = "127.0.0.1:443";
/// Replaces `ACCESS_ADDR` for the free-port probe only, so tests need not
/// depend on what holds 443 on the machine running them. The relay still
/// listens on `ACCESS_ADDR`; this changes nothing but the address probed.
const ACCESS_ADDR_ENV: &str = "HPY_NETWORK_ACCESS_ADDR";
/// The file in a network directory naming the project it belongs to.
const PROJECT_FILE: &str = "project";

pub fn linux_target(docker_arch: &str) -> Result<String, Failure> {
    match docker_arch.trim() {
        "x86_64" | "amd64" => Ok("x86_64-unknown-linux-musl".into()),
        "aarch64" | "arm64" => Ok("aarch64-unknown-linux-musl".into()),
        other => Err(Failure::usage(format!(
            "HappyView publishes no Linux binary for Docker's `{other}` architecture"
        ))),
    }
}

/// `accounts` is where the password is kept; `access_record` is the file
/// whose removal repeats the one-time setup.
pub fn banner(
    account: &SeededAccount,
    interactive: bool,
    accounts: &Path,
    access_record: &Path,
) -> String {
    let password = if interactive {
        format!("password {}", account.password)
    } else {
        format!("password in {}", accounts.display())
    };
    format!(
        "local network ready: {PUBLIC_URL}\n  sign in as {} ({password}); that account is the superadmin\n  \
         a certificate error in the browser? delete {} and run this again to repeat the one-time setup\n  \
         writes stay on this computer; Ctrl-C stops the network and keeps its data",
        account.handle,
        access_record.display()
    )
}

/// The seeded password is a throwaway, but it still reaches only a person at
/// a terminal: never a log, a pipe, or a `--json` consumer.
pub fn shows_password(interactive: bool, json: bool) -> bool {
    interactive && !json
}

/// `docker inspect` of the HappyView container once its logs end: still
/// running means the developer stopped following them, so `hpy` exits 0;
/// stopped means HappyView exited, and its code is passed on.
pub fn exit_from_inspect(out: &str) -> i32 {
    let mut parts = out.split_whitespace();
    match (parts.next(), parts.next().and_then(|c| c.parse().ok())) {
        (Some("true"), _) => 0,
        (Some("false"), Some(code)) => code,
        _ => 1,
    }
}

/// Creates the network directory if it is new, recording which project it
/// belongs to. A new one is also when a moved or renamed project shows up, so
/// it answers a line for every network whose project no longer exists.
/// Nothing is deleted: those networks hold the only copy of their data.
pub fn claim_network_dir(net: &NetworkDir, project_root: &Path) -> Result<Vec<String>, Failure> {
    let canonical = std::fs::canonicalize(project_root).map_err(Failure::runtime)?;
    let record = |dir: &Path| {
        std::fs::write(
            dir.join(PROJECT_FILE),
            canonical.to_string_lossy().as_bytes(),
        )
        .map_err(Failure::runtime)
    };
    if net.dir.exists() {
        if !net.dir.join(PROJECT_FILE).is_file() {
            record(&net.dir)?;
        }
        return Ok(Vec::new());
    }
    std::fs::create_dir_all(&net.dir).map_err(Failure::runtime)?;
    record(&net.dir)?;
    let Some(networks) = net.dir.parent() else {
        return Ok(Vec::new());
    };
    let mut lines = Vec::new();
    let mut others: Vec<PathBuf> = std::fs::read_dir(networks)
        .map_err(Failure::runtime)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| *p != net.dir)
        .collect();
    others.sort();
    for dir in others {
        let Ok(old) = std::fs::read_to_string(dir.join(PROJECT_FILE)) else {
            continue;
        };
        if !Path::new(&old).exists() {
            lines.push(format!(
                "a local network for {old}, which no longer exists, is at {}; remove it with \
                 `deno task sandbox destroy --accept-destructive` in {}",
                dir.display(),
                dir.join(PINNED.top).display()
            ));
        }
    }
    Ok(lines)
}

/// The host's uid and gid, which the container runs HappyView as so the files
/// it writes into the project belong to the developer.
fn host_ids() -> (u32, u32) {
    // SAFETY: getuid and getgid have no preconditions and cannot fail.
    unsafe { (libc::getuid(), libc::getgid()) }
}

/// Ctrl-C, caught so `hpy` decides when the run stops. Every child runs in a
/// process group of its own (see `runner`), so the terminal's Ctrl-C reaches
/// `hpy` alone: a sandbox command is never cut off part way, which would leave
/// the sandbox locked, and `hpy` stops the network once the step in progress
/// has finished.
struct Interrupt {
    signal: Signal,
    seen: bool,
}

impl Interrupt {
    fn install() -> Result<Interrupt, Failure> {
        let signal = signal(SignalKind::interrupt())
            .map_err(|e| Failure::runtime(format!("could not handle Ctrl-C: {e}")))?;
        Ok(Interrupt {
            signal,
            seen: false,
        })
    }

    async fn recv(&mut self) {
        self.signal.recv().await;
        self.seen = true;
    }

    /// Whether a Ctrl-C has arrived, taking one that is waiting without
    /// waiting for one.
    fn seen(&mut self) -> bool {
        if !self.seen
            && self
                .signal
                .poll_recv(&mut Context::from_waker(Waker::noop()))
                .is_ready()
        {
            self.seen = true;
        }
        self.seen
    }
}

enum Halt {
    Interrupted,
    Failed(Failure),
}

impl From<Failure> for Halt {
    fn from(f: Failure) -> Halt {
        Halt::Failed(f)
    }
}

/// Runs a step that has a child and waits for it to finish, even after a
/// Ctrl-C: the signal prints one line, naming the step as `what`, saying the
/// run stops once it is done. No step starts after a Ctrl-C.
async fn step<T>(
    ctx: &Ctx,
    interrupt: &mut Interrupt,
    what: &str,
    fut: impl Future<Output = Result<T, Failure>>,
) -> Result<T, Halt> {
    if interrupt.seen() {
        return Err(Halt::Interrupted);
    }
    let mut fut = std::pin::pin!(fut);
    let result = tokio::select! {
        result = &mut fut => result,
        _ = interrupt.recv() => {
            ctx.out.status(&format!(
                "Ctrl-C: stopping once {what} has finished; cutting it short could leave the sandbox locked"
            ));
            fut.await
        }
    };
    if interrupt.seen() {
        return Err(Halt::Interrupted);
    }
    Ok(result?)
}

/// A step with no child to wait for, abandoned at once on Ctrl-C.
async fn abandonable<T>(
    interrupt: &mut Interrupt,
    fut: impl Future<Output = Result<T, Failure>>,
) -> Result<T, Halt> {
    if interrupt.seen() {
        return Err(Halt::Interrupted);
    }
    tokio::select! {
        result = fut => Ok(result?),
        _ = interrupt.recv() => Err(Halt::Interrupted),
    }
}

/// The Compose projects whose access relay is running.
async fn relay_projects(r: &dyn Runner, cwd: &Path) -> Result<Vec<String>, Failure> {
    let out = r
        .capture(
            "docker",
            &[
                "ps".into(),
                "--filter".into(),
                "label=com.docker.compose.service=host-access".into(),
                "--format".into(),
                "{{.Label \"com.docker.compose.project\"}}".into(),
            ],
            cwd,
        )
        .await?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

fn relay_held_by(other: &str) -> Failure {
    Failure::usage(format!(
        "another local network ({other}) holds {ACCESS_ADDR}; stop it first (Ctrl-C in its terminal, \
         or `deno task sandbox access stop` in its checkout)"
    ))
}

/// Refuses before the relay starts if its port is taken by anything but this
/// sandbox's own relay; the sandbox would otherwise fail without saying why.
async fn ensure_relay_port_free(sandbox: &Sandbox<'_>) -> Result<(), Failure> {
    let projects = relay_projects(sandbox.runner, &sandbox.checkout).await?;
    if let Some(other) = projects.iter().find(|p| **p != sandbox.project) {
        return Err(relay_held_by(other));
    }
    if projects.contains(&sandbox.project) {
        return Ok(());
    }
    let addr = std::env::var(ACCESS_ADDR_ENV)
        .ok()
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| ACCESS_ADDR.into());
    let listening = addr.parse::<std::net::SocketAddr>().is_ok_and(|a| {
        std::net::TcpStream::connect_timeout(&a, Duration::from_millis(500)).is_ok()
    });
    if listening {
        return Err(Failure::usage(format!(
            "something else is listening on {addr} (the local network's HTTPS relay needs it); stop it first"
        )));
    }
    Ok(())
}

async fn happyview_container(sandbox: &Sandbox<'_>) -> Result<Option<String>, Failure> {
    let filter = |k: &str, v: &str| format!("label=com.docker.compose.{k}={v}");
    let names = sandbox
        .runner
        .capture(
            "docker",
            &[
                "ps".into(),
                "-a".into(),
                "--filter".into(),
                filter("project", &sandbox.project),
                "--filter".into(),
                filter("service", APP_ID),
                "--format".into(),
                "{{.Names}}".into(),
            ],
            &sandbox.checkout,
        )
        .await?;
    Ok(names
        .lines()
        .map(str::trim)
        .find(|n| !n.is_empty())
        .map(str::to_string))
}

/// `up`, followed on failure by HappyView's own last words: the sandbox
/// withholds Compose's output, so a HappyView that dies at boot would
/// otherwise surface only as a failed `up`.
async fn up(ctx: &Ctx, interrupt: &mut Interrupt, sandbox: &Sandbox<'_>) -> Result<(), Halt> {
    match step(ctx, interrupt, "starting the local network", sandbox.up()).await {
        Err(Halt::Failed(f)) => {
            if let Ok(Some(name)) = happyview_container(sandbox).await {
                ctx.out
                    .status("the HappyView container's last 50 log lines:");
                let _ = sandbox
                    .runner
                    .show_on_stderr(
                        "docker",
                        &["logs".into(), "--tail".into(), "50".into(), name],
                        &sandbox.checkout,
                    )
                    .await;
            }
            Err(Halt::Failed(f))
        }
        other => other,
    }
}

async fn stop(ctx: &Ctx, sandbox: &Sandbox<'_>) -> Result<(), Failure> {
    ctx.out
        .status("stopping the local network (its data is kept)");
    // Both are attempted: a relay that would not stop is no reason to leave
    // the whole network running.
    let access = sandbox.access_stop().await;
    let down = sandbox.down().await;
    access.and(down)
}

pub async fn run_local(ctx: &Ctx, args: DevArgs) -> Result<(), Failure> {
    // Before any child: from here on Ctrl-C reaches `hpy` as an event rather
    // than ending it.
    let mut interrupt = Interrupt::install()?;
    let runner = SystemRunner {
        stdout_to_stderr: ctx.out.is_json(),
    };
    let mut running = false;
    let mut sandbox = None;
    let started = start(
        ctx,
        &args,
        &runner,
        &mut interrupt,
        &mut sandbox,
        &mut running,
    )
    .await;
    let (sandbox, (network_dir, account, root, from)) = match (started, sandbox) {
        (Ok(started), Some(sandbox)) => (sandbox, started),
        (Ok(_), None) => unreachable!("a started network has a sandbox"),
        (Err(Halt::Interrupted), sandbox) => {
            // Each step was left to finish or stop on its own terms. Running
            // containers are stopped like after a failure, except while a
            // step is pending: the sandbox then refuses all but `resume`.
            match sandbox {
                Some(sandbox) if running && sandbox.pending() => ctx.out.status(
                    "interrupted; the local network's containers may still be running until the next run resumes it",
                ),
                Some(sandbox) if running => {
                    if let Err(e) = stop(ctx, &sandbox).await {
                        ctx.out.status(&format!("warning: {}", e.report));
                    }
                    ctx.out
                        .status("interrupted; the local network is stopped and the next run resumes");
                }
                _ => ctx.out.status("interrupted; the next run resumes"),
            }
            return Err(Failure::exit(130));
        }
        (Err(Halt::Failed(f)), sandbox) => {
            // As after a Ctrl-C: a pending step leaves only `resume`, which
            // refuses `access stop` and `down`.
            match sandbox {
                Some(sandbox) if running && sandbox.pending() => ctx.out.status(
                    "the local network's setup did not finish; its containers may still be running until the next run resumes it",
                ),
                Some(sandbox) if running => {
                    if let Err(e) = stop(ctx, &sandbox).await {
                        ctx.out.status(&format!("warning: {}", e.report));
                    }
                }
                _ => {}
            }
            return Err(f);
        }
    };

    // The container runs HappyView from the bind-mounted project, so a host
    // build into its `.happyview/build` is the one it loads: a module is wasm,
    // the same whatever builds it.
    let watcher = ModuleWatcher::spawn(&root, from);
    let followed = follow(ctx, &mut interrupt, &sandbox, &network_dir, &account).await;
    if let Some(watcher) = watcher {
        watcher.stop().await;
    }
    let interrupted = interrupt.seen();
    let stopped = stop(ctx, &sandbox).await;
    match followed {
        _ if interrupted => stopped,
        Ok(code) => {
            stopped?;
            finish(code)
        }
        Err(f) => {
            if let Err(e) = stopped {
                ctx.out.status(&format!("warning: {}", e.report));
            }
            Err(f)
        }
    }
}

/// Everything up to a running network with HappyView in it, answering the
/// network's directory, the seeded superadmin, and the project's root and
/// modules. `running` turns true once anything may have started, which is
/// from when a failure has to stop the network again.
async fn start<'r>(
    ctx: &Ctx,
    args: &DevArgs,
    runner: &'r dyn Runner,
    interrupt: &mut Interrupt,
    sandbox_out: &mut Option<Sandbox<'r>>,
    running: &mut bool,
) -> Result<(PathBuf, SeededAccount, PathBuf, Snapshot), Halt> {
    step(
        ctx,
        interrupt,
        "checking for Deno and Docker",
        check_tools(runner, &ctx.dir),
    )
    .await?;
    let root = find_root(&ctx.dir).ok_or_else(|| {
        Failure::usage(format!(
            "no {CONFIG_FILE} in {} or any directory above it; start one with `hpy happyview create`",
            ctx.dir.display()
        ))
    })?;
    let data = data_root()?;
    let net = network_dir(&data, &root)?;
    // Checked before anything downloads or starts: the relay's port is the
    // one resource two sandboxes cannot share.
    let relays = step(
        ctx,
        interrupt,
        "looking for another local network",
        relay_projects(runner, &root),
    )
    .await?;
    if let Some(other) = relays.iter().find(|p| **p != net.project) {
        return Err(relay_held_by(other).into());
    }
    let docker_arch = step(
        ctx,
        interrupt,
        "asking Docker for its architecture",
        runner.capture(
            "docker",
            &["info".into(), "--format".into(), "{{.Architecture}}".into()],
            &root,
        ),
    )
    .await?;
    // The container runs Linux whatever this computer runs, so the binary is
    // the Linux release for Docker's architecture, never the host's own.
    let target = linux_target(&docker_arch)?;
    let options = PrepareOptions {
        locked: args.run.locked,
        place: PlaceMode::Copy,
        target,
    };
    let prepared = abandonable(interrupt, prepare(ctx, &options)).await?;
    // Before HappyView first boots, which refuses a module with no build.
    // Taken before the build, so a save made while it runs is rebuilt.
    let from = Snapshot::take(&prepared.root, modules::read_modules(&prepared.root)?);
    if !from.modules().is_empty() {
        // Not a `step`: a build holds no sandbox lock, so Ctrl-C ends the one
        // under way at once rather than waiting out every module left.
        if interrupt.seen() {
            return Err(Halt::Interrupted);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let mut build = std::pin::pin!(first_build_until(
            &prepared.root,
            from.modules(),
            stop.clone()
        ));
        tokio::select! {
            result = &mut build => result?,
            _ = interrupt.recv() => {
                stop.store(true, Ordering::SeqCst);
                build.await?;
                return Err(Halt::Interrupted);
            }
        }
    }
    let backfill = ProjectToml::load(&prepared.root)
        .map_err(Failure::from)?
        .dev
        .backfill;
    for line in claim_network_dir(&net, &prepared.root)? {
        ctx.out.status(&line);
    }
    let checkout = abandonable(
        interrupt,
        fetch_checkout(&http_client(), &PINNED, &net, &|m| ctx.out.status(m)),
    )
    .await?;
    step(
        ctx,
        interrupt,
        "installing Atmosphere in a Box",
        install_checkout(runner, &PINNED, &checkout),
    )
    .await?;
    let sandbox = sandbox_out.insert(Sandbox {
        runner,
        checkout: checkout.clone(),
        project: net.project.clone(),
        subnet: net.subnet.clone(),
    });
    // Before the first sandbox command, which would only fail on it.
    sandbox.refuse_a_held_lock()?;

    if args.reset {
        if !ctx.prompter.confirm(
            "Discard the local network's accounts, records and database?",
            args.yes,
        )? {
            return Err(Failure::runtime("cancelled").into());
        }
        // The sandbox refuses `destroy` while a step is pending, and an
        // interrupted first create has no manifest for `destroy` to find the
        // project in: `resume` settles both, and leaves a created sandbox.
        if sandbox.pending() {
            *running = true;
            step(
                ctx,
                interrupt,
                "finishing the interrupted setup",
                sandbox.resume(),
            )
            .await?;
        }
        if sandbox.created() {
            step(
                ctx,
                interrupt,
                "discarding the local network",
                sandbox.destroy(),
            )
            .await?;
        }
        let local = prepared.root.join(LOCAL_DB_DIR);
        if local.exists() {
            std::fs::remove_dir_all(&local).map_err(Failure::runtime)?;
        }
    }
    std::fs::create_dir_all(prepared.root.join(LOCAL_DB_DIR)).map_err(Failure::runtime)?;

    // Before `created()`: an interrupted first create can leave pending
    // state with no manifest yet, and only `resume` may finish it.
    if sandbox.pending() {
        ctx.out
            .status("finishing the local network's interrupted setup");
        *running = true;
        step(
            ctx,
            interrupt,
            "finishing the interrupted setup",
            sandbox.resume(),
        )
        .await?;
    }
    if !sandbox.created() {
        ctx.out
            .status(&format!("creating the local network ({})", net.project));
        step(
            ctx,
            interrupt,
            "creating the local network",
            sandbox.create(),
        )
        .await?;
    }
    let account = match seeded_superadmin(&checkout)? {
        Some(account) => account,
        None => {
            // HappyView joins only once the seeded user exists, so its first
            // boot already has its superadmin and it boots once.
            *running = true;
            up(ctx, interrupt, sandbox).await?;
            step(
                ctx,
                interrupt,
                "creating the sandbox's accounts",
                sandbox.seed(),
            )
            .await?;
            seeded_superadmin(&checkout)?
                .ok_or_else(|| Failure::runtime("seed finished without recording user1's DID"))?
        }
    };
    let (uid, gid) = host_ids();
    let app = AppConfig {
        project_root: prepared.root.clone(),
        binary: prepared.binary.clone(),
        uid,
        gid,
        superadmin: Some(account.did.clone()),
        backfill,
    };
    let written = write_app(&checkout, &app)?;
    let route_changed = step(
        ctx,
        interrupt,
        "applying HappyView to the local network",
        sandbox.sync(written),
    )
    .await?;
    *running = true;
    up(ctx, interrupt, sandbox).await?;
    if route_changed {
        let restarted = step(
            ctx,
            interrupt,
            "restarting the sandbox's DNS, gateway and PDS",
            sandbox.restart_route_readers(),
        )
        .await?;
        if restarted.is_empty() {
            ctx.out.status(
                "warning: no DNS, gateway or PDS container was running to restart for HappyView's new route; \
                 sign-in may fail until the local network is restarted",
            );
        }
    }
    if backfill && !BACKFILL_ON_LOCAL {
        ctx.out.status(
            "backfill is off on the local network: its relay cannot list repos by collection",
        );
    }
    Ok((net.dir, account, prepared.root, from))
}

async fn follow(
    ctx: &Ctx,
    interrupt: &mut Interrupt,
    sandbox: &Sandbox<'_>,
    network_dir: &Path,
    account: &SeededAccount,
) -> Result<i32, Failure> {
    ensure_relay_port_free(sandbox).await?;
    ensure_access(ctx, sandbox, network_dir, Path::new("/etc/hosts")).await?;
    let name = happyview_container(sandbox).await?.ok_or_else(|| {
        Failure::runtime(format!(
            "the HappyView container did not start; see `deno task sandbox ps` in {}",
            sandbox.checkout.display()
        ))
    })?;
    ctx.out.status(&banner(
        account,
        shows_password(ctx.prompter.is_interactive(), ctx.out.is_json()),
        &accounts_path(&sandbox.checkout),
        &record_path(network_dir),
    ));
    ctx.out.done(
        "",
        json!({ "url": PUBLIC_URL, "handle": account.handle, "project": sandbox.project }),
    );
    // Under --json the runner sends these to stderr with every other child's
    // output, keeping stdout to the one result document.
    let args = ["logs".into(), "--follow".into(), name.clone()];
    let logs = sandbox.runner.show("docker", &args, &sandbox.checkout);
    tokio::select! {
        result = logs => {
            result?;
        }
        // `docker logs` is in a process group of its own and never sees the
        // terminal's Ctrl-C; dropping it here is what ends it.
        _ = interrupt.recv() => return Ok(0),
    }
    let state = sandbox
        .runner
        .capture(
            "docker",
            &[
                "inspect".into(),
                "--format".into(),
                "{{.State.Running}} {{.State.ExitCode}}".into(),
                name,
            ],
            &sandbox.checkout,
        )
        .await?;
    Ok(exit_from_inspect(&state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::network::accounts::SeededAccount;

    #[test]
    fn docker_architectures_map_to_musl_release_targets() {
        assert_eq!(
            linux_target("x86_64\n").unwrap(),
            "x86_64-unknown-linux-musl"
        );
        assert_eq!(
            linux_target("aarch64").unwrap(),
            "aarch64-unknown-linux-musl"
        );
        assert_eq!(linux_target("arm64").unwrap(), "aarch64-unknown-linux-musl");
        assert!(linux_target("s390x").is_err());
    }

    #[test]
    fn credentials_print_only_to_a_terminal() {
        let a = SeededAccount {
            handle: "user1.pds1.atmosbox.test".into(),
            did: "did:plc:u".into(),
            password: "secret-pw".into(),
        };
        let accounts = Path::new("/data/net/atmosphereinabox-v0.7.1/state/accounts.json");
        let record = Path::new("/data/net/access.toml");
        let shown = banner(&a, true, accounts, record);
        assert!(
            shown.contains("https://happyview.atmosbox.internal") && shown.contains("secret-pw")
        );
        let hidden = banner(&a, false, accounts, record);
        assert!(hidden.contains("user1.pds1.atmosbox.test") && !hidden.contains("secret-pw"));
        assert!(hidden.contains(&accounts.display().to_string()), "{hidden}");
        // A removed CA trust shows up only as a browser error; the line
        // names the file whose removal repeats the setup.
        for text in [&shown, &hidden] {
            assert!(text.contains("certificate error"), "{text}");
            assert!(text.contains("delete /data/net/access.toml"), "{text}");
        }
    }

    #[test]
    fn the_password_needs_a_terminal_and_no_json() {
        assert!(shows_password(true, false));
        assert!(!shows_password(true, true));
        assert!(!shows_password(false, false));
        assert!(!shows_password(false, true));
    }

    #[test]
    fn a_stopped_container_reports_its_exit_code_and_an_interrupted_one_zero() {
        assert_eq!(exit_from_inspect("true 0\n"), 0);
        assert_eq!(exit_from_inspect("false 3\n"), 3);
        assert_eq!(exit_from_inspect("garbage"), 1);
    }

    #[test]
    fn a_network_whose_project_is_gone_is_named_and_kept() {
        let data = tempfile::tempdir().unwrap();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_path = std::fs::canonicalize(first.path()).unwrap();
        let old = network_dir(data.path(), first.path()).unwrap();
        assert!(claim_network_dir(&old, first.path()).unwrap().is_empty());
        drop(first);

        let new = network_dir(data.path(), second.path()).unwrap();
        let lines = claim_network_dir(&new, second.path()).unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains(&first_path.display().to_string()));
        assert!(lines[0].contains(&old.dir.display().to_string()));
        assert!(lines[0].contains("deno task sandbox destroy --accept-destructive"));
        assert!(
            lines[0].contains(&format!("in {}", old.dir.join(PINNED.top).display())),
            "{}",
            lines[0]
        );
        assert!(old.dir.is_dir(), "an old network is never deleted");
        // Said once, when the new directory appears.
        assert!(claim_network_dir(&new, second.path()).unwrap().is_empty());
    }
}
