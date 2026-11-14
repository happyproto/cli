// Route → handler. A route missing here exits 1 saying it is not ported yet.
import type { Args } from "../cli.ts";
import type { Ctx } from "../core/ctx.ts";
import * as add from "./add.ts";
import * as auth from "./auth.ts";
import * as build from "./build.ts";
import * as channel from "./channel.ts";
import * as check from "./check.ts";
import * as create from "./create.ts";
import * as deploy from "./deploy.ts";
import * as dev from "./dev.ts";
import * as env from "./env.ts";
import * as instance from "./instance.ts";
import * as lifecycle from "./lifecycle.ts";
import * as profile from "./profile.ts";
import * as publish from "./publish.ts";
import * as pull from "./pull/index.ts";
import * as scaffold from "./scaffold.ts";
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
  "hv.create": create.run,
  "hv.deploy": deploy.run,
  "hv.env.push": env.push,
  "hv.pull": pull.run,
  "hv.add": add.run,
  "hv.scaffold": scaffold.run,
  "hv.dev": dev.run,
  "hv.build": (ctx) => build.run(ctx),
  "hv.check": check.check,
  "hv.test": check.test,
  "hv.types": check.types,
  update: (ctx) => update.run(ctx),
  channel: channel.run,
};
