// Tests for the roadmap triage engine — the pure ranking/grammar/budget core
// (docs/designs/roadmap-mastery/roadmap-engine.md §4). We assert the behaviours that
// would silently mislead if they regressed: the loudness grammar, the clutter
// budget caps, node de-duplication, target resolution, and the emphasis rules.

import { describe, it, expect } from 'vitest'
import {
  triage,
  triageProfessor,
  triageStudent,
  DEFAULT_BUDGET,
  FULL_BUDGET,
  type Candidate,
  type ProfSignals,
  type StuSignals,
} from '@/lib/roadmap/triage'
import type { CourseModule, Resource, RoadmapAnnotation } from '@/lib/roadmap/prototype-adapter'

// ── Fixtures ─────────────────────────────────────────────────────
const res = (t: string, extra: Partial<Resource> = {}): Resource => ({ k: 'lecture', t, s: '', st: '', ...extra })
const mod = (title: string, materials: Resource[] = []): CourseModule => ({ title, pct: 0, materials, quizzes: [], assignments: [] })

const course: CourseModule[] = [
  mod('Module A', [res('Lecture 1'), res('Lecture 2')]),
  mod('Module B', [res('Lecture 3'), res('Lecture 4'), res('Lecture 5')]),
]
const at = (anns: RoadmapAnnotation[], t: string) => anns.find((a) => a.t === t)

const emptyProf: ProfSignals = {
  stuck: [], gradingQueue: [], allGraded: [], missing: [], draftsUnsubmitted: [],
  unpublishedDrafts: [],
  unsharedUploads: [], dueSoon: [], sessionSoon: [], itemQuality: [], masteryTrend: [], noOpens: [], openSpike: [], reDownloads: [], revisits: [], clickThroughs: [], edges: [],
  deckGap: [], neverDelivered: [], extrasCold: [], openUntouched: [],
  spokenClaims: [], deliveryDepth: [],
}
const emptyStu: StuSignals = {
  dueSoon: [], gradePosted: [], masteryHigh: [], masteryLow: [], longReads: [],
  noImprovement: [], absenceGap: [], slowWrong: [], masteryTrend: [], newSinceVisit: [], edges: [],
  selfStudyRemainder: [],
  spokenClaims: [], deliveryDepth: [],
}

// ── Grammar: tier → sub-variant ──────────────────────────────────
describe('grammar', () => {
  it('act-now flag uses banner with a count, wave without', () => {
    const { annotations } = triage(course, [
      { target: 'Lecture 1', shape: 'flag', alertness: 'act-now', tone: 'alert', n: 5 },
      { target: 'Lecture 3', shape: 'flag', alertness: 'act-now', tone: 'warn' },
    ])
    expect(at(annotations, 'Lecture 1')).toMatchObject({ v: 'flag', sub: 'banner' })
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'flag', sub: 'wave' })
  })

  it('this-week note marches (dots); insight headline number is big; ambient flag tucks (tab)', () => {
    const { annotations } = triage(course, [
      { target: 'Lecture 1', shape: 'note', alertness: 'this-week', tone: 'warn' },
      { target: 'Lecture 3', shape: 'note', alertness: 'insight', tone: 'warn', bigNumber: true },
      { target: 'Lecture 4', shape: 'flag', alertness: 'ambient', tone: 'ok' },
    ])
    expect(at(annotations, 'Lecture 1')).toMatchObject({ v: 'margin', sub: 'dots' })
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'margin', sub: 'big' })
    expect(at(annotations, 'Lecture 4')).toMatchObject({ v: 'flag', sub: 'tab' })
  })
})

// ── Target resolution ────────────────────────────────────────────
describe('target resolution', () => {
  it('drops annotations whose target is not on the map', () => {
    const { annotations } = triage(course, [{ target: 'Nonexistent Node', shape: 'note', alertness: 'insight', tone: 'warn' }])
    expect(annotations).toHaveLength(0)
  })

  it('keeps an xref only when both endpoints resolve', () => {
    const bad = triage(course, [{ target: 'Lecture 1', target2: 'Ghost', shape: 'xref', alertness: 'structural', tone: 'info' }])
    expect(bad.annotations).toHaveLength(0)
    const ok = triage(course, [{ target: 'Lecture 1', target2: 'Lecture 3', shape: 'xref', alertness: 'structural', tone: 'info' }])
    expect(ok.annotations[0]).toMatchObject({ v: 'xref', t: 'Lecture 1', t2: 'Lecture 3' })
  })
})

