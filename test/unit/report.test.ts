// miette 7.6 / textwrap 0.16.4 wrapping, checked against the Rust alpha.31 binary: each golden is
// what it printed for `hpy registry plugin show --name <text>` (main adds the final newline).
import { expect, it } from "vitest";
import { renderReport } from "../../src/core/report.ts";

const GOLDENS: [string, string][] = [
  [
    "`see (https://ada.dev/x) and at://did:plc:abc/software.release.project/my-plugin and http://127.0.0.1:8080/a` is not a project name: 1 to 64 lowercase letters, digits and interior `-`",
    "  × `see (https://ada.dev/x) and at://did:plc:abc/software.release.project/my-\n  │ plugin and http://127.0.0.1:8080/a` is not a project name: 1 to 64\n  │ lowercase letters, digits and interior `-`\n",
  ],
  [
    "`  indented   spaces | a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-aa-bb-cc-dd-ee-ff` is not a project name: 1 to 64 lowercase letters, digits and interior `-`",
    "  × `  indented   spaces | a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-\n  │ z-aa-bb-cc-dd-ee-ff` is not a project name: 1 to 64 lowercase letters,\n  │ digits and interior `-`\n",
  ],
  [
    '`$(x) [y]% {z}+ 1.0.0-beta.1/2 "quoted text" longwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww` is not a project name: 1 to 64 lowercase letters, digits and interior `-`',
    '  × `$(x) [y]% {z}+ 1.0.0-beta.1/2 "quoted text"\n  │ longwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww\n  │ wwwwwwwwwwwwwwwwwwww` is not a project name: 1 to 64 lowercase letters,\n  │ digits and interior `-`\n',
  ],
];

it("reports_wrap_as_miette_does", () => {
  for (const [message, want] of GOLDENS) expect(renderReport(message, 78)).toBe(want);
});
