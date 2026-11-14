// crates/hpy/src/project/network/runner.rs `FakeRunner` (#[cfg(test)]): records every call as a
// shell line would read, `env` first, and answers the first answer whose prefix the line
// starts with, or success with no output.
import { Failure } from "../../src/core/failure.ts";
import { type Env, Exit, type Runner } from "../../src/project/network/runner.ts";

export type Answer = { ok: string } | { err: string };

export class FakeRunner implements Runner {
  readonly calls: string[] = [];
  readonly answers: [string, Answer][];

  constructor(answers: [string, Answer][] = []) {
    this.answers = answers;
  }

  static answering(answers: [string, Answer][]): FakeRunner {
    return new FakeRunner(answers);
  }

  private answer(program: string, args: readonly string[], env: Env = []): Answer {
    const line = [...env.map(([k, v]) => `${k}=${v}`), program, ...args].join(" ");
    this.calls.push(line);
    return this.answers.find(([prefix]) => line.startsWith(prefix))?.[1] ?? { ok: "" };
  }

  async show(program: string, args: readonly string[]): Promise<Exit> {
    return this.showWithEnv(program, args, []);
  }

  async showWithEnv(program: string, args: readonly string[], env: Env): Promise<Exit> {
    return Exit.code("ok" in this.answer(program, args, env) ? 0 : 1);
  }

  async showOnStderr(program: string, args: readonly string[]): Promise<Exit> {
    return this.show(program, args);
  }

  async capture(program: string, args: readonly string[]): Promise<string> {
    const a = this.answer(program, args);
    if ("err" in a) throw Failure.runtime(a.err);
    return a.ok;
  }
}
