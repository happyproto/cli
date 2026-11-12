// crates/hpy/src/prompt.rs: a flag's value, else a prompt (only with a
// terminal), else the default, else an error naming the flag. Nothing here ever
// blocks without a TTY. Prompts draw on stderr, so stdout stays the result's.
import * as p from "@clack/prompts";
import { Failure } from "./failure.ts";

type Check = (s: string) => string | null;
const io = { output: process.stderr, withGuide: false } as const;

function unwrap<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) throw Failure.runtime("cancelled");
  return v as Exclude<T, symbol>;
}

export class Prompter {
  readonly interactive: boolean;
  /** Why there is no prompting, for the error that names a missing flag. */
  readonly whyNot: string;

  constructor(noInput: boolean, terminal = !!process.stdin.isTTY && !!process.stderr.isTTY) {
    this.interactive = !noInput && terminal;
    this.whyNot = noInput ? "--no-input was given" : "no terminal to prompt on";
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  async required(
    flag: string,
    label: string,
    given: string | undefined,
    def: string | undefined,
    check: Check,
  ): Promise<string> {
    return this.requiredWithHelp(flag, label, given, def, undefined, check);
  }

  /** `required`, with a line under the prompt saying what the default is. */
  async requiredWithHelp(
    flag: string,
    label: string,
    given: string | undefined,
    def: string | undefined,
    help: string | undefined,
    check: Check,
  ): Promise<string> {
    if (given !== undefined) {
      const e = check(given);
      if (e !== null) throw Failure.usage(`${flag}: ${e}`);
      return given;
    }
    if (this.interactive) {
      const v = unwrap(
        await p.text({
          ...io,
          message: help ? `${label} (${help})` : label,
          ...(def !== undefined ? { defaultValue: def, placeholder: def } : {}),
          validate: (s) => {
            const value = s === "" && def !== undefined ? def : (s ?? "");
            return check(value) ?? undefined;
          },
        }),
      );
      return v === "" && def !== undefined ? def : v;
    }
    if (def !== undefined) {
      const e = check(def);
      if (e !== null) throw Failure.usage(`${flag} (defaulted to \`${def}\`): ${e}`);
      return def;
    }
    throw Failure.usage(`missing ${flag} (${this.whyNot})`);
  }

  async optional(
    label: string,
    given: string | undefined,
    def: string | undefined,
  ): Promise<string | undefined> {
    if (given !== undefined) return given;
    if (this.interactive) {
      const v = unwrap(
        await p.text({
          ...io,
          message: `${label} (optional; leave blank to skip)`,
          ...(def !== undefined ? { defaultValue: def, placeholder: def } : {}),
        }),
      );
      return v.trim() === "" ? undefined : v;
    }
    return def;
  }

  /** Flags if any were given, else one prompt per line (blank to finish), else the defaults. */
  async list<T>(
    flag: string,
    label: string,
    given: string[],
    def: T[],
    parse: (s: string) => T | { error: string },
    min: number,
  ): Promise<T[]> {
    const isErr = (v: unknown): v is { error: string } =>
      !!v &&
      typeof v === "object" &&
      "error" in (v as object) &&
      Object.keys(v as object).length === 1;
    let items: T[];
    if (given.length > 0) {
      items = given.map((s) => {
        const v = parse(s);
        if (isErr(v)) throw Failure.usage(`${flag}: ${v.error}`);
        return v;
      });
    } else if (this.interactive && def.length === 0) {
      items = [];
      for (;;) {
        const help = items.length < min ? "required" : "leave blank to finish";
        const s = unwrap(await p.text({ ...io, message: `${label} (${help})` }));
        if (s.trim() === "") {
          if (items.length >= min) break;
          continue;
        }
        const v = parse(s);
        if (isErr(v)) process.stderr.write(`  ${v.error}\n`);
        else items.push(v);
      }
    } else {
      items = def;
    }
    if (items.length < min) throw Failure.usage(`missing ${flag} (${this.whyNot})`);
    return items;
  }

  /** Flags (checked against `options` when there are any), else a checklist, else `preselected`. */
  async multi(
    flag: string,
    label: string,
    given: string[],
    options: string[],
    preselected: string[],
  ): Promise<string[]> {
    if (given.length > 0) {
      if (options.length > 0) {
        const bad = given.find((g) => !options.includes(g));
        if (bad !== undefined)
          throw Failure.usage(`${flag}: \`${bad}\` is not one of ${options.join(", ")}`);
      }
      return given;
    }
    if (this.interactive && options.length > 0) {
      return unwrap(
        await p.multiselect({
          ...io,
          message: label,
          options: options.map((o) => ({ value: o, label: o })),
          initialValues: options.filter((o) => preselected.includes(o)),
          required: false,
        }),
      );
    }
    return [...preselected];
  }

  /** One of `options`, by index: a prompt with a terminal, otherwise an error naming the flag. */
  async choose(flag: string, label: string, options: string[]): Promise<number> {
    if (this.interactive) {
      return unwrap(
        await p.select({
          ...io,
          message: label,
          options: options.map((o, i) => ({ value: i, label: o })),
        }),
      );
    }
    const list = options.map((o) => `  • ${o}`);
    throw Failure.usage(`${label} pass ${flag} to choose (${this.whyNot}):\n${list.join("\n")}`);
  }

  /** A yes-or-no offer, yes by default; `null` without a terminal, so the caller can say how instead. */
  async offer(label: string): Promise<boolean | null> {
    if (!this.interactive) return null;
    return unwrap(await p.confirm({ ...io, message: label, initialValue: true }));
  }

  async confirm(label: string, yes: boolean): Promise<boolean> {
    if (yes) return true;
    if (this.interactive)
      return unwrap(await p.confirm({ ...io, message: label, initialValue: false }));
    throw Failure.usage("pass --yes to confirm without a terminal");
  }
}
