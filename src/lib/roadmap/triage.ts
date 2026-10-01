/**
 * roadmap triage engine — turns raw LMS signals into the few most important
 * annotations + node-emphasis the roadmap should show, and picks the right
 * visual voice for each. Pure: no DB, no React, no I/O. The two roadmap pages
 * gather signals server-side and call triageProfessor / triageStudent; the
 * output replaces the hardcoded DEMO_ANNOTATIONS / DEMO_EMPHASIS.
 *
 * Design: docs/designs/roadmap-mastery/roadmap-engine.md §4 (the grammar + budget).
 * Two entry points rather than one audience flag — professor and student share
 * no signals and no wording, so a shared function would be all branches.
 *
 * Pipeline: signals → candidates (buildXCandidates) → rank → cap (the clutter
 * budget) → RoadmapAnnotation[] + EmphasisSpec[] via the loudness grammar.
 */

import type {
  CourseModule,
  EmphasisKind,
  Kind,
  EmphasisTone,
  AnnotationSub,
  RoadmapAnnotation,
  EmphasisSpec,
} from './prototype-adapter'
import { resolveTarget } from './annotation-target'

/* ════════════════════════════════════════════════════════════════
   THE SIGNAL CONTRACT — what the server-side producers must supply.
   Every field is "free data" for Slice 1: already fetched by the page,
   or one cheap query. Titles match roadmap node titles (substring).
   ════════════════════════════════════════════════════════════════ */

/** An assessment with a real deadline, and how long until it closes. */
export interface DueItem {
  title: string
  kind: 'quiz' | 'assignment'
  hoursLeft: number
}

/** A prerequisite/related link between two node titles (roadmap_edges). */
export interface EdgeSignal {
  from: string
  to: string
  kind: 'prerequisite' | 'related'
}

/** A quote-anchored statement the professor made in a finished class (slice 4,
 *  roadmap-engine.md §5.1). `quote` is their verbatim words, verified against
 *  the real transcript before storage — an annotation built from this must
 *  always show it (a paraphrased "promise" is the failure this feature exists
 *  to avoid). */
export interface SpokenClaim {
  kind: 'commitment' | 'exam_scope' | 'emphasis' | 'off_deck'
  /** lc_rooms.name — targets the session node (`session:` prefix). */
  sessionTitle: string
  /** One plain sentence from the extraction pass (unused by the map today —
   *  the quote carries the annotation; Athena reads the summary). */
  summary: string
  quote: string
  /** 1-based, as a student counts slides. */
  slide: number
}

/** P24/S23 · the deep-vs-skimmed pair on one taught deck. `target` is the
 *  deck's material card as `item:<module_item_id>` — exact, so a deck whose
 *  title another card shares still annotates the right node. */
export interface DeliveryDepthSignal {
  target: string
  deepSlide: number
  deepMinutes: number
  skimmedSlide: number
  skimmedSeconds: number
}

/** Professor signals — class aggregates + the action queue. */
export interface ProfSignals {
  /** P3 · per-module struggle, from the student-journey states already fetched. */
  stuck: { moduleTitle: string; struggling: number; engaged: number }[]
  /** P8 · submissions waiting to be graded, per activity. */
  gradingQueue: { title: string; awaiting: number }[]
  /** P8 · activities whose submissions are all graded (good-news ✓). */
  allGraded: { title: string }[]
  /** P9 · published, past-due activities with un-submitted students. */
  missing: { title: string; count: number }[]
  /** P7 · in-progress/draft submissions never turned in, per activity. */
  draftsUnsubmitted: { title: string; count: number }[]
  /** P11 · activities still unpublished (draft) on the map. */
  /** Draft quizzes/assignments, oldest first; `ageDays` from `created_at`. */
  unpublishedDrafts: { title: string; createdAt?: string | null; ageDays?: number }[]
  /** Material saved but not shared with students — a live-classroom deck the
   *  professor uploaded to project and hasn't released (P: unshared upload). */
  unsharedUploads: { title: string }[]
  /** P10 · upcoming deadlines. */
  dueSoon: DueItem[]
  /** P12 · a live class about to start (hours out; only the imminent ones). */
  sessionSoon: { title: string; hoursUntil: number }[]
  /** P4 · the single weakest class skill, mapped onto an assessing node. */
  weakestSkill?: { classScore: number; targetTitle: string }
  /** P6 · quiz questions with poor empirical discrimination (item analysis). */
  itemQuality: { quizTitle: string; questionLabel: string }[]
  /** P13 · a recent office-hour booking spike, attached to a chosen node. */
  bookingDemand?: { targetTitle: string; recent: number }
  /** P4 · class mastery declining over time (from the nightly snapshots). */
  masteryTrend: { targetTitle: string; from: number; to: number }[]
  /** P1 · placed content no student has ever opened. */
  noOpens: { title: string }[]
  /** P1 · content opened by many students recently (engagement spike). */
  openSpike: { title: string; count: number }[]
  /** P2 · resources students keep re-downloading (repeat pulls) + how many do. */
  reDownloads: { title: string; students: number }[]
  /** P17 · resources students keep revisiting (repeat views by the same student). */
  revisits: { title: string; students: number }[]
  /** P5 · outbound link click-throughs (distinct students who followed the link). */
  clickThroughs: { title: string; students: number }[]
  /** P15 · prerequisite/related edges for xref arrows. */
  edges: EdgeSignal[]
  /** P18 · a deck the class started but never finished (Part II §13.2). */
  deckGap: { title: string; covered: number; total: number }[]
  /** P19 · a module with lectures that no class ever reached and no assessment closed. */
  neverDelivered: { title: string }[]
  /** P20 · supplementary material no student has completed (check or tick). */
  extrasCold: { title: string }[]
  /** P21 · published and open, but not one student has started it. */
  openUntouched: { title: string }[]
  /** P14/P16/P22/P23 · what the professor said out loud in class (slice 4). */
  spokenClaims: SpokenClaim[]
  /** P24 · a deck taught unevenly — minutes on one slide, seconds on another. */
  deliveryDepth: DeliveryDepthSignal[]
}

