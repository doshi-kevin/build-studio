/**
 * roadmap-signals — assembles the triage engine's ProfSignals / StuSignals from
 * (a) data the roadmap page already fetched (course, roadmap DTO, journeys,
 * mastery) and (b) a couple of cheap deadline/submission queries. Server-side
 * (touches the DB via the passed client); the ranking itself stays pure in
 * triage.ts. Everything degrades to empty on missing data — a signal that can't
 * be built just isn't shown.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'
import type { CourseModule } from './prototype-adapter'
import { SESSION_SOON_H } from './triage'
import type { ProfSignals, StuSignals, DueItem, EdgeSignal, SpokenClaim, DeliveryDepthSignal } from './triage'
import { computeWeekStruggle, type NodeJourney } from './journey-state'
import { masteryTier } from '@/lib/skills/mastery'
import { roadmapSignalQueries } from '@/lib/supabase/queries'
import { isExtraItemType, placementByResource, type CoverageResult } from './coverage'

const WEEK_MS = 7 * 24 * 3600 * 1000
/* Endpoint types that make an edge module-level, so it is skipped when building
   content-to-content cross-refs. 'manual_module' / 'manual_lecture' are gone with
   the manual-canvas retirement: their tables were dropped, so those ids resolve
   to no title and the `from && to` check below discards such an edge regardless.
   The DB's endpoint-type CHECK still permits the words for any legacy row. */
const MODULE_ENDPOINTS = new Set(['module'])

/** node id → title, across weeks/items/resources — for turning edge endpoints into targets. */
function idTitleMap(data: AutoRoadmapData): Map<string, string> {
  const m = new Map<string, string>()
  for (const w of data.weeks) {
    m.set(w.id, w.title)
    for (const it of w.items) m.set(it.id, it.title)
  }
  for (const r of data.resources) m.set(r.id, r.title)
  return m
}

/** Semantic content↔content edges (drop the module↔resource placement edges). */
function edgeSignals(data: AutoRoadmapData): EdgeSignal[] {
  const title = idTitleMap(data)
  const out: EdgeSignal[] = []
  for (const e of data.edges) {
    if (MODULE_ENDPOINTS.has(e.fromType) || MODULE_ENDPOINTS.has(e.toType)) continue
    const from = title.get(e.fromId)
    const to = title.get(e.toId)
    if (from && to) out.push({ from, to, kind: e.edgeType ?? 'prerequisite' })
  }
  return out
}

const hoursUntil = (iso: string | null, now: number): number | null =>
  iso ? (new Date(iso).getTime() - now) / 3_600_000 : null


// ── Part II coverage signals (Appendix B P18–P21 / S15–S18) ──────
//
// The coverage engine already derived all of this; these turn it into the
// annotation vocabulary. Titles come from the roadmap DTO because CoverageResult
// is keyed by id and the annotation layer targets nodes by title.

interface CoverageTitles {
  item: Map<string, string>
  module: Map<string, string>
  resource: Map<string, string>
}

function coverageTitles(data: AutoRoadmapData): CoverageTitles {
  const item = new Map<string, string>()
  const module_ = new Map<string, string>()
  for (const w of data.weeks) {
    module_.set(w.id, w.title)
    for (const it of w.items) item.set(it.id, it.title)
  }
  const resource = new Map(data.resources.map((r) => [r.id, r.title]))
  return { item, module: module_, resource }
}

/**
 * P19 — "this week never got a class", at most once, on the week it is about.
 *
 * Every module past the class's current position is un-delivered, so the naive
 * "not started and not skipped" rule fired on all of them at once (and on the
 * front-matter module too — a syllabus/handout band is never taught in a class).
 * Weeks the class simply hasn't reached yet aren't late; only the *next* one is,
 * and only if nothing is on the books for it:
 *
 *  1. Find the frontier — the last module the class has actually started. Before
 *     it there is nothing to warn about (a course-info band sits there); with no
 *     frontier at all the term hasn't started and nothing is behind yet.
 *  2. Walk forward from there and take the first module with no class scheduled
 *     or running. A booked class means the week is planned, so it is skipped over
 *     rather than ending the walk.
 */
