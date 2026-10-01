// @vitest-environment node
//
// The About kind's three ROUTE-ONLY behaviors (src/app/api/assignment-assistant/route.ts).
// None of them is reachable from the adapter, tool-factory or prompt suites:
//
//  1. THE OWNER GATE. The About page's editor is professor-only and saveAboutContent
//     rejects everyone else, so the chat that drives it is professor-only too. TAs pass
//     the shared canWriteAsStaff check at step 2 — this is a SECOND, kind-specific gate
//     after it, and nothing else in the suite exercises it.
//  2. THE body.kind FALLBACK. The screen rides only the per-message body, so an
//     auto-sent follow-up arrives with NO screen. Without the fallback those turns lose
//     the kind: wrong prompt, wrong tool set, wrong rate-limit pool and a ledger row
//     labelled assignment_assistant (all four observed in QA). Delete the fallback today
//     and no other test goes red — the bug reappears silently.
//  3. THE ATTACHMENT GATE. This route inlines file bytes for the About kind ONLY.
//     athena-attach-promise-honesty.test.ts pins that as SOURCE TEXT (a grep for the
//     gate expression); this pins the BEHAVIOR — that a non-About turn's file parts are
//     stripped before they reach the provider, and that the About prefix is built from
//     the server-verified institution + section, never from anything the client sent.
//  4. THE CONVERSATION OWNERSHIP GATE (not About-specific, but route-only and sharing
//     this harness). Now that every turn is persisted, body.id names a row in
//     athena_conversations. verifySectionAccess proves the caller may use the SECTION,
//     never that they own that conversation — so a staff member could otherwise pass
//     their own sectionId with a colleague's conversation id and append to that
//     colleague's thread through the RLS-bypassing admin client.
//
// streamText is mocked so we can read what the route handed the model; no network, no
// model. Same harness shape as assignment-assistant-search-wiring.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStreamText = vi.fn()
const mockToUIMessageStreamResponse = vi.fn(() => new Response('stream'))
const mockLogEvent = vi.fn()
const mockRecordAiUsage = vi.fn()
const mockGetUser = vi.fn()
const mockVerifySectionAccess = vi.fn()
const mockReserveAthenaSlot = vi.fn()
const mockBuildTools = vi.fn()
const mockResolveScope = vi.fn()
const mockMaterialize = vi.fn()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let captured: any

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   disabled/locked paths are covered in ai-kill-switch.test.ts. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  // Identity, so `captured.messages` is exactly the history the route built.
  convertToModelMessages: async (m: unknown) => m,
  stepCountIs: (n: number) => n,
  smoothStream: () => undefined,
}))

vi.mock('@ai-sdk/google', () => {
  const google = (model: string) => ({ model })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(google as any).tools = { googleSearch: () => ({ providerTool: 'GOOGLE_SEARCH_WEB' }) }
  return { google }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/auth/section-access', () => ({
  verifySectionAccess: (...a: unknown[]) => mockVerifySectionAccess(...a),
  canWriteAsStaff: (role: string) => role === 'professor' || role === 'ta',
  canWriteAsProfessor: (role: string) => role === 'professor',
}))
vi.mock('@/lib/supabase/event-logger', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/ai/professor-assistant/rate-limit', () => ({
  reserveAthenaSlot: (...a: unknown[]) => mockReserveAthenaSlot(...a),
}))
vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: (...a: unknown[]) => mockRecordAiUsage(...a) }))
vi.mock('@/lib/costs/external-usage', () => ({ recordExternalUsage: vi.fn() }))
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }))
vi.mock('@/lib/ai/professor-assistant/context', () => ({
  loadAssistantContext: async () => ({ institutionId: 'inst-1', courseTitle: 'Course', modules: [] }),
}))
vi.mock('@/lib/ai/assignment-assistant/context', () => ({
  loadGradeContext: async () => undefined,
  resolveAthenaLimitScope: (...a: unknown[]) => mockResolveScope(...a),
}))
vi.mock('@/lib/ai/assignment-assistant/prompts', () => ({
  buildAssignmentAssistantSystemPrompt: () => 'SYSTEM',
}))
vi.mock('@/lib/ai/assignment-assistant/tools', () => ({
  buildAssignmentAssistantTools: (...a: unknown[]) => mockBuildTools(...a),
}))
// Real asFilePart (the strip branch's actual predicate); materializeFileParts spied so
// no storage is touched — we assert HOW it was called, which is the security boundary.
vi.mock('@/lib/ai/athena-attachments-server', () => ({
  asFilePart: (p: unknown) => (p && (p as { type?: string }).type === 'file' ? p : null),
  materializeFileParts: (...a: unknown[]) => mockMaterialize(...a),
  // The route runs this over the turn it PERSISTS (it strips forged storage
  // paths before they become a durable capability). These tests assert what
  // reaches the MODEL, a separate copy of the history, so a pass-through keeps
  // them focused — filePartsToPaths' own behavior is unit-tested in
  // athena-attachments.test.ts.
  filePartsToPaths: (m: unknown) => m,
}))

