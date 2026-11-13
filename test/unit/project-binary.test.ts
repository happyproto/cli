// crates/hpy/src/project/binary.rs tests, against test/support/mock-server.ts for wiremock.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Failure } from "../../src/core/failure.ts";
import {
  assetName,
  BINARY_NAME,
  CODEMOD_NAME,
  ensureBinary,
  ensureNamed,
  extractNamed,
  httpClient,
  latestVersion,
  MAX_RELEASE_PAGES,
  nextPage,
  parseSha256,
  type ReleaseSource,
} from "../../src/project/binary.ts";
import { binaryPath, withFileName } from "../../src/project/cache.ts";
import { MockServer, query } from "../support/mock-server.ts";
import { rawTarXz, tarXz } from "../support/tar.ts";

const LINUX = "x86_64-unknown-linux-musl";
const WINDOWS = "x86_64-pc-windows-msvc";
const LINUX_ENTRY = "happyview-x86_64-unknown-linux-musl/happyview";

const hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const tempdir = () => mkdtempSync(join(tmpdir(), "hpy-binary-"));
const text = (b: Uint8Array) => Buffer.from(b).toString();

const servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.stop();
    s.verify();
  }
});
async function start(): Promise<MockServer> {
  const s = await MockServer.start();
  servers.push(s);
  return s;
}

const source = (server: MockServer): ReleaseSource => ({
  api: server.url,
  download: `${server.url}/dl`,
  repo: "o/happyview",
});