/** Student signals — self + next step. All strictly self-scoped. */
export interface StuSignals {
  /** S7 · the student's own upcoming deadlines (un-submitted only). */
  dueSoon: DueItem[]
  /** S4 · activities the student has a posted grade on. */
  gradePosted: { title: string }[]
  /** S8 · how many skills are below the "weak" threshold, on a review node. */
  weakSkills?: { count: number; targetTitle: string }
  /** S19 · the student's weakest skill, on the node that TEACHES it — the canvas
   *  twin of the node modal's "Study this with AI Tutor" link. `tutorHref` is
   *  absent when the section has the AI Tutor off; the note then still names the
   *  weak skill, just without the link. */
  studyWithTutor?: { targetTitle: string; key?: string; topic: string; pct: number; tutorHref?: string }
  /** S2 · nodes the student has mastered (good-news). */
  masteryHigh: { title: string; pct: number }[]
  /** S2/C1 · an upcoming assessment vs the student's mastery of its skill. */
  masteryLow: { title: string; pct: number }[]
  /** S13 · long readings worth starting early. */
  longReads: { title: string; key?: string; pages: number }[]
  /** the node to begin next (first not-started material). */
  startHere?: { title: string; key?: string }
  /** C10 · repeated attempts on a quiz with no score gain — nudge to office hours. */
  noImprovement: { title: string; attempts: number }[]
  /** C3 · a missed session that covered one of the student's weakest topics. */
  absenceGap: { sessionTitle: string; topic: string }[]
  /** C7 · a quiz where the student was slow AND wrong on a skill (comprehension gap). */
  slowWrong: { title: string; skill: string }[]
  /** S2 · the student's own mastery change over time (from the nightly snapshots). */
  masteryTrend: { targetTitle: string; from: number; to: number }[]
  /** C15 · content added since the student's last visit. */
  newSinceVisit: { title: string; key?: string }[]
  /** S1 · the node of the student's most recent activity — "you are here". */
  youAreHere?: { title: string; key?: string }
  /** prerequisite/related edges for xref arrows. */
  edges: EdgeSignal[]
  /** S17 · the part of a deck the class never got to — the rest is self-study. */
  selfStudyRemainder: { title: string; covered: number; total: number }[]
  /** S16 · an extra with a check waiting that this student hasn't done. */
  checkAvailable?: { title: string }
  /** S18 · how far the student is through what has actually been taught. */
  coverageVsDelivery?: { title: string; pct: number }
  /** S20/S21/S22 · what was said in class, quote-anchored (slice 4). The
   *  builder skips `exam_scope` — it has no student twin on the map; Athena
   *  answers scope questions from the same rows (U24). */
  spokenClaims: SpokenClaim[]
  /** S23 · the class skimmed a slide of this deck — a self-study prompt. */
  deliveryDepth: DeliveryDepthSignal[]
}

/* ════════════════════════════════════════════════════════════════
   CANDIDATES — one potential annotation before ranking + capping.
   Producers describe the SIGNAL (what/where/how urgent); the engine
   chooses the concrete visual variant from the grammar.
   ════════════════════════════════════════════════════════════════ */

/** Loudness tier — drives the visual vocabulary (grammar) and ranking. */
export type Alertness = 'act-now' | 'this-week' | 'insight' | 'ambient' | 'structural'
/** Which annotation family a signal wants; the tier picks the sub-variant. */
export type Shape = 'note' | 'flag' | 'ring' | 'mark' | 'xref' | 'tally' | 'rule'

export interface Candidate {
  /** node title to attach to (substring); 'session:' prefix targets a session. */
  target: string
  /** xref only: the second node title (the clickable link). */
  target2?: string
  shape: Shape
  alertness: Alertness
  tone: EmphasisTone
  /** note text (may contain `<b>…</b>`, and `<a>…</a>` when `href` is set). */
  text?: string
  /** destination for the text's `<a>…</a>` segment (same-origin app path). */
  href?: string
  /** tally count. */
  n?: number
  /** note only: render the headline `big` sub (a number that IS the note). */
  bigNumber?: boolean
  /** ranking inputs, each 0..1; default mid. */
  urgency?: number
  reach?: number
  /** node emphasis this signal also warrants (subject to the budget). */
  emphasis?: EmphasisKind
  /** engagement-class signal (P1 opens / new-since-visit). These are the quietest
   *  tiers and a busy map's louder signals would always starve them, so they get
   *  a small reserved quota (Budget.maxEngagement) filled before the general pass. */
  engagement?: boolean
}

/* ════════════════════════════════════════════════════════════════
   THE CLUTTER BUDGET — hard caps so the map never floods (§4.2).
   ════════════════════════════════════════════════════════════════ */
export interface Budget {
  maxAnnotations: number
  maxPerModule: number
  maxActNow: number
  maxLoops: number
  maxBreathe: number
  maxEmphasis: number
  maxXref: number
  maxRule: number
  /** slots reserved for engagement-class signals so louder tiers can't starve them. */
  maxEngagement: number
}
export const DEFAULT_BUDGET: Budget = {
  /* 5, not 10. "focused" is meant to be a shortlist of the few things worth
     acting on, but it was tuned for a course that generates more signal than a
     real one does: after node-dedup (one annotation per node — structural, not a
     budget knob) a real section yields about ten candidates, so a cap of 10 sat
     exactly at the ceiling and never bound. Switching everything → focused then
     removed a single note, which reads as a broken toggle. At 5 the two modes
     differ visibly, and `everything` (FULL_BUDGET) still shows every candidate. */
  maxAnnotations: 5,
  maxPerModule: 2,
  maxActNow: 2,
  maxLoops: 3,
  maxBreathe: 1,
  maxEmphasis: 5,
  maxXref: 2,
  maxRule: 1,
  maxEngagement: 2,
}

