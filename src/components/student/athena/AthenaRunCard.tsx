// Run chrome — the "what is she actually doing" layer, ported from prototype
// variant 02 (Trace) into the dock's language. One soft card per phase: it opens,
// its rows advance, and it folds to a single line when the phase ends. The header
// reopens it any time.
//
// Friendly names only, never function names — a student should read
// "Looking things up… · Course materials" and not a tool identifier.
//
// The rows are REAL: /api/chat times every lookup it performs (retrieval, the
// weak-topic lane) and every tool the model chooses to call, and streams a marker
// per start and finish. `phaseFromRun` below is the whole client side of it — a
// reducer over those events, no timers and nothing invented. A turn that looked
// nothing up therefore shows no card at all, which is the point.
//
// The rows reach this component two ways. Live, they ride the stream as markers
// so each appears the moment it happens. Afterwards they are read back from the
// answer's `metadata` (see `messageRun`), so reopening a thread — or reloading,
// or switching pose — still shows what ran. Rows only, never the directive:
// stored as data they can be rendered but never re-fired.

'use client'

import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { AthenaRunEvent } from '@/lib/ai/athena-directive'

export interface RunRow {
  /** Friendly name — "Course materials", never `search_materials`. */
  name: string
  detail: string
  /** Real measured duration, once the row completes. */
  seconds?: number
  state: 'active' | 'done'
  /** Plan rows only: the proposing tool's own name, for the card's title. */
  card?: string
}

export interface RunPhase {
  /** Title while running, e.g. "Looking things up…". */
  title: string
  /** Title once finished, e.g. "Looked up 2 things". */
  doneTitle: string
  rows: RunRow[]
  /** Every row has finished — the header goes past-tense and ticks. */
  done: boolean
  /** The turn is over, so the card may fold itself away. Deliberately separate
   *  from `done`: she can finish looking things up a long time before she
   *  finishes writing, and a spinner running through the whole answer says she's
   *  still searching when she isn't. */
  collapsible: boolean
}

/** Reduce a turn's events into ordered rows. No timers and nothing invented —
 *  a row exists because the server told us it started. */
function rowsFromRun(events: AthenaRunEvent[]): RunRow[] {
  const order: string[] = []
  const rows = new Map<string, RunRow>()
  for (const event of events) {
    if (!rows.has(event.id)) order.push(event.id)
    const existing = rows.get(event.id)
    rows.set(event.id, {
      name: event.name,
      // A 'done' with an empty detail must not blank out what 'start' said.
      detail: event.detail || existing?.detail || '',
      state: event.phase === 'done' ? 'done' : 'active',
      seconds: event.ms === undefined ? existing?.seconds : event.ms / 1000,
      card: event.card ?? existing?.card,
    })
  }
  return order.map((id) => rows.get(id)!)
}

/**
 * Fold the turn's LOOKUP events into a card. `settled` is the caller's answer to
 * "is this turn over" — the last row finishing doesn't mean she's done, since
 * the model can still reach for another tool mid-answer.
 *
 * `spoken` — has the first word of the answer landed yet? Between the last lookup
 * finishing and the first token there is nothing else on screen: the "Thinking…"
 * row is gone (the stream is open), so a card that ticked the moment its rows did
 * left the thread completely still for what is often the longest wait of the turn.
 * The header therefore keeps its spinner until she speaks — but re-titled, because
 * she is no longer looking anything up and saying so would be the other lie.
 * Defaults true so a run read back from the database renders finished.
 */
export function phaseFromRun(
  events: AthenaRunEvent[],
  settled: boolean,
  spoken = true,
): RunPhase | null {
  const list = rowsFromRun(events.filter((e) => e.group !== 'plan'))
  if (list.length === 0) return null
  const allDone = list.every((r) => r.state === 'done')
  const n = list.length
  return {
    title: allDone ? 'Putting your answer together…' : 'Looking things up…',
    doneTitle: `Looked up ${n} thing${n === 1 ? '' : 's'}`,
    rows: list,
    /* `settled` is the backstop: a turn that ends without a word (a tool-only answer, a
       stream that dies) must not leave a spinner going forever.

       `|| settled` on the outside, not just inside the parens (#660): pressing Stop
       during the tool-call phase aborts before any row reports 'done', so allDone is
       false and the old `allDone && …` shape left that row spinning at "in progress" for
       the rest of the session. A settled turn is finished whatever its rows last said —
       the work is not still happening, so nothing should claim it is. */
    done: (allDone && spoken) || settled,
    collapsible: settled,
  }
}

/**
 * The plan card — a propose tool's declared steps (§14.5).
 *
 * Cut from the first port on purpose: the prototype drew this card off a timer
 * for every question, and inventing "here's my three-step plan" is a much
 * bigger lie than inventing a tool name. It exists now because there is finally
 * something real behind it — the steps are declared in the tool definition,
 * server-side, and each row ticks when that step actually finishes.
 *
 * Two deliberate differences from the lookup card:
 *   • It never folds away. A lookup is chrome; a proposal is a receipt for
 *     something the student is about to be asked to confirm, and receipts stay.
 *   • The last row is the proposal, never the write — so the card structurally
 *     cannot show a completed mutation, because Athena never performs one.
 *
 * Steps that never ran simply aren't drawn, exactly like an un-reported lookup:
 * a tool that bailed at step two must not leave step three claiming to be done.
 */
