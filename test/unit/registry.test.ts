// hpy-atproto/src/registry.rs tests, with a mock server as the registry (and as HappyView for
// the procedures).
import { afterEach, expect, it } from "vitest";
import { DpopKey } from "../../src/atproto/dpop.ts";
import type { AtprotoError } from "../../src/atproto/error.ts";
import { HappyView } from "../../src/atproto/happyview.ts";
import { HttpRegistry } from "../../src/atproto/registry.ts";
import { MockServer, query, type Recorded, type Reply } from "../support/mock-server.ts";

const DID = "did:plc:abc";

let servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.verify();
    await s.stop();
  }
  servers = [];
});
const start = async () => {
  const s = await MockServer.start();
  servers.push(s);
  return s;
};

function project(name: string) {
  return {
    uri: `at://${DID}/software.release.project/${name}`,
    cid: "bafyproj",
    did: DID,
    name,
    sidecar: { uri: `at://${DID}/at.happyproto.registry.project/${name}` },
    publication: {
      uri: `at://${DID}/site.standard.publication/${name}`,
      cid: "bafypub",
      name: "Pretty",
      url: "https://x.test/p",
    },
    pluginType: "library",
    keywords: ["a"],
    authors: [{ name: "T" }],
    security: [{ email: "s@x.test" }],
    channels: {
      latest: {
        version: "1.0.0",
        uri: "at://v",
        cid: "bafyv",
        state: "deprecated",
        availability: "deletedAtSource",
      },
    },
    lifecycle: { state: "active" },
    indexedAt: "2026-10-23T00:00:00Z",
  };
}

function version(v: string) {
  return {
    uri: `at://${DID}/software.release.version/x:${v}`,
    cid: "bafyver",
    did: DID,
    name: "x",
    version: v,
    manifest: { uri: "at://m", cid: "bafym" },
    artifact: { $type: "at.happyproto.plugin.v1" },
    changelog: { uri: "at://d", title: "t", markdown: "# t", fetchedAt: "now" },
    availability: "available",
    suspect: false,
    lifecycle: {
      state: "deprecated",
      installable: true,
      supersededBy: "2.0.0",
      events: [{ uri: "at://s", status: "supersededBy", supersededBy: "2.0.0" }],
    },
    indexedAt: "2026-10-23T00:00:00Z",
  };
}

const serve = (server: MockServer, nsid: string, status: number, body: unknown) =>
  server.given("GET", `/xrpc/at.happyproto.registry.${nsid}`, { status, json: body });

async function fails(p: Promise<unknown>): Promise<AtprotoError> {
  try {
    await p;
  } catch (e) {
    return e as AtprotoError;
  }
  throw new Error("expected an error");
}

it("get_project_sends_actor_and_name_and_reads_the_view", async () => {
  const server = await start();
  server
    .given(
      "GET",
      "/xrpc/at.happyproto.registry.getProject",
      { json: project("x") },
      query("actor", "trezy.dev"),
      query("name", "x"),
    )
    .expect(1);
  const got = (await new HttpRegistry(server.url).getProject("trezy.dev", "x"))!;
  expect(got.pluginType).toBe("library");
  expect(got.sidecar.cid).toBeUndefined();
  expect(got.publication.name).toBe("Pretty");
  const head = got.channels.get("latest")!;
  expect(head.state).toBe("deprecated");
  expect(head.availability).toBe("deletedAtSource");
  expect(got.lifecycle.state).toBe("active");
  // A read can't prove a client key, so HappyView would only log it and count the call as
  // anonymous; it isn't sent.
  expect(server.requests[0]!.headers["x-client-key"]).toBeUndefined();
});

