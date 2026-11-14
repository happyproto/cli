import record from "happyview.record";

/**
 * @param {INPUT_TYPE} input
 * @param {import("happyview:ctx").ProcedureCtx} ctx
 */
export default async function handle(input, ctx) {
  const ref = await record.create("COLLECTION", input);
  return { uri: ref.uri, cid: ref.cid };
}
