// hpy-atproto/src/scope.rs tests.
import { describe, expect, it } from "vitest";
import {
  coversBlob,
  coversRepo,
  missingBlobScopes,
  missingRepoScopes,
  PUBLISH_COLLECTIONS,
} from "../../src/atproto/scope.ts";
import { DEFAULT_SCOPE } from "../../src/atproto/settings.ts";

describe("scope", () => {
  it("an_exact_type_covers_only_itself", () => {
    expect(coversBlob("blob:application/wasm", "application/wasm")).toBe(true);
    expect(coversBlob("blob:application/wasm", "application/json")).toBe(false);
  });

  it("a_subtype_wildcard_covers_its_type", () => {
    expect(coversBlob("blob:image/*", "image/png")).toBe(true);
    expect(coversBlob("blob:image/*", "application/json")).toBe(false);
    // Not a prefix match: `image/*` must not admit `imagefoo/png`.
    expect(coversBlob("blob:image/*", "imagefoo/png")).toBe(false);
  });

  it("the_full_wildcard_covers_anything", () => {
    expect(coversBlob("blob:*/*", "application/json")).toBe(true);
    expect(coversBlob("atproto blob:*/*", "image/png")).toBe(true);
  });

  it("only_blob_permissions_are_read", () => {
    expect(coversBlob("atproto repo:application/json", "application/json")).toBe(false);
    expect(coversBlob("", "application/json")).toBe(false);
  });

  it("parameters_and_case_do_not_decide_a_match", () => {
    expect(coversBlob("blob:application/json", "application/json; charset=utf-8")).toBe(true);
    expect(coversBlob("blob:application/JSON", "application/json")).toBe(true);
  });

  it("the_missing_scopes_are_named_once_each_in_order", () => {
    const granted = "atproto blob:application/wasm";
    expect(missingBlobScopes(granted, ["application/wasm", "image/png", "image/png"])).toEqual([
      "blob:image/png",
    ]);
    expect(missingBlobScopes(granted, ["application/wasm"])).toEqual([]);
  });

  it("a_repo_permission_covers_its_collection_and_a_wildcard_covers_all", () => {
    expect(coversRepo("repo:a.b.c", "a.b.c")).toBe(true);
    expect(coversRepo("repo:a.b.c", "a.b.d")).toBe(false);
    // Action and other parameters narrow what may be done, not which collection.
    expect(coversRepo("atproto repo:a.b.c?action=create", "a.b.c")).toBe(true);
    expect(coversRepo("repo:*", "a.b.c")).toBe(true);
    expect(coversRepo("blob:a.b.c", "a.b.c")).toBe(false);
    expect(coversRepo("", "a.b.c")).toBe(false);
  });

  it("the_missing_repo_scopes_are_named_once_each_in_order", () => {
    expect(missingRepoScopes("atproto repo:a.b", ["a.b", "c.d", "c.d", "e.f"])).toEqual([
      "repo:c.d",
      "repo:e.f",
    ]);
  });

  it("the_default_scope_covers_every_collection_a_publish_writes", () => {
    expect(missingRepoScopes(DEFAULT_SCOPE, PUBLISH_COLLECTIONS)).toEqual([]);
    expect(PUBLISH_COLLECTIONS.length).toBe(8);
    // A grant from before the registry moved collections cannot publish.
    const old =
      "atproto repo:at.happyproto.plugin.profile repo:at.happyproto.plugin.release blob:application/wasm";
    expect(missingRepoScopes(old, PUBLISH_COLLECTIONS).length).toBe(8);
  });

  it("the_default_scope_covers_every_artifact_a_publish_uploads", () => {
    for (const mime of [
      "application/wasm",
      "application/json",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]) {
      expect(coversBlob(DEFAULT_SCOPE, mime), `the default scope cannot upload ${mime}`).toBe(true);
    }
  });
});
