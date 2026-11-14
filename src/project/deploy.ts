// crates/hpy/src/project/deploy.rs: what `hpy happyview deploy` changes on an instance to make
// it match the project, worked out before anything is sent.
import { declaredCapabilities, type InstalledPlugin } from "../atproto/admin.ts";
import { parseProjectUri } from "../plugin/validate.ts";
import type { LockedPlugin } from "./lock.ts";

/** A locked plugin, as the admin API names it. */
export interface Target {
  id: string;
  did: string;
  name: string;
  version: string;
  /**
   * The capabilities the lock pins this version as declaring, which the deploy accepts.
   * Undefined in a lock written before hpy recorded them; `run` refuses such a lock rather
   * than accept a set it is guessing.
   */
  capabilities: string[] | undefined;
  /**
   * Of those, the ones the installed version did not declare. Empty for a fresh install,
   * where nothing was granted before and the whole set is shown instead.
   */
  new_capabilities: string[];
}

/** One change to the instance's plugins. */
export type PluginStep =
  /** Not installed: install the locked version. */
  | { kind: "install"; target: Target }
  /** The locked project at another version: move it. */
  | { kind: "move"; target: Target; from: string }
  /** Installed under the same id from somewhere else (a URL, or another publisher): install the locked one over it. */
  | { kind: "replace"; target: Target; from: string }
  /** Installed, not in the lock, and `--prune-plugins` was given. */
  | { kind: "remove"; id: string };

/** `Display for PluginStep`. */
export function stepText(s: PluginStep): string {
  switch (s.kind) {
    case "install":
      return `install ${s.target.id} ${s.target.version}`;
    case "move":
      return `move ${s.target.id} ${s.from} → ${s.target.version}`;
    case "replace":
      return `replace ${s.target.id} ${s.target.version} (installed from ${s.from})`;
    case "remove":
      return `remove ${s.id}`;
  }
}

export interface PluginPlan {
  /** In the order to apply them: every install after what it depends on, removals last. */
  steps: PluginStep[];
  /** Locked plugins already at their locked version. */
  unchanged: string[];
  /** Installed plugins the lock doesn't list, left alone. */
  kept: string[];
}

/** The plugin types a project's lock manages; others (auth) are the instance's own business. */
const PROJECT_TYPES = ["interpreter", "library"];

/** BTreeMap<&str, _> order: by UTF-8 bytes, which is code-point order. */
const byCodePoint = (a: string, b: string) => {
  const x = [...a].map((c) => c.codePointAt(0) as number);
  const y = [...b].map((c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
};

/** A BTreeMap built from pairs: sorted by key, the last of a repeated key winning. */
function btree<T>(pairs: [string, T][]): [string, T][] {
  const m = new Map<string, T>();
  for (const [k, v] of pairs) m.set(k, v);
  return [...m].sort(([a], [b]) => byCodePoint(a, b));
}

/**
 * Locked plugins, each after the ones it depends on, otherwise by id. A dependency the lock
 * doesn't hold, or a cycle, is the lock's validation's to refuse; here it only must not loop.
 */
function dependencyOrder(lock: readonly LockedPlugin[]): LockedPlugin[] {
  const byId = new Map(btree(lock.map((p) => [p.id, p])));
  const done = new Set<string>();
  const order: LockedPlugin[] = [];
  const visit = (p: LockedPlugin) => {
    if (done.has(p.id)) return;
    done.add(p.id);
    for (const dep of p.dependencies) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    order.push(p);
  };
  for (const p of byId.values()) visit(p);
  return order;
}

export function planPlugins(
  lock: readonly LockedPlugin[],
  installed: readonly InstalledPlugin[],
  prune: boolean,
): PluginPlan {
  const on = btree(installed.map((p) => [p.id, p]));
  const onMap = new Map(on);
  const plan: PluginPlan = { steps: [], unchanged: [], kept: [] };
  for (const p of dependencyOrder(lock)) {
    // The lock's own validation guarantees the URI parses.
    const [did, name] = parseProjectUri(p.project) ?? ["", ""];
    const target: Target = {
      id: p.id,
      did,
      name,
      version: p.version,
      capabilities: p.capabilities === undefined ? undefined : [...p.capabilities],
      new_capabilities: [],
    };
    const current = onMap.get(p.id);
    if (!current) {
      plan.steps.push({ kind: "install", target });
      continue;
    }
    // What this change would newly grant. Read from the installed version's own declaration
    // rather than from the lock's previous entry, because the instance is what holds the
    // grant in force and may be running something the lock never pinned.
    const had = declaredCapabilities(current);
    target.new_capabilities = (target.capabilities ?? []).filter((c) => !had.includes(c));
    const r = current.registry;
    const from = r && r.did === did && r.name === name ? r : null;
    if (from) {
      if (from.version_uri === p.version_uri) plan.unchanged.push(p.id);
      else plan.steps.push({ kind: "move", target, from: current.version });
    } else {
      plan.steps.push({ kind: "replace", target, from: r?.did ?? "a URL" });
    }
  }
  const locked = new Set(lock.map((p) => p.id));
  for (const [id, p] of on) {
    if (locked.has(id) || !PROJECT_TYPES.includes(p.plugin_type)) continue;
    if (prune) plan.steps.push({ kind: "remove", id });
    else plan.kept.push(id);
  }
  return plan;
}