// ── The clutter budget ───────────────────────────────────────────
describe('clutter budget', () => {
  it('caps annotations per module', () => {
    const cands: Candidate[] = ['Lecture 3', 'Lecture 4', 'Lecture 5'].map((t, i) => ({
      target: t, shape: 'note', alertness: 'insight', tone: 'warn', urgency: 0.9 - i * 0.1,
    }))
    const { annotations } = triage(course, cands) // all in Module B; cap is 2
    expect(annotations).toHaveLength(2)
    expect(at(annotations, 'Lecture 5')).toBeUndefined() // lowest-urgency dropped
  })

  it('keeps one annotation per node (highest priority wins)', () => {
    const { annotations } = triage(course, [
      { target: 'Lecture 1', shape: 'note', alertness: 'ambient', tone: 'slate', text: 'quiet' },
      { target: 'Lecture 1', shape: 'flag', alertness: 'act-now', tone: 'alert', text: 'loud' },
    ])
    const forNode = annotations.filter((a) => a.t === 'Lecture 1')
    expect(forNode).toHaveLength(1)
    expect(forNode[0].v).toBe('flag') // the act-now candidate outranks the ambient note
  })

  it('FULL_BUDGET lifts the count caps so every node-deduped candidate renders', () => {
    // All in Module B (cap 2 under DEFAULT); FULL_BUDGET should keep all three.
    const cands: Candidate[] = ['Lecture 3', 'Lecture 4', 'Lecture 5'].map((t) => ({
      target: t, shape: 'note', alertness: 'insight', tone: 'warn',
    }))
    expect(triage(course, cands).annotations).toHaveLength(2) // curated
    expect(triage(course, cands, FULL_BUDGET).annotations).toHaveLength(3) // everything
  })

  it('FULL_BUDGET still spends the motion budget — "everything" is not "everything animates"', () => {
    // 5 looping-eligible notes (this-week → the 'dots' variant), one per lecture,
    // so nothing is dropped for count.
    const cands: Candidate[] = ['Lecture 1', 'Lecture 2', 'Lecture 3', 'Lecture 4', 'Lecture 5'].map((t) => ({
      target: t, shape: 'note' as const, alertness: 'this-week' as const, tone: 'warn' as const,
    }))
    const { annotations } = triage(course, cands, FULL_BUDGET)
    expect(annotations).toHaveLength(5) // every signal is present…
    // …but only maxLoops of them loop; the rest fall back to the static variant.
    expect(annotations.filter((a) => a.v === 'margin' && a.sub === 'dots')).toHaveLength(DEFAULT_BUDGET.maxLoops)
  })

  it('honours the global annotation cap', () => {
    const many: Candidate[] = Array.from({ length: 8 }, (_, i) => ({
      target: `Lecture ${(i % 5) + 1}`, shape: 'note' as const, alertness: 'insight' as const, tone: 'warn' as const, urgency: 1 - i * 0.05,
    }))
    const { annotations } = triage(course, many, { ...DEFAULT_BUDGET, maxAnnotations: 3, maxPerModule: 3 })
    expect(annotations.length).toBeLessThanOrEqual(3)
  })

  it('demotes act-now signals past the quota to a quieter voice', () => {
    const { annotations } = triage(
      course,
      [
        { target: 'Lecture 1', shape: 'flag', alertness: 'act-now', tone: 'alert', urgency: 0.9 },
        { target: 'Lecture 3', shape: 'flag', alertness: 'act-now', tone: 'warn', urgency: 0.5 },
      ],
      { ...DEFAULT_BUDGET, maxActNow: 1 },
    )
    // first stays loud (wave); second demoted to this-week → the quiet pin (no sub)
    expect(at(annotations, 'Lecture 1')).toMatchObject({ v: 'flag', sub: 'wave' })
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'flag', sub: undefined })
  })

  it('spends the motion budget: looping annotations past the cap go static', () => {
    const cands: Candidate[] = ['Lecture 1', 'Lecture 2', 'Lecture 3', 'Lecture 4'].map((t, i) => ({
      target: t, shape: 'note', alertness: 'this-week', tone: 'warn', urgency: 1 - i * 0.1,
    }))
    const { annotations } = triage(course, cands, { ...DEFAULT_BUDGET, maxLoops: 2, maxPerModule: 4 })
    const marching = annotations.filter((a) => a.v === 'margin' && a.sub === 'dots')
    expect(marching).toHaveLength(2) // only 2 keep the marching-dots motion
    expect(annotations.filter((a) => a.v === 'margin' && a.sub === 'ink').length).toBeGreaterThan(0) // rest quieted
  })
})

