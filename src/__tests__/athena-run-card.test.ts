// `phaseFromRun` is the whole client half of the run channel: it folds the
// start/finish markers /api/chat streams into the dock's "Looking things up…"
// card. It replaced a client-side timer that invented two fixed rows for every
// answer, so the invariants worth pinning are the ones that keep it honest —
// nothing shown that wasn't reported, and a row that opened always closes.

import { describe, it, expect } from 'vitest'
import { navigationPhase, phaseFromRun, planPhase } from '@/components/student/athena/AthenaRunCard'
import type { AthenaRunEvent } from '@/lib/ai/athena-directive'
import { messageRun } from '@/lib/ai/conversation-utils'

const start = (id: string, name: string): AthenaRunEvent => ({ phase: 'start', id, name, detail: '' })
const done = (id: string, name: string, detail: string, ms: number): AthenaRunEvent => ({
  phase: 'done',
  id,
  name,
  detail,
  ms,
})

describe('phaseFromRun', () => {
  it('draws no card for a turn that looked nothing up', () => {
    // The card used to appear on every answer whether anything ran or not.
    expect(phaseFromRun([], true)).toBeNull()
  })

  it('pairs a start with its finish into one row, keeping the real duration', () => {
    const phase = phaseFromRun([start('materials', 'Course materials'), done('materials', 'Course materials', '7 of 8 pages matched', 812)], true)

    expect(phase!.rows).toEqual([
      { name: 'Course materials', detail: '7 of 8 pages matched', state: 'done', seconds: 0.812 },
    ])
    expect(phase!.doneTitle).toBe('Looked up 1 thing')
  })

  it('shows a lookup still running as running', () => {
    const phase = phaseFromRun([start('materials', 'Course materials'), start('focus', 'What to study next'), done('materials', 'Course materials', 'ok', 100)], false)

    expect(phase!.rows.map((r) => r.state)).toEqual(['done', 'active'])
    expect(phase!.done).toBe(false)
    // The header names the wait it is actually in. Collapsing the title to one
    // string passes every other assertion in this file.
    expect(phase!.title).toBe('Looking things up…')
  })

  it('reads a REPLAYED run as finished, but only folds when the turn ends', () => {
    /* `spoken` defaults true, which is the case this covers: a run read back from
       the database, where the answer is already there. Live turns never take the
       default — AthenaChat always passes the third argument — and their behaviour
       is the test below, where the spinner holds until she speaks. Tying the
       header to the turn left a spinner running through the whole answer; tying
       the FOLD to the rows made the card vanish mid-answer. Three signals, not
       one. */
    const events = [start('materials', 'Course materials'), done('materials', 'Course materials', 'ok', 100)]

    expect(phaseFromRun(events, false)).toMatchObject({ done: true, collapsible: false })
    expect(phaseFromRun(events, true)).toMatchObject({ done: true, collapsible: true })
  })

  it('holds the spinner between the last lookup and the first word of the answer', () => {
    // The gap the student actually stares at: rows all ticked, stream open, no
    // text yet. The header stays in its running state — but not titled as if she
    // were still searching — and `settled` is the backstop for a wordless turn.
    const events = [start('materials', 'Course materials'), done('materials', 'Course materials', 'ok', 100)]

    const waiting = phaseFromRun(events, false, false)
    expect(waiting).toMatchObject({ done: false, collapsible: false })
    expect(waiting!.title).not.toContain('Looking things up')
    expect(phaseFromRun(events, false, true)).toMatchObject({ done: true })
    expect(phaseFromRun(events, true, false)).toMatchObject({ done: true })
  })

  it('is not finished while a row is still running AND the turn is live', () => {
    /* settled=false is the live case — a lookup genuinely in flight, so the spinner is
       telling the truth. */
    const phase = phaseFromRun([start('materials', 'Course materials')], false)
    expect(phase).toMatchObject({ done: false, collapsible: false })
  })

  it('is finished once the turn settles, even with a row left mid-flight (#660)', () => {
    /* This case previously asserted done:false, which encoded the bug: pressing Stop
       during the tool-call phase aborts before any row reports 'done', so the row sat at
       "in progress" for the rest of the session with no error and no way to clear it.
       A settled turn is over whatever its rows last said — claiming work is still
       happening when it has been cancelled is the lie worth fixing. */
    const phase = phaseFromRun([start('materials', 'Course materials')], true)
    expect(phase).toMatchObject({ done: true, collapsible: true })
  })

  it('keeps the order the lookups happened in, not the order they finished', () => {
    const phase = phaseFromRun(
      [
        start('materials', 'Course materials'),
        start('focus', 'What to study next'),
        done('focus', 'What to study next', '2 ranked', 40),
        done('materials', 'Course materials', '3 of 8 pages matched', 900),
      ],
      true,
    )

    expect(phase!.rows.map((r) => r.name)).toEqual(['Course materials', 'What to study next'])
  })

  it('does not let a finish blank out the name or detail a start established', () => {
    // Defensive: a truncated 'done' payload should degrade to a completed row,
    // never to an empty one.
    const phase = phaseFromRun(
      [start('focus', 'What to study next'), { phase: 'done', id: 'focus', name: 'What to study next', detail: '' }],
      true,
    )

    expect(phase!.rows[0]).toMatchObject({ name: 'What to study next', state: 'done' })
  })

  it('pluralises the settled title off the real row count', () => {
    const events = [
      start('a', 'Course materials'),
      done('a', 'Course materials', '', 1),
      start('b', 'Your weak topics'),
      done('b', 'Your weak topics', '', 2),
    ]
    expect(phaseFromRun(events, true)!.doneTitle).toBe('Looked up 2 things')
  })
})


