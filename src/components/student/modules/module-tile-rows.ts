'use client'

/**
 * Tile-view layout: how many tiles fit on a row, and where the detail panel goes.
 *
 * The panel opens under the ROW of tiles holding the selected one — not under the
 * tile itself — so something has to know how many tiles are on a row, and CSS
 * won't tell us. That is the entire reason this file exists.
 *
 * IMPORTANT: TILE_GRID_CLASS and TILE_BREAKPOINTS describe the SAME grid and must
 * agree. They sit adjacent for exactly that reason — Tailwind needs its class
 * names as build-time literals, so the column counts can't be generated from the
 * table. If they ever drift, the tiles still lay out correctly (everything is ONE
 * CSS grid, and only the panel opts into full width), and the only symptom is the
 * panel opening a row too early. That graceful failure is why this is one grid
 * rather than a separate grid per row.
 */

import { useEffect, useState } from 'react'

/** The grid. Mirrors TILE_BREAKPOINTS below. */
export const TILE_GRID_CLASS =
  'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

/** Widest first — the first entry whose query matches wins. Mirrors the class above. */
export const TILE_BREAKPOINTS = [
  { minWidth: 1280, cols: 4 }, // xl
  { minWidth: 1024, cols: 3 }, // lg
  { minWidth: 640, cols: 2 }, // sm
  { minWidth: 0, cols: 1 }, // base
] as const

/**
 * The column count, given something that can answer a media query.
 *
 * Takes a matcher rather than a width so the answer comes from the SAME mechanism
 * CSS uses. Comparing `window.innerWidth` to the breakpoints instead would
 * disagree with the grid by the width of a scrollbar at exactly the boundary — and
 * be wrong on the one pixel where it matters.
 */
export function tileColumns(matches: (query: string) => boolean): number {
  for (const bp of TILE_BREAKPOINTS) {
    if (bp.minWidth === 0 || matches(`(min-width: ${bp.minWidth}px)`)) return bp.cols
  }
  return 1
}

function readColumns(): number {
  // jsdom has no matchMedia, and the server has no window. One column is the safe
  // read: the panel then opens directly under the selected tile, which is the
  // narrow-screen layout anyway.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 1
  return tileColumns((query) => window.matchMedia(query).matches)
}

/** Live column count, recalculated when the window crosses a breakpoint. */
export function useTileColumns(enabled: boolean): number {
  const [cols, setCols] = useState(readColumns)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const update = () => setCols(readColumns())
    update()
    /* One listener per breakpoint rather than a resize handler: these fire only
       when the column count actually changes, not on every pixel of a drag. */
    const lists = TILE_BREAKPOINTS.filter((bp) => bp.minWidth > 0).map((bp) =>
      window.matchMedia(`(min-width: ${bp.minWidth}px)`),
    )
    for (const list of lists) list.addEventListener('change', update)
    return () => {
      for (const list of lists) list.removeEventListener('change', update)
    }
  }, [enabled])

  return cols
}

/** The shape this file needs of a row — the merged module/divider sequence. */
export interface TileLayoutRow {
  kind: 'module' | 'divider'
  id: string
}

/**
 * The index in `rows` after which the detail panel belongs, or null when nothing
 * is selected (or the selected week isn't on screen).
 *
 * Tiles fill left-to-right, `columns` per row. A divider is a full-width label, so
 * it both ENDS the row before it and starts a fresh one after — "Unit 2" followed
 * by three weeks puts those three weeks on a row of their own rather than letting
 * them finish the row above.
 */
export function panelInsertAfterIndex(
  rows: readonly TileLayoutRow[],
  columns: number,
  selectedId: string | null,
): number | null {
  if (!selectedId) return null
  // A nonsense column count must still lay something out, never divide by zero.
  const perRow = Math.max(1, Math.floor(columns) || 1)

  let run: number[] = []
  /** If the selected week is in the row we just finished, that row's last index. */
  const hit = (): number | null =>
    run.some((i) => rows[i].id === selectedId) ? (run[run.length - 1] as number) : null

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'divider') {
      const found = hit()
      if (found !== null) return found
      run = []
      continue
    }
    run.push(i)
    if (run.length === perRow) {
      const found = hit()
      if (found !== null) return found
      run = []
    }
  }
  // The last row is usually short; the panel still opens under it.
  return hit()
}