// ── Emphasis rules ───────────────────────────────────────────────
describe('emphasis', () => {
  it('allows only one breathing node; extras fall back to a static outline', () => {
    const { emphasis } = triage(course, [
      { target: 'Lecture 1', shape: 'flag', alertness: 'act-now', tone: 'alert', n: 1, emphasis: 'breathe' },
      { target: 'Lecture 3', shape: 'flag', alertness: 'act-now', tone: 'warn', n: 1, emphasis: 'breathe' },
    ])
    expect(emphasis.filter((e) => e.em === 'breathe')).toHaveLength(1)
    expect(emphasis.filter((e) => e.em === 'outline')).toHaveLength(1)
  })

  it('coexists with a static annotation but downgrades atop an animated one', () => {
    // Lecture 1: banner (static) + breathe → breathe survives.
    const staticCase = triage(course, [
      { target: 'Lecture 1', shape: 'flag', alertness: 'act-now', tone: 'alert', n: 3, emphasis: 'breathe' },
    ])
    expect(staticCase.emphasis[0]).toMatchObject({ t: 'Lecture 1', em: 'breathe' })
    // Lecture 1: marching-dots note (a loop) + shine → shine downgrades to outline.
    const animatedCase = triage(course, [
      { target: 'Lecture 1', shape: 'note', alertness: 'this-week', tone: 'warn', emphasis: 'shine' },
    ])
    expect(animatedCase.emphasis[0]).toMatchObject({ t: 'Lecture 1', em: 'outline' })
  })
})