// The navigation card is the one row the run channel doesn't carry — the shell
// raises it, because the shell is what owns the router. It used to be gated on
// `driving`, which meant it deleted itself the moment the move finished; a
// receipt that disappears is not a receipt.
describe('navigationPhase', () => {
  it('runs while she is moving the app', () => {
    const phase = navigationPhase('Roadmap · the node she explained', true)

    expect(phase.title).toBe('Taking you there…')
    expect(phase.rows[0].state).toBe('active')
    expect(phase).toMatchObject({ done: false, collapsible: false })
  })

  it('settles and stays once the move is done', () => {
    const phase = navigationPhase('Roadmap · the node she explained', false)

    expect(phase.doneTitle).toBe('Took you there')
    expect(phase.rows[0].state).toBe('done')
    expect(phase).toMatchObject({ done: true, collapsible: true })
  })

  it('claims no duration it cannot measure', () => {
    // router.push reports no completion, so a number here would be the fixed
    // 2.6s UI window pretending to be a measurement.
    expect(navigationPhase('Roadmap', false).rows[0].seconds).toBeUndefined()
  })
})

// The plan card was cut from the first port because nothing fed it. These are
// the properties that keep it honest now that something does.
describe('planPhase', () => {
  const step = (id: string, name: string, phase: 'start' | 'done', ms?: number): AthenaRunEvent => ({
    phase,
    id,
    name,
    detail: phase === 'done' ? 'ok' : '',
    group: 'plan',
    ...(ms === undefined ? {} : { ms }),
  })

  it('draws nothing when no propose tool ran — a read-only turn has no plan', () => {
    expect(planPhase([{ phase: 'done', id: 'materials', name: 'Course materials', detail: '3 pages', ms: 600 }]))
      .toBeNull()
  })

  it('keeps plan rows and lookup rows in separate cards', () => {
    const events: AthenaRunEvent[] = [
      { phase: 'done', id: 'materials', name: 'Course materials', detail: '3 pages', ms: 600 },
      step('a', 'Your strongest topics', 'done', 120),
    ]
    expect(planPhase(events)?.rows.map((r) => r.name)).toEqual(['Your strongest topics'])
    expect(phaseFromRun(events, true)?.rows.map((r) => r.name)).toEqual(['Course materials'])
  })

  it('never folds away — a proposal is a receipt, not chrome', () => {
    const phase = planPhase([step('a', 'Your strongest topics', 'done', 120)])
    expect(phase?.done).toBe(true)
    expect(phase?.collapsible).toBe(false)
  })

  it("titles itself with the proposing tool's own name, not a count of its steps", () => {
    // This card never folds, so its done title is the line the student re-reads
    // on every scroll-back. "Did 3 things to set this up" named neither what was
    // set up nor how — and "3 things" counts internals, not anything they asked
    // for.
    const events: AthenaRunEvent[] = [
      { ...step('a', 'Your strongest topics', 'done', 120), card: 'A challenge that fits' },
      { ...step('b', "What's still open", 'done', 90), card: 'A challenge that fits' },
    ]
    expect(planPhase(events)?.doneTitle).toBe('Ready: a challenge that fits')
    expect(planPhase([events[0], { ...events[1], phase: 'start' }])?.title).toBe(
      'Setting up a challenge that fits…',
    )
    expect(planPhase(events)?.doneTitle).not.toMatch(/\d/)
  })

  it('does not draw a step that never ran, so a tool that bailed cannot claim it finished', () => {
    // Declared three, reported two: the third simply is not there.
    const phase = planPhase([
      step('a', 'Your strongest topics', 'done', 120),
      step('b', "What's still open", 'start'),
    ])
    expect(phase?.rows.map((r) => r.state)).toEqual(['done', 'active'])
    expect(phase?.done).toBe(false)
  })

  it('carries the server-measured duration through, same as a lookup row', () => {
    expect(planPhase([step('a', 'Your strongest topics', 'done', 1400)])?.rows[0].seconds).toBe(1.4)
  })
})

