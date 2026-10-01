// getSpokenPassage — the "said in class" citation's read side (N1).
//
// Why this action gets its own suite when most of Athena's UI is left to
// Playwright: this is the ONLY place a lecture transcript is handed to a
// student outside search. It re-derives visibility itself rather than trusting
// the citation, so the gate (this section, ended room, "Catch me up" still on)
// and the deck match are load-bearing — and the deck match has three shapes
// because `hydrateTranscriptMatches` in lib/pinecone/search.ts builds the cited
// title three ways. A drift between those two files is silent: the chip opens,
// the slide renders, the words are simply never found.
//
// Mocking style mirrors actions-athena-context.test.ts (same source file): a
// per-table admin double whose chains are thenable, since the transcript query
// is awaited directly off .limit().

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockAdminClient = vi.fn()
const mockLoggerError = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (...args: unknown[]) => mockAdminClient(...args),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => mockLoggerError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let getSpokenPassage: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECTION = 'sec-1'
const USER = 'user-1'

/** Records every `.eq(col, val)` the transcript chain received, so the tenant /
 *  ended-room / page-offset filters can be asserted by the COLUMN they name —
 *  an embedded-resource filter (`lc_rooms.section_id`) is a string PostgREST
 *  parses, and a typo in the table half silently widens the read. */
type Eq = [string, unknown]

function adminWith(tables: Record<string, { data: unknown; error?: unknown }>) {
  const eqs: Record<string, Eq[]> = {}
  const fromSpy = vi.fn((table: string) => {
    const result = tables[table] ?? { data: null }
    eqs[table] ??= []
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'order', 'limit']) chain[m] = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn((col: string, val: unknown) => {
      eqs[table].push([col, val])
      return chain
    })
    chain.single = vi.fn().mockResolvedValue(result)
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
    return chain
  })
  return { from: fromSpy, __fromSpy: fromSpy, __eqs: eqs }
}

/** One `lc_transcriptions` row as PostgREST returns it for this select. */
function row(opts: {
  text?: string
  deckTitle?: string | null
  moduleItemId?: string | null
  roomName?: string | null
  endedAt?: string | null
  enabled?: boolean | null
}) {
  return {
    text: opts.text ?? 'So the attention weights are just a softmax over the scores.',
    lc_rooms: {
      name: opts.roomName === undefined ? 'Week 6 Lecture' : opts.roomName,
      status: 'ended',
      lecture_summary_enabled: opts.enabled === undefined ? true : opts.enabled,
      section_id: SECTION,
      ended_at: opts.endedAt === undefined ? '2026-03-01T10:00:00Z' : opts.endedAt,
    },
    lc_decks: {
      title: opts.deckTitle === undefined ? 'Attention Mechanisms' : opts.deckTitle,
      module_item_id: opts.moduleItemId === undefined ? null : opts.moduleItemId,
    },
  }
}

const enrolled = { data: { id: 'e1' } }

beforeEach(async () => {
  vi.resetModules()
  mockGetUser.mockReset()
  mockAdminClient.mockReset()
  mockLoggerError.mockReset()
  const mod = await import('@/app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions')
  getSpokenPassage = mod.getSpokenPassage
})

function authed() {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })
}
function unauthed() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'no user' } })
}

