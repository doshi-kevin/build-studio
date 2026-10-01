/**
 * readAllPages — read every row of a query, a page at a time.
 *
 * PostgREST silently caps an unbounded select at 1000 rows. When the rows feed a
 * *count*, that only understates a signal. When they feed an aggregate computed
 * across the whole set — a class average, a point-biserial correlation — a
 * truncated read doesn't weaken the number, it makes it wrong, and nothing in
 * the response says so.
 *
 * Use this only where completeness is load-bearing. If "most recent N" is the
 * right answer, an explicit `.order().limit(N)` is cheaper and clearer.
 *
 * `orderColumn` must be a stable sort key — `.range()` paging over an unordered
 * query can repeat or skip rows between pages.
 */

import { logger } from '@/lib/logger'

const PAGE = 1000

/** Hard stop so a pathological table can't spin this forever. */
const MAX_PAGES = 50

export async function readAllPages<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
  orderColumn: string,
  source = 'readAllPages',
): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE
    const { data, error } = await build()
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      // Partial data beats none for these signals, but the gap must be visible.
      logger.error(`${source}: page read failed`, error, { from, orderColumn })
      break
    }
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
  logger.warn(`${source}: hit the page ceiling — result is truncated`, {
    orderColumn,
    rows: out.length,
    maxPages: MAX_PAGES,
  })
  return out
}
