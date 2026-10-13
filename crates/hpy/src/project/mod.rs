//! Running a HappyView project: resolving its plugins, fetching and verifying
//! what it runs, and starting the binary.

pub mod binary;
pub mod cache;
// Goes once `dev --network local` uses the module.
#[allow(dead_code)]
pub mod network;
pub mod plugins;
pub mod prepare;
pub mod resolve;
pub mod run;