describe('getSpokenPassage — guards before the transcript is read', () => {
  it('refuses an unauthenticated caller without touching the admin DB', async () => {
    unauthed()
    await expect(getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })).resolves.toEqual({ text: null })
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('refuses a student not enrolled in the section before reading transcripts', async () => {
    authed()
    const admin = adminWith({ enrollments: { data: null } })
    mockAdminClient.mockReturnValue(admin)

    await expect(getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })).resolves.toEqual({ text: null })
    expect(admin.__fromSpy.mock.calls.map((c: unknown[]) => c[0])).not.toContain('lc_transcriptions')
  })

  it('rejects a non-positive or non-integer slide rather than querying page_number -1', async () => {
    authed()
    const admin = adminWith({ enrollments: enrolled })
    mockAdminClient.mockReturnValue(admin)

    for (const bad of [0, -2, 1.5, NaN]) {
      await expect(getSpokenPassage(SECTION, bad, { title: 'Attention Mechanisms' })).resolves.toEqual({ text: null })
    }
    expect(admin.__fromSpy.mock.calls.map((c: unknown[]) => c[0])).not.toContain('lc_transcriptions')
  })

  it('reads nothing when the citation names neither a title nor an item', async () => {
    authed()
    const admin = adminWith({ enrollments: enrolled })
    mockAdminClient.mockReturnValue(admin)

    // A blank title is not a wildcard — without it every deck spoken over this
    // slide would match, and the student would get another lecture's words.
    await expect(getSpokenPassage(SECTION, 3, { title: '   ' })).resolves.toEqual({ text: null })
    await expect(getSpokenPassage(SECTION, 3, {})).resolves.toEqual({ text: null })
    expect(admin.__fromSpy.mock.calls.map((c: unknown[]) => c[0])).not.toContain('lc_transcriptions')
  })
})

describe('getSpokenPassage — how the query is scoped', () => {
  it('asks for the 0-based page and scopes to this section’s ENDED rooms', async () => {
    authed()
    const admin = adminWith({ enrollments: enrolled, lc_transcriptions: { data: [row({})] } })
    mockAdminClient.mockReturnValue(admin)

    await getSpokenPassage(SECTION, 7, { title: 'Attention Mechanisms' })

    const eqs = admin.__eqs.lc_transcriptions
    // The citation prints slide 7; lc_transcriptions stores it as page 6.
    expect(eqs).toContainEqual(['page_number', 6])
    // Embedded-resource filters: the table half must be there, or the read
    // widens to every section's ended rooms / to live rooms.
    expect(eqs).toContainEqual(['lc_rooms.section_id', SECTION])
    expect(eqs).toContainEqual(['lc_rooms.status', 'ended'])
  })
})

describe('getSpokenPassage — the three ways a citation names a deck', () => {
  it('matches the deck’s own title, case- and whitespace-insensitively', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: enrolled,
        lc_transcriptions: { data: [row({ text: '  Softmax over the scores.  ' })] },
      }),
    )

    await expect(getSpokenPassage(SECTION, 3, { title: '  attention MECHANISMS ' })).resolves.toEqual({
      text: 'Softmax over the scores.',
      room: 'Week 6 Lecture',
    })
  })

  it('matches the room name when the deck carries no title of its own', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: enrolled,
        // search.ts titles this citation with the room name: `deck.title || roomName`.
        lc_transcriptions: { data: [row({ deckTitle: null, roomName: 'Week 6 Lecture' })] },
      }),
    )

    const res = await getSpokenPassage(SECTION, 3, { title: 'Week 6 Lecture' })
    expect(res.text).toContain('attention weights')
  })

  it('matches the "Live class" literal an untitled deck in an unnamed room is cited as', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: enrolled,
        // search.ts falls all the way through: `deck.title || room.name || 'Live class'`.
        lc_transcriptions: { data: [row({ deckTitle: null, roomName: null })] },
      }),
    )

    const res = await getSpokenPassage(SECTION, 3, { title: 'Live class' })
    expect(res.text).toContain('attention weights')
  })

  it('does not let "Live class" match a deck that HAS a name of its own', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: enrolled,
        lc_transcriptions: { data: [row({ deckTitle: 'Attention Mechanisms', roomName: 'Week 6 Lecture' })] },
      }),
    )

    const res = await getSpokenPassage(SECTION, 3, { title: 'Live class' })
    expect(res.text).toBeNull()
  })

  it('matches the promoted module item even when the cited title is a different string', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: enrolled,
        lc_transcriptions: { data: [row({ deckTitle: 'Deck as renamed in class', moduleItemId: 'item-9' })] },
      }),
    )

    const res = await getSpokenPassage(SECTION, 3, { title: 'Lecture 6 Slides', itemId: 'item-9' })
    expect(res.text).toContain('attention weights')
  })

  it('does not hand back another deck spoken over the same slide number', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: enrolled,
        lc_transcriptions: {
          data: [row({ deckTitle: 'Tokenization', roomName: 'Week 2 Lecture', moduleItemId: 'item-2' })],
        },
      }),
    )

    // Same section, same ended-room gate, same page — only the deck differs.
    await expect(getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms', itemId: 'item-9' })).resolves.toEqual({
      text: null,
    })
  })
})

