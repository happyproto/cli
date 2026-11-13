// The plugin registry's gateway, read API and blob upload, for the parity
// harness's `@mockcred=<mode>` cases: the credential's registry is
// `$MOCK/reg-<mode>` and its PDS `$MOCK/reg-<mode>/pds`. A small stateful
// registry, like crate::testing's FakeRegistry, seeded per mode and reset
// before each binary's run (steps joined by ` ;; ` share it).
//
//   reg-new       nothing registered
//   reg-has       my-plugin registered as fixtures/plugin/basic describes it, with 0.9.0 published
//   reg-changed   my-plugin registered with another display name, a sidecar CID and an icon
//   reg-refuse    nothing registered; publishRelease refuses every release
//   reg-dup       my-plugin 1.0.0 already published with another artifact
//   reg-badcid    uploads answer a CID other than the bytes'
//   reg-swap      my-plugin registered; putProject answers InvalidSwap
//   reg-flaky     getVersion answers 500
import { rawCid } from "../../src/plugin/checksum.ts";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
const BANNER = Buffer.concat([PNG, Buffer.from("banner")]);
const blobRef = (bytes, mime) => ({
  $type: "blob",
  ref: { $link: rawCid(bytes) },
  mimeType: mime,
  size: bytes.length,
});

function projectView(did, name, o = {}) {
  return {
    uri: `at://${did}/software.release.project/${name}`,
    cid: "bafyproject",
    did,
    handle: "happyproto.at",
    name,
    sidecar: {
      uri: `at://${did}/at.happyproto.registry.project/${name}`,
      ...(o.sidecarCid ? { cid: o.sidecarCid } : {}),
    },
    publication: {
      uri: `at://${did}/site.standard.publication/${name}`,
      cid: "bafypublication",
      name: o.displayName ?? name,
      ...(o.description !== undefined ? { description: o.description } : {}),
      url: `https://happyproto.at/plugins/${did}/${name}`,
      ...(o.icon ? { icon: o.icon } : {}),
    },
    pluginType: o.pluginType ?? "library",
    keywords: o.keywords ?? [],
    authors: o.authors ?? [],
    security: o.security ?? [],
    channels: o.channels ?? {},
    lifecycle: { state: "active" },
    indexedAt: "2026-10-23T00:00:00Z",
  };
}

function versionView(did, name, version, artifact, availability = "available") {
  return {
    uri: `at://${did}/software.release.version/${name}.${version}`,
    cid: `bafyversion${version.replaceAll(/[^a-z0-9]/g, "")}`,
    did,
    name,
    version,
    manifest: { uri: `at://${did}/software.release.manifest/3l${version}`, cid: "bafymanifest" },
    artifact,
    availability,
    suspect: false,
    lifecycle: { state: "active", installable: true, events: [] },
    indexedAt: "2026-10-23T00:00:00Z",
  };
}

/** An earlier version's artifact: same banner, an older module. */
function olderArtifact() {
  return {
    $type: "at.happyproto.plugin.v1",
    package: blobRef(Buffer.from("old module"), "application/wasm"),
    manifest: blobRef(Buffer.from("old manifest"), "application/json"),
    banner: { image: blobRef(BANNER, "image/png"), width: 1, height: 1, alt: "A banner" },
    pluginType: "library",
    apiVersion: "2",
    capabilities: [],
    namespace: "my.plugin",
    requires: { "env:happyview": ">=3.0.0" },
    license: "MIT",
    sections: { description: "Does things." },
  };
}

/** my-plugin as fixtures/plugin/basic's hpy.toml describes it. */
const basic = (did, o = {}) =>
  projectView(did, "my-plugin", {
    displayName: "Mine",
    description: "Does things.",
    icon: rawCid(PNG),
    keywords: ["demo"],
    authors: [{ name: "Ada", email: "ada@example.com" }],
    security: [{ email: "security@example.com" }],
    ...o,
  });

function seed(mode, did) {
  const s = { projects: new Map(), versions: new Map(), publications: new Map() };
  const addVersion = (v) => s.versions.set(`${v.name}@${v.version}`, v);
  if (mode === "has" || mode === "swap") {
    s.projects.set(
      "my-plugin",
      basic(did, {
        channels: {
          latest: {
            version: "0.9.0",
            uri: `at://${did}/software.release.version/my-plugin.0.9.0`,
            cid: "bafyversion090",
            state: "active",
            availability: "available",
          },
        },
      }),
    );
    addVersion(versionView(did, "my-plugin", "0.9.0", olderArtifact()));
  }
  if (mode === "changed") {
    s.projects.set(
      "my-plugin",
      basic(did, { displayName: "Old Name", sidecarCid: "bafysidecar1" }),
    );
    s.publications.set("my-plugin", { name: "Old Name", icon: blobRef(PNG, "image/png") });
  }
  if (mode === "dup") {
    const other = { ...olderArtifact(), license: "Apache-2.0" };
    addVersion(versionView(did, "my-plugin", "1.0.0", other));
  }
  return s;
}

