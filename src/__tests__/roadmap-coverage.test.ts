// Tests for the node coverage lifecycle (docs/designs/roadmap-mastery/roadmap-engine.md §13) —
// the pure derivation that replaces the old hand-ticked roadmap_node_status.
//
// The rules that matter here are the ones a professor would notice being wrong:
// a deck only completes at its LAST slide, a published quiz nobody started is
// not the same as one the class is working through, and a skipped week must
// leave both the numerator and the denominator.

import { describe, it, expect } from 'vitest'
import {
  computeCoverage,
  deriveAssignmentCoverage,
  deriveLectureCoverage,
  deriveModuleCoverage,
  deriveQuizCoverage,
  isExtraItemType,
  isStatefulItemType,
  placementByResource,
  type CoverageSignals,
  type DeckPresentation,
  type ModuleDelivery,
} from '@/lib/roadmap/coverage'
import type {
  AutoRoadmapData,
  RoadmapEdge,
  RoadmapItemNode,
  RoadmapLinkEndpointType,
  RoadmapResourceNode,
  RoadmapWeekNode,
} from '@/lib/validations/auto-roadmap'
import type { ModuleItemType } from '@/lib/validations/module'

// ── Fixture builders ─────────────────────────────────────────────

const NOTHING: ModuleDelivery = {
  hasEndedClass: false,
  hasClosedAssessment: false,
}

const deck = (o: Partial<DeckPresentation> = {}): DeckPresentation => ({
  maxSlide: 0,
  pageCount: 30,
  roomStatus: 'ended',
  ...o,
})

function item(o: Partial<RoadmapItemNode> & { id: string; itemType: ModuleItemType }): RoadmapItemNode {
  return {
    title: o.id, description: '', position: 0, status: 'not_started', href: null, file: null, ...o,
  } as RoadmapItemNode
}

function week(o: Partial<RoadmapWeekNode> & { id: string }): RoadmapWeekNode {
  return {
    title: o.id, description: '', weekNumber: null, position: 0, status: 'not_started', items: [], ...o,
  } as RoadmapWeekNode
}

function resource(
  o: Partial<RoadmapResourceNode> & { id: string; kind: RoadmapResourceNode['kind'] },
): RoadmapResourceNode {
  return { title: o.id, status: 'not_started', stateLabel: 'Draft', href: '', ...o } as RoadmapResourceNode
}

function data(o: Partial<AutoRoadmapData>): AutoRoadmapData {
  return { sectionId: 'sec-1', weeks: [], resources: [], edges: [], ...o }
}

const place = (moduleId: string, resId: string, resType: RoadmapLinkEndpointType): RoadmapEdge => ({
  id: `e-${moduleId}-${resId}`, fromType: 'module', fromId: moduleId, toType: resType, toId: resId,
})

function signals(o: Partial<CoverageSignals> = {}): CoverageSignals {
  return {
    enrolledCount: 0,
    skippedModules: [],
    decksByItem: {},
    roomsByModule: {},
    quizzes: {},
    assignments: {},
    ...o,
  }
}

const PAST = new Date(Date.now() - 86_400_000).toISOString()
const FUTURE = new Date(Date.now() + 86_400_000).toISOString()

// ── Stateless node types ─────────────────────────────────────────

describe('isStatefulItemType', () => {
  it('counts only lectures — a professor never "delivers" a paper or a link', () => {
    expect(isStatefulItemType('lecture')).toBe(true)
    for (const t of ['video', 'image', 'reference', 'link', 'note', 'section_divider'] as ModuleItemType[]) {
      expect(isStatefulItemType(t)).toBe(false)
    }
  })

  it('extras are the stateless material a student goes through themselves', () => {
    for (const t of ['video', 'image', 'reference', 'link'] as ModuleItemType[]) {
      expect(isExtraItemType(t)).toBe(true)
    }
    // A lecture is derived, and notes/dividers were never content.
    for (const t of ['lecture', 'note', 'section_divider'] as ModuleItemType[]) {
      expect(isExtraItemType(t)).toBe(false)
    }
  })
})

// ── Deck lectures ────────────────────────────────────────────────

