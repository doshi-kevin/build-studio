// The DM notification's destination (#693).
//
// A DM is global; the pane that shows it is section-scoped. So the notification links
// to /dms?c=<channel>, which resolves a real destination at CLICK time. What is worth
// pinning here is the resolver's JUDGEMENT, because each branch was a decision:
//
//   1. It must SKIP a shared section whose professor switched discussions off. The
//      student discussions page opens with verifyFeatureEnabled(), which calls
//      notFound() — so linking there would replace "clicking does nothing", the bug in
//      the issue, with "clicking shows an error page".
//   2. It must not leak. A channel the caller isn't part of has to be indistinguishable
//      from one that doesn't exist, or the route becomes an oracle for whether any given
//      channel id is real. Same reason openOrCreateDm returns one refusal for both.
//   3. It must give up gracefully rather than guess, when no shared section qualifies.
//
// A filter-aware fake is needed rather than the table-keyed one in actions-dms.test.ts:
// this resolver queries `enrollments` for BOTH users and `course_sections` twice, so a
// mock keyed only on the table name cannot tell those calls apart and would answer the
// wrong one.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockRedirect = vi.fn((url: string) => {
  // Next's redirect() throws to unwind; mirror that so code after it never runs.
  throw new Error(`NEXT_REDIRECT:${url}`)
})

