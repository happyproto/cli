// crates/hpy/src/project/network/app.rs: HappyView as an Atmosphere in a Box managed
// application: a container on the sandbox network running the Linux release binary over the
// bind-mounted project, behind a sandbox HTTPS route.
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { Failure } from "../../core/failure.ts";
import { createDirAll, ioErrorText, readToString, writeString } from "../../core/io.ts";
import { type Json, toJson } from "../../core/output.ts";
import { rustJoin, rustParent } from "../../core/paths.ts";
import {
  array,
  fromStr,
  get,
  type Node,
  node,
  parseValue,
  toStringPretty,
} from "../../core/serde-json.ts";
import TEMPLATES from "./templates.json" with { type: "json" };

export const APP_ID = "happyview";
/** The sandbox route HappyView's `PUBLIC_URL` is read from. */
export const ROUTE_ID = "happyview";
/**
 * A full name rather than a label under the sandbox's `.test` domain: the sandbox PDS refuses
 * an OAuth `client_id` on the `.test` TLD.
 */
export const ROUTE_HOSTNAME = "happyview.atmosbox.internal";
export const PUBLIC_URL = "https://happyview.atmosbox.internal";
export const SUPERADMIN_ENV = "SUPERADMIN_DID";
export const BACKFILL_ENV = "HAPPYVIEW_DEV_BACKFILL";
/** Tells HappyView it is the sandboxed instance, not one on the real network. */
export const NETWORK_ENV = "HAPPYVIEW_NETWORK";
/** Polling interval for HappyView's project watcher, in milliseconds. */
export const WATCH_POLL_ENV = "HAPPYVIEW_WATCH_POLL_MS";
/** Whether the sandbox relay can drive backfill's discovery (`listReposByCollection`). */
export const BACKFILL_ON_LOCAL: boolean = false;
/**
 * Polling instead of file events. Docker Desktop's VirtioFS share delivers no CLOSE_WRITE,
 * MOVED_TO or delete events for the bind-mounted project, so an editor's save never reaches an
 * event watcher. `undefined` would leave the watcher on events.
 */
export const WATCH_POLL_MS: number | undefined = 500;
/**
 * The local network's database and plugin cache, kept apart from the one `dev` uses against
 * the real network so their records never mix.
 */
export const LOCAL_DB_DIR = ".happyview/local-network";

export const STACK_FILE = "stacks/happyview.yaml";
export const DEFINITION_FILE = "stacks/happyview.definition.json";
const BUILD_DIR = "stacks/happyview";
const BINARY_NAME = "happyview";

export interface AppConfig {
  projectRoot: string;
  /** The Linux release binary; copied into the build context, never mounted. */
  binary: string;
  uid: number;
  gid: number;
  superadmin: string | undefined;
  /** `[dev] backfill` from the project. */
  backfill: boolean;
}

const runtime = (e: unknown): Failure => Failure.runtime(ioErrorText(e));

export function stackJson(c: AppConfig): { [k: string]: Json } {
  const env: { [k: string]: Json } = {
    HOST: "0.0.0.0",
    PORT: "3000",
    // Service names over plain transport: the network is internal, and HappyView's WebSocket
    // client trusts only a compiled-in root list.
    JETSTREAM_URL: "ws://full-stack-jetstream:8080",
    RELAY_URL: "http://full-stack-relay:2470",
    DATABASE_URL: `sqlite:///project/${LOCAL_DB_DIR}/happyview.db?mode=rwc`,
    HV_UID: String(c.uid),
    HV_GID: String(c.gid),
    [BACKFILL_ENV]: String(c.backfill && BACKFILL_ON_LOCAL),
    [NETWORK_ENV]: "local",
  };
  if (c.superadmin !== undefined) env[SUPERADMIN_ENV] = c.superadmin;
  if (WATCH_POLL_MS !== undefined) env[WATCH_POLL_ENV] = String(WATCH_POLL_MS);
  return {
    services: {
      [APP_ID]: {
        build: { context: `./${BUILD_DIR}` },
        working_dir: "/project",
        command: ["dev", "."],
        environment: env,
        volumes: [{ type: "bind", source: c.projectRoot, target: "/project" }],
        restart: "no",
      },
    },
  };
}