describe('deriveLectureCoverage — slide decks', () => {
  it('is not started until a room actually presents it', () => {
    const r = deriveLectureCoverage(true, [deck({ roomStatus: 'scheduled', maxSlide: 12 })], NOTHING)
    expect(r.status).toBe('not_started')
  })

  it('stays in progress at 28 of 30 — no invented 90% threshold', () => {
    const r = deriveLectureCoverage(true, [deck({ maxSlide: 27 })], NOTHING)
    expect(r.status).toBe('in_progress')
    expect(r.coverage).toEqual({ covered: 28, total: 30 })
  })

  it('completes only on the last slide (maxSlide is 0-based)', () => {
    const r = deriveLectureCoverage(true, [deck({ maxSlide: 29 })], NOTHING)
    expect(r.status).toBe('complete')
    expect(r.coverage).toEqual({ covered: 30, total: 30 })
  })

  it('unions coverage across two classes that each presented part of the deck', () => {
    const r = deriveLectureCoverage(
      true,
      [deck({ maxSlide: 9 }), deck({ maxSlide: 29 })],
      NOTHING,
    )
    expect(r.status).toBe('complete')
    expect(r.coverage).toEqual({ covered: 30, total: 30 })
  })

  it('a later review class re-showing early slides cannot undo coverage', () => {
    // Descending order: last-wins code would report 10 of 30 and regress the
    // deck from complete back to in progress.
    const r = deriveLectureCoverage(
      true,
      [deck({ maxSlide: 29 }), deck({ maxSlide: 9 })],
      NOTHING,
    )
    expect(r.coverage).toEqual({ covered: 30, total: 30 })
    expect(r.status).toBe('complete')
  })

  it('a closed assessment marks the deck fully covered even mid-deck', () => {
    const r = deriveLectureCoverage(true, [deck({ maxSlide: 4 })], {
      ...NOTHING,
      hasClosedAssessment: true,
    })
    expect(r.status).toBe('complete')
    expect(r.coverage).toEqual({ covered: 30, total: 30 })
  })

  it('never reports more slides covered than the deck has', () => {
    const r = deriveLectureCoverage(true, [deck({ maxSlide: 99 })], NOTHING)
    expect(r.coverage).toEqual({ covered: 30, total: 30 })
  })

  it('omits the fraction when the deck never rendered a page count', () => {
    const r = deriveLectureCoverage(true, [deck({ pageCount: null, maxSlide: 3 })], NOTHING)
    expect(r.coverage).toBeUndefined()
    expect(r.status).toBe('in_progress')
  })
})

// ── Non-deck lectures ────────────────────────────────────────────

describe('deriveLectureCoverage — uploaded readings', () => {
  it('rides on the module’s ended class rather than waiting to be "presented"', () => {
    expect(deriveLectureCoverage(false, [], NOTHING).status).toBe('not_started')
    expect(deriveLectureCoverage(false, [], { ...NOTHING, hasEndedClass: true }).status).toBe('complete')
  })

  it('completes when the module’s assessment closed, with no class at all', () => {
    const r = deriveLectureCoverage(false, [], { ...NOTHING, hasClosedAssessment: true })
    expect(r.status).toBe('complete')
  })

  it('a live class is not yet delivery', () => {
    /* A room going live delivers nothing on its own — a reading rides on its
       module's class having ENDED. Expressed through a live presentation of the
       module's deck now that ModuleDelivery has no hasLiveClass flag (no rule ever
       read it; a mid-class deck reports progress via its own fraction instead). */
    expect(deriveLectureCoverage(false, [deck({ roomStatus: 'live' })], NOTHING).status).toBe('not_started')
  })
})

// ── Quizzes ──────────────────────────────────────────────────────

