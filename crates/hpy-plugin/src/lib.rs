//! Everything about a HappyView plugin that needs no network: reading the
//! files in a plugin directory, validating them against the rules the
//! registry enforces, and building the records to publish.

pub mod artifact;
pub mod checksum;
pub mod config;
pub mod locate;
pub mod manifest;
pub mod problem;
pub mod profile;
pub mod release;
pub mod validate;

pub use problem::Problem;

pub const PROFILE_NSID: &str = "at.happyproto.plugin.profile";
pub const RELEASE_NSID: &str = "at.happyproto.plugin.release";
pub const EXTENSION_NSID: &str = "at.happyproto.plugin.releaseExtension";
pub const PLUGIN_KIND: &str = "happyview-plugin";
