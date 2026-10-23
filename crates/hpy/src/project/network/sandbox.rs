//! The sandbox's lifecycle, through the CLI Atmosphere in a Box documents.

use std::path::PathBuf;

use crate::failure::Failure;
use crate::project::network::app::{APP_ID, Written};
use crate::project::network::runner::{Exit, Runner};

pub struct Sandbox<'a> {
    pub runner: &'a dyn Runner,
    pub checkout: PathBuf,
    pub project: String,
    /// The network `create` asks for; see `choose_subnet`.
    pub subnet: String,
}

/// `--subnet`'s value, held to what Atmosphere in a Box accepts (a private
/// IPv4 network from /16 to /28, aligned to its prefix) so a mistake is
/// refused before anything downloads rather than by the sandbox's `create`.
pub fn parse_subnet(value: &str) -> Result<String, String> {
    const EXAMPLE: &str = "an IPv4 network such as 10.40.0.0/24";
    let (addr, prefix) = value
        .split_once('/')
        .ok_or_else(|| format!("expected {EXAMPLE}"))?;
    let addr: std::net::Ipv4Addr = addr.parse().map_err(|_| format!("expected {EXAMPLE}"))?;
    let prefix: u32 = prefix
        .parse()
        .ok()
        .filter(|p| (16..=28).contains(p))
        .ok_or("the prefix must be from /16 to /28")?;
    let [a, b, _, _] = addr.octets();
    if !(a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)) {
        return Err(
            "it must be a private network, inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16"
                .into(),
        );
    }
    let mask = !((1u32 << (32 - prefix)) - 1);
    let start = std::net::Ipv4Addr::from(u32::from(addr) & mask);
    if start != addr {
        return Err(format!(
            "{addr} is not where a /{prefix} starts; did you mean {start}/{prefix}?"
        ));
    }
    Ok(format!("{addr}/{prefix}"))
}

/// The network a sandbox is created on. The one it was last created on is
/// kept, through `--reset` too, until `--subnet` names another; a project
/// with neither gets the one derived from its path. A created sandbox cannot
/// move, so asking one to is refused rather than ignored.
pub fn choose_subnet(
    asked: Option<&str>,
    recorded: Option<&str>,
    derived: &str,
    created: bool,
    reset: bool,
) -> Result<String, Failure> {
    if let (Some(asked), Some(recorded)) = (asked, recorded)
        && created
        && !reset
        && ipv4_range(asked) != ipv4_range(recorded)
    {
        return Err(Failure::usage(format!(
            "this project's local network was created on {recorded}; to move it to {asked}, \
             run this again with --reset, which discards its accounts, records and database"
        )));
    }
    Ok(asked.or(recorded).unwrap_or(derived).to_string())
}

/// An IPv4 CIDR as its first and last address; `None` for anything else,
/// IPv6 included.
fn ipv4_range(cidr: &str) -> Option<(u32, u32)> {
    let (addr, prefix) = cidr.split_once('/')?;
    let addr: std::net::Ipv4Addr = addr.parse().ok()?;
    let prefix: u32 = prefix.parse().ok().filter(|p| *p <= 32)?;
    let size = 1u64 << (32 - prefix);
    let start = u32::from(addr) & !((size - 1) as u32);
    Some((start, (u64::from(start) + size - 1) as u32))
}

/// The first Docker network, from `docker network inspect` lines of a name
/// followed by its subnets, whose subnet overlaps `ours`.
pub fn overlapping_network(inspect: &str, ours: &str) -> Option<(String, String)> {
    let (a, b) = ipv4_range(ours)?;
    inspect.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let name = parts.next()?;
        parts
            .find(|cidr| ipv4_range(cidr).is_some_and(|(c, d)| c <= b && a <= d))
            .map(|cidr| (name.to_string(), cidr.to_string()))
    })
}

