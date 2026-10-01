// The student dashboard's "Focus areas" card (#287).
//
// Two halves, tested separately because they fail differently:
//
//  1. The SELECTION rule — which topics surface. Everything here is a judgement that
//     would be silently wrong rather than broken: a null score rendered as 0% tells a
//     student to go work on something nobody has measured; an excluded skill tells
//     them to work on something their professor deliberately dropped.
//  2. The three EMPTY-ish states, which an empty array cannot tell apart. "You have
//     not been assessed yet" and "everything is already strong" are opposite messages
//     and both arrive as `skills: []`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FocusAreas } from '@/components/student/dashboard/FocusAreas'
import type { StudentFocusSkill } from '@/lib/supabase/queries'

// ── selection rule ────────────────────────────────────────────────────────

const mockGetOwnMasteryTrend = vi.fn(async () => [] as { skillName: string; from: number; to: number }[])
vi.mock('@/lib/roadmap/engagement', () => ({
  getOwnMasteryTrend: (...a: unknown[]) => mockGetOwnMasteryTrend(...(a as [])),
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

interface SkillFixture { id: string; name: string; parent_id?: string | null; excluded?: boolean; suppressed?: boolean }
interface MasteryFixture { skill_id: string; score: number | null }

/** A fake admin client covering exactly the three reads the query makes. */
function fakeDb(opts: {
  sections?: { id: string; code: string; features: string[] }[]
  skills?: Record<string, SkillFixture[]>
  mastery?: Record<string, MasteryFixture[]>
  enrollError?: boolean
  skillsError?: boolean
}) {
  const sections = opts.sections ?? [{ id: 'sec-1', code: 'CS-513', features: ['roadmap'] }]
  const allSkills = Object.entries(opts.skills ?? {}).flatMap(([sectionId, list]) =>
    list.map((s) => ({
      id: s.id, section_id: sectionId, institution_id: 'inst', parent_id: s.parent_id ?? null,
      name: s.name, info: null, source: 'ai', placement_pinned: false,
      excluded: s.excluded ?? false, suppressed: s.suppressed ?? false,
      library_skill_id: null, position: 0, created_at: '', updated_at: '',
    })),
  )
  const allMastery = Object.entries(opts.mastery ?? {}).flatMap(([sectionId, list]) =>
    list.map((m) => ({ student_id: 'stu-1', skill_id: m.skill_id, section_id: sectionId, score: m.score, state: null })),
  )

  return {
    from: (table: string) => {
      if (table === 'enrollments') {
        const chain: Record<string, unknown> = {}
        const self = () => chain
        chain.select = self
        chain.eq = (col: string) => {
          if (col === 'status') {
            return Promise.resolve({
              data: opts.enrollError ? null : sections.map((sc) => ({
                section_id: sc.id,
                course_sections: { id: sc.id, settings: { enabledFeatures: sc.features }, courses: { code: sc.code } },
              })),
              error: opts.enrollError ? { message: 'boom' } : null,
            })
          }
          return chain
        }
        return chain
      }
      if (table === 'skills') {
        return { select: () => ({ in: async () => ({ data: opts.skillsError ? null : allSkills, error: opts.skillsError ? { message: 'boom' } : null }) }) }
      }
      // skill_mastery
      return { select: () => ({ eq: () => ({ in: async () => ({ data: allMastery, error: null }) }) }) }
    },
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let getStudentFocusSkills: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockGetOwnMasteryTrend.mockClear()
  const mod = await import('@/lib/supabase/queries')
  getStudentFocusSkills = mod.skillQueries.getStudentFocusSkills
})

describe('getStudentFocusSkills — which topics surface', () => {
  it('returns the weakest first and caps the list', async () => {
    const db = fakeDb({
      skills: { 'sec-1': [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }, { id: 'd', name: 'Delta' }] },
      mastery: { 'sec-1': [
        { skill_id: 'a', score: 55 }, { skill_id: 'b', score: 20 },
        { skill_id: 'c', score: 70 }, { skill_id: 'd', score: 40 },
      ] },
    })
    const out = await getStudentFocusSkills(db, 'stu-1')
    expect(out.skills.map((s: StudentFocusSkill) => s.name)).toEqual(['Beta', 'Delta', 'Alpha'])
  })

  it('drops topics the student has already mastered', async () => {
    /* A topic leaves this card by being learned — that is what keeps it a to-do list
       rather than a report card. */
    const db = fakeDb({
      skills: { 'sec-1': [{ id: 'a', name: 'Mastered' }, { id: 'b', name: 'Weak' }] },
      mastery: { 'sec-1': [{ skill_id: 'a', score: 91 }, { skill_id: 'b', score: 44 }] },
    })
    const out = await getStudentFocusSkills(db, 'stu-1')
    expect(out.skills.map((s: StudentFocusSkill) => s.name)).toEqual(['Weak'])
    expect(out.hasAnyMastery).toBe(true)
  })

  it('never surfaces an unscored topic as a weak one', async () => {
    /* A null score means "not assessed", not zero. Ranking it as 0% would put the
       thing nobody has measured at the very top of the student's to-do list. */
    const db = fakeDb({
      skills: { 'sec-1': [{ id: 'a', name: 'Unscored' }, { id: 'b', name: 'Real' }] },
      mastery: { 'sec-1': [{ skill_id: 'a', score: null }, { skill_id: 'b', score: 65 }] },
    })
    const out = await getStudentFocusSkills(db, 'stu-1')
    expect(out.skills.map((s: StudentFocusSkill) => s.name)).toEqual(['Real'])
  })

  it('ignores skills the professor excluded or that are still suppressed', async () => {
    const db = fakeDb({
      skills: { 'sec-1': [
        { id: 'a', name: 'Dropped', excluded: true },
        { id: 'b', name: 'Suggested', suppressed: true },
        { id: 'c', name: 'Real' },
      ] },
      mastery: { 'sec-1': [{ skill_id: 'a', score: 5 }, { skill_id: 'b', score: 10 }, { skill_id: 'c', score: 50 }] },
    })
    const out = await getStudentFocusSkills(db, 'stu-1')
    expect(out.skills.map((s: StudentFocusSkill) => s.name)).toEqual(['Real'])
  })

  it('spans every enrolled course, not just one', async () => {
    const db = fakeDb({
      sections: [
        { id: 'sec-1', code: 'CS-513', features: ['roadmap'] },
        { id: 'sec-2', code: 'NLP 506', features: ['roadmap'] },
      ],
      skills: { 'sec-1': [{ id: 'a', name: 'Alpha' }], 'sec-2': [{ id: 'b', name: 'Beta' }] },
      mastery: { 'sec-1': [{ skill_id: 'a', score: 60 }], 'sec-2': [{ skill_id: 'b', score: 30 }] },
    })
    const out = await getStudentFocusSkills(db, 'stu-1')
    expect(out.skills.map((s: StudentFocusSkill) => `${s.courseCode}:${s.name}`)).toEqual(['NLP 506:Beta', 'CS-513:Alpha'])
  })

  it('marks a row unlinked when the section has the roadmap switched off', async () => {
    /* The student roadmap page notFound()s when the feature is off, so a link there
       would be a dead end — the same defect #693 was filed for. */
    const db = fakeDb({
      sections: [{ id: 'sec-1', code: 'CS-513', features: ['modules'] }],
      skills: { 'sec-1': [{ id: 'a', name: 'Alpha' }] },
      mastery: { 'sec-1': [{ skill_id: 'a', score: 40 }] },
    })
    const out = await getStudentFocusSkills(db, 'stu-1')
    expect(out.skills[0].roadmapEnabled).toBe(false)
  })

  it('reports a failure as no-mastery, so a broken read cannot read as "all mastered"', async () => {
    const out = await getStudentFocusSkills(fakeDb({ enrollError: true }), 'stu-1')
    expect(out).toEqual({ skills: [], hasAnyMastery: false })
    const out2 = await getStudentFocusSkills(fakeDb({ skillsError: true, skills: { 'sec-1': [] } }), 'stu-1')
    expect(out2.hasAnyMastery).toBe(false)
  })

  it('only asks for a trend for the sections it actually shows', async () => {
    /* getOwnMasteryTrend runs several reads per section. Widening it to every enrolled
       course would put real latency on a landing page for a number decorating 3 rows. */
    const db = fakeDb({
      sections: [
        { id: 'sec-1', code: 'A', features: [] },
        { id: 'sec-2', code: 'B', features: [] },
        { id: 'sec-3', code: 'C', features: [] },
      ],
      skills: { 'sec-1': [{ id: 'a', name: 'A1' }], 'sec-2': [{ id: 'b', name: 'B1' }], 'sec-3': [{ id: 'c', name: 'C1' }] },
      mastery: { 'sec-1': [{ skill_id: 'a', score: 10 }], 'sec-2': [{ skill_id: 'b', score: 20 }], 'sec-3': [{ skill_id: 'c', score: 95 }] },
    })
    await getStudentFocusSkills(db, 'stu-1')
    const asked = mockGetOwnMasteryTrend.mock.calls.map((c) => (c as unknown[])[1])
    expect(asked.sort()).toEqual(['sec-1', 'sec-2'])
  })
})

// ── the three empty-ish states ────────────────────────────────────────────

const row = (over: Partial<StudentFocusSkill> = {}): StudentFocusSkill => ({
  skillId: 's1', name: 'Splay Trees', score: 32, sectionId: 'sec-1',
  courseCode: 'CS-513', roadmapEnabled: true, delta: null, ...over,
})

describe('FocusAreas — states an empty array cannot tell apart', () => {
  it('invites a brand-new student in, rather than reporting emptiness', async () => {
    render(<FocusAreas skills={[]} hasAnyMastery={false} />)
    expect(screen.getByText(/No topics scored yet/i)).toBeInTheDocument()
    expect(screen.getByText(/once your graded work has been marked/i)).toBeInTheDocument()
  })

  it('congratulates a student whose topics are all strong', async () => {
    render(<FocusAreas skills={[]} hasAnyMastery />)
    expect(screen.getByText(/Nothing needs attention right now/i)).toBeInTheDocument()
    expect(screen.queryByText(/No topics scored yet/i)).not.toBeInTheDocument()
  })

  it('does not dress a failed load as good news', async () => {
    /* Both other states are reassuring. A fetch that failed must look like neither. */
    render(<FocusAreas skills={[]} hasAnyMastery loadError />)
    expect(screen.getByText(/Couldn't load your topics|Couldn’t load your topics/i)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing needs attention/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/No topics scored yet/i)).not.toBeInTheDocument()
  })

  it('never congratulates while weak topics are on screen', async () => {
    /* Caught in a browser, not by these tests: the page passed `hasAnyMastery` into a
       prop called `allStrong`, so the card rendered "weakest 3" in its header and
       "Nothing needs attention right now" in its body at the same time. The conclusion
       is now derived from `skills` being empty, so the pairing cannot be got wrong. */
    render(<FocusAreas skills={[row()]} hasAnyMastery />)
    expect(screen.getByText('Splay Trees')).toBeInTheDocument()
    expect(screen.queryByText(/Nothing needs attention/i)).not.toBeInTheDocument()
  })

  it('renders a topic with its course and score', async () => {
    render(<FocusAreas skills={[row()]} />)
    expect(screen.getByText('Splay Trees')).toBeInTheDocument()
    expect(screen.getByText('CS-513')).toBeInTheDocument()
    expect(screen.getByText('32%')).toBeInTheDocument()
  })

  it('links to the roadmap only when that section has it enabled', async () => {
    const { container: on } = render(<FocusAreas skills={[row({ roadmapEnabled: true })]} />)
    expect(on.querySelector('a[href="/student/courses/sec-1/roadmap"]')).toBeTruthy()

    const { container: off } = render(<FocusAreas skills={[row({ roadmapEnabled: false })]} />)
    expect(off.querySelector('a[href="/student/courses/sec-1/roadmap"]')).toBeNull()
  })

  it('omits the delta when there is no baseline to compare against', async () => {
    /* Rendering a missing trend as "0" would claim the student had not moved, which is
       a different statement from "we have nothing to compare yet". */
    /* Assert on the delta ELEMENT, not on the absence of the character "0": a bare
       unsigned zero passes any text-based negative check while still telling the
       student, wrongly, that they have not moved. The tooltip is the only thing the
       delta renders and nothing else on the card has one. */
    const hasDelta = (c: HTMLElement) => c.querySelector('[title*="since your last check-in"]')

    const { container: none } = render(<FocusAreas skills={[row({ delta: null })]} />)
    expect(hasDelta(none)).toBeNull()

    const { container: flat } = render(<FocusAreas skills={[row({ delta: 0 })]} />)
    expect(hasDelta(flat), 'a zero delta is "no change measured", not a result').toBeNull()

    const { container: up } = render(<FocusAreas skills={[row({ delta: 8 })]} />)
    expect(hasDelta(up)).not.toBeNull()
    expect(screen.getByText('+8')).toBeInTheDocument()
  })
})