const GOOGLE_MODEL = {
  id: 'gemini-flash',
  provider: 'google',
  model: 'gemini-3-flash-preview',
  thinkingLevel: 'minimal',
  attachments: { maxFiles: 5 },
}

/** A conversation id every real client always sends (useChat's own id); the
 *  route now needs one for EVERY kind, not just About's attachment scoping. */
const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555'

/**
 * A minimal but functional admin-client stub — every query the route now runs
 * for conversation persistence (the IDOR ownership check, ensureConversation's
 * upsert, the append RPC, the updated_at/title updates) needs SOMETHING to
 * chain onto and await, or it throws before ever reaching the behavior these
 * tests actually care about (attachments, kind fallback, the owner gate).
 * `.maybeSingle()` resolves to no existing row, so the IDOR guard always
 * treats the conversation as brand-new and lets the request through.
 */
function fakeAdminDb() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    upsert: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
  }
  return { from: () => chain, rpc: async () => ({ data: 1, error: null }) }
}

let POST: (req: Request) => Promise<Response>

beforeEach(async () => {
  vi.resetModules()
  // No mock implementation below throws, so resetting here is safe (see the
  // vitest-4 caveat in CLAUDE.md).
  mockStreamText.mockReset()
  mockToUIMessageStreamResponse.mockReset()
  mockLogEvent.mockReset()
  mockRecordAiUsage.mockReset()
  mockGetUser.mockReset()
  mockVerifySectionAccess.mockReset()
  mockReserveAthenaSlot.mockReset()
  mockBuildTools.mockReset()
  mockResolveScope.mockReset()
  mockMaterialize.mockReset()
  captured = undefined

  mockToUIMessageStreamResponse.mockImplementation(() => new Response('stream'))
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: fakeAdminDb() })
  mockReserveAthenaSlot.mockResolvedValue({ accepted: true, modelDef: GOOGLE_MODEL })
  mockBuildTools.mockReturnValue({ apply_edits: {}, get_course_data: {} })
  mockResolveScope.mockResolvedValue('about')
  mockMaterialize.mockImplementation(async (_db, messages) => messages)
  mockStreamText.mockImplementation((args: unknown) => {
    captured = args
    return { toUIMessageStreamResponse: mockToUIMessageStreamResponse }
  })

  const mod = await import('@/app/api/assignment-assistant/route')
  POST = mod.POST
})

function request(body: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/assignment-assistant', {
    method: 'POST',
    body: JSON.stringify({ sectionId: 'sec-1', surface: 'authoring', messages: [], id: CONVERSATION_ID, ...body }),
  })
}

const aboutScreen = { authoring: { kind: 'about' } }

describe('About kind — the professor-only gate', () => {
  it('rejects a TA with 403 even though they pass the shared staff check', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'ta', adminDb: {} })

    const res = await POST(request({ screen: aboutScreen }))

    expect(res.status).toBe(403)
    // Rejected BEFORE any model spend: no slot reserved, no stream started.
    expect(mockReserveAthenaSlot).not.toHaveBeenCalled()
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('cannot be sidestepped by omitting the screen (the fallback path is gated too)', async () => {
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'ta', adminDb: {} })

    const res = await POST(request({ kind: 'about' }))

    expect(res.status).toBe(403)
  })

  it('lets the professor through', async () => {
    const res = await POST(request({ screen: aboutScreen }))
    expect(res.status).toBe(200)
  })

  it('leaves TAs working on the assignment kinds untouched', async () => {
    // The gate is kind-specific; widening it to every authoring turn would lock
    // TAs out of the assignment surfaces they are supposed to have.
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'ta', adminDb: fakeAdminDb() })

    const res = await POST(request({ screen: { authoring: { kind: 'files' } } }))

    expect(res.status).toBe(200)
  })
})

