//! A HappyView project's files, as `hpy` reads and writes them. No network:
//! the registry and the release downloads live in the `hpy` binary.

pub mod config;

pub use config::{CONFIG_FILE, PluginKind, ProjectToml, Requirement, find_root};