function neverDeliveredSignal(
  data: AutoRoadmapData,
  coverage: CoverageResult,
  t: CoverageTitles,
): ProfSignals['neverDelivered'] {
  /* Modules with a live class either running or still ahead on the calendar. A
     room whose slot has already passed without being started does NOT count: only
     'live' rooms get culled (`lc_auto_end_stale_rooms`), so a class that was booked
     and never held stays 'scheduled' for ever — and treating that as planned would
     silence the warning on exactly the week it exists for. */
  const planned = new Set<string>()
  const placement = placementByResource(data.edges)
  const now = Date.now()
  for (const r of data.resources) {
    if (r.kind !== 'live_session' || r.status === 'complete') continue
    const startsAt = r.scheduledAt ? new Date(r.scheduledAt).getTime() : null
    if (startsAt != null && startsAt < now) continue // booked, never held
    const moduleId = placement.get(r.id)
    if (moduleId) planned.add(moduleId)
  }

  const live = data.weeks.filter((w) => {
    const mod = coverage.modules.get(w.id)
    return mod && !mod.excluded && !mod.skipped
  })
  let frontier = -1
  live.forEach((w, i) => {
    if (coverage.modules.get(w.id)?.status !== 'not_started') frontier = i
  })
  if (frontier < 0) return [] // the class hasn't started teaching anything

  for (const w of live.slice(frontier + 1)) {
    if (planned.has(w.id)) continue
    const title = t.module.get(w.id)
    return title ? [{ title }] : []
  }
  return []
}

/** P18/P21/P19 — what the professor should know about their own delivery. */
export function professorCoverageSignals(
  data: AutoRoadmapData,
  coverage: CoverageResult | null | undefined,
): Pick<ProfSignals, 'deckGap' | 'neverDelivered' | 'openUntouched'> {
  const empty = { deckGap: [], neverDelivered: [], openUntouched: [] }
  if (!coverage) return empty
  const t = coverageTitles(data)

  const deckGap: ProfSignals['deckGap'] = []
  for (const [id, cov] of coverage.items) {
    // Only a part-covered deck has a gap worth naming; a finished one has none
    // and an unstarted one is a different signal (never delivered).
    if (cov.status !== 'in_progress' || !cov.coverage) continue
    const title = t.item.get(id)
    if (title) deckGap.push({ title, covered: cov.coverage.covered, total: cov.coverage.total })
  }

  const neverDelivered: ProfSignals['neverDelivered'] = neverDeliveredSignal(data, coverage, t)

  const openUntouched: ProfSignals['openUntouched'] = []
  for (const [id, cov] of coverage.resources) {
    if (!cov.openUntouched) continue
    const title = t.resource.get(id)
    if (title) openUntouched.push({ title })
  }

  return { deckGap, neverDelivered, openUntouched }
}

/** S15/S16/S17/S18 — the same derivation, read back to the student. */
export function studentCoverageSignals(
  data: AutoRoadmapData,
  coverage: CoverageResult | null | undefined,
): Pick<StuSignals, 'selfStudyRemainder' | 'checkAvailable' | 'coverageVsDelivery'> {
  const empty = { selfStudyRemainder: [] }
  if (!coverage) return empty
  const t = coverageTitles(data)

  const selfStudyRemainder: StuSignals['selfStudyRemainder'] = []
  for (const [id, cov] of coverage.items) {
    if (cov.status !== 'in_progress' || !cov.coverage) continue
    const title = t.item.get(id)
    if (title) selfStudyRemainder.push({ title, covered: cov.coverage.covered, total: cov.coverage.total })
  }

  // S16 — the nudge points at the FIRST extra they haven't done, once for the
  // whole map: one is a prompt, one per extra would be a to-do list nobody reads.
  // (There is deliberately no per-module "N of M extras done" tally: extras are
  // optional, and a count of them reads as a chore you're behind on.)
  let checkAvailable: StuSignals['checkAvailable']
  for (const w of data.weeks) {
    if (checkAvailable) break
    if (coverage.modules.get(w.id)?.skipped) continue
    const next = w.items.find((it) => isExtraItemType(it.itemType) && !coverage.studentDone.has(it.id))
    if (next) checkAvailable = { title: next.title }
  }

  // S18 — how far through what has actually been TAUGHT. Pooled over modules so
  // one big week counts more than one small one, and anchored on the first
  // module the student hasn't finished (a course-level fact needs a home node).
  let studentDone = 0
  let deliveredTotal = 0
  let anchor: string | undefined
  for (const w of data.weeks) {
    const mod = coverage.modules.get(w.id)
    if (!mod || mod.excluded || mod.skipped || mod.studentPct === undefined) continue
    deliveredTotal += mod.pct
    studentDone += Math.min(mod.studentPct, mod.pct)
    if (!anchor && mod.studentPct < 100) anchor = w.title
  }
  const coverageVsDelivery =
    anchor && deliveredTotal > 0
      ? { title: anchor, pct: Math.round((100 * studentDone) / deliveredTotal) }
      : undefined

  return { selfStudyRemainder, checkAvailable, coverageVsDelivery }
}

