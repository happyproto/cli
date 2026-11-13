// The registries `hv add` and `hv scaffold` read in the parity harness, under the shared mock:
//   $MOCK/addreg/…   happyview-lua (interpreter `lua`), happyview-db and happyview-record
//                    (libraries `happyview.db` and `happyview.record`), each 1.4.2 on latest
//   $MOCK/addboth/…  `lua` answered by an interpreter and by a library (namespace `lua`)
//   $MOCK/addtwo/…   two interpreters answering `lua`: happyview-lua and other-lua
//   $MOCK/addpre/…   happyview-js (interpreter `js`), with only an alpha channel at 0.1.0-alpha.3
import { rawCid } from "../../src/plugin/checksum.ts";
import { HV_DID, mountRegistryOn, Plugin } from "../support/hv-stack.ts";
import { query } from "../support/mock-server.ts";

const lua = () => Plugin.interpreter("happyview-lua", "lua", "\0asm lua");

export function mountAdd(s) {
  mountRegistryOn(s, "/addreg", [
    lua(),
    Plugin.library("happyview-db", "happyview.db", "\0asm db"),
    Plugin.library("happyview-record", "happyview.record", "\0asm record"),
  ]);
  mountRegistryOn(s, "/addboth", [lua(), Plugin.library("lua-lib", "lua", "\0asm lualib")]);
  mountRegistryOn(s, "/addtwo", [lua(), Plugin.interpreter("other-lua", "lua", "\0asm other")]);
  mountPrerelease(s);
}

/** `/addpre`: a plugin with nothing but prereleases, which `mountRegistryOn` cannot serve. */
function mountPrerelease(s) {
  const js = Plugin.interpreter("happyview-js", "js", "\0asm js");
  const at = (nsid) => `/addpre/xrpc/at.happyproto.registry.${nsid}`;
  const pre = "0.1.0-alpha.3";
  const version = {
    ...js.versionJson(),
    version: pre,
    uri: `at://${HV_DID}/software.release.version/happyview-js.${pre}`,
  };
  const project = js.projectJson();
  project.channels = {
    alpha: {
      version: pre,
      uri: version.uri,
      cid: version.cid,
      state: "active",
      availability: "available",
    },
  };
  s.given(
    "GET",
    at("searchProjects"),
    { json: { projects: [project] } },
    query("pluginType", "interpreter"),
  );
  s.given("GET", at("searchProjects"), { json: { projects: [] } });
  s.given("GET", at("getProject"), { json: project }, query("name", js.name));
  s.given(
    "GET",
    at("resolveChannel"),
    { json: version },
    query("name", js.name),
    query("channel", "alpha"),
  );
  s.given("GET", at("getVersion"), { json: version }, query("version", pre));
  s.given("GET", at("listVersions"), { json: { versions: [version] } });
  for (const bytes of [js.wasm, js.manifest])
    s.given(
      "GET",
      at("getArtifact"),
      { body: Buffer.from(bytes), headers: { "content-type": "application/octet-stream" } },
      query("cid", rawCid(bytes)),
    );
  for (const [nsid, error] of [
    ["getProject", "ProjectNotFound"],
    ["resolveChannel", "ChannelNotFound"],
    ["getVersion", "VersionNotFound"],
    ["getArtifact", "ArtifactNotHeld"],
  ])
    s.given("GET", at(nsid), { status: 400, json: { error, message: "no" } });
}
