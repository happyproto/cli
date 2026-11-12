// `exported_credential` from tests/cli.rs: a fresh key and a fake token.
import { exportCredential } from "../../src/atproto/credential.ts";
import { DpopKey } from "../../src/atproto/dpop.ts";

export async function exportedCredential(
  did: string,
  registry = "https://api.happyproto.at",
  handle: string | null = "alice.test",
): Promise<string> {
  return exportCredential({
    registry,
    clientKey: "hvc_test",
    did,
    handle,
    pds: "https://pds.test",
    scopes: "atproto",
    accessToken: "tok",
    dpopKey: await DpopKey.generate(),
  });
}
