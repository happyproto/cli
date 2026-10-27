use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "hpy", version, about = "The HappyProto command line")]
pub struct Cli {
    /// Print the result as JSON on stdout.
    #[arg(long, global = true)]
    pub json: bool,
    /// Never prompt; fail when a value is missing. Irreversible actions still need --yes. Implied without a terminal.
    #[arg(long, global = true)]
    pub no_input: bool,
    /// Run as if started in DIR.
    #[arg(short = 'C', global = true, value_name = "DIR")]
    pub dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Work with the HappyProto plugin registry.
    #[command(subcommand)]
    Registry(RegistryCommand),
    /// Update hpy to the newest release on your channel.
    Update,
    /// Show or choose the release channel hpy updates from.
    Channel(ChannelArgs),
    /// Build HappyView apps: a project directory, run and tested locally.
    #[command(subcommand, alias = "hv")]
    Happyview(HappyviewCommand),
}

#[derive(Args)]
pub struct ChannelArgs {
    /// stable (also `main`), beta or alpha. Shows the current channel when omitted.
    #[arg(value_parser = clap::value_parser!(crate::channel::Channel))]
    pub channel: Option<crate::channel::Channel>,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Subcommand)]
pub enum RegistryCommand {
    /// Sign in to the registry with your atproto account.
    Login(LoginArgs),
    /// Sign out of the registry and forget stored credentials.
    Logout,
    /// Show who you are signed in to the registry as.
    Whoami,
    /// Manage your HappyView plugins in the registry.
    #[command(subcommand)]
    Plugin(PluginCommand),
}

#[derive(Args)]
pub struct LoginArgs {
    /// Your handle or DID.
    pub identifier: Option<String>,
    /// Sign in for CI: print a credential to store as the HPY_CREDENTIAL secret
    /// instead of saving it here. It is its own session, revocable on its own.
    #[arg(long)]
    pub export: bool,
    /// Print the authorization URL instead of opening a browser.
    #[arg(long)]
    pub no_browser: bool,
}

#[derive(Subcommand)]
pub enum PluginCommand {
    /// Write hpy.toml's [project] and create the plugin's project in the registry.
    Init(ProfileInitArgs),
    /// Show the plugin's project as the registry has it.
    Show(NameArg),
    /// Edit the plugin's project in the registry.
    Edit(ProfileEditArgs),
    /// Copy the plugin's project from the registry into hpy.toml's [project].
    Pull(NameArg),
    /// Publish the plugin in the current directory as a new version.
    Publish(PublishArgs),
    /// Show what the registry knows about this plugin's versions.
    Status(StatusArgs),
    /// Record a lifecycle event (end of support, end of life, …) for a version or the whole project.
    Lifecycle(LifecycleArgs),
}

#[derive(Args, Default)]
pub struct NameArg {
    /// Project name (default: hpy.toml [project] name, then manifest.json id).
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Args, Default)]
pub struct ProfileFields {
    /// The name people see (the publication's name).
    #[arg(long)]
    pub display_name: Option<String>,
    /// One-line description.
    #[arg(long)]
    pub description: Option<String>,
    /// Author as `Name <email> (url)`; repeatable.
    #[arg(long = "author", value_name = "AUTHOR")]
    pub authors: Vec<String>,
    /// Security contact (email or URL); repeatable.
    #[arg(long = "security", value_name = "CONTACT")]
    pub security: Vec<String>,
    /// Keyword; repeatable.
    #[arg(long = "keyword", value_name = "KEYWORD")]
    pub keywords: Vec<String>,
}

#[derive(Args)]
pub struct ProfileInitArgs {
    #[command(flatten)]
    pub name: NameArg,
    #[command(flatten)]
    pub fields: ProfileFields,
    /// Only write hpy.toml; do not create the project.
    #[arg(long)]
    pub local_only: bool,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Args)]
pub struct ProfileEditArgs {
    #[command(flatten)]
    pub name: NameArg,
    /// Replace the fields given; authors/security/keywords given here are added.
    #[command(flatten)]
    pub fields: ProfileFields,
    /// Remove a keyword; repeatable.
    #[arg(long = "remove-keyword", value_name = "KEYWORD")]
    pub remove_keywords: Vec<String>,
}

#[derive(Args)]
pub struct PublishArgs {
    /// Path to the built .wasm module, relative to the plugin's directory (-C).
    #[arg(long)]
    pub wasm: Option<PathBuf>,
    /// Version to publish (default: manifest.json version).
    #[arg(long)]
    pub version: Option<String>,
    /// The channel to move to this version: latest, beta or alpha (default: latest for a stable version, else the prerelease's name).
    #[arg(long)]
    pub track: Option<String>,
    /// Publish an already published version's artifact as --version instead of building one.
    #[arg(long, value_name = "FROM_VERSION")]
    pub promote: Option<String>,
    /// Validate and print what would be published without publishing.
    #[arg(long)]
    pub dry_run: bool,
    /// Skip hpy.toml [build] command.
    #[arg(long)]
    pub no_build: bool,
    /// Wait until the registry has copied the version's blobs.
    #[arg(long)]
    pub wait: bool,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Args)]
pub struct StatusArgs {
    /// A single version to inspect.
    pub version: Option<String>,
    #[command(flatten)]
    pub name: NameArg,
}

