/**
 * #598 — a newly added skill could become permanently unmanageable.
 *
 * The report blamed a '%' in the name, but the name is incidental. What matters is which
 * PARENT the AI placement picked: suggestSkillPlacement offered every top-level skill as a
 * candidate, including ones that are `suppressed` (an AI suggestion the professor has not
 * confirmed) or `excluded` (one they deliberately dropped).
 *
 * Nesting under a suppressed main hides the child completely, because the List renders
 * `initialTree.filter(n => !n.suppressed)` and the separate "suggested" strip prints only the
 * suggestion's own name — never its subtopics. Since every management control (rename, delete,
 * exclude) lives in the List, the skill still exists (visible in the Matrix, working Concept
 * Detail page) with no way to manage it ever again.
 *
 * These tests pin the two halves: the visibility rule the List actually applies, and the
 * candidate filter that now stops a skill being parented somewhere invisible.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildSkillTree } from '@/lib/skills/tree'
import type { SkillRow } from '@/lib/validations/skill'

const row = (over: Partial<SkillRow> & { id: string; name: string }): SkillRow =>
  ({
    section_id: 'sec-1', institution_id: 'inst-1', parent_id: null, info: null,
    source: 'professor', placement_pinned: false, excluded: false, suppressed: false,
    position: 0, created_at: '', updated_at: '', ...over,
  }) as SkillRow

/** Exactly the derivation SkillsManager applies to decide what the List shows. */
function visibleInList(rows: SkillRow[]): string[] {
  const tree = buildSkillTree(rows)
  const tracked = tree.filter((n) => !n.suppressed)
  // mains, plus the subtopics that render underneath an expanded main
  return tracked.flatMap((m) => [m.name, ...m.subtopics.map((s) => s.name)])
}

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. They pin
   the AI-on path ONLY; this file asserts nothing about the disabled degradation.
   (ai-kill-switch.test.ts covers the guard module itself, not this pipeline.) */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

describe('#598 — a child of a suppressed main is invisible in the List', () => {
  it('hides the child when its parent is an unconfirmed AI suggestion', () => {
    const visible = visibleInList([
      row({ id: 'p', name: 'Suggested Main', suppressed: true, source: 'ai' }),
      row({ id: 'c', name: '100%_recall', parent_id: 'p' }),
    ])
    // this is the defect the fix prevents upstream: no route to rename or delete it
    expect(visible).not.toContain('100%_recall')
  })

  it('shows the same child once its parent is a tracked main — so the name is NOT the problem', () => {
    const visible = visibleInList([
      row({ id: 'p', name: 'Confirmed Main' }),
      row({ id: 'c', name: '100%_recall', parent_id: 'p' }),
    ])
    expect(visible).toContain('100%_recall')
  })

  it("a '%' in a top-level skill's name renders normally — the character is incidental", () => {
    expect(visibleInList([row({ id: 'a', name: '100%_recall' })])).toContain('100%_recall')
    expect(visibleInList([row({ id: 'a', name: '50%_off_by_one' })])).toContain('50%_off_by_one')
  })
})

/* Exercises the REAL suggestSkillPlacement, not a copy of its filter. A test that re-states
   the production expression stays green through any regression in it — which is precisely the
   failure mode this issue is about. The oracle is the candidate list handed to the model. */
describe('#598 — placement candidates exclude untracked mains', () => {
  it('never offers a suppressed or excluded main as a parent, and treats null flags as tracked', async () => {
    vi.resetModules()
    const suggestSkillParent = vi.fn().mockResolvedValue(null)

    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }))
    vi.doMock('next/server', () => ({ after: (fn: () => void) => fn() }))
    vi.doMock('@/lib/supabase/event-logger', () => ({ logEvent: vi.fn() }))
    vi.doMock('@/lib/extraction/enqueue', () => ({ enqueueMasteryRecompute: vi.fn() }))
    vi.doMock('@/lib/ai/llm-client', () => ({
      suggestSkillParent: (...a: unknown[]) => suggestSkillParent(...a),
      suggestSectionSkillHierarchy: vi.fn(),
    }))
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'prof-1' } }, error: null }) } }),
    }))

    const MAINS = [
      { id: 'm1', name: 'Tracked', suppressed: false, excluded: false },
      { id: 'm2', name: 'Unconfirmed', suppressed: true, excluded: false },
      { id: 'm3', name: 'Dropped', suppressed: false, excluded: true },
      { id: 'm4', name: 'LegacyNulls', suppressed: null, excluded: null },
    ]
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'neq', 'order']) chain[m] = () => chain
    chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: MAINS, error: null }).then(r)
    vi.doMock('@/lib/auth/section-access', () => ({
      verifySectionAccess: async () => ({ ok: true, role: 'professor', adminDb: { from: () => chain } }),
      canWriteAsStaff: () => true,
    }))

    const mod = await import('@/app/(dashboard)/professor/courses/[sectionId]/skills/actions')
    await mod.suggestSkillPlacement('8a2ac745-bbd2-4848-a4b6-aeac1e69bb4b', 'Recursion')

    expect(suggestSkillParent).toHaveBeenCalled()
    const namesOffered = suggestSkillParent.mock.calls[0][1] as string[]
    expect(namesOffered).toContain('Tracked')
    expect(namesOffered).toContain('LegacyNulls')      // null flags mean tracked, not untracked
    expect(namesOffered).not.toContain('Unconfirmed')  // suppressed → would hide the child
    expect(namesOffered).not.toContain('Dropped')      // excluded → professor dropped it
  })
})
