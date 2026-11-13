// hpy-atproto/src/admin.rs: a HappyView instance's admin API, as `hpy` talks
// to it: signed in with the session `hpy happyview login` registered, or with
// an `hv_` API key (for CI) sent as a bearer token, and the calls a deploy makes.
import { type Json, sortKeys } from "../core/output.ts";
import {
  array,
  bool,
  fromValue,
  optional,
  str as strDe,
  struct,
  withDefault,
} from "../core/serde-json.ts";
import type { Credential } from "./credential.ts";
import { AtprotoError } from "./error.ts";
import { request, statusText, transportError } from "./http.ts";

/** instance.rs `KEY_VAR`, repeated here so admin.ts does not import instance.ts. */
const KEY_VAR = "HPY_HV_API_KEY";

/** How a request proves who sends it. */
type AdminAuth = { kind: "apiKey"; key: string } | { kind: "session"; cred: Credential };

/** A plugin as `GET /admin/plugins` lists it; only what a deploy compares. */
export interface InstalledPlugin {
  id: string;
  version: string;
  plugin_type: string;
  /** The registry project it was installed from; null for a URL or file install. */
  registry: InstalledFrom | null;
  /** What the installed version declares, by name. */
  capabilities: { declared: { name: string }[] };
}

export interface InstalledFrom {
  did: string | null;
  name: string | null;
  version_uri: string | null;
}

export const declaredCapabilities = (p: InstalledPlugin): string[] =>
  p.capabilities.declared.map((c) => c.name);

/**
 * admin/script_variables.rs: a variable as `GET /admin/script-variables` lists it. The masked
 * preview is left out: it is the same fixed mask for every variable.
 */
export interface ScriptVariable {
  key: string;
  /** The instance can't read the stored value with its current key, so setting it again is the only way to recover it. */
  unreadable: boolean;
  created_at: string | undefined;
  updated_at: string | undefined;
}

const SCRIPT_VARIABLE = struct("ScriptVariable", {
  key: strDe,
  unreadable: withDefault(bool, false),
  created_at: withDefault(optional(strDe), undefined),
  updated_at: withDefault(optional(strDe), undefined),
});

/** Something wrong with a project file, as the instance's loader says it. */
export interface ProjectProblem {
  path: string;
  line: number | null;
  message: string;
}

export function problemText(p: ProjectProblem): string {
  if (p.path === "") return p.message;
  return p.line !== null ? `${p.path}:${p.line}: ${p.message}` : `${p.path}: ${p.message}`;
}

/** The project an instance serves, as `GET /admin/project` answers. */
export interface DeployedProject {
  sha256: string;
  deployed_at: string | null;
  deployed_by: string | null;
  /** Why the stored project failed to build at the last boot; empty when it is served. */
  problems: ProjectProblem[];
}

/** What one kind of thing in the project gained, changed or lost. */
export interface Changes {
  added: string[];
  changed: string[];
  removed: string[];
}

export const changesEmpty = (c: Changes) =>
  c.added.length === 0 && c.changed.length === 0 && c.removed.length === 0;

/** What `PUT /admin/project` did, or on a dry run would do. */
export interface ProjectDeploy {
  sha256: string;
  dry_run: boolean;
  deployed_at: string | null;
  /** By kind (`lexicons`, `scripts`, …), in key order as a BTreeMap holds them. */
  changes: Record<string, Changes>;
  backfills: string[];
  warnings: ProjectProblem[];
}

/** Nothing in the project differs from what the instance serves. */
export const deployEmpty = (d: ProjectDeploy) =>
  Object.values(d.changes).every(changesEmpty) && d.backfills.length === 0;

/** What `getOptional` got. */
export type Optional =
  | { kind: "read"; value: Json }
  | { kind: "notServed" }
  | { kind: "notPermitted" };

interface Refusal {
  error: string | null;
  message: string | null;
  actionUrl: string | null;
  actionLabel: string | null;
  dependents: string[];
  problems: ProjectProblem[];
}

