/**
 * Roadmap Class Lens — the professor's whole-class ⇄ one-student switch on the
 * redesigned roadmap, plus the Class analytics drawer. Port of the old
 * roadmap's "Overlay journey" dropdown + StudentJourneyRoster modal into the
 * prototype's design language (design locked in
 * tmp/roadmap-ui-concepts/index_final.html §13; styles in
 * roadmap-prototype.css §16).
 *
 * Data is the same as the old controls: getStudentJourneys (ownership-checked,
 * read-only) for the roster + per-node journeys, ConceptAnalyticsData for the
 * "By concept" tab. Selecting a student is a pure client-side view swap —
 * RoadmapPrototype paints the overlay via JourneyOverlayContext.
 *
 * Type: Client Components (rendered inside RoadmapPrototype, professor only)
 */
'use client'

import { createContext, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { statesForKeys, type JourneyState, type NodeJourney } from '@/lib/roadmap/journey-state'
import { masteryTier, scoreLabel } from '@/lib/skills/mastery'
import { medianScore, percentProficient, percentAtRisk } from '@/lib/skills/scoring'
import { studentScoresForSkill } from '@/lib/skills/aggregate'
import { getStudentDossier, generateStudentDossierSummary, refreshClassInsights, getClassInsightsRefreshStatus, generateClassInsightSummary, type ClassRefreshState, type ConceptAnalyticsData, type StudentDossierData, type StudentJourneysData, type StudentJourneyRow } from './actions'
import type { DossierLateItem } from '@/lib/roadmap/dossier'

/* ── the overlay contract with RoadmapPrototype ──────────────────────────────
   null = lens off (whole class); a map = the selected student's per-node
   journey. Card wrappers look their `Resource.key` up; no entry → the card
   carries no mastery signal → dimmed "not yet covered" (the old canvas rule). */
export const JourneyOverlayContext = createContext<Record<string, NodeJourney> | null>(null)

/** JourneyState → the jo-* class token the prototype CSS paints. */
export const JOURNEY_CLASS: Record<JourneyState, string> = {
  mastered: 'mastered',
  review_next: 'review',
  in_progress: 'prog',
  not_started: 'not',
}

/* journey-state colours in the prototype's own token set (mastered = success,
   review = warning, in progress = info) */
const JSTATE: Record<JourneyState, { c: string; l: string }> = {
  mastered: { c: '#10b981', l: 'Mastered' },
  review_next: { c: '#f59e0b', l: 'Review next' },
  in_progress: { c: 'oklch(0.56 0.19 260)', l: 'In progress' },
  not_started: { c: 'oklch(0.75 0.015 250)', l: 'Not started' },
}
const JORDER: JourneyState[] = ['mastered', 'review_next', 'in_progress', 'not_started']
export const JOURNEY_COLOR: Record<JourneyState, string> = {
  mastered: JSTATE.mastered.c,
  review_next: JSTATE.review_next.c,
  in_progress: JSTATE.in_progress.c,
  not_started: JSTATE.not_started.c,
}

/* overall standing → label + tone, in the prototype's hex/oklch tokens */
const STANDING: Record<StudentJourneyRow['overall'], { l: string; c: string }> = {
  excelling: { l: 'Excelling', c: '#10b981' },
  on_track: { l: 'On track', c: 'oklch(0.56 0.19 260)' },
  needs_support: { l: 'Needs support', c: '#ef4444' },
  not_started: { l: 'No data yet', c: '#94a3b8' },
}

/* mastery-tier hues for the By-concept tab (mirrors TIER in RoadmapPrototype) */
const TIER_COLOR: Record<string, string> = { weak: '#ef4444', shaky: '#f59e0b', strong: '#10b981', none: '#94a3b8' }

/* avatar hues — the session facepile palette, reused for the roster */
const FACE_COLORS = ['#7c5cd6', '#2f9e6e', '#d6708b', '#4a6fd0']
const faceColor = (i: number) => FACE_COLORS[i % FACE_COLORS.length]

/** 4-state mix → the conic-gradient donut (the skill pill's donut, journey-coloured). */
function JourneyDonut({ counts }: { counts: Record<JourneyState, number> }) {
  const total = JORDER.reduce((a, k) => a + counts[k], 0)
  if (!total) return null
  const active = JORDER.filter((k) => counts[k])
  const cums = active.reduce<number[]>((arr, k) => [...arr, (arr[arr.length - 1] ?? 0) + counts[k]], [])
  const stops = active.map((k, i) =>
    `${JSTATE[k].c} ${((cums[i] - counts[k]) / total) * 360}deg ${(cums[i] / total) * 360}deg`,
  ).join(', ')
  return <b className="donut" style={{ background: `conic-gradient(${stops})` }} />
}

/* the tiny bar-chart glyph (the session tiles' poll glyph, reused as the
   analytics mark) — tint via the `tint` colour */
const BarsGlyph = ({ tint }: { tint: string }) => (
  <span className="ig pollg" style={{ '--ti': tint } as React.CSSProperties}>
    <i style={{ height: 5 }} /><i style={{ height: 10 }} /><i style={{ height: 7 }} />
  </span>
)

/* ════════════════════════════════════════════════════════════════
   THE DOCK — fixed top-center pill; whole class by default, dropdown
   to pick a student or open the analytics drawer.
   ════════════════════════════════════════════════════════════════ */
interface ClassLensDockProps {
  journeys: StudentJourneysData | null
  loading: boolean
  selected: StudentJourneyRow | null
  /** lazy-load the journeys (no-op once loaded) — fired when the menu opens. */
  onEnsure: () => void
  onSelect: (studentId: string | null) => void
  onOpenAnalytics: () => void
}

export const ClassLensDock = memo(function ClassLensDock({ journeys, loading, selected, onEnsure, onSelect, onOpenAnalytics }: ClassLensDockProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  /* click outside / Escape closes the menu */
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const toggle = () => {
    setOpen((o) => !o)
    if (!open) onEnsure()
  }
  const pick = (id: string | null) => { setOpen(false); onSelect(id) }

  const students = useMemo(() => journeys?.students ?? [], [journeys])
  const classCounts = useMemo(() => {
    const c: Record<JourneyState, number> = { mastered: 0, review_next: 0, in_progress: 0, not_started: 0 }
    for (const s of students) for (const k of JORDER) c[k] += s.counts[k]
    return c
  }, [students])

  return (
    <div ref={rootRef} className={`lensdock${open ? ' open' : ''}`}>
      <button type="button" className="lpill" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {selected ? (
          <>
            <span className="jav" style={{ '--a': faceColor(students.indexOf(selected)) } as React.CSSProperties}>{selected.initials}</span>
            <span className="who">viewing <b>{selected.name}</b></span>
          </>
        ) : (
          <>
            <span className="facepile" aria-hidden>
              {students.slice(0, 3).map((s, i) => <i key={s.studentId} style={{ '--a': faceColor(i) } as React.CSSProperties}>{s.initials}</i>)}
              {students.length > 3 ? <i className="more">+{students.length - 3}</i> : null}
            </span>
            <span className="who">viewing <b>whole class</b></span>
          </>
        )}
        {loading ? <Loader2 className="lspin" aria-hidden /> : <ChevronDown className="chev" aria-hidden />}
      </button>

      {open && (
        <div className="lensmenu" role="menu">
          <div className="lhead">
            {journeys ? `CLASS LENS · ${journeys.classStats.totalStudents} STUDENTS` : 'CLASS LENS · LOADING…'}
          </div>
          {/* .lbody is the scroll box. The footer used to be a sticky child of .lensmenu and
              floated over the last student at any scroll offset short of the bottom, so a
              click aimed at that student opened analytics instead (#768). */}
          <div className="lbody">
          <button type="button" role="menuitem" className={`lrow${!selected ? ' on' : ''}`} onClick={() => pick(null)}>
            <span className="lgroup" aria-hidden>
              {(students.length ? students.slice(0, 3) : [0, 1, 2]).map((s, i) => (
                <i key={typeof s === 'number' ? s : s.studentId} style={{ '--a': faceColor(i) } as React.CSSProperties} />
              ))}
            </span>
            <span className="lmeta">
              <span className="nm">Whole class</span>
              <span className="sub">class heat &amp; annotations</span>
            </span>
            <span className="pct">
              <JourneyDonut counts={classCounts} />
              {journeys?.classStats.classMastery != null ? `${journeys.classStats.classMastery}%` : '—'}
              {!selected ? <span className="tick">✓</span> : null}
            </span>
          </button>
          {students.map((s, i) => {
            const std = STANDING[s.overall]
            const on = selected?.studentId === s.studentId
            return (
              <button key={s.studentId} type="button" role="menuitem" className={`lrow${on ? ' on' : ''}`} onClick={() => pick(s.studentId)}>
                <span className="jav" style={{ '--a': faceColor(i) } as React.CSSProperties}>{s.initials}</span>
                <span className="lmeta">
                  <span className="nm">{s.name}</span>
                  <span className="sub" style={{ color: std.c }}>{std.l}</span>
                </span>
                <span className="pct">{s.masteryPct != null ? `${s.masteryPct}%` : '—'}{on ? <span className="tick">✓</span> : null}</span>
              </button>
            )
          })}
          {journeys && students.length === 0 ? <div className="lempty">No students enrolled yet.</div> : null}
          </div>
          <div className="lfoot">
            <button type="button" className="go-anal" onClick={() => { setOpen(false); onOpenAnalytics() }}>
              <BarsGlyph tint="#fff" />Open class analytics
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

/* ════════════════════════════════════════════════════════════════
   THE LENS STRIP — "viewing a student, read-only" banner + the
   4-state legend (port of the old banner + JourneyLegend).

   CURRENTLY UNMOUNTED (see the parked render in RoadmapPrototype):
   the dock pill already names the viewed student, so the strip was
   redundant chrome — but its legend (Mastered · Review next · In
   progress · Not started · Not yet covered) is the only place those
   overlay colours are ever named. Keep this component until the
   legend's new home is decided.
   ════════════════════════════════════════════════════════════════ */
export function LensStrip({ student, index, onClear }: { student: StudentJourneyRow; index: number; onClear: () => void }) {
  return (
    <div className="lenstrip">
      <span className="jav" style={{ '--a': faceColor(index) } as React.CSSProperties}>{student.initials}</span>
      <span className="msg">viewing <b>{student.name}</b>&rsquo;s journey</span>
      <span className="rotag">READ-ONLY</span>
      <span className="leg">
        {JORDER.map((k) => <span key={k}><i style={{ '--jc': JSTATE[k].c } as React.CSSProperties} />{JSTATE[k].l}</span>)}
        <span><i className="nc" />Not yet covered</span>
      </span>
      <button type="button" className="back" aria-label="Back to whole class" title="Back to whole class" onClick={onClear}>
        <X aria-hidden />
      </button>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════
   THE ANALYTICS DRAWER — slides up from the canvas' bottom edge.
   By student: stat tiles + the roster (per-module journey pips,
   overall mastery bar, quiz avg). By skill: curated skills ranked
   weakest-first; a row expands to the per-student distribution
   (median · proficient · at risk · every student's score). Port of
   StudentJourneyRoster + ClassConceptPanel, restyled; header echoes
   RoadmapNodeModal's anatomy.
   ════════════════════════════════════════════════════════════════ */
interface ClassAnalyticsDrawerProps {
  open: boolean
  onClose: () => void
  sectionId: string
  journeys: StudentJourneysData | null
  concepts: ConceptAnalyticsData | null
}

/** "Week 3" → "W3"; anything else (manual "Module" groups) → "M{n}". */
const shortWeekLabel = (label: string, i: number) => {
  const m = /^week\s+(\d+)$/i.exec(label.trim())
  return m ? `W${m[1]}` : `M${i + 1}`
}

interface RankedSkill { id: string; name: string; score: number; tier: string; atRisk: number }

/** One skill row: the ranked headline, expanding to the per-student
 *  distribution (median · proficient · at risk · each student's score) —
 *  the port of ClassConceptPanel's ConceptRow drill-down. */
function SkillRow({ row, concepts }: { row: RankedSkill; concepts: ConceptAnalyticsData }) {
  const [open, setOpen] = useState(false)
  /* per-student scores only when expanded (same laziness as the old modal);
     weakest first, no-data students at the bottom */
  const entries = useMemo(() => {
    if (!open) return []
    return studentScoresForSkill(concepts.topics, concepts.masteryRows, concepts.roster, row.id)
      .sort((a, b) => {
        if (a.score == null && b.score == null) return 0
        if (a.score == null) return 1
        if (b.score == null) return -1
        return a.score - b.score
      })
  }, [open, concepts, row.id])
  const scores = entries.map((e) => e.score)
  const median = medianScore(scores)
  const prof = percentProficient(scores, concepts.proficientThreshold)
  const risk = percentAtRisk(scores, concepts.atRiskThreshold)
  return (
    <div className={`crow${open ? ' open' : ''}`} style={{ '--tc': TIER_COLOR[row.tier] } as React.CSSProperties}>
      <button type="button" className="chead" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="car" aria-hidden>›</span>
        <span className="cn">{row.name}</span>
        <span className="tchip">{row.tier}</span>
        <span className="cbar"><i style={{ width: `${row.score}%` }} /></span>
        <span className="cnum">{row.score}</span>
        <span className="crisk">{row.atRisk ? `${row.atRisk} at risk` : 'no one at risk'}</span>
      </button>
      {open && (
        <div className="cbody">
          <div className="cstats">
            <span>{concepts.metricLabel} <b>{scoreLabel(median)}</b></span>
            <span>proficient <b style={{ color: TIER_COLOR.strong }}>{prof == null ? '—' : `${Math.round(prof)}%`}</b></span>
            <span>at risk <b style={{ color: TIER_COLOR.weak }}>{risk == null ? '—' : `${Math.round(risk)}%`}</b></span>
          </div>
          {entries.map((e) => {
            const t = masteryTier(e.score)
            return (
              <div key={e.id} className="srow">
                <span className="sn">{e.name}</span>
                <span className="sbar"><i style={{ width: `${e.score == null ? 0 : Math.round(e.score)}%`, background: TIER_COLOR[t] }} /></span>
                <span className="spct" style={{ color: e.score == null ? undefined : TIER_COLOR[t] }}>{scoreLabel(e.score)}</span>
                {e.score != null && e.score < concepts.atRiskThreshold
                  ? <span className="satrisk">at risk</span>
                  : <span className="satrisk ghost" aria-hidden />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const ClassAnalyticsDrawer = memo(function ClassAnalyticsDrawer({ open, onClose, sectionId, journeys, concepts }: ClassAnalyticsDrawerProps) {
  const [tab, setTab] = useState<'students' | 'concepts'>('students')

  /* Build the body on FIRST open, and keep it after. The roster is the biggest
     subtree on the canvas — one pip per node, per module, per student — and
     `ranked` below walks every mastery row once per skill. Behind a closed
     drawer that was pure cost on every roadmap visit. Latched during render so
     the body lands in the SAME commit that flips the drawer open. */
  const [everOpened, setEverOpened] = useState(false)
  if (open && !everOpened) setEverOpened(true)

  /* THE CLASS NARRATIVE — the whole-class twin of the dossier card's AI
     summary, and the same contract: labelled AI, cheap to skip, and every
     figure it quotes is in the tiles / tabs / roster below it. Fetched on FIRST
     open (never behind a closed drawer); the server hash-caches per section, so
     a re-open is free and the model only runs when the class numbers moved. */
  const [summary, setSummary] = useState<{ text: string; at: string } | null>(null)
  /* 'unavailable' is NOT 'error'. The action refuses when the section has an
     empty roster or nothing graded, and that refusal is a fact about the course,
     not a failure. Rendering it as an error gave the professor a Try again
     button that could never succeed. */
  const [summaryState, setSummaryState] = useState<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null)
  /* the retry goes through the EFFECT (bumping this) rather than calling the
     action directly, so it inherits the cancellation token and the shimmer
     ceiling instead of needing its own copy of both */
  const [attempt, setAttempt] = useState(0)
  const summaryBoxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!everOpened) return
    const token = { cancelled: false }
    /* ceiling on the shimmer: a hung model call flips to the error copy (which
       carries the retry) instead of breathing forever */
    const ceiling = setTimeout(() => {
      setSummaryState((s) => (s === 'loading' ? 'error' : s))
    }, 45_000)
    void (async () => {
      setSummaryState('loading')
      /* The try/catch is load-bearing, not defensive habit: a server action
         REJECTS rather than returning { error } when the request itself fails
         (dropped connection, expired session, a bad response Next can't
         decode). Unhandled, that leaves the panel shimmering with no error copy
         and therefore no retry — for the rest of the session, since reopening
         the drawer can't re-fire an effect gated on `everOpened`. */
      try {
        const gen = await generateClassInsightSummary(sectionId)
        if (token.cancelled) return
        if (gen.data) {
          setSummary({ text: gen.data.summary, at: gen.data.generatedAt })
          setSummaryState('ready')
        } else if (gen.error) {
          // A stated reason, not a broken read. No retry: nothing to retry.
          setUnavailableReason(gen.error)
          setSummaryState('unavailable')
        } else {
          setSummaryState('error')
        }
      } catch {
        if (!token.cancelled) setSummaryState('error')
      }
    })()
    return () => { token.cancelled = true; clearTimeout(ceiling) }
  }, [everOpened, sectionId, attempt])

  /* Escape closes (only while open) */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /* Focus must LEAVE the drawer when it closes.
     The panel goes `aria-hidden` while staying mounted (it animates out), so a
     button inside it that still holds focus makes Chromium log "Blocked
     aria-hidden on an element because its descendant retained focus" — and the
     reader's next Tab carries on from inside a drawer that is no longer there.
     Restore focus to whatever had it before opening; fall back to blurring, which
     at least sends the next Tab back to the top of the page. */
  const panelRef = useRef<HTMLDivElement | null>(null)
  const returnFocusTo = useRef<HTMLElement | null>(null)
  /* useLayoutEffect, not useEffect (#589 part 1). This restore already existed and the
     warning was still reported: a passive effect runs AFTER paint, so the panel is already
     rendered aria-hidden with focus still inside it by the time focus moves, and Chromium
     has logged the conflict. A layout effect runs after the DOM mutation but before paint,
     which is the only window where moving focus out gets ahead of the browser's check. */
  useLayoutEffect(() => {
    if (open) {
      const active = document.activeElement
      returnFocusTo.current =
        active instanceof HTMLElement && !panelRef.current?.contains(active) ? active : null
      return
    }
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !panelRef.current?.contains(active)) return
    if (returnFocusTo.current?.isConnected) returnFocusTo.current.focus()
    else active.blur()
  }, [open])

  /* By skill: ranked weakest-first with an at-risk head-count per skill —
     same data + helpers as ClassConceptPanel; rows expand to the
     per-student distribution (SkillRow). */
  const ranked = useMemo<RankedSkill[]>(() => {
    if (!concepts || !everOpened) return []
    return concepts.view.ranked
      .filter((row) => row.classScore != null)
      .map((row) => ({
        id: row.skillId,
        name: row.name,
        score: Math.round(row.classScore as number),
        tier: masteryTier(row.classScore),
        atRisk: studentScoresForSkill(concepts.topics, concepts.masteryRows, concepts.roster, row.skillId)
          .filter((e) => e.score != null && e.score < concepts.atRiskThreshold).length,
      }))
  }, [concepts, everOpened])

  const weeks = useMemo(() => (journeys?.weeks ?? []).filter((w) => w.nodeKeys.length > 0), [journeys])
  const stats = journeys?.classStats

  return (
    <>
      <div className={`ascrim${open ? ' on' : ''}`} aria-hidden onClick={onClose} />
      {/* `inert`, not `aria-hidden`: the panel stays mounted so it can animate out, and
          aria-hidden over a subtree that still holds focus is exactly what Chromium
          refuses ("Blocked aria-hidden on an element because its descendant retained
          focus"). The focus-restore effect below cannot prevent that warning — it is a
          passive effect, so it runs after React has already written the attribute. `inert`
          is the attribute meant for this: it hides the subtree AND moves focus out itself,
          so the two can never disagree. */}
      <div ref={panelRef} className={`analytics${open ? ' on' : ''}`} role="dialog" aria-modal="true" aria-label="Class analytics" inert={!open}>
        <div className="ahead">
          <span className="hgrp">
            <span className="akick">{stats ? `${stats.totalStudents} STUDENTS` : 'LOADING…'}</span>
            <span className="atitle">Class analytics</span>
          </span>
          <button type="button" className="aclose" aria-label="Close" onClick={onClose}><X aria-hidden /></button>
        </div>
        <div className="atabs">
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'students'} className={tab === 'students' ? 'on' : ''} onClick={() => setTab('students')}>By student</button>
            <button type="button" role="tab" aria-selected={tab === 'concepts'} className={tab === 'concepts' ? 'on' : ''} onClick={() => setTab('concepts')}>By skill</button>
          </div>
        </div>

        <div className="abody">
          {/* Above the tabs' content, not inside a tab: the narrative is about
              the class either way, so it must not vanish when the professor
              switches to "By skill". Same .sdai panel as the dossier card, so
              the two AI summaries read as one thing in two scopes. */}
          {everOpened && (
            <div className="sdai">
              <span className="sdlab">
                <span aria-hidden>✦ </span>
                <span className="sdlt">
                  AI summary
                  {summaryState === 'loading' ? ' · writing…'
                    : summaryState === 'ready' && summary ? ` · updated ${agoTail(summary.at)}` : ''}
                </span>
              </span>
              {/* The live region announces that the summary ARRIVED; it does not
                  carry the prose. Piping ~100 words through aria-live reads the
                  whole narrative aloud, unprompted, over a dialog that just
                  announced itself — so a reader navigating the roster gets
                  interrupted by a paragraph they didn't ask for. The prose sits
                  below, reachable when they want it. */}
              <span className="sdsr" role="status" aria-live="polite">
                {summaryState === 'ready' ? 'Class summary ready'
                  : summaryState === 'unavailable' ? 'No class summary to write yet'
                  : summaryState === 'error' ? 'Class summary unavailable'
                  /* `attempt > 0` keeps the FIRST open silent — nobody asked for
                     that one, and the shimmer already says it. After a Try again
                     the loading state must be audible, or a retry that fails
                     again announces nothing and the click reads as dead. */
                  : attempt > 0 ? 'Writing class summary…' : ''}
              </span>
              <div className="sdaibox" ref={summaryBoxRef} tabIndex={-1} aria-busy={summaryState === 'loading'}>
                {summaryState === 'ready' && summary ? (
                  <p>{boldFigures(summary.text)}</p>
                ) : summaryState === 'unavailable' ? (
                  <p className="sderr">{unavailableReason}</p>
                ) : summaryState === 'error' ? (
                  <p className="sderr">
                    Couldn&rsquo;t write the class summary — the numbers below are still current.
                    {/* focus moves to the panel, not nowhere: the button unmounts
                        the moment the retry starts, and without this the active
                        element falls to <body> — outside the aria-modal drawer,
                        so the reader's next Tab lands behind the scrim. */}
                    <button type="button" onClick={() => { setAttempt((a) => a + 1); summaryBoxRef.current?.focus() }}><RefreshCw aria-hidden /> Try again</button>
                  </p>
                ) : (
                  /* eight bars, not the card's three: the drawer reserves the
                     full prose height, so the shimmer has to fill it (§16 CSS) */
                  <span className="sdsk" role="img" aria-label="Writing summary…">
                    <i /><i /><i /><i /><i /><i /><i /><i />
                  </span>
                )}
              </div>
            </div>
          )}
          {!everOpened ? null : tab === 'concepts' ? (
            !concepts ? (
              <div className="aempty">Couldn&rsquo;t load skill analytics.</div>
            ) : ranked.length === 0 ? (
              <div className="aempty">
                {concepts.view.ranked.length === 0
                  /* Names no control: "Tracked skills" is hidden while the lens
                     views one student, and this empty state is reachable from
                     there — an instruction pointing at nothing reads as broken. */
                  ? 'No skills set up yet — set them up from the whole-class view.'
                  : 'No mastery data yet — skills appear here once activities are graded.'}
              </div>
            ) : (
              <>
                <div className="aleg">
                  {(['weak', 'shaky', 'strong'] as const).map((t) => (
                    <span key={t}><i style={{ background: TIER_COLOR[t] }} />{t[0].toUpperCase() + t.slice(1)}</span>
                  ))}
                </div>
                {ranked.map((row) => <SkillRow key={row.id} row={row} concepts={concepts} />)}
                <div className="afoot">curated skills ranked weakest-first — click one for the per-student breakdown</div>
              </>
            )
          ) : !journeys || !stats ? (
            <div className="aempty"><Loader2 className="lspin" aria-hidden /> Loading class data…</div>
          ) : (
            <>
              <div className="atiles">
                <div className="tile">
                  <div className="tl">CLASS MASTERY</div>
                  <div className="tv">
                    <JourneyDonut counts={journeys.students.reduce((acc, s) => { for (const k of JORDER) acc[k] += s.counts[k]; return acc }, { mastered: 0, review_next: 0, in_progress: 0, not_started: 0 } as Record<JourneyState, number>)} />
                    {stats.classMastery != null ? `${stats.classMastery}%` : '—'}
                  </div>
                  <div className="ts">avg across students</div>
                </div>
                <div className="tile"><div className="tl">EXCELLING</div><div className="tv">{stats.excelling}</div><div className="ts">≥ 80% mastery</div></div>
                <div className="tile"><div className="tl">NEEDS SUPPORT</div><div className="tv">{stats.needsSupport}</div><div className="ts">below the bar</div></div>
                <div className="tile"><div className="tl">QUIZ AVG</div><div className="tv">{stats.classQuizAvg != null ? `${stats.classQuizAvg}%` : '—'}</div><div className="ts">class quiz average</div></div>
              </div>

              {journeys.students.length === 0 ? (
                <div className="aempty">No students are enrolled in this section yet.</div>
              ) : (
                <>
                  <div className="aroster">
                    <div className="amin">
                      <div className="arhead">
                        <span className="hwho">STUDENT</span>
                        <span className="hmods">MODULE JOURNEY</span>
                        <span className="hbar">OVERALL</span>
                        <span className="hqz">QUIZ</span>
                      </div>
                      {journeys.students.map((s, i) => {
                        const std = STANDING[s.overall]
                        const total = JORDER.reduce((a, k) => a + s.counts[k], 0)
                        /* read-only rows — a student is overlaid from the
                           "viewing whole class" dock's dropdown, not from here */
                        return (
                          <div key={s.studentId} className="arow">
                            <span className="acol-who">
                              <span className="jav" style={{ '--a': faceColor(i) } as React.CSSProperties}>{s.initials}</span>
                              <span className="lmeta">
                                <span className="nm">{s.name}</span>
                                <span className="std" style={{ '--sc': std.c } as React.CSSProperties}><i />{std.l}</span>
                              </span>
                            </span>
                            <span className="acol-mods">
                              {weeks.map((w, wi) => (
                                <span key={w.key} className="mgrp">
                                  <span className="pips">
                                    {statesForKeys(s.nodes, w.nodeKeys).map((state, pi) => (
                                      <i key={pi} className="pip" title={JSTATE[state].l} style={{ '--pc': JSTATE[state].c } as React.CSSProperties} />
                                    ))}
                                  </span>
                                  <span className="ml">{shortWeekLabel(w.label, wi)}</span>
                                </span>
                              ))}
                            </span>
                            <span className="acol-bar">
                              <span className="bl"><span>mastery</span><b>{s.masteryPct != null ? `${s.masteryPct}%` : '—'}</b></span>
                              <span className="jbar">
                                {total > 0 ? JORDER.filter((k) => s.counts[k] > 0).map((k) => (
                                  <i key={k} style={{ '--jc': JSTATE[k].c, width: `${((s.counts[k] / total) * 100).toFixed(1)}%` } as React.CSSProperties} />
                                )) : null}
                              </span>
                            </span>
                            <span className="acol-qz">{s.quizAvg != null ? `${s.quizAvg}%` : '—'}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
})

/* ════════════════════════════════════════════════════════════════
   THE STUDENT DOSSIER — the floating card that answers "how is this
   student doing?" the moment the lens views them (styles: §21).

   Geometry is deliberate (chosen from the four variants + the LMS
   research pass): the card FLOATS over the canvas' left edge with
   zero reflow — the map keeps its size, zoom and scroll, and is
   never dimmed (Blackboard's peeking-layer rule: the context behind
   a panel stays readable). Narrative first but visibly labelled AI
   and cheap to skip; every number it may quote sits directly
   beneath it as the audit trail. ‹ › walk the roster without
   leaving the card (Canvas Grade Detail Tray's arrows).
   ════════════════════════════════════════════════════════════════ */

/* avatar_url is student-writable — only load it from our own storage origin,
   otherwise fall back to initials. An arbitrary host here would let a student
   observe when (and from where) their professor opens their dossier. */
const SUPABASE_ORIGIN = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const safeAvatarUrl = (url: string | null): string | null =>
  url && SUPABASE_ORIGIN && url.startsWith(`${SUPABASE_ORIGIN}/storage/`) ? url : null

/** "+2d late" / "+5h late" / "+20m late" from seconds. */
function fmtLate(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  if (d >= 1) return `+${d}d late`
  const h = Math.floor(seconds / 3600)
  if (h >= 1) return `+${h}h late`
  return `+${Math.max(1, Math.floor(seconds / 60))}m late`
}

/** "just now" / "2h ago" / "3d ago" / "2w ago" — hour-precise while fresh. */
function agoTail(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 60) return 'just now'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

/** The summary's **figures** as real <b> elements — split-based, so the model
 *  output stays plain TEXT throughout (never parsed as HTML). */
function boldFigures(text: string): React.ReactNode[] {
  return text.split(/\*\*([^*]+)\*\*/g).map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))
}

/**
 * A tile's "vs class" line. Three deliberate rules:
 *
 * - **The WORDS carry the direction** ("ahead of class" / "behind class"), so
 *   colour and the arrow are reinforcement. A screen reader hears the verdict,
 *   and "▴ class 20%" can't be misread as the class trending up.
 * - **A deadband.** Inside `band` points the two are "same as class" and stay
 *   neutral — on a 39-item denominator one file is 2.6 points, so a strict
 *   `!==` let a single click flip the tile between green and red.
 * - **`scoreAhead={false}` for effort measures.** Beating a low class average
 *   at opening material is not good news; a green ▴ on 8-of-39 would suppress
 *   exactly the attention the tile exists to attract. Ahead still reports,
 *   just without the congratulation.
 * - **`klassLabel`** swaps how the class value is DISPLAYED (e.g. a fraction
 *   on a counted tile) — the comparison itself always runs on the numbers.
 */
function VsClass({ mine, klass, band = 3, scoreAhead = true, klassLabel }: {
  mine: number | null
  klass: number | null
  band?: number
  scoreAhead?: boolean
  klassLabel?: string
}) {
  if (mine == null || klass == null) return <span className="sdsub">no class data</span>
  const shown = klassLabel ?? `${klass}%`
  if (Math.abs(mine - klass) <= band) return <span className="sdsub">same as class ({shown})</span>
  const ahead = mine > klass
  const tone = ahead ? (scoreAhead ? ' up' : '') : ' down'
  return (
    <span className={`sdsub${tone}`}>
      <span aria-hidden>{ahead ? '▴' : '▾'} </span>{ahead ? 'ahead of' : 'behind'} class ({shown})
    </span>
  )
}

/** Cooldown state + hours until the next manual refresh, computed once at
 *  set time (Date.now() is impure during render). */
function withHours(state: ClassRefreshState): ClassRefreshState & { hoursLeft: number } {
  const hoursLeft = state.cooldownUntil
    ? Math.max(0, Math.ceil((new Date(state.cooldownUntil).getTime() - Date.now()) / 3_600_000))
    : 0
  return { ...state, hoursLeft }
}

/* which arrow moved the lens — module-scoped so it survives the card's
   per-student remount; read once by the incoming card's focus restore */
let lastNavDir: 'prev' | 'next' | null = null

interface StudentDossierCardProps {
  student: StudentJourneyRow
  /** Roster index — the lens' avatar colour for this student. */
  index: number
  students: StudentJourneyRow[]
  classStats: StudentJourneysData['classStats'] | null
  sectionId: string
  onSelect: (studentId: string) => void
  onClear: () => void
}

export const StudentDossierCard = memo(function StudentDossierCard({ student, index, students, classStats, sectionId, onSelect, onClear }: StudentDossierCardProps) {
  /* The card is mounted with key={studentId}, so switching students REMOUNTS
     it — these initial values ARE the per-student reset (no setState-in-effect
     needed) and a previous student's card can never paint over this one. */
  const [dossier, setDossier] = useState<StudentDossierData | null>(null)
  const [failed, setFailed] = useState(false)
  const [summary, setSummary] = useState<{ text: string; at: string } | null>(null)
  const [summaryState, setSummaryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [avatarFailed, setAvatarFailed] = useState(false)
  /* bumping this re-runs the fetch effect — the whole-card "Try again" and
     the reload after a class refresh completes */
  const [attempt, setAttempt] = useState(0)
  /* enriched at SET time (not render — hooks purity) with the whole hours
     left on the cooldown, for the button's title */
  const [refresh, setRefresh] = useState<(ClassRefreshState & { hoursLeft: number }) | null>(null)
  const navRef = useRef<HTMLSpanElement>(null)

  /* the card remounts per student (key=), destroying the pressed arrow — put
     focus back on its twin so ‹ › can be pressed repeatedly (the Canvas
     Grade Detail Tray behaviour). Falls to any enabled nav button at the
     roster's ends, where the twin is disabled. */
  useEffect(() => {
    if (!lastNavDir) return
    const twin = navRef.current?.querySelector<HTMLButtonElement>(`[data-dir="${lastNavDir}"]`)
    const target = twin && !twin.disabled ? twin : navRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    target?.focus()
    lastNavDir = null
  }, [])

  /* Escape = ✕ (every other overlay on this canvas dismisses on it) — but
     yield to anything stacked above the card: the node modal, either drawer,
     the lens menu and the settings popover all own Escape first. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const root = document.querySelector('.rmproto')
      if (!root || root.classList.contains('d-open')) return
      if (root.querySelector('.ascrim.on, .lensmenu, .spop, .skillsdrawer')) return
      onClear()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClear])

  useEffect(() => {
    let cancelled = false
    /* ceiling on the shimmer: a hung model call flips to the error copy
       (which carries the retry) instead of breathing forever */
    const ceiling = setTimeout(() => {
      setSummaryState((s) => (s === 'loading' ? 'error' : s))
    }, 45_000)
    void (async () => {
      const res = await getStudentDossier(sectionId, student.studentId)
      if (cancelled) return
      if (!res.data) { setFailed(true); return }
      setFailed(false)
      setDossier(res.data)
      setRefresh(withHours(res.data.classRefresh))
      if (res.data.summary && res.data.summaryGeneratedAt) {
        setSummary({ text: res.data.summary, at: res.data.summaryGeneratedAt })
        setSummaryState('ready')
        return
      }
      // Signals changed (or first open) — write a fresh narrative.
      const gen = await generateStudentDossierSummary(sectionId, student.studentId)
      if (cancelled) return
      if (gen.data) {
        setSummary({ text: gen.data.summary, at: gen.data.generatedAt })
        setSummaryState('ready')
      } else {
        setSummaryState('error')
      }
    })()
    return () => { cancelled = true; clearTimeout(ceiling) }
  }, [sectionId, student.studentId, attempt])

  const retryAll = () => { setFailed(false); setAttempt((a) => a + 1) }

  /* while a class refresh runs, poll its job state; when it lands, reload the
     card so the fresh facts + narrative appear (the bell separately toasts
     the professor wherever they are). */
  useEffect(() => {
    if (!refresh?.active) return
    const t = setInterval(() => {
      void (async () => {
        const res = await getClassInsightsRefreshStatus(sectionId)
        if (!res.data || res.data.active) return
        setRefresh(withHours(res.data))
        setAttempt((a) => a + 1)
        /* report the outcome WHERE THE CLICK HAPPENED — "0 rewritten, all
           current" must not read as "nothing happened, and now it's locked" */
        if (res.data.lastStatus === 'failed') {
          toast.error('Couldn’t refresh the class summaries — try again in a moment.')
        } else if (res.data.lastOutcome) {
          toast.success(`Class insights refreshed — ${res.data.lastOutcome}`)
        }
      })()
    }, 8_000)
    return () => clearInterval(t)
  }, [refresh?.active, sectionId])

  /* freshness labels + cooldown hours re-evaluate once a minute, so a card
     left open doesn't claim "just now" forever or hold a lapsed cooldown */
  useEffect(() => {
    const t = setInterval(() => setRefresh((r) => (r ? withHours(r) : r)), 60_000)
    return () => clearInterval(t)
  }, [])

  const onCooldown = !refresh?.active && (refresh?.hoursLeft ?? 0) > 0

  /* disabled ONLY while a run is live — during the initial fetch (refresh
     null) the tab stays full-strength (onRefreshClick already no-ops) so it
     doesn't flash grey on every ‹ › roster step. The accessible name starts
     with the visible label (WCAG 2.5.3 Label in Name — voice control says
     "click Refresh class"). */
  const refreshDisabled = refresh?.active === true
  const refreshAria = refresh?.active
    ? 'Refreshing insights for the whole class…'
    : onCooldown
      ? `Refresh class — refreshed recently, available again in about ${refresh?.hoursLeft}h`
      : 'Refresh class — rewrite the AI summaries for every student'

  const startClassRefresh = async () => {
    const res = await refreshClassInsights(sectionId)
    if (res.error) { toast.error(res.error); return }
    toast.success('Refreshing insights for the whole class — you’ll get a notification when it finishes.')
    setRefresh((r) => ({ active: true, cooldownUntil: r?.cooldownUntil ?? null, lastStatus: r?.lastStatus ?? null, lastOutcome: null, hoursLeft: r?.hoursLeft ?? 0 }))
  }

  /* the class refresh is expensive (a model call per changed student) and
     once-a-day — so it never fires on a bare click: cooldown states explain
     themselves, everything else confirms scope + cost first */
  const onRefreshClick = () => {
    if (!refresh || refresh.active) return
    if (onCooldown) {
      toast(`Insights were refreshed recently — you can refresh again in about ${refresh.hoursLeft}h.`)
      return
    }
    toast(`Rewrite AI summaries for all ${students.length} students?`, {
      description: 'Runs in the background — available once a day.',
      action: { label: 'Refresh', onClick: () => void startClassRefresh() },
    })
  }

  const retrySummary = async () => {
    setSummaryState('loading')
    const gen = await generateStudentDossierSummary(sectionId, student.studentId)
    if (gen.data) { setSummary({ text: gen.data.summary, at: gen.data.generatedAt }); setSummaryState('ready') }
    else setSummaryState('error')
  }

  const pos = students.findIndex((s) => s.studentId === student.studentId)
  const prev = pos > 0 ? students[pos - 1] : null
  const next = pos >= 0 && pos < students.length - 1 ? students[pos + 1] : null

  const facts = dossier?.facts ?? null
  const lates: DossierLateItem[] = facts
    ? [...facts.lateAssignments, ...facts.lateQuizzes].sort((a, b) => b.lateBySeconds - a.lateBySeconds).slice(0, 5)
    : []
  const totalNodes = JORDER.reduce((s, k) => s + student.counts[k], 0)
  const std = STANDING[student.overall]
  const avatarUrl = safeAvatarUrl(dossier?.avatarUrl ?? null)

  return (
    <>
      {/* whole-class refresh — a free-standing pebble floating ABOVE the card,
          detached from it: this rewrites every student's summary, so it must not
          read as part of the one-student card. Kept clear of the ‹ › ✕ cluster
          and of the per-student retry inside the summary panel, which shares its
          glyph but costs 100× less. Confirm-first, and cooldown-guarded
          server-side (24h) so it can't stack LLM spend. */}
      <button
        type="button"
        className={`sdrb${refresh?.active ? ' busy' : ''}`}
        disabled={refreshDisabled}
        aria-label={refreshAria}
        title="Refresh AI insights for the whole class"
        onClick={onRefreshClick}
      >
        <RefreshCw aria-hidden />
        <span>{refresh?.active ? 'Refreshing…' : 'Refresh class'}</span>
      </button>
    <aside className="sdcard" aria-label={`${student.name} — student summary`}>
      <header className="sdhead">
        <span className="jav sdav" style={{ '--a': faceColor(index) } as React.CSSProperties}>
          {avatarUrl && !avatarFailed
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={avatarUrl} alt="" onError={() => setAvatarFailed(true)} />
            : student.initials}
        </span>
        <span className="sdid">
          <span className="sdname">{student.name}</span>
          {/* mockup order (the selected variant C): last-active sits between the
              name and the standing chip. The slot always renders so the header
              can't reflow when the fetch lands — a shimmer while loading, then
              the stamp, or a plain statement about our records when there is no
              signal at all (the migration backfills logins + logged events, so
              null here really does mean nothing recorded). */}
          <span className="sdlast">
            {!dossier
              ? <i className="sdlastsk" aria-hidden />
              : dossier.lastActiveAt ? `last active ${agoTail(dossier.lastActiveAt)}` : 'no activity recorded'}
          </span>
          <span className="std" style={{ '--sc': std.c } as React.CSSProperties}><i />{std.l}</span>
        </span>
        <span className="sdnav" ref={navRef}>
          <button type="button" className="sdibtn" data-dir="prev" aria-label={prev ? `Previous student: ${prev.name}` : 'No previous student'} title={prev?.name} disabled={!prev} onClick={() => { if (prev) { lastNavDir = 'prev'; onSelect(prev.studentId) } }}><ChevronLeft aria-hidden /></button>
          <button type="button" className="sdibtn" data-dir="next" aria-label={next ? `Next student: ${next.name}` : 'No next student'} title={next?.name} disabled={!next} onClick={() => { if (next) { lastNavDir = 'next'; onSelect(next.studentId) } }}><ChevronRight aria-hidden /></button>
          <button type="button" className="sdibtn" aria-label="Back to whole class" title="Back to whole class" onClick={onClear}><X aria-hidden /></button>
        </span>
      </header>

      <div className="sdscroll">
        {/* the narrative — labelled AI, the numbers beneath are its audit
            trail. "current as of" is the truthful frame: the hash check just
            confirmed these facts still match the stored prose, so age here is
            provenance, not staleness. */}
        <div className="sdai">
          <span className="sdlab">
            <span aria-hidden>✦ </span>
            <span className="sdlt">
              AI summary
              {refresh?.active ? ' · refreshing all…' : summaryState === 'ready' && summary ? ` · updated ${agoTail(summary.at)}` : ''}
            </span>
          </span>
          {/* the live region wraps ONLY the prose — the button's state flips
              must not re-announce the whole 90-word summary */}
          <div role="status" aria-live="polite" aria-busy={summaryState === 'loading'}>
            {summaryState === 'ready' && summary ? (
              <p>{boldFigures(summary.text)}</p>
            ) : summaryState === 'error' ? (
              <p className="sderr">
                Couldn&rsquo;t write the summary — the numbers below are still current.
                <button type="button" onClick={() => void retrySummary()}><RefreshCw aria-hidden /> Try again</button>
              </p>
            ) : (
              <span className="sdsk" role="img" aria-label="Writing summary…"><i /><i /><i /></span>
            )}
          </div>
        </div>

        {failed ? (
          <p className="sderr sdfetch">
            Couldn&rsquo;t load this student&rsquo;s details.
            <button type="button" onClick={retryAll}><RefreshCw aria-hidden /> Try again</button>
          </p>
        ) : (
          <>
            {/* the concrete numbers */}
            <div className="sdtiles">
              <div className="sdtile">
                <span className="sdlab">Mastery</span>
                <b>{student.masteryPct != null ? `${student.masteryPct}%` : '—'}</b>
                <VsClass mine={student.masteryPct} klass={classStats?.classMastery ?? null} />
              </div>
              <div className="sdtile">
                <span className="sdlab">Quiz avg</span>
                <b>{student.quizAvg != null ? `${student.quizAvg}%` : '—'}</b>
                <VsClass mine={student.quizAvg} klass={classStats?.classQuizAvg ?? null} />
              </div>
              <div className="sdtile">
                <span className="sdlab">Skills mastered</span>
                <b>{student.counts.mastered}<span className="sdof">/{totalNodes}</span></b>
                <span className="sdsub">map nodes with data</span>
              </div>
              {/* effort, not achievement — with the three tiles above it this
                  separates "hasn't looked" from "looked and didn't get it".
                  Late work isn't a tile: the list below names every late item
                  and carries its own total. */}
              <div className="sdtile">
                <span className="sdlab">Materials opened</span>
                {/* the count IS the value — "13%" of what is unanswerable,
                    and 5/39 invites the sanity check (the Skills tile's shape) */}
                <b>
                  {!facts ? '…' : facts.materialsOpened.total > 0
                    ? <>{facts.materialsOpened.opened}<span className="sdof">/{facts.materialsOpened.total}</span></>
                    : '—'}
                </b>
                <VsClass
                  mine={facts?.materialsOpened.pct ?? null}
                  klass={facts?.classMaterialsOpenedPct ?? null}
                  /* the class value in the tile's own unit — a fraction of the
                     same denominator, not a percent beside a count */
                  klassLabel={facts && facts.materialsOpened.total > 0 && facts.classMaterialsOpenedPct != null
                    ? `${Math.round((facts.classMaterialsOpenedPct / 100) * facts.materialsOpened.total)}/${facts.materialsOpened.total}`
                    : undefined}
                  /* one item's worth of movement is noise, not a verdict */
                  band={Math.max(3, Math.round(100 / Math.max(facts?.materialsOpened.total ?? 1, 1)))}
                  scoreAhead={false}
                />
              </div>
            </div>

            {/* journey mix over the map's nodes, in the overlay's own colours */}
            <div className="sdmix">
              <span className="jbar">
                {totalNodes > 0 ? JORDER.filter((k) => student.counts[k] > 0).map((k) => (
                  <i key={k} style={{ '--jc': JSTATE[k].c, width: `${((student.counts[k] / totalNodes) * 100).toFixed(1)}%` } as React.CSSProperties} />
                )) : null}
              </span>
              <span className="sdleg">
                {JORDER.filter((k) => student.counts[k] > 0).map((k) => (
                  <span key={k}><i style={{ '--jc': JSTATE[k].c } as React.CSSProperties} />{student.counts[k]} {JSTATE[k].l.toLowerCase()}</span>
                ))}
              </span>
            </div>

            <div className="sdlist qlist">
              <span className="sdlab">Fumbled most</span>
              {!facts ? <span className="sdnone">Loading…</span>
                : facts.fumbledQuestions.length === 0 ? <span className="sdnone">No missed quiz questions yet.</span>
                : facts.fumbledQuestions.map((f, i) => (
                  <span key={i} className="sdrow">
                    <span className="sdq" title={f.quizTitle}>Q</span>
                    <span className="sdrt" title={f.questionText}>{f.questionText}</span>
                    <span className="sdrr bad">{f.wrongCount}/{f.attempts} wrong</span>
                  </span>
                ))}
              {facts && facts.fumbledCount > facts.fumbledQuestions.length && (
                <span className="sdnone">and {facts.fumbledCount - facts.fumbledQuestions.length} more</span>
              )}
            </div>

            <div className="sdlist">
              <span className="sdlab">Late submissions</span>
              {!facts ? <span className="sdnone">Loading…</span>
                : lates.length === 0 ? <span className="sdnone">Everything on time so far.</span>
                : lates.map((l, i) => (
                  <span key={i} className="sdrow">
                    <span className={`sddot ${l.kind}`} aria-hidden />
                    <span className="sdrt">{l.title}</span>
                    <span className="sdrr bad">{fmtLate(l.lateBySeconds)}</span>
                  </span>
                ))}
              {facts && facts.lateCount > lates.length && (
                <span className="sdnone">and {facts.lateCount - lates.length} more</span>
              )}
            </div>

            <div className="sdlist">
              <span className="sdlab">Weakest skills</span>
              {!facts ? <span className="sdnone">Loading…</span>
                : facts.weakestSkills.length === 0 ? <span className="sdnone">No skill scores yet.</span>
                : facts.weakestSkills.map((w, i) => (
                  <span key={i} className="sdrow">
                    <span className="sdrt">{w.name}</span>
                    <span className="sdbar"><i style={{ width: `${w.score}%`, background: TIER_COLOR[masteryTier(w.score)] }} /></span>
                    <span className="sdrr">{w.score}%</span>
                  </span>
                ))}
            </div>
          </>
        )}
      </div>
    </aside>
    </>
  )
})