it("not_found_names_answer_none_whatever_the_status", async () => {
  for (const [nsid, name] of [
    ["getProject", "ProjectNotFound"],
    // A handle that resolves to no account has no projects either.
    ["getProject", "ActorNotFound"],
    ["getVersion", "VersionNotFound"],
    ["resolveChannel", "ChannelNotFound"],
  ] as const) {
    for (const status of [200, 400]) {
      const server = await start();
      serve(server, nsid, status, { error: name, message: "no" });
      const reg = new HttpRegistry(server.url);
      const found =
        nsid === "getProject"
          ? await reg.getProject("a", "x")
          : nsid === "getVersion"
            ? await reg.getVersion(DID, "x", "1.0.0")
            : await reg.resolveChannel(DID, "x", "latest");
      expect(found, `${nsid} ${status}`).toBeNull();
    }
  }
});

it("get_version_and_resolve_channel_send_their_params", async () => {
  const server = await start();
  server
    .given(
      "GET",
      "/xrpc/at.happyproto.registry.getVersion",
      { json: version("1.2.3") },
      query("did", DID),
      query("name", "x"),
      query("version", "1.2.3"),
    )
    .expect(1);
  server
    .given(
      "GET",
      "/xrpc/at.happyproto.registry.resolveChannel",
      { json: version("2.0.0-beta.1") },
      query("did", DID),
      query("name", "x"),
      query("channel", "beta"),
    )
    .expect(1);
  const reg = new HttpRegistry(server.url);
  const v = (await reg.getVersion(DID, "x", "1.2.3"))!;
  expect(v.version).toBe("1.2.3");
  expect(v.lifecycle.installable).toBe(true);
  expect(v.lifecycle.supersededBy).toBe("2.0.0");
  expect(v.lifecycle.events[0]!.status).toBe("supersededBy");
  expect(v.changelog!.markdown).toBe("# t");
  expect((await reg.resolveChannel(DID, "x", "beta"))!.version).toBe("2.0.0-beta.1");
});

it("other_errors_surface_whatever_the_status", async () => {
  for (const status of [200, 500]) {
    const server = await start();
    server.given("GET", "*", {
      status,
      json: { error: "NotConfigured", message: "no identity" },
    });
    const err = await fails(new HttpRegistry(server.url).getVersion(DID, "x", "1.0.0"));
    expect(err.message, `${status}`).toContain("NotConfigured");
  }
});

it("search_projects_sends_filters_and_follows_the_cursor", async () => {
  const server = await start();
  server
    .given(
      "GET",
      "/xrpc/at.happyproto.registry.searchProjects",
      { json: { projects: [project("b")] } },
      query("pluginType", "interpreter"),
      query("q", "lua"),
      query("cursor", "next"),
    )
    .expect(1);
  server.given(
    "GET",
    "/xrpc/at.happyproto.registry.searchProjects",
    { json: { projects: [project("a")], cursor: "next" } },
    query("pluginType", "interpreter"),
    query("q", "lua"),
    query("limit", "100"),
  );
  const all = await new HttpRegistry(server.url).searchProjects("interpreter", "lua");
  expect(all.map((p) => p.name)).toEqual(["a", "b"]);
});

it("search_projects_without_filters_sends_none", async () => {
  const server = await start();
  server.given("GET", "/xrpc/at.happyproto.registry.searchProjects", {
    json: { projects: [project("a")] },
  });
  const all = await new HttpRegistry(server.url).searchProjects(undefined, undefined);
  expect(all).toHaveLength(1);
  const q = server.requests[0]!.query.toString();
  expect(q.includes("pluginType") || q.includes("q="), q).toBe(false);
});

it("list_versions_follows_the_cursor", async () => {
  const server = await start();
  server.given(
    "GET",
    "/xrpc/at.happyproto.registry.listVersions",
    { json: { versions: [version("1.0.0")] } },
    query("cursor", "next"),
  );
  server.given(
    "GET",
    "/xrpc/at.happyproto.registry.listVersions",
    { json: { versions: [version("2.0.0")], cursor: "next" } },
    query("did", DID),
    query("name", "x"),
  );
  const all = await new HttpRegistry(server.url).listVersions(DID, "x");
  expect(all.map((v) => v.version)).toEqual(["2.0.0", "1.0.0"]);
});