function failure(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

async function failureOf(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Failure) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

it("asset_names_follow_the_target", () => {
  expect(assetName(LINUX)).toBe("happyview-x86_64-unknown-linux-musl.tar.xz");
  expect(assetName("aarch64-apple-darwin")).toBe("happyview-aarch64-apple-darwin.tar.xz");
});

it("sha256_files_are_read_by_their_first_token", () => {
  const want = hex("x");
  // cargo-dist's own form: binary-mode `sha256sum` output.
  expect(parseSha256(`${want} *happyview-x.tar.xz\n`)).toBeDefined();
  expect(parseSha256(`${want}  happyview-x.tar.xz\n`)).toBeDefined();
  expect(parseSha256(want.toUpperCase())).toBeDefined();
  expect(parseSha256("nothex")).toBeUndefined();
  expect(parseSha256(want.slice(0, 62))).toBeUndefined();
  expect(parseSha256("")).toBeUndefined();
});

it("extracts_only_the_binary_at_its_release_path", () => {
  // Releases carry helper binaries beside `happyview`, and a `happyview` anywhere but
  // cargo-dist's path is not the one wanted.
  const tar = tarXz([
    ["happyview-x86_64-unknown-linux-musl/README.md", "readme", 0o644],
    ["happyview-x86_64-unknown-linux-musl/happyview-codemod", "NOT IT", 0o755],
    ["elsewhere/happyview", "NOT IT EITHER", 0o755],
    [LINUX_ENTRY, "ELF", 0o755],
  ]);
  expect(text(extractNamed(tar, LINUX, BINARY_NAME))).toBe("ELF");
  const misplaced = tarXz([
    ["README.md", "r", 0o644],
    ["happyview", "ELF", 0o755],
  ]);
  expect(failure(() => extractNamed(misplaced, LINUX, BINARY_NAME)).message).toContain(
    `no \`${LINUX_ENTRY}\``,
  );
});

it("extracts_the_codemod_beside_the_binary", () => {
  const tar = tarXz([
    [LINUX_ENTRY, "ELF", 0o755],
    ["happyview-x86_64-unknown-linux-musl/happyview-codemod", "CODEMOD", 0o755],
  ]);
  expect(text(extractNamed(tar, LINUX, CODEMOD_NAME))).toBe("CODEMOD");
  const without = tarXz([[LINUX_ENTRY, "ELF", 0o755]]);
  expect(failure(() => extractNamed(without, LINUX, CODEMOD_NAME)).message).toContain(
    "happyview-codemod",
  );
});

it("the_codemod_comes_from_the_same_verified_archive", async () => {
  const server = await start();
  const archive = tarXz([
    [LINUX_ENTRY, "ELF", 0o755],
    ["happyview-x86_64-unknown-linux-musl/happyview-codemod", "#!/bin/sh\n", 0o755],
  ]);
  const asset = assetName(LINUX);
  server.given("GET", `/dl/v3.0.0/${asset}`, { body: Buffer.from(archive) }).expect(1);
  server.given("GET", `/dl/v3.0.0/${asset}.sha256`, { body: hex(archive) }).expect(1);
  const cache = tempdir();
  const got = await ensureNamed(
    httpClient(),
    source(server),
    cache,
    "3.0.0",
    LINUX,
    CODEMOD_NAME,
    () => {},
  );
  expect(got).toBe(withFileName(binaryPath(cache, "3.0.0", LINUX), CODEMOD_NAME));
  expect(readFileSync(got).toString()).toBe("#!/bin/sh\n");
});

it("an_archive_reaching_outside_itself_is_refused", () => {
  const cases: [Parameters<typeof rawTarXz>[0], string][] = [
    [
      [
        ["../happyview", "regular", "x"],
        [LINUX_ENTRY, "regular", "ELF"],
      ],
      "outside",
    ],
    [
      [
        ["/tmp/happyview", "regular", "x"],
        [LINUX_ENTRY, "regular", "ELF"],
      ],
      "outside",
    ],
    [
      [
        ["..\\happyview", "regular", "x"],
        [LINUX_ENTRY, "regular", "ELF"],
      ],
      "outside",
    ],
    [
      [
        ["C:\\happyview", "regular", "x"],
        [LINUX_ENTRY, "regular", "ELF"],
      ],
      "outside",
    ],
    [[[LINUX_ENTRY, "symlink", ""]], "link"],
  ];
  for (const [entries, says] of cases) {
    const err = failure(() => extractNamed(rawTarXz(entries), LINUX, BINARY_NAME));
    expect(err.message, JSON.stringify(entries)).toContain(says);
  }
  const twice = rawTarXz([
    [LINUX_ENTRY, "regular", "one"],
    [LINUX_ENTRY, "regular", "two"],
  ]);
  expect(failure(() => extractNamed(twice, LINUX, BINARY_NAME)).message).toContain(
    "more than once",
  );
});

it("downloads_verifies_and_caches_once", async () => {
  const server = await start();
  const archive = tarXz([[LINUX_ENTRY, "#!/bin/sh\n", 0o755]]);
  const asset = assetName(LINUX);
  server.given("GET", `/dl/v3.0.0/${asset}`, { body: Buffer.from(archive) }).expect(1);
  server
    .given("GET", `/dl/v3.0.0/${asset}.sha256`, { body: `${hex(archive)} *${asset}\n` })
    .expect(1);
  const cache = tempdir();
  const http = httpClient();
  const got = await ensureBinary(http, source(server), cache, "3.0.0", LINUX, () => {});
  expect(got).toBe(binaryPath(cache, "3.0.0", LINUX));
  expect(readFileSync(got).toString()).toBe("#!/bin/sh\n");
  if (process.platform !== "win32") expect(statSync(got).mode & 0o777).toBe(0o755);
  await ensureBinary(http, source(server), cache, "3.0.0", LINUX, () => {});
});

it("a_checksum_mismatch_installs_nothing", async () => {
  const server = await start();
  const asset = assetName(LINUX);
  server.given("GET", `/dl/v3.0.0/${asset}`, {
    body: Buffer.from(tarXz([[LINUX_ENTRY, "x", 0o755]])),
  });
  server.given("GET", `/dl/v3.0.0/${asset}.sha256`, { body: hex("something else") });
  const cache = tempdir();
  const err = await failureOf(
    ensureBinary(httpClient(), source(server), cache, "3.0.0", LINUX, () => {}),
  );
  expect(err.message).toContain("does not match");
  expect(() => statSync(binaryPath(cache, "3.0.0", LINUX))).toThrow();
});

it("a_version_without_an_asset_is_a_usage_error", async () => {
  const server = await start();
  const cache = tempdir();
  const err = await failureOf(
    ensureBinary(httpClient(), source(server), cache, "2.9.0", LINUX, () => {}),
  );
  expect(err.code).toBe(2);
  expect(err.message).toContain("[happyview] version");
});

it("a_version_that_is_not_one_is_refused_before_any_download", async () => {
  const server = await start();
  server.given("*", "*", { status: 500 }).expect(0);
  const cache = tempdir();
  const err = await failureOf(
    ensureBinary(httpClient(), source(server), cache, "../../x", LINUX, () => {}),
  );
  expect(err.code).toBe(2);
  expect(readdirSync(cache).length).toBe(0);
});

it("windows_is_refused_before_anything_is_looked_up", async () => {
  const server = await start();
  server.given("*", "*", { status: 500 }).expect(0);
  const cache = tempdir();
  // Even a binary already in the cache is not one HappyView ships.
  const cached = binaryPath(cache, "3.0.0", WINDOWS);
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, "MZ");
  const err = await failureOf(
    ensureBinary(httpClient(), source(server), cache, "3.0.0", WINDOWS, () => {}),
  );
  expect(err.code).toBe(2);
  expect(err.message).toBe("running HappyView locally isn't supported on Windows; use WSL");
});

it("latest_for_windows_is_judged_by_the_linux_build", async () => {
  const server = await start();
  const linux = assetName(LINUX);
  server.given("GET", "/repos/o/happyview/releases", {
    json: [
      { tag_name: "v3.1.0", draft: false, assets: [] },
      { tag_name: "v3.0.0", draft: false, assets: [{ name: linux }] },
    ],
  });
  expect(await latestVersion(httpClient(), source(server), WINDOWS)).toBe("3.0.0");
});

