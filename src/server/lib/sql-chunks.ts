/**
 * D1 refuses a statement with more than 100 bound variables ("too many SQL variables"). Every IN list built from a
 * page of rows (tasks, messages, comments, files, ids from a request) goes through `inChunks`, which leaves room for
 * the other conditions in the same statement. Round 25, Sentry MYMAIL-API-V and MYMAIL-API-W.
 */
export const SQL_IN_CHUNK = 90;

/** Splits `ids` into lists of at most SQL_IN_CHUNK. */
export function chunkIds<T>(ids: readonly T[], size = SQL_IN_CHUNK): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
  return parts;
}

/** Runs `q` once per chunk of `ids` (in parallel) and joins the rows. No ids, no query. */
export async function inChunks<T, I = string>(ids: readonly I[], q: (chunk: I[]) => Promise<T[]>): Promise<T[]> {
  if (!ids.length) return [];
  return (await Promise.all(chunkIds(ids).map(q))).flat();
}