describe('deriveQuizCoverage', () => {
  const q = (o: Partial<Parameters<typeof deriveQuizCoverage>[0]> = {}) => ({
    status: 'published', dueDate: null, attemptCount: 0, submittedCount: 0, ...o,
  })

  it('a draft has not started', () => {
    expect(deriveQuizCoverage(q({ status: 'draft' }), 10).status).toBe('not_started')
  })

  it('distinguishes "published, nobody started" from "the class is working through it"', () => {
    const untouched = deriveQuizCoverage(q({ attemptCount: 0 }), 10)
    expect(untouched).toEqual({ status: 'not_started', openUntouched: true })

    const working = deriveQuizCoverage(q({ attemptCount: 3, submittedCount: 1 }), 10)
    expect(working.status).toBe('in_progress')
    expect(working.openUntouched).toBeUndefined()
  })

  it('completes past its due date — nobody can submit any more', () => {
    expect(deriveQuizCoverage(q({ dueDate: PAST, attemptCount: 1 }), 10).status).toBe('complete')
    expect(deriveQuizCoverage(q({ dueDate: FUTURE, attemptCount: 1 }), 10).status).toBe('in_progress')
  })

  it('completes once the whole roster has submitted', () => {
    expect(deriveQuizCoverage(q({ attemptCount: 10, submittedCount: 10 }), 10).status).toBe('complete')
    expect(deriveQuizCoverage(q({ attemptCount: 10, submittedCount: 9 }), 10).status).toBe('in_progress')
  })

  it('an empty roster never fakes completion', () => {
    expect(deriveQuizCoverage(q({ attemptCount: 0, submittedCount: 0 }), 0).status).toBe('not_started')
  })
})

// ── Assignments ──────────────────────────────────────────────────

describe('deriveAssignmentCoverage', () => {
  const a = (o: Partial<Parameters<typeof deriveAssignmentCoverage>[0]> = {}) => ({
    status: 'published', submissionCount: 0, gradedCount: 0, ...o,
  })

  it('closed and archived are complete regardless of grading', () => {
    expect(deriveAssignmentCoverage(a({ status: 'closed' }), 10).status).toBe('complete')
    expect(deriveAssignmentCoverage(a({ status: 'archived' }), 10).status).toBe('complete')
  })

  it('published with no submissions is open-untouched, not in progress', () => {
    expect(deriveAssignmentCoverage(a(), 10)).toEqual({ status: 'not_started', openUntouched: true })
  })

  it('completes when the whole roster is graded — today nothing ever flips this', () => {
    expect(deriveAssignmentCoverage(a({ submissionCount: 10, gradedCount: 10 }), 10).status).toBe('complete')
    expect(deriveAssignmentCoverage(a({ submissionCount: 10, gradedCount: 4 }), 10).status).toBe('in_progress')
  })
})

// ── Module roll-up ───────────────────────────────────────────────

describe('deriveModuleCoverage', () => {
  const none = new Set<string>()

  it('rolls up its children', () => {
    expect(deriveModuleCoverage('m', ['complete', 'complete'], none)).toMatchObject({ status: 'complete', pct: 100 })
    expect(deriveModuleCoverage('m', ['not_started', 'not_started'], none)).toMatchObject({ status: 'not_started', pct: 0 })
    expect(deriveModuleCoverage('m', ['complete', 'not_started'], none)).toMatchObject({ status: 'in_progress', pct: 50 })
    expect(deriveModuleCoverage('m', ['in_progress', 'not_started'], none)).toMatchObject({ status: 'in_progress', pct: 0 })
  })

  it('excludes a professor-skipped module without flattering it', () => {
    const r = deriveModuleCoverage('m', ['not_started'], new Set(['m']))
    expect(r).toEqual({ status: 'not_started', pct: 0, excluded: true, skipped: true })
  })

  it('excludes a module with nothing derivable rather than reading 0%', () => {
    const r = deriveModuleCoverage('m', [], none)
    expect(r).toMatchObject({ excluded: true, skipped: false })
  })

  it('gives a part-way child its own fraction instead of reading a flat 0%', () => {
    // One deck 6 slides into 30, one lecture not started: 0.2 of 2 children = 10%.
    // Without partial credit this whole week reported 0% while its class was live.
    const r = deriveModuleCoverage('m', ['in_progress', 'not_started'], none, undefined, [6 / 30])
    expect(r).toMatchObject({ status: 'in_progress', pct: 10 })
  })

  it('never lets partial credit claim 100% while a child is unfinished', () => {
    // 1 complete + a deck 999 slides into 1000: (1 + 0.999) / 2 = 99.95%, which
    // rounds to 100 and would read as "week delivered" with a slide still to go.
    const r = deriveModuleCoverage('m', ['complete', 'in_progress'], none, undefined, [999 / 1000])
    expect(r.pct).toBe(99)
    expect(r.status).toBe('in_progress')
  })

  it('ignores partial credit outside (0,1) so a bad fraction cannot inflate the percentage', () => {
    const r = deriveModuleCoverage('m', ['in_progress', 'not_started'], none, undefined, [5, Number.NaN])
    // 5 clamps to 1 and NaN to 0 — one child's worth of credit, never two.
    expect(r.pct).toBe(50)
  })

  it('counts partial credit toward the student percentage too', () => {
    // 1 stateful child at 50% + 1 of 1 extras done → 1.5 of 2 = 75%.
    const r = deriveModuleCoverage('m', ['in_progress'], none, { done: 1, total: 1 }, [0.5])
    expect(r.studentPct).toBe(75)
  })
})

