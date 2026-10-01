// reconcileSectionSkills with the AI kill switch CLOSED.
//
// The guard used to return at the top of the function, which killed everything
// below it — including work that touches no model. An institution with AI off got
// no activity_skills rows at all, so Topic Mastery never moved for anyone, even
// when the professor hand-created every skill and hand-tagged every question
// (audit finding F9). These tests pin the narrowed guard.
//
// A separate file from skill-reconcile.test.ts because that one mocks the guard
// OPEN for its whole module; this suite needs it closed.
//
// The enforcement that matters is the llm-client mock below: both exports THROW,
// so any model call that escapes the guard fails the suite loudly instead of
// quietly spending a token. That catches a future ungated call even if it is
// added in a different file, which a static import check could not.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiGuardVerdict } from '@/lib/ai/kill-switch'

let verdict: AiGuardVerdict = { allowed: false, lockedBy: 'institution' }

vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => verdict),
  checkAiFeatureBySection: vi.fn(async () => verdict),
}))

vi.mock('@/lib/ai/llm-client', () => ({
  extractTopicsFromContent: vi.fn(() => {
    throw new Error('extractTopicsFromContent called with AI disabled')
  }),
  suggestSkillParent: vi.fn(() => {
    throw new Error('suggestSkillParent called with AI disabled')
  }),
}))

const mockLogEvent = vi.fn()
vi.mock('@/lib/supabase/event-logger', () => ({
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}))

const mockSeedLibrary = vi.fn(async () => ({ seeded: 0 }))
const mockPublishLibrary = vi.fn(async () => ({ published: 0 }))
vi.mock('@/lib/skills/library', () => ({
  seedSectionSkillsFromLibrary: (...a: unknown[]) => mockSeedLibrary(...(a as [])),
  publishSectionSkillsToLibrary: (...a: unknown[]) => mockPublishLibrary(...(a as [])),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/ai/usage', () => ({ recordAiUsage: vi.fn() }))

import { reconcileSectionSkills } from '@/lib/skills/reconcile'

// ── Fake admin client ───────────────────────────────────────────

const SECTION = 'sec-1'
const INSTITUTION = 'inst-1'

interface Tables {
  [table: string]: Array<Record<string, unknown>>
}

/**
 * Minimal PostgREST-shaped double. Filters are ignored — each table just yields
 * its configured rows — which is fine here because every assertion is about
 * WRITES, and the section scoping is the one thing reconcile never varies.
 *
 * `skills` is deliberately MUTABLE: the mint loop inserts into it and the mapping
 * pass re-reads the pool afterwards, so a test can prove a freshly minted skill
 * then receives its activity mapping.
 */
function makeAdmin(tables: Tables) {
  const writes = {
    inserted: [] as Array<{ table: string; rows: Array<Record<string, unknown>> }>,
    upserted: [] as Array<{ table: string; rows: Array<Record<string, unknown>> }>,
    updated: [] as Array<{ table: string; patch: Record<string, unknown> }>,
    deleted: [] as string[],
    rpc: [] as string[],
  }

  const from = (table: string) => {
    const rows = () => tables[table] ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'in', 'not', 'is', 'order', 'limit', 'neq', 'gte', 'lte']) {
      chain[m] = () => chain
    }
    // readAllPages terminates on a short page, and every fixture is far under one.
    chain.range = async () => ({ data: rows(), error: null })
    chain.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null })
    chain.single = async () => ({ data: rows()[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null })
    chain.insert = (input: Array<Record<string, unknown>> | Record<string, unknown>) => {
      const list = Array.isArray(input) ? input : [input]
      writes.inserted.push({ table, rows: list })
      if (table === 'skills') {
        // Mint-then-map: the pool is re-read after this insert.
        for (const r of list) tables.skills = [...(tables.skills ?? []), { id: `new-${writes.inserted.length}`, ...r }]
      }
      const res = { data: list.map((_, i) => ({ id: `new-${writes.inserted.length}-${i}` })), error: null }
      return {
        select: () => ({ single: async () => ({ data: res.data[0], error: null }) }),
        then: (resolve: (v: unknown) => unknown) => resolve(res),
      }
    }
    chain.upsert = async (input: Array<Record<string, unknown>>) => {
      writes.upserted.push({ table, rows: Array.isArray(input) ? input : [input] })
      return { error: null }
    }
    chain.update = (patch: Record<string, unknown>) => {
      writes.updated.push({ table, patch })
      return { eq: async () => ({ error: null }) }
    }
    chain.delete = () => {
      writes.deleted.push(table)
      return { eq: async () => ({ error: null }) }
    }
    return chain
  }

  return {
    admin: {
      from,
      rpc: async (name: string) => {
        writes.rpc.push(name)
        return { error: null }
      },
    },
    writes,
  }
}