it("latest_skips_drafts_and_releases_without_a_binary", async () => {
  const asset = assetName(LINUX);
  const latest = async (releases: unknown) => {
    const server = await start();
    server.given("GET", "/repos/o/happyview/releases", { json: releases });
    return latestVersion(httpClient(), source(server), LINUX);
  };
  const onlyPrereleases = [
    { tag_name: "v3.1.0", draft: true, assets: [{ name: asset }] },
    { tag_name: "v3.0.0-alpha.12", draft: false, assets: [{ name: asset }] },
    { tag_name: "v3.0.0-alpha.13", draft: false, assets: [] },
    { tag_name: "v2.9.0", draft: false, assets: [] },
  ];
  expect(await latest(onlyPrereleases)).toBe("3.0.0-alpha.12");
  // A stable release wins over a newer prerelease.
  const withStable = [
    { tag_name: "v3.1.0-alpha.1", draft: false, assets: [{ name: asset }] },
    { tag_name: "v3.0.0", draft: false, assets: [{ name: asset }] },
    { tag_name: "v2.9.0", draft: false, assets: [] },
  ];
  expect(await latest(withStable)).toBe("3.0.0");
});

it("latest_reads_every_page_of_releases", async () => {
  const server = await start();
  const asset = assetName(LINUX);
  const releases = "/repos/o/happyview/releases";
  const next = `<${server.url}${releases}?per_page=100&page=2>; rel="next", <${server.url}${releases}?per_page=100&page=2>; rel="last"`;
  // Mounted first, as wiremock's higher priority.
  server
    .given(
      "GET",
      releases,
      { json: [{ tag_name: "v3.0.0", draft: false, assets: [{ name: asset }] }] },
      query("page", "2"),
    )
    .expect(1);
  server
    .given("GET", releases, {
      headers: { link: next },
      json: [{ tag_name: "v3.1.0-alpha.2", draft: false, assets: [{ name: asset }] }],
    })
    .expect(1);
  expect(await latestVersion(httpClient(), source(server), LINUX)).toBe("3.0.0");
});

it("latest_stops_at_the_page_cap", async () => {
  const server = await start();
  const releases = "/repos/o/happyview/releases";
  const next = `<${server.url}${releases}?page=again>; rel="next"`;
  server.given("GET", releases, { headers: { link: next }, json: [] }).expect(MAX_RELEASE_PAGES);
  const err = await failureOf(latestVersion(httpClient(), source(server), LINUX));
  expect(err.message).toContain("[happyview] version");
});

it("the_next_page_is_read_from_the_link_header", () => {
  const link = `<https://a/r?page=1>; rel="prev", <https://a/r?page=3>; rel="next", <https://a/r?page=9>; rel="last"`;
  expect(nextPage(link)).toBe("https://a/r?page=3");
  expect(nextPage(`<https://a/r?page=9>; rel="last"`)).toBeUndefined();
});

/**
 * A raw HTTP server answering each request with `reply`, which writes to the socket itself.
 * Not a Rust test: Rust's client has no timeout, and the stall bound is this port's own.
 */
async function rawServer(reply: (socket: Socket) => void): Promise<string> {
  const sockets: Socket[] = [];
  const s = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", () => reply(socket));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  rawCleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const socket of sockets) socket.destroy();
        s.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/dl`;
}
const rawCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of rawCleanups.splice(0)) await c();
});

const head = (length: number) =>
  `HTTP/1.1 200 OK\r\ncontent-length: ${length}\r\ncontent-type: application/octet-stream\r\n\r\n`;

it("a_download_with_no_response_fails_once_it_stalls", async () => {
  const url = await rawServer(() => {});
  const started = Date.now();
  await expect(httpClient(300).request(url)).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("a_download_whose_body_stops_fails_once_it_stalls", async () => {
  const url = await rawServer((socket) => socket.write(`${head(10)}abc`));
  const resp = await httpClient(300).request(url);
  expect(resp.status).toBe(200);
  expect(resp.url).toBe(url);
  await expect(resp.arrayBuffer()).rejects.toThrow();
});

it("a_slow_download_that_keeps_coming_is_never_cut_off", async () => {
  // Eight chunks 100ms apart: longer than the stall bound in all, never that long between two.
  const url = await rawServer((socket) => {
    socket.write(head(8));
    let sent = 0;
    const tick = setInterval(() => {
      socket.write("x");
      if (++sent === 8) clearInterval(tick);
    }, 100);
  });
  const resp = await httpClient(300).request(url);
  expect(Buffer.from(await resp.arrayBuffer()).toString()).toBe("xxxxxxxx");
});

it("a_request_with_its_own_timeout_keeps_it", async () => {
  const url = await rawServer(() => {});
  await expect(httpClient(60_000).request(url, { timeout: 0.3 })).rejects.toThrow();
});
