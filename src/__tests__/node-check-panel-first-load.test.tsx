// The node check's first load — which of the two completion controls a
// supplementary node may show, and when.
//
// A node has exactly one completion path: a generated quick check (middle
// column) or the plain self check-off tick (right rail). Which one applies is
// only known after a round trip, so the pre-answer render is a real decision.
// Rendering the tick optimistically (as this once did) put a live "Mark as
// done" on screen for the length of the round trip and then took it away —
// visible as a button that blinks out untouched, and clickable in the meantime
// on a node that had a check waiting for it.
//
// `useNodeCheck` owns the load precisely so both columns read one answer; these
// tests drive the hook and the panel together, the way NodeDetail does.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import {
  NodeCheckPanel,
  completionControls,
  useNodeCheck,
  type NodeCheckView,
} from '@/app/(dashboard)/professor/courses/[sectionId]/roadmap/NodeCheckPanel'

afterEach(cleanup)

type Load = (itemId: string) => Promise<{ data?: NodeCheckView; error?: string }>

/** A load whose resolution the test controls, so "before it answers" is observable. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * NodeDetail in miniature: one hook, the panel in the middle, and the tick in
 * the rail gated on the same answer.
 */
function Harness({ load, checked = false, onToggle }: { load: Load; checked?: boolean; onToggle?: () => void }) {
  const check = useNodeCheck({ itemId: 'item-1', load })
  // The REAL gate, not a restatement of it — otherwise reverting NodeDetail's
  // wiring reintroduces the flash with every test here still green.
  const { showTick, showCheck } = completionControls({ offered: true, checked, view: check.view })
  return (
    <>
      <div data-testid="main">
        {showCheck ? (
          <NodeCheckPanel
            itemId="item-1"
            submit={vi.fn()}
            onPassed={vi.fn()}
            check={check}
            selfCheck={{ checked, saving: false, onToggle: onToggle ?? vi.fn() }}
          />
        ) : null}
      </div>
      <div data-testid="side">{showTick ? <button type="button">Mark as done</button> : null}</div>
    </>
  )
}

const tick = () => screen.queryByRole('button', { name: 'Mark as done' })

const READY: NodeCheckView = {
  kind: 'ready',
  passed: false,
  tries: 0,
  questions: [
    { id: 'q1', prompt: 'What does the alignment model estimate?', choices: ['a', 'b', 'c', 'd'], selected: null },
  ],
}