// Persistence: the cards used to vanish on reload, on a pose change, and on
// reopening a thread, because the rows only ever existed as markers inside the
// streamed text and the stored copy of that text is scrubbed. They are now also
// recorded as data on the row. `messageRun` is the read side of that.
describe('messageRun — the cards survive a reopened thread', () => {
  const row = (metadata: Record<string, unknown>) => ({
    id: 'm-1',
    conversation_id: 'c-1',
    role: 'assistant' as const,
    content: 'Beam search keeps k candidates.',
    metadata,
    created_at: '2026-07-31',
  })

  it('reads back the rows recorded on an answer', () => {
    const run: AthenaRunEvent[] = [
      { phase: 'start', id: 'materials', name: 'Course materials', detail: '' },
      { phase: 'done', id: 'materials', name: 'Course materials', detail: '7 of 8 matched', ms: 812 },
    ]
    expect(messageRun(row({ run }))).toEqual(run)
    // And they rebuild the same card the live markers would have.
    expect(phaseFromRun(messageRun(row({ run })), true)?.doneTitle).toBe('Looked up 1 thing')
  })

  it('shows no cards for a thread written before rows were recorded', () => {
    // The old behaviour, and still the honest one: no record, no card.
    expect(messageRun(row({ usage: { inputTokens: 10 } }))).toEqual([])
    expect(messageRun(row({}))).toEqual([])
  })

  it('drops malformed rows instead of rendering a half-built card', () => {
    const run = [
      { phase: 'done', id: 'ok', name: 'Course materials', detail: '' },
      { phase: 'sideways', id: 'bad', name: 'x', detail: '' },
      { id: 'no-phase', name: 'x', detail: '' },
      null,
    ]
    expect(messageRun(row({ run })).map((e) => e.id)).toEqual(['ok'])
  })

  it('is not an array, is not a card', () => {
    expect(messageRun(row({ run: 'nope' }))).toEqual([])
  })
})
