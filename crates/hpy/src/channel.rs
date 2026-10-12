//! Release channels. Every release belongs to exactly one: a plain version to
//! `stable`, `-beta.N` to `beta`, `-alpha.N` to `alpha` (semantic-release cuts
//! them from the `main`, `beta` and `alpha` branches). Channels are strict: a
//! channel offers only its own releases, never a newer one from another.

use std::fmt;
use std::path::Path;
use std::str::FromStr;

pub use semver::Version;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
    Alpha,
}

impl Channel {
    /// The channel a version was released on, or `None` for a prerelease no
    /// channel ships (e.g. `-rc.1`).
    pub fn of(version: &Version) -> Option<Channel> {
        if version.pre.is_empty() {
            return Some(Channel::Stable);
        }
        match version.pre.as_str().split('.').next() {
            Some("beta") => Some(Channel::Beta),
            Some("alpha") => Some(Channel::Alpha),
            _ => None,
        }
    }

    pub fn is_prerelease(self) -> bool {
        self != Channel::Stable
    }
}

impl fmt::Display for Channel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
            Channel::Alpha => "alpha",
        })
    }
}

impl FromStr for Channel {
    type Err = String;

    fn from_str(s: &str) -> Result<Channel, String> {
        match s {
            // `main` is the branch stable releases are cut from.
            "stable" | "main" => Ok(Channel::Stable),
            "beta" => Ok(Channel::Beta),
            "alpha" => Ok(Channel::Alpha),
            other => Err(format!(
                "`{other}` is not a channel; choose stable, beta or alpha"
            )),
        }
    }
}

/// A GitHub release, as much of it as choosing one needs.
#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    #[serde(rename = "tag_name")]
    pub tag: String,
    #[serde(default)]
    pub draft: bool,
}

/// The newest published release on `channel`.
pub fn latest_on(channel: Channel, releases: &[Release]) -> Option<Version> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter_map(|r| Version::parse(r.tag.trim_start_matches('v')).ok())
        .filter(|v| Channel::of(v) == Some(channel))
        .max()
}

/// The channel to follow: the one chosen with `hpy channel`, else the one the
/// running version came from, else stable.
pub fn effective(chosen: Option<Channel>, current: &Version) -> Channel {
    chosen
        .or_else(|| Channel::of(current))
        .unwrap_or(Channel::Stable)
}

#[derive(Serialize, Deserialize)]
struct File {
    channel: Channel,
}

/// The channel chosen with `hpy channel`, if any.
pub fn read(path: &Path) -> Option<Channel> {
    let text = std::fs::read_to_string(path).ok()?;
    toml::from_str::<File>(&text).ok().map(|f| f.channel)
}

pub fn write(path: &Path, channel: Channel) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = toml::to_string(&File { channel }).map_err(std::io::Error::other)?;
    std::fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn release(tag: &str) -> Release {
        Release {
            tag: tag.into(),
            draft: false,
        }
    }

    #[test]
    fn parses_channel_names_and_main_means_stable() {
        assert_eq!("stable".parse(), Ok(Channel::Stable));
        assert_eq!("main".parse(), Ok(Channel::Stable));
        assert_eq!("beta".parse(), Ok(Channel::Beta));
        assert_eq!("alpha".parse(), Ok(Channel::Alpha));
        assert!("nightly".parse::<Channel>().is_err());
        assert_eq!(Channel::Alpha.to_string(), "alpha");
    }

    #[test]
    fn a_version_is_on_the_channel_its_prerelease_names() {
        assert_eq!(Channel::of(&v("1.0.0")), Some(Channel::Stable));
        assert_eq!(Channel::of(&v("1.0.0-alpha.1")), Some(Channel::Alpha));
        assert_eq!(Channel::of(&v("1.1.0-beta.3")), Some(Channel::Beta));
        assert_eq!(Channel::of(&v("1.0.0-rc.1")), None);
    }

    #[test]
    fn the_latest_on_a_channel_is_strictly_that_channels() {
        let releases = [
            release("v1.0.0"),
            release("v1.1.0-alpha.2"),
            release("v1.1.0-beta.1"),
            release("v2.0.0"),
            release("not-a-version"),
            Release {
                tag: "v1.1.0-alpha.3".into(),
                draft: true,
            },
        ];
        assert_eq!(latest_on(Channel::Stable, &releases), Some(v("2.0.0")));
        assert_eq!(latest_on(Channel::Beta, &releases), Some(v("1.1.0-beta.1")));
        // a newer stable never counts for alpha, and a draft is not released
        assert_eq!(
            latest_on(Channel::Alpha, &releases),
            Some(v("1.1.0-alpha.2"))
        );
        assert_eq!(latest_on(Channel::Alpha, &[release("v1.0.0")]), None);
    }

    #[test]
    fn the_chosen_channel_wins_else_the_installed_versions() {
        assert_eq!(
            effective(Some(Channel::Beta), &v("1.0.0-alpha.1")),
            Channel::Beta
        );
        assert_eq!(effective(None, &v("1.0.0-alpha.1")), Channel::Alpha);
        assert_eq!(effective(None, &v("1.0.0")), Channel::Stable);
        assert_eq!(effective(None, &v("1.0.0-rc.1")), Channel::Stable);
    }

    #[test]
    fn the_chosen_channel_round_trips_and_a_corrupt_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hpy/channel.toml");
        assert_eq!(read(&path), None);
        write(&path, Channel::Alpha).unwrap();
        assert_eq!(read(&path), Some(Channel::Alpha));
        std::fs::write(&path, "channel = \"nightly\"").unwrap();
        assert_eq!(read(&path), None);
    }
}
