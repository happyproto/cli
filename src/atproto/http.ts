// What reqwest gave the Rust code for free: a user agent, timeouts, and
// StatusCode's Display (`404 Not Found`).
import { STATUS_CODES } from "node:http";
import { USER_AGENT } from "../core/version.ts";

export function statusText(status: number): string {
  const reason = STATUS_CODES[status];
  return reason ? `${status} ${reason}` : `${status}`;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Seconds; reqwest's per-client timeout in the Rust code. */
  timeout?: number;
  query?: [string, string][];
  /** Follow redirects (reqwest's default) or report them. */
  redirect?: "follow" | "manual";
}

export async function request(url: string, o: RequestOptions = {}): Promise<Response> {
  const u = new URL(url);
  for (const [k, v] of o.query ?? []) u.searchParams.append(k, v);
  return fetch(u, {
    method: o.method ?? "GET",
    headers: { "user-agent": USER_AGENT, ...(o.headers ?? {}) },
    ...(o.body !== undefined ? { body: o.body as BodyInit } : {}),
    redirect: o.redirect ?? "follow",
    signal: AbortSignal.timeout((o.timeout ?? 30) * 1000),
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