vi.mock('next/navigation', () => ({ redirect: (url: string) => mockRedirect(url) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockAdminClient(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const ME = 'aaaa0000-0000-0000-0000-000000000001'
const THEM = 'bbbb0000-0000-0000-0000-000000000002'
const CHANNEL = 'cccc0000-0000-0000-0000-000000000003'

/** One query's recorded filters, so a fake can answer per-call rather than per-table. */
interface Filters {
  [column: string]: unknown
}

type Answer = (filters: Filters) => { data: unknown; error: unknown }

/**
 * A Supabase-ish chain that records every .eq()/.in() and consults `answer` only when
 * awaited, by which point all filters are known.
 */
function chainFor(answer: Answer) {
  const filters: Filters = {}
  const result = () => answer(filters)
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  chain.select = passthrough
  chain.order = passthrough
  chain.limit = passthrough
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val
    return chain
  }
  chain.in = (col: string, val: unknown) => {
    filters[col] = val
    return chain
  }
  chain.maybeSingle = async () => result()
  chain.single = async () => result()
  chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result()).then(onFulfilled)
  return chain
}

interface World {
  /** Sections the viewer teaches. */
  teaching?: string[]
  /** Sections the viewer is enrolled in. */
  enrolled?: string[]
  /** Sections the counterparty can reach, by any route. */
  theirs?: string[]
  /** section id → enabledFeatures. Absent means the array is empty. */
  features?: Record<string, string[]>
  /** Participants of CHANNEL. Absent means the channel does not exist. */
  participants?: string[] | null
}

function fakeDb(w: World) {
  return {
    from: (table: string) =>
      chainFor((f) => {
        if (table === 'dm_channels') {
          if (!w.participants) return { data: null, error: null }
          return { data: { user_a_id: w.participants[0], user_b_id: w.participants[1] }, error: null }
        }
        if (table === 'course_sections') {
          // Two distinct calls: "who teaches this" vs "settings for these ids".
          if (f.professor_id === ME) {
            return { data: (w.teaching ?? []).map((id) => ({ id, settings: {} })), error: null }
          }
          if (f.professor_id === THEM) {
            return { data: [], error: null }
          }
          const ids = (f.id as string[]) ?? []
          return {
            data: ids.map((id) => ({ id, settings: { enabledFeatures: w.features?.[id] ?? [] } })),
            error: null,
          }
        }
        if (table === 'enrollments') {
          const who = f.student_id === ME ? (w.enrolled ?? []) : f.student_id === THEM ? (w.theirs ?? []) : []
          return { data: who.map((section_id) => ({ section_id })), error: null }
        }
        if (table === 'section_staff') {
          return { data: [], error: null }
        }
        return { data: [], error: null }
      }),
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let DmResolverPage: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockRedirect.mockClear()
  const mod = await import('@/app/(dashboard)/dms/page')
  DmResolverPage = mod.default
  mockGetUser.mockResolvedValue({ data: { user: { id: ME } }, error: null })
})

/** Run the page, returning either the redirect target or the rendered element. */
async function open(world: World) {
  mockAdminClient.mockReturnValue(fakeDb(world))
  try {
    const el = await DmResolverPage({ searchParams: Promise.resolve({ c: CHANNEL }) })
    return { redirectedTo: null as string | null, element: el }
  } catch (e) {
    const m = /^NEXT_REDIRECT:(.*)$/.exec((e as Error).message)
    if (!m) throw e
    return { redirectedTo: m[1], element: null }
  }
}

describe('DM resolver destination (#693)', () => {
  it('sends a student to the shared course, deep-linked to the sender', async () => {
    const { redirectedTo } = await open({
      enrolled: ['sec-1'],
      theirs: ['sec-1'],
      features: { 'sec-1': ['discussions'] },
      participants: [ME, THEM],
    })
    expect(redirectedTo).toBe(`/student/courses/sec-1/discussions?dm=${THEM}`)
  })

  it('skips a shared course with discussions switched off and uses one that has it on', async () => {
    /* The whole reason this resolves late. sec-off would 404 on verifyFeatureEnabled,
       so the notification would be worse than the bug it fixes. */
    const { redirectedTo } = await open({
      enrolled: ['sec-off', 'sec-on'],
      theirs: ['sec-off', 'sec-on'],
      features: { 'sec-off': ['modules'], 'sec-on': ['discussions'] },
      participants: [ME, THEM],
    })
    expect(redirectedTo).toBe(`/student/courses/sec-on/discussions?dm=${THEM}`)
  })

  it('prefers a course the viewer teaches, which has no student feature gate to fail', async () => {
    const { redirectedTo } = await open({
      teaching: ['sec-taught'],
      enrolled: ['sec-enrolled'],
      theirs: ['sec-taught', 'sec-enrolled'],
      features: { 'sec-enrolled': ['discussions'] },
      participants: [ME, THEM],
    })
    expect(redirectedTo).toBe(`/professor/courses/sec-taught/discussions?dm=${THEM}`)
  })

  it('gives up rather than guessing when every shared course has discussions off', async () => {
    const { redirectedTo, element } = await open({
      enrolled: ['sec-off'],
      theirs: ['sec-off'],
      features: { 'sec-off': [] },
      participants: [ME, THEM],
    })
    expect(redirectedTo).toBeNull()
    // Specific copy is safe here: the caller owns this channel.
    expect(element.props.title).toBe('This conversation has no home right now')
  })

  it('gives up when the two share no course at all', async () => {
    const { redirectedTo, element } = await open({
      enrolled: ['sec-mine'],
      theirs: ['sec-theirs'],
      features: { 'sec-mine': ['discussions'] },
      participants: [ME, THEM],
    })
    expect(redirectedTo).toBeNull()
    expect(element.props.title).toBe('This conversation has no home right now')
  })

  describe('does not become an oracle for whether a channel id is real', () => {
    /* These two MUST be identical. If a non-participant got different copy from a
       nonexistent channel, the route would confirm any channel id's existence. */
    it('a channel the caller is not part of looks exactly like a missing one', async () => {
      const outsider = await open({ participants: ['dddd-1', 'eeee-2'] })
      const nonexistent = await open({ participants: null })

      expect(outsider.redirectedTo).toBeNull()
      expect(nonexistent.redirectedTo).toBeNull()
      // Default `missing` copy: no title/description override, so nothing is disclosed.
      expect(outsider.element.props.title).toBeUndefined()
      expect(outsider.element.props.description).toBeUndefined()
      expect(outsider.element.props).toEqual(nonexistent.element.props)
    })

    it('does not even look up the destination for a channel that is not the caller’s', async () => {
      // A leak can also be a timing one: resolving first would make the outsider case
      // measurably slower than the missing case.
      const db = fakeDb({ participants: ['dddd-1', 'eeee-2'], enrolled: ['sec-1'], theirs: ['sec-1'] })
      const spy = vi.spyOn(db, 'from')
      mockAdminClient.mockReturnValue(db)
      await DmResolverPage({ searchParams: Promise.resolve({ c: CHANNEL }) })
      expect(spy.mock.calls.map((c) => c[0])).toEqual(['dm_channels'])
    })
  })

  it('renders a way out when the channel id is missing from the URL', async () => {
    mockAdminClient.mockReturnValue(fakeDb({}))
    const el = await DmResolverPage({ searchParams: Promise.resolve({}) })
    expect(el.props.action.href).toBe('/notifications')
  })
})
