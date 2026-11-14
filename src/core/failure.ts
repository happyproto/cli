// crates/hpy/src/failure.rs: an error with its exit code.
//   1 runtime or remote, 2 usage or validation, 3 not logged in.
import { AtprotoError, errorText } from "../atproto/error.ts";
import { Problem } from "../plugin/problem.ts";

export class Failure extends Error {
  readonly code: number;
  /** Already explained on the terminal by a child process, so main prints nothing more. */
  readonly quiet: boolean;

  constructor(code: number, message: string, quiet = false) {
    super(message);
    this.code = code;
    this.quiet = quiet;
  }

  static usage(msg: unknown): Failure {
    return new Failure(2, errorText(msg));
  }

  static runtime(msg: unknown): Failure {
    return new Failure(1, errorText(msg));
  }

  static notLoggedIn(): Failure {
    return new Failure(3, "not logged in; run `hpy registry login`");
  }

  static exit(code: number): Failure {
    return new Failure(code, `exited with ${code}`, true);
  }

  static problems(intro: string, problems: readonly Problem[]): Failure {
    const list = problems.map((p) => `  • ${p}`);
    return Failure.usage(`${intro}\n${list.join("\n")}`);
  }

  /** `From<hpy_atproto::Error>` and `From<Problem>`; anything else is a runtime failure. */
  static from(e: unknown): Failure {
    if (e instanceof Failure) return e;
    if (e instanceof AtprotoError) {
      const code = e.isAuth() ? 3 : e.isUsage() ? 2 : 1;
      return new Failure(code, e.message);
    }
    if (e instanceof Problem) return Failure.usage(e.toString());
    return Failure.runtime(e);
  }
}
