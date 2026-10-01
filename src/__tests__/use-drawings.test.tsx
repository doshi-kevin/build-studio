// Tests for the useDrawings hook — guards the canvas state machine that
// merges persisted (snapshot) annotations with live broadcast strokes.
//
// Two regressions matter most here:
//  1. "clear → draw → ghosts come back": addStroke() must NEVER reset the
//     per-slide cleared filter, or a single stroke after Clear All resurrects
//     every persisted stroke the clear just hid.
//  2. "fresh strokes vanish on slide navigation": live strokes are bucketed
//     per slide, so drawing on slide B must not discard slide A's in-session
//     strokes — returning to slide A must still show them.

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDrawings } from '@/lib/live-classroom/broadcast/use-drawings'
import { EventBus } from '@/lib/live-classroom/broadcast/event-bus'
import type { Stroke } from '@/lib/live-classroom/drawings/types'

const AUTHOR_ID = '11111111-1111-4111-8111-111111111111'
const DECK_ID = 'deck-11111111-1111-4111-8111-111111111111'

function buildStroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: overrides.id ?? `stroke-${Math.random().toString(36).slice(2)}`,
    slideIndex: overrides.slideIndex ?? 0,
    points: overrides.points ?? [{ x: 0, y: 0, t: 0 }],
    color: overrides.color ?? '#000000',
    width: overrides.width ?? 2,
    authorId: overrides.authorId ?? AUTHOR_ID,
  }
}

function envelope<T extends string>(type: T, data: unknown) {
  return { seq: null, ts: 't', type, data } as never
}

