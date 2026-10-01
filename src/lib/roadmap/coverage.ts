/**
 * Node coverage lifecycle — the derivation rules (Part II, slice 1).
 *
 * See docs/designs/roadmap-mastery/roadmap-engine.md §13. The old roadmap asks a professor to
 * tick every node by hand, which nobody keeps up to date, so its progress bars
 * are decoration. This derives the same three states from what the app already
 * records — a live class that ran, a deck that was advanced, an assessment that
 * closed — and stores nothing. Delete an item or unpublish a module and both
 * the numerator and the denominator correct themselves for free.
 *
 * Pure and dependency-free: every input is a plain value, so the whole ruleset
 * is unit-testable without a database. The queries live in coverage-signals.ts.
 */

import type { ModuleItemType } from '@/lib/validations/module'
import type {
  AutoRoadmapData,
  RoadmapEdge,
  RoadmapNodeStatus,
} from '@/lib/validations/auto-roadmap'

// ── What has a status at all ─────────────────────────────────────

/**
 * Item types the professor actually *delivers*, and which therefore carry a
 * status and count toward the delivery percentage (§11 decision 1).
 *
 * Everything else — video, image, reference, link — is supplementary material a
 * professor never "presents", so ticking it by hand is busywork and leaving it
 * not-started forever drags every percentage down. Those are stateless here and
 * get a student-side completion path instead (§14, slice 2). `note` and
 * `section_divider` were never content; `assignment` items are legacy (real
 * assignments arrive as resources, not module items).
 */
const STATEFUL_ITEM_TYPES = new Set<ModuleItemType>(['lecture'])

/** True when this item type carries a status dot and counts toward delivery. */
export function isStatefulItemType(t: ModuleItemType): boolean {
  return STATEFUL_ITEM_TYPES.has(t)
}

// ── Inputs ───────────────────────────────────────────────────────

/** One deck as presented by one room. A lecture shown across two classes has two. */
export interface DeckPresentation {
  /** Highest slide index ever reached, 0-based (lc_decks.max_slide). */
  maxSlide: number
  /** Total slides (lc_decks.page_count); null when the deck never finished rendering. */
  pageCount: number | null
  /** The presenting room's lifecycle. */
  roomStatus: 'scheduled' | 'live' | 'ended'
}

/** What live classes did in a module.
 *
 *  Only "has a class ENDED" is here. A `hasLiveClass` flag was collected and
 *  carried all the way to ModuleDelivery but no rule ever read it: a deck moves on
 *  slide advance (deriveLectureCoverage → deckCoverageOf), not on the room going
 *  live, and a non-slides reading rides on its module's class having *ended*. A
 *  mid-class deck already reports progress through its own covered/total fraction,
 *  so the flag had nothing left to decide. */
export interface ModuleRooms {
  hasEndedClass: boolean
}

/** A quiz's real lifecycle plus the engagement counts the status needs. */
export interface QuizActivity {
  status: string | null
  dueDate: string | null
  /** Distinct students with at least one attempt. */
  attemptCount: number
  /** Distinct students who submitted. */
  submittedCount: number
}

/** An assignment's real lifecycle plus its submission counts. */
export interface AssignmentActivity {
  status: string | null
  /** Distinct students with a non-draft submission. */
  submissionCount: number
  /** Distinct students whose submission is graded. */
  gradedCount: number
}

/**
 * Everything the derivation needs that isn't already on AutoRoadmapData.
 *
 * Plain arrays/records rather than Set/Map: this crosses a server-action
 * boundary, and only structured-cloneable values survive that trip.
 */
export interface CoverageSignals {
  /** Enrolled roster size — the denominator for "everyone has submitted". */
  enrolledCount: number
  /** modules.id marked coverage_state = 'skipped'. */
  skippedModules: string[]
  /** module_items.id → the decks presented from it, across every room. */
  decksByItem: Record<string, DeckPresentation[]>
  /** modules.id → what its live classes did. */
  roomsByModule: Record<string, ModuleRooms>
  /** quizzes.id → lifecycle + counts. */
  quizzes: Record<string, QuizActivity>
  /** assignments.id → lifecycle + counts. */
  assignments: Record<string, AssignmentActivity>
  /**
   * A read behind these signals FAILED or was truncated, so the numbers derived
   * from them are incomplete.
   *
   * This matters because "no data" and "we couldn't read the data" produce the
   * SAME shape here, and that shape derives as "nothing delivered, 0% covered" —
   * a confident wrong answer on the one number the page exists to report. Set it
   * and the surface can say the figures are partial instead of quietly
   * understating a professor's whole term.
   */
  degraded?: boolean
}