/** A section whose professor curated one skill and tagged one question with it. */
function handCuratedSection(extra: Partial<Tables> = {}): Tables {
  return {
    course_sections: [{ institution_id: INSTITUTION }],
    skills: [{ id: 'sk-enthalpy', name: 'Enthalpy', parent_id: null, position: 0, source: 'professor', excluded: false, suppressed: false }],
    quiz_questions: [{ id: 'q1', tags: ['Enthalpy'], points: 1 }],
    quizzes: [{ id: 'quiz-1' }],
    quiz_attempts: [{ id: 'att-1', quiz_id: 'quiz-1', resolved_question_ids: ['q1'] }],
    assignments: [],
    module_items: [],
    lc_rooms: [],
    lc_interactions: [],
    activity_skills: [],
    ...extra,
  }
}

beforeEach(() => {
  verdict = { allowed: false, lockedBy: 'institution' }
  mockLogEvent.mockClear()
  mockSeedLibrary.mockClear()
  mockPublishLibrary.mockClear()
})

// ── The regression ─────────────────────────────────────────────

describe('reconcileSectionSkills with AI disabled', () => {
  it('still maps a hand-tagged question to the professor’s own skill', async () => {
    const { admin, writes } = makeAdmin(handCuratedSection())

    await reconcileSectionSkills(admin, SECTION)

    // THE bug. On the pre-fix code this array is empty: the guard returned before
    // any mapping ran, so a hand-curated section scored nothing forever.
    const maps = writes.upserted.filter((w) => w.table === 'activity_skills').flatMap((w) => w.rows)
    expect(maps).toEqual([
      expect.objectContaining({
        section_id: SECTION,
        activity_id: 'quiz-1',
        activity_type: 'quiz',
        skill_id: 'sk-enthalpy',
      }),
    ])
  })

  it('spends nothing on a model', async () => {
    // The llm-client mock throws, and reconcile catches internally, so a leak
    // would surface as a missing mapping rather than a rejection — assert the
    // mapping landed AND the mocks were never touched.
    const llm = await import('@/lib/ai/llm-client')
    const { admin } = makeAdmin(handCuratedSection())

    await reconcileSectionSkills(admin, SECTION)

    expect(llm.extractTopicsFromContent).not.toHaveBeenCalled()
    expect(llm.suggestSkillParent).not.toHaveBeenCalled()
  })

  it('runs the course-library round trip, which the old guard deferred', async () => {
    const { admin } = makeAdmin(handCuratedSection())
    await reconcileSectionSkills(admin, SECTION)
    expect(mockSeedLibrary).toHaveBeenCalledTimes(1)
    expect(mockPublishLibrary).toHaveBeenCalledTimes(1)
  })
})

// ── The destructive block stays gated ──────────────────────────

describe('legacy-bucket dissolve with AI disabled', () => {
  it('never re-homes or deletes, because a null placement would flatten it irreversibly', async () => {
    const { admin, writes } = makeAdmin(
      handCuratedSection({
        skills: [
          { id: 'bucket', name: 'Imported from activities', parent_id: null, position: 0, source: 'ai', excluded: false, suppressed: false },
          { id: 'child', name: 'Enthalpy', parent_id: 'bucket', position: 0, source: 'ai', excluded: false, suppressed: false },
        ],
      }),
    )

    await reconcileSectionSkills(admin, SECTION)

    // bestParentId returns null with AI off; re-homing on that answer would move
    // every child to top level and then destroy the bucket.
    expect(writes.deleted).not.toContain('skills')
    expect(writes.updated.filter((u) => u.table === 'skills' && 'parent_id' in u.patch)).toEqual([])
  })
})

// ── Minting is gated on the REASON, not the refusal ────────────

describe('minting a brand-new concept', () => {
  const withUnmatchedTag = () =>
    handCuratedSection({
      quiz_questions: [{ id: 'q1', tags: ['Gibbs free energy'], points: 1 }],
    })

  it('mints flat on a deliberate opt-out, so the tag can still score', async () => {
    verdict = { allowed: false, lockedBy: 'institution' }
    const { admin, writes } = makeAdmin(withUnmatchedTag())

    await reconcileSectionSkills(admin, SECTION)

    const minted = writes.inserted.filter((w) => w.table === 'skills').flatMap((w) => w.rows)
    expect(minted).toEqual([
      expect.objectContaining({ name: 'Gibbs free energy', parent_id: null, section_id: SECTION }),
    ])
  })

  it('mints NOTHING on a policy-read error, which self-heals instead', async () => {
    /* A flat mint is permanent and it escapes the section: the dedup skips any
       name already in the pool so nothing re-parents it, and the library publish
       filters on excluded/suppressed rather than source, so it propagates to
       sibling sections. A transient error must not buy a momentary gap at the
       price of permanent, course-wide damage — the tag stays on the question and
       the next healthy run places it properly. */
    verdict = { allowed: false, lockedBy: 'error' }
    const { admin, writes } = makeAdmin(withUnmatchedTag())

    await reconcileSectionSkills(admin, SECTION)

    expect(writes.inserted.filter((w) => w.table === 'skills')).toEqual([])
  })
})

