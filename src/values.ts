// clap's `value_parser`s: a value checked as it is parsed, so a mistake is
// refused before the command runs. A refusal prints clap's
// `error: invalid value '<v>' for '<arg>': <why>`, with no usage line, exit 2.

/** A value refused by its parser; main prints it as clap does. */
export class ValueError extends Error {
  readonly value: string;
  readonly arg: string;
  readonly reason: string;
  constructor(value: string, arg: string, reason: string) {
    super(`invalid value '${value}' for '${arg}': ${reason}`);
    this.value = value;
    this.arg = arg;
    this.reason = reason;
  }
}

/** A commander `argParser` for the argument clap shows as `arg`, from a parser that throws its reason as a string. */
export function valueParser<T>(arg: string, parse: (value: string) => T): (value: string) => T {
  return (value) => {
    try {
      return parse(value);
    } catch (e) {
      throw new ValueError(value, arg, typeof e === "string" ? e : (e as Error).message);
    }
  };
}

const EXAMPLE = "an IPv4 network such as 10.40.0.0/24";

/** `std::net::Ipv4Addr`'s `FromStr`, as a number. */
export function ipv4(s: string): number | undefined {
  // std::net::Ipv4Addr's parser: exactly four decimal octets, no leading zeros.
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) return undefined;
    n = n * 256 + Number(p);
  }
  return n;
}

const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/**
 * cli.rs `parse_subnet`: `dev --subnet`'s value, held to what Atmosphere in a
 * Box accepts (a private IPv4 network from /16 to /28, aligned to its prefix).
 */
export function parseSubnet(value: string): string {
  const slash = value.indexOf("/");
  if (slash === -1) throw `expected ${EXAMPLE}`;
  const addr = ipv4(value.slice(0, slash));
  if (addr === undefined) throw `expected ${EXAMPLE}`;
  const p = value.slice(slash + 1);
  // Rust's u32 parser takes an optional leading `+`.
  const prefix = /^\+?[0-9]+$/.test(p) ? Number(p.replace(/^\+/, "")) : Number.NaN;
  if (!(prefix >= 16 && prefix <= 28)) throw "the prefix must be from /16 to /28";
  const a = addr >>> 24;
  const b = (addr >>> 16) & 255;
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)))
    throw "it must be a private network, inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16";
  const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
  const start = (addr & mask) >>> 0;
  if (start !== addr)
    throw `${dotted(addr)} is not where a /${prefix} starts; did you mean ${dotted(start)}/${prefix}?`;
  return `${dotted(addr)}/${prefix}`;
}

export type Channel = "stable" | "beta" | "alpha";

/** channel.rs `Channel::from_str`. `main` is the branch stable releases are cut from. */
export function parseChannel(s: string): Channel {
  if (s === "stable" || s === "main") return "stable";
  if (s === "beta" || s === "alpha") return s;
  throw `\`${s}\` is not a channel; choose stable, beta or alpha`;
}
