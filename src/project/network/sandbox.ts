// crates/hpy/src/project/network/sandbox.rs: the sandbox's lifecycle, through the CLI
// Atmosphere in a Box documents.
import { existsSync, rmdirSync } from "node:fs";
import { Failure } from "../../core/failure.ts";
import { readToString } from "../../core/io.ts";
import { rustJoin } from "../../core/paths.ts";
import { lines, trim } from "../../core/rust-str.ts";
import { get, type Node, parseValue } from "../../core/serde-json.ts";
import { ipv4 } from "../../values.ts";
import { APP_ID, type Written } from "./app.ts";
import { isFile } from "./atmosbox.ts";
import { Exit, type Runner } from "./runner.ts";

/** `str::split_whitespace`. */
const words = (s: string): string[] => s.split(/\p{White_Space}+/u).filter((w) => w !== "");

/**
 * The network a sandbox is created on. The one it was last created on is kept, through
 * `--reset` too, until `--subnet` names another; a project with neither gets the one derived
 * from its path. A created sandbox cannot move, so asking one to is refused rather than
 * ignored.
 */
export function chooseSubnet(
  asked: string | undefined,
  recorded: string | undefined,
  derived: string,
  created: boolean,
  reset: boolean,
): string {
  if (asked !== undefined && recorded !== undefined && created && !reset) {
    const a = ipv4Range(asked);
    const b = ipv4Range(recorded);
    const same =
      a === undefined ? b === undefined : b !== undefined && a[0] === b[0] && a[1] === b[1];
    if (!same) {
      throw Failure.usage(
        `this project's local network was created on ${recorded}; to move it to ${asked}, ` +
          "run this again with --reset, which discards its accounts, records and database",
      );
    }
  }
  return asked ?? recorded ?? derived;
}

/** An IPv4 CIDR as its first and last address; `undefined` for anything else, IPv6 included. */
function ipv4Range(cidr: string): [number, number] | undefined {
  const slash = cidr.indexOf("/");
  if (slash === -1) return undefined;
  const addr = ipv4(cidr.slice(0, slash));
  if (addr === undefined) return undefined;
  const p = cidr.slice(slash + 1);
  // Rust's u32 parser takes an optional leading `+`.
  if (!/^\+?[0-9]+$/.test(p)) return undefined;
  const prefix = Number(p.replace(/^\+/, ""));
  if (!(prefix <= 32)) return undefined;
  const size = 2 ** (32 - prefix);
  const start = addr - (addr % size);
  return [start, start + size - 1];
}

/**
 * The first Docker network, from `docker network inspect` lines of a name followed by its
 * subnets, whose subnet overlaps `ours`.
 */
export function overlappingNetwork(inspect: string, ours: string): [string, string] | undefined {
  const range = ipv4Range(ours);
  if (range === undefined) return undefined;
  const [a, b] = range;
  for (const line of lines(inspect)) {
    const [name, ...cidrs] = words(line);
    if (name === undefined) continue;
    const cidr = cidrs.find((c) => {
      const r = ipv4Range(c);
      return r !== undefined && r[0] <= b && a <= r[1];
    });
    if (cidr !== undefined) return [name, cidr];
  }
  return undefined;
}

/**
 * The services that read the sandbox's routes only when they start: its DNS server, its HTTPS
 * gateway, and each PDS (`pds1`, `pds-space1`, …), which otherwise cannot resolve or reach a
 * route added after they started.
 */
function readsRoutesAtStart(service: string): boolean {
  const pdsNumber = service.startsWith("pds-space")
    ? service.slice(9)
    : service.startsWith("pds")
      ? service.slice(3)
      : undefined;
  return (
    service === "dns" ||
    service === "gateway" ||
    (pdsNumber !== undefined && /^[1-9][0-9]*$/.test(pdsNumber))
  );
}

function manifest(checkout: string): Node | undefined {
  try {
    return parseValue(readToString(rustJoin(checkout, "state/manifest.json")));
  } catch {
    return undefined;
  }
}