const err = (status, error, message) => ({
  status,
  json: message === undefined ? { error } : { error, message },
});

export function mountRegistry(server) {
  const states = new Map();
  const state = (mode, did) => {
    if (!states.has(mode)) states.set(mode, seed(mode, did));
    return states.get(mode);
  };
  server.reset = () => states.clear();
  server.given("*", /^\/reg-[a-z]+\/(pds\/)?xrpc\//, (r) => {
    const [, modeSeg, ...rest] = r.path.split("/");
    const mode = modeSeg.slice(4);
    const onPds = rest[0] === "pds";
    const method = onPds ? rest[2] : rest[1];
    const q = (k) => r.query.get(k);
    const did = q("actor") ?? q("did") ?? q("repo") ?? "did:plc:mo7vq4jbioxwafy5zkcc3eux";
    const s = state(mode, did);
    const body = r.method === "POST" && method !== "com.atproto.repo.uploadBlob" ? r.json() : {};
    const name = q("name") ?? body.name;
    switch (method) {
      case "com.atproto.repo.getRecord": {
        const rec =
          q("collection") === "site.standard.publication"
            ? s.publications.get(q("rkey"))
            : undefined;
        if (!rec) return err(400, "RecordNotFound", "Could not locate record");
        return {
          json: {
            uri: `at://${did}/${q("collection")}/${q("rkey")}`,
            cid: "bafypubrecord",
            value: rec,
          },
        };
      }
      case "at.happyproto.registry.getProject": {
        const p = s.projects.get(name);
        return p ? { json: p } : err(400, "ProjectNotFound", "no such project");
      }
      case "at.happyproto.registry.getVersion": {
        if (mode === "flaky") return err(500, "InternalServerError", "try again");
        const v = s.versions.get(`${name}@${q("version")}`);
        return v ? { json: v } : err(400, "VersionNotFound", "no such version");
      }
      case "at.happyproto.registry.listVersions": {
        const versions = [...s.versions.values()].filter((v) => v.name === name).reverse();
        return { json: { versions } };
      }
      case "com.atproto.repo.uploadBlob": {
        const cid = mode === "badcid" ? rawCid(Buffer.from("something else")) : rawCid(r.body);
        return {
          json: {
            blob: {
              $type: "blob",
              ref: { $link: cid },
              mimeType: r.headers["content-type"],
              size: r.body.length,
            },
          },
        };
      }
      case "at.happyproto.registry.putProject": {
        if (mode === "swap") return err(400, "InvalidSwap", "the sidecar changed");
        if (body.validateOnly) return { json: {} };
        const did_ = "did:plc:mo7vq4jbioxwafy5zkcc3eux";
        const created = !s.projects.has(name);
        const icon = body.publication?.icon?.ref?.$link;
        const old = s.projects.get(name);
        s.projects.set(
          name,
          projectView(did_, name, {
            displayName: body.publication?.name,
            description: body.publication?.description,
            icon,
            pluginType: body.project?.pluginType,
            keywords: body.project?.keywords,
            authors: body.project?.authors,
            security: body.project?.security,
            sidecarCid: "bafysidecar2",
            channels: old?.channels,
          }),
        );
        s.publications.set(name, body.publication);
        const ref = (c) => ({ uri: `at://${did_}/${c}/${name}`, cid: `bafy${c.split(".").pop()}` });
        return {
          json: {
            created,
            project: ref("software.release.project"),
            publication: ref("site.standard.publication"),
            sidecar: ref("at.happyproto.registry.project"),
          },
        };
      }
      case "at.happyproto.registry.publishRelease": {
        if (mode === "refuse")
          return err(400, "InvalidRecord", "capabilities must be declared, even when empty");
        if (!s.projects.has(name)) return err(400, "ProjectMissing", `no project named ${name}`);
        if (body.validateOnly) return { json: {} };
        const did_ = "did:plc:mo7vq4jbioxwafy5zkcc3eux";
        const key = `${name}@${body.version}`;
        const resumed = s.versions.has(key);
        const v = versionView(did_, name, body.version, body.artifact);
        s.versions.set(key, v);
        const p = s.projects.get(name);
        p.channels[body.track] = {
          version: body.version,
          uri: v.uri,
          cid: v.cid,
          state: "active",
          availability: "available",
        };
        return {
          json: {
            resumed,
            manifest: v.manifest,
            version: { uri: v.uri, cid: v.cid },
            channel: {
              uri: `at://${did_}/software.release.channel/${name}.${body.track}`,
              cid: "bafychannel",
            },
          },
        };
      }
      case "at.happyproto.registry.promoteRelease": {
        const from = s.versions.get(`${name}@${body.fromVersion}`);
        if (!from) return err(400, "VersionNotFound", `no version ${body.fromVersion}`);
        const v = versionView(from.did, name, body.version, from.artifact);
        s.versions.set(`${name}@${body.version}`, v);
        return { json: { version: { uri: v.uri, cid: v.cid } } };
      }
      default:
        return { status: 404 };
    }
  });
}