// ── Builders (integration through the public entry points) ───────
describe('professor builder', () => {
  it('renders the grading queue and marks missing submissions as act-now + breathe', () => {
    const { annotations, emphasis } = triageProfessor(course, {
      ...emptyProf,
      gradingQueue: [{ title: 'Lecture 1', awaiting: 6 }],
      missing: [{ title: 'Lecture 3', count: 5 }],
    })
    expect(at(annotations, 'Lecture 1')?.text).toContain('awaiting your grade')
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'flag', sub: 'banner' })
    /* Names what is missing, and stays disjoint from P7's "N started, not turned
       in" — two overlapping headcounts on one card get added together by anyone
       reading fast, which claims a class in more trouble than it is. */
    expect(at(annotations, 'Lecture 3')?.text).toBe('5 never started it')
    expect(emphasis.find((e) => e.t === 'Lecture 3')?.em).toBe('breathe') // static banner + breathe coexist
  })

  /* The safety net for the end-of-class "share today's deck?" prompt. Decline or
     miss it and the material sits on the map invisible to students — the card is
     faded with an eye-off, and this note is the only place the REASON is stated in
     words. 'info', like the draft-publish reminder: an unfinished decision, not a
     problem. */
  it('names material saved but never shared with students', () => {
    const { annotations } = triageProfessor(course, {
      ...emptyProf,
      unsharedUploads: [{ title: 'Lecture 2' }],
    })
    expect(at(annotations, 'Lecture 2')?.text).toContain('not shared with students')
    expect(at(annotations, 'Lecture 2')?.tone).toBe('info')
    // Silent when everything is shared — an empty signal must not draw a ring.
    expect(triageProfessor(course, emptyProf).annotations).toHaveLength(0)
  })

  /* The two halves of P11: the same ring says different things depending on how
     long the draft has sat, because "publish it?" stops being useful once the
     professor has already ignored it for a month. */
  it('ages the draft nudge: a month-old draft names the month it stalled', () => {
    const iso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
    const fresh = triageProfessor(course, {
      ...emptyProf, unpublishedDrafts: [{ title: 'Lecture 1', createdAt: iso(4), ageDays: 4 }],
    })
    expect(at(fresh.annotations, 'Lecture 1')?.text).toBe('still a draft — publish it?')
    expect(at(fresh.annotations, 'Lecture 1')?.tone).toBe('info')

    const stale = triageProfessor(course, {
      ...emptyProf, unpublishedDrafts: [{ title: 'Lecture 1', createdAt: iso(70), ageDays: 70 }],
    })
    const note = at(stale.annotations, 'Lecture 1')
    expect(note?.text).toMatch(/^a draft since [A-Z][a-z]+ — finish or drop\?$/)
    expect(note?.tone).toBe('warn') // louder: the quiet version was already ignored
  })

  /* No created_at (an older row, or a read that didn't carry it) must not invent
     an age — it keeps the neutral wording rather than claiming a month. */
  it('falls back to the plain nudge when a draft has no authoring date', () => {
    const { annotations } = triageProfessor(course, {
      ...emptyProf, unpublishedDrafts: [{ title: 'Lecture 1', createdAt: null, ageDays: 0 }],
    })
    expect(at(annotations, 'Lecture 1')?.text).toBe('still a draft — publish it?')
  })

  /* P12 · a class about to start. The wording is hours-until, not a wall clock:
     this text is built on the server (UTC) for a professor who isn't, so "today"
     and "3 pm" are both claims we can't make from there. */
  it('flags an imminent class in hours, targeted at the session tile', () => {
    const withSession = [{ ...course[0], sessions: [{ t: 'Thursday class', s: 'Scheduled', sched: true }] }, course[1]]
    const { annotations } = triageProfessor(withSession, {
      ...emptyProf, sessionSoon: [{ title: 'Thursday class', hoursUntil: 3.2 }],
    })
    const note = at(annotations, 'session:Thursday class')
    expect(note).toMatchObject({ v: 'flag', tone: 'info' })
    expect(note?.text).toBe('class in 3 hours')
  })

  /* The quiet this-week pin renders identically at 12 hours and at 20 minutes, so
     the most time-critical thing on the map has to escalate — act-now with no count
     is a flag·wave, which is size + motion and no change of hue. */
  it('escalates a class under two hours to an act-now wave', () => {
    const withSession = [{ ...course[0], sessions: [{ t: 'Thursday class', s: 'Scheduled', sched: true }] }, course[1]]
    const soon = triageProfessor(withSession, {
      ...emptyProf, sessionSoon: [{ title: 'Thursday class', hoursUntil: 0.5 }],
    })
    expect(at(soon.annotations, 'session:Thursday class')).toMatchObject({ v: 'flag', sub: 'wave', tone: 'info' })

    const later = triageProfessor(withSession, {
      ...emptyProf, sessionSoon: [{ title: 'Thursday class', hoursUntil: 6 }],
    })
    // still the quiet pin further out — a class this afternoon is not an alarm
    expect(at(later.annotations, 'session:Thursday class')?.sub).toBeUndefined()
  })

  it('never says "in 1 hours" — hoursUntil is fractional', () => {
    const withSession = [{ ...course[0], sessions: [{ t: 'Thursday class', s: 'Scheduled', sched: true }] }, course[1]]
    const { annotations } = triageProfessor(withSession, {
      ...emptyProf, sessionSoon: [{ title: 'Thursday class', hoursUntil: 1.2 }],
    })
    expect(at(annotations, 'session:Thursday class')?.text).toBe('class in an hour')
  })

  it('says "within the hour" instead of "in 0 hours"', () => {
    const withSession = [{ ...course[0], sessions: [{ t: 'Thursday class', s: 'Scheduled', sched: true }] }, course[1]]
    const { annotations } = triageProfessor(withSession, {
      ...emptyProf, sessionSoon: [{ title: 'Thursday class', hoursUntil: 0.4 }],
    })
    expect(at(annotations, 'session:Thursday class')?.text).toBe('class starts within the hour')
  })

  it('only surfaces struggle above the floor, pinned to the module band', () => {
    const low = triageProfessor(course, { ...emptyProf, stuck: [{ moduleTitle: 'Module A', struggling: 1, engaged: 10 }] })
    expect(low.annotations.some((a) => a.t.includes('Module A'))).toBe(false) // 10% is below the 30% floor
    const high = triageProfessor(course, { ...emptyProf, stuck: [{ moduleTitle: 'Module A', struggling: 7, engaged: 10 }] })
    const band = at(high.annotations, 'module:Module A') // module-scoped prefix, not a resource
    expect(band?.text).toContain('7 of 10')
  })
})

describe('notes are never annotated', () => {
  // A note IS the professor's own aside pinned to the map. Annotating it stacks
  // our text on theirs — the reader can't tell whose is whose, and the card has
  // no room for both. The rule lives in triage's one candidate gate, so it holds
  // for every signal rather than for the handful that remembered to check.
  const withNote: CourseModule[] = [
    mod('Wk1', [res('Read me first', { k: 'note' }), res('Lecture 1')]),
  ]

  it('drops an annotation aimed at a note', () => {
    const { annotations } = triage(withNote, [
      { target: 'Read me first', shape: 'note', alertness: 'this-week', tone: 'info', text: 'start <b>here</b> next' },
    ])
    expect(annotations).toHaveLength(0)
  })

  it('still annotates a normal card in the same module', () => {
    // Pairing matters: without this, deleting the whole annotation pipeline would
    // pass the test above.
    const { annotations } = triage(withNote, [
      { target: 'Lecture 1', shape: 'note', alertness: 'this-week', tone: 'info', text: 'start <b>here</b> next' },
    ])
    expect(annotations).toHaveLength(1)
    expect(annotations[0].t).toBe('Lecture 1')
  })

  it('drops an xref when the FAR end is a note', () => {
    // The near end is fine, so a check that only looked at `target` would let
    // this through and draw a line into a note.
    const { annotations } = triage(withNote, [
      { target: 'Lecture 1', target2: 'Read me first', shape: 'xref', alertness: 'insight', tone: 'info', text: 'related' },
    ])
    expect(annotations).toHaveLength(0)
  })

  it("does not annotate the student's start-here node when the first material is a note", () => {
    // The real regression: startHere picks the first not-done material in a
    // not-done module, and in a course whose module opens with a welcome note
    // that is the note. End to end through the student builder.
    const { annotations } = triageStudent(withNote, { ...emptyStu, startHere: { title: 'Read me first' } })
    expect(annotations.some((a) => a.t === 'Read me first')).toBe(false)
  })
})

