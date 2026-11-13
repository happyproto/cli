// The version and the npm package's name, injected by the bundler (scripts/build.mjs); from
// package.json when run from source. package.json is the one place either is written down.
import { readFileSync } from "node:fs";

declare const HPY_VERSION: string | undefined;
declare const HPY_PACKAGE_NAME: string | undefined;

const manifest = (): { version: string; name: string } =>
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export const VERSION: string = typeof HPY_VERSION === "string" ? HPY_VERSION : manifest().version;

/** The npm package hpy is published as, for the `npm i -g` upgrade hint. */
export const PACKAGE_NAME: string =
  typeof HPY_PACKAGE_NAME === "string" ? HPY_PACKAGE_NAME : manifest().name;

export const USER_AGENT = `hpy/${VERSION}`;