export function planPhase(events: AthenaRunEvent[]): RunPhase | null {
  const list = rowsFromRun(events.filter((e) => e.group === 'plan'))
  if (list.length === 0) return null
  const allDone = list.every((r) => r.state === 'done')
  /* The card's own title is the proposing tool's student-facing name, which
     already exists and is already written in her voice ("a challenge that
     fits"). It replaced "Did 3 things to set this up" — a count of internal
     steps, with "this" referring to an answer two screens up. Since this card
     never folds, that sentence was the one the student re-read forever, and it
     was the least informative text in it. */
  const named = list.find((r) => r.card)?.card
  return {
    title: named ? `Setting up ${named.toLowerCase()}…` : 'Working on it…',
    doneTitle: named ? `Ready: ${named.toLowerCase()}` : 'Set this up for you',
    rows: list,
    done: allDone,
    collapsible: false,
  }
}

/**
 * She moved the app — the shell knows when, and where to.
 *
 * Settles and STAYS in the thread like any other card, rather than vanishing when
 * the move finishes: "she navigated me here" is exactly the kind of thing worth
 * scrolling back to, and a row that deletes itself is the opposite of a receipt.
 *
 * No duration on the row, deliberately. This is a movement, not a query — the
 * other rows' timings answer "why did that take four seconds", and the drive
 * answers that with the animation itself. `router.push` reports no completion,
 * so any number here would be the fixed UI window dressed up as a measurement.
 */
export function navigationPhase(destination: string, running: boolean): RunPhase {
  // "Navigating the app" / "App navigation" was the developer's description of
  // `router.push` in the one card that bans system language. "Opened" reads as
  // one sentence with the label beside it: Opened · Challenges · Graph Sprint.
  return {
    title: 'Taking you there…',
    doneTitle: 'Took you there',
    done: !running,
    collapsible: !running,
    rows: [{ name: 'Opened', detail: destination, state: running ? 'active' : 'done' }],
  }
}

/** Sub-second lookups are the common case, and "0.0s" reads as a broken number
 *  rather than a fast one. */
function formatDuration(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`
}

export function AthenaRunCard({ phase }: { phase: RunPhase }) {
  // Opens while it runs, folds itself away when it settles — but a manual toggle
  // wins from then on, so reopening a finished card doesn't snap shut again.
  const [override, setOverride] = useState<boolean | null>(null)
  const closed = override ?? phase.collapsible

  return (
    // data-athena-run: a stable hook for the visual walkthroughs — the header is
    // otherwise indistinguishable from any other aria-expanded button in the dock.
    <div
      data-athena-run
      className="max-w-[92%] overflow-hidden rounded-2xl border border-border/70 bg-card/60"
    >
      <button
        type="button"
        onClick={() => setOverride(!closed)}
        aria-expanded={!closed}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex w-3.5 shrink-0 justify-center">
          {phase.done ? (
            <Check className="h-3.5 w-3.5 text-success" aria-hidden />
          ) : (
            <span
              className="h-3 w-3 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none"
              aria-hidden
            />
          )}
        </span>
        {/* The live region sits on the TITLE, not the rows: it announces the
            outcome once ("Ready: a challenge that fits", "Navigated the app")
            instead of narrating every tick. Without it a screen-reader student
            was driven to a different page with no announcement at all. */}
        <span className="flex-1" role="status">
          {phase.done ? phase.doneTitle : phase.title}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${closed ? '-rotate-90' : ''}`}
          aria-hidden
        />
      </button>
      {/* The collapse is a `0fr` grid row, which hides the rows visually but
          leaves them in the accessibility tree — so a closed card was still
          being read out under a header saying aria-expanded="false". */}
      <div
        className="athena-run-body"
        data-closed={closed ? 'true' : undefined}
        aria-hidden={closed || undefined}
      >
        <div className="min-h-0 overflow-hidden px-3">
          {phase.rows.map((row, i) => (
            <div
              key={`${row.name}-${i}`}
              className="flex min-w-0 items-center gap-2 pb-1.75 text-xs text-foreground"
            >
              <RowMark state={row.state} />
              <span className="shrink-0 font-semibold">{row.name}</span>
              {/* Titled because 24rem of dock truncates most details. */}
              <span className="truncate text-[11.5px] text-muted-foreground" title={row.detail}>
                {row.detail}
              </span>
              {row.seconds !== undefined && (
                <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">
                  {formatDuration(row.seconds)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** ● running (pulsing) · ✓ done — a glyph, not a colour alone. There is no
 *  "pending" row: a lookup we haven't been told about yet simply isn't drawn. */
function RowMark({ state }: { state: RunRow['state'] }) {
  /* The glyph is the only carrier of per-row state, so it needs a name as well
     as a shape — `aria-hidden` on both marks meant a screen reader heard "Your
     strongest topics, 4 at mastery" with no way to tell finished from running. */
  const label = <span className="sr-only">{state === 'done' ? 'done' : 'in progress'}</span>
  if (state === 'done') {
    return (
      <>
        <Check className="h-3 w-3 shrink-0 text-success" aria-hidden />
        {label}
      </>
    )
  }
  return (
    <>
      <span className="flex w-3 shrink-0 justify-center" aria-hidden>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
      </span>
      {label}
    </>
  )
}
