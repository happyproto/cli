// The Rust types the oracle uses (oracle/src/main.rs, which copies or imports hpy's), as
// serde-json.ts decoders and toml.ts encoders, for the types not yet ported into src. The hpy
// ones mirror the structs in crates/hpy-atproto/src/settings.rs and
// crates/hpy/src/{channel,update,modules}.rs; hpy-plugin's config.rs and hpy-project's are in
// src.
import {
  array,
  bool,
  type Decoder,
  f64,
  field,
  i64,
  map,
  optional,
  str,
  struct,
  taggedEnum,
  u8,
  u32,
  unitEnum,
  unitVariant,
  untagged,
  variant,
  withDefault,
} from "../../../src/core/serde-json.ts";
import {
  type Encoder,
  encArray,
  encBool,
  encFloat,
  encInt,
  encMap,
  encOption,
  encStr,
  encStruct,
  encUnitVariant,
  isEmpty,
  isNone,
  tomlValue,
} from "../../../src/core/toml.ts";

const opt = <T>(d: Decoder<T>) => withDefault(optional(d), undefined);

// --- hpy-plugin config.rs ---

export {
  encProjectConfig,
  HPY_TOML as hpyToml,
  IMAGE_CONFIG as imageConfig,
  type ImageConfig,
  PROJECT_CONFIG as projectConfig,
  type ProjectConfig,
} from "../../../src/plugin/config.ts";

import {
  AUTHOR as author,
  CONTACT as contact,
  encAuthor,
  encContact,
  encImageConfig,
  encProjectConfig,
  type ImageConfig,
  type ProjectConfig,
} from "../../../src/plugin/config.ts";
import type { Author, Contact } from "../../../src/plugin/project.ts";

type SectionSource = string | { text: string };
type SectionsConfig = {
  description?: SectionSource;
  installation?: SectionSource;
  security?: SectionSource;
};
type ReleaseConfig = {
  license?: string;
  changelog?: string;
  requires: Map<string, string> | Record<string, string>;
  sections: SectionsConfig;
  artifacts: { banner?: ImageConfig; screenshots: ImageConfig[] };
};
type HpyToml = {
  project?: ProjectConfig;
  release?: ReleaseConfig;
  build?: { command?: string; wasm?: string };
};

const encSectionSource: Encoder<SectionSource> = (v) =>
  typeof v === "string" ? encStr(v) : encStruct<{ text: string }>("Inline", { text: encStr })(v);
const encSections = encStruct<SectionsConfig>("SectionsConfig", {
  description: { enc: encOption(encSectionSource), skipIf: isNone },
  installation: { enc: encOption(encSectionSource), skipIf: isNone },
  security: { enc: encOption(encSectionSource), skipIf: isNone },
});
const sectionsEmpty = (s: SectionsConfig): boolean =>
  isNone(s.description) && isNone(s.installation) && isNone(s.security);
export const encHpyToml = encStruct<HpyToml>("HpyToml", {
  project: { enc: encOption(encProjectConfig), skipIf: isNone },
  release: {
    enc: encOption(
      encStruct<ReleaseConfig>("ReleaseConfig", {
        license: { enc: encOption(encStr), skipIf: isNone },
        changelog: { enc: encOption(encStr), skipIf: isNone },
        requires: { enc: encMap(encStr), skipIf: isEmpty },
        sections: { enc: encSections, skipIf: sectionsEmpty },
        artifacts: encStruct<ReleaseConfig["artifacts"]>("ArtifactsConfig", {
          banner: { enc: encOption(encImageConfig), skipIf: isNone },
          screenshots: { enc: encArray(encImageConfig), skipIf: isEmpty },
        }),
      }),
    ),
    skipIf: isNone,
  },
  build: {
    enc: encOption(
      encStruct<{ command?: string; wasm?: string }>("BuildConfig", {
        command: encOption(encStr),
        wasm: encOption(encStr),
      }),
    ),
    skipIf: isNone,
  },
});

// --- hpy modules.rs, hpy-atproto settings.rs ---
// (hpy-project config.rs RawToml and lock.rs are the real ones, in src/project.)

