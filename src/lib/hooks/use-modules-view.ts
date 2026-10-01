'use client'

/**
 * List or tiles — the reader's Modules layout, remembered across visits.
 *
 * localStorage rather than sessionStorage, and NOT keyed by course section: unlike
 * "which weeks I have open right now" (use-module-expansion), which is transient
 * working state, "I read grids better than lists" is a lasting preference that
 * should follow the reader from course to course and week to week.
 *
 * Read via useSyncExternalStore, the same approach as use-module-expansion: the
 * server snapshot is the neutral default and React re-renders with the real value
 * straight after hydration, so there is no mismatch and no setState inside an
 * effect. That also means the tile grid only ever renders in the BROWSER, which is
 * what lets the grid read the window width (see module-tile-rows.ts).
 */

import { useCallback, useState, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'scholera_modules_view'

export const MODULES_VIEWS = ['list', 'tile'] as const
export type ModulesView = (typeof MODULES_VIEWS)[number]

/** List: a reader who never touches the toggle sees the page they already know. */
export const DEFAULT_MODULES_VIEW: ModulesView = 'list'

/** Writes only ever come from this hook, so there's nothing external to watch. */
const noopSubscribe = () => () => {}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Absent, corrupt, or written by an older build — anything unrecognised is list. */
export function parseModulesView(raw: string | null): ModulesView {
  return MODULES_VIEWS.includes(raw as ModulesView) ? (raw as ModulesView) : DEFAULT_MODULES_VIEW
}

export function useModulesView() {
  /* A string, not an object — getSnapshot must return a referentially stable
     value or useSyncExternalStore re-renders forever. */
  const storedRaw = useSyncExternalStore(
    noopSubscribe,
    readStored,
    () => null,
  )

  // Null until the reader picks something; after that it's authoritative.
  const [chosen, setChosen] = useState<ModulesView | null>(null)

  const setView = useCallback((next: ModulesView) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* storage unavailable (private mode, quota) — the choice just won't persist */
    }
    setChosen(next)
  }, [])

  return { view: chosen ?? parseModulesView(storedRaw), setView }
}