/** "Show everything" preset — the *count* caps lifted so every candidate that
 *  survives node-dedup + target resolution renders. Still one annotation per
 *  node (that's structural, not a budget knob). Backs the roadmap's "everything"
 *  detail mode; DEFAULT_BUDGET backs the curated "focused" mode.
 *
 *  The three **voice** caps deliberately stay at their curated values: showing
 *  everything means every signal is *present*, not that every one animates. They
 *  hide nothing — maxLoops/maxBreathe only swap an annotation for its static
 *  variant, and maxActNow only quiets a flag to the this-week voice — so lifting
 *  them would buy no extra information and cost a map of competing motion. */
export const FULL_BUDGET: Budget = {
  maxAnnotations: 999,
  maxPerModule: 999,
  maxEmphasis: 999,
  maxXref: 999,
  maxRule: 999,
  maxEngagement: 999,
  maxActNow: DEFAULT_BUDGET.maxActNow,
  maxLoops: DEFAULT_BUDGET.maxLoops,
  maxBreathe: DEFAULT_BUDGET.maxBreathe,
}

/* ════════════════════════════════════════════════════════════════
   NODE LOCATOR — map a target title to its module index, mirroring the
   annotation layer's own resolution (resources first, then sessions,
   then the module title; 'session:' prefix → sessions only). Returns
   -1 when the target isn't on the map, so we can drop dangling signals.
   ════════════════════════════════════════════════════════════════ */
type LocEntry = { mod: number; group: 'res' | 'sess' | 'mod'; title: string; kind?: Kind; key?: string }

/** Card kinds that are never annotated, whatever a signal asks for.
 *
 *  A note IS the annotation — it's a professor's own aside, pinned to the map as
 *  content. Hanging "start here next" or "3 weak skills" on it annotates an
 *  annotation: the card gains a margin note it has no room for, and the reader
 *  can't tell which text is the professor's and which is ours. Enforced here, at
 *  the one gate every candidate already passes, rather than in each of the ~20
 *  signal producers — a rule stated once can't be forgotten by signal 21. */
const NON_ANNOTATABLE: ReadonlySet<Kind> = new Set<Kind>(['note'])

/**
 * A candidate's target string: by ITEM ID when the signal's producer carried the
 * card's node key, else by title.
 *
 * Title targeting is not wrong — `resolveTarget` matches exact titles before
 * substrings, so a signal carrying a card's full title lands correctly even when
 * another title contains it. But two cards CAN share a title, and then only the id
 * can separate them. Producers that already hold the card pass `key` and get that
 * for free; the rest fall back, which is why this is a helper and not a migration.
 */
function targetOf(key: string | undefined, title: string): string {
  return key ? `item:${key.slice(key.indexOf(':') + 1)}` : title
}

function buildLocator(course: CourseModule[]): {
  locate: (target: string) => number
  kindOf: (target: string) => Kind | undefined
} {
  const entries: LocEntry[] = []
  course.forEach((m, i) => {
    entries.push({ mod: i, group: 'mod', title: m.title })
    for (const r of [...m.materials, ...m.quizzes, ...m.assignments]) entries.push({ mod: i, group: 'res', title: r.t, kind: r.k, key: r.key })
    for (const s of m.sessions ?? []) entries.push({ mod: i, group: 'sess', title: s.t })
    if (m.liveRoom) entries.push({ mod: i, group: 'sess', title: m.liveRoom.t })
  })
  /* ONE resolution, so "which module is this on" and "what kind of card is it"
     can never disagree about which entry a target meant — and it is the SAME
     resolution the annotation layer positions with (annotation-target.ts), which
     used to be a separate copy of these rules, free to drift from this one. */
  const find = (target: string): LocEntry | undefined =>
    resolveTarget(entries, target, { group: (e) => e.group, title: (e) => e.title, key: (e) => e.key })
  return {
    locate: (target) => find(target)?.mod ?? -1,
    kindOf: (target) => find(target)?.kind,
  }
}

/* ════════════════════════════════════════════════════════════════
   THE GRAMMAR — a candidate's (shape, alertness) → concrete annotation.
   Louder tiers get louder sub-variants (§4.1).
   ════════════════════════════════════════════════════════════════ */
function toAnnotation(c: Candidate): RoadmapAnnotation {
  const { tone, target: t, text, href } = c
  switch (c.shape) {
    case 'xref':
      return { v: 'xref', tone, t, t2: c.target2, text, href }
    case 'rule':
      return { v: 'rule', tone, t, text, href }
    case 'tally':
      return { v: 'tally', tone, t, n: c.n, text, href }
    case 'ring':
      return { v: 'ring', tone, t, text, href }
    case 'mark':
      return { v: 'mark', sub: c.alertness === 'act-now' ? 'bang' : 'dogear', tone, t, text, href }
    case 'flag': {
      let sub: AnnotationSub | undefined
      if (c.alertness === 'act-now') sub = c.n != null ? 'banner' : 'wave'
      else if (c.alertness === 'ambient') sub = 'tab'
      else sub = undefined // pin — the quiet default
      return { v: 'flag', sub, tone, t, text, href }
    }
    case 'note':
    default: {
      let sub: AnnotationSub | undefined
      if (c.alertness === 'insight') sub = c.bigNumber ? 'big' : 'ink'
      else if (c.alertness === 'this-week') sub = 'dots'
      else if (c.alertness === 'ambient') sub = c.bigNumber ? 'big' : undefined // pencil
      else sub = 'ink'
      return { v: 'margin', sub, tone, t, text, href }
    }
  }
}

/* ranking: the loudness tier dominates, then urgency, then reach. */
const TIER_RANK: Record<Alertness, number> = { 'act-now': 4, 'this-week': 3, insight: 2, ambient: 1, structural: 0 }
function byPriority(a: Candidate, b: Candidate): number {
  const t = TIER_RANK[b.alertness] - TIER_RANK[a.alertness]
  if (t) return t
  const u = (b.urgency ?? 0.5) - (a.urgency ?? 0.5)
  if (u) return u
  return (b.reach ?? 0.5) - (a.reach ?? 0.5)
}