export class Sandbox {
  readonly runner: Runner;
  readonly checkout: string;
  readonly project: string;
  /** The network `create` asks for; see `chooseSubnet`. */
  subnet: string;

  constructor(runner: Runner, checkout: string, project: string, subnet: string) {
    this.runner = runner;
    this.checkout = checkout;
    this.project = project;
    this.subnet = subnet;
  }

  static args(rest: readonly string[]): string[] {
    return ["task", "sandbox", ...rest];
  }

  private async task(rest: readonly string[]): Promise<void> {
    const args = Sandbox.args(rest);
    const exit = await this.releasingADroppedLock(() =>
      this.runner.show("deno", args, this.checkout),
    );
    Exit.check(exit, "deno", args);
  }

  /** The directory the sandbox CLI holds for the length of one command. */
  lock(): string {
    return rustJoin(this.checkout, "state/cli.lock");
  }

  /** Refuses a lock no child of this run took: another `deno task sandbox` may hold it, and only the developer can tell. */
  refuseAHeldLock(): void {
    const lock = this.lock();
    if (existsSync(lock)) {
      throw Failure.usage(
        `the local network's sandbox is locked:\n\n  ${lock}\n\nAnother \`deno task sandbox\` may be running in ${this.checkout}; ` +
          "if none is, a previous run crashed: inspect that lock, remove it, and run this again",
      );
    }
  }

  /**
   * Runs one sandbox command and removes the lock it leaves only if a signal ended it and the
   * lock was not there before it started. The CLI releases its lock on every exit it makes
   * itself, error or not, so a lock left after one is someone else's: its "CLI locked"
   * refusal, for one, is an ordinary exit 1 caused by another command's lock. Only a signal
   * stops our child before it can let go.
   */
  async releasingADroppedLock(command: () => Promise<Exit>): Promise<Exit> {
    const lock = this.lock();
    const heldBefore = existsSync(lock);
    const exit = await command();
    if (!heldBefore && exit.signal !== undefined && existsSync(lock)) {
      // The CLI's lock is an empty directory.
      try {
        rmdirSync(lock);
      } catch {}
    }
    return exit;
  }

  /** The network the sandbox's manifest says it was created on; `undefined` when there is none. */
  recordedSubnet(): string | undefined {
    const m = manifest(this.checkout);
    const subnet = m === undefined ? undefined : get(m, "subnet");
    return subnet?.kind === "string" ? subnet.value : undefined;
  }

  created(): boolean {
    return isFile(rustJoin(this.checkout, "state/manifest.json"));
  }

  /**
   * Whether the sandbox's own record of selected applications names HappyView. An unreadable
   * manifest reads as "not applied", which only costs a redundant `apply`.
   */
  applied(): boolean {
    const m = manifest(this.checkout);
    const apps = m === undefined ? undefined : get(m, "applications");
    if (apps?.kind !== "array") return false;
    return apps.children.some((a) => a.kind === "string" && a.value === APP_ID);
  }

  /**
   * An interrupted `create` or `apply` leaves one of these behind, and the sandbox refuses
   * everything else until `resume` has finished it.
   */
  pending(): boolean {
    return ["pending-create.json", "pending-apply.json"].some((f) =>
      isFile(rustJoin(this.checkout, "state", f)),
    );
  }

  resume(): Promise<void> {
    return this.task(["resume"]);
  }