// ── Professor ────────────────────────────────────────────────────
export interface ProfSignalContext {
  course: CourseModule[]
  roadmapData: AutoRoadmapData
  journeys: { weeks: { title: string; nodeKeys: string[] }[]; students: { nodes: Record<string, NodeJourney> }[] } | null
  concepts: { view?: { weakest?: { skillId: string; classScore: number | null } | null }; sources?: Record<string, { title: string }[]> } | null
  /** Slice-2 admin-read aggregates (from getProfessorAggregates). */
  itemQuality?: { quizTitle: string; questionLabel: string }[]
  bookingRecent?: number
  /** Slice-3 admin-read aggregates (from getProfessorAggregates). masteryTrend is
   *  keyed by skill_id — resolved to an assessing node here via concepts.sources. */
  masteryTrend?: { skillId: string; from: number; to: number }[]
  noOpens?: { title: string }[]
  openSpike?: { title: string; count: number }[]
  reDownloads?: { title: string; students: number }[]
  revisits?: { title: string; students: number }[]
  clickThroughs?: { title: string; students: number }[]
  /** The section's quizzes with their deadline + unfinished-attempt count. Also an
   *  admin read (from getProfessorAggregates): every quiz table is RLS-deny-all,
   *  so the section-scoped client `getProfessorActivitySignals` uses sees none. */
  quizActivity?: { title: string; status: string; dueDate: string | null; inProgress: number }[]
  /** Part II — the derived coverage, source of P18/P19/P21. */
  coverage?: CoverageResult | null
  /** P20 · extras no student has completed (an admin read; see getProfessorAggregates). */
  extrasCold?: { title: string }[]
  /** Slice 4 · quote-anchored spoken claims + delivery depth (an admin read via
   *  getTranscriptSignals, audience 'professor'; see getProfessorAggregates). */
  spokenClaims?: SpokenClaim[]
  deliveryDepth?: DeliveryDepthSignal[]
}

const BOOKING_SPIKE = 3 // recent bookings that count as a "spike"


/** The first scheduled session on the map — where a class-wide "add a review
 *  session?" nudge best attaches (bookings carry no topic/node of their own). */
function firstScheduledSession(course: CourseModule[]): string | undefined {
  for (const m of course) for (const s of m.sessions ?? []) if (s.sched) return s.t
  return undefined
}