/** Rooms plus the assessment outcome — the full picture a lecture rides on. */
export interface ModuleDelivery extends ModuleRooms {
  /**
   * A quiz or assignment placed on this module has closed. The class has
   * demonstrably moved past the material — it assessed it (§13.2).
   */
  hasClosedAssessment: boolean
}

// ── Outputs ──────────────────────────────────────────────────────

/** Slides the class actually got through, for the "18 of 30" fraction. */
export interface DeckCoverage {
  covered: number
  total: number
}

export interface NodeCoverage {
  status: RoadmapNodeStatus
  /** Slide-deck lectures only — the honest fraction behind an in-progress deck. */
  coverage?: DeckCoverage
  /**
   * Published, open, and not one student has started it (§13.1). Today this is
   * indistinguishable from a quiz the whole class is working through; surfacing
   * it is signal P21. Kept separate from `status` so the map's three-state
   * visual vocabulary doesn't have to grow a fourth colour.
   *
   * **Professor-only.** It is a class aggregate ("nobody has started this"), so
   * it must never be rendered on a student's card — see resourceToCard.
   */
  openUntouched?: boolean
}

export interface ModuleCoverage {
  status: RoadmapNodeStatus
  /** Delivery percentage over this module's stateful children, 0–100. */
  pct: number
  /**
   * Excluded from both percentages (§13.3): the professor marked it skipped, or
   * it holds nothing derivable. An excluded module reads as neither delivered
   * nor undelivered — it simply isn't counted.
   */
  excluded: boolean
  /** True only for the professor's explicit skip, so the UI can say why. */
  skipped: boolean
  /**
   * The STUDENT's own coverage of this module, 0–100 — present only when
   * `computeCoverage` was given a student layer (§10, §11 decision 10).
   *
   * Same delivered nodes as `pct`, plus the extras this student completed, over
   * a denominator that also counts those extras. A student cannot reach 100%
   * before the professor has delivered the lectures, because an undelivered
   * lecture is never "done" for them either — that structural gate is the cap
   * decision 10 asks for, so no separate min() against `pct` is applied (one
   * would erase real work: four papers read in an untaught week would read 0%).
   */
  studentPct?: number
}

/** The per-student layer: what this one student has personally completed. */
export interface StudentCoverage {
  /**
   * RAW `module_items.id` of extras this student finished — a self check-off
   * today, plus passed node checks once slice 2b lands.
   *
   * Raw, NOT the `module_item:{id}` canvas key: that is the id the old
   * roadmap's check-off writes into `roadmap_progress.progress.nodeProgress`
   * (`RoadmapCanvasView` passes `n.ref.id`) and the id `journeyFromTopicAccuracy`
   * matches against. Prefixing here would make every existing tick invisible and
   * let the same node be ticked twice, once per surface.
   */
  completedExtras: ReadonlySet<string>
}

export interface CoverageResult {
  /** module_items.id → derived coverage. Stateless items are absent. */
  items: Map<string, NodeCoverage>
  /** quizzes.id / assignments.id → derived coverage. Live sessions are unchanged. */
  resources: Map<string, NodeCoverage>
  /** modules.id → roll-up. */
  modules: Map<string, ModuleCoverage>
  /**
   * module_items.id → this student completed it. Only the stateless extras
   * appear, and only when a student layer was supplied.
   */
  studentDone: Set<string>
  /** Carried through from CoverageSignals — see `CoverageSignals.degraded`. */
  degraded?: boolean
}

/**
 * Extras a student can personally complete: the stateless material types.
 * `note` and `section_divider` were never content, so they are not extras
 * either — nothing to go through, nothing to tick.
 */
