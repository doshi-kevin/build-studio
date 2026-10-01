// answer-key.ts — loadAnswerKeyText caching. document-parser + storage are mocked;
// the admin client is a hand-built double. Pins the E10 negative-cache TTL: a failed
// download/parse caches null for NEG_CACHE_TTL_MS so a transient Storage blip doesn't
// disable the key for the process lifetime, and after the TTL the next call retries.
// Also pins the "no key PDF" (null source_path) short-circuit and the positive memo.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const parseDocumentMock = vi.fn()
const getTextForLLMMock = vi.fn()

vi.mock('@/lib/document-parser', () => ({
  parseDocument: (...a: unknown[]) => parseDocumentMock(...a),
  getTextForLLM: (...a: unknown[]) => getTextForLLMMock(...a),
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { loadAnswerKeyText, storeAnswerKeyText } from '@/lib/assignments/ai-grading/answer-key'

/**
 * Build a fake admin client.
 *  - `row` is what the assignment_answer_keys select returns.
 *  - `download` drives the Storage back-fill: 'ok' | 'fail'.
 *  - upsert (used by storeAnswerKeyText on back-fill) is a no-op success.
 */
function fakeAdmin(opts: {
  row: { source_path: string | null; source_name?: string | null; text?: string | null }
  download?: 'ok' | 'fail'
  downloadCounter?: { n: number }
}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: opts.row, error: null })
  // .eq() is self-chaining so the query can filter by assignment_id AND institution_id.
  const eqChain: { eq: () => typeof eqChain; maybeSingle: typeof maybeSingle } = {
    eq: vi.fn(() => eqChain),
    maybeSingle,
  }
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => eqChain),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    })),
    storage: {
      from: vi.fn(() => ({
        download: vi.fn(async () => {
          if (opts.downloadCounter) opts.downloadCounter.n++
          if (opts.download === 'ok') {
            return { data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null }
          }
          return { data: null, error: { message: 'not found' } }
        }),
      })),
    },
  } as never
}

const assignment = (id: string) => ({ id, institutionId: 'inst-1', sectionId: 'sec-1' })

beforeEach(() => {
  parseDocumentMock.mockReset()
  getTextForLLMMock.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('loadAnswerKeyText', () => {
  it('returns null immediately when no key PDF is attached (null source_path)', async () => {
    const admin = fakeAdmin({ row: { source_path: null } })
    expect(await loadAnswerKeyText(admin, assignment('no-key'))).toBeNull()
  })

  it('returns the cached text straight from the row when present', async () => {
    const admin = fakeAdmin({ row: { source_path: 'p/key.pdf', text: 'CACHED KEY TEXT' } })
    expect(await loadAnswerKeyText(admin, assignment('has-text'))).toBe('CACHED KEY TEXT')
  })

  it('E10: caches the failure with a TTL then retries after it expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    parseDocumentMock.mockResolvedValue({ pages: [], metadata: {} })
    getTextForLLMMock.mockReturnValue('backfilled')

    const counter = { n: 0 }
    // First: download FAILS → negative cache with TTL.
    const failing = fakeAdmin({
      row: { source_path: 'p/ttl.pdf', text: null },
      download: 'fail',
      downloadCounter: counter,
    })
    expect(await loadAnswerKeyText(failing, assignment('ttl-key'))).toBeNull()
    expect(counter.n).toBe(1)

    // Within the TTL window: served from the negative cache, no second download.
    expect(await loadAnswerKeyText(failing, assignment('ttl-key'))).toBeNull()
    expect(counter.n).toBe(1)

    // Advance past NEG_CACHE_TTL_MS (60s) → the next call retries the download.
    vi.setSystemTime(61_000)
    const okCounter = { n: 0 }
    const recovering = fakeAdmin({
      row: { source_path: 'p/ttl.pdf', text: null },
      download: 'ok',
      downloadCounter: okCounter,
    })
    expect(await loadAnswerKeyText(recovering, assignment('ttl-key'))).toBe('backfilled')
    expect(okCounter.n).toBe(1) // it did retry the download after the TTL
  })

  it('back-fills once from storage then memoizes the parsed text (no second download)', async () => {
    parseDocumentMock.mockResolvedValue({ pages: [], metadata: {} })
    getTextForLLMMock.mockReturnValue('parsed-once')
    const counter = { n: 0 }
    const admin = fakeAdmin({
      row: { source_path: 'p/once.pdf', text: null },
      download: 'ok',
      downloadCounter: counter,
    })
    expect(await loadAnswerKeyText(admin, assignment('backfill-key'))).toBe('parsed-once')
    expect(await loadAnswerKeyText(admin, assignment('backfill-key'))).toBe('parsed-once')
    expect(counter.n).toBe(1) // positive memo means only one download total
  })
})

/**
 * #627 — storeAnswerKeyText returned void and only logged its failure, so a caller could
 * not tell a stored answer key from a lost one. The professor got a clean success while the
 * staff-only row the AI grader reads had never been written, and grading then ran with no
 * reference answers at all. That degrades quietly, which is much harder to notice than an
 * outright error.
 *
 * The log line's own promise — "grading will parse on demand" — is only true if the ROW
 * exists to be re-read. When the upsert itself fails there is nothing to back-fill from.
 */
describe('storeAnswerKeyText failure reporting (#627)', () => {
  /** Minimal double: just enough to drive the upsert's outcome. */
  const adminWithUpsert = (error: { message: string } | null) =>
    ({ from: () => ({ upsert: vi.fn().mockResolvedValue({ error }) }) }) as never

  const row = {
    assignmentId: 'a-1',
    institutionId: 'i-1',
    sectionId: 's-1',
    sourcePath: 'p/key.pdf',
    sourceName: 'key.pdf',
    text: 'the key',
  }

  it('reports the failure to the caller instead of only logging it', async () => {
    const res = await storeAnswerKeyText(adminWithUpsert({ message: 'permission denied' }), row)

    /* The caller needs a value it can branch on. A void return is what made the silent
       success possible. */
    expect(res.error).toBe('permission denied')
  })

  it('reports no error on a successful write', async () => {
    const res = await storeAnswerKeyText(adminWithUpsert(null), row)

    expect(res.error).toBeNull()
  })
})