/// The services that read the sandbox's routes only when they start: its DNS
/// server, its HTTPS gateway, and each PDS (`pds1`, `pds-space1`, …), which
/// otherwise cannot resolve or reach a route added after they started.
fn reads_routes_at_start(service: &str) -> bool {
    let pds_number = service
        .strip_prefix("pds-space")
        .or_else(|| service.strip_prefix("pds"));
    matches!(service, "dns" | "gateway")
        || pds_number.is_some_and(|n| {
            !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
        })
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
        let args = Self::args(rest);
        self.releasing_a_dropped_lock(self.runner.show("deno", &args, &self.checkout))
            .await?
            .check("deno", &args)
    }

    /// The directory the sandbox CLI holds for the length of one command.
    pub fn lock(&self) -> PathBuf {
        self.checkout.join("state/cli.lock")
    }

    /// Refuses a lock no child of this run took: another `deno task sandbox`
    /// may hold it, and only the developer can tell whether one does.
    pub fn refuse_a_held_lock(&self) -> Result<(), Failure> {
        let lock = self.lock();
        if lock.exists() {
            return Err(Failure::usage(format!(
                "the local network's sandbox is locked:\n\n  {}\n\nAnother `deno task sandbox` may be running in {}; \
                 if none is, a previous run crashed: inspect that lock, remove it, and run this again",
                lock.display(),
                self.checkout.display()
            )));
        }
        Ok(())
    }

    /// Runs one sandbox command and removes the lock it leaves only if a
    /// signal ended it and the lock was not there before it started. The CLI
    /// releases its lock on every exit it makes itself, error or not, so a
    /// lock left after one is someone else's: its "CLI locked" refusal, for
    /// one, is an ordinary exit 1 caused by another command's lock. Only a
    /// signal stops our child before it can let go.
    async fn releasing_a_dropped_lock(
        &self,
        command: impl Future<Output = Result<Exit, Failure>>,
    ) -> Result<Exit, Failure> {
        let lock = self.lock();
        let held_before = lock.exists();
        let exit = command.await?;
        if !held_before && exit.signal.is_some() && lock.exists() {
            // The CLI's lock is an empty directory.
            let _ = std::fs::remove_dir(&lock);
        }
        Ok(exit)
    }

    /// The network the sandbox's manifest says it was created on; `None`
    /// when there is no manifest or it names none.
    pub fn recorded_subnet(&self) -> Option<String> {
        std::fs::read_to_string(self.checkout.join("state/manifest.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|manifest| manifest.get("subnet")?.as_str().map(str::to_string))
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

    /// Refuses a subnet another Docker network already holds, naming that
    /// network, before `create` fails on it with Docker's own error. A network
    /// of this sandbox's own project is left out: a `create` that failed part
    /// way can leave one.
    pub async fn refuse_a_taken_subnet(&self) -> Result<(), Failure> {
        let names = self
            .runner
            .capture(
                "docker",
                &["network", "ls", "--format", "{{.Name}}"].map(String::from),
                &self.checkout,
            )
            .await?;
        let own = format!("{}_", self.project);
        let others: Vec<String> = names
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty() && !n.starts_with(&own))
            .map(str::to_string)
            .collect();
        if others.is_empty() {
            return Ok(());
        }
        let mut args = ["network", "inspect", "--format"]
            .map(String::from)
            .to_vec();
        args.push("{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}".into());
        args.extend(others);
        let inspect = self.runner.capture("docker", &args, &self.checkout).await?;
        if let Some((name, theirs)) = overlapping_network(&inspect, &self.subnet) {
            return Err(Failure::usage(format!(
                "the local network for this project uses {}, which overlaps Docker network `{name}` ({theirs}); \
                 choose another with `--subnet <CIDR>` (a private IPv4 network from /16 to /28, such as 10.40.0.0/24), \
                 or remove that network (`docker network rm {name}`) if nothing needs it, then run this again",
                self.subnet
            )));
        }
        Ok(())
    }

    pub async fn create(&self) -> Result<(), Failure> {
        self.refuse_a_taken_subnet().await?;
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
            "--subnet",
            &self.subnet,
        ])
        .await
    }

    /// Applies HappyView where it is new or its files changed, and answers
    /// whether that added or changed its route.
    pub async fn sync(&self, written: Written) -> Result<bool, Failure> {
        if !self.applied() {
            self.task(&["apply", "--app", APP_ID]).await?;
            return Ok(true);
        }
        if written.any {
            self.task(&["apply", "--component", APP_ID]).await?;
        }
        Ok(written.definition)
    }

    /// Restarts the running services that read routes only at start, once a
    /// route has been added or changed; without it the PDS cannot reach
    /// HappyView and OAuth sign-in fails. Answers the containers restarted.
    pub async fn restart_route_readers(&self) -> Result<Vec<String>, Failure> {
        let listed = self
            .runner
            .capture(
                "docker",
                &[
                    "ps".into(),
                    "--filter".into(),
                    format!("label=com.docker.compose.project={}", self.project),
                    "--format".into(),
                    "{{.Names}} {{.Label \"com.docker.compose.service\"}}".into(),
                ],
                &self.checkout,
            )
            .await?;
        let names: Vec<String> = listed
            .lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let name = parts.next()?;
                reads_routes_at_start(parts.next()?).then(|| name.to_string())
            })
            .collect();
        if !names.is_empty() {
            let args: Vec<String> = std::iter::once("restart".to_string())
                .chain(names.iter().cloned())
                .collect();
            self.runner.capture("docker", &args, &self.checkout).await?;
        }
        Ok(names)
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

    /// `access stop` only stops the relay, and `down` then leaves the stopped
    /// container behind (its profile is not active) while removing the network
    /// it was attached to. `access start` would restart that container and fail
    /// on the missing network, so a stopped relay of this project is removed
    /// first and Compose creates a fresh one. A running relay is left alone.
    pub async fn access_start(&self) -> Result<(), Failure> {
        let listed = self
            .runner
            .capture(
                "docker",
                &[
                    "ps".into(),
                    "-a".into(),
                    "--filter".into(),
                    format!("label=com.docker.compose.project={}", self.project),
                    "--filter".into(),
                    "label=com.docker.compose.service=host-access".into(),
                    "--format".into(),
                    "{{.Names}} {{.Label \"com.docker.compose.service\"}} {{.State}}".into(),
                ],
                &self.checkout,
            )
            .await?;
        let stopped: Vec<String> = listed
            .lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let (name, service, state) = (parts.next()?, parts.next()?, parts.next()?);
                (service == "host-access" && state != "running").then(|| name.to_string())
            })
            .collect();
        if !stopped.is_empty() {
            let args: Vec<String> = std::iter::once("rm".to_string())
                .chain(stopped.iter().cloned())
                .collect();
            self.runner.capture("docker", &args, &self.checkout).await?;
        }
        self.task(&["access", "start"]).await
    }

    pub async fn access_stop(&self) -> Result<(), Failure> {
        self.task(&["access", "stop"]).await
    }

    /// Read through `capture`, which cannot tell a signal from an exit code,
    /// so a lock it leaves is never removed; a later sandbox command reports
    /// it instead.
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
    use crate::project::network::runner::{FakeRunner, SystemRunner};

    fn sandbox<'a>(runner: &'a FakeRunner, dir: &Path) -> Sandbox<'a> {
        Sandbox {
            runner,
            checkout: dir.to_path_buf(),
            project: "hv-app-1234abcd".into(),
            subnet: "172.30.17.0/24".into(),
        }
    }

    fn write_manifest(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir.join("state")).unwrap();
        std::fs::write(dir.join("state/manifest.json"), body).unwrap();
    }

    #[tokio::test]
    async fn a_new_sandbox_is_created_with_the_full_stack_and_happyview_applied_later() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let s = sandbox(&runner, dir.path());
        assert!(!s.created());
        s.create().await.unwrap();
        assert_eq!(
            runner.calls(),
            [
                "docker network ls --format {{.Name}}",
                "deno task sandbox create --pds 1 --users-per-pds 1 --project hv-app-1234abcd --preset full-stack --subnet 172.30.17.0/24",
            ]
        );
        write_manifest(dir.path(), r#"{"applications":[]}"#);
        runner.calls.lock().unwrap().clear();
        let unchanged = Written::default();
        let files = Written {
            any: true,
            definition: false,
        };
        let route = Written {
            any: true,
            definition: true,
        };
        // A first apply always adds the route.
        assert!(s.sync(unchanged).await.unwrap());
        assert_eq!(runner.calls(), ["deno task sandbox apply --app happyview"]);
        // The fake runs nothing, so stand in for what the real `apply` records.
        write_manifest(dir.path(), r#"{"applications":["happyview"]}"#);
        runner.calls.lock().unwrap().clear();
        assert!(!s.sync(unchanged).await.unwrap());
        assert!(runner.calls().is_empty());
        assert!(!s.sync(files).await.unwrap());
        assert!(s.sync(route).await.unwrap());
        assert_eq!(
            runner.calls(),
            [
                "deno task sandbox apply --component happyview",
                "deno task sandbox apply --component happyview"
            ]
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
        assert!(s.sync(Written::default()).await.unwrap());
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

    #[test]
    fn subnets_overlap_by_range_not_by_text() {
        let inspect = "bridge 172.17.0.0/16 \nhv-other_atmosinabox 172.30.17.0/24 fd00::/64 \nhost \nwide 172.16.0.0/12 \n";
        assert_eq!(
            overlapping_network(inspect, "172.30.17.0/24"),
            Some(("hv-other_atmosinabox".into(), "172.30.17.0/24".into()))
        );
        // A /12 holding the /24 is as much in the way as the same /24.
        assert_eq!(
            overlapping_network("wide 172.16.0.0/12\n", "172.30.18.0/24"),
            Some(("wide".into(), "172.16.0.0/12".into()))
        );
        assert_eq!(
            overlapping_network("bridge 172.17.0.0/16\nv6 fd00::/64\n", "172.30.18.0/24"),
            None
        );
    }

    #[test]
    fn a_subnet_is_what_atmosphere_in_a_box_accepts() {
        for ok in ["10.40.0.0/24", "172.31.0.0/16", "192.168.7.16/28"] {
            assert_eq!(parse_subnet(ok).as_deref(), Ok(ok));
        }
        for (bad, says) in [
            ("10.40.0.0", "such as 10.40.0.0/24"),
            ("10.40.0/24", "such as 10.40.0.0/24"),
            ("10.40.0.0/15", "/16 to /28"),
            ("10.40.0.0/29", "/16 to /28"),
            ("172.32.0.0/24", "private"),
            ("8.8.8.0/24", "private"),
            ("10.40.0.1/24", "did you mean 10.40.0.0/24?"),
        ] {
            let err = parse_subnet(bad).unwrap_err();
            assert!(err.contains(says), "{bad}: {err}");
        }
    }

    #[test]
    fn a_subnet_once_chosen_is_kept_until_another_is_asked_for() {
        let derived = "172.30.17.0/24";
        // A new project takes the derived network, or the one asked for.
        assert_eq!(
            choose_subnet(None, None, derived, false, false).unwrap(),
            derived
        );
        assert_eq!(
            choose_subnet(Some("10.40.0.0/24"), None, derived, false, false).unwrap(),
            "10.40.0.0/24"
        );
        // `--reset` without `--subnet` recreates it where it was.
        assert_eq!(
            choose_subnet(None, Some("10.40.0.0/24"), derived, true, true).unwrap(),
            "10.40.0.0/24"
        );
        // `--reset` with `--subnet` moves it.
        assert_eq!(
            choose_subnet(
                Some("10.41.0.0/24"),
                Some("10.40.0.0/24"),
                derived,
                true,
                true
            )
            .unwrap(),
            "10.41.0.0/24"
        );
        // Naming the network it already has is not a move.
        assert!(
            choose_subnet(
                Some("10.40.0.0/24"),
                Some("10.40.0.0/24"),
                derived,
                true,
                false
            )
            .is_ok()
        );
    }

    #[test]
    fn a_created_network_asked_to_move_without_reset_is_refused() {
        let err = choose_subnet(
            Some("10.41.0.0/24"),
            Some("10.40.0.0/24"),
            "172.30.17.0/24",
            true,
            false,
        )
        .unwrap_err();
        let report = err.report.to_string();
        assert!(report.contains("created on 10.40.0.0/24"), "{report}");
        assert!(report.contains("--reset"), "{report}");
        assert_eq!(err.code, 2);
    }

    #[test]
    fn the_recorded_subnet_is_the_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let s = sandbox(&runner, dir.path());
        assert_eq!(s.recorded_subnet(), None);
        write_manifest(dir.path(), r#"{"applications":[],"subnet":"10.40.0.0/24"}"#);
        assert_eq!(s.recorded_subnet().as_deref(), Some("10.40.0.0/24"));
    }

    #[tokio::test]
    async fn create_refuses_a_subnet_another_network_holds_and_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::answering(&[
            (
                "docker network ls",
                Ok("bridge\nhv-app-1234abcd_atmosinabox\nsomeone-else\n"),
            ),
            (
                "docker network inspect",
                Ok("bridge 172.17.0.0/16 \nsomeone-else 172.30.0.0/16 \n"),
            ),
        ]);
        let err = sandbox(&runner, dir.path()).create().await.unwrap_err();
        let report = err.report.to_string();
        assert!(report.contains("`someone-else`"), "{report}");
        assert!(report.contains("172.30.0.0/16"), "{report}");
        assert!(report.contains("--subnet <CIDR>"), "{report}");
        assert_eq!(err.code, 2);
        let calls = runner.calls();
        // This sandbox's own network is never counted against it, and
        // nothing is created.
        assert!(calls[1].ends_with("bridge someone-else"), "{calls:?}");
        assert!(
            !calls.iter().any(|c| c.contains("sandbox create")),
            "{calls:?}"
        );
    }

    #[tokio::test]
    async fn a_stopped_relay_is_removed_before_access_starts() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::answering(&[(
            "docker ps -a --filter label=com.docker.compose.project=hv-app-1234abcd --filter label=com.docker.compose.service=host-access",
            Ok("hv-app-1234abcd-host-access-1 host-access exited\nodd-1 dns exited\n"),
        )]);
        sandbox(&runner, dir.path()).access_start().await.unwrap();
        let calls = runner.calls();
        let rm = calls
            .iter()
            .position(|c| c == "docker rm hv-app-1234abcd-host-access-1")
            .unwrap_or_else(|| panic!("{calls:?}"));
        let start = calls
            .iter()
            .position(|c| c.ends_with("access start"))
            .unwrap_or_else(|| panic!("{calls:?}"));
        assert!(rm < start, "{calls:?}");
    }

    #[tokio::test]
    async fn a_running_relay_is_not_removed() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::answering(&[(
            "docker ps -a",
            Ok("hv-app-1234abcd-host-access-1 host-access running\n"),
        )]);
        sandbox(&runner, dir.path()).access_start().await.unwrap();
        assert!(
            !runner.calls().iter().any(|c| c.starts_with("docker rm")),
            "{:?}",
            runner.calls()
        );
    }

    #[tokio::test]
    async fn only_the_route_readers_are_restarted() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::answering(&[(
            "docker ps --filter label=com.docker.compose.project=hv-app-1234abcd",
            Ok(
                "hv-app-dns-1 dns\nhv-app-gateway-1 gateway\nhv-app-pds1-1 pds1\nhv-app-plc-1 plc\nhv-app-happyview-1 happyview\nhv-app-pds-space2-1 pds-space2\nodd pdsx\n",
            ),
        )]);
        let restarted = sandbox(&runner, dir.path())
            .restart_route_readers()
            .await
            .unwrap();
        assert_eq!(
            restarted,
            [
                "hv-app-dns-1",
                "hv-app-gateway-1",
                "hv-app-pds1-1",
                "hv-app-pds-space2-1"
            ]
        );
        assert_eq!(
            runner.calls().last().unwrap(),
            "docker restart hv-app-dns-1 hv-app-gateway-1 hv-app-pds1-1 hv-app-pds-space2-1"
        );
    }

    #[test]
    fn a_lock_found_at_start_is_refused_with_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let s = sandbox(&runner, dir.path());
        s.refuse_a_held_lock().unwrap();
        std::fs::create_dir_all(s.lock()).unwrap();
        let err = s.refuse_a_held_lock().unwrap_err();
        let report = err.report.to_string();
        assert!(report.contains(&s.lock().display().to_string()), "{report}");
        assert!(
            report.contains(&dir.path().display().to_string()),
            "{report}"
        );
        assert_eq!(err.code, 2);
    }

    /// Runs `script` in the sandbox checkout as a real child, standing in
    /// for a sandbox command, under the lock rule.
    async fn under_the_lock_rule(s: &Sandbox<'_>, script: &str) -> Exit {
        let args = vec!["-c".to_string(), script.to_string()];
        s.releasing_a_dropped_lock(SystemRunner::default().show("sh", &args, &s.checkout))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn only_a_lock_our_signalled_command_left_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("state")).unwrap();
        let runner = FakeRunner::default();
        let s = sandbox(&runner, dir.path());

        // Another command took the lock after the check, and ours refused
        // with an ordinary exit, as the CLI's "CLI locked" does.
        let exit = under_the_lock_rule(&s, "mkdir state/cli.lock; exit 1").await;
        assert_eq!(exit, Exit::code(1));
        assert!(s.lock().exists(), "another command's lock was removed");
        std::fs::remove_dir(s.lock()).unwrap();

        // Ours took the lock and a signal ended it before it let go.
        let exit = under_the_lock_rule(&s, "mkdir state/cli.lock; kill -TERM $$").await;
        assert_eq!(exit.signal, Some(libc::SIGTERM));
        assert!(!s.lock().exists(), "our own stale lock was kept");

        // A lock that was there before the command is never touched.
        std::fs::create_dir(s.lock()).unwrap();
        under_the_lock_rule(&s, "kill -TERM $$").await;
        assert!(
            s.lock().exists(),
            "a lock from before the command was removed"
        );
    }
}
