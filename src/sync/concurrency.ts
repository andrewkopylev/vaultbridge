/**
 * Run `worker(item, index)` for every entry of `items`, with at most `limit`
 * workers in flight at once. Fail-fast: on the first error, in-flight workers
 * complete their current item, no new items are started, and the first error
 * is re-thrown. Subsequent errors from already-running workers are dropped.
 *
 * Order of completion is not preserved; only the bound on concurrency is.
 */
export async function runWithLimit<T>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const cap = Math.max(1, Math.min(limit | 0, items.length));

  // Holder object so TypeScript tracks mutations across the closure / await boundary.
  const state: { cursor: number; error: { err: unknown } | null } = {
    cursor: 0,
    error: null,
  };

  const runner = async (): Promise<void> => {
    while (state.error === null) {
      const idx = state.cursor++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx], idx);
      } catch (err) {
        if (state.error === null) state.error = { err };
        return;
      }
    }
  };

  const pool: Promise<void>[] = [];
  for (let i = 0; i < cap; i++) pool.push(runner());
  await Promise.all(pool);

  if (state.error !== null) throw state.error.err;
}
