mod cli;
mod clock;
mod commands;
mod ctx;
mod failure;
mod output;
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
    let update = hpy_atproto::settings::config_dir()
        .ok()
        .and_then(|dir| update::start(dir.join("update-check.toml")));
    let code = match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(f) => {
            eprintln!("{:?}", f.report);
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
    let Command::Registry(command) = cli.command;
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
            PluginCommand::Withdraw(a) => commands::withdraw::run(&ctx, a).await,
        },
    }
}