it("listing_versions_of_an_unknown_project_is_empty", async () => {
  const server = await start();
  serve(server, "listVersions", 200, { error: "ProjectNotFound", message: "no" });
  expect(await new HttpRegistry(server.url).listVersions(DID, "x")).toEqual([]);
});

it("get_artifact_asks_for_a_cid_and_answers_bytes", async () => {
  const server = await start();
  const wasm = Buffer.from("\0asm\x01\0\0\0", "latin1");
  server
    .given(
      "GET",
      "/xrpc/at.happyproto.registry.getArtifact",
      { headers: { "content-type": "application/wasm" }, body: wasm },
      query("cid", "bafkok"),
    )
    .expect(1);
  const got = await new HttpRegistry(server.url).getArtifact("bafkok");
  expect(Buffer.from(got)).toEqual(wasm);
});

it("get_artifact_surfaces_refusals_in_either_status", async () => {
  const server = await start();
  const replies: [string, Reply][] = [
    ["held", { status: 400, json: { error: "ArtifactNotHeld", message: "not copied yet" } }],
    ["lua", { status: 200, json: { error: "NotConfigured", message: "no identity" } }],
  ];
  for (const [cid, reply] of replies) {
    server.given("GET", "/xrpc/at.happyproto.registry.getArtifact", reply, query("cid", cid));
  }
  const reg = new HttpRegistry(server.url);
  expect((await fails(reg.getArtifact("held"))).message).toContain("ArtifactNotHeld");
  expect((await fails(reg.getArtifact("lua"))).message).toContain("NotConfigured");
});

it("a_json_artifact_that_names_no_error_still_answers", async () => {
  // A manifest is JSON and can carry any field but `error`.
  const server = await start();
  const manifest = { id: "x" };
  server.given("GET", "/xrpc/at.happyproto.registry.getArtifact", { json: manifest });
  const bytes = await new HttpRegistry(server.url).getArtifact("bafj");
  expect(JSON.parse(Buffer.from(bytes).toString())).toEqual(manifest);
});

async function registry(server: MockServer): Promise<HttpRegistry> {
  const cred = {
    registry: server.url,
    clientKey: "hvc_test",
    did: DID,
    handle: null,
    pds: "https://pds.test",
    scopes: "atproto",
    accessToken: "tok",
    dpopKey: await DpopKey.generate(),
  };
  return new HttpRegistry(server.url).withSession(new HappyView(server.url, "hvc_test"), cred);
}

/** wiremock's `body_partial_json`: every key in `expect` is in the body with that value. */
function partialJson(expected: unknown): (r: Recorded) => boolean {
  const contains = (have: unknown, want: unknown): boolean => {
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      if (have === null || typeof have !== "object" || Array.isArray(have)) return false;
      return Object.entries(want).every(([k, v]) =>
        contains((have as Record<string, unknown>)[k], v),
      );
    }
    return JSON.stringify(have) === JSON.stringify(want);
  };
  return (r) => {
    try {
      return contains(r.json(), expected);
    } catch {
      return false;
    }
  };
}

const post = (server: MockServer, nsid: string, want: unknown, status: number, out: unknown) =>
  server
    .given("POST", `/xrpc/at.happyproto.registry.${nsid}`, { status, json: out }, partialJson(want))
    .expect(1);

const r = (uri: string) => ({ uri, cid: "bafy" });

it("put_project_answers_what_it_wrote", async () => {
  const server = await start();
  post(server, "putProject", { name: "x", swapCid: "old", validateOnly: false }, 200, {
    valid: true,
    created: true,
    project: r("at://p"),
    publication: r("at://pub"),
    sidecar: r("at://s"),
  });
  const out = (await (await registry(server)).putProject({ name: "x", swapCid: "old" }, false))!;
  expect(out.created).toBe(true);
  expect(out.project.uri).toBe("at://p");
  expect(out.sidecar.uri).toBe("at://s");
});