describe('the node check\'s first load', () => {
  it('offers nothing actionable, then settles on the tick when there is no check', async () => {
    const gate = deferred<{ data?: NodeCheckView }>()
    render(<Harness load={() => gate.promise} />)

    // The regression: a live tick here is one the student can press on a node
    // that may be about to replace it with a check.
    expect(tick()).toBeNull()
    expect(screen.getByText(/looking for a quick check/i)).toBeTruthy()

    gate.resolve({ data: { kind: 'not_quizzable' } })
    await waitFor(() => expect(tick()).toBeTruthy())
    expect(screen.queryByText(/looking for a quick check/i)).toBeNull()
  })

  it('offers both doors in the middle column and never shows the rail tick beside them', async () => {
    const onToggle = vi.fn()
    const gate = deferred<{ data?: NodeCheckView }>()
    render(<Harness load={() => gate.promise} onToggle={onToggle} />)

    expect(tick()).toBeNull()
    gate.resolve({ data: READY })

    // The check is OPTIONAL: the trust door is a live mark-done, and the
    // questions stay behind the quiz door until the student walks in.
    await waitFor(() => expect(screen.getByText(/we believe you/i)).toBeTruthy())
    expect(screen.queryByText(/alignment model/i)).toBeNull()
    expect(tick()).toBeNull() // the rail tick — the trust door replaces it here

    fireEvent.click(screen.getByRole('button', { name: /I went through it/i }))
    expect(onToggle).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: /Quiz me first/i }))
    expect(screen.getByText(/alignment model/i)).toBeTruthy()
    expect(screen.getByTestId('main').textContent).toContain('alignment model')
    // Mid-check the trust door stays on screen — bailing out is one tap.
    expect(screen.getByRole('button', { name: /I went through it/i })).toBeTruthy()
    expect(tick()).toBeNull()
  })

  it('settles on the tick when the load fails — never stranded on the placeholder', async () => {
    render(<Harness load={async () => ({ error: 'Could not load the check' })} />)

    await waitFor(() => expect(tick()).toBeTruthy())
    expect(screen.queryByText(/looking for a quick check/i)).toBeNull()
  })

  it('shows the tick alone on a node already ticked — no check, even if one exists', async () => {
    // Re-asking someone to answer five questions about material they have
    // already marked done is noise, so the tick wins outright.
    render(<Harness load={async () => ({ data: READY })} checked />)

    await waitFor(() => expect(tick()).toBeTruthy())
    expect(screen.queryByText(/alignment model/i)).toBeNull()
    expect(screen.getByTestId('main').textContent).toBe('')
  })

  it('shows the generation wait, then the tick when generation never lands', async () => {
    vi.useFakeTimers()
    try {
      // 'preparing' polls a capped number of times (3s apart) before giving up.
      render(<Harness load={async () => ({ data: { kind: 'preparing' } })} />)

      expect(tick()).toBeNull()
      await vi.waitFor(() => expect(screen.getByText(/putting a few questions together/i)).toBeTruthy())
      expect(tick()).toBeNull()

      // Past the poll budget: 5 polls × 3s, plus slack for the awaited loads.
      await vi.advanceTimersByTimeAsync(3000 * 6)
      expect(tick()).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── telling the MAP a check is being written ──────────────────
  // Opening the node is what starts the generation, so nothing else on the page
  // knows it began: the roadmap node reads node_check_state from server data
  // rendered before the click. `onBaking` is that message.
  //
  // Two things about it are load-bearing, and both are asserted below:
  //   · it fires on the TRANSITION only — the caller spends a refetch on every
  //     call, and this hook re-asks every 3s while it waits
  //   · it carries the ITEM ID. node_check_state lives on module_items and is
  //     shared by the whole section, so it can say "still being written" but
  //     never "you asked for it". The id is what lets the map show the state to
  //     the student who clicked and nobody else; drop it and one student's click
  //     lights up every classmate's map and starts their browsers polling.
  describe('onBaking', () => {
    function Reporter({ load, onBaking }: { load: Load; onBaking: (itemId: string, baking: boolean) => void }) {
      const check = useNodeCheck({ itemId: 'item-1', load, onBaking })
      return <div>{check.view?.kind ?? 'waiting'}</div>
    }

    it('reports once while the pool is being written, whatever the poll does', async () => {
      vi.useFakeTimers()
      try {
        const onBaking = vi.fn()
        render(<Reporter load={async () => ({ data: { kind: 'preparing' } })} onBaking={onBaking} />)

        await vi.waitFor(() => expect(onBaking).toHaveBeenCalledWith('item-1', true))
        // Three more polls, still preparing — still exactly one call.
        await vi.advanceTimersByTimeAsync(3000 * 3)
        expect(onBaking).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('says so again when the questions land, so the node can stop saying it', async () => {
      vi.useFakeTimers()
      try {
        const onBaking = vi.fn()
        const views: NodeCheckView[] = [{ kind: 'preparing' }, READY]
        let at = 0
        render(<Reporter load={async () => ({ data: views[Math.min(at++, 1)] })} onBaking={onBaking} />)

        await vi.waitFor(() => expect(onBaking).toHaveBeenCalledWith('item-1', true))
        // The next poll, 3s on, is the one that finds them.
        await vi.advanceTimersByTimeAsync(3000)
        expect(onBaking.mock.calls).toEqual([['item-1', true], ['item-1', false]])
      } finally {
        vi.useRealTimers()
      }
    })

    it('tells the map when it gives up, so the node stops promising questions', async () => {
      /* The two give-up clocks are different lengths — this panel stops at 5 polls,
         the map's watcher runs longer. Without this the map kept shimmering and
         promising questions for a node whose own card had already concluded there
         were none. */
      vi.useFakeTimers()
      try {
        const onBaking = vi.fn()
        render(<Reporter load={async () => ({ data: { kind: 'preparing' } })} onBaking={onBaking} />)

        await vi.waitFor(() => expect(onBaking).toHaveBeenCalledWith('item-1', true))
        await vi.advanceTimersByTimeAsync(3000 * 6) // past this panel's own budget
        expect(onBaking.mock.calls).toEqual([['item-1', true], ['item-1', false]])
      } finally {
        vi.useRealTimers()
      }
    })

    it('still reports when the card was closed before the answer arrived', async () => {
      /* THE case the map state exists for: the student clicks a node and closes it
         again. The first load also enqueues the job, so it can easily outlast that
         Escape — and the report used to sit behind the unmount guard, so the map
         was never told and nothing ever appeared on it. The map owns this state and
         is still mounted; only the panel's own `setView` may be skipped. */
      const gate = deferred<{ data?: NodeCheckView }>()
      const onBaking = vi.fn()
      const { unmount } = render(<Reporter load={() => gate.promise} onBaking={onBaking} />)

      unmount() // the card closes first…
      gate.resolve({ data: { kind: 'preparing' } }) // …and the answer lands after
      await waitFor(() => expect(onBaking).toHaveBeenCalledWith('item-1', true))
    })

    it('never reports for a node that had its check ready all along', async () => {
      const onBaking = vi.fn()
      render(<Reporter load={async () => ({ data: READY })} onBaking={onBaking} />)

      await waitFor(() => expect(screen.getByText('ready')).toBeTruthy())
      // 'false' would be a message about a state the node was never in.
      expect(onBaking).not.toHaveBeenCalled()
    })
  })
})