describe('module-scoped targets', () => {
  // Annotation targets resolve by title SUBSTRING, resources first, so a module
  // whose name is contained in one of its children ("Introduction to NLP" ⊂
  // "Lecture 1: Introduction to NLP") pulls its own note onto that child unless
  // the candidate says `module:`. Every module-level signal must use the prefix.
  const nested = [mod('Intro to NLP', [res('Lecture 1: Intro to NLP'), res('Reading A')])]

  it('P19 never-delivered pins to the module band, not the lecture that contains its name', () => {
    const { annotations } = triageProfessor(nested, { ...emptyProf, neverDelivered: [{ title: 'Intro to NLP' }] })
    expect(at(annotations, 'module:Intro to NLP')?.text).toContain('never got a class')
    expect(at(annotations, 'Lecture 1: Intro to NLP')).toBeUndefined()
  })

  it('S18 coverage-vs-delivery pins to the module band', () => {
    const { annotations } = triageStudent(nested, {
      ...emptyStu, coverageVsDelivery: { title: 'Intro to NLP', pct: 62 },
    }, FULL_BUDGET)
    expect(at(annotations, 'module:Intro to NLP')?.text).toContain('62%')
    expect(annotations.map((a) => a.t)).not.toContain('Intro to NLP')
  })
})

describe('student builder', () => {
  it('flags an imminent deadline loudly (wave) and a posted grade quietly (tab + tada)', () => {
    const { annotations, emphasis } = triageStudent(course, {
      ...emptyStu,
      dueSoon: [{ title: 'Lecture 1', kind: 'assignment', hoursLeft: 10 }],
      gradePosted: [{ title: 'Lecture 3' }],
    })
    expect(at(annotations, 'Lecture 1')).toMatchObject({ v: 'flag', sub: 'wave' }) // <48h → rippling flag
    expect(at(annotations, 'Lecture 1')?.text).toContain('closes tonight')
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'flag', sub: 'tab' }) // grade posted → quiet tab
    expect(emphasis.find((e) => e.t === 'Lecture 3')?.em).toBe('tada') // celebratory pop on a static node
  })

  it('S19 carries its Athena study href onto the annotation, not just into the text', () => {
    // The grammar rebuilds every candidate into a fresh annotation object, so a
    // shape that forgets to copy `href` drops the link with no other symptom:
    // the layer renders the <a> segment as plain words and the note still looks
    // right. Only an assertion on the annotation catches it.
    const { annotations } = triageStudent(course, {
      ...emptyStu,
      studyWithTutor: {
        targetTitle: 'Lecture 2', topic: 'Word alignment', pct: 41,
        tutorHref: '/student/courses/s1/roadmap?athena-topic=Word%20alignment',
      },
    }, FULL_BUDGET)
    expect(at(annotations, 'Lecture 2')).toMatchObject({
      v: 'margin',
      href: '/student/courses/s1/roadmap?athena-topic=Word%20alignment',
    })
    // The link marker and the skill name both have to survive into the text.
    expect(at(annotations, 'Lecture 2')?.text).toContain('<a>study it with Athena</a>')
    expect(at(annotations, 'Lecture 2')?.text).toContain('<b>Word alignment</b>')
  })

  it('S19 with Athena off still notes the weak skill, with no href', () => {
    const { annotations } = triageStudent(course, {
      ...emptyStu,
      studyWithTutor: { targetTitle: 'Lecture 2', topic: 'Word alignment', pct: 41 },
    }, FULL_BUDGET)
    expect(at(annotations, 'Lecture 2')?.text).toContain('weakest here')
    expect(at(annotations, 'Lecture 2')?.href).toBeUndefined()
  })
})