/* an annotation that loops forever (motion budget counts these). */
function isLoop(a: RoadmapAnnotation): boolean {
  return (a.v === 'margin' && (a.sub === 'dots' || a.sub === 'squiggle')) || (a.v === 'flag' && a.sub === 'wave')
}
/* quiet the motion of a looping annotation while keeping its meaning. */
function stillVariant(a: RoadmapAnnotation): RoadmapAnnotation {
  if (a.v === 'margin') return { ...a, sub: 'ink' }
  if (a.v === 'flag') return { ...a, sub: a.text && /\d/.test(a.text) ? 'banner' : undefined }
  return a
}

/* ════════════════════════════════════════════════════════════════
   THE ENGINE — rank candidates, apply the budget, render.
   ════════════════════════════════════════════════════════════════ */
export function triage(
  course: CourseModule[],
  candidates: Candidate[],
  budget: Budget = DEFAULT_BUDGET,
  // A pure node-emphasis, tied to no annotation — the "you are here" position
  // ring. Added directly to the emphasis channel so it coexists with whatever
  // annotation (e.g. "start here next") wins that node.
  positionMarker?: { target: string; tone: EmphasisTone },
): { annotations: RoadmapAnnotation[]; emphasis: EmphasisSpec[] } {
  const { locate, kindOf } = buildLocator(course)
  const annotatable = (target: string | undefined | null): boolean => {
    if (target == null) return true
    const k = kindOf(target)
    return k === undefined || !NON_ANNOTATABLE.has(k)
  }

  // Drop signals whose target isn't on the map (xref needs both ends), or whose
  // target is a card kind that never takes an annotation.
  const onMap = candidates.filter((c) => {
    if (locate(c.target) < 0) return false
    if (!annotatable(c.target)) return false
    if (c.shape === 'xref' && (c.target2 == null || locate(c.target2) < 0)) return false
    // An xref draws a line between two cards, so BOTH ends have to be annotatable.
    if (c.shape === 'xref' && !annotatable(c.target2)) return false
    return true
  })

  // Structural annotations (rule/xref) sit outside the score but inside the
  // total — keep up to their own caps, most-urgent first.
  const rules = onMap.filter((c) => c.shape === 'rule').sort(byPriority).slice(0, budget.maxRule)
  const xrefs = onMap.filter((c) => c.shape === 'xref').sort(byPriority).slice(0, budget.maxXref)

  // Ranked annotations: one per node (highest priority wins the node).
  const ranked = onMap.filter((c) => c.shape !== 'rule' && c.shape !== 'xref').sort(byPriority)
  const perNode = new Set<string>()
  const deduped: Candidate[] = []
  for (const c of ranked) {
    if (perNode.has(c.target)) continue
    perNode.add(c.target)
    deduped.push(c)
  }

  // Fill under the caps: per-module (2), global total (10, includes structural),
  // and the act-now quota (beyond 2, demote to the quieter this-week voice).
  const perModule = new Map<number, number>()
  // Keyed by the ORIGINAL candidate, valued by the possibly-demoted copy that will
  // render. A map (not a set + push order) because the three passes below pick out
  // of priority sequence, while the layer downstream must receive them IN priority
  // order: it places notes first-come-first-served against a `placed` accumulator,
  // so whatever is emitted first claims the clean margin slot.
  const picked = new Map<Candidate, Candidate>()
  let total = rules.length + xrefs.length
  let actNow = 0

  const tryPick = (c: Candidate): boolean => {
    if (total >= budget.maxAnnotations) return false
    const mod = locate(c.target)
    const used = perModule.get(mod) ?? 0
    if (used >= budget.maxPerModule) return false
    let keep = c
    if (c.alertness === 'act-now') {
      if (actNow >= budget.maxActNow) {
        // over quota: keep the signal, quiet its voice (and drop a breathing cue)
        keep = { ...c, alertness: 'this-week', emphasis: c.emphasis === 'breathe' ? undefined : c.emphasis }
      } else {
        actNow++
      }
    }
    picked.set(c, keep)
    perModule.set(mod, used + 1)
    total++
    return true
  }

  // Three passes, all under the same caps, ordered by what must never be
  // displaced. `deduped` is priority-sorted, so each pass is too.
  //   1. act-now — the loudest tier can't lose a slot to a quieter signal. The
  //      reserve below spends from the SHARED per-module/total pools, so without
  //      this pass two ambient notes could fill a module's quota (maxEngagement
  //      equals maxPerModule) and evict "9 of 10 stuck here" outright.
  //   2. the reserved engagement quota — ambient/low-reach signals lose every
  //      priority comparison, so a busy map would otherwise starve them.
  //   3. everything else by rank.
  for (const c of deduped) {
    if (c.alertness === 'act-now') tryPick(c)
  }
  let eng = 0
  for (const c of deduped) {
    if (eng >= budget.maxEngagement) break
    if (c.engagement && !picked.has(c) && tryPick(c)) eng++
  }
  for (const c of deduped) {
    if (!picked.has(c)) tryPick(c)
  }

  // Emit in priority order regardless of which pass claimed each slot, so the
  // loudest signal gets the best placement downstream.
  const selected = deduped.filter((c) => picked.has(c)).map((c) => picked.get(c) as Candidate)

  // Render (rules + xrefs + ranked), then spend the motion budget: past
  // maxLoops looping annotations, quiet the rest to a static variant.
  const rendered = [...rules, ...xrefs, ...selected].map(toAnnotation)
  let loops = 0
  const annotations = rendered.map((a) => {
    if (!isLoop(a)) return a
    if (loops < budget.maxLoops) { loops++; return a }
    return stillVariant(a)
  })

  // Emphasis rides on SELECTED candidates only — never orphan a breathing/
  // celebrating node whose explaining annotation was dropped by the budget
  // (and this makes the act-now demotion's breathe-strip actually take effect,
  // since `selected` holds the demoted copies). Two rules on a shared node:
  // "no double MOTION" (an animated emphasis atop a looping annotation drops to
  // the static outline) and the single-breathe cap.
  const loopTargets = new Set(annotations.filter(isLoop).map((a) => a.t))
  const emSeen = new Set<string>()
  const emphasis: EmphasisSpec[] = []
  let breathe = 0
  for (const c of selected) {
    if (!c.emphasis) continue
    if (emphasis.length >= budget.maxEmphasis) break
    if (emSeen.has(c.target)) continue
    let em = c.emphasis
    const animated = em === 'breathe' || em === 'shine' || em === 'wiggle' || em === 'tada'
    if (animated && loopTargets.has(c.target)) em = 'outline'
    if (em === 'breathe') {
      if (breathe >= budget.maxBreathe) em = 'outline'
      else breathe++
    }
    emSeen.add(c.target)
    emphasis.push({ em, tone: c.tone, t: c.target })
  }

  // The position marker rides the emphasis channel (static outline), so it never
  // competes with annotations for its node — but still respects the map + caps.
  if (positionMarker && locate(positionMarker.target) >= 0 && !emSeen.has(positionMarker.target) && emphasis.length < budget.maxEmphasis) {
    emphasis.push({ em: 'outline', tone: positionMarker.tone, t: positionMarker.target })
  }

  return { annotations, emphasis }
}