export function isExtraItemType(t: ModuleItemType): boolean {
  return t === 'video' || t === 'image' || t === 'reference' || t === 'link'
}

// ── Placement ────────────────────────────────────────────────────

const RESOURCE_ENDPOINTS = new Set(['quiz', 'assignment', 'live_session'])

/**
 * resourceId → the module it was placed on, from the professor's placement
 * edges (module ↔ resource). Shared with the prototype adapter so both read
 * placement the same way.
 */
export function placementByResource(edges: readonly RoadmapEdge[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of edges) {
    const ends: [string, string][] = [
      [e.fromType, e.fromId],
      [e.toType, e.toId],
    ]
    const mod = ends.find(([t]) => t === 'module')
    const res = ends.find(([t]) => RESOURCE_ENDPOINTS.has(t))
    if (mod && res) out.set(res[1], mod[1])
  }
  return out
}

// ── Lectures ─────────────────────────────────────────────────────

/**
 * Slides covered across every room that presented this deck. A lecture split
 * over two classes accumulates, so take the furthest point reached anywhere.
 *
 * `maxSlide` is a 0-based index, so reaching index 17 means 18 slides were
 * shown. A room that never ran contributes nothing.
 */
function deckCoverageOf(presentations: readonly DeckPresentation[]): DeckCoverage | null {
  let covered = 0
  let total = 0

  for (const p of presentations) {
    if (p.roomStatus === 'scheduled') continue // never actually shown
    if (p.pageCount && p.pageCount > total) total = p.pageCount
    // Furthest point reached ANYWHERE, so a later review class that re-presents
    // slides 1–10 can't undo a class that already got to 30.
    const reached = p.maxSlide + 1
    if (reached > covered) covered = reached
  }

  // `total` can only be set by a presented room, so reaching here with total > 0
  // already implies at least one presentation.
  if (!total) return null // deck never rendered — no honest fraction to show
  return { covered: Math.min(covered, total), total }
}

/**
 * A lecture's status (§13.1).
 *
 * A slide deck waits for the live class that presents it. Any other lecture —
 * an uploaded reading — is never "presented", so requiring a room link would
 * leave it incomplete forever; it rides on its module's class instead
 * (§11 decision 5).
 */
export function deriveLectureCoverage(
  useAsSlides: boolean,
  presentations: readonly DeckPresentation[],
  delivery: ModuleDelivery | undefined,
): NodeCoverage {
  const assessed = delivery?.hasClosedAssessment ?? false

  if (!useAsSlides) {
    const delivered = assessed || (delivery?.hasEndedClass ?? false)
    return { status: delivered ? 'complete' : 'not_started' }
  }

  const coverage = deckCoverageOf(presentations) ?? undefined

  // The module's assessment closing marks the deck fully covered regardless of
  // slide position — the class has moved past the material (§13.2).
  if (assessed) {
    return {
      status: 'complete',
      coverage: coverage && { covered: coverage.total, total: coverage.total },
    }
  }

  const everPresented = presentations.some((p) => p.roomStatus !== 'scheduled')
  if (!everPresented) return { status: 'not_started', coverage }

  // Full coverage only at the last slide. 28 of 30 stays in progress and shows
  // the fraction — the honest answer, and why we don't invent a 90% threshold.
  const finished = !!coverage && coverage.covered >= coverage.total
  return { status: finished ? 'complete' : 'in_progress', coverage }
}

// ── Assessments ──────────────────────────────────────────────────

/**
 * A quiz's status (§13.1). Replaces the old "published → in progress forever"
 * reading with one that accounts for who actually took it.
 */
export function deriveQuizCoverage(q: QuizActivity, enrolledCount: number): NodeCoverage {
  if ((q.status || '').toLowerCase() !== 'published') return { status: 'not_started' }

  // Past its due date nobody can submit any more, so the quiz is done.
  if (q.dueDate && new Date(q.dueDate).getTime() < Date.now()) return { status: 'complete' }
  if (enrolledCount > 0 && q.submittedCount >= enrolledCount) return { status: 'complete' }

  // Published and open, but not one student has begun (P21).
  if (q.attemptCount === 0) return { status: 'not_started', openUntouched: true }

  return { status: 'in_progress' }
}

