// The version, injected by the bundler (scripts/build.mjs); from package.json when run from source.
import { readFileSync } from "node:fs";

declare const HPY_VERSION: string | undefined;

export const VERSION: string =
  typeof HPY_VERSION === "string"
    ? HPY_VERSION
    : (
        JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
          version: string;
        }
      ).version;

export const USER_AGENT = `hpy/${VERSION}`;
