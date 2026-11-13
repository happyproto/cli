// hpy-project/src/lock.rs: `happyview.lock`: the exact plugin versions a project runs, and the
// CIDs that pin each one's records and bytes. Type mapping as in ./config.ts.
import { readToString, toIoError } from "../core/io.ts";
import { rustJoin } from "../core/paths.ts";
import {
  array,
  compareKeys,
  type Decoder,
  optional,
  str,
  struct,
  u32,
  unitEnum,
  withDefault,
} from "../core/serde-json.ts";
import {
  type Encoder,
  encArray,
  encInt,
  encOption,
  encStr,
  encStruct,
  encUnitVariant,
  fromStr,
  isEmpty,
  isNone,
  toTomlString,
} from "../core/toml.ts";
import { TRACKS } from "../plugin/nsid.ts";
import { Problem } from "../plugin/problem.ts";
import { isProjectName, parseProjectUri, versionUri } from "../plugin/validate.ts";
import {
  entryProjectUri,
  PluginKind,
  type ProjectToml,
  tomlProblem,
  writeIfChanged,
} from "./config.ts";

export const LOCK_FILE = "happyview.lock";
export const LOCK_VERSION = 2;
const HEADER = "# Written by hpy from happyview.toml. Commit it; don't edit it by hand.\n\n";
/**
 * Version 1 named packages and checksums from the registry before it moved to
 * `software.release`; none of that can be looked up any more.
 */
const PREDATES_REGISTRY =
  "happyview.lock predates the software.release registry; delete it and run hpy happyview check";

export interface LockedHappyview {
  version: string;
}

export interface LockedPlugin {
  /** The project's name, which HappyView loads the plugin by. */
  id: string;
  kind: PluginKind;
  keys: string[];
  /** The `software.release.project` URI, so a later resolution never looks the plugin up by name again. */
  project: string;
  version: string;
  /**
   * The channel `happyview.toml` followed when this was locked; absent for an exact version pin
   * and for a plugin only others require. A changed pin is drift, while a channel moving on is
   * not: `check` and `dev` stay reproducible until `hpy happyview add` re-resolves it.
   */
  channel?: string | undefined;
  version_uri: string;
  /** The `software.release.manifest` record's CID: a published version whose manifest changes is no longer the one locked. */
  manifest_cid: string;
  /** The module's blob CID, which its downloaded bytes must hash to. */
  package_cid: string;
  /** The published `manifest.json`'s blob CID, likewise. */
  manifest_blob_cid: string;
  dependencies: string[];
  /**
   * The capabilities this exact version's manifest declares, recorded so a deploy accepts what
   * was resolved and committed rather than whatever the registry serves when it runs. The
   * manifest is pinned by `manifest_cid`, so this is the set a reviewer of the lock saw.
   *
   * `undefined` in a lock written before hpy recorded them. A deploy refuses one rather than
   * guess: an empty list is a plugin that asks for nothing, which is exactly the claim that
   * must not be made on its behalf.
   */
  capabilities?: string[] | undefined;
}

// --- serde ---

const opt = <T>(d: Decoder<T>) => withDefault(optional(d), undefined);

export const PLUGIN_KIND: Decoder<PluginKind> = unitEnum("PluginKind", ["interpreter", "library"]);

export const LOCKED_PLUGIN: Decoder<LockedPlugin> = struct("LockedPlugin", {
  id: str,
  kind: PLUGIN_KIND,
  keys: withDefault(array(str), () => []),
  project: str,
  version: str,
  channel: opt(str),
  version_uri: str,
  manifest_cid: str,
  package_cid: str,
  manifest_blob_cid: str,
  dependencies: withDefault(array(str), () => []),
  capabilities: opt(array(str)),
});

export interface LockfileFields {
  version: number;
  happyview: LockedHappyview;
  plugins: LockedPlugin[];
}

export const LOCKFILE: Decoder<LockfileFields> = struct("Lockfile", {
  version: u32,
  happyview: struct("LockedHappyview", { version: str }),
  plugins: withDefault(array(LOCKED_PLUGIN), () => [], { rename: "plugin" }),
});

/** The version alone, read first: another format may have a shape this one cannot deserialize. */
export const LOCK_FORMAT: Decoder<{ version: number }> = struct("Format", { version: u32 });

