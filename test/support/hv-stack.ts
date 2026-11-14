// crates/hpy/tests/happyview.rs's support: a fake HappyView release (a shell script in a
// `.tar.xz`) served beside a fake registry, and private config, cache and project directories.
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/output.ts";
import { sortKeys } from "../../src/core/output.ts";
import { predictedBlob } from "../../src/plugin/artifact.ts";
import { rawCid } from "../../src/plugin/checksum.ts";
import { HOST_TARGET } from "../../src/project/binary.ts";
import { Home, hpy, type Run } from "./hpy.ts";
import { MockServer, query } from "./mock-server.ts";
import { tarXz } from "./tar.ts";

export const VERSION = "3.0.0-alpha.12";

/**
 * Records its arguments, its working directory, and `PLUGIN_DIR` when it arrives. With
 * `HV_MODE=trap` it runs until a SIGTERM, which it records. With `HV_MODE=signals` it records
 * every SIGTERM, SIGHUP, SIGINT and SIGQUIT, one line each, and runs on until `$HV_LOG.quit`
 * exists, so a second copy of a signal is recorded too; it then exits 7 if a SIGTERM came and
 * 0 otherwise. Waiting on a background `sleep` lets a trap run as its signal arrives. With
 * `HV_MODE=die` a signal ends it. Otherwise it exits with `HV_EXIT`. `HV_SAY` is printed to
 * stdout and stderr first (for the parity harness, which compares what passes through).
 */
export const FAKE_HAPPYVIEW = `#!/bin/sh
echo "$*" >> "$HV_LOG"
pwd -P > "$HV_LOG.cwd"
if [ -n "\${PLUGIN_DIR+set}" ]; then
  echo "PLUGIN_DIR=$PLUGIN_DIR" >> "$HV_LOG"
fi
if [ -n "$HV_SAY" ]; then
  echo "$HV_SAY"
  echo "$HV_SAY" >&2
fi
if [ "$HV_MODE" = trap ]; then
  trap 'echo got >> "$HV_LOG.term"; exit 7' TERM
  echo $$ > "$HV_LOG.ready"
  while :; do sleep 0.1; done
fi
if [ "$HV_MODE" = signals ]; then
  code=0
  trap 'echo TERM >> "$HV_LOG.sig"; code=7' TERM
  trap 'echo HUP >> "$HV_LOG.sig"' HUP
  trap 'echo INT >> "$HV_LOG.sig"' INT
  trap 'echo QUIT >> "$HV_LOG.sig"' QUIT
  echo $$ > "$HV_LOG.ready"
  while [ ! -e "$HV_LOG.quit" ]; do sleep 0.1 & wait $!; done
  exit $code
fi
if [ "$HV_MODE" = die ]; then
  kill -KILL $$
fi
exit "\${HV_EXIT:-0}"
`;

/** The asset hpy asks for. */
export const target = () => HOST_TARGET;

/** Output that holds `needle` once an error report's wrapping is undone. */
export function says(out: string, needle: string): boolean {
  const flat = (t: string) =>
    [...t].filter((c) => !/^\p{White_Space}$/u.test(c) && c !== "│").join("");
  return flat(out).includes(flat(needle));
}

export class Stack {
  readonly server: MockServer;
  readonly home = new Home();
  readonly cache = mkdtempSync(join(tmpdir(), "hpy-cache-"));
  readonly project = mkdtempSync(join(tmpdir(), "hpy-project-"));
  readonly log: string;

  private constructor(server: MockServer) {
    this.server = server;
    chmodSync(this.cache, 0o700);
    writeFileSync(join(this.project, "happyview.toml"), `[happyview]\nversion = "${VERSION}"\n`);
    writeFileSync(
      join(this.project, "happyview.lock"),
      `version = 2\n\n[happyview]\nversion = "${VERSION}"\n`,
    );
    this.log = join(this.project, "hv.log");
  }

  static async start(): Promise<Stack> {
    const s = new Stack(await MockServer.start());
    const asset = `happyview-${target()}.tar.xz`;
    const archive = tarXz([[`happyview-${target()}/happyview`, FAKE_HAPPYVIEW, 0o755]]);
    const sum = createHash("sha256").update(archive).digest("hex");
    s.server.given("GET", `/dl/v${VERSION}/${asset}`, { body: Buffer.from(archive) });
    s.server.given("GET", `/dl/v${VERSION}/${asset}.sha256`, { body: `${sum}  ${asset}\n` });
    return s;
  }

  env(): Record<string, string> {
    return {
      HPY_REGISTRY_URL: this.server.url,
      HPY_CACHE_DIR: this.cache,
      HPY_DATA_DIR: join(this.cache, "data"),
      HPY_HAPPYVIEW_DOWNLOAD: `${this.server.url}/dl`,
      HPY_GITHUB_API: this.server.url,
      HV_LOG: this.log,
    };
  }

  hpy(args: string[], env: Record<string, string> = {}): Promise<Run> {
    return hpy(this.home, args, { cwd: this.project, env: { ...this.env(), ...env } });
  }

  /** `hpy`, run in `cwd` rather than the stack's project (`.current_dir(...)` in Rust). */
  hpyIn(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
    return hpy(this.home, args, { cwd, env: { ...this.env(), ...env } });
  }

  readLog(): string {
    try {
      return readFileSync(this.log, "utf8");
    } catch {
      return "";
    }
  }

  async dispose(): Promise<void> {
    await this.server.stop();
    this.home.dispose();
    for (const d of [this.cache, this.project]) rmSync(d, { recursive: true, force: true });
  }
}