// ── Assignment extraction is cache-only ────────────────────────

describe('assignment concept extraction with AI disabled', () => {
  it('serves a cached extraction and never writes through', async () => {
    const text = 'Compute the enthalpy change for the reaction.'
    const { assignmentSkillText, textHash } = await import('@/lib/skills/reconcile')
    const assignment = { id: 'asn-1', title: '', description: text, guidelines: '', module_id: null, points: 10 }
    const hash = textHash(assignmentSkillText(assignment))

    const { admin, writes } = makeAdmin(
      handCuratedSection({
        assignments: [{ ...assignment, settings: { skillExtraction: { hash, names: ['Enthalpy'] } } }],
      }),
    )

    await reconcileSectionSkills(admin, SECTION)

    const maps = writes.upserted.filter((w) => w.table === 'activity_skills').flatMap((w) => w.rows)
    expect(maps).toContainEqual(
      expect.objectContaining({ activity_id: 'asn-1', activity_type: 'assignment', skill_id: 'sk-enthalpy' }),
    )
    // Cache-only: no model call means no write-through.
    expect(writes.rpc).not.toContain('merge_assignment_settings')
  })

  it('yields nothing for a stale cache rather than calling the model', async () => {
    const { admin, writes } = makeAdmin(
      handCuratedSection({
        assignments: [{
          id: 'asn-1', title: '', description: 'edited since extraction', guidelines: '',
          module_id: null, points: 10,
          settings: { skillExtraction: { hash: 'stale-hash', names: ['Enthalpy'] } },
        }],
      }),
    )

    await reconcileSectionSkills(admin, SECTION)

    const maps = writes.upserted.filter((w) => w.table === 'activity_skills').flatMap((w) => w.rows)
    expect(maps.filter((m) => m.activity_id === 'asn-1')).toEqual([])
    expect(writes.rpc).not.toContain('merge_assignment_settings')
  })
})

// ── Observability ──────────────────────────────────────────────

describe('what a refusal records', () => {
  it('writes a durable audit row ONLY when the policy read errored', async () => {
    verdict = { allowed: false, lockedBy: 'error' }
    const errored = makeAdmin(handCuratedSection())
    await reconcileSectionSkills(errored.admin, SECTION)

    expect(mockLogEvent).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null, // actorless background job
        eventType: 'skill.reconcile_ai_unavailable',
        sectionId: SECTION,
        metadata: expect.objectContaining({ lockedBy: 'error' }),
      }),
    )
  })

  it('stays out of the admin activity feed for a deliberate opt-out', async () => {
    /* reconcile runs on every mastery recompute, including a nightly per-section
       sweep, so a row per run would flood the feed for a steady state the admin
       chose. The structured log still carries it. */
    verdict = { allowed: false, lockedBy: 'institution' }
    const optedOut = makeAdmin(handCuratedSection())
    await reconcileSectionSkills(optedOut.admin, SECTION)

    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})

// ── Drift tripwire ─────────────────────────────────────────────

describe('reconcile.ts AI surface', () => {
  it('reaches llm-client through exactly the two helpers this suite pins closed', () => {
    /* A weaker guard than the throwing mocks above — a contributor can dodge it by
       routing a model call through a new module. It earns its place by failing with
       a message that names the invariant, so the next person adding an AI helper
       here is told to gate it behind aiAllowed. */
    const src = readFileSync(join(__dirname, '../lib/skills/reconcile.ts'), 'utf8')
    const named = src.match(/import \{([^}]*)\} from '@\/lib\/ai\/llm-client'/)
    expect(named, 'reconcile.ts should import from llm-client by name').toBeTruthy()
    expect(named![1].split(',').map((x) => x.trim()).filter(Boolean).sort()).toEqual([
      'extractTopicsFromContent',
      'suggestSkillParent',
    ])
    // A dynamic import would sidestep the static list above.
    expect(src).not.toMatch(/import\(\s*['"]@\/lib\/ai\/llm-client['"]\s*\)/)
  })
})
