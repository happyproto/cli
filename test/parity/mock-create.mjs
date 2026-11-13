// What `hv create` reads in the parity harness, under the shared mock (HPY_REGISTRY_URL picks
// the registry, HPY_GITHUB_API the release list):
//   $MOCK/crreg/…    a registry with happyview-lua (as tests/happyview.rs's `mount_lua`)
//   $MOCK/crtwo/…    happyview-lua and other-lua, both answering to `lua`
//   $MOCK/crlib/…    happyview-lua and http-lib (namespace happyview.http)
//   $MOCK/crold/…    a lua interpreter from before project mode: no file extensions
//   $MOCK/crmany/…   lua, typescript, python (no starter handler) and alpha-lua (only an alpha
//                    channel, answering to `luau`), plus http-lib
//   $MOCK/crempty/…  a registry with nothing in it
//   $MOCK/crgh/…     GitHub's releases API over two pages: the newest stable with this host's
//                    binary is 3.0.0 (a newer prerelease, a draft and a release without the
//                    binary are passed over)
//   $MOCK/crghpre/…  only prereleases ship the binary
//   $MOCK/crgh0/…    no release ships the binary
//   $MOCK/crgh5/…    the release list answers 500
// Anything else under /cr answers 404 (the mock's default).
import { mountRegistryOn, Plugin, target } from "../support/hv-stack.ts";
import { query } from "../support/mock-server.ts";

const RELEASES = "/repos/gamesgamesgamesgamesgames/happyview/releases";

const lua = () => Plugin.interpreter("happyview-lua", "lua", "\0asm lua");
const http = () => Plugin.library("http-lib", "happyview.http", "\0asm http");

/** A plugin whose project has only an `alpha` channel. */
function alphaOnly(p) {
  const project = p.projectJson.bind(p);
  p.projectJson = () => {
    const j = project();
    j.channels = { alpha: j.channels.latest };
    return j;
  };
  return p;
}

export function mountCreate(s) {
  mountRegistryOn(s, "/crreg", [lua()]);
  mountRegistryOn(s, "/crtwo", [lua(), Plugin.interpreter("other-lua", "lua", "\0asm other")]);
  mountRegistryOn(s, "/crlib", [lua(), http()]);
  const old = lua();
  delete old.fields.fileExtensions;
  mountRegistryOn(s, "/crold", [old]);
  const luau = alphaOnly(Plugin.interpreter("alpha-lua", "luau", "\0asm luau"));
  mountRegistryOn(
    s,
    "/crmany",
    [
      lua(),
      Plugin.interpreter("happyview-ts", "typescript", "\0asm ts"),
      Plugin.interpreter("happyview-py", "python", "\0asm py"),
      luau,
      http(),
    ],
    (srv) =>
      srv.given(
        "GET",
        "/crmany/xrpc/at.happyproto.registry.resolveChannel",
        { json: luau.versionJson() },
        query("name", "alpha-lua"),
        query("channel", "alpha"),
      ),
  );
  mountRegistryOn(s, "/crempty", []);

  const asset = `happyview-${target()}.tar.xz`;
  const release = (tag, assets = [asset], draft = false) => ({
    tag_name: tag,
    draft,
    assets: assets.map((name) => ({ name })),
  });
  s.given(
    "GET",
    `/crgh${RELEASES}`,
    { json: [release("v3.0.0"), release("2.9.0", ["happyview-other.tar.xz"])] },
    query("page", "2"),
  );
  s.given("GET", `/crgh${RELEASES}`, (r) => ({
    headers: {
      link: `<http://${r.headers.host}/crgh${RELEASES}?per_page=100&page=2>; rel="next"`,
    },
    json: [release("v3.1.0-beta.1"), release("v3.0.5", [asset], true), release("v2.0.0", [])],
  }));
  s.given("GET", `/crghpre${RELEASES}`, {
    json: [release("v3.1.0-beta.2"), release("v3.1.0-beta.10"), release("v3.0.0", [])],
  });
  s.given("GET", `/crgh0${RELEASES}`, { json: [release("v3.0.0", [])] });
  s.given("GET", `/crgh5${RELEASES}`, { status: 500, body: "down" });
}
