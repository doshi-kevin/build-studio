'use client'

/**
 * NodeCheckPanel — the short check inside a supplementary node's modal
 * (docs/designs/roadmap-mastery/roadmap-engine.md §14).
 *
 * Renders inside NodeDetail on the STUDENT path only. It never receives an
 * answer key: the action hands out five question bodies, and grading happens
 * server-side against the pool.
 *
 * It renders in the MIDDLE column, under the node's own content — the right
 * rail is reserved for status, summary, actions and skills. (It began in that
 * rail, where five questions with four wrapping options each was four screens
 * of scrolling in a ~204px column.)
 *
 * ONE QUESTION AT A TIME survived the move: the counter keeps the ask small
 * enough to feel like a nudge, which is the whole point of §14.
 *
 * Lives in the professor route folder because the whole roadmap prototype does
 * (the student page imports RoadmapPrototype from here); the actions it calls
 * are the student's own, passed in as props so this file pulls no server code.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

export interface NodeCheckQuestionView {
  id: string
  prompt: string
  choices: string[]
  selected: number | null
}

export type NodeCheckView =
  | { kind: 'preparing' }
  | { kind: 'not_quizzable' }
  | { kind: 'ready'; questions: NodeCheckQuestionView[]; passed: boolean; tries: number }

export interface NodeCheckActions {
  /** The module item this check belongs to. */
  itemId: string
  /**
   * Loads the student's questions, generating the pool on first ask.
   *
   * Takes the id rather than a pre-bound closure ON PURPOSE: the caller builds
   * this per render, so a bound function would change identity every render and
   * re-trigger the effect below forever.
   *
   * For the same reason this must be a STABLE reference — a bound server action
   * or a useCallback, never an arrow written at the call site. An inline arrow
   * is a new function each render, and the effect below re-fires on every one.
   */
  load: (itemId: string) => Promise<{ data?: NodeCheckView; error?: string }>
  /** Grades a submission; returns the tally, never which ones were wrong. */
  submit: (
    itemId: string,
    answers: (number | null)[],
  ) => Promise<{ data?: { passed: boolean; correct: number; total: number }; error?: string }>
  /** Called after a pass so the map's percentages can refresh. */
  onPassed: () => void
  /**
   * Called when the answer FIRST says the pool is being generated (and again if
   * it later isn't). Two things need it, and neither can know otherwise:
   *
   *  · The generation is what the load itself starts, so nothing else on the
   *    page knows it began — the map's node reads `node_check_state` from server
   *    data rendered before this click.
   *  · That column is COURSE-level (`module_items`, shared by the section — see
   *    getNodeCheckForStudent). It answers "is this still being written", never
   *    "did YOU ask for it". The item id is what makes the second answerable, so
   *    it is passed back: the map shows the state only for nodes whose id came
   *    through here.
   *
   * Only on CHANGE, not once per poll. Also fires `false` when the panel's own
   * poll budget runs out: the two give-up clocks are different lengths, so this
   * is the only way the map learns the shorter one expired instead of promising
   * questions the card has already stopped waiting for.
   */
  onBaking?: (itemId: string, baking: boolean) => void
}

/** What the hook hands back — the load's answer plus the picks it seeded. */
export interface NodeCheckController {
  /** `null` while the first load is still in flight. */
  view: NodeCheckView | null
  answers: (number | null)[]
  setAnswers: React.Dispatch<React.SetStateAction<(number | null)[]>>
}

/**
 * Which completion control the node modal may show right now.
 *
 * Exported because this three-line rule IS the bug that was reported: the tick
 * used to render from frame one, so it appeared for the length of the round
 * trip and then vanished when the check took its place. Inline in NodeDetail it
 * was untestable, and a test that re-spells it here proves nothing.
 *
 * The invariant: while `view` is null NEITHER shows. A control that is offered
 * and then withdrawn reads as a bug, and it is clickable in the meantime.
 */
export function completionControls(o: {
  /** A check could exist for this node — the caller supplied the actions. */
  offered: boolean
  /** They have already ticked it; re-asking is noise. */
  checked: boolean
  view: NodeCheckView | null
}): { showTick: boolean; showCheck: boolean } {
  const showCheck = o.offered && !o.checked && o.view?.kind !== 'not_quizzable'
  return { showCheck, showTick: !showCheck }
}

/** How often to re-ask while the background generation runs, and for how long. */
const POLL_MS = 3000
const MAX_POLLS = 5