export async function buildProfessorSignals(
  supabase: SupabaseClient,
  sectionId: string,
  ctx: ProfSignalContext,
): Promise<ProfSignals> {
  const now = Date.now()
  const activity = await roadmapSignalQueries.getProfessorActivitySignals(supabase, sectionId)

  const gradingQueue: ProfSignals['gradingQueue'] = []
  const allGraded: ProfSignals['allGraded'] = []
  const missing: ProfSignals['missing'] = []
  const draftsUnsubmitted: ProfSignals['draftsUnsubmitted'] = []
  const dueSoon: DueItem[] = []

  for (const a of activity.assignments) {
    const t = activity.tallies[a.id] ?? { draft: 0, submitted: 0, graded: 0, returned: 0, handedIn: 0 }
    if (t.submitted > 0) gradingQueue.push({ title: a.title, awaiting: t.submitted })
    else if (t.graded > 0) allGraded.push({ title: a.title })
    if (t.draft > 0) draftsUnsubmitted.push({ title: a.title, count: t.draft })

    const h = hoursUntil(a.dueAt, now)
    if (a.status !== 'published' || h == null) continue
    if (h > 0 && h <= WEEK_MS / 3_600_000) dueSoon.push({ title: a.title, kind: 'assignment', hoursLeft: h })
    else if (h <= 0 && activity.enrolled > 0) {
      /* Anyone on the roster without a submission timestamp never handed work in.
         Counting statuses instead reports zero forever: the auto-zero cron gives
         every non-submitter a `graded` row within 15 minutes of the deadline (see
         `AssignmentSubmissionTally.handedIn`).

         Draft-holders come out because P7 already names them ("N started, not
         turned in") — two overlapping headcounts on one card get added together by
         anyone reading fast, which claims a class in more trouble than it is. So
         the two notes are disjoint: this one is the people with nothing at all. */
      const count = activity.enrolled - t.handedIn - t.draft
      if (count > 0) missing.push({ title: a.title, count })
    }
  }
  for (const q of ctx.quizActivity ?? []) {
    // A quiz attempt left 'in_progress' is the quiz twin of a draft submission.
    if (q.inProgress > 0) draftsUnsubmitted.push({ title: q.title, count: q.inProgress })

    const h = hoursUntil(q.dueDate, now)
    if (q.status === 'published' && h != null && h > 0 && h <= WEEK_MS / 3_600_000) {
      dueSoon.push({ title: q.title, kind: 'quiz', hoursLeft: h })
    }
  }

  /* P12 — a live class close enough to plan around. Every scheduled room already
     draws its own calendar tile, so only an imminent one earns a callout: a room
     three days out is a date, not a nudge. The window stays inside the same day so
     the engine's deliberately vague wording ("class in 3 hours") can't be wrong
     about which day it means — see the note in `triage.ts`. */
  const sessionSoon: ProfSignals['sessionSoon'] = []
  for (const r of ctx.roadmapData.resources) {
    if (r.kind !== 'live_session' || !r.scheduledAt) continue
    const h = hoursUntil(r.scheduledAt, now)
    if (h != null && h > 0 && h <= SESSION_SOON_H) sessionSoon.push({ title: r.title, hoursUntil: h })
  }
  sessionSoon.sort((a, b) => a.hoursUntil - b.hoursUntil)

  /* Unpublished drafts still on the map (draft resources surface as stateLabel
     'Draft'), oldest first and carrying their age in days. A draft written this
     week is a work in progress; one that has sat since June is a decision the
     professor never came back to, and the two deserve different wording — so the
     stale ones must also be the ones that survive the clutter budget. */
  const unpublishedDrafts = ctx.roadmapData.resources
    .filter((r) => r.stateLabel === 'Draft')
    .map((r) => ({
      title: r.title,
      createdAt: r.createdAt ?? null,
      ageDays: r.createdAt ? Math.floor((now - new Date(r.createdAt).getTime()) / 86_400_000) : 0,
    }))
    .sort((a, b) => b.ageDays - a.ageDays)

  /* Material a professor saved but never shared. `hiddenFromStudents` is only set
     on the professor's own loader, so this is empty on any other path. */
  const unsharedUploads = ctx.roadmapData.weeks
    .flatMap((w) => w.items)
    .filter((it) => it.hiddenFromStudents && it.title)
    .map((it) => ({ title: it.title }))

  // Per-module struggle, from the already-fetched student journeys.
  const stuck: ProfSignals['stuck'] = []
  if (ctx.journeys) {
    const studentNodes = ctx.journeys.students.map((s) => s.nodes)
    for (const w of ctx.journeys.weeks) {
      // Head counts, not pooled (student × node) pairs — "N of M stuck here" is
      // read as people, so M must never exceed the class size.
      const s = computeWeekStruggle(w.nodeKeys, studentNodes).students
      if (s.engaged > 0) stuck.push({ moduleTitle: w.title, struggling: s.struggling, engaged: s.engaged })
    }
  }

  // The single weakest class skill, mapped onto an assessing node.
  let weakestSkill: ProfSignals['weakestSkill']
  const wk = ctx.concepts?.view?.weakest
  if (wk && wk.classScore != null && wk.classScore < 70) {
    const src = ctx.concepts?.sources?.[wk.skillId]?.[0]
    if (src) weakestSkill = { classScore: Math.round(wk.classScore), targetTitle: src.title }
  }

  // Booking spike → attach to a scheduled session if the map has one.
  let bookingDemand: ProfSignals['bookingDemand']
  const spikeTarget = firstScheduledSession(ctx.course)
  if ((ctx.bookingRecent ?? 0) >= BOOKING_SPIKE && spikeTarget) {
    bookingDemand = { targetTitle: `session:${spikeTarget}`, recent: ctx.bookingRecent as number }
  }

  // Resolve each declining skill onto an assessing node (same sources map weakestSkill uses).
  const masteryTrend: ProfSignals['masteryTrend'] = []
  for (const t of ctx.masteryTrend ?? []) {
    const src = ctx.concepts?.sources?.[t.skillId]?.[0]
    if (src) masteryTrend.push({ targetTitle: src.title, from: t.from, to: t.to })
  }

  return {
    stuck, gradingQueue, allGraded, missing, draftsUnsubmitted, unpublishedDrafts, unsharedUploads, dueSoon,
    sessionSoon,
    weakestSkill, itemQuality: ctx.itemQuality ?? [], bookingDemand,
    masteryTrend, noOpens: ctx.noOpens ?? [], openSpike: ctx.openSpike ?? [], reDownloads: ctx.reDownloads ?? [],
    revisits: ctx.revisits ?? [], clickThroughs: ctx.clickThroughs ?? [],
    edges: edgeSignals(ctx.roadmapData),
    ...professorCoverageSignals(ctx.roadmapData, ctx.coverage),
    extrasCold: ctx.extrasCold ?? [],
    spokenClaims: ctx.spokenClaims ?? [],
    deliveryDepth: ctx.deliveryDepth ?? [],
  }
}