// ── Slice 2 aggregate signals ────────────────────────────────────
describe('slice 2 · professor aggregates', () => {
  it('renders poor item discrimination as a static insight on the quiz', () => {
    const { annotations } = triageProfessor(course, { ...emptyProf, itemQuality: [{ quizTitle: 'Lecture 1', questionLabel: 'Q5' }] })
    expect(at(annotations, 'Lecture 1')).toMatchObject({ v: 'margin', sub: 'ink' })
    expect(at(annotations, 'Lecture 1')?.text).toContain('discriminates poorly')
  })

  it('attaches a booking-demand nudge to the chosen node', () => {
    const { annotations } = triageProfessor(course, { ...emptyProf, bookingDemand: { targetTitle: 'Lecture 2', recent: 5 } })
    expect(at(annotations, 'Lecture 2')?.text).toContain('bookings spiked')
    const zero = triageProfessor(course, { ...emptyProf, bookingDemand: { targetTitle: 'Lecture 2', recent: 0 } })
    expect(at(zero.annotations, 'Lecture 2')).toBeUndefined() // no spike → nothing
  })
})

describe('slice 2 · student aggregates', () => {
  it('nudges repeated no-improvement attempts toward office hours', () => {
    const { annotations } = triageStudent(course, { ...emptyStu, noImprovement: [{ title: 'Lecture 1', attempts: 2 }] })
    expect(at(annotations, 'Lecture 1')?.text).toContain('no movement')
  })

  it('places an absence-gap note on the missed SESSION, not a same-named resource', () => {
    const withSession: CourseModule[] = [
      mod('Wk1', [res('Lecture 5')]), // a resource that shares the session's title
      { title: 'Wk2', pct: 0, materials: [], quizzes: [], assignments: [], sessions: [{ t: 'Lecture 5', s: '' }] },
    ]
    const { annotations } = triageStudent(withSession, { ...emptyStu, absenceGap: [{ sessionTitle: 'Lecture 5', topic: 'RNNs' }] })
    const note = at(annotations, 'session:Lecture 5') // session-scoped prefix
    expect(note?.text).toContain('you missed this')
    expect(note?.text).toContain('RNNs')
  })

  it('surfaces a slow-and-wrong comprehension gap', () => {
    const { annotations } = triageStudent(course, { ...emptyStu, slowWrong: [{ title: 'Lecture 1', skill: 'regularization' }] })
    expect(at(annotations, 'Lecture 1')?.text).toContain('slow')
    expect(at(annotations, 'Lecture 1')?.text).toContain('regularization')
  })
})