/* ════════════════════════════════════════════════════════════════
   CANDIDATE BUILDERS — map typed signals onto candidates (the wording
   + tone + tier live here; this is the audience "voice").
   ════════════════════════════════════════════════════════════════ */

/** a friendly deadline phrase from hours-remaining. */
function dueLabel(hoursLeft: number): string {
  if (hoursLeft <= 0) return 'past due'
  if (hoursLeft < 12) return 'closes tonight'
  if (hoursLeft < 24) return 'due tomorrow'
  const days = Math.ceil(hoursLeft / 24)
  return `due in ${days} days`
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/* How close a scheduled class has to be before it earns an annotation of its own
   (P12). Twelve hours keeps it inside one working day, which is what lets the note
   stay timezone-free. Lives here, with the urgency scale that divides by it, so the
   window and the ramp can't drift apart. */
export const SESSION_SOON_H = 12
/** "in an hour" / "in 3 hours" — never "in 1 hours". */
const inHoursLabel = (h: number): string =>
  Math.round(h) === 1 ? 'class in an hour' : `class in ${Math.round(h)} hours`

/* When a draft stops reading as "in progress" and starts reading as abandoned.
   A month is the shortest span that can't be explained by "I'm still writing it"
   inside a normal teaching term. */
const STALE_DRAFT_DAYS = 30
/** "June", or "June 2025" once it isn't this year. Named, not counted: "a draft
 *  since June" is how a professor remembers it, "62 days old" isn't — but a course
 *  shell reused next term would otherwise give last year's leftovers this term's
 *  urgency, with identical wording. */
const monthOf = (iso: string, now: number): string => {
  const d = new Date(iso)
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  return d.getUTCFullYear() === new Date(now).getUTCFullYear()
    ? month
    : `${month} ${d.getUTCFullYear()}`
}

/* A verbatim quote is stored up to 400 chars; a margin note carries the first
   clause-and-a-bit (90 chars ≈ 5 wrapped lines at the note's real width —
   measured; longer buys nothing because the lead-in, not the quote, sets the
   floor). Clipping with an ellipsis keeps it honest — shortened, never reworded
   (the trust rule: a spoken claim always shows its quote) — and the cut lands
   on a word boundary so the elision doesn't read as a render bug. */
const QUOTE_MAX = 90
const spokenQuote = (q: string): string => {
  if (q.length <= QUOTE_MAX) return `“${q}”`
  const cut = q.slice(0, QUOTE_MAX)
  const atWord = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut
  return `“${atWord.trimEnd()}…”`
}

/* A mastery % → its band tone, so a trend's two numbers paint by level (green
 * ≥80, amber 50–79, red <50) and the from→to transition reads at a glance.
 * Mirrors the journey-state thresholds (MASTERY_THRESHOLD 80 / REVIEW 50). */
const masteryTone = (pct: number): EmphasisTone => (pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'alert')
/* Render a "from% → to%" pair with each number in its band tone. */
const trendPair = (from: number, to: number): string =>
  `<c:${masteryTone(from)}>${from}%</c> → <c:${masteryTone(to)}>${to}%</c>`

export function buildProfessorCandidates(s: ProfSignals): Candidate[] {
  const out: Candidate[] = []
  const now = Date.now() // only for wording a stale draft's month/year

  for (const k of s.stuck) {
    if (k.engaged <= 0) continue
    const ratio = k.struggling / k.engaged
    if (ratio < 0.3) continue // only surface real struggle
    out.push({
      // module-scoped: pin to the module band, not a resource that shares its name
      target: `module:${k.moduleTitle}`, shape: 'note', alertness: 'insight', bigNumber: true,
      tone: ratio >= 0.6 ? 'alert' : 'warn', reach: clamp01(ratio), urgency: 0.5,
      text: `<b>${k.struggling} of ${k.engaged}</b> stuck here`,
    })
  }
  for (const g of s.gradingQueue) {
    if (g.awaiting <= 0) continue
    out.push({
      target: g.title, shape: 'note', alertness: 'this-week', tone: 'warn',
      urgency: 0.6, reach: clamp01(g.awaiting / 15),
      text: `${g.awaiting} awaiting your grade`,
    })
  }
  for (const a of s.allGraded) {
    // claims only what it verifies — the queue is clear, not that everyone submitted
    out.push({ target: a.title, shape: 'flag', alertness: 'ambient', tone: 'ok', text: 'nothing to grade ✓' })
  }
  for (const m of s.missing) {
    if (m.count <= 0) continue
    out.push({
      target: m.title, shape: 'flag', alertness: 'act-now', tone: 'alert', n: m.count,
      urgency: 0.9, reach: clamp01(m.count / 10),
      /* Says what is missing, not just how many — a bare "3 missing" beside an
         assignment card reads as marks or attachments — and says it in a way that
         cannot be confused with P7's "N started, not turned in" on the same card.
         The two populations are disjoint (see the signal builder). */
      text: `${m.count} never started it`, emphasis: 'breathe',
    })
  }
  for (const d of s.draftsUnsubmitted) {
    if (d.count <= 0) continue
    out.push({
      target: d.title, shape: 'tally', alertness: 'insight', tone: 'warn', n: d.count,
      reach: clamp01(d.count / 10), text: `${d.count} started, not turned in`,
    })
  }
  for (const u of s.unsharedUploads) {
    /* The safety net for the end-of-class "share today's deck?" prompt. Miss that
       prompt and the file is on the map but invisible to students — the card is
       faded with an eye-off, and this names the reason in words. 'info' (blue),
       matching the draft-publish reminder: not a problem, just an unfinished
       decision. */
    out.push({
      target: u.title, shape: 'ring', alertness: 'this-week', tone: 'info', urgency: 0.4,
      text: 'not shared with students yet',
    })
  }
  for (const u of s.unpublishedDrafts) {
    /* A draft that has sat for a month isn't a publish reminder any more — it is
       an unmade decision, and saying WHEN it stopped moving is what makes that
       land ("a draft since June"). Amber for those, since the professor has
       already ignored the quiet version; anything newer keeps 'info' (blue) —
       a draft in progress isn't a problem, and blue also keeps the ring distinct
       from the amber/red struggle notes that share these modules. */
    const stale = (u.ageDays ?? 0) >= STALE_DRAFT_DAYS && !!u.createdAt
    out.push({
      target: u.title, shape: 'ring', alertness: 'this-week',
      tone: stale ? 'warn' : 'info', urgency: stale ? 0.5 : 0.4,
      text: stale
        ? `a draft since ${monthOf(u.createdAt as string, now)} — finish or drop?`
        : 'still a draft — publish it?',
    })
  }
  for (const c of s.sessionSoon) {
    /* Timezone-free on purpose. The demo said "today · 3 pm", but this text is
       built on the server (UTC) for a professor who is not in UTC — "today" and a
       wall-clock hour are both claims we cannot make from here, and being an hour
       or a day wrong about a class is worse than being vague. Hours-until says the
       same thing and is true everywhere; the card's own tile carries the date. */
    out.push({
      target: `session:${c.title}`, shape: 'flag',
      /* Under two hours this is the most time-critical thing on the map, and the
         quiet this-week pin renders identically at 12 hours and at 20 minutes. The
         escalation is size + motion (act-now with no count → flag·wave), never
         hue: `info` keeps a class that is merely soon from competing with the
         red/amber things that are actually wrong. */
      alertness: c.hoursUntil < 2 ? 'act-now' : 'this-week', tone: 'info',
      urgency: clamp01(1 - c.hoursUntil / SESSION_SOON_H),
      text: c.hoursUntil < 1 ? 'class starts within the hour' : inHoursLabel(c.hoursUntil),
    })
  }
  for (const d of s.dueSoon) {
    const soon = d.hoursLeft < 24
    out.push({
      target: d.title, shape: soon ? 'flag' : 'note', alertness: soon ? 'act-now' : 'this-week',
      tone: 'warn', urgency: clamp01(1 - d.hoursLeft / 168),
      text: `${dueLabel(d.hoursLeft)} — nudge the class?`,
    })
  }
  if (s.weakestSkill) {
    out.push({
      target: s.weakestSkill.targetTitle, shape: 'note', alertness: 'insight', tone: 'alert',
      reach: 0.9, text: `class is weakest here — <b>${s.weakestSkill.classScore}%</b>`,
    })
  }
  for (const q of s.itemQuality) {
    out.push({
      target: q.quizTitle, shape: 'note', alertness: 'insight', tone: 'alert', reach: 0.6,
      text: `<b>${q.questionLabel}</b> discriminates poorly — worth a look`,
    })
  }
  if (s.bookingDemand && s.bookingDemand.recent > 0) {
    out.push({
      target: s.bookingDemand.targetTitle, shape: 'note', alertness: 'this-week', tone: 'info', urgency: 0.4,
      text: 'office-hour bookings spiked — add a review session?',
    })
  }
  for (const t of s.masteryTrend) {
    if (t.to >= t.from) continue // professor only surfaces slippage
    const drop = t.from - t.to
    out.push({
      target: t.targetTitle, shape: 'note', alertness: 'insight', tone: drop >= 10 ? 'alert' : 'warn',
      reach: clamp01(drop / 30), text: `mastery slipping — ${trendPair(t.from, t.to)}`,
    })
  }
  for (const c of s.noOpens) {
    out.push({ target: c.title, shape: 'note', alertness: 'ambient', tone: 'slate', text: 'no one has opened this yet', engagement: true })
  }
  for (const c of s.openSpike) {
    if (c.count <= 0) continue
    out.push({
      target: c.title, shape: 'tally', alertness: 'insight', tone: 'info', n: c.count,
      reach: clamp01(c.count / 20), text: `${c.count} opened this week`, engagement: true,
    })
  }
  for (const c of s.reDownloads) {
    if (c.students <= 0) continue
    out.push({
      target: c.title, shape: 'note', alertness: 'insight', tone: 'info',
      reach: clamp01(c.students / 10), text: 'students keep re-downloading this', engagement: true,
    })
  }
  for (const c of s.revisits) {
    if (c.students <= 0) continue
    out.push({
      target: c.title, shape: 'note', alertness: 'insight', tone: 'info',
      reach: clamp01(c.students / 10), text: 'students keep revisiting this', engagement: true,
    })
  }
  for (const c of s.clickThroughs) {
    if (c.students <= 0) continue
    out.push({
      target: c.title, shape: 'tally', alertness: 'insight', tone: 'info', n: c.students,
      reach: clamp01(c.students / 20), text: `${c.students} clicked through`, engagement: true,
    })
  }
  // ── Part II coverage signals (P18–P21) ─────────────────────────
  for (const d of s.deckGap) {
    // The honest fraction IS the message, so it goes in a big margin note.
    out.push({
      target: d.title, shape: 'note', alertness: 'insight', tone: 'warn',
      reach: clamp01(1 - d.covered / Math.max(d.total, 1)),
      text: `you stopped at <b>slide ${d.covered} of ${d.total}</b> here`,
    })
  }
  for (const m of s.neverDelivered) {
    out.push({
      target: `module:${m.title}`, shape: 'note', alertness: 'insight', tone: 'warn', reach: 0.7,
      text: 'this week never got a class',
    })
  }
  for (const c of s.extrasCold) {
    out.push({
      target: c.title, shape: 'note', alertness: 'ambient', tone: 'slate',
      /* "gone through", not "done this check": getColdExtras counts an extra as
         touched by EITHER route — a passed quick check or a self check-off — and
         plenty of extras have no check at all (an external link is
         'not_quizzable', so its only route is the tick). Naming the check made the
         note read as nonsense on exactly those cards. */
      text: 'no one has gone through this yet', engagement: true,
    })
  }
  for (const c of s.openUntouched) {
    out.push({
      target: c.title, shape: 'note', alertness: 'insight', tone: 'warn', reach: 0.6,
      text: 'published — nobody has started it',
    })
  }
  // ── Slice 4 — what was said out loud (P14/P16/P22/P23, quote-anchored) ──
  for (const c of s.spokenClaims) {
    const target = `session:${c.sessionTitle}`
    const q = spokenQuote(c.quote)
    if (c.kind === 'commitment') {
      /* A promise made out loud is an action item: the class heard it and the
         LMS doesn't reflect it yet. The slide anchor makes it checkable. */
      out.push({
        target, shape: 'note', alertness: 'this-week', tone: 'warn', urgency: 0.7,
        text: `you told the class — ${q} (slide ${c.slide})`,
      })
    } else if (c.kind === 'exam_scope') {
      // "exam scope", never bare "scope" — the note must say scope of WHAT
      // without making the reader parse the clipped quote to find out.
      out.push({
        target, shape: 'note', alertness: 'insight', tone: 'info', reach: 0.8,
        text: `exam scope, in your words — ${q}`,
      })
    } else if (c.kind === 'emphasis') {
      // P22 rides the node-emphasis channel — that channel is what it was built
      // for (§4.1). Static outline: the note's text carries the message.
      // "stressed", not "flagged": flag is this product's UI verb, and nobody
      // flags anything out loud.
      out.push({
        target, shape: 'note', alertness: 'insight', tone: 'info', reach: 0.7,
        text: `you stressed this in class — ${q}`, emphasis: 'outline',
      })
    } else {
      out.push({
        target, shape: 'note', alertness: 'insight', tone: 'warn', reach: 0.6,
        text: `you only explained this in class — ${q}`,
      })
    }
  }
  for (const d of s.deliveryDepth) {
    // "sec" spelled out — "40s" after a comma momentarily reads as a plural.
    out.push({
      target: d.target, shape: 'note', alertness: 'insight', tone: 'info', reach: 0.5,
      text: `you spent <b>${d.deepMinutes} min</b> on slide ${d.deepSlide} — slide ${d.skimmedSlide} got ${d.skimmedSeconds} sec`,
    })
  }
  for (const e of s.edges) {
    out.push({
      target: e.to, target2: e.from, shape: 'xref', alertness: 'structural', tone: 'info',
      text: e.kind === 'prerequisite' ? 'do this first —' : 'related —',
    })
  }
  return out
}

export function buildStudentCandidates(s: StuSignals): Candidate[] {
  const out: Candidate[] = []

  for (const d of s.dueSoon) {
    const soon = d.hoursLeft < 48
    // A wave flag already carries the act-now motion — no breathe on top (the
    // engine would quiet it anyway; two motions on one card is the thing to avoid).
    out.push({
      target: d.title, shape: soon ? 'flag' : 'note', alertness: soon ? 'act-now' : 'this-week',
      tone: 'warn', urgency: clamp01(1 - d.hoursLeft / 168), text: dueLabel(d.hoursLeft),
    })
  }
  for (const g of s.gradePosted) {
    out.push({ target: g.title, shape: 'flag', alertness: 'ambient', tone: 'ok', text: 'grade posted ✓', emphasis: 'tada' })
  }
  if (s.weakSkills && s.weakSkills.count > 0) {
    out.push({
      target: s.weakSkills.targetTitle, shape: 'tally', alertness: 'insight', tone: 'warn',
      n: s.weakSkills.count, reach: clamp01(s.weakSkills.count / 8),
      text: `${s.weakSkills.count} weak skills to review`,
    })
  }
  if (s.studyWithTutor) {
    // The canvas half of the modal's Athena study link: masteryLow points at the
    // activity that ASSESSES a weak skill, this one at the material that TEACHES
    // it — which is where the student can actually do something about it.
    const t = s.studyWithTutor
    out.push({
      target: targetOf(t.key, t.targetTitle), shape: 'note', alertness: 'insight', tone: 'alert',
      reach: clamp01(1 - t.pct / 60), href: t.tutorHref,
      text: `<b>${t.topic}</b> is your weakest here — <a>study it with Athena</a>`,
    })
  }
  for (const m of s.masteryHigh) {
    out.push({
      target: m.title, shape: 'note', alertness: 'ambient', tone: 'ok', bigNumber: true,
      text: `<b>${m.pct}%</b> mastered — keep going`,
    })
  }
  for (const m of s.masteryLow) {
    // mastery level is a clock-less insight (static ink), not a this-week motion cue
    out.push({
      target: m.title, shape: 'note', alertness: 'insight', tone: 'warn',
      reach: 0.6, text: `you're at <b>${m.pct}%</b> here — worth a review`,
    })
  }
  for (const r of s.longReads) {
    out.push({
      target: targetOf(r.key, r.title), shape: 'note', alertness: 'insight', tone: 'warn', bigNumber: true,
      reach: 0.4, text: `<b>${r.pages} pages</b> — start early`,
    })
  }
  if (s.startHere) {
    out.push({
      target: targetOf(s.startHere.key, s.startHere.title), shape: 'note', alertness: 'this-week', tone: 'info', bigNumber: true,
      urgency: 0.7, text: 'start <b>here</b> next', emphasis: 'shine',
    })
  }
  for (const n of s.noImprovement) {
    // marching dots already carry the motion — no emphasis on top (would double up)
    out.push({
      target: n.title, shape: 'note', alertness: 'this-week', tone: 'warn', urgency: 0.6,
      text: `${n.attempts} tries, no movement — office hours?`,
    })
  }
  for (const a of s.absenceGap) {
    out.push({
      target: `session:${a.sessionTitle}`, shape: 'note', alertness: 'insight', tone: 'warn', reach: 0.7,
      text: `you missed this — <b>${a.topic}</b> was taught here`,
    })
  }
  for (const w of s.slowWrong) {
    out.push({
      target: w.title, shape: 'note', alertness: 'insight', tone: 'warn', reach: 0.5,
      text: `slow <b>and</b> wrong on ${w.skill} — comprehension, not carelessness`,
    })
  }
  for (const t of s.masteryTrend) {
    const up = t.to >= t.from
    out.push({
      target: t.targetTitle, shape: 'note', alertness: 'insight', tone: up ? 'ok' : 'warn',
      reach: clamp01(Math.abs(t.to - t.from) / 30),
      text: up ? `your mastery ${trendPair(t.from, t.to)} — keep going` : `mastery slipping — ${trendPair(t.from, t.to)}`,
    })
  }
  for (const c of s.newSinceVisit) {
    out.push({ target: targetOf(c.key, c.title), shape: 'mark', alertness: 'ambient', tone: 'info', text: 'new since your last visit', engagement: true })
  }
  // ── Part II coverage signals (S15–S18) ─────────────────────────
  for (const d of s.selfStudyRemainder) {
    // Arguably the single most useful new signal: it tells a student exactly
    // which part of a deck was never taught (§13.2, Appendix B S17).
    out.push({
      target: d.title, shape: 'note', alertness: 'insight', tone: 'warn',
      reach: clamp01(1 - d.covered / Math.max(d.total, 1)),
      text: `class stopped at <b>slide ${d.covered}</b> — the rest is on you`,
    })
  }
  if (s.checkAvailable) {
    out.push({
      target: s.checkAvailable.title, shape: 'note', alertness: 'ambient', tone: 'info',
      text: '2-min check — mark this one done', engagement: true,
    })
  }
  if (s.coverageVsDelivery) {
    out.push({
      target: `module:${s.coverageVsDelivery.title}`, shape: 'note', alertness: 'insight', tone: 'info',
      reach: clamp01(1 - s.coverageVsDelivery.pct / 100),
      text: `you're <b>${s.coverageVsDelivery.pct}%</b> through what's been taught`,
    })
  }
  // ── Slice 4 — heard in class (S20/S21/S22, always with the verbatim quote) ──
  for (const c of s.spokenClaims) {
    if (c.kind === 'exam_scope') continue // no map twin — Athena answers scope (U24)
    const target = `session:${c.sessionTitle}`
    const q = spokenQuote(c.quote)
    if (c.kind === 'commitment') {
      /* The student twin of P14, and the more useful half: the students who were
         absent, or weren't listening, never got the announcement. "announced"
         names the kind — every note on a session node was "said in class". The
         slide anchor stays: unlike the professor, the student can't verify a
         clipped promise from memory, so the slide is their only handle in. */
      out.push({
        target, shape: 'note', alertness: 'this-week', tone: 'warn', urgency: 0.7,
        text: `announced in class — ${q} (slide ${c.slide})`,
      })
    } else if (c.kind === 'emphasis') {
      // The one thing a student cannot reconstruct from the slides afterwards.
      // S21 rides the node-emphasis channel like its professor twin (§4.1).
      out.push({
        target, shape: 'note', alertness: 'insight', tone: 'warn', reach: 0.8,
        text: `stressed in class — ${q}`, emphasis: 'outline',
      })
    } else {
      out.push({
        target, shape: 'note', alertness: 'insight', tone: 'info', reach: 0.6,
        text: `only explained in class — ${q}`,
      })
    }
  }
  for (const d of s.deliveryDepth) {
    out.push({
      target: d.target, shape: 'note', alertness: 'insight', tone: 'info', reach: 0.5,
      text: `class spent <b>${d.deepMinutes} min</b> on slide ${d.deepSlide} — slide ${d.skimmedSlide} got ${d.skimmedSeconds} sec`,
    })
  }
  // NB: youAreHere is emitted as a node-emphasis outline (see triageStudent), not
  // an annotation — "you are here" is a position on the card, and as an annotation
  // it lost the per-node dedup to "start here next" whenever they shared a node.
  for (const e of s.edges) {
    out.push({
      target: e.to, target2: e.from, shape: 'xref', alertness: 'structural', tone: 'info',
      text: e.kind === 'prerequisite' ? 'the prereq is here —' : 'related —',
    })
  }
  return out
}

/* ════════════════════════════════════════════════════════════════
   PUBLIC ENTRY POINTS — audience-specific, auth-selected by the page.
   ════════════════════════════════════════════════════════════════ */
export function triageProfessor(
  course: CourseModule[],
  signals: ProfSignals,
  budget?: Budget,
): { annotations: RoadmapAnnotation[]; emphasis: EmphasisSpec[] } {
  return triage(course, buildProfessorCandidates(signals), budget)
}

export function triageStudent(
  course: CourseModule[],
  signals: StuSignals,
  budget?: Budget,
): { annotations: RoadmapAnnotation[]; emphasis: EmphasisSpec[] } {
  const marker = signals.youAreHere
    ? { target: targetOf(signals.youAreHere.key, signals.youAreHere.title), tone: 'info' as const }
    : undefined
  return triage(course, buildStudentCandidates(signals), budget, marker)
}