describe('About kind — the body.kind fallback for screenless turns', () => {
  it('recovers the kind for an auto-sent turn that carries no screen', async () => {
    await POST(request({ kind: 'about' }))

    // All three consumers of activeKind must see it, or the turn silently
    // degrades into an assignment turn (QA: wrong tools + wrong pool + wrong row).
    expect(mockBuildTools).toHaveBeenCalledWith(expect.objectContaining({ kind: 'about' }))
    expect(mockResolveScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'about' }),
    )
    expect(mockReserveAthenaSlot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'about' }),
    )
  })

  it('bills the About turn to its own ledger feature, not assignment_assistant', async () => {
    await POST(request({ kind: 'about' }))
    await captured.onFinish({ usage: {}, providerMetadata: undefined, steps: [] })

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'about_assistant' }),
    )
  })

  it('the screen wins when both are present', async () => {
    // The screen is the live one; the static transport body can lag a surface swap.
    await POST(request({ kind: 'about', screen: { authoring: { kind: 'quiz' } } }))

    expect(mockBuildTools).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quiz' }))
  })

  it('ignores a non-string kind rather than passing it through', async () => {
    await POST(request({ kind: { evil: true } }))

    expect(mockBuildTools).toHaveBeenCalledWith(expect.objectContaining({ kind: undefined }))
  })
})

describe('About kind — file parts reach the model on this kind ONLY', () => {
  const withFile = (extra: Record<string, unknown>) =>
    request({
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [
            { type: 'text', text: 'here is my syllabus' },
            { type: 'file', url: 'inst-1/sec-1/11111111-2222-4333-8444-555555555555/syllabus.pdf', mediaType: 'application/pdf' },
          ],
        },
      ],
      ...extra,
    })

  it('inlines them under a prefix built from the VERIFIED institution + section', async () => {
    const fakeDb = fakeAdminDb()
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: fakeDb })

    await POST(withFile({ screen: aboutScreen, id: CONVERSATION_ID }))

    // institutionId comes from loadAssistantContext (server-derived) and sectionId
    // from the verified access check — a forged path outside this prefix is never
    // downloaded. If the prefix ever starts taking a client-supplied value, this
    // literal is what changes. The first arg is asserted by REFERENCE (the same
    // fakeDb instance), not by shape, since the admin client is now a working
    // stub rather than an inert tag object.
    expect(mockMaterialize).toHaveBeenCalledWith(
      fakeDb,
      expect.anything(),
      `inst-1/sec-1/${CONVERSATION_ID}/`,
      5,
    )
  })

  it('inlines them on every OTHER kind too, under that kind\'s own scoped prefix', async () => {
    // Attachments used to be About-only; the paperclip on the assignment kinds
    // uploaded a student-facing file the model never saw (#652). Every kind now
    // carries chat attachments, and the prefix is still rebuilt server-side, so
    // widening the capability did not widen what a forged path can reach.
    const fakeDb = fakeAdminDb()
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: fakeDb })

    await POST(withFile({ screen: { authoring: { kind: 'files' } } }))

    expect(mockMaterialize).toHaveBeenCalledWith(
      fakeDb,
      expect.anything(),
      `inst-1/sec-1/${CONVERSATION_ID}/`,
      5,
    )
  })

  it('inlines them on the GRADE surface, which has no kind at all', async () => {
    const fakeDb = fakeAdminDb()
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: fakeDb })

    await POST(withFile({ surface: 'grade' }))

    expect(mockMaterialize).toHaveBeenCalledWith(
      fakeDb,
      expect.anything(),
      `inst-1/sec-1/${CONVERSATION_ID}/`,
      5,
    )
  })

  it('rejects the whole request when there is no conversation id to scope by', async () => {
    // Every real client always sends one (useChat's own id) — persistence now
    // depends on it for EVERY kind, not just About's attachment prefix, so a
    // missing id fails the request outright rather than degrading quietly.
    const res = await POST(withFile({ screen: aboutScreen, id: undefined }))

    expect(res.status).toBe(400)
    expect(mockMaterialize).not.toHaveBeenCalled()
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('refuses a NON-UUID conversation id (no traversal char can enter the storage prefix)', async () => {
    // The id is the only client value in the path; a `..` in it would ride the prefix
    // past pathInScope (which only checks the filename after the prefix). The same
    // up-front UUID guard that persistence relies on catches this before the
    // request goes any further.
    const res = await POST(withFile({ screen: aboutScreen, id: '../../other-inst/other-sec/scope' }))

    expect(res.status).toBe(400)
    expect(mockMaterialize).not.toHaveBeenCalled()
    expect(mockStreamText).not.toHaveBeenCalled()
  })
})

