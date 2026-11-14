// commands/happyview/pull/wire.rs: the admin API's answers, as `pull` reads them. Built from
// HappyView's own handlers: v2 is `origin/beta` (v2.17.0) and v3 is `origin/alpha`, both in
// `src/admin/`. Every field either version may leave out is optional, and fields neither needs
// are not named, so an answer with more in it still reads.
import {
  array,
  bool,
  i64,
  type Node,
  node,
  optional,
  str,
  struct,
  withDefault,
} from "../../core/serde-json.ts";

const optStr = withDefault(optional(str), undefined);

/** A row of `GET /admin/lexicons` (`LexiconSummary`), and of `GET /admin/lexicons/{id}`, which adds `lexicon_json`. */
export interface Lexicon {
  id: string;
  /** `record`, `query`, `procedure`, … as both versions name it. */
  lexicon_type: string | undefined;
  backfill: boolean;
  token_cost: number | bigint | undefined;
  /** v3 only; v2 indexes every record lexicon. */
  indexed: boolean | undefined;
  /** `manual` or `network` in both; v3 also says `project`, and repeats it as `layer`. */
  source: string | undefined;
  layer: string | undefined;
  /** v2 only: what the codemod needs to name a query's collection. */
  target_collection: string | undefined;
  /** Only in the single-lexicon answer. */
  lexicon_json: Node | undefined;
}

export const LEXICON = struct("Lexicon", {
  id: str,
  lexicon_type: optStr,
  backfill: withDefault(bool, false),
  token_cost: withDefault(optional(i64), undefined),
  indexed: withDefault(optional(bool), undefined),
  source: optStr,
  layer: optStr,
  target_collection: optStr,
  lexicon_json: withDefault(optional(node), undefined),
});

/** Fetched from the network, so the project names it rather than carrying a copy. */
export const isNetwork = (l: Lexicon) => (l.layer ?? l.source) === "network";

/** A compiled module's handler (`ModuleRow`); v3 only. */
export interface ModuleRow {
  module: string;
  path: string;
  handler: string;
}

const MODULE_ROW = struct("ModuleRow", {
  module: str,
  path: str,
  handler: withDefault(str, ""),
});

/** A row of `GET /admin/scripts` (`ScriptResponse`). */
export interface Script {
  /** The trigger, e.g. `xrpc.query:com.example.hello`. */
  id: string;
  script_type: string;
  body: string;
  description: string | undefined;
  outbound_xrpcs: string[] | undefined;
  /** v3: the project file, for a project script. */
  path: string | undefined;
  /** v3: set for a compiled module's handler, which has no body. */
  module: ModuleRow | undefined;
}

export const SCRIPT = struct("Script", {
  id: str,
  script_type: withDefault(str, "lua"),
  body: withDefault(str, ""),
  description: optStr,
  outbound_xrpcs: withDefault(optional(array(str)), undefined),
  path: optStr,
  module: withDefault(optional(MODULE_ROW), undefined),
});

/** A row of `GET /admin/scripts/modules` (`ModuleSourceResponse`): a file under `src/` that scripts import. */
export interface ModuleSource {
  id: string;
  /** Project-relative and `/`-separated. */
  path: string;
  source: string;
}

export const MODULE_SOURCE = struct("ModuleSource", { id: str, path: str, source: str });

/** `GET /admin/script-variables`. Only the key is read. */
export const VARIABLE = struct("Variable", { key: str });

const SECRET = struct("Secret", { key: str });

/** `registry` on a v3 plugin (`PluginRegistryStatus`). */
export interface PluginRegistry {
  did: string | undefined;
  name: string | undefined;
  /** Undefined when the install is pinned to its version. */
  channel: string | undefined;
}

const PLUGIN_REGISTRY = struct("PluginRegistry", { did: optStr, name: optStr, channel: optStr });

/** A plugin of `GET /admin/plugins` (`PluginSummary`, under `plugins`). */
export interface Plugin {
  id: string;
  version: string;
  /** `registry`, `url` or `file`. */
  source: string | undefined;
  required_secrets: { key: string }[];
  /** v3 only. */
  registry: PluginRegistry | undefined;
  plugin_type: string | undefined;
  namespace: string | undefined;
}

const PLUGIN = struct("Plugin", {
  id: str,
  version: withDefault(str, ""),
  source: optStr,
  required_secrets: withDefault(array(SECRET), () => []),
  registry: withDefault(optional(PLUGIN_REGISTRY), undefined),
  plugin_type: optStr,
  namespace: optStr,
});

export const PLUGIN_LIST = struct("PluginList", {
  plugins: withDefault(array(PLUGIN), () => []),
});

/** `GET /admin/settings` (`SettingEntry`). */
export const SETTING = struct("Setting", { key: str, value: withDefault(str, "") });

/** `GET /admin/users` (`UserSummary`). */
export const USER = struct("User", { did: str, is_super: withDefault(bool, false) });

/** `GET /admin/labelers` (`LabelerSummary`). */
export const LABELER = struct("Labeler", { did: str, status: withDefault(str, "") });

/** `GET /admin/network-lexicons` (`NetworkLexiconSummary`). */
export const NETWORK_LEXICON = struct("NetworkLexicon", { nsid: str });
