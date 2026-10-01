// Where the tile view's detail panel lands.
//
// This is the one piece of real logic in the tile view, and it fails SILENTLY:
// nothing throws if the panel opens under the wrong row, the page just stops
// making sense — the reader clicks Week 2 and a panel appears somewhere below
// Week 6. It also can't be caught by a type: every answer is a number.
//
// The cases that matter are the boundaries (first/last tile of a row, a short
// final row) and the divider, which is full width and therefore ENDS the row
// before it — the case a hand-rolled `floor(index / columns)` gets wrong.
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  panelInsertAfterIndex,
  tileColumns,
  useTileColumns,
  type TileLayoutRow,
} from '@/components/student/modules/module-tile-rows'

const mods = (...ids: string[]): TileLayoutRow[] => ids.map((id) => ({ kind: 'module', id }))
const divider = (id: string): TileLayoutRow => ({ kind: 'divider', id })

const EIGHT = mods('m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8')

describe('panelInsertAfterIndex — a plain grid', () => {
  it('opens under the whole row, not under the selected tile', () => {
    // m2 is the 2nd of 4 on row one; the panel belongs after m4 so that m3 and m4
    // stay on that row rather than being pushed below the panel.
    expect(panelInsertAfterIndex(EIGHT, 4, 'm2')).toBe(3)
  })

  it('finds a later row', () => {
    expect(panelInsertAfterIndex(EIGHT, 4, 'm5')).toBe(7)
  })

  it('follows the column count', () => {
    // At 3 columns m5 sits on row two (m4, m5, m6), so the panel moves up.
    expect(panelInsertAfterIndex(EIGHT, 3, 'm5')).toBe(5)
    expect(panelInsertAfterIndex(EIGHT, 2, 'm5')).toBe(5)
    // One column per row — the panel is directly under its own tile.
    expect(panelInsertAfterIndex(EIGHT, 1, 'm5')).toBe(4)
  })

  it('handles a short final row', () => {
    const six = mods('m1', 'm2', 'm3', 'm4', 'm5', 'm6')
    expect(panelInsertAfterIndex(six, 4, 'm6')).toBe(5)
  })

  it('is null when nothing is selected or the week is not on screen', () => {
    expect(panelInsertAfterIndex(EIGHT, 4, null)).toBeNull()
    expect(panelInsertAfterIndex(EIGHT, 4, 'unpublished-module')).toBeNull()
  })

  /* A wrong count still has to lay something out — this ran with columns=0 on the
     first render before the media queries were read. */
  it('treats a nonsense column count as one column rather than dividing by zero', () => {
    expect(panelInsertAfterIndex(EIGHT, 0, 'm3')).toBe(2)
    expect(panelInsertAfterIndex(EIGHT, Number.NaN, 'm3')).toBe(2)
  })
})

describe('panelInsertAfterIndex — dividers break the row', () => {
  // "Unit 1" over two weeks, then "Unit 2" over three. At 4 columns a naive
  // index/columns would put every one of these on row zero.
  const rows: TileLayoutRow[] = [
    divider('d1'),
    ...mods('m1', 'm2'),
    divider('d2'),
    ...mods('m3', 'm4', 'm5'),
  ]

  it('closes the row at the divider instead of filling it from the next group', () => {
    // m1 is in a row of two — cut short by "Unit 2" — so the panel goes after m2,
    // above the divider, not after m4.
    expect(panelInsertAfterIndex(rows, 4, 'm1')).toBe(2)
    expect(panelInsertAfterIndex(rows, 4, 'm2')).toBe(2)
  })

  it('starts a fresh row after the divider', () => {
    // m3 begins a new row, so the group's three weeks share it and the panel
    // lands after the last of them.
    expect(panelInsertAfterIndex(rows, 4, 'm3')).toBe(6)
    expect(panelInsertAfterIndex(rows, 4, 'm5')).toBe(6)
  })

  it('still fills rows within a group', () => {
    expect(panelInsertAfterIndex(rows, 2, 'm3')).toBe(5) // m3, m4 fill a row of 2
    expect(panelInsertAfterIndex(rows, 2, 'm5')).toBe(6) // m5 is alone on the next
  })
})

describe('tileColumns', () => {
  /* Asks the same media queries the CSS grid does, rather than comparing
     window.innerWidth to the breakpoints — those disagree by a scrollbar's width
     at exactly the boundary. */
  const upTo = (max: number) => (query: string) => {
    const min = Number(query.match(/(\d+)px/)?.[1])
    return min <= max
  }

  it('reads the widest matching breakpoint', () => {
    expect(tileColumns(upTo(1440))).toBe(4)
    expect(tileColumns(upTo(1100))).toBe(3)
    expect(tileColumns(upTo(800))).toBe(2)
  })

  it('falls back to a single column when no breakpoint matches', () => {
    expect(tileColumns(() => false)).toBe(1)
  })
})

/* The subscription, not the arithmetic. `cols` is useState and the effect's deps
   are [enabled], so nothing recomputes it on re-render — if the listeners are
   never attached, the column count freezes at the mount width for the LIFE of the
   page and never self-heals. The panel then opens under the wrong row after any
   resize, silently. The tile-view test stubs these as no-ops, so this is the only
   place registration and cleanup are exercised. */
describe('useTileColumns — staying in step with the viewport', () => {
  const realMatchMedia = window.matchMedia
  /** Registered listeners, keyed by the query they were attached to. */
  let listeners: Map<string, Set<() => void>>
  let width: number

  const install = (initialWidth: number) => {
    width = initialWidth
    listeners = new Map()
    window.matchMedia = ((query: string) => ({
      get matches() {
        return Number(query.match(/(\d+)px/)?.[1] ?? 0) <= width
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: () => void) => {
        const set = listeners.get(query) ?? new Set()
        set.add(cb)
        listeners.set(query, set)
      },
      removeEventListener: (_: string, cb: () => void) => listeners.get(query)?.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }

  /** Move the viewport and fire the change events a real browser would. */
  const resizeTo = (next: number) => {
    width = next
    for (const set of listeners.values()) for (const cb of set) cb()
  }

  const listenerCount = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)

  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  it('reports the column count for the mount width', () => {
    install(1400)
    const { result } = renderHook(() => useTileColumns(true))
    expect(result.current).toBe(4)
  })

  it('recomputes when the viewport crosses a breakpoint', () => {
    install(1400)
    const { result, rerender } = renderHook(() => useTileColumns(true))
    expect(result.current).toBe(4)

    resizeTo(1100)
    rerender()
    expect(result.current).toBe(3)

    resizeTo(500)
    rerender()
    expect(result.current).toBe(1)
  })

  it('subscribes once per breakpoint and unsubscribes all of them on unmount', () => {
    install(1400)
    const { unmount } = renderHook(() => useTileColumns(true))
    // Three real breakpoints; the base (minWidth 0) needs no query.
    expect(listenerCount()).toBe(3)

    unmount()
    expect(listenerCount()).toBe(0)
  })

  it('attaches nothing while the grid is off screen', () => {
    install(1400)
    renderHook(() => useTileColumns(false))
    expect(listenerCount()).toBe(0)
  })
})
