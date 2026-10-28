//! Everything about a HappyView plugin that needs no network: reading the
//! files in a plugin directory, validating them against the rules the
//! registry enforces, and building what `hpy` sends to it.

pub mod artifact;
pub mod changelog;
pub mod checksum;
pub mod config;
pub mod locate;
pub mod manifest;
pub mod problem;
pub mod project;
pub mod validate;

pub use problem::Problem;

pub const PROJECT_NSID: &str = "software.release.project";
pub const MANIFEST_NSID: &str = "software.release.manifest";
pub const VERSION_NSID: &str = "software.release.version";
pub const CHANNEL_NSID: &str = "software.release.channel";
pub const STATUS_NSID: &str = "software.release.status";
pub const SIDECAR_NSID: &str = "at.happyproto.registry.project";
pub const PUBLICATION_NSID: &str = "site.standard.publication";
pub const DOCUMENT_NSID: &str = "site.standard.document";
/// The `$type` of a plugin's entry in a `software.release.manifest`'s
/// `artifacts`.
pub const ARTIFACT_TYPE: &str = "at.happyproto.plugin.v1";
pub const TRACKS: [&str; 3] = ["latest", "beta", "alpha"];
pub const PLUGIN_TYPES: [&str; 3] = ["auth", "library", "interpreter"];