export const encLockedPlugin: Encoder<LockedPlugin> = encStruct<LockedPlugin>("LockedPlugin", {
  id: encStr,
  kind: encUnitVariant,
  keys: encArray(encStr),
  project: encStr,
  version: encStr,
  channel: { enc: encOption(encStr), skipIf: isNone },
  version_uri: encStr,
  manifest_cid: encStr,
  package_cid: encStr,
  manifest_blob_cid: encStr,
  dependencies: encArray(encStr),
  capabilities: { enc: encOption(encArray(encStr)), skipIf: isNone },
});

export const encLockfile: Encoder<LockfileFields> = encStruct<LockfileFields>("Lockfile", {
  version: encInt,
  happyview: encStruct<LockedHappyview>("LockedHappyview", { version: encStr }),
  plugins: { enc: encArray(encLockedPlugin), rename: "plugin", skipIf: isEmpty },
});

/** `looks_like_cid`: enough of a CID's shape to catch a hand edit or a checksum from an older lock: base32 multibase, lowercase. */
function looksLikeCid(s: string): boolean {
  return s.length > 8 && s.startsWith("b") && /^[a-z2-7]*$/.test(s);
}

function clonePlugin(p: LockedPlugin): LockedPlugin {
  return {
    ...p,
    keys: [...p.keys],
    dependencies: [...p.dependencies],
    capabilities: p.capabilities === undefined ? undefined : [...p.capabilities],
  };
}

export class Lockfile implements LockfileFields {
  version: number;
  happyview: LockedHappyview;
  plugins: LockedPlugin[];

  constructor(fields: LockfileFields) {
    this.version = fields.version;
    this.happyview = fields.happyview;
    this.plugins = fields.plugins;
  }

  /** Throws `Problem`. */
  static parse(text: string): Lockfile {
    // The version is read alone first: another format may have a shape this one cannot
    // deserialize, and the useful answer is what to do.
    let format: { version: number };
    try {
      format = fromStr(text, LOCK_FORMAT);
    } catch (e) {
      throw tomlProblem(LOCK_FILE, e);
    }
    if (format.version === 1) throw new Problem("", PREDATES_REGISTRY);
    if (format.version !== LOCK_VERSION) {
      throw new Problem(
        LOCK_FILE,
        `is format ${format.version} and was written by a different hpy; upgrade hpy`,
      );
    }
    let lock: Lockfile;
    try {
      lock = new Lockfile(fromStr(text, LOCKFILE));
    } catch (e) {
      throw tomlProblem(LOCK_FILE, e);
    }
    lock.validate();
    return lock;
  }

  private validate(): void {
    for (const [i, p] of this.plugins.entries()) {
      const at = (field: string) => `${LOCK_FILE}: plugin[${i}].${field}`;
      if (!isProjectName(p.id)) {
        throw new Problem(at("id"), `\`${p.id}\` is not a project name`);
      }
      const parsed = parseProjectUri(p.project);
      if (parsed === null || parsed[1] !== p.id) {
        throw new Problem(
          at("project"),
          `\`${p.project}\` is not the software.release.project URI of \`${p.id}\``,
        );
      }
      const [did, name] = parsed;
      if (p.version_uri !== versionUri(did, name, p.version)) {
        throw new Problem(
          at("version_uri"),
          `\`${p.version_uri}\` is not the version URI of ${p.id}@${p.version}`,
        );
      }
      if (p.channel !== undefined) {
        if (!(TRACKS as readonly string[]).includes(p.channel)) {
          throw new Problem(
            at("channel"),
            `\`${p.channel}\` is not a channel (plugin \`${p.id}\`)`,
          );
        }
        if (p.keys.length === 0) {
          throw new Problem(
            at("channel"),
            `\`${p.id}\` is only required by other plugins, so no channel chose it`,
          );
        }
      }
      for (const [field, cid] of [
        ["manifest_cid", p.manifest_cid],
        ["package_cid", p.package_cid],
        ["manifest_blob_cid", p.manifest_blob_cid],
      ] as const) {
        if (!looksLikeCid(cid)) {
          throw new Problem(at(field), `\`${cid}\` is not a CID (plugin \`${p.id}\`)`);
        }
      }
      if (this.plugins.slice(0, i).some((q) => q.id === p.id)) {
        throw new Problem(at("id"), `\`${p.id}\` appears more than once`);
      }
    }
    for (const [i, p] of this.plugins.entries()) {
      const missing = p.dependencies.find((d) => !this.plugins.some((q) => q.id === d));
      if (missing !== undefined) {
        throw new Problem(
          `${LOCK_FILE}: plugin[${i}].dependencies`,
          `\`${p.id}\` needs \`${missing}\`, which is not in the lock`,
        );
      }
    }
  }