/**
 * Loads the check, and owns the picks so the panel can be a pure renderer.
 *
 * It is a hook rather than state inside the panel because the ANSWER decides
 * two columns at once: the questions render in the middle of the card, while
 * the right rail shows the plain self check-off only when there is no check to
 * take its place. One fetch, read by both.
 *
 * `source` is optional (professors get no check) — hooks can't be conditional,
 * so the absent case is handled inside rather than at the call site.
 */
export function useNodeCheck(source?: Pick<NodeCheckActions, 'itemId' | 'load' | 'onBaking'>): NodeCheckController {
  // `null` until the first load answers. Rendering the self check-off from
  // frame one (as this once did, to keep the ACTIONS block from blinking)
  // offered a live "Mark as done" for the second or so the round trip took and
  // then withdrew it — an actionable control that appears and vanishes
  // untouched reads as a bug, and a fast click in that window ticks a node that
  // had a check waiting. Every path below settles it, failures included.
  const [view, setView] = useState<NodeCheckView | null>(null)
  const [answers, setAnswers] = useState<(number | null)[]>([])
  const itemId = source?.itemId
  const load = source?.load
  /* Read through a ref so a caller who passes a fresh arrow can't re-fire the
     fetch effect — the whole reason `load` is documented as needing to be
     stable. `reported` keeps the callback to state CHANGES only. */
  const onBaking = useRef(source?.onBaking)
  onBaking.current = source?.onBaking
  /* Seeded false, not null: a node whose questions were ready all along was
     never being written, so reporting "not being written" about it is a message
     about a state it was never in — and one pointless setState in the map for
     every node opened. Only real transitions are worth a call. */
  const reported = useRef(false)

  // One effect owns the fetch AND the poll: generation is a background job, so
  // the first student to open the node waits a few seconds rather than having
  // to close and reopen it. The poll is CAPPED — an item stuck 'preparing'
  // settles on the tick instead of spinning forever.
  useEffect(() => {
    if (!itemId || !load) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let polls = 0
    const tick = async () => {
      const res = await load(itemId)
      /* Report to the map BEFORE the unmount guard. Closing the card while the
         questions are still being written is the exact case this feature exists
         for — and the first load can outlast a fast Escape, since it also enqueues
         the job. Guarding this behind `cancelled` meant the map was never told at
         all, so nothing ever appeared on it. The map owns this state and is still
         mounted; only `setView` below belongs to the panel that may be gone. */
      if (res.data) {
        const baking = res.data.kind === 'preparing'
        if (reported.current !== baking) {
          reported.current = baking
          onBaking.current?.(itemId, baking)
        }
      }
      if (cancelled) return
      // A failed load settles on the tick — it is the correct degraded state,
      // and leaving `view` null would strand the student on the placeholder.
      if (!res.data) { setView({ kind: 'not_quizzable' }); return }
      setView(res.data)
      if (res.data.kind === 'ready') setAnswers(res.data.questions.map((q) => q.selected))
      if (res.data.kind === 'preparing' && polls++ < MAX_POLLS) {
        timer = setTimeout(() => void tick(), POLL_MS)
      } else if (res.data.kind === 'preparing') {
        /* We gave up waiting. Tell the map too, or it keeps promising questions
           for a node whose own card has already concluded there are none — the
           two give-up clocks are different lengths, so this is the only way the
           map learns the shorter one expired. */
        if (reported.current) {
          reported.current = false
          onBaking.current?.(itemId, false)
        }
        setView({ kind: 'not_quizzable' })
      }
    }
    void tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [itemId, load])

  return { view, answers, setAnswers }
}

export interface NodeCheckPanelProps extends Omit<NodeCheckActions, 'load'> {
  check: NodeCheckController
  /** The right rail's own self check-off, re-offered here as the TRUST DOOR.
   *  The rail hides its tick while this panel shows (completionControls), so
   *  the door is the node's one mark-done while a check exists — the check
   *  gates nothing anymore, it is a voluntary extra. */
  selfCheck?: { checked: boolean; saving: boolean; onToggle: () => void }
}

export function NodeCheckPanel({ itemId, submit, onPassed, check, selfCheck }: NodeCheckPanelProps) {
  const { view, answers, setAnswers } = check
  const [at, setAt] = useState(0)
  const [busy, setBusy] = useState(false)
  /* The quiz door's latch: questions render only after the student walks in.
     Never auto-opened — the whole point of the doors is that the questions
     are opt-in, not the price of the tick. */
  const [started, setStarted] = useState(false)
  const [result, setResult] = useState<{ passed: boolean; correct: number; total: number } | null>(null)
  const groupId = useId()

  // Deliberately no heading yet: most nodes turn out to have no check, and
  // announcing one we then take away is the same mistake as the tick.
  if (!view) return <div className="dfoot ncwait">looking for a quick check…</div>

  // The self check-off in the right rail is the whole UI for these.
  if (view.kind === 'not_quizzable') return null

  const preparing = view.kind === 'preparing'
  const ready = view.kind === 'ready' ? view : null
  const total = ready?.questions.length ?? 0
  const answered = answers.filter((a) => a !== null).length
  const done = !!ready && (ready.passed || !!result?.passed)
  const q = ready?.questions[Math.min(at, total - 1)]

  const onSubmit = async () => {
    if (!ready) return
    setBusy(true)
    const res = await submit(itemId, answers)
    setBusy(false)
    if (res.error || !res.data) {
      toast.error(res.error || 'Could not submit')
      return
    }
    setResult(res.data)
    if (res.data.passed) {
      onPassed()
      return
    }
    // Clear the picks on a miss. Keeping them would turn the tally into a
    // per-question oracle: flip one answer, resubmit, and the ±1 tells you
    // exactly which one it was — solvable without opening the material.
    setAnswers(ready.questions.map(() => null))
    setAt(0)
  }

  return (
    <>
      <div className="dlabel">CALL IT DONE</div>
      {done ? (
        <div className="ncdone">✓ Done — this counts toward your progress, and gave your mastery a little boost.</div>
      ) : (
        <>
          {/* Two doors, one decision (§14, optional check): the trust door and
              the quiz door carry equal weight. Both stay on screen mid-check so
              bailing out of the questions is always one tap. */}
          <div className="ncdoors">
            {selfCheck ? (
              <button
                type="button"
                className={`ncdoor${started ? ' dim' : ''}`}
                disabled={selfCheck.saving}
                onClick={() => {
                  /* Bailing out mid-quiz discards the picks — the whole block is
                     about to vanish, so the receipt has to say what happened. */
                  if (started && answered > 0) toast.success('Marked as done — the questions can wait.')
                  selfCheck.onToggle()
                }}
              >
                <b>I went through it {selfCheck.saving ? '…' : '✓'}</b>
                <span>{started ? 'still one tap away — no questions asked.' : 'mark it done — we believe you.'}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={`ncdoor quiz${started ? ' live' : ''}`}
              disabled={preparing || started}
              onClick={() => setStarted(true)}
            >
              <b>Quiz me first</b>
              {preparing ? (
                <span>putting a few questions together…</span>
              ) : started ? (
                <span className="ncstep">question {Math.min(at, total - 1) + 1} of {total}</span>
              ) : (
                <>
                  <span>{total} quick question{total === 1 ? '' : 's'}, ~1 minute.</span>
                  <span className="ncboost">✦ small mastery boost</span>
                </>
              )}
            </button>
          </div>
          {started && ready && q ? (
            <>
              <div className="ncq" role="radiogroup" aria-labelledby={`${groupId}-${at}`}>
                <div className="ncqp" id={`${groupId}-${at}`}>{q.prompt}</div>
                {q.choices.map((c, ci) => (
                  <button
                    key={ci}
                    type="button"
                    role="radio"
                    aria-checked={answers[at] === ci}
                    className={`ncopt${answers[at] === ci ? ' on' : ''}`}
                    onClick={() => setAnswers((prev) => prev.map((a, j) => (j === at ? ci : a)))}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* The tally only — never WHICH ones were wrong. */}
              {result && !result.passed ? (
                <div className="dfoot">{result.correct} of {result.total} right — have another look and try again.</div>
              ) : null}

              <div className="ncnav">
                <button type="button" className="dopen ghost" disabled={at === 0} onClick={() => setAt((i) => i - 1)}>
                  Back
                </button>
                {at < total - 1 ? (
                  <button type="button" className="dopen ghost" onClick={() => setAt((i) => i + 1)}>
                    Next<span>›</span>
                  </button>
                ) : (
                  <button type="button" className="dopen ghost" disabled={busy || answered < total} onClick={onSubmit}>
                    Check my answers<span>{busy ? '…' : answered < total ? `${answered}/${total}` : '✓'}</span>
                  </button>
                )}
              </div>
            </>
          ) : null}
          {/* "Your instructor can see it" is the disclosure the rail's tick
              carries — this panel REPLACES that tick, so it must carry it too.
              No "doors": that's our word, not the student's. */}
          <div className="dfoot">
            {selfCheck
              ? 'either way counts the same toward your progress — the questions just nudge your mastery. Neither touches your marks. Your instructor can see it.'
              : 'it counts toward your progress, never your marks. Your instructor can see it.'}
          </div>
        </>
      )}
    </>
  )
}
