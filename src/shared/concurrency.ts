/**
 * Maps over items with a bounded number of in-flight operations.
 *
 * Public XRPL nodes throttle aggressive callers, and a naive Promise.all over
 * every pool issues two requests per pool at once — enough to be refused with
 * "You are placing too much load on the server". Results keep input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error(`concurrency limit must be at least 1, got ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
