import record from "happyview.record";
LEXICON_IMPORTimport type { ProcedureCtx } from "happyview:ctx";

export default async function handle(input: INPUT_TYPE, ctx: ProcedureCtx) {
  const ref = await record.create("COLLECTION", input);
  return { uri: ref.uri, cid: ref.cid };
}
