// Route → handler. A route missing here exits 1 saying it is not ported yet.
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import * as auth from "./auth.ts";
import * as channel from "./channel.ts";
import * as instance from "./instance.ts";
import * as lifecycle from "./lifecycle.ts";
import * as profile from "./profile.ts";
import * as publish from "./publish.ts";
import * as status from "./status.ts";
import * as update from "./update.ts";

export type Handler = (ctx: Ctx, args: Args) => Promise<void>;

export const HANDLERS: Record<string, Handler> = {
  "registry.login": auth.login,
  "registry.logout": auth.logout,
  "registry.whoami": auth.whoami,
  "plugin.init": profile.init,
  "plugin.show": profile.show,
  "plugin.edit": profile.edit,
  "plugin.pull": profile.pull,
  "plugin.publish": publish.run,
  "plugin.status": status.run,
  "plugin.lifecycle": lifecycle.run,
  "hv.login": instance.login,
  "hv.logout": instance.logout,
  "hv.whoami": (ctx) => instance.whoami(ctx),
  update: (ctx) => update.run(ctx),
  channel: channel.run,
};