export function definitionJson(): { [k: string]: Json } {
  return {
    version: 1,
    id: APP_ID,
    services: [
      {
        service: APP_ID,
        environment: [
          { name: "PUBLIC_URL", source: { kind: "route-url", route: ROUTE_ID } },
          { name: "PLC_URL", source: { kind: "plc-url" } },
        ],
      },
    ],
    // Atmosphere in a Box takes exactly one of `host` (a label under its domain) and
    // `hostname` (a full name).
    routes: [{ id: ROUTE_ID, service: APP_ID, hostname: ROUTE_HOSTNAME, port: 3000 }],
    secrets: [],
  };
}

/** `components.json` with HappyView registered, or `undefined` when it already is. */
export function registerComponent(components: string): string | undefined {
  let list: Node[];
  try {
    list = fromStr(components, array(node));
  } catch (e) {
    throw Failure.runtime(`stacks/components.json is not readable: ${(e as Error).message}`);
  }
  // serde_json's `c["id"] == APP_ID`: a string `id` on an object.
  const isApp = (c: Node): boolean => {
    const id = get(c, "id");
    return id?.kind === "string" && id.value === APP_ID;
  };
  if (list.some(isApp)) return undefined;
  const entry = parseValue(
    JSON.stringify({
      id: APP_ID,
      file: STACK_FILE,
      application: APP_ID,
      definition: DEFINITION_FILE,
    }),
  );
  const all: Node = { kind: "array", children: [...list, entry], start: -1, end: -1 };
  return `${toStringPretty(all)}\n`;
}

function writeIfChanged(path: string, body: string): boolean {
  try {
    if (readToString(path) === body) return false;
  } catch {}
  const parent = rustParent(path);
  try {
    if (parent !== undefined) createDirAll(parent);
    writeString(path, body);
  } catch (e) {
    throw runtime(e);
  }
  return true;
}

function sha256Of(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Copies the binary into the build context unless the copy already there has the same size and
 * hash. The executable bit comes from the Dockerfile.
 */
function copyBinary(from: string, to: string): boolean {
  let wanted: number;
  try {
    wanted = statSync(from).size;
  } catch (e) {
    throw Failure.runtime(`cannot read ${from}: ${ioErrorText(e)}`);
  }
  let haveSize: number | undefined;
  try {
    haveSize = statSync(to).size;
  } catch {}
  if (haveSize === wanted) {
    const have = sha256Of(to);
    if (have !== undefined && have === sha256Of(from)) return false;
  }
  const parent = rustParent(to);
  try {
    if (parent !== undefined) createDirAll(parent);
    copyFileSync(from, to);
  } catch (e) {
    throw runtime(e);
  }
  return true;
}

/** What `writeApp` changed on disk. */
export interface Written {
  any: boolean;
  /** The application definition, which carries HappyView's route. */
  definition: boolean;
}

export const Written = {
  default(): Written {
    return { any: false, definition: false };
  },
} as const;

export function writeApp(checkout: string, c: AppConfig): Written {
  const build = rustJoin(checkout, BUILD_DIR);
  let changed = false;
  changed = writeIfChanged(rustJoin(build, "Dockerfile"), TEMPLATES.Dockerfile) || changed;
  changed = writeIfChanged(rustJoin(build, "entrypoint.sh"), TEMPLATES["entrypoint.sh"]) || changed;
  changed = copyBinary(c.binary, rustJoin(build, BINARY_NAME)) || changed;
  // YAML is a superset of JSON, so the stack is written as JSON and every value is quoted
  // correctly without a YAML writer.
  changed = writeIfChanged(rustJoin(checkout, STACK_FILE), `${toJson(stackJson(c))}\n`) || changed;
  const definition = writeIfChanged(
    rustJoin(checkout, DEFINITION_FILE),
    `${toJson(definitionJson())}\n`,
  );
  changed = definition || changed;
  const components = rustJoin(checkout, "stacks/components.json");
  let text: string;
  try {
    text = readToString(components);
  } catch (e) {
    throw runtime(e);
  }
  const updated = registerComponent(text);
  if (updated !== undefined) {
    try {
      writeString(components, updated);
    } catch (e) {
      throw runtime(e);
    }
    changed = true;
  }
  return { any: changed, definition };
}
