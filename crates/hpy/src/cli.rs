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
    /// Write hpy.toml and create the plugin's registry profile on your PDS.
    Init(ProfileInitArgs),
    /// Show the plugin's profile on your PDS.
    Show(SlugArg),
    /// Edit the plugin's profile on your PDS.
    Edit(ProfileEditArgs),
    /// Copy the plugin's profile on your PDS into hpy.toml.
    Pull(SlugArg),
    /// Publish the plugin in the current directory as a new release.
    Publish(PublishArgs),
    /// Show what the registry knows about this plugin's releases.
    Status(StatusArgs),
    /// Withdraw a published release (it stays installable by exact version).
    Withdraw(WithdrawArgs),
    /// Ask the registry to copy a pending release's artifact again.
    Retry(RetryArgs),
}

#[derive(Args, Default)]
pub struct SlugArg {
    /// Package slug (default: hpy.toml [profile] slug, then manifest.json id).
    #[arg(long)]
    pub slug: Option<String>,
}

#[derive(Args, Default)]
pub struct ProfileFields {
    /// Display name.
    #[arg(long)]
    pub name: Option<String>,
    /// One-line description.
    #[arg(long)]
    pub description: Option<String>,
    /// SPDX license expression, or "proprietary".
    #[arg(long)]
    pub license: Option<String>,
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
    pub slug: SlugArg,
    #[command(flatten)]
    pub fields: ProfileFields,
    /// Only write hpy.toml; do not create the record.
    #[arg(long)]
    pub local_only: bool,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Args)]
pub struct ProfileEditArgs {
    #[command(flatten)]
    pub slug: SlugArg,
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
    /// Version to publish (default: hpy.toml [release] version, then manifest.json version).
    #[arg(long)]
    pub version: Option<String>,
    /// Validate and print the record without publishing.
    #[arg(long)]
    pub dry_run: bool,
    /// Skip hpy.toml [build] command.
    #[arg(long)]
    pub no_build: bool,
    /// Wait until the registry has copied the artifact.
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
    pub slug: SlugArg,
}

#[derive(Args)]
pub struct RetryArgs {
    /// The pending version.
    pub version: String,
    #[command(flatten)]
    pub slug: SlugArg,
    /// Wait until the registry has copied the artifact.
    #[arg(long)]
    pub wait: bool,
}

#[derive(Args)]
pub struct WithdrawArgs {
    /// The version to withdraw.
    pub version: String,
    #[command(flatten)]
    pub slug: SlugArg,
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
    /// Library namespace or id; repeatable.
    #[arg(long = "library", value_name = "LIBRARY")]
    pub libraries: Vec<String>,
    /// The registry package to use for the interpreter or library it answers to, when several do; repeatable.
    #[arg(long = "package", value_name = "AT-URI")]
    pub packages: Vec<String>,
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
    #[arg(long, value_name = "CIDR", value_parser = crate::project::network::sandbox::parse_subnet)]
    pub subnet: Option<String>,
    /// Do not ask for confirmation.
    #[arg(long, short)]
    // Only `--network local` asks, and it is unix-only.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub yes: bool,
}

#[derive(Args)]
pub struct AddArgs {
    /// A language id (interpreters) or a namespace or id (libraries), optionally `@version`.
    #[arg(value_name = "PLUGIN")]
    pub plugins: Vec<String>,
    /// Treat every PLUGIN as an interpreter.
    #[arg(long, conflicts_with = "library")]
    pub interpreter: bool,
    /// Treat every PLUGIN as a library.
    #[arg(long)]
    pub library: bool,
    /// The registry package to use, when several answer to one name.
    #[arg(long, value_name = "AT-URI", requires = "plugins")]
    pub package: Option<String>,
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

    #[test]
    fn command_tree_is_valid() {
        super::Cli::command().debug_assert();
    }
}