/**
 * An assignment's status (§13.1). Today `published` reads in-progress forever
 * because nothing ever flips it; grading the roster now completes it.
 */
export function deriveAssignmentCoverage(
  a: AssignmentActivity,
  enrolledCount: number,
): NodeCoverage {
  const s = (a.status || '').toLowerCase()
  if (s === 'closed' || s === 'archived') return { status: 'complete' }
  if (s !== 'published') return { status: 'not_started' }

  if (enrolledCount > 0 && a.gradedCount >= enrolledCount) return { status: 'complete' }
  if (a.submissionCount === 0) return { status: 'not_started', openUntouched: true }

  return { status: 'in_progress' }
}

// ── Module roll-up ───────────────────────────────────────────────

/**
 * Roll a module up from its children (§13.1). Pure count — no stored row.
 *
 * `childStatuses` must already be filtered to *stateful* children; a module of
 * nothing but reference links has none, which excludes it rather than letting
 * it read 0% forever.
 */
export function deriveModuleCoverage(
  moduleId: string,
  childStatuses: readonly RoadmapNodeStatus[],
  skippedModules: ReadonlySet<string>,
  /** Extras in this module: how many this student finished, out of how many. */
  extras?: { done: number; total: number },
  /**
   * Fractional credit in (0,1) for children that are part-way through and expose
   * an honest fraction — today only a slide deck, which contributes covered/total
   * (6 of 30 → 0.2) instead of nothing. Without this a week whose only lecture is
   * mid-delivery reads a flat 0%, which looks untouched while the class is
   * literally running.
   *
   * Never pushes the module to 100%: the cap below keeps a module with any
   * unfinished child at 99% at most, so "100%" continues to mean every child is
   * complete.
   */
  partialCredit?: readonly number[],
): ModuleCoverage {
  // Both excluded cases report a neutral, un-started roll-up rather than a
  // flattering 100%: a consumer that forgets to check `excluded` then shows a
  // grey "not covering" module, not a fake green one.
  if (skippedModules.has(moduleId)) {
    return { status: 'not_started', pct: 0, excluded: true, skipped: true }
  }
  // A module of nothing but extras still has something for the STUDENT to do,
  // so it is only excluded when there is nothing on either side.
  if (childStatuses.length === 0 && !extras?.total) {
    return { status: 'not_started', pct: 0, excluded: true, skipped: false }
  }

  const done = childStatuses.filter((s) => s === 'complete').length
  const started = childStatuses.filter((s) => s !== 'not_started').length

  const status: RoadmapNodeStatus =
    childStatuses.length === 0
      ? 'not_started'
      : done === childStatuses.length
        ? 'complete'
        : started === 0
          ? 'not_started'
          : 'in_progress'

  /* Credit earned so far: finished children count 1 each, part-way ones their own
     fraction. Summed defensively — a caller passing a fraction outside (0,1) (or
     more fractions than there are children) must not be able to inflate the
     percentage past what the children can actually earn. */
  const partial = (partialCredit ?? []).reduce(
    (sum, f) => sum + (Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0),
    0,
  )
  const credit = Math.min(done + partial, childStatuses.length)

  /* Round, then hold back the last point unless every child is genuinely
     complete: a deck at 29/30 must not let the module claim 100% and read as
     finished when it isn't. */
  const pctOf = (earned: number, total: number, allDone: boolean): number => {
    if (!total) return 0
    const raw = Math.round((100 * earned) / total)
    return allDone ? raw : Math.min(raw, 99)
  }

  const out: ModuleCoverage = {
    status,
    // Delivery ignores extras entirely — a professor never delivers them.
    pct: pctOf(credit, childStatuses.length, done === childStatuses.length),
    // Excluded from DELIVERY when the professor has nothing to deliver here,
    // even though the student may still have extras to work through.
    excluded: childStatuses.length === 0,
    skipped: false,
  }

  if (extras) {
    const total = childStatuses.length + extras.total
    // `total` is always > 0 here: the zero-on-both-sides case returned above.
    out.studentPct = pctOf(
      credit + extras.done,
      total,
      done === childStatuses.length && extras.done === extras.total,
    )
  }
  return out
}

