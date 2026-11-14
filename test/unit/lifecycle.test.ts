// crates/hpy/src/commands/lifecycle.rs tests.
import { expect, it } from "vitest";
import { DEFAULT_SCOPE } from "../../src/atproto/settings.ts";
import {
  checkGrant,
  type Details,
  EVENTS,
  put,
  type Subject,
  statusInput,
  withdrawInput,
} from "../../src/commands/lifecycle.ts";
import type { Failure } from "../../src/core/failure.ts";
import { STATUS_NSID } from "../../src/plugin/nsid.ts";
import { DID, FakeRegistry, FakeRepo } from "../support/fakes.ts";

const input = (subject: Subject, event: string, details: Details = {}) =>
  statusInput(DID, "my-plugin", subject, event, details);

function failure(f: () => unknown): Failure {
  try {
    f();
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected a failure");
}

async function failureOf(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("expected a failure");
}

it("a_version_status_names_the_version_record", () => {
  expect(
    input({ version: "1.0.0" }, "endOfSupport", { kind: "security", reason: "use 2.x" }),
  ).toEqual({
    subject: "at://did:plc:testuser/software.release.version/my-plugin.1.0.0",
    status: "endOfSupport",
    kind: "security",
    reason: "use 2.x",
  });
});

it("a_project_status_names_the_project_record", () => {
  expect(input({ project: true }, "endOfLife").subject).toBe(
    "at://did:plc:testuser/software.release.project/my-plugin",
  );
});

it("only_the_registrys_events_are_accepted", () => {
  for (const event of EVENTS) {
    const details = event === "supersededBy" ? { supersededBy: "2.0.0" } : {};
    expect(() => input({ project: true }, event, details), event).not.toThrow();
  }
  for (const event of ["deprecated", "EndOfLife", ""]) {
    const err = failure(() => input({ project: true }, event));
    expect(err.code, event).toBe(2);
    expect(err.message, event).toContain("endOfDistribution");
  }
  expect(failure(() => input({ project: true }, "withdrawn")).message).toContain("--withdraw");
});

it("superseded_by_needs_and_only_goes_with_its_version", () => {
  expect(failure(() => input({ project: true }, "supersededBy")).message).toContain(
    "--superseded-by",
  );
  expect(input({ version: "1.0.0" }, "supersededBy", { supersededBy: "2.0.0" }).supersededBy).toBe(
    "2.0.0",
  );
  expect(failure(() => input({ project: true }, "endOfLife", { supersededBy: "2.0.0" })).code).toBe(
    2,
  );
  expect(failure(() => input({ version: "v1" }, "endOfLife")).code).toBe(2);
});

it("a_withdrawal_names_the_status_and_its_subject", async () => {
  const subject = "at://did:plc:testuser/software.release.version/my-plugin.1.0.0";
  const repo = FakeRepo.with([[STATUS_NSID, "3labc", { subject, status: "endOfLife" }]]);
  const uri = `at://${DID}/${STATUS_NSID}/3labc`;
  const got = await withdrawInput(repo, uri, "by mistake");
  expect(got).toEqual({ subject, status: "withdrawn", withdraws: uri, reason: "by mistake" });
  const reg = new FakeRegistry();
  expect(await put(reg, got)).toEqual({
    uri: "at://did:plc:testuser/software.release.status/3lstatus",
    cid: "bafystatus",
  });
  expect(reg.statuses[0]).toEqual(got);
});

it("a_grant_without_the_status_collection_is_refused", () => {
  const old = new FakeRepo({ scopes: "atproto repo:at.happyproto.plugin.release" });
  const err = failure(() => checkGrant(old));
  expect(err.code).toBe(2);
  expect(err.message).toContain("repo:software.release.status");
  checkGrant(new FakeRepo({ scopes: DEFAULT_SCOPE }));
  checkGrant(new FakeRepo());
});

it("only_your_own_existing_status_can_be_withdrawn", async () => {
  const repo = new FakeRepo();
  for (const uri of [
    "at://did:plc:someoneelse/software.release.status/3labc",
    `at://${DID}/software.release.version/my-plugin.1.0.0`,
    `at://${DID}/${STATUS_NSID}/3lnothere`,
  ]) {
    expect((await failureOf(withdrawInput(repo, uri, undefined))).code, uri).toBe(2);
  }
});