// serde's derive, by hand: a wrong type is an error; a missing defaulted field is its default.
class Shape extends Error {}
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Shape("expected an object");
  return v as Record<string, unknown>;
};
const str = (o: Record<string, unknown>, k: string): string => {
  if (typeof o[k] !== "string") throw new Shape(`missing field \`${k}\``);
  return o[k] as string;
};
const optStr = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Shape(`invalid type for \`${k}\``);
  return v;
};
const strs = (o: Record<string, unknown>, k: string): string[] => {
  const v = o[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new Shape(`invalid type for \`${k}\``);
  return v as string[];
};
const list = <T>(o: Record<string, unknown>, k: string, f: (v: unknown) => T): T[] => {
  const v = o[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Shape(`invalid type for \`${k}\``);
  return v.map(f);
};

function problem(v: unknown): ProjectProblem {
  const o = obj(v);
  const line = o.line;
  if (line !== undefined && line !== null && !(Number.isInteger(line) && (line as number) >= 0))
    throw new Shape("invalid type for `line`");
  return {
    path: optStr(o, "path") ?? "",
    line: (line as number | undefined) ?? null,
    message: str(o, "message"),
  };
}

function installedPlugin(v: unknown): InstalledPlugin {
  const o = obj(v);
  const reg = o.registry;
  const caps = o.capabilities === undefined || o.capabilities === null ? {} : obj(o.capabilities);
  return {
    id: str(o, "id"),
    version: str(o, "version"),
    plugin_type: str(o, "plugin_type"),
    registry:
      reg === undefined || reg === null
        ? null
        : (() => {
            const r = obj(reg);
            return {
              did: optStr(r, "did"),
              name: optStr(r, "name"),
              version_uri: optStr(r, "version_uri"),
            };
          })(),
    capabilities: { declared: list(caps, "declared", (c) => ({ name: str(obj(c), "name") })) },
  };
}

function changes(v: unknown): Changes {
  const o = obj(v);
  return { added: strs(o, "added"), changed: strs(o, "changed"), removed: strs(o, "removed") };
}

function projectDeploy(v: unknown): ProjectDeploy {
  const o = obj(v);
  if (typeof o.dry_run !== "boolean") throw new Shape("missing field `dry_run`");
  const raw = o.changes === undefined || o.changes === null ? {} : obj(o.changes);
  const ch: Record<string, Changes> = {};
  for (const k of Object.keys(raw).sort()) ch[k] = changes(raw[k]);
  return {
    sha256: str(o, "sha256"),
    dry_run: o.dry_run,
    deployed_at: optStr(o, "deployed_at"),
    changes: ch,
    backfills: strs(o, "backfills"),
    warnings: list(o, "warnings", problem),
  };
}

/** `serde_json::from_slice(..).unwrap_or_default()`: any shape that does not fit is no refusal at all. */
function refusal(bytes: Uint8Array): Refusal {
  const none: Refusal = {
    error: null,
    message: null,
    actionUrl: null,
    actionLabel: null,
    dependents: [],
    problems: [],
  };
  try {
    const o = obj(JSON.parse(Buffer.from(bytes).toString()));
    return {
      error: optStr(o, "error"),
      message: optStr(o, "message"),
      actionUrl: optStr(o, "actionUrl"),
      actionLabel: optStr(o, "actionLabel"),
      dependents: strs(o, "dependents"),
      problems: list(o, "problems", problem),
    };
  } catch {
    return none;
  }
}

type Body = { kind: "none" } | { kind: "json"; value: Json } | { kind: "gzip"; bytes: Uint8Array };

/** One path segment, as `form_urlencoded::byte_serialize` writes it. */
function segment(s: string): string {
  return new URLSearchParams({ x: s }).toString().slice(2);
}

export class Admin {
  readonly base: string;
  readonly #auth: AdminAuth;

  private constructor(base: string, auth: AdminAuth) {
    this.base = base.replace(/\/+$/, "");
    this.#auth = auth;
  }

  /** Signed in with an API key. */
  static withKey(base: string, key: string): Admin {
    return new Admin(base, { kind: "apiKey", key });
  }

  /** Signed in as the user whose session `cred` holds, on the instance it was registered with. */
  static withSession(cred: Credential): Admin {
    return new Admin(cred.registry, { kind: "session", cred });
  }

  /** The key is a secret; never print it. */
  toString(): string {
    return `Admin { base: ${JSON.stringify(this.base)}, .. }`;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /** Sends one admin request; only a request that never got an answer is an error here. */
  async #request(
    what: string,
    method: string,
    path: string,
    body: Body,
    ifMatch: string | null = null,
  ): Promise<{ status: number; bytes: Uint8Array }> {
    const url = `${this.base}/admin${path}`;
    const headers: Record<string, string> = {};
    if (this.#auth.kind === "apiKey") {
      headers.authorization = `Bearer ${this.#auth.key}`;
    } else {
      const c = this.#auth.cred;
      headers.authorization = `DPoP ${c.accessToken}`;
      headers.dpop = await c.dpopKey.proof(method, url, c.accessToken, null);
      headers["x-client-key"] = c.clientKey;
    }
    let payload: string | Uint8Array | undefined;
    if (body.kind === "json") {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(sortKeys(body.value));
    } else if (body.kind === "gzip") {
      headers["content-type"] = "application/gzip";
      payload = body.bytes;
    }
    if (ifMatch !== null) headers["if-match"] = `"${ifMatch}"`;
    let resp: Response;
    try {
      resp = await request(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        timeout: 120,
      });
    } catch (e) {
      throw AtprotoError.other(`could not reach ${this.base} (${what}): ${transportError(e)}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      throw AtprotoError.other(transportError(e));
    }
    return { status: resp.status, bytes };
  }

  /** The JSON body of a successful answer (null for an empty one), or the refusal as an error. */
  #answer(what: string, status: number, bytes: Uint8Array): Json {
    if (status >= 200 && status < 300) {
      if (bytes.length === 0) return null;
      try {
        return JSON.parse(Buffer.from(bytes).toString()) as Json;
      } catch (e) {
        throw AtprotoError.other(
          `${this.base} answered ${what} with something unreadable: ${(e as Error).message}`,
        );
      }
    }
    throw this.#refused(what, status, refusal(bytes));
  }

  async #send(what: string, method: string, path: string, body?: Json): Promise<Json> {
    const { status, bytes } = await this.#request(
      what,
      method,
      path,
      body === undefined ? { kind: "none" } : { kind: "json", value: body },
    );
    return this.#answer(what, status, bytes);
  }

  #unreadable(what: string, e: unknown): AtprotoError {
    return AtprotoError.other(`${this.base} ${what}: ${(e as Error).message}`);
  }

  /** The project the instance serves; null when none was ever deployed. */
  async project(): Promise<DeployedProject | null> {
    const what = "reading the deployed project";
    const { status, bytes } = await this.#request(what, "GET", "/project", { kind: "none" });
    if (status === 404) {
      if (refusal(bytes).error === "NoProject") return null;
      throw AtprotoError.other(
        `${this.base} has no project deploys; it runs a HappyView too old for \`hpy happyview deploy\``,
      );
    }
    const value = this.#answer(what, status, bytes);
    try {
      const o = obj(value);
      const err = o.error === undefined || o.error === null ? null : obj(o.error);
      return {
        sha256: str(o, "sha256"),
        deployed_at: optStr(o, "deployed_at"),
        deployed_by: optStr(o, "deployed_by"),
        problems: err ? list(err, "problems", problem) : [],
      };
    } catch (e) {
      throw this.#unreadable("described its project unreadably", e);
    }
  }

  /**
   * Sends a project bundle. `seen` is the sha256 of the project this deploy
   * compared against, so one deployed meanwhile is not overwritten.
   */
  async deployProject(
    bundle: Uint8Array,
    dryRun: boolean,
    seen: string | null,
  ): Promise<ProjectDeploy> {
    const what = dryRun ? "checking the project" : "deploying the project";
    const { status, bytes } = await this.#request(
      what,
      "PUT",
      `/project?dry_run=${dryRun}`,
      { kind: "gzip", bytes: bundle },
      seen,
    );
    const value = this.#answer(what, status, bytes);
    try {
      return projectDeploy(value);
    } catch (e) {
      throw this.#unreadable(`answered ${what} unreadably`, e);
    }
  }

  #refused(what: string, status: number, r: Refusal): AtprotoError {
    const base = this.base;
    const said = (needle: string) => [r.error, r.message].some((m) => m?.includes(needle));
    if (status === 401) {
      return this.#auth.kind === "session"
        ? AtprotoError.loginRequired(
            `your sign-in to ${base} has expired or was revoked; run \`hpy hv login --url ${base}\``,
          )
        : AtprotoError.loginRequired(
            `${base} refused the API key; create a new one in its dashboard and set ${KEY_VAR} (or pipe it to \`hpy hv login --url ${base} --key-stdin\`)`,
          );
    }
    // Before the 403 arms: a limit isn't a missing permission.
    if (r.error === "LimitReached") {
      const why =
        r.message !== null && r.message.trim() !== ""
          ? r.message
          : "the instance's limits don't allow it";
      let message = `${base} refused ${what}: ${why.trim()}`;
      if (r.actionLabel !== null && r.actionUrl !== null) {
        const label = r.actionLabel.trim();
        const url = r.actionUrl.trim();
        if (label !== "" && (url.startsWith("https://") || url.startsWith("http://")))
          message += `\n  ${label}: ${url}`;
      }
      return AtprotoError.other(message);
    }
    if (r.error === "InvalidProject") {
      let message = `${base} refused the project`;
      if (r.message !== null) message = `${message}: ${r.message}`;
      for (const p of r.problems) message += `\n  • ${problemText(p)}`;
      return AtprotoError.registry("InvalidProject", message);
    }
    if (status === 412)
      return AtprotoError.other(
        `the project on ${base} changed since this deploy read it; run the deploy again to see what it would change now`,
      );
    if (status === 409 && r.error === "ProjectFromFile")
      return AtprotoError.other(
        `${base} takes its project from a directory (HAPPYVIEW_PROJECT), so a deploy can't change it; update that directory instead`,
      );
    if (status === 413)
      return AtprotoError.other(
        `the project is too large for ${base} to accept; it takes bundles up to 50 MB compressed`,
      );
    if (status === 403) {
      if (said("not a user"))
        return AtprotoError.other(
          `your account isn't an admin of ${base}; ask its owner to add you in its dashboard`,
        );
      if (said("API client's session"))
        return AtprotoError.loginRequired(
          `${base} doesn't accept this sign-in for deploying; run \`hpy hv login --url ${base}\``,
        );
      if (said("did not grant dev.happyview.adminFull"))
        return AtprotoError.loginRequired(
          `your sign-in to ${base} didn't grant managing it; run \`hpy hv login --url ${base}\` and approve managing your HappyView instances`,
        );
      const why = r.message ?? r.error;
      return this.#auth.kind === "session"
        ? AtprotoError.other(
            `${base} refused ${what}: ${why ?? "your account is not allowed to"}. Ask its owner to give your account that permission in its dashboard`,
          )
        : AtprotoError.other(
            `${base} refused ${what}: ${why ?? "the API key's user is not allowed to"}. Give the API key that permission in the dashboard, or create one that has it`,
          );
    }
    let detail =
      r.error !== null && r.message !== null
        ? `${r.error}: ${r.message}`
        : (r.error ?? r.message ?? `HTTP ${statusText(status)}`);
    if (r.dependents.length > 0) detail = `${detail} (${r.dependents.join(", ")} depend on it)`;
    return AtprotoError.other(`${base} refused ${what} (${detail})`);
  }

  /** Any admin read, as the JSON it answers; `path` is under `/admin`. */
  async get(what: string, path: string): Promise<Json> {
    return this.#send(what, "GET", path);
  }

  /** `get`, answering null rather than an error on a 403 that is not a reached limit. */
  async getIfPermitted(what: string, path: string): Promise<Json | null> {
    const { status, bytes } = await this.#request(what, "GET", path, { kind: "none" });
    if (status === 403 && refusal(bytes).error !== "LimitReached") return null;
    return this.#answer(what, status, bytes);
  }

  /** `get` for a read an older instance may not serve: 404 is notServed, 403 notPermitted. */
  async getOptional(what: string, path: string): Promise<Optional> {
    const { status, bytes } = await this.#request(what, "GET", path, { kind: "none" });
    if (status === 404) return { kind: "notServed" };
    if (status === 403 && refusal(bytes).error !== "LimitReached") return { kind: "notPermitted" };
    return { kind: "read", value: this.#answer(what, status, bytes) };
  }

  /** Every installed plugin. */
  async plugins(): Promise<InstalledPlugin[]> {
    const out = await this.#send("listing plugins", "GET", "/plugins");
    try {
      return list(obj(out), "plugins", installedPlugin);
    } catch (e) {
      throw this.#unreadable("listed its plugins unreadably", e);
    }
  }

  /**
   * Installs one exact version of a registry project, accepting `capabilities`
   * on the operator's behalf. The accepted set is sent even when empty: an
   * absent `accepted_capabilities` reads as accepting nothing.
   */
  async install(
    did: string,
    name: string,
    version: string,
    capabilities: string[],
  ): Promise<InstalledPlugin> {
    const out = await this.#send(`installing ${name} ${version}`, "POST", "/plugins", {
      registry: { did, name, version },
      accepted_capabilities: capabilities,
    });
    try {
      return installedPlugin(out);
    } catch (e) {
      throw this.#unreadable(`answered the install of ${name} unreadably`, e);
    }
  }

  /** Moves an installed registry plugin to one exact version, accepting `capabilities` for it. */
  async reload(id: string, version: string, capabilities: string[]): Promise<void> {
    await this.#send(`moving ${id} to ${version}`, "POST", `/plugins/${segment(id)}/reload`, {
      registry: { version },
      accepted_capabilities: capabilities,
    });
  }

  /** Uninstalls a plugin; refused while others depend on it. */
  async remove(id: string): Promise<void> {
    await this.#send(`removing ${id}`, "DELETE", `/plugins/${segment(id)}`);
  }

  // admin/script_variables.rs. A variable's value is a secret: it goes out in the body of the
  // request that sets it and nowhere else, and the errors are built from the call's name and
  // the instance's answer, never from what was sent.

  /** Every variable the instance has, without its value. */
  async scriptVariables(): Promise<ScriptVariable[]> {
    const out = await this.#send("listing script variables", "GET", "/script-variables");
    try {
      return fromValue(out, array(SCRIPT_VARIABLE)) as ScriptVariable[];
    } catch (e) {
      throw AtprotoError.other(
        `${this.base} listed its script variables unreadably: ${(e as Error).message}`,
      );
    }
  }

  /** Creates the variable `key`, or replaces its value. */
  async setScriptVariable(key: string, value: string): Promise<void> {
    await this.#send(`setting ${key}`, "POST", "/script-variables", { key, value });
  }
}
