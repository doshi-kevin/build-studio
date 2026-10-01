'use client'

/**
 * The interactive bodies of Athena's study artifacts, rendered inside the
 * roadmap's node-detail modal (NodeDetail delegates its main column here for
 * `k === 'athena'`). One component per kind, dispatched through WIDGETS — the
 * render half of the kind registry in `@/lib/athena/artifact-kinds`.
 *
 * State writes are optimistic and debounced: the widget updates instantly,
 * persists ~half a second after the last interaction (a burst of checklist
 * ticks is one write, and two fast clicks can't land out of order), and a
 * failed save keeps the UI state and says so once. Styles live in
 * roadmap-prototype.css §19 (`.aw-*`), the modal's own voice.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import type {
  ArtifactState,
  AthenaArtifactView,
  ChecklistPayload,
  Cite,
  FlashcardsPayload,
  KnowledgeMapPayload,
  PracticePayload,
  StudyGuidePayload,
} from '@/lib/athena/artifact-kinds'

interface WidgetProps {
  artifact: AthenaArtifactView
  /** Persist interaction state; absent → read-only (never the case today). */
  onSaveState?: (artifactId: string, state: ArtifactState) => Promise<{ success?: true; error?: string }>
}

const SAVE_DEBOUNCE_MS = 450

/** Athena writes these strings the same way she writes chat answers — a card
 *  back or a guide point about a formula arrives as LaTeX. Rendered `compact`
 *  and as a <span>, since every slot below sits inside phrasing content (a
 *  button face, a list item's label). */
function Text({ children }: { children: string }) {
  return <MarkdownLatex variant="compact" as="span" content={children} />
}

function useStateSaver(props: WidgetProps) {
  /* One toast per modal open, not one per failed click. */
  const warned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<ArtifactState | null>(null)
  const saveRef = useRef(props.onSaveState)
  const idRef = useRef(props.artifact.id)
  useEffect(() => {
    saveRef.current = props.onSaveState
    idRef.current = props.artifact.id
  })

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const state = pending.current
    pending.current = null
    if (!state || !saveRef.current) return
    void saveRef.current(idRef.current, state).then((res) => {
      if (res?.error && !warned.current) {
        warned.current = true
        toast.error('Couldn’t save your progress — it still counts on this screen.')
      }
    })
  }, [])
  /* Closing the modal mid-burst must not eat the last ticks. */
  useEffect(() => () => flush(), [flush])

  return useCallback((state: ArtifactState) => {
    pending.current = state
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])
}

/** The quiet "run it again" affordance — resets are cheap and private here. */
function ResetButton({ onReset, label }: { onReset: () => void; label: string }) {
  return (
    <button type="button" className="aw-reset" onClick={onReset}>{label}</button>
  )
}

/** The course page an item is drawn from — the cite-and-check source (§15.4),
 *  shown so the artifact is traceable, not a black box. Absent on legacy rows and
 *  on checklist steps, so it renders nothing when there's no cite. */
function CiteLine({ cite }: { cite?: Cite }) {
  if (!cite) return null
  return <span className="aw-cite">— {cite.material}, p.{cite.page}</span>
}

// ── Flashcards ───────────────────────────────────────────────────

function FlashcardsWidget({ artifact }: WidgetProps) {
  const cards = (artifact.payload as FlashcardsPayload).cards ?? []
  const [i, setI] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const hintId = useId()
  if (cards.length === 0) return <div className="dempty">This deck is empty.</div>
  const go = (d: number) => {
    setFlipped(false)
    setI((cur) => (cur + d + cards.length) % cards.length)
  }
  const card = cards[i]
  const face = flipped ? card.back : card.front
  return (
    <div className="aw-flash">
      <div className="dlabel">CARD {i + 1} OF {cards.length}</div>
      {/* The visible face IS the button's accessible name — no aria-label to
          shadow it. Only the active face renders, so nothing leaks the answer
          to the accessibility tree early, and a long back grows the card
          instead of spilling out of a fixed-height box. */}
      <button
        type="button"
        className={`aw-card${flipped ? ' flip' : ''}`}
        onClick={() => setFlipped((f) => !f)}
        aria-describedby={hintId}
      >
        <span key={`${i}-${flipped ? 'b' : 'f'}`} className={`aw-face ${flipped ? 'aw-back' : 'aw-front'}`}>
          <Text>{face}</Text>
        </span>
      </button>
      {/* The flip, announced — outside the button so the name stays clean. */}
      <span className="sr-only" role="status">
        {flipped ? `Answer: ${card.back}` : `Card ${i + 1}: ${card.front}`}
      </span>
      {/* Source shows on the answer side, where the fact is. */}
      {flipped ? <CiteLine cite={card.cite} /> : null}
      <div className="aw-nav">
        <button type="button" onClick={() => go(-1)} aria-label="Previous card">‹</button>
        <span className="aw-hint" id={hintId}>{flipped ? 'tap for the front' : 'tap the card to flip it'}</span>
        <button type="button" onClick={() => go(1)} aria-label="Next card">›</button>
      </div>
    </div>
  )
}