export const HV_DID = "did:plc:hv";

/** One plugin the fake registry serves: a single version, 1.4.2, which its `latest` channel points at. */
export class Plugin {
  name: string;
  pluginType: "interpreter" | "library";
  displayName: string;
  fields: { [k: string]: Json };
  wasm: Uint8Array;
  manifest: Uint8Array;

  private constructor(
    name: string,
    pluginType: "interpreter" | "library",
    displayName: string,
    fields: { [k: string]: Json },
    wasm: Uint8Array,
  ) {
    this.name = name;
    this.pluginType = pluginType;
    this.displayName = displayName;
    this.fields = fields;
    this.wasm = wasm;
    this.manifest = Buffer.from(`{"id":"${name}"}`);
  }

  static interpreter(name: string, language: string, wasm: string): Plugin {
    return new Plugin(
      name,
      "interpreter",
      "Lua",
      {
        pluginType: "interpreter",
        apiVersion: "2",
        languageId: language,
        fileExtensions: [language],
        capabilities: ["script:host"],
      },
      Buffer.from(wasm),
    );
  }

  static library(name: string, namespace: string, wasm: string): Plugin {
    return new Plugin(
      name,
      "library",
      "HTTP",
      { pluginType: "library", apiVersion: "2", namespace, capabilities: [] },
      Buffer.from(wasm),
    );
  }

  versionJson(): { [k: string]: Json } {
    const artifact: { [k: string]: Json } = {
      $type: "at.happyproto.plugin.v1",
      package: predictedBlob(this.wasm, "application/wasm"),
      manifest: predictedBlob(this.manifest, "application/json"),
      capabilities: [],
      license: "MIT",
      sections: { description: "A plugin." },
      ...this.fields,
    };
    const name = this.name;
    return {
      uri: `at://${HV_DID}/software.release.version/${name}.1.4.2`,
      cid: rawCid(Buffer.from(`version ${name}`)),
      did: HV_DID,
      name,
      version: "1.4.2",
      manifest: {
        uri: `at://${HV_DID}/software.release.manifest/3l${name}`,
        cid: rawCid(Buffer.from(JSON.stringify(sortKeys(artifact)))),
      },
      artifact,
      availability: "available",
      suspect: false,
      lifecycle: { state: "active", installable: true, events: [] },
      indexedAt: "2026-10-23T00:00:00Z",
    };
  }

  projectJson(): Json {
    const name = this.name;
    const version = this.versionJson();
    return {
      uri: `at://${HV_DID}/software.release.project/${name}`,
      did: HV_DID,
      name,
      sidecar: { uri: `at://${HV_DID}/at.happyproto.registry.project/${name}` },
      publication: {
        uri: `at://${HV_DID}/site.standard.publication/${name}`,
        cid: "bafypublication",
        name: this.displayName,
        url: `https://happyproto.at/plugins/${HV_DID}/${name}`,
      },
      pluginType: this.pluginType,
      channels: {
        latest: {
          version: "1.4.2",
          uri: version.uri as Json,
          cid: version.cid as Json,
          state: "active",
          availability: "available",
        },
      },
      lifecycle: { state: "active" },
      indexedAt: "2026-10-23T00:00:00Z",
    };
  }
}

/**
 * A registry serving `plugins` through the read API, with the not-found answers the real one
 * gives for anything else. `first` mounts ahead of those fallbacks (wiremock's priorities).
 */
export function mountRegistry(
  stack: Stack,
  plugins: readonly Plugin[],
  first?: (s: MockServer) => void,
): void {
  mountRegistryOn(stack.server, "", plugins, first);
}

/** `mountRegistry` on any server, under `prefix` (for the parity harness's shared mock). */
export function mountRegistryOn(
  s: MockServer,
  prefix: string,
  plugins: readonly Plugin[],
  first?: (s: MockServer) => void,
): void {
  const at = (nsid: string) => `${prefix}/xrpc/at.happyproto.registry.${nsid}`;
  for (const pluginType of ["interpreter", "library"]) {
    const projects = plugins.filter((p) => p.pluginType === pluginType).map((p) => p.projectJson());
    s.given("GET", at("searchProjects"), { json: { projects } }, query("pluginType", pluginType));
  }
  for (const p of plugins) {
    const version = p.versionJson();
    s.given("GET", at("getProject"), { json: p.projectJson() }, query("name", p.name));
    s.given(
      "GET",
      at("resolveChannel"),
      { json: version },
      query("name", p.name),
      query("channel", "latest"),
    );
    s.given(
      "GET",
      at("getVersion"),
      { json: version },
      query("name", p.name),
      query("version", "1.4.2"),
    );
    s.given("GET", at("listVersions"), { json: { versions: [version] } }, query("name", p.name));
    for (const bytes of [p.wasm, p.manifest])
      s.given(
        "GET",
        at("getArtifact"),
        { body: Buffer.from(bytes), headers: { "content-type": "application/octet-stream" } },
        query("cid", rawCid(bytes)),
      );
  }
  first?.(s);
  for (const [nsid, error] of [
    ["getProject", "ProjectNotFound"],
    ["resolveChannel", "ChannelNotFound"],
    ["getVersion", "VersionNotFound"],
    ["listVersions", "ProjectNotFound"],
    ["getArtifact", "ArtifactNotHeld"],
  ] as const)
    s.given("GET", at(nsid), { status: 400, json: { error, message: "no" } });
}
