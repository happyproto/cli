// Answers com.example.hello. Save this file and the next request runs it.
// The types are ones `hpy happyview dev` writes into .happyview/types.
import type { Params, Output } from "happyview:lexicons/com.example.hello";
import type { QueryCtx } from "happyview:ctx";

export default function handle(input: Params, ctx: QueryCtx): Output {
  return { message: `Hello, ${input.name ?? "world"}!` };
}
