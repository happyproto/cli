import db from "happyview.db";
LEXICON_IMPORTimport type { QueryCtx } from "happyview:ctx";

/** What this reads from the query string, whatever else the lexicon declares. */
type Query = { uri?: string; did?: string; limit?: string | number; cursor?: string };

export default async function handle(input: INPUT_TYPE, ctx: QueryCtx) {
  if (input.uri) {
    const entry = await db.get(input.uri);
    if (!entry) {
      return { error: "NotFound", message: `no record at ${input.uri}` };
    }
    return { uri: entry.uri, cid: entry.cid, value: entry.record };
  }

  // Query params arrive as strings unless the lexicon types them, and a
  // chain step given undefined is skipped, so absent filters read as no filter.
  const limit = Number(input.limit);
  return db.records("COLLECTION")
    .did(input.did)
    .limit(Number.isFinite(limit) ? limit : undefined)
    .cursor(input.cursor)
    .run();
}
