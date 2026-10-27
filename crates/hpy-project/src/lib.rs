//! A HappyView project's files, as `hpy` reads and writes them. No network:
//! the registry and the release downloads live in the `hpy` binary.

pub mod config;
pub mod lock;
pub mod manifest;
pub mod place;
pub mod scaffold;

pub use config::{CONFIG_FILE, Pin, PluginEntry, PluginKind, ProjectToml, Requirement, find_root};
pub use lock::{LOCK_FILE, LockedHappyview, LockedPlugin, Lockfile};
