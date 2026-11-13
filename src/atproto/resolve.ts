// hpy-atproto/src/resolve.rs: from what the user typed to where to sign them
// in. Handle or DID → DID document → PDS → its authorization server's
// metadata. The Rust code used jacquard's resolvers; this is the same chain:
// handles by DNS TXT (`_atproto.<handle>`) then `/.well-known/atproto-did`,
// did:plc through plc.directory, did:web through `/.well-known/did.json`.
import { resolveTxt } from "node:dns/promises";
import { AtprotoError } from "./error.ts";
import { request } from "./http.ts";

export interface AuthServer {
  issuer: string;
  parEndpoint: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface Resolved {
  did: string;
  handle: string | null;
  pds: string;
  auth: AuthServer;
}

export interface Resolver {
  resolve(identifier: string): Promise<Resolved>;
}

const PLC_DIRECTORY = "https://plc.directory";

async function getJson(url: string): Promise<Record<string, unknown>> {
  const resp = await request(url, { headers: { accept: "application/json" }, timeout: 10 });
  if (!resp.ok) throw new Error(`${url} answered ${resp.status}`);
  const v = await resp.json();
  if (!v || typeof v !== "object") throw new Error(`${url} answered no JSON object`);
  return v as Record<string, unknown>;
}

async function handleToDid(handle: string): Promise<string> {
  try {
    const records = await resolveTxt(`_atproto.${handle}`);
    const dids = records
      .map((r) => r.join(""))
      .filter((t) => t.startsWith("did="))
      .map((t) => t.slice(4));
    if (dids.length === 1 && dids[0]) return dids[0];
  } catch {}
  const resp = await request(`https://${handle}/.well-known/atproto-did`, { timeout: 10 });
  if (!resp.ok) throw new Error(`handle ${handle} did not resolve`);
  const did = (await resp.text()).trim();
  if (!did.startsWith("did:")) throw new Error(`handle ${handle} did not resolve to a DID`);
  return did;
}

async function didDocument(did: string): Promise<Record<string, unknown>> {
  if (did.startsWith("did:plc:")) return getJson(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`);
  if (did.startsWith("did:web:")) {
    const host = decodeURIComponent(did.slice("did:web:".length));
    return getJson(`https://${host}/.well-known/did.json`);
  }
  throw new Error(`unsupported DID method in ${did}`);
}

function pdsEndpoint(doc: Record<string, unknown>): string | null {
  const services = Array.isArray(doc.service) ? doc.service : [];
  for (const s of services) {
    if (!s || typeof s !== "object") continue;
    const svc = s as Record<string, unknown>;
    const id = String(svc.id ?? "");
    if (
      (id === "#atproto_pds" || id.endsWith("#atproto_pds")) &&
      svc.type === "AtprotoPersonalDataServer"
    ) {
      if (typeof svc.serviceEndpoint === "string") return svc.serviceEndpoint;
    }
  }
  return null;
}

function handles(doc: Record<string, unknown>): string[] {
  const aka = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : [];
  return aka
    .filter((a): a is string => typeof a === "string" && a.startsWith("at://"))
    .map((a) => a.slice(5));
}

async function authServerOf(pds: string): Promise<Record<string, unknown>> {
  const base = pds.replace(/\/+$/, "");
  const resource = await getJson(`${base}/.well-known/oauth-protected-resource`);
  const servers = Array.isArray(resource.authorization_servers)
    ? resource.authorization_servers
    : [];
  const issuer = servers.find((s): s is string => typeof s === "string");
  if (!issuer) throw new Error(`${pds} names no authorization server`);
  return getJson(`${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`);
}

/** The real network. */
export class NetworkResolver implements Resolver {
  async resolve(input: string): Promise<Resolved> {
    const identifier = input.trim().replace(/^@+/, "");
    if (identifier.startsWith("http://") || identifier.startsWith("https://"))
      throw AtprotoError.other("sign in with your handle or DID, not a server URL");
    let did: string;
    let doc: Record<string, unknown>;
    let meta: Record<string, unknown>;
    try {
      did = identifier.startsWith("did:")
        ? identifier
        : await handleToDid(identifier.toLowerCase());
      doc = await didDocument(did);
      const pdsUrl = pdsEndpoint(doc);
      if (pdsUrl === null)
        throw AtprotoError.other(`\`${identifier}\` has no PDS in its DID document`);
      meta = await authServerOf(pdsUrl);
    } catch (e) {
      if (e instanceof AtprotoError) throw e;
      throw AtprotoError.other(
        `could not find where \`${identifier}\` signs in: ${(e as Error).message}`,
      );
    }
    const pds = pdsEndpoint(doc) as string;
    const parEndpoint = meta.pushed_authorization_request_endpoint;
    if (typeof parEndpoint !== "string")
      throw AtprotoError.other("the authorization server does not support PAR");
    return {
      did: typeof doc.id === "string" ? doc.id : did,
      handle: handles(doc)[0] ?? null,
      pds: pds.replace(/\/+$/, ""),
      auth: {
        issuer: String(meta.issuer ?? ""),
        parEndpoint,
        authorizationEndpoint: String(meta.authorization_endpoint ?? ""),
        tokenEndpoint: String(meta.token_endpoint ?? ""),
      },
    };
  }
}