// ── Orchestration ────────────────────────────────────────────────

/**
 * Derive coverage for every node on the map.
 *
 * Order matters: assessments resolve first because a *closed* one marks its
 * module's lectures delivered (§13.2), which in turn feeds the module roll-up.
 */
export function computeCoverage(
  data: AutoRoadmapData,
  signals: CoverageSignals,
  student?: StudentCoverage,
): CoverageResult {
  const { enrolledCount, decksByItem, roomsByModule } = signals
  const skippedModules = new Set(signals.skippedModules)

  // 1. Assessments — independent of everything else on the map.
  const resources = new Map<string, NodeCoverage>()
  for (const r of data.resources) {
    if (r.kind === 'quiz') {
      const q = signals.quizzes[r.id]
      // No activity row (e.g. an RLS-blocked read) → fall back to the status the
      // assembler already derived, rather than inventing a wrong one.
      if (q) resources.set(r.id, deriveQuizCoverage(q, enrolledCount))
    } else if (r.kind === 'assignment') {
      const a = signals.assignments[r.id]
      if (a) resources.set(r.id, deriveAssignmentCoverage(a, enrolledCount))
    }
    // live_session keeps its room lifecycle status — already correct (§13.1).
  }

  // 2. Which modules had an assessment close.
  const placement = placementByResource(data.edges)
  const closedAssessmentModules = new Set<string>()
  for (const r of data.resources) {
    if (r.kind !== 'quiz' && r.kind !== 'assignment') continue
    const status = resources.get(r.id)?.status ?? r.status
    if (status !== 'complete') continue
    const moduleId = placement.get(r.id)
    if (moduleId) closedAssessmentModules.add(moduleId)
  }

  const deliveryOf = (moduleId: string): ModuleDelivery => ({
    hasEndedClass: roomsByModule[moduleId]?.hasEndedClass ?? false,
    hasClosedAssessment: closedAssessmentModules.has(moduleId),
  })

  // 3. Lectures, then the module roll-up over every stateful child.
  const items = new Map<string, NodeCoverage>()
  const modules = new Map<string, ModuleCoverage>()
  const studentDone = new Set<string>()

  for (const w of data.weeks) {
    const delivery = deliveryOf(w.id)
    const childStatuses: RoadmapNodeStatus[] = []
    /* Part-way children's own fractions, so a mid-delivery week reports the
       progress it has actually made instead of a flat 0%. Only a deck can supply
       one — every other child is binary. */
    const partialCredit: number[] = []
    let extrasTotal = 0
    let extrasDone = 0

    for (const it of w.items) {
      if (isStatefulItemType(it.itemType)) {
        const cov = deriveLectureCoverage(!!it.useAsSlides, decksByItem[it.id] ?? [], delivery)
        items.set(it.id, cov)
        childStatuses.push(cov.status)
        if (cov.status === 'in_progress' && cov.coverage && cov.coverage.total > 0) {
          partialCredit.push(cov.coverage.covered / cov.coverage.total)
        }
        continue
      }
      // Extras only exist for a student — the professor never delivers them.
      if (!student || !isExtraItemType(it.itemType)) continue
      extrasTotal++
      if (student.completedExtras.has(it.id)) {
        extrasDone++
        studentDone.add(it.id)
      }
    }

    for (const r of data.resources) {
      if (placement.get(r.id) !== w.id) continue
      childStatuses.push(resources.get(r.id)?.status ?? r.status)
    }

    modules.set(
      w.id,
      deriveModuleCoverage(
        w.id,
        childStatuses,
        skippedModules,
        student ? { done: extrasDone, total: extrasTotal } : undefined,
        partialCredit,
      ),
    )
  }

  /* Pass the signal-layer's degraded flag straight through: the derivation is
     pure, so it cannot tell a partial read from a quiet course, and only the
     surface can say so. */
  return { items, resources, modules, studentDone, degraded: signals.degraded }
}
