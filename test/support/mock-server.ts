// A real HTTP server for spawned-binary tests, in the spirit of wiremock:
// `given(method, path)` mounts a response, every request is recorded, and a
// mount can say how many times it expects to be hit.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
  json(): unknown;
}

export interface Reply {
  status?: number;
  json?: unknown;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

type Matcher = (r: Recorded) => boolean;

interface Mount {
  method: string;
  path: string | RegExp;
  extra: Matcher[];
  reply: Reply | ((r: Recorded) => Reply);
  expect?: number;
  /** wiremock's `up_to_n_times`: the mount stops matching after this many hits. */
  limit?: number;
  hits: number;
}

export class MockServer {
  readonly requests: Recorded[] = [];
  #mounts: Mount[] = [];
  #server: Server;
  url = "";

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<MockServer> {
    const m = new MockServer(createServer());
    m.#server.on("request", async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const u = new URL(req.url ?? "/", "http://x");
      const rec: Recorded = {
        method: req.method ?? "GET",
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks),
        json() {
          return JSON.parse(this.body.toString());
        },
      };
      m.requests.push(rec);
      const mount = m.#mounts.find(
        (x) =>
          (x.limit === undefined || x.hits < x.limit) &&
          (x.method === "*" || x.method === rec.method) &&
          (typeof x.path === "string"
            ? x.path === "*" || x.path === rec.path
            : x.path.test(rec.path)) &&
          x.extra.every((f) => f(rec)),
      );
      if (!mount) {
        res.writeHead(404).end();
        return;
      }
      mount.hits++;
      const reply = typeof mount.reply === "function" ? mount.reply(rec) : mount.reply;
      const headers = { ...(reply.headers ?? {}) };
      let body: string | Buffer = reply.body ?? "";
      if (reply.json !== undefined) {
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(reply.json);
      }
      res.writeHead(reply.status ?? 200, headers).end(body);
    });
    await new Promise<void>((res) => m.#server.listen(0, "127.0.0.1", () => res()));
    m.url = `http://127.0.0.1:${(m.#server.address() as AddressInfo).port}`;
    return m;
  }

  /** Mounts a response; later mounts are tried after earlier ones, as wiremock does. */
  given(
    method: string,
    path: string | RegExp,
    reply: Reply | ((r: Recorded) => Reply),
    ...extra: Matcher[]
  ) {
    const mount: Mount = { method, path, reply, extra, hits: 0 };
    this.#mounts.push(mount);
    const handle = {
      expect(n: number) {
        mount.expect = n;
        return handle;
      },
      times(n: number) {
        mount.limit = n;
        return handle;
      },
    };
    return handle;
  }

  /** wiremock's verify-on-drop: every mount with `expect(n)` was hit exactly n times. */
  verify(): void {
    for (const m of this.#mounts)
      if (m.expect !== undefined && m.hits !== m.expect)
        throw new Error(`${m.method} ${m.path}: expected ${m.expect} requests, got ${m.hits}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((res) => this.#server.close(() => res()));
  }
}

export const query =
  (k: string, v: string): Matcher =>
  (r) =>
    r.query.get(k) === v;
export const header =
  (k: string, v: string): Matcher =>
  (r) =>
    r.headers[k.toLowerCase()] === v;
export const bodyContains =
  (text: string): Matcher =>
  (r) =>
    r.body.toString().includes(text);
