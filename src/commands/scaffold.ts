// commands/happyview/scaffold.rs, the part `check` and `pull` use: the warnings for a query or
// procedure with no handler beside it. The `scaffold` command itself is M4's to port here.

import { rustComponents } from "../core/paths.ts";
import { LexiconKind, scan } from "../project/handlers.ts";

/** A project-relative path, `/`-separated whatever the platform. */
function shown(path: string): string {
  return rustComponents(path).join("/");
}

/** The command that writes a handler for `nsid`, for messages that point at it. */
export function hint(nsid: string): string {
  return `run \`hpy hv scaffold ${nsid}\``;
}

/**
 * One line per query or procedure lexicon under `root/src` with no handler beside it, for
 * `check` to warn with. A project it cannot read has none: HappyView's own check reports what
 * is wrong with it.
 */
export function missingHandlerWarnings(root: string): string[] {
  let lexicons: ReturnType<typeof scan>;
  try {
    lexicons = scan(root);
  } catch {
    return [];
  }
  return lexicons
    .filter((l) => LexiconKind.isMethod(l.kind) && l.existingHandler(root) === undefined)
    .map((l) => {
      const answer =
        l.kind === "query"
          ? "HappyView answers it only for ?uri="
          : "HappyView refuses every call to it";
      return `warning: ${LexiconKind.label(l.kind)} ${l.nsid} has no handler beside ${shown(l.path)}, so ${answer}; ${hint(l.nsid)}`;
    });
}