describe('the conversation a turn is written to must belong to the caller', () => {
  /** The admin client as it looks when body.id names a row that ALREADY exists —
   *  the single lookup the route makes before it appends anything. */
  function dbWithExistingConversation(row: { section_id: string; user_id: string; surface?: string }) {
    const db = fakeAdminDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = (db.from as () => any)()
    chain.maybeSingle = async () => ({ data: { surface: 'studio', ...row }, error: null })
    return db
  }

  it("refuses a conversation id owned by someone else in the same section", async () => {
    mockVerifySectionAccess.mockResolvedValue({
      ok: true,
      role: 'ta',
      adminDb: dbWithExistingConversation({ section_id: 'sec-1', user_id: 'other-prof' }),
    })

    const res = await POST(request({ screen: { authoring: { kind: 'files' } } }))

    expect(res.status).toBe(403)
    // Refused before any spend AND before any write, so the victim's thread is
    // neither appended to nor bumped to the top of their resume list.
    expect(mockReserveAthenaSlot).not.toHaveBeenCalled()
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('refuses the caller\'s OWN conversation when it belongs to a different section', async () => {
    // Same person, wrong course. Letting this through would re-file a thread under
    // a section it was never scoped to, and hand it that section's class context.
    mockVerifySectionAccess.mockResolvedValue({
      ok: true,
      role: 'professor',
      adminDb: dbWithExistingConversation({ section_id: 'sec-other', user_id: 'user-1' }),
    })

    const res = await POST(request({ screen: { authoring: { kind: 'files' } } }))

    expect(res.status).toBe(403)
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it("refuses the caller's own thread from a DIFFERENT Athena surface", async () => {
    // Three surfaces share athena_conversations. Same person, same section, but a
    // console or student thread — appending Studio turns into it would leave the
    // row's surface unchanged while its transcript quietly grows foreign messages.
    mockVerifySectionAccess.mockResolvedValue({
      ok: true,
      role: 'professor',
      adminDb: dbWithExistingConversation({ section_id: 'sec-1', user_id: 'user-1', surface: 'professor' }),
    })

    const res = await POST(request({ screen: { authoring: { kind: 'files' } } }))

    expect(res.status).toBe(403)
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the ownership lookup itself errors', async () => {
    // A failed query returns null data, which is indistinguishable from "brand-new
    // conversation" — the one gate here that must refuse rather than assume.
    const db = fakeAdminDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain = (db.from as () => any)()
    chain.maybeSingle = async () => ({ data: null, error: { message: 'statement timeout' } })
    mockVerifySectionAccess.mockResolvedValue({ ok: true, role: 'professor', adminDb: db })

    const res = await POST(request({ screen: { authoring: { kind: 'files' } } }))

    expect(res.status).toBe(500)
    expect(mockStreamText).not.toHaveBeenCalled()
  })

  it('lets the owner go on writing to their own existing thread', async () => {
    // The gate must not block resume itself: every other test in this file sends a
    // brand-new id (no row), so an inverted comparison here would break every
    // resumed conversation and go unnoticed.
    mockVerifySectionAccess.mockResolvedValue({
      ok: true,
      role: 'professor',
      adminDb: dbWithExistingConversation({ section_id: 'sec-1', user_id: 'user-1' }),
    })

    const res = await POST(request({ screen: { authoring: { kind: 'files' } } }))

    expect(res.status).toBe(200)
    expect(mockStreamText).toHaveBeenCalled()
  })
})
