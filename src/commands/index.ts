// Route → handler. A route missing here exits 1 saying it is not ported yet.
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import * as auth from "./auth.ts";

export type Handler = (ctx: Ctx, args: Args) => Promise<void>;

export const HANDLERS: Record<string, Handler> = {
  "registry.login": auth.login,
  "registry.logout": auth.logout,
  "registry.whoami": auth.whoami,
};
