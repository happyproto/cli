// cli.rs's `conflicts_with` and `requires`, which commander does not express
// the way clap does. clap.ts's validator applies them with clap's wording and
// usage lines (exit 2). Each name is an option's attribute (`dryRun`,
// `browser` for `--no-browser`) or a positional's clap name (`PLUGIN`).

export type Rule = { conflicts: [string, string] } | { requires: [string, string] };

export const RULES: Record<string, Rule[]> = {
  "plugin.lifecycle": [
    { conflicts: ["withdraw", "project"] },
    { conflicts: ["withdraw", "supersededBy"] },
    { conflicts: ["withdraw", "kind"] },
  ],
  "hv.pull": [{ conflicts: ["diff", "dryRun"] }, { requires: ["apiKeyEnv", "legacy"] }],
  "hv.add": [
    { conflicts: ["interpreter", "library"] },
    { conflicts: ["channel", "version"] },
    { requires: ["channel", "PLUGIN"] },
    { requires: ["version", "PLUGIN"] },
    { requires: ["project", "PLUGIN"] },
  ],
  "hv.login": [{ conflicts: ["keyStdin", "IDENTIFIER"] }, { conflicts: ["keyStdin", "browser"] }],
};

/** The routes that have rules, for the command-tree test. */
export const CHECKED_ROUTES = Object.keys(RULES);