// ── Slice 3 structural-gap signals ───────────────────────────────
describe('slice 3 · mastery trend + engagement', () => {
  it('professor surfaces only a mastery DECLINE, not a gain', () => {
    const { annotations } = triageProfessor(course, {
      ...emptyProf,
      masteryTrend: [{ targetTitle: 'Lecture 1', from: 64, to: 52 }, { targetTitle: 'Lecture 3', from: 40, to: 78 }],
    })
    // both numbers rendered, each toned by its mastery band (64 & 52 → warn)
    expect(at(annotations, 'Lecture 1')?.text).toContain('<c:warn>64%</c> → <c:warn>52%</c>')
    expect(at(annotations, 'Lecture 3')).toBeUndefined() // a gain is not "slipping"
  })

  it('student shows a mastery jump as good news and a drop as a warning', () => {
    const up = triageStudent(course, { ...emptyStu, masteryTrend: [{ targetTitle: 'Lecture 1', from: 35, to: 78 }] })
    expect(at(up.annotations, 'Lecture 1')).toMatchObject({ tone: 'ok' })
    // 35 low → red band, 78 → amber band: the rise reads red→amber
    expect(at(up.annotations, 'Lecture 1')?.text).toContain('<c:alert>35%</c> → <c:warn>78%</c>')
    const down = triageStudent(course, { ...emptyStu, masteryTrend: [{ targetTitle: 'Lecture 1', from: 70, to: 55 }] })
    expect(at(down.annotations, 'Lecture 1')).toMatchObject({ tone: 'warn' })
  })

  it('professor engagement: no-opens is a quiet pencil, an open spike is a tally', () => {
    const { annotations } = triageProfessor(course, {
      ...emptyProf, noOpens: [{ title: 'Lecture 1' }], openSpike: [{ title: 'Lecture 3', count: 13 }],
    })
    expect(at(annotations, 'Lecture 1')).toMatchObject({ v: 'margin', sub: undefined, tone: 'slate' })
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'tally', n: 13 })
  })

  it('professor engagement: re-downloads surface a note and hold a reserved slot', () => {
    // Flood the map so only the reserved engagement quota lets P2 through.
    const stuck = course.map((m) => ({ moduleTitle: m.title, struggling: 9, engaged: 10 }))
    const { annotations } = triageProfessor(course, {
      ...emptyProf, stuck, reDownloads: [{ title: 'Lecture 2', students: 4 }],
    })
    expect(at(annotations, 'Lecture 2')).toMatchObject({ v: 'margin', tone: 'info' })
    expect(at(annotations, 'Lecture 2')?.text).toContain('re-downloading')
  })

  it('professor engagement: revisits are a note, click-throughs are a tally', () => {
    const { annotations } = triageProfessor(course, {
      ...emptyProf,
      revisits: [{ title: 'Lecture 1', students: 3 }],
      clickThroughs: [{ title: 'Lecture 3', students: 9 }],
    })
    expect(at(annotations, 'Lecture 1')).toMatchObject({ v: 'margin', tone: 'info' })
    expect(at(annotations, 'Lecture 1')?.text).toContain('revisiting')
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'tally', n: 9 })
    expect(at(annotations, 'Lecture 3')?.text).toContain('clicked through')
  })

  it('student engagement: new-since-visit dogear and a "you are here" position outline', () => {
    const { annotations, emphasis } = triageStudent(course, {
      ...emptyStu, newSinceVisit: [{ title: 'Lecture 3' }], youAreHere: { title: 'Lecture 1' },
    })
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'mark', sub: 'dogear' })
    // youAreHere rides the emphasis channel (not an annotation), so it survives
    // even when another annotation wins the node.
    expect(emphasis).toContainEqual({ em: 'outline', tone: 'info', t: 'Lecture 1' })
  })

  it('"you are here" coexists with the annotation that wins its node (no dedup loss)', () => {
    const { annotations, emphasis } = triageStudent(course, {
      ...emptyStu, startHere: { title: 'Lecture 1' }, youAreHere: { title: 'Lecture 1' },
    })
    expect(at(annotations, 'Lecture 1')?.text).toContain('start')
    expect(emphasis).toContainEqual({ em: 'outline', tone: 'info', t: 'Lecture 1' })
  })

  it('reserves engagement slots so a busy map does not starve open counts', () => {
    // Flood every module with higher-priority stuck notes; without the reserve,
    // the ambient no-opens / insight open-spike would be pushed out entirely.
    const stuck = course.map((m) => ({ moduleTitle: m.title, struggling: 9, engaged: 10 }))
    const { annotations } = triageProfessor(course, {
      ...emptyProf, stuck,
      noOpens: [{ title: 'Lecture 2' }], openSpike: [{ title: 'Lecture 3', count: 7 }],
    })
    expect(at(annotations, 'Lecture 3')).toMatchObject({ v: 'tally' }) // open spike survived
    expect(annotations.some((a) => a.text === 'no one has opened this yet')).toBe(true)
  })

  it('emits in priority order even though the reserve picks out of order', () => {
    // The annotation layer places notes first-come-first-served against its
    // `placed` accumulator, so emit order decides who gets the clean margin slot.
    // The reserve claims its engagement slots in a pass of its own — the output
    // must still be loudest-first, not reserve-first.
    const { annotations } = triage(course, [
      { target: 'Lecture 1', shape: 'note', alertness: 'ambient', tone: 'slate', text: 'quiet', engagement: true },
      { target: 'Lecture 3', shape: 'note', alertness: 'insight', tone: 'warn', text: 'middle' },
      { target: 'Lecture 4', shape: 'flag', alertness: 'act-now', tone: 'alert', urgency: 1, text: 'loud' },
    ])
    expect(annotations.map((a) => a.text)).toEqual(['loud', 'middle', 'quiet'])
  })

  it('the engagement reserve never evicts an act-now signal from its module', () => {
    // The reserve spends from the SHARED per-module pool and maxEngagement equals
    // maxPerModule, so two ambient notes in one module could otherwise fill its
    // quota before the loudest tier is even considered.
    const { annotations } = triage(course, [
      { target: 'Lecture 3', shape: 'flag', alertness: 'act-now', tone: 'alert', urgency: 1, text: 'CRITICAL' },
      { target: 'Lecture 4', shape: 'note', alertness: 'ambient', tone: 'slate', text: 'eng-a', engagement: true },
      { target: 'Lecture 5', shape: 'note', alertness: 'ambient', tone: 'slate', text: 'eng-b', engagement: true },
    ])
    expect(annotations.map((a) => a.text)).toContain('CRITICAL')
  })
})

