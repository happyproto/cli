// hpy-plugin/src/lib.rs: the collections a plugin release is written to.
export const PROJECT_NSID = "software.release.project";
export const MANIFEST_NSID = "software.release.manifest";
export const VERSION_NSID = "software.release.version";
export const CHANNEL_NSID = "software.release.channel";
export const STATUS_NSID = "software.release.status";
export const SIDECAR_NSID = "at.happyproto.registry.project";
export const PUBLICATION_NSID = "site.standard.publication";
export const DOCUMENT_NSID = "site.standard.document";
/** The `$type` of a plugin's entry in a `software.release.manifest`'s `artifacts`. */
export const ARTIFACT_TYPE = "at.happyproto.plugin.v1";
export const TRACKS = ["latest", "beta", "alpha"] as const;
export const PLUGIN_TYPES = ["auth", "library", "interpreter"] as const;