#[derive(Args)]
pub struct LifecycleArgs {
    /// The version the event is about; with --project, the event itself.
    #[arg(value_name = "VERSION")]
    pub target: Option<String>,
    /// endOfDevelopment, endOfSupport, supersededBy, endOfDistribution or endOfLife.
    #[arg(value_name = "EVENT")]
    pub event: Option<String>,
    /// The event is about the whole project rather than one version.
    #[arg(long)]
    pub project: bool,
    /// What kind of event it is, in your own words (e.g. security).
    #[arg(long)]
    pub kind: Option<String>,
    /// Why, for the people running it.
    #[arg(long)]
    pub reason: Option<String>,
    /// The version to move to (with supersededBy).
    #[arg(long, value_name = "VERSION")]
    pub superseded_by: Option<String>,
    /// Withdraw a status recorded in error, by its at:// URI.
    #[arg(long, value_name = "STATUS_URI", conflicts_with_all = ["project", "superseded_by", "kind"])]
    pub withdraw: Option<String>,
    #[command(flatten)]
    pub name: NameArg,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Subcommand)]
pub enum HappyviewCommand {
    /// Scaffold a new HappyView project.
    Create(CreateArgs),
    /// Run the project with its pinned HappyView; a saved file is live on the next request.
    ///
    /// A compiled module is rebuilt when a file under its own directory changes. A path
    /// dependency outside that directory, or a workspace's Cargo.lock above it, is not
    /// watched: after changing one, save a file in the module to rebuild it.
    Dev(DevArgs),
    /// Add plugins to happyview.toml and happyview.lock and download them; with none, bring the lock up to date and download it.
    #[command(alias = "install")]
    Add(AddArgs),
    /// Build every compiled script module in happyview.toml into .happyview/build/.
    Build,
    /// Build the project's snapshot without serving it; exits non-zero on any error.
    Check(RunArgs),
    /// Run the project's tests.
    Test(TestArgs),
    /// Write editor types for the project into .happyview/types/, and the tsconfig.json or .luarc.json that points editors at them.
    Types(RunArgs),
}

#[derive(Args)]
pub struct CreateArgs {
    /// Directory to create, relative to the current one.
    #[arg(long, value_name = "DIR")]
    pub name: PathBuf,
    /// The superadmin's DID (default: the account `hpy registry login` holds).
    #[arg(long, value_name = "DID")]
    pub superadmin: Option<String>,
    /// Interpreter language id; repeatable (default: lua).
    #[arg(long = "interpreter", value_name = "LANGUAGE")]
    pub interpreters: Vec<String>,
    /// Library namespace or project name; repeatable.
    #[arg(long = "library", value_name = "LIBRARY")]
    pub libraries: Vec<String>,
    /// The registry project to use for the interpreter or library it answers to, when several do; repeatable.
    #[arg(long = "project", value_name = "AT-URI")]
    pub projects: Vec<String>,
    /// The app's display name (default: the directory name).
    #[arg(long)]
    pub app_name: Option<String>,
    /// HappyView version to pin (default: the newest with a binary for this machine).
    #[arg(long, value_name = "VERSION")]
    pub happyview_version: Option<String>,
}

#[derive(Args, Default)]
pub struct RunArgs {
    /// Fail rather than update happyview.lock when it no longer matches happyview.toml.
    #[arg(long)]
    pub locked: bool,
}

#[derive(clap::ValueEnum, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Network {
    /// The real atproto network; writes reach your real PDS.
    #[default]
    Real,
    /// A private network on this computer (Atmosphere in a Box; needs Docker and Deno 2.8).
    Local,
}

#[derive(Args)]
pub struct DevArgs {
    #[command(flatten)]
    pub run: RunArgs,
    /// Which atproto network to run against.
    #[arg(long, value_enum, default_value_t = Network::Real)]
    pub network: Network,
    /// Discard the local network's accounts, records and database, then start fresh.
    #[arg(long)]
    pub reset: bool,
    /// The private IPv4 network the local network is created on, when the one
    /// derived from the project's path is taken. Kept until another is given.
    #[arg(long, value_name = "CIDR", value_parser = parse_subnet)]
    pub subnet: Option<String>,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    // Only `--network local` asks, and it is unix-only.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub yes: bool,
}

/// `dev --subnet`'s value, held to what Atmosphere in a Box accepts (a private
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

#[derive(Args)]
pub struct AddArgs {
    /// A language id (interpreters) or a namespace or project name (libraries).
    #[arg(value_name = "PLUGIN")]
    pub plugins: Vec<String>,
    /// Treat every PLUGIN as an interpreter.
    #[arg(long, conflicts_with = "library")]
    pub interpreter: bool,
    /// Treat every PLUGIN as a library.
    #[arg(long)]
    pub library: bool,
    /// Follow this channel: latest, beta or alpha (default: latest, else the only channel there is).
    #[arg(long, requires = "plugins", conflicts_with = "version")]
    pub channel: Option<String>,
    /// Pin this exact version instead of following a channel.
    #[arg(long, requires = "plugins")]
    pub version: Option<String>,
    /// The registry project to use, when several answer to one name.
    #[arg(long, value_name = "AT-URI", requires = "plugins")]
    pub project: Option<String>,
}

#[derive(Args)]
pub struct TestArgs {
    #[command(flatten)]
    pub run: RunArgs,
    /// Rerun the affected tests whenever the project changes.
    #[arg(long)]
    pub watch: bool,
    /// Only run test files whose path contains this.
    pub filter: Option<String>,
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::parse_subnet;

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
    fn command_tree_is_valid() {
        super::Cli::command().debug_assert();
    }
}
