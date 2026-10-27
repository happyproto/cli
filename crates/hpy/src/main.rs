mod channel;
mod cli;
mod clock;
mod commands;
mod ctx;
mod failure;
mod output;
mod project;
mod prompt;
#[cfg(test)]
mod testing;
mod update;

use std::process::ExitCode;

use clap::Parser;

use cli::{Cli, Command, PluginCommand, RegistryCommand};
use ctx::Ctx;
use failure::Failure;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let checks = checks_for_updates(&cli.command);
    let update = hpy_atproto::settings::config_dir()
        .ok()
        .filter(|_| checks)
        .and_then(update::start);
    let code = match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(f) => {
            if !f.quiet {
                eprintln!("{:?}", f.report);
            }
            ExitCode::from(f.code)
        }
    };
    update::finish(update).await;
    code
}

async fn run(cli: Cli) -> Result<(), Failure> {
    let settings = hpy_atproto::Settings::load()?;
    let dir = match cli.dir {
        Some(d) => d,
        None => std::env::current_dir().map_err(Failure::runtime)?,
    };
    let ctx = Ctx {
        settings,
        prompter: prompt::Prompter::new(cli.no_input),
        out: output::Output::new(cli.json),
        dir,
    };
    let command = match cli.command {
        Command::Update => return commands::update::run(&ctx).await,
        Command::Channel(a) => return commands::channel::run(&ctx, a).await,
        Command::Happyview(command) => return commands::happyview::run(&ctx, command).await,
        Command::Registry(command) => command,
    };
    match command {
        RegistryCommand::Login(a) => commands::auth::login(&ctx, a).await,
        RegistryCommand::Logout => commands::auth::logout(&ctx).await,
        RegistryCommand::Whoami => commands::auth::whoami(&ctx).await,
        RegistryCommand::Plugin(command) => match command {
            PluginCommand::Init(a) => commands::profile::init(&ctx, a).await,
            PluginCommand::Show(a) => commands::profile::show(&ctx, a).await,
            PluginCommand::Edit(a) => commands::profile::edit(&ctx, a).await,
            PluginCommand::Pull(a) => commands::profile::pull(&ctx, a).await,
            PluginCommand::Publish(a) => commands::publish::run(&ctx, a).await,
            PluginCommand::Status(a) => commands::status::run(&ctx, a).await,
            PluginCommand::Lifecycle(a) => commands::lifecycle::run(&ctx, a).await,
        },
    }
}

/// Whether the daily update check runs around this command. `update` and
/// `channel` do it themselves, and say so. `happyview` ends by becoming the
/// HappyView binary, so a check started here would record the day as checked
/// and then be lost with its notice.
fn checks_for_updates(command: &Command) -> bool {
    !matches!(
        command,
        Command::Update | Command::Channel(_) | Command::Happyview(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn happyview_commands_skip_the_update_check() {
        let command = |args: &[&str]| Cli::try_parse_from(args).unwrap().command;
        assert!(!checks_for_updates(&command(&["hpy", "hv", "check"])));
        assert!(!checks_for_updates(&command(&["hpy", "update"])));
        assert!(checks_for_updates(&command(&["hpy", "registry", "whoami"])));
    }

    /// Withdrawing became a lifecycle status and the registry retries copies
    /// itself, so neither command is kept as an alias.
    #[test]
    fn withdraw_and_retry_are_gone() {
        for gone in ["withdraw", "retry"] {
            let err = Cli::try_parse_from(["hpy", "registry", "plugin", gone, "1.0.0"])
                .err()
                .unwrap();
            assert_eq!(
                err.kind(),
                clap::error::ErrorKind::InvalidSubcommand,
                "{gone}"
            );
        }
    }

    #[test]
    fn lifecycle_takes_a_version_and_an_event_or_the_project_and_one() {
        let parse = |args: &[&str]| match Cli::try_parse_from(args).unwrap().command {
            Command::Registry(RegistryCommand::Plugin(PluginCommand::Lifecycle(a))) => a,
            _ => panic!(),
        };
        let a = parse(&[
            "hpy",
            "registry",
            "plugin",
            "lifecycle",
            "1.0.0",
            "endOfLife",
        ]);
        assert_eq!(
            (a.target.as_deref(), a.event.as_deref(), a.project),
            (Some("1.0.0"), Some("endOfLife"), false)
        );
        let a = parse(&[
            "hpy",
            "registry",
            "plugin",
            "lifecycle",
            "--project",
            "endOfLife",
        ]);
        assert_eq!((a.target.as_deref(), a.project), (Some("endOfLife"), true));
        let a = parse(&[
            "hpy",
            "registry",
            "plugin",
            "lifecycle",
            "--withdraw",
            "at://x",
        ]);
        assert_eq!(a.withdraw.as_deref(), Some("at://x"));
    }
}
