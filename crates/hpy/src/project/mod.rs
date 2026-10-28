//! Running a HappyView project: resolving its plugins, fetching and verifying
//! what it runs, and starting the binary.

pub mod binary;
pub mod cache;
pub mod deploy;
pub mod editor;
pub mod modules;
// `dev --network local` is refused off unix.
#[cfg(unix)]
pub mod network;
pub mod plugins;
pub mod prepare;
pub mod resolve;
pub mod run;