// ── Student ──────────────────────────────────────────────────────
/** The student's own activity, fetched by the enrollment-verified admin action
 *  getStudentActivity (quiz tables are RLS-deny-all, so the read can't run on
 *  the request client). Carries completion + due dates only, never scores. */
export interface StudentActivity {
  assignments: Array<{ title: string; dueAt: string | null; mySubmission: string | null }>
  quizzes: Array<{ title: string; dueDate: string | null; completed: boolean }>
}
export interface StuSignalContext {
  course: CourseModule[]
  roadmapData: AutoRoadmapData
  concepts: { concepts: Record<string, { score: number | null; assessedBy: { title: string }[] }> } | null
  /** Part II — the derived coverage incl. this student's layer (S15–S18). */
  coverage?: CoverageResult | null
  /** S19 — the course path Athena's `?athena-topic=` deep link hangs off, when the
   *  feature is on. Makes the weak-skill note's "study it with Athena" a live link
   *  (same destination as the node modal's). Omitted → the note still names the
   *  skill, just isn't clickable. */
  aiTutorHref?: string
}
/** Slice-2 admin-read aggregates for the student (from getStudentAggregates),
 *  already signal-shaped — the arithmetic ran server-side via aggregates.ts. */
export interface StudentAggregates {
  noImprovement: StuSignals['noImprovement']
  slowWrong: StuSignals['slowWrong']
  absenceGap: StuSignals['absenceGap']
  /** Slice-3 (optional so callers can adopt incrementally). masteryTrend is keyed
   *  by skill NAME — resolved to an assessing node here via ctx.concepts. */
  masteryTrend?: { skillName: string; from: number; to: number }[]
  newSinceVisit?: StuSignals['newSinceVisit']
  youAreHere?: StuSignals['youAreHere']
  /** Slice 4 · spoken claims + delivery depth (getTranscriptSignals, audience
   *  'student' — the reader drops rooms whose replay toggle is off, G14). */
  spokenClaims?: SpokenClaim[]
  deliveryDepth?: DeliveryDepthSignal[]
}
const EMPTY_AGGREGATES: StudentAggregates = { noImprovement: [], slowWrong: [], absenceGap: [] }