// ── Practice questions ───────────────────────────────────────────

function PracticeWidget(props: WidgetProps) {
  const { artifact } = props
  const questions = (artifact.payload as PracticePayload).questions ?? []
  const save = useStateSaver(props)
  const [answers, setAnswers] = useState<Record<string, number>>(
    () => ({ ...(artifact.state.answers ?? {}) }),
  )
  if (questions.length === 0) return <div className="dempty">This practice set is empty.</div>

  const pick = (qi: number, oi: number) => {
    if (answers[String(qi)] !== undefined) return // locked once answered
    const next = { ...answers, [String(qi)]: oi }
    setAnswers(next)
    save({ ...artifact.state, answers: next })
  }
  const reset = () => {
    setAnswers({})
    save({ ...artifact.state, answers: {} })
  }
  const answered = Object.keys(answers).length
  const correct = questions.filter((q, qi) => q.options[answers[String(qi)]]?.correct).length

  return (
    <div className="aw-quiz">
      <div className="aw-headline">
        <div className="dlabel" role="status">
          PRACTICE · {answered} of {questions.length} answered{answered > 0 ? ` · ${correct} right` : ''}
        </div>
        {answered > 0 ? <ResetButton onReset={reset} label="Try again" /> : null}
      </div>
      {questions.map((q, qi) => {
        const chosen = answers[String(qi)]
        const locked = chosen !== undefined
        return (
          <div key={qi} className="aw-q">
            <div className="aw-prompt"><span className="no">{qi + 1}</span><Text>{q.prompt}</Text></div>
            {q.options.map((o, oi) => {
              const cls =
                locked && o.correct ? ' ok'
                : locked && oi === chosen ? ' bad'
                : ''
              return (
                /* aria-disabled, not disabled: an answered question must stay
                   keyboard-reviewable; pick() already refuses a second answer.
                   The verdict is words + glyph, never color alone. */
                <button
                  key={oi}
                  type="button"
                  className={`aw-opt${cls}`}
                  aria-disabled={locked || undefined}
                  onClick={() => pick(qi, oi)}
                >
                  <span className="aw-opt-text"><Text>{o.text}</Text></span>
                  {locked && o.correct ? <span className="aw-tag ok">✓ Correct</span> : null}
                  {locked && oi === chosen && !o.correct ? <span className="aw-tag bad">✗ Your answer</span> : null}
                </button>
              )
            })}
            {locked && q.explanation ? <div className="aw-expl"><Text>{q.explanation}</Text></div> : null}
            {locked ? <CiteLine cite={q.cite} /> : null}
          </div>
        )
      })}
    </div>
  )
}

// ── Study checklist ──────────────────────────────────────────────

