//! A HappyView project's files, as `hpy` reads and writes them. No network:
//! the registry and the release downloads live in the `hpy` binary.

pub mod config;
pub mod lock;
pub mod manifest;

pub use config::{CONFIG_FILE, PluginKind, ProjectToml, Requirement, find_root};
pub use lock::{LOCK_FILE, LockedHappyview, LockedPlugin, Lockfile};