/** Pure: turns the fetched activity + page data into student signals. */
export function buildStudentSignals(
  activity: StudentActivity,
  ctx: StuSignalContext,
  aggregates: StudentAggregates = EMPTY_AGGREGATES,
): StuSignals {
  const now = Date.now()

  const dueSoon: DueItem[] = []
  const gradePosted: StuSignals['gradePosted'] = []
  const turnedIn = new Set(['submitted', 'graded', 'returned'])
  for (const a of activity.assignments) {
    if (a.mySubmission === 'graded') gradePosted.push({ title: a.title })
    const h = hoursUntil(a.dueAt, now)
    if (!turnedIn.has(a.mySubmission ?? '') && h != null && h > 0 && h <= WEEK_MS / 3_600_000) {
      dueSoon.push({ title: a.title, kind: 'assignment', hoursLeft: h })
    }
  }
  for (const q of activity.quizzes) {
    if (q.completed) { gradePosted.push({ title: q.title }); continue }
    const h = hoursUntil(q.dueDate, now)
    if (h != null && h > 0 && h <= WEEK_MS / 3_600_000) dueSoon.push({ title: q.title, kind: 'quiz', hoursLeft: h })
  }

  // Own mastery, mapped onto the activity that assesses each skill. Also build a
  // name→assessing-node map (concept keys are already normalised) for the trend.
  const highs: { title: string; pct: number }[] = []
  const lows: { title: string; pct: number }[] = []
  const titleBySkillName = new Map<string, string>()
  for (const [key, c] of Object.entries(ctx.concepts?.concepts ?? {})) {
    if (!c.assessedBy?.length) continue
    titleBySkillName.set(key, c.assessedBy[0].title)
    if (c.score == null) continue
    const tier = masteryTier(c.score)
    if (tier === 'strong') highs.push({ title: c.assessedBy[0].title, pct: Math.round(c.score) })
    else if (tier === 'weak') lows.push({ title: c.assessedBy[0].title, pct: Math.round(c.score) })
  }
  highs.sort((a, b) => b.pct - a.pct)
  lows.sort((a, b) => a.pct - b.pct)

  // Resolve each own-mastery trend skill onto its assessing node.
  const masteryTrend: StuSignals['masteryTrend'] = []
  for (const t of aggregates.masteryTrend ?? []) {
    const title = titleBySkillName.get(t.skillName.trim().toLowerCase())
    if (title) masteryTrend.push({ targetTitle: title, from: t.from, to: t.to })
  }

  // S19 — the student's single weakest skill, placed on the material that TEACHES
  // it (masteryLow already covers the activity that ASSESSES it). One only: this
  // is a pointer to the next thing to do, and a map full of them is a map of
  // nowhere to start. The node modal carries the actual AI-Tutor link.
  let studyWithTutor: StuSignals['studyWithTutor']
  const scoreOf = (skill: string) => ctx.concepts?.concepts?.[skill.trim().toLowerCase()]?.score ?? null

  // Long readings + the next node to start (both from the rendered course).
  const longReads: StuSignals['longReads'] = []
  let startHere: StuSignals['startHere']
  for (const m of ctx.course) {
    if (m.draft) continue
    for (const r of m.materials) {
      for (const [skill] of r.skills ?? []) {
        const score = scoreOf(skill)
        if (score == null || masteryTier(score) !== 'weak') continue
        if (!studyWithTutor || score < studyWithTutor.pct) {
          studyWithTutor = {
            targetTitle: r.t, key: r.key, topic: skill, pct: Math.round(score),
            tutorHref: ctx.aiTutorHref ? `${ctx.aiTutorHref}?athena-topic=${encodeURIComponent(skill)}` : undefined,
          }
        }
      }
      // "start early" is a nudge for a big reading still ahead — skip finished
      // readings (and finished modules) so done nodes don't carry the note.
      if (r.k === 'lecture' && r.st !== 'done' && m.phase !== 'done' && (r.pages ?? 0) >= 40) {
        longReads.push({ title: r.t, key: r.key, pages: r.pages ?? 0 })
      }
      if (!startHere && m.phase !== 'done' && r.st !== 'done') startHere = { title: r.t, key: r.key }
    }
  }

  return {
    dueSoon, gradePosted, masteryHigh: highs.slice(0, 3), masteryLow: lows.slice(0, 3),
    studyWithTutor, longReads, startHere,
    noImprovement: aggregates.noImprovement, absenceGap: aggregates.absenceGap, slowWrong: aggregates.slowWrong,
    masteryTrend, newSinceVisit: aggregates.newSinceVisit ?? [], youAreHere: aggregates.youAreHere,
    edges: edgeSignals(ctx.roadmapData),
    ...studentCoverageSignals(ctx.roadmapData, ctx.coverage),
    spokenClaims: aggregates.spokenClaims ?? [],
    deliveryDepth: aggregates.deliveryDepth ?? [],
  }
}
