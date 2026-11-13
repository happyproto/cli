// What reqwest gave the Rust code for free: a user agent, timeouts, and
// StatusCode's Display (`404 Not Found`).
import * as nodeHttp from "node:http";
import type { Json } from "../core/output.ts";
import { fromSlice, type Node, node, objectEntries } from "../core/serde-json.ts";
import { USER_AGENT } from "../core/version.ts";

export function statusText(status: number): string {
  const reason = nodeHttp.STATUS_CODES[status];
  return reason ? `${status} ${reason}` : `${status}`;
}

type ProxyEnv = Record<string, string | undefined>;

/**
 * reqwest's proxy settings, which every Rust request honoured: hyper-util's `Matcher::from_env`
 * (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` for both, `NO_PROXY`; the upper-case name wins
 * when set, even empty; none under CGI, when `REQUEST_METHOD` is set). Node's fetch ignores
 * these unless told, so main applies them once at startup. Where the runtime has no
 * `setGlobalProxyFromEnv` (Node before 24.5, Bun, whose fetch reads `HTTP(S)_PROXY` itself),
 * this does nothing.
 */
export function useEnvProxy(env: ProxyEnv = process.env): void {
  if ("Bun" in globalThis) {
    useEnvProxyUnderBun(env);
    return;
  }
  const set = (nodeHttp as { setGlobalProxyFromEnv?: (e: ProxyEnv) => unknown })
    .setGlobalProxyFromEnv;
  if (typeof set !== "function" || env.REQUEST_METHOD !== undefined) return;
  const proxies = proxyEnv(env);
  if (proxies === undefined) return;
  try {
    set(proxies);
  } catch {
    // A proxy Node cannot use (a socks:// one) is left to fail as no proxy would.
  }
}

/**
 * Bun's fetch reads HTTP_PROXY, HTTPS_PROXY and NO_PROXY itself, but not ALL_PROXY, nor a bare
 * `host:port`. Writing reqwest's reading of them back into the environment makes Bun use the
 * same proxies. (Children see the normalised values; reqwest's reading is the one hpy means.)
 */
function useEnvProxyUnderBun(env: ProxyEnv): void {
  if (env.REQUEST_METHOD !== undefined) return;
  const proxies = proxyEnv(env);
  if (proxies === undefined) return;
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] as const) {
    const v = proxies[k];
    if (v !== undefined && v !== "") env[k] = v;
  }
}

/** The settings `useEnvProxy` hands Node, or `undefined` for none. */
export function proxyEnv(env: ProxyEnv): ProxyEnv | undefined {
  const first = (...names: string[]): string => {
    for (const n of names) {
      const v = env[n];
      if (v !== undefined) return v;
    }
    return "";
  };
  // `parse_env_uri`: empty is unset, and a bare host:port is an http:// proxy.
  const uri = (v: string): string | undefined =>
    v === "" ? undefined : v.includes("://") ? v : `http://${v}`;
  const all = uri(first("ALL_PROXY", "all_proxy"));
  const http = uri(first("HTTP_PROXY", "http_proxy")) ?? all;
  const https = uri(first("HTTPS_PROXY", "https_proxy")) ?? all;
  if (http === undefined && https === undefined) return undefined;
  const out: ProxyEnv = { NO_PROXY: first("NO_PROXY", "no_proxy") };
  if (http !== undefined) out.HTTP_PROXY = http;
  if (https !== undefined) out.HTTPS_PROXY = https;
  return out;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Seconds; reqwest's per-client timeout in the Rust code. `null` is a client with none. */
  timeout?: number | null;
  query?: [string, string][];
  /** Follow redirects (reqwest's default) or report them. */
  redirect?: "follow" | "manual";
  /** Aborts the request early, on top of the timeout. */
  signal?: AbortSignal;
}

export async function request(url: string, o: RequestOptions = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of o.query ?? []) u.searchParams.append(k, v);
  return fetch(u, {
    method: o.method ?? "GET",
    headers: { "user-agent": USER_AGENT, ...(o.headers ?? {}) },
    ...(o.body !== undefined ? { body: o.body as BodyInit } : {}),
    redirect: o.redirect ?? "follow",
    ...(o.timeout === null
      ? o.signal
        ? { signal: o.signal }
        : {}
      : {
          signal: o.signal
            ? AbortSignal.any([o.signal, AbortSignal.timeout((o.timeout ?? 30) * 1000)])
            : AbortSignal.timeout((o.timeout ?? 30) * 1000),
        }),
  });
}

/** `.json(&value)`: the body and its content type. */
export function jsonBody(text: string): { body: string; headers: Record<string, string> } {
  return { body: text, headers: { "content-type": "application/json" } };
}

/** reqwest's Display for a transport error, roughly: the cause's message. */
export function transportError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    if (e.name === "TimeoutError" || e.name === "AbortError") return "operation timed out";
    if (cause instanceof Error) return `error sending request: ${cause.message}`;
    return e.message;
  }
  return String(e);
}

/**
 * A parsed `serde_json::Value` as plain `Json`: the last of duplicate keys wins and keys come
 * out sorted, as `Value`'s map holds them. Integers past 2^53 lose precision, as JSON.parse's do.
 */
export function nodeJson(n: Node): Json {
  switch (n.kind) {
    case "null":
    case "bool":
    case "string":
      return n.value;
    case "number":
      return Number(n.value);
    case "array":
      return n.children.map(nodeJson);
    case "object": {
      const out: { [key: string]: Json } = {};
      for (const [key, value] of objectEntries(n)) {
        Object.defineProperty(out, key, {
          value: nodeJson(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
  }
}

/**
 * `serde_json::from_slice::<Value>`: throws serde_json's own error (`expected value at line 1
 * column 1`) for a body that is not JSON.
 */
export function parseJson(bytes: Uint8Array): Json {
  return nodeJson(fromSlice(bytes, node));
}

/** reqwest's Display for `Response::json`'s error: the serde error is only its source. */
export const DECODE_ERROR = "error decoding response body";