describe('getSpokenPassage — the "Catch me up" gate', () => {
  it('drops a room whose professor turned the recap off', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({ enrollments: enrolled, lc_transcriptions: { data: [row({ enabled: false })] } }),
    )

    // The toggle is re-read here, not trusted from the citation, so flipping it
    // off after the answer streamed takes the passage away on the next click.
    await expect(getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })).resolves.toEqual({ text: null })
  })

  it('treats a null toggle as ON, matching the RLS policy’s COALESCE(…, true)', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({ enrollments: enrolled, lc_transcriptions: { data: [row({ enabled: null })] } }),
    )

    // Defensive parity: the column is NOT NULL DEFAULT true today, but search.ts
    // and the student read policy both default null to ON. Tightening this to
    // `=== true` would make the panel hide what search is allowed to cite.
    const res = await getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })
    expect(res.text).toContain('attention weights')
  })
})

describe('getSpokenPassage — a deck presented more than once', () => {
  it('returns the most recent session’s words regardless of row order', async () => {
    authed()
    const older = row({
      text: 'First pass at attention, from the original lecture.',
      roomName: 'Week 6 Lecture',
      endedAt: '2026-03-01T10:00:00Z',
    })
    const newer = row({
      text: 'Second pass at attention, from the make-up class.',
      roomName: 'Week 6 Make-up',
      endedAt: '2026-03-08T10:00:00Z',
    })
    mockAdminClient.mockReturnValue(
      // Deliberately oldest-first: PostgREST returned no order, so the recency
      // pick must come from the sort, not from the row that happened to arrive.
      adminWith({ enrollments: enrolled, lc_transcriptions: { data: [older, newer] } }),
    )

    await expect(getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })).resolves.toEqual({
      text: 'Second pass at attention, from the make-up class.',
      room: 'Week 6 Make-up',
    })
  })
})

describe('getSpokenPassage — nothing to show', () => {
  it('skips a row whose transcript is blank', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({ enrollments: enrolled, lc_transcriptions: { data: [row({ text: '   ' })] } }),
    )

    await expect(getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })).resolves.toEqual({ text: null })
  })

  it('omits the room label when the room was never meaningfully named', async () => {
    authed()
    // Whitespace, not null, is the fixture that matters: `?? undefined` would
    // pass a null through fine and let "  " reach the UI, where SpokenPassage
    // renders it as "Said in    · slide 3" instead of falling back to
    // "Said in class". Only `.trim() || undefined` catches both.
    mockAdminClient.mockReturnValue(
      adminWith({ enrollments: enrolled, lc_transcriptions: { data: [row({ roomName: '   ' })] } }),
    )

    const res = await getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })
    expect(res.text).toContain('attention weights')
    expect(res.room).toBeUndefined()
  })

  it('returns nothing (not a throw) when the transcript read fails', async () => {
    authed()
    mockAdminClient.mockReturnValue(
      adminWith({
        enrollments: enrolled,
        lc_transcriptions: { data: null, error: { message: 'connection reset' } },
      }),
    )

    // The preview still has the slide; a failed lead must degrade to the shape
    // the panel had before this existed.
    await expect(getSpokenPassage(SECTION, 3, { title: 'Attention Mechanisms' })).resolves.toEqual({ text: null })
    expect(mockLoggerError).toHaveBeenCalled()
  })
})
