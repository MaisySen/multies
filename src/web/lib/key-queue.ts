/**
 * Runs async work one at a time per key, in the order it was asked for: the next starts when the one before has
 * settled (a failure does not stop the next). Work under different keys runs side by side.
 *
 * Task edits use it per task: two quick edits (set Repeat, then Mark as done) went out as two requests at once, and
 * when the second reached the server first the task was done before it repeated, so no next one was made.
 */
const tails = new Map<string, Promise<unknown>>();

export function inOrder<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  const next = before.then(run, run);
  const tail = next.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return next;
}

/** For tests: how many keys have work queued or running. */
export const queuedKeys = () => tails.size;