  /** `null` when there is no lock. Throws `Problem`. */
  static load(root: string): Lockfile | null {
    let text: string;
    try {
      text = readToString(rustJoin(root, LOCK_FILE));
    } catch (e) {
      const io = toIoError(e);
      if (io.code === "ENOENT") return null;
      throw new Problem(LOCK_FILE, `cannot be read: ${io.message}`);
    }
    return Lockfile.parse(text);
  }

  render(): string {
    const sorted: LockfileFields = {
      version: this.version,
      happyview: { ...this.happyview },
      plugins: this.plugins
        .map(clonePlugin)
        .sort((a, b) => compareKeys(a.id, b.id))
        .map((p) => ({
          ...p,
          keys: [...p.keys].sort(compareKeys),
          dependencies: [...p.dependencies].sort(compareKeys),
        })),
    };
    return `${HEADER}${toTomlString(sorted, encLockfile)}`;
  }

  /**
   * Writes beside the toml through a rename, so an interrupted write never leaves a truncated
   * lock for the next command to misread. Throws `IoError`.
   */
  write(root: string): void {
    writeIfChanged(rustJoin(root, LOCK_FILE), this.render());
  }

  findKey(kind: PluginKind, key: string): LockedPlugin | undefined {
    return this.plugins.find((p) => p.kind === kind && p.keys.includes(key));
  }

  /**
   * The plugins this lock records no capabilities for, which is every one of them in a lock
   * written before hpy recorded them.
   *
   * A deploy accepts the capabilities the lock records, so it cannot use such a lock at all;
   * `prepare` rewrites one for that reason even when it matches `happyview.toml`.
   */
  unrecordedCapabilities(): string[] {
    return this.plugins.filter((p) => p.capabilities === undefined).map((p) => p.id);
  }

  /**
   * Why this lock no longer describes `cfg`, one sentence each; empty when it still does. A
   * channel pin is satisfied by whatever it resolved to when locked: moving to the channel's
   * new head is an explicit update.
   */
  drift(cfg: ProjectToml): string[] {
    const out: string[] = [];
    const wanted = cfg.happyview.version;
    if (wanted !== undefined && wanted !== this.happyview.version) {
      out.push(
        `HappyView is locked at ${this.happyview.version} but happyview.toml asks for ${wanted}`,
      );
    }
    const requirements = cfg.requirements();
    for (const r of requirements) {
      const what = `${PluginKind.pluginType(r.kind)} \`${r.key}\``;
      const p = this.findKey(r.kind, r.key);
      if (p === undefined) {
        out.push(`${what} is not in the lock`);
        continue;
      }
      const wantedUri = entryProjectUri(r.entry);
      const locked = p.channel !== undefined ? `channel ${p.channel}` : `version ${p.version}`;
      const asked =
        r.entry.pin.kind === "channel"
          ? `channel ${r.entry.pin.channel}`
          : `version ${r.entry.pin.version}`;
      if (p.project !== wantedUri) {
        out.push(`${what} is locked to ${p.project}, but happyview.toml names ${wantedUri}`);
      } else if (locked !== asked) {
        const how = p.channel !== undefined ? "from" : "at";
        out.push(`${what} is locked ${how} ${locked}, but happyview.toml asks for ${asked}`);
      }
    }
    for (const p of this.plugins) {
      for (const key of p.keys) {
        if (!requirements.some((r) => r.kind === p.kind && r.key === key)) {
          out.push(
            `${PluginKind.pluginType(p.kind)} \`${key}\` is locked but no longer in happyview.toml`,
          );
        }
      }
    }
    return out;
  }
}
