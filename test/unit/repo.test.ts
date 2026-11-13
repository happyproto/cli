// hpy-atproto/src/repo.rs tests, with one mock server as HappyView and one as the PDS.
import { afterEach, expect, it } from "vitest";
import { DpopKey } from "../../src/atproto/dpop.ts";
import { HappyView } from "../../src/atproto/happyview.ts";
import { HappyViewRepo } from "../../src/atproto/repo.ts";
import { MockServer, query } from "../support/mock-server.ts";

let servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
});
const start = async () => {
  const s = await MockServer.start();
  servers.push(s);
  return s;
};

async function repo(hv: MockServer, pds: MockServer): Promise<HappyViewRepo> {
  return new HappyViewRepo(new HappyView(hv.url, "hvc_test"), {
    registry: hv.url,
    clientKey: "hvc_test",
    did: "did:plc:abc",
    handle: null,
    pds: pds.url,
    scopes: "atproto",
    accessToken: "tok",
    dpopKey: await DpopKey.generate(),
  });
}

it("reads_come_from_the_pds_and_not_found_is_none", async () => {
  const [hv, pds] = [await start(), await start()];
  pds.given(
    "GET",
    "/xrpc/com.atproto.repo.getRecord",
    { json: { uri: "at://did:plc:abc/c/x", cid: "bafy", value: { a: 1 } } },
    query("rkey", "x"),
  );
  pds.given(
    "GET",
    "/xrpc/com.atproto.repo.getRecord",
    { status: 400, json: { error: "RecordNotFound", message: "nope" } },
    query("rkey", "missing"),
  );
  const r = await repo(hv, pds);
  const got = await r.getRecord("c", "x");
  if (got === null) throw new Error("expected the record");
  expect([got.cid, (got.value as { a: number }).a]).toEqual(["bafy", 1]);
  expect(await r.getRecord("c", "missing")).toBeNull();
  expect(hv.requests.length).toBe(0);
});

it("list_records_follows_the_cursor", async () => {
  const [hv, pds] = [await start(), await start()];
  pds.given(
    "GET",
    "/xrpc/com.atproto.repo.listRecords",
    { json: { records: [{ uri: "at://d/c/2", cid: "b2", value: {} }] } },
    query("cursor", "next"),
  );
  pds.given("GET", "/xrpc/com.atproto.repo.listRecords", {
    json: { records: [{ uri: "at://d/c/1", cid: "b1", value: {} }], cursor: "next" },
  });
  const all = await (await repo(hv, pds)).listRecords("c");
  expect(all.map((r) => r.uri)).toEqual(["at://d/c/1", "at://d/c/2"]);
});