// ── Placement ────────────────────────────────────────────────────

describe('placementByResource', () => {
  it('maps a resource to its module regardless of edge direction', () => {
    const out = placementByResource([
      place('m1', 'q1', 'quiz'),
      { id: 'e2', fromType: 'assignment', fromId: 'a1', toType: 'module', toId: 'm2' },
    ])
    expect(out.get('q1')).toBe('m1')
    expect(out.get('a1')).toBe('m2')
  })

  it('ignores content-to-content edges that touch no module', () => {
    const out = placementByResource([
      { id: 'e', fromType: 'module_item', fromId: 'i1', toType: 'quiz', toId: 'q1' },
    ])
    expect(out.size).toBe(0)
  })
})

// ── End to end ───────────────────────────────────────────────────

describe('computeCoverage', () => {
  it('leaves stateless material out of the module percentage entirely', () => {
    // One delivered lecture plus four supplementary items. The old roll-up read
    // 20%; only the lecture is deliverable, so delivery is 100%.
    const d = data({
      weeks: [
        week({
          id: 'm1',
          items: [
            item({ id: 'lec', itemType: 'lecture' }),
            item({ id: 'vid', itemType: 'video' }),
            item({ id: 'img', itemType: 'image' }),
            item({ id: 'ref', itemType: 'reference' }),
            item({ id: 'lnk', itemType: 'link' }),
          ],
        }),
      ],
    })
    const out = computeCoverage(d, signals({ roomsByModule: { m1: { hasEndedClass: true } } }))

    expect(out.modules.get('m1')).toMatchObject({ status: 'complete', pct: 100, excluded: false })
    expect(out.items.get('lec')?.status).toBe('complete')
    // Stateless items get no derived status at all.
    for (const id of ['vid', 'img', 'ref', 'lnk']) expect(out.items.has(id)).toBe(false)
  })

  it('a closed quiz on a module completes that module’s half-shown deck', () => {
    const d = data({
      weeks: [week({ id: 'm1', items: [item({ id: 'deck1', itemType: 'lecture', useAsSlides: true })] })],
      resources: [resource({ id: 'q1', kind: 'quiz' })],
      edges: [place('m1', 'q1', 'quiz')],
    })
    const out = computeCoverage(
      d,
      signals({
        enrolledCount: 5,
        decksByItem: { deck1: [deck({ maxSlide: 3 })] },
        quizzes: { q1: { status: 'published', dueDate: PAST, attemptCount: 2, submittedCount: 2 } },
      }),
    )

    expect(out.resources.get('q1')?.status).toBe('complete')
    expect(out.items.get('deck1')?.status).toBe('complete')
    expect(out.modules.get('m1')).toMatchObject({ pct: 100 })
  })

  it('excludes a module whose only children are stateless', () => {
    const d = data({ weeks: [week({ id: 'm1', items: [item({ id: 'ref', itemType: 'reference' })] })] })
    const out = computeCoverage(d, signals())
    expect(out.modules.get('m1')).toMatchObject({ excluded: true, skipped: false })
  })

  it('honours the skip flag over any derived child state', () => {
    const d = data({ weeks: [week({ id: 'm1', items: [item({ id: 'lec', itemType: 'lecture' })] })] })
    const out = computeCoverage(
      d,
      signals({
        skippedModules: ['m1'],
        roomsByModule: { m1: { hasEndedClass: true } },
      }),
    )
    expect(out.modules.get('m1')).toMatchObject({ excluded: true, skipped: true, pct: 0 })
  })

  it('falls back to the assembled status when an activity row is missing', () => {
    // e.g. an RLS-blocked read — better the old answer than an invented one.
    // The placement edge matters: it's the module roll-up that has to fall back.
    const d = data({
      weeks: [week({ id: 'm1' })],
      resources: [resource({ id: 'q1', kind: 'quiz', status: 'complete' })],
      edges: [place('m1', 'q1', 'quiz')],
    })
    const out = computeCoverage(d, signals())
    expect(out.resources.has('q1')).toBe(false)
    expect(out.modules.get('m1')).toMatchObject({ status: 'complete', pct: 100, excluded: false })
  })

  it('drives an assignment end to end, and a closed one completes its deck', () => {
    const d = data({
      weeks: [week({ id: 'm1', items: [item({ id: 'deck1', itemType: 'lecture', useAsSlides: true })] })],
      resources: [resource({ id: 'a1', kind: 'assignment' })],
      edges: [place('m1', 'a1', 'assignment')],
    })
    const out = computeCoverage(
      d,
      signals({
        enrolledCount: 4,
        decksByItem: { deck1: [deck({ maxSlide: 2 })] },
        assignments: { a1: { status: 'closed', submissionCount: 3, gradedCount: 3 } },
      }),
    )
    expect(out.resources.get('a1')?.status).toBe('complete')
    expect(out.items.get('deck1')?.status).toBe('complete')
    expect(out.modules.get('m1')).toMatchObject({ pct: 100 })
  })

  it('keeps a resource inside its own module’s percentage', () => {
    // A quiz placed on m2 must not inflate m1. Invisible in a one-module fixture.
    const d = data({
      weeks: [
        week({ id: 'm1', items: [item({ id: 'lecA', itemType: 'lecture' })] }),
        week({ id: 'm2', items: [item({ id: 'lecB', itemType: 'lecture' })] }),
      ],
      resources: [resource({ id: 'q1', kind: 'quiz' })],
      edges: [place('m2', 'q1', 'quiz')],
    })
    const out = computeCoverage(
      d,
      signals({
        enrolledCount: 2,
        // No class anywhere: the ONLY delivery evidence is m2's closed quiz.
        quizzes: { q1: { status: 'published', dueDate: PAST, attemptCount: 2, submittedCount: 2 } },
      }),
    )
    // m2 owns the quiz, so it completes both the quiz and (via §13.2) its lecture.
    expect(out.modules.get('m2')).toMatchObject({ pct: 100, status: 'complete' })
    expect(out.items.get('lecB')?.status).toBe('complete')
    // m1 has nothing of its own delivered — it must be untouched by m2's quiz,
    // in the numerator AND in the denominator.
    expect(out.modules.get('m1')).toMatchObject({ pct: 0, status: 'not_started' })
    expect(out.items.get('lecA')?.status).toBe('not_started')
  })

  // ── student layer (slice 2a) ───────────────────────────────────
  // Raw module_items.id — the id roadmap_progress actually stores.
  const withStudent = (ids: string[]) => ({ completedExtras: new Set<string>(ids) })

  it('leaves extras out of the professor number but counts them for the student', () => {
    const d = data({
      weeks: [
        week({
          id: 'm1',
          items: [
            item({ id: 'lec', itemType: 'lecture' }),
            item({ id: 'vid', itemType: 'video' }),
            item({ id: 'ref', itemType: 'reference' }),
          ],
        }),
      ],
    })
    const s = signals({ roomsByModule: { m1: { hasEndedClass: true } } })

    // Professor: the lecture is the only deliverable → 100%, and no student number.
    const prof = computeCoverage(d, s).modules.get('m1')!
    expect(prof).toMatchObject({ pct: 100 })
    expect(prof.studentPct).toBeUndefined()

    // Student who read one of the two extras: 2 of 3.
    const stu = computeCoverage(d, s, withStudent(['vid']))
    expect(stu.modules.get('m1')).toMatchObject({ pct: 100, studentPct: 67 })
    expect(stu.studentDone.has('vid')).toBe(true)
    expect(stu.studentDone.has('ref')).toBe(false)
  })

  it('a student cannot reach 100% while the lecture is undelivered', () => {
    // The structural cap decision 10 asks for: an undelivered lecture is not
    // "done" for the student either, so ticking every extra still falls short.
    const d = data({
      weeks: [week({ id: 'm1', items: [item({ id: 'lec', itemType: 'lecture' }), item({ id: 'vid', itemType: 'video' })] })],
    })
    const out = computeCoverage(d, signals(), withStudent(['vid']))
    expect(out.modules.get('m1')).toMatchObject({ pct: 0, studentPct: 50 })
  })

  it('an extras-only module counts for the student but not for delivery', () => {
    const d = data({ weeks: [week({ id: 'm1', items: [item({ id: 'ref', itemType: 'reference' })] })] })

    // Professor: nothing to deliver → excluded.
    expect(computeCoverage(d, signals()).modules.get('m1')).toMatchObject({ excluded: true })

    // Student: they read it → 100% of what was theirs to do. Asserted whole,
    // because the interesting part is what the OTHER fields stay: an untouched
    // extras-only week must not collapse to 'complete' via 0-of-0 delivery.
    expect(computeCoverage(d, signals(), withStudent(['ref'])).modules.get('m1'))
      .toEqual({ status: 'not_started', pct: 0, excluded: true, skipped: false, studentPct: 100 })
    expect(computeCoverage(d, signals(), withStudent([])).modules.get('m1'))
      .toEqual({ status: 'not_started', pct: 0, excluded: true, skipped: false, studentPct: 0 })
  })

  it('a note-only module has nothing for either side', () => {
    const d = data({ weeks: [week({ id: 'm1', items: [item({ id: 'n', itemType: 'note' })] })] })
    const m = computeCoverage(d, signals(), withStudent([])).modules.get('m1')!
    expect(m).toMatchObject({ excluded: true, skipped: false })
    expect(m.studentPct).toBeUndefined()
  })

  it('notes and dividers are not extras — they are nothing to go through', () => {
    const d = data({
      weeks: [week({ id: 'm1', items: [item({ id: 'n', itemType: 'note' }), item({ id: 'v', itemType: 'video' })] })],
    })
    const out = computeCoverage(d, signals(), withStudent(['v']))
    // Only the video counted, so the note can't drag the student below 100%.
    expect(out.modules.get('m1')).toMatchObject({ studentPct: 100 })
  })

  it('a skipped module stays out of the student number too', () => {
    const d = data({ weeks: [week({ id: 'm1', items: [item({ id: 'vid', itemType: 'video' })] })] })
    const out = computeCoverage(d, signals({ skippedModules: ['m1'] }), withStudent([]))!
    const m = out.modules.get('m1')!
    expect(m).toMatchObject({ excluded: true, skipped: true })
    expect(m.studentPct).toBeUndefined()
  })

  it('a live session keeps its own room lifecycle status', () => {
    const d = data({
      weeks: [week({ id: 'm1' })],
      resources: [resource({ id: 's1', kind: 'live_session', status: 'complete' })],
      edges: [place('m1', 's1', 'live_session')],
    })
    const out = computeCoverage(d, signals())
    expect(out.resources.has('s1')).toBe(false)
    // …and it still counts toward the module roll-up via its assembled status.
    expect(out.modules.get('m1')).toMatchObject({ status: 'complete', pct: 100, excluded: false })
  })

  /* The derivation is pure, so a partial signal read and a genuinely quiet course
     are the SAME input here — both derive 0%. Only the flag distinguishes them, so
     losing it in this hand-off means the page states a confidently wrong number
     with nothing to qualify it. */
  it('carries a degraded signal read through to the result', () => {
    const d = data({ weeks: [week({ id: 'm1', items: [item({ id: 'lec', itemType: 'lecture' })] })] })
    expect(computeCoverage(d, signals({ degraded: true })).degraded).toBe(true)
    // …and does not invent one on a clean read.
    expect(computeCoverage(d, signals()).degraded).toBeUndefined()
  })
})
