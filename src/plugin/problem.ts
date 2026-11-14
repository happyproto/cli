// hpy-plugin/src/problem.rs: one thing wrong with a plugin's inputs, located by
// a field path such as `release.requires["env:happyview"]`. Validation collects
// these rather than stopping at the first, so an author fixes everything at once.
export class Problem extends Error {
  readonly path: string;
  readonly problem: string;

  constructor(path: string, message: string) {
    // A problem with no path is a whole sentence already.
    super(path === "" ? message : `${path}: ${message}`);
    this.path = path;
    this.problem = message;
  }

  override toString(): string {
    return this.message;
  }

  equals(other: Problem): boolean {
    return this.path === other.path && this.problem === other.problem;
  }
}