it("validating_writes_nothing_and_answers_none", async () => {
  const server = await start();
  post(server, "putProject", { validateOnly: true }, 200, { valid: true });
  post(server, "publishRelease", { validateOnly: true }, 200, { valid: true });
  const reg = await registry(server);
  expect(await reg.putProject({}, true)).toBeNull();
  expect(await reg.publishRelease({}, true)).toBeNull();
});

it("publish_release_answers_the_written_records", async () => {
  const server = await start();
  post(
    server,
    "publishRelease",
    { name: "x", version: "1.0.0", track: "beta", validateOnly: false },
    200,
    {
      valid: true,
      resumed: true,
      manifest: r("at://m"),
      version: r("at://v"),
      channel: r("at://c"),
      changelog: r("at://d"),
    },
  );
  const out = (await (
    await registry(server)
  ).publishRelease({ name: "x", version: "1.0.0", track: "beta" }, false))!;
  expect(out.resumed).toBe(true);
  expect(out.manifest!.uri).toBe("at://m");
  expect(out.version.uri).toBe("at://v");
  expect(out.channel!.uri).toBe("at://c");
  expect(out.changelog!.uri).toBe("at://d");
});

it("promote_release_needs_no_manifest_or_channel", async () => {
  const server = await start();
  const input = { name: "x", fromVersion: "1.0.0-beta.1", version: "1.0.0" };
  post(server, "promoteRelease", input, 200, { version: r("at://v") });
  const out = await (await registry(server)).promoteRelease(input);
  expect(out.version.uri).toBe("at://v");
  expect(out.resumed).toBe(false);
  expect(out.manifest).toBeUndefined();
  expect(out.channel).toBeUndefined();
});

it("put_status_answers_the_record", async () => {
  const server = await start();
  const input = { subject: "at://v", status: "endOfLife" };
  post(server, "putStatus", input, 200, r("at://status"));
  expect((await (await registry(server)).putStatus(input)).uri).toBe("at://status");
});

it("procedure_refusals_keep_their_names_in_either_status", async () => {
  for (const [nsid, name] of [
    ["putProject", "InvalidSwap"],
    ["publishRelease", "VersionExists"],
    ["publishRelease", "ProjectMissing"],
    ["promoteRelease", "NotInstallable"],
    ["promoteRelease", "VersionNotFound"],
    ["putStatus", "SubjectNotFound"],
    ["putStatus", "InvalidStatus"],
    ["putProject", "InvalidRecord"],
  ] as const) {
    for (const status of [200, 400]) {
      const server = await start();
      post(server, nsid, {}, status, { error: name, message: "say it plainly" });
      const reg = await registry(server);
      const err = await fails(
        nsid === "putProject"
          ? reg.putProject({}, false)
          : nsid === "publishRelease"
            ? reg.publishRelease({}, false)
            : nsid === "promoteRelease"
              ? reg.promoteRelease({})
              : reg.putStatus({}),
      );
      expect(err.registryName(), `${nsid} ${status}: ${err.message}`).toBe(name);
      if (name === "VersionNotFound") {
        expect(err.isUsage()).toBe(true);
        expect(err.message).toBe("say it plainly");
      }
    }
  }
});

it("procedures_without_a_session_are_not_logged_in", async () => {
  const reg = new HttpRegistry("http://127.0.0.1:9");
  expect((await fails(reg.publishRelease({}, true))).isAuth()).toBe(true);
  expect((await fails(reg.putStatus({}))).isAuth()).toBe(true);
});

it("a_malformed_answer_is_an_error_not_a_default", async () => {
  const server = await start();
  post(server, "putStatus", {}, 200, { uri: "at://x" });
  const err = await fails((await registry(server)).putStatus({}));
  expect(err.message).toContain("unreadable");
});