describe('useDrawings', () => {
  it('hydrates strokes for the current slide from initialAnnotations', () => {
    const bus = new EventBus()
    const initial = [
      buildStroke({ id: 'a', slideIndex: 0 }),
      buildStroke({ id: 'b', slideIndex: 1 }),
      buildStroke({ id: 'c', slideIndex: 0 }),
    ]
    const { result } = renderHook(() =>
      useDrawings({ bus, initialAnnotations: initial, slideIndex: 0, deckId: DECK_ID }),
    )
    expect(result.current.strokes.map((s) => s.id).sort()).toEqual(['a', 'c'])
  })

  it('appends incoming live strokes to the current slide', () => {
    const bus = new EventBus()
    const { result } = renderHook(() =>
      useDrawings({ bus, initialAnnotations: [], slideIndex: 0, deckId: DECK_ID }),
    )

    act(() => {
      bus.emit(envelope('drawing_stroke', buildStroke({ id: 'live-1', slideIndex: 0 })))
    })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['live-1'])
  })

  it('dedupes broadcast strokes that arrive twice with the same id', () => {
    const bus = new EventBus()
    const { result } = renderHook(() =>
      useDrawings({ bus, initialAnnotations: [], slideIndex: 0, deckId: DECK_ID }),
    )

    const stroke = buildStroke({ id: 'dup', slideIndex: 0 })
    act(() => {
      bus.emit(envelope('drawing_stroke', stroke))
      bus.emit(envelope('drawing_stroke', stroke))
    })
    expect(result.current.strokes).toHaveLength(1)
  })

  it('does not render a stroke that belongs to a different slide', () => {
    // A stroke for slide 0 arriving while viewing slide 1 must not render on
    // slide 1 — but (unlike the old single-slot bucket) it is retained so it
    // shows when the user navigates to slide 0 (see the navigation regression).
    const bus = new EventBus()
    const { result, rerender } = renderHook(
      ({ slideIndex }: { slideIndex: number }) =>
        useDrawings({ bus, initialAnnotations: [], slideIndex, deckId: DECK_ID }),
      { initialProps: { slideIndex: 1 } },
    )

    act(() => {
      bus.emit(envelope('drawing_stroke', buildStroke({ id: 'on-slide-0', slideIndex: 0 })))
    })
    // Still on slide 1 — the slide-0 stroke must not render here.
    expect(result.current.strokes).toHaveLength(0)

    // Navigate to slide 0 — the stroke was retained, not discarded.
    rerender({ slideIndex: 0 })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['on-slide-0'])
  })

  it('REGRESSION: retains a slide\'s live strokes after navigating away and back', () => {
    // The bug: the prof draws on slide 0, moves to slide 1 and draws there,
    // returns to slide 0 — slide 0's fresh stroke was gone (a single-slot live
    // bucket got overwritten by slide 1's stroke). Fresh strokes are never
    // merged into initialAnnotations, so a per-slide live map is the only thing
    // keeping them until a reload. Drive it through addStroke() to mirror the
    // local drawer path (Broadcast does not echo `self`).
    const bus = new EventBus()
    const { result, rerender } = renderHook(
      ({ slideIndex }: { slideIndex: number }) =>
        useDrawings({ bus, initialAnnotations: [], slideIndex, deckId: DECK_ID }),
      { initialProps: { slideIndex: 0 } },
    )

    act(() => {
      result.current.addStroke(buildStroke({ id: 's0-fresh', slideIndex: 0 }))
    })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['s0-fresh'])

    rerender({ slideIndex: 1 })
    act(() => {
      result.current.addStroke(buildStroke({ id: 's1-fresh', slideIndex: 1 }))
    })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['s1-fresh'])

    // Back to slide 0 — its fresh stroke must still be there.
    rerender({ slideIndex: 0 })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['s0-fresh'])
  })

  it('resets live strokes and cleared-slide flags when the deck changes', () => {
    // Live strokes and the cleared filter are keyed only by slideIndex, so a
    // deck switch must reset them — otherwise deck A's in-session strokes (or a
    // cleared-slide flag) would leak onto deck B's same slide index.
    const bus = new EventBus()
    const initialA = [buildStroke({ id: 'deckA-persist', slideIndex: 0 })]
    const { result, rerender } = renderHook(
      ({ deckId, initialAnnotations }: { deckId: string; initialAnnotations: Stroke[] }) =>
        useDrawings({ bus, initialAnnotations, slideIndex: 0, deckId }),
      { initialProps: { deckId: DECK_ID, initialAnnotations: initialA } },
    )

    act(() => {
      result.current.addStroke(buildStroke({ id: 'deckA-live', slideIndex: 0 }))
      bus.emit(envelope('drawing_clear', { slideIndex: 0 }))
    })
    // Cleared: initial hidden, live wiped.
    expect(result.current.strokes).toHaveLength(0)

    // Switch to deck B (fresh snapshot brings deck B's own strokes for slide 0).
    const initialB = [buildStroke({ id: 'deckB-persist', slideIndex: 0 })]
    rerender({ deckId: 'deck-22222222-2222-4222-8222-222222222222', initialAnnotations: initialB })

    // The cleared flag from deck A must NOT suppress deck B's slide-0 strokes,
    // and deck A's live stroke must not appear.
    expect(result.current.strokes.map((s) => s.id)).toEqual(['deckB-persist'])
  })

  it('drawing_clear wipes both initial and live strokes for the target slide', () => {
    const bus = new EventBus()
    const initial = [buildStroke({ id: 'persist-1', slideIndex: 0 })]
    const { result } = renderHook(() =>
      useDrawings({ bus, initialAnnotations: initial, slideIndex: 0, deckId: DECK_ID }),
    )

    act(() => {
      bus.emit(envelope('drawing_stroke', buildStroke({ id: 'live-1', slideIndex: 0 })))
    })
    expect(result.current.strokes).toHaveLength(2)

    act(() => {
      bus.emit(envelope('drawing_clear', { slideIndex: 0 }))
    })
    expect(result.current.strokes).toHaveLength(0)
  })

  it('REGRESSION: drawing_clear followed by a new stroke does NOT resurrect persisted strokes', () => {
    // The bug: prof clears, draws a red stroke, and the previously-persisted
    // blue strokes ghost back onto the canvas. Caused by an earlier
    // implementation that un-cleared the slide whenever any drawing_stroke
    // event landed. The fix is the one-way clearedInitial set — once a
    // slide is cleared, no stroke event should re-add the persisted entries.
    const bus = new EventBus()
    const initial = [
      buildStroke({ id: 'blue-1', slideIndex: 0 }),
      buildStroke({ id: 'blue-2', slideIndex: 0 }),
    ]
    const { result } = renderHook(() =>
      useDrawings({ bus, initialAnnotations: initial, slideIndex: 0, deckId: DECK_ID }),
    )
    expect(result.current.strokes).toHaveLength(2)

    act(() => {
      bus.emit(envelope('drawing_clear', { slideIndex: 0 }))
    })
    expect(result.current.strokes).toHaveLength(0)

    act(() => {
      bus.emit(envelope('drawing_stroke', buildStroke({ id: 'red', slideIndex: 0 })))
    })

    const ids = result.current.strokes.map((s) => s.id)
    expect(ids).toEqual(['red'])
    expect(ids).not.toContain('blue-1')
    expect(ids).not.toContain('blue-2')
  })

  it('REGRESSION: addStroke() does NOT resurrect persisted strokes after a local clear', () => {
    // The local-render twin of the bug above. The professor's own canvas
    // calls addStroke() directly (Supabase Broadcast does not echo `self`),
    // so addStroke MUST also avoid touching clearedInitial.
    const bus = new EventBus()
    const initial = [buildStroke({ id: 'old-1', slideIndex: 0 })]
    const { result } = renderHook(() =>
      useDrawings({ bus, initialAnnotations: initial, slideIndex: 0, deckId: DECK_ID }),
    )

    act(() => {
      result.current.clearStrokes()
    })
    expect(result.current.strokes).toHaveLength(0)

    act(() => {
      result.current.addStroke(buildStroke({ id: 'new-stroke', slideIndex: 0 }))
    })

    expect(result.current.strokes.map((s) => s.id)).toEqual(['new-stroke'])
  })

  it('does not affect other slides when one slide is cleared', () => {
    // Per-slide cleared state must be isolated: clearing slide 0 must leave
    // slide 1's persisted annotations untouched.
    const bus = new EventBus()
    const initial = [
      buildStroke({ id: 's0', slideIndex: 0 }),
      buildStroke({ id: 's1', slideIndex: 1 }),
    ]
    const { result, rerender } = renderHook(
      ({ slideIndex }: { slideIndex: number }) =>
        useDrawings({ bus, initialAnnotations: initial, slideIndex, deckId: DECK_ID }),
      { initialProps: { slideIndex: 0 } },
    )

    act(() => {
      bus.emit(envelope('drawing_clear', { slideIndex: 0 }))
    })
    expect(result.current.strokes).toHaveLength(0)

    rerender({ slideIndex: 1 })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['s1'])
  })

  it("drawing_clear on one slide leaves another slide's live strokes intact", () => {
    // The clear path was reworked from a single-slot bucket to a per-slide map.
    // Clearing slide 0 must wipe only slide 0's live deltas — slide 1's
    // in-session strokes must survive (a naive reset-all would drop them, and
    // no persisted-strokes isolation test would catch that).
    const bus = new EventBus()
    const { result, rerender } = renderHook(
      ({ slideIndex }: { slideIndex: number }) =>
        useDrawings({ bus, initialAnnotations: [], slideIndex, deckId: DECK_ID }),
      { initialProps: { slideIndex: 0 } },
    )

    act(() => {
      result.current.addStroke(buildStroke({ id: 's0-live', slideIndex: 0 }))
      result.current.addStroke(buildStroke({ id: 's1-live', slideIndex: 1 }))
      bus.emit(envelope('drawing_clear', { slideIndex: 0 }))
    })
    expect(result.current.strokes).toHaveLength(0) // slide 0 cleared

    rerender({ slideIndex: 1 })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['s1-live'])
  })

  it('addStroke dedupes by id', () => {
    const bus = new EventBus()
    const { result } = renderHook(() =>
      useDrawings({ bus, initialAnnotations: [], slideIndex: 0, deckId: DECK_ID }),
    )

    const stroke = buildStroke({ id: 'self-1', slideIndex: 0 })
    act(() => {
      result.current.addStroke(stroke)
      result.current.addStroke(stroke)
    })
    expect(result.current.strokes).toHaveLength(1)
  })

  it('clearStrokes only clears the currently-viewed slide', () => {
    const bus = new EventBus()
    const initial = [
      buildStroke({ id: 's0', slideIndex: 0 }),
      buildStroke({ id: 's1', slideIndex: 1 }),
    ]
    const { result, rerender } = renderHook(
      ({ slideIndex }: { slideIndex: number }) =>
        useDrawings({ bus, initialAnnotations: initial, slideIndex, deckId: DECK_ID }),
      { initialProps: { slideIndex: 0 } },
    )

    act(() => {
      result.current.clearStrokes()
    })

    rerender({ slideIndex: 1 })
    expect(result.current.strokes.map((s) => s.id)).toEqual(['s1'])
  })
})
