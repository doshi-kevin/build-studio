'use client'

/**
 * Which Modules sections are open, remembered per course section.
 *
 * Sections are collapsed by default — a semester of modules expanded at once
 * is the "scroll of death" this redesign exists to remove — so only the first
 * one opens on a first visit. After that the reader's own choice is restored,
 * which also stops a server revalidation (publishing, reordering, deleting)
 * from snapping every section shut mid-task.
 *
 * sessionStorage rather than localStorage on purpose: "what I have open right
 * now" is transient working state, not a preference worth resurrecting weeks
 * later.
 *
 * Read via useSyncExternalStore (same approach as DashboardGreeting) rather
 * than a read-after-mount effect: the server snapshot is the neutral default
 * and React re-renders with the real value straight after hydration, so there
 * is no mismatch and no setState inside an effect.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

const STORAGE_PREFIX = 'scholera_modules_expanded:'

/** Writes only ever come from this hook, so there's nothing external to watch. */
const noopSubscribe = () => () => {}

function readRaw(sectionId: string): string | null {
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + sectionId)
  } catch {
    return null
  }
}

function parseStored(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null
  } catch {
    return null
  }
}

function writeStored(sectionId: string, ids: string[]) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + sectionId, JSON.stringify(ids))
  } catch {
    /* storage unavailable (private mode, quota) — expansion just won't persist */
  }
}

export function useModuleExpansion(sectionId: string, moduleIds: string[]) {
  const firstModuleId = moduleIds[0]

  /* A string, not a Set — getSnapshot must return a referentially stable value
     or useSyncExternalStore re-renders forever. */
  const storedRaw = useSyncExternalStore(
    noopSubscribe,
    () => readRaw(sectionId),
    () => null,
  )

  // Null until the reader touches something; after that it's authoritative.
  const [chosen, setChosen] = useState<Set<string> | null>(null)

  const expanded = useMemo(() => {
    if (chosen) return chosen
    // Drop ids for modules that no longer exist so the set can't grow forever.
    const stored = parseStored(storedRaw)?.filter((id) => moduleIds.includes(id))
    if (stored) return new Set(stored)
    return new Set(firstModuleId ? [firstModuleId] : [])
  }, [chosen, storedRaw, moduleIds, firstModuleId])

  /**
   * True while `expanded` is still the first-visit DEFAULT — nothing stored and
   * the reader hasn't touched anything — rather than a state they chose.
   *
   * Opening the first section on arrival is a LIST default. The tile grid reads it
   * differently: a panel already open under the first row looks like something was
   * clicked, so the grid starts fully collapsed and uses this to tell the two
   * apart. Once anything is stored (including a deliberate all-closed), both views
   * honour it and switching layouts keeps the reader's place.
   */
  const usingDefault = chosen === null && parseStored(storedRaw) === null

  const commit = useCallback(
    (next: Set<string>) => {
      writeStored(sectionId, [...next])
      setChosen(next)
    },
    [sectionId],
  )

  const toggle = useCallback(
    (moduleId: string) => {
      const next = new Set(expanded)
      if (next.has(moduleId)) next.delete(moduleId)
      else next.add(moduleId)
      commit(next)
    },
    [expanded, commit],
  )

  /** Open a section without closing anything — used by ?item= / ?section= links. */
  const expand = useCallback(
    (moduleId: string) => {
      if (expanded.has(moduleId)) return
      commit(new Set(expanded).add(moduleId))
    },
    [expanded, commit],
  )

  /**
   * Make this the only open section, or close everything with null.
   *
   * The student tile view has one detail panel and one Collapse button, so it
   * can't express itself with `toggle` — but it shares this state with the list so
   * that switching layouts keeps the reader's place.
   */
  const setOnly = useCallback(
    (moduleId: string | null) => {
      commit(new Set(moduleId ? [moduleId] : []))
    },
    [commit],
  )

  return { expanded, toggle, expand, setOnly, usingDefault }
}