function ChecklistWidget(props: WidgetProps) {
  const { artifact } = props
  const steps = (artifact.payload as ChecklistPayload).steps ?? []
  const save = useStateSaver(props)
  const [done, setDone] = useState<Set<number>>(() => new Set(artifact.state.done ?? []))
  if (steps.length === 0) return <div className="dempty">This plan is empty.</div>

  const persist = (next: Set<number>) => {
    setDone(next)
    save({ ...artifact.state, done: [...next].sort((a, b) => a - b) })
  }
  const toggle = (i: number) => {
    const next = new Set(done)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    persist(next)
  }
  const doneCount = steps.filter((_, i) => done.has(i)).length
  const minutesLeft = steps.reduce((t, s, i) => t + (done.has(i) ? 0 : s.minutes ?? 0), 0)

  return (
    <div className="aw-plan">
      <div className="aw-headline">
        <div className="dlabel" role="status">
          {doneCount === steps.length
            ? 'ALL DONE — NICE.'
            : `${doneCount} OF ${steps.length} DONE${minutesLeft > 0 ? ` · ≈${minutesLeft} MIN LEFT` : ''}`}
        </div>
        {doneCount > 0 ? <ResetButton onReset={() => persist(new Set())} label="Start over" /> : null}
      </div>
      <div className="aw-bar"><i style={{ width: `${(100 * doneCount) / steps.length}%` }} /></div>
      {steps.map((s, i) => (
        <label key={i} className={`aw-step${done.has(i) ? ' done' : ''}`}>
          <input type="checkbox" checked={done.has(i)} onChange={() => toggle(i)} />
          <span className="aw-step-label"><Text>{s.label}</Text></span>
          {s.minutes ? <span className="aw-mins">{s.minutes} min</span> : null}
        </label>
      ))}
    </div>
  )
}

// ── Study guide ──────────────────────────────────────────────────

function StudyGuideWidget({ artifact }: WidgetProps) {
  const sections = (artifact.payload as StudyGuidePayload).sections ?? []
  if (sections.length === 0) return <div className="dempty">This guide is empty.</div>
  return (
    <div className="aw-guide">
      {sections.map((s, si) => (
        <section key={si}>
          <h4 className="aw-gh">{s.heading}</h4>
          <ul className="aw-gpts">
            {(s.points ?? []).map((p, pi) => (
              <li key={pi} className="aw-gpt">
                <span className="aw-gpt-t"><Text>{p.text}</Text></span>
                <CiteLine cite={p.cite} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ── Knowledge map ────────────────────────────────────────────────

/** The saved prerequisite path (issue #94): the stops in study order with
 *  Athena's why-lines, and the one action — light it back up on the map
 *  (`?path=<id>`, the roadmap's knowledge-path lens). Mastery figures are a
 *  snapshot from when the student asked, and say so. */
function KnowledgeMapWidget({ artifact }: WidgetProps) {
  const router = useRouter()
  const pathname = usePathname()
  const km = artifact.payload as KnowledgeMapPayload
  const stops = km.stops ?? []
  if (stops.length === 0) return <div className="dempty">This path is empty.</div>
  const showOnMap = () => {
    /* Swap the modal for the lens: dropping ?node= closes this card, ?path=
       lights the map. One push so Back undoes both together. */
    const params = new URLSearchParams(window.location.search)
    params.delete('node')
    params.set('path', artifact.id)
    router.push(`${pathname}?${params.toString()}`)
  }
  return (
    <div className="aw-kmap">
      <p className="aw-kq">“{km.question}”</p>
      <ol className="aw-kstops">
        {stops.map((s, i) => (
          <li key={i} className="aw-kstop">
            <div className="aw-kst">
              <span className="no" aria-hidden>{i + 1}</span>
              {s.title}
              {s.masteryPct != null ? <span className="aw-kpct">{s.masteryPct}% when you asked</span> : null}
            </div>
            <p className="aw-kwhy">{s.why}</p>
          </li>
        ))}
        {/* the destination is semantically the path's last entry, not an
            afterthought below the list */}
        <li className="aw-kstop"><div className="aw-kdest"><span aria-hidden>→ </span>{km.focus?.title} — what you asked about</div></li>
      </ol>
      <button type="button" className="aw-kshow" onClick={showOnMap}>
        <span aria-hidden>✦ </span>Light the path on your map
        <small>closes this note and highlights the stops on the roadmap</small>
      </button>
    </div>
  )
}

// ── Dispatch ─────────────────────────────────────────────────────

const WIDGETS: Record<AthenaArtifactView['kind'], (props: WidgetProps) => ReactElement> = {
  flashcards: FlashcardsWidget,
  practice: PracticeWidget,
  checklist: ChecklistWidget,
  study_guide: StudyGuideWidget,
  knowledge_map: KnowledgeMapWidget,
}

export function AthenaArtifactBody(props: WidgetProps) {
  const Widget = WIDGETS[props.artifact.kind]
  /* A kind this build doesn't know — the fetch filters these out, so only a
     stale bundle can get here. Say something rather than render nothing. */
  if (!Widget) return <div className="dempty">This note needs a newer version of the app.</div>
  return <Widget {...props} />
}