export const modulesFile = struct("ModulesFile", {
  modules: withDefault(map(struct("ModuleEntry", { language: str, path: str })), () => new Map()),
});
export const settingsFile = struct("SettingsFile", {
  registry: withDefault(
    struct("RegistrySection", { url: optional(str), client_key: optional(str) }),
    () => ({}),
  ),
  oauth: withDefault(
    struct("OAuthSection", {
      client_id: optional(str),
      scope: optional(str),
      redirect: optional(str),
      client_auth: optional(str),
    }),
    () => ({}),
  ),
  credentials: withDefault(struct("CredentialsSection", { store: optional(str) }), () => ({})),
});

// --- hpy channel.rs, update.rs, network/access.rs, commands/profile.rs ---

export const channel = unitEnum("Channel", ["stable", "beta", "alpha"]);
export const channelFile = struct("ChannelFile", { channel });
export const updateState = struct("UpdateState", { last_checked: str });
export const accessRecord = struct("AccessRecord", { ca_sha256: str });

export const encChannelFile = encStruct<{ channel: string }>("ChannelFile", {
  channel: encUnitVariant,
});
export const encUpdateState = encStruct<{ last_checked: string }>("UpdateState", {
  last_checked: encStr,
});
export const encAccessRecord = encStruct<{ ca_sha256: string }>("AccessRecord", {
  ca_sha256: encStr,
});

// commands/profile.rs `Editable` is the real one.
export { EDITABLE as editable, encEditable } from "../../../src/commands/profile.ts";

// --- oracle-only types ---

export const kitchen = struct("Kitchen", {
  s: str,
  n: u32,
  i: i64,
  f: f64,
  b: bool,
  v: withDefault(array(str), []),
  m: withDefault(map(u32), () => new Map()),
  o: optional(str),
  e: withDefault(channel, "stable"),
  u8v: opt(u8),
  renamed: field(optional(str), { rename: "renamed-key", default: undefined }),
});
type Kitchen = {
  s: string;
  n: number;
  i: number;
  f: number;
  b: boolean;
  v: string[];
  m: Record<string, number>;
  o?: string;
  e: string;
  u8v?: number;
  renamed?: string;
};
export const encKitchen = encStruct<Kitchen>("Kitchen", {
  s: encStr,
  n: encInt,
  i: encInt,
  f: encFloat,
  b: encBool,
  v: encArray(encStr),
  m: encMap(encInt),
  o: encOption(encStr),
  e: encUnitVariant,
  u8v: encOption(encInt),
  renamed: { enc: encOption(encStr), rename: "renamed-key" },
});

export const strict = struct(
  "Strict",
  { name: str, count: withDefault(u32, 0) },
  { denyUnknownFields: true },
);
export const shape = taggedEnum("Shape", "kind", {
  circle: variant("Circle", { r: f64 }),
  square: variant("Square", { side: u32 }),
  empty: unitVariant("Empty"),
});
export const shapeHolder = struct("ShapeHolder", { shape, shapes: withDefault(array(shape), []) });
type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number } | { kind: "empty" };
const encShape: Encoder<Shape> = (s) => {
  switch (s.kind) {
    case "circle":
      return encStruct<{ kind: string; r: number }>("Shape", { kind: encStr, r: encFloat })(s);
    case "square":
      return encStruct<{ kind: string; side: number }>("Shape", { kind: encStr, side: encInt })(s);
    case "empty":
      return encStruct<{ kind: string }>("Shape", { kind: encStr })(s);
  }
};
export const encShapeHolder = encStruct<{ shape: Shape; shapes: Shape[] }>("ShapeHolder", {
  shape: encShape,
  shapes: encArray(encShape),
});

export const inner = struct("Inner", { a: str, b: opt(i64) });
export const nested = struct("Nested", { outer: inner, list: withDefault(array(inner), []) });
type Inner = { a: string; b?: number };
const encInner = encStruct<Inner>("Inner", { a: encStr, b: encOption(encInt) });
export const encNested = encStruct<{ outer: Inner; list: Inner[] }>("Nested", {
  outer: encInner,
  list: encArray(encInner),
});

export const bare = struct("Bare", { value: tomlValue });