// ── Slice 4 — spoken claims + delivery depth (P14/P16/P22/P23/P24, S20–S23) ──
describe('spoken claims (slice 4)', () => {
  const withSession = [{ ...course[0], sessions: [{ t: 'Lecture 6 live', s: 'Ended', sched: false }] }, course[1]]
  const claim = (kind: 'commitment' | 'exam_scope' | 'emphasis' | 'off_deck', quote = 'I will push the deadline to Friday') => ({
    kind, sessionTitle: 'Lecture 6 live', summary: 'The deadline moved to Friday.', quote, slide: 12,
  })

  it('a commitment lands on the session node with the verbatim quote and slide anchor', () => {
    const prof = triageProfessor(withSession, { ...emptyProf, spokenClaims: [claim('commitment')] })
    const note = at(prof.annotations, 'session:Lecture 6 live')
    // this-week note voice: marching dots, warn — an unactioned promise, not an alarm
    expect(note).toMatchObject({ v: 'margin', sub: 'dots', tone: 'warn' })
    expect(note?.text).toContain('“I will push the deadline to Friday”')
    expect(note?.text).toContain('(slide 12)')

    const stu = triageStudent(withSession, { ...emptyStu, spokenClaims: [claim('commitment')] })
    const stuNote = at(stu.annotations, 'session:Lecture 6 live')
    // The student keeps the slide anchor too — they can't verify a clipped
    // promise from memory the way the professor can.
    expect(stuNote?.text).toBe('announced in class — “I will push the deadline to Friday” (slide 12)')
  })

  it('exam scope reaches the professor map but has no student twin (Athena answers U24)', () => {
    const prof = triageProfessor(withSession, { ...emptyProf, spokenClaims: [claim('exam_scope', 'everything through chapter 5')] })
    expect(at(prof.annotations, 'session:Lecture 6 live')?.text).toContain('“everything through chapter 5”')

    const stu = triageStudent(withSession, { ...emptyStu, spokenClaims: [claim('exam_scope', 'everything through chapter 5')] })
    expect(stu.annotations).toHaveLength(0)
  })

  it('an emphasis claim rides the node-emphasis channel on both audiences', () => {
    const prof = triageProfessor(withSession, { ...emptyProf, spokenClaims: [claim('emphasis', 'this will be on the exam')] })
    expect(prof.emphasis).toContainEqual({ em: 'outline', tone: 'info', t: 'session:Lecture 6 live' })

    const stu = triageStudent(withSession, { ...emptyStu, spokenClaims: [claim('emphasis', 'this will be on the exam')] })
    expect(stu.emphasis).toContainEqual({ em: 'outline', tone: 'warn', t: 'session:Lecture 6 live' })
    expect(at(stu.annotations, 'session:Lecture 6 live')?.text).toBe('stressed in class — “this will be on the exam”')
  })

  it('clips a long quote with an ellipsis instead of rewording it', () => {
    const long = 'so what I want you to remember about the attention mechanism is that the whole point of the softmax over the scores is to make the weights sum to one'
    const { annotations } = triageStudent(withSession, { ...emptyStu, spokenClaims: [claim('off_deck', long)] })
    const text = at(annotations, 'session:Lecture 6 live')?.text ?? ''
    expect(text).toContain('…”')
    expect(text).toContain(long.slice(0, 40)) // verbatim prefix, never paraphrased
    expect(text.length).toBeLessThan(long.length)
  })

  it('a claim whose session is not on the map is dropped, never re-homed', () => {
    const { annotations } = triageStudent(course, { ...emptyStu, spokenClaims: [claim('commitment')] })
    expect(annotations).toHaveLength(0)
  })

  it('delivery depth targets the deck card by item id, worded per audience', () => {
    const withDeck = [{ ...course[0], materials: [res('Transformers deck', { key: 'module_item:deck-1' })] }, course[1]]
    const depth = { target: 'item:deck-1', deepSlide: 9, deepMinutes: 12, skimmedSlide: 22, skimmedSeconds: 40 }

    const prof = triageProfessor(withDeck, { ...emptyProf, deliveryDepth: [depth] })
    expect(at(prof.annotations, 'item:deck-1')?.text).toBe('you spent <b>12 min</b> on slide 9 — slide 22 got 40 sec')

    const stu = triageStudent(withDeck, { ...emptyStu, deliveryDepth: [depth] })
    expect(at(stu.annotations, 'item:deck-1')?.text).toBe('class spent <b>12 min</b> on slide 9 — slide 22 got 40 sec')
  })
})