  /**
   * Refuses a subnet another Docker network already holds, naming that network, before
   * `create` fails on it with Docker's own error. A network of this sandbox's own project is
   * left out: a `create` that failed part way can leave one.
   */
  async refuseATakenSubnet(): Promise<void> {
    const names = await this.runner.capture(
      "docker",
      ["network", "ls", "--format", "{{.Name}}"],
      this.checkout,
    );
    const own = `${this.project}_`;
    const others = lines(names)
      .map(trim)
      .filter((n) => n !== "" && !n.startsWith(own));
    if (others.length === 0) return;
    const args = [
      "network",
      "inspect",
      "--format",
      "{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}",
      ...others,
    ];
    const inspect = await this.runner.capture("docker", args, this.checkout);
    const found = overlappingNetwork(inspect, this.subnet);
    if (found !== undefined) {
      const [name, theirs] = found;
      throw Failure.usage(
        `the local network for this project uses ${this.subnet}, which overlaps Docker network \`${name}\` (${theirs}); ` +
          "choose another with `--subnet <CIDR>` (a private IPv4 network from /16 to /28, such as 10.40.0.0/24), " +
          `or remove that network (\`docker network rm ${name}\`) if nothing needs it, then run this again`,
      );
    }
  }

  async create(): Promise<void> {
    await this.refuseATakenSubnet();
    await this.task([
      "create",
      "--pds",
      "1",
      "--users-per-pds",
      "1",
      "--project",
      this.project,
      "--preset",
      "full-stack",
      "--subnet",
      this.subnet,
    ]);
  }

  /** Applies HappyView where it is new or its files changed, and answers whether that added or changed its route. */
  async sync(written: Written): Promise<boolean> {
    if (!this.applied()) {
      await this.task(["apply", "--app", APP_ID]);
      return true;
    }
    if (written.any) await this.task(["apply", "--component", APP_ID]);
    return written.definition;
  }

  /**
   * Restarts the running services that read routes only at start, once a route has been added
   * or changed; without it the PDS cannot reach HappyView and OAuth sign-in fails. Answers the
   * containers restarted.
   */
  async restartRouteReaders(): Promise<string[]> {
    const listed = await this.runner.capture(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project=${this.project}`,
        "--format",
        '{{.Names}} {{.Label "com.docker.compose.service"}}',
      ],
      this.checkout,
    );
    const names: string[] = [];
    for (const line of lines(listed)) {
      const [name, service] = words(line);
      if (name !== undefined && service !== undefined && readsRoutesAtStart(service))
        names.push(name);
    }
    if (names.length > 0) await this.runner.capture("docker", ["restart", ...names], this.checkout);
    return names;
  }

  async up(): Promise<void> {
    await this.task(["check"]);
    // The first start pulls every full-stack image; the CLI's 120 s default is too short for that.
    await this.task(["up", "--build", "--wait-timeout", "600"]);
  }

  seed(): Promise<void> {
    return this.task(["seed"]);
  }

  down(): Promise<void> {
    return this.task(["down"]);
  }

  destroy(): Promise<void> {
    return this.task(["destroy", "--accept-destructive"]);
  }

  /**
   * `access stop` only stops the relay, and `down` then leaves the stopped container behind
   * (its profile is not active) while removing the network it was attached to. `access start`
   * would restart that container and fail on the missing network, so a stopped relay of this
   * project is removed first and Compose creates a fresh one. A running relay is left alone.
   */
  async accessStart(): Promise<void> {
    const listed = await this.runner.capture(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${this.project}`,
        "--filter",
        "label=com.docker.compose.service=host-access",
        "--format",
        '{{.Names}} {{.Label "com.docker.compose.service"}} {{.State}}',
      ],
      this.checkout,
    );
    const stopped: string[] = [];
    for (const line of lines(listed)) {
      const [name, service, state] = words(line);
      if (name === undefined || service === undefined || state === undefined) continue;
      if (service === "host-access" && state !== "running") stopped.push(name);
    }
    if (stopped.length > 0) await this.runner.capture("docker", ["rm", ...stopped], this.checkout);
    await this.task(["access", "start"]);
  }

  accessStop(): Promise<void> {
    return this.task(["access", "stop"]);
  }

  /**
   * Read through `capture`, which cannot tell a signal from an exit code, so a lock it leaves
   * is never removed; a later sandbox command reports it instead.
   */
  hostsBlock(): Promise<string> {
    return this.runner.capture("deno", Sandbox.args(["access", "hosts"]), this.checkout);
  }
}
