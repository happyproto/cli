// commands/happyview/env.rs and hpy-atproto admin/script_variables.rs tests.
import { inspect } from "node:util";
import { afterEach, expect, it } from "vitest";
import { Admin } from "../../src/atproto/admin.ts";
import { KEY_RULE, parse } from "../../src/commands/env/dotenv.ts";
import { type Planned, question, redact, select, sendEach } from "../../src/commands/env.ts";
import { Failure } from "../../src/core/failure.ts";
import { header, MockServer, type Recorded } from "../support/mock-server.ts";

const KEY = "hv_0123456789abcdef0123456789abcdef";
const SECRET = "sk-live-unit-secret-91c2";

let servers: MockServer[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.verify();
    await s.stop();
  }
  servers = [];
});
const start = async () => {
  const s = await MockServer.start();
  servers.push(s);
  return s;
};
const postedKeys = (s: MockServer) =>
  s.requests.filter((r) => r.method === "POST").map((r) => (r.json() as { key: string }).key);
const fails = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected an error");
};

// --- env.rs

it("asks_about_each_key_and_sends_only_the_ones_accepted", async () => {
  const s = await start();
  s.given("POST", "/admin/script-variables", { status: 204 });
  const admin = Admin.withKey(s.url, KEY);
  const es = parse(`A=${SECRET}\nB=2\nC=3\n`);
  const plan: Planned[] = [
    { entry: es[0]!, existing: { kind: "new" } },
    { entry: es[1]!, existing: { kind: "replaces", unreadable: false } },
    { entry: es[2]!, existing: { kind: "replaces", unreadable: true } },
  ];
  const asked: string[] = [];
  const lines: string[] = [];
  const outcome = await sendEach(
    admin,
    plan,
    async (p) => {
      asked.push(question(p));
      return p.entry.key !== "B";
    },
    (l) => lines.push(l),
  );
  expect(asked).toEqual([
    "send A (new)?",
    "send B (replaces existing)?",
    "send C (replaces existing, whose value the instance can't read)?",
  ]);
  expect(lines).toEqual(["sent A", "skipped B", "sent C"]);
  expect(outcome.sent).toEqual(["A", "C"]);
  expect(outcome.skipped).toEqual(["B"]);
  expect(postedKeys(s)).toEqual(["A", "C"]);
});

it("a_cancelled_question_stops_the_run", async () => {
  const s = await start();
  s.given("POST", "*", { status: 204 });
  const admin = Admin.withKey(s.url, KEY);
  const plan: Planned[] = parse("A=1\nB=2\n").map((entry) => ({
    entry,
    existing: { kind: "new" },
  }));
  const err = await fails(
    sendEach(
      admin,
      plan,
      async () => {
        throw Failure.runtime("cancelled");
      },
      () => {},
    ),
  );
  expect(err.message).toBe("cancelled");
  expect(postedKeys(s)).toEqual([]);
});

it("a_failure_that_quotes_the_value_has_it_taken_out", async () => {
  const s = await start();
  s.given("POST", "*", {
    status: 400,
    json: { error: "BadRequest", message: `cannot store ${SECRET}` },
  });
  const admin = Admin.withKey(s.url, KEY);
  const plan: Planned[] = [{ entry: parse(`A=${SECRET}\n`)[0]!, existing: { kind: "new" } }];
  const lines: string[] = [];
  const outcome = await sendEach(
    admin,
    plan,
    async () => true,
    (l) => lines.push(l),
  );
  const shown = `${inspect(lines)} ${inspect(outcome)}`;
  expect(shown).toContain("failed A: ");
  expect(shown).toContain("[value hidden]");
  expect(shown).not.toContain(SECRET);
});

it("named_keys_must_be_in_the_file", () => {
  const es = parse("A=1\nB=2\nC=3\n");
  expect(select(es, [], ".env")).toEqual([0, 1, 2]);
  expect(select(es, ["C", "A", "C"], ".env")).toEqual([2, 0]);
  let err = (() => {
    try {
      select(es, ["A", "X", "Y"], ".env");
    } catch (e) {
      return e as Failure;
    }
    throw new Error("expected a refusal");
  })();
  expect(err.code).toBe(2);
  expect(err.message).toBe(".env doesn't set X, Y, so nothing was sent");
  err = (() => {
    try {
      select(es, ["MY-KEY"], ".env");
    } catch (e) {
      return e as Failure;
    }
    throw new Error("expected a refusal");
  })();
  expect(err.message).toContain(KEY_RULE);
});

it("a_short_value_is_not_taken_out_of_a_message", () => {
  expect(redact("HTTP 500", "5")).toBe("HTTP 500");
  expect(redact("got abcd!", "abcd")).toBe("got [value hidden]!");
});

// --- admin/script_variables.rs

const VAR_SECRET = "sk-live-do-not-print-7f3a9c";

it("lists_variables_without_their_values", async () => {
  const s = await start();
  s.given(
    "GET",
    "/admin/script-variables",
    {
      json: [
        {
          key: "API_TOKEN",
          preview: "****",
          unreadable: false,
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-01T00:00:00Z",
        },
        {
          key: "OLD",
          preview: "****",
          unreadable: true,
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
        },
      ],
    },
    header("authorization", `Bearer ${KEY}`),
  );
  const vars = await Admin.withKey(s.url, KEY).scriptVariables();
  expect(vars.length).toBe(2);
  expect(vars[0]?.key).toBe("API_TOKEN");
  expect(vars[0]?.unreadable).toBe(false);
  expect(vars[1]?.unreadable).toBe(true);
});

it("sets_a_variable_with_its_key_and_value", async () => {
  const s = await start();
  s.given(
    "POST",
    "/admin/script-variables",
    { status: 204 },
    (r: Recorded) =>
      JSON.stringify(r.json()) === JSON.stringify({ key: "API_TOKEN", value: VAR_SECRET }),
  ).expect(1);
  await Admin.withKey(s.url, KEY).setScriptVariable("API_TOKEN", VAR_SECRET);
});

it("a_refused_set_names_the_key_but_never_the_value", async () => {
  const s = await start();
  s.given("POST", "*", {
    status: 500,
    json: { error: "InternalError", message: "failed to upsert script variable" },
  });
  const err = await fails(Admin.withKey(s.url, KEY).setScriptVariable("API_TOKEN", VAR_SECRET));
  const text = `${err.message} ${inspect(err)}`;
  expect(text).toContain("API_TOKEN");
  expect(text).toContain("failed to upsert");
  expect(text).not.toContain(VAR_SECRET);
});
