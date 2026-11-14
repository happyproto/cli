// Answers com.example.hello. Save this file and the next request runs it.
// The types are ones `hpy happyview dev` writes into .happyview/types.

/**
 * @param {import("happyview:lexicons/com.example.hello").Params} input
 * @param {import("happyview:ctx").QueryCtx} ctx
 * @returns {import("happyview:lexicons/com.example.hello").Output}
 */
export default function handle(input, ctx) {
  return { message: `Hello, ${input.name ?? "world"}!` };
}
