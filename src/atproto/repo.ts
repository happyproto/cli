// hpy-atproto/src/repo.rs: the signed-in user's own repo. Commands are written
// against `Repo` so they can be tested with an in-memory fake. Writing plugin
// records is the registry's job: a raw `com.atproto.repo.*` write sent to
// HappyView is proxied wherever the instance routes it, which need not be the
// user's PDS.
import type { Json } from "../core/output.ts";
import { fromStr, value } from "../core/serde-json.ts";
import type { Credential } from "./credential.ts";
import { AtprotoError } from "./error.ts";
import { type HappyView, xrpcError } from "./happyview.ts";
import { request, transportError } from "./http.ts";

export interface StoredRecord {
  uri: string;
  cid: string | null;
  value: Json;
}

export interface WriteResult {
  uri: string;
  cid: string;
}

export interface Repo {
  did(): string;
  getRecord(collection: string, rkey: string): Promise<StoredRecord | null>;
  listRecords(collection: string): Promise<StoredRecord[]>;
  /** Uploads a blob and answers the blob ref JSON (`{$type, ref, mimeType, size}`). */
  uploadBlob(bytes: Uint8Array, mime: string): Promise<Json>;
  /**
   * The scopes this session was granted, where they are known. null means not
   * knowable here rather than none granted, so a caller that pre-checks a
   * grant has to let null through and leave the refusal to the server.
   */
  grantedScopes(): string | null;
}

/** The record key: the last path segment of an AT URI. */
export function rkeyOf(uri: string): string {
  const i = uri.lastIndexOf("/");
  return i === -1 ? uri : uri.slice(i + 1);
}

const field = (v: unknown, k: string): unknown =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)[k]
    : undefined;

function stored(v: unknown): StoredRecord {
  const uri = field(v, "uri");
  const cid = field(v, "cid");
  const val = field(v, "value");
  return {
    uri: typeof uri === "string" ? uri : "",
    cid: typeof cid === "string" ? cid : null,
    value: (val ?? null) as Json,
  };
}

/** Reads straight from the user's PDS (they are public); blob uploads go through HappyView, which holds the session. */
export class HappyViewRepo implements Repo {
  readonly #hv: HappyView;
  readonly #cred: Credential;

  constructor(hv: HappyView, cred: Credential) {
    this.#hv = hv;
    this.#cred = cred;
  }

  async #pdsGet(method: string, params: [string, string][]): Promise<Json | null> {
    const url = `${this.#cred.pds.replace(/\/+$/, "")}/xrpc/${method}`;
    let resp: Response;
    let body: string;
    try {
      resp = await request(url, { query: params, timeout: 30 });
    } catch (e) {
      throw AtprotoError.other(`could not reach your PDS (${method}): ${transportError(e)}`);
    }
    try {
      body = await resp.text();
    } catch (e) {
      throw AtprotoError.other(transportError(e));
    }
    if (resp.ok) {
      try {
        return fromStr(body, value) as Json;
      } catch (e) {
        throw AtprotoError.other(e);
      }
    }
    const err = xrpcError(method, resp.status, body, true);
    if (err.detail.kind === "Xrpc" && err.detail.name === "RecordNotFound") return null;
    throw err;
  }

  did(): string {
    return this.#cred.did;
  }

  grantedScopes(): string | null {
    return this.#cred.scopes;
  }

  async getRecord(collection: string, rkey: string): Promise<StoredRecord | null> {
    const page = await this.#pdsGet("com.atproto.repo.getRecord", [
      ["repo", this.#cred.did],
      ["collection", collection],
      ["rkey", rkey],
    ]);
    return page === null ? null : stored(page);
  }

  async listRecords(collection: string): Promise<StoredRecord[]> {
    const out: StoredRecord[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params: [string, string][] = [
        ["repo", this.#cred.did],
        ["collection", collection],
        ["limit", "100"],
      ];
      if (cursor !== null) params.push(["cursor", cursor]);
      const page = await this.#pdsGet("com.atproto.repo.listRecords", params);
      if (page === null) break;
      const records = field(page, "records");
      if (Array.isArray(records)) out.push(...records.map(stored));
      const next = field(page, "cursor");
      if (typeof next === "string" && next !== cursor) cursor = next;
      else break;
    }
    return out;
  }

  async uploadBlob(bytes: Uint8Array, mime: string): Promise<Json> {
    return this.#hv.uploadBlob(this.#cred, bytes, mime);
  }
}
