// crates/hpy/src/channel.rs: release channels. Every release belongs to exactly one: a plain
// version to `stable`, `-beta.N` to `beta`, `-alpha.N` to `alpha` (semantic-release cuts them
// from the `main`, `beta` and `alpha` branches). Channels are strict: a channel offers only its
// own releases, never a newer one from another.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readToString, toIoError, writeString } from "./core/io.ts";
import { Version } from "./core/semver.ts";
import {
  bool,
  type Decoder,
  field,
  str,
  struct,
  unitEnum,
  withDefault,
} from "./core/serde-json.ts";
import { encStruct, encUnitVariant, fromStr, toTomlString } from "./core/toml.ts";
import { type Channel, parseChannel } from "./values.ts";

export { type Channel, parseChannel, Version };

/** The channel a version was released on, or `undefined` for a prerelease no channel ships (`-rc.1`). */
export function channelOf(version: Version): Channel | undefined {
  if (version.pre.isEmpty()) return "stable";
  const first = version.pre.asStr().split(".")[0];
  if (first === "beta") return "beta";
  if (first === "alpha") return "alpha";
  return undefined;
}

export function isPrerelease(channel: Channel): boolean {
  return channel !== "stable";
}

/** A GitHub release, as much of it as choosing one needs. */
export interface Release {
  tag: string;
  draft: boolean;
}

export const RELEASE: Decoder<Release> = struct("Release", {
  tag: field(str, { rename: "tag_name" }),
  draft: withDefault(bool, false),
}) as Decoder<Release>;

/** `str::trim_start_matches('v')`. */
function trimV(s: string): string {
  let i = 0;
  while (s[i] === "v") i++;
  return s.slice(i);
}

/** The newest published release on `channel`. */
export function latestOn(channel: Channel, releases: readonly Release[]): Version | undefined {
  let best: Version | undefined;
  for (const r of releases) {
    if (r.draft) continue;
    let v: Version;
    try {
      v = Version.parse(trimV(r.tag));
    } catch {
      continue;
    }
    if (channelOf(v) !== channel) continue;
    // `Iterator::max` keeps the last of equal maxima.
    if (best === undefined || Version.compare(v, best) >= 0) best = v;
  }
  return best;
}

/** The channel to follow: the one chosen with `hpy channel`, else the running version's, else stable. */
export function effective(chosen: Channel | undefined, current: Version): Channel {
  return chosen ?? channelOf(current) ?? "stable";
}

// The file `hpy channel` keeps its choice in.
export const CHANNEL = unitEnum("Channel", ["stable", "beta", "alpha"]) as Decoder<Channel>;
export const CHANNEL_FILE = struct("File", { channel: CHANNEL }) as Decoder<{ channel: Channel }>;
export const encChannelFile = encStruct<{ channel: Channel }>("File", {
  channel: encUnitVariant,
});

/** The channel chosen with `hpy channel`, if any. */
export function read(path: string): Channel | undefined {
  let text: string;
  try {
    text = readToString(path);
  } catch {
    return undefined;
  }
  try {
    return fromStr(text, CHANNEL_FILE).channel;
  } catch {
    return undefined;
  }
}

/** Throws an `IoError`. */
export function write(path: string, channel: Channel): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    throw toIoError(e);
  }
  writeString(path, toTomlString({ channel }, encChannelFile));
}
