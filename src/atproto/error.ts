// hpy-atproto/src/error.rs: the errors the atproto layer reports, and which of
// them are the user's to fix (usage) or a missing sign-in (auth).

/** Registry refusals the publisher fixes by changing what they ran or wrote. */
const USAGE_ERRORS = [
  "InvalidProject",
  "InvalidRecord",
  "InvalidRequest",
  "VersionExists",
  "ProjectMissing",
  "NotInstallable",
  "VersionNotFound",
];

export type AtprotoErrorKind =
  | { kind: "NotLoggedIn" }
  | { kind: "SessionExpired" }
  /** Stored credentials that cannot be used; the message says why. */
  | { kind: "LoginRequired"; message: string }
  | { kind: "Xrpc"; method: string; name: string; message?: string | undefined }
  /** A refusal from the registry's own procedures, written for the publisher. */
  | { kind: "Registry"; name: string; message: string }
  | { kind: "Other"; message: string };

export class AtprotoError extends Error {
  readonly detail: AtprotoErrorKind;

  constructor(detail: AtprotoErrorKind) {
    super(render(detail));
    this.detail = detail;
  }

  static notLoggedIn(): AtprotoError {
    return new AtprotoError({ kind: "NotLoggedIn" });
  }
  static sessionExpired(): AtprotoError {
    return new AtprotoError({ kind: "SessionExpired" });
  }
  static loginRequired(message: string): AtprotoError {
    return new AtprotoError({ kind: "LoginRequired", message });
  }
  static xrpc(method: string, name: string, message?: string): AtprotoError {
    return new AtprotoError({ kind: "Xrpc", method, name, message });
  }
  static registry(name: string, message: string): AtprotoError {
    return new AtprotoError({ kind: "Registry", name, message });
  }
  static other(message: unknown): AtprotoError {
    return new AtprotoError({ kind: "Other", message: errorText(message) });
  }

  isAuth(): boolean {
    const k = this.detail.kind;
    return k === "NotLoggedIn" || k === "SessionExpired" || k === "LoginRequired";
  }

  /** Errors that are the publisher's to fix, not a failure of the tool. */
  isUsage(): boolean {
    return this.detail.kind === "Registry" && USAGE_ERRORS.includes(this.detail.name);
  }

  /** The registry's error name, for errors that came from it. */
  registryName(): string | undefined {
    return this.detail.kind === "Registry" ? this.detail.name : undefined;
  }
}

function render(d: AtprotoErrorKind): string {
  switch (d.kind) {
    case "NotLoggedIn":
      return "not logged in; run `hpy registry login`";
    case "SessionExpired":
      return "your session has expired or was revoked; run `hpy registry login`";
    case "LoginRequired":
    case "Other":
      return d.message;
    case "Xrpc":
      return `${d.method} failed: ${d.name}${d.message !== undefined ? ` — ${d.message}` : ""}`;
    case "Registry":
      return d.message;
  }
}

/** `e.to_string()` for whatever was thrown. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
