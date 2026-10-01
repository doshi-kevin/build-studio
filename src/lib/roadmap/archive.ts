// Roadmap archive — the pure half: where the list lives and how to read it.
//
// Archiving is a view decision, not a deletion: the node's own row and its module
// placement are left completely alone, which is what makes "put it back" exact —
// restoring is removing the key from this list, and the card returns to the same
// week, the same column, the same slot it left.
//
// Stored as `course_sections.settings.roadmapArchived` (a jsonb string[] of node
// keys), alongside enabledFeatures / sidebarHidden / sidebarOrder.
//
// Separate from archive-actions.ts because that file is `'use server'`, which may
// only export async functions — a shared constant or a sync reader cannot live
// there (the build fails, not the types).

import type { CourseModule, Resource, Session } from './prototype-adapter'

export const ROADMAP_ARCHIVED_KEY = 'roadmapArchived'

/** Node keys come from the client, so they're untrusted. Only the shapes the
 *  roadmap adapter actually mints are accepted — otherwise arbitrary strings
 *  would accumulate in `settings`, which is re-read on every page load for the
 *  section and copied into cloned sections. */
export const ARCHIVABLE_NODE_KEY = /^(?:module_item|quiz|assignment|live_session|session):[0-9a-fA-F-]{36}$/

/** A hard ceiling on the list. A professor archiving this much has a different
 *  problem than a missing button, and settings is not a bulk store. */
export const MAX_ARCHIVED = 300

/** Reads the archived list out of a settings blob, tolerating absent/garbage. */
export function readArchivedKeys(settings: unknown): string[] {
  const s = (settings ?? {}) as Record<string, unknown>
  const list = s[ROADMAP_ARCHIVED_KEY]
  return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []
}

/* ── the Archive, professor flavour ──────────────────────────────────────────
   A node the professor has taken off the map. Nothing is deleted and no
   placement is touched, so "put it back" is exact: drop the key and the card
   returns to the week, column and slot it left (see archive-actions.ts).
   One parked node, whatever kind it was. `where` is the week it came from — the
   tray is out of the map's context, so each card has to carry its own. */
/** `where` for a card that had no module to begin with — the tray renders it as
 *  its own phrase rather than "from no week yet", which reads as a typo. */
export const NO_WEEK = 'no week yet'

export type ArchivedNode = { key: string; where: string } & ({ r: Resource } | { s: Session })
export const isArchivedRes = (a: ArchivedNode): a is ArchivedNode & { r: Resource } => 'r' in a

/** The course with every archived node removed — what the map draws. Returns
 *  the input untouched when nothing in it is archived, so the layout memos
 *  don't rebuild for an empty Archive. */
export function stripArchived(course: CourseModule[], keys: ReadonlySet<string>): CourseModule[] {
  const gone = (x: { key?: string }) => !!x.key && keys.has(x.key)
  let touched = false
  const out = course.map((m) => {
    const materials = m.materials.filter((r) => !gone(r))
    const quizzes = m.quizzes.filter((r) => !gone(r))
    const assignments = m.assignments.filter((r) => !gone(r))
    const sessions = m.sessions?.filter((s) => !gone(s))
    const liveRoom = m.liveRoom && gone(m.liveRoom) ? undefined : m.liveRoom
    if (materials.length === m.materials.length && quizzes.length === m.quizzes.length
      && assignments.length === m.assignments.length
      && (sessions?.length ?? 0) === (m.sessions?.length ?? 0)
      && liveRoom === m.liveRoom) return m
    touched = true
    /* `live` is what draws the LIVE node; archiving the room must take the flag
       with it, or the band renders a live room that has no room. */
    return { ...m, materials, quizzes, assignments, sessions, liveRoom, live: liveRoom ? m.live : false }
  })
  return touched ? out : course
}

/** The archived nodes themselves, read off the UNFILTERED course (plus the
 *  unplaced pile, which is a lane of the map like any other). */
export function collectArchived(course: CourseModule[], unplaced: Resource[], keys: ReadonlySet<string>, titles: string[]): ArchivedNode[] {
  if (keys.size === 0) return []
  const out: ArchivedNode[] = []
  for (const r of unplaced) {
    if (r.key && keys.has(r.key)) out.push({ key: r.key, where: NO_WEEK, r })
  }
  course.forEach((m, i) => {
    const where = titles[i] ?? m.title
    for (const r of [...m.materials, ...m.quizzes, ...m.assignments]) {
      if (r.key && keys.has(r.key)) out.push({ key: r.key, where, r })
    }
    for (const s of [...(m.sessions ?? []), ...(m.liveRoom ? [m.liveRoom] : [])]) {
      if (s.key && keys.has(s.key)) out.push({ key: s.key, where, s })
    }
  })
  return out
}

/** A placement the professor has just made, not yet confirmed by the server:
 *  resource key → index of the module band it was dropped on. */
export type PendingPlacement = Record<string, number>

/**
 * Put just-dropped cards into the modules they were dropped on, so the map shows
 * the placement immediately instead of after the write and the refetch.
 *
 * Idempotent by key: once the refresh brings the real course back, the card is
 * already in that module and this adds nothing — which is what lets the pending
 * map be dropped lazily rather than raced against the refresh.
 */
export function withPendingPlacements(
  course: CourseModule[],
  unplaced: Resource[],
  pending: PendingPlacement,
): CourseModule[] {
  const keys = Object.keys(pending)
  if (keys.length === 0) return course
  const byModule = new Map<number, Resource[]>()
  for (const key of keys) {
    const r = unplaced.find((u) => u.key === key)
    const mi = pending[key]
    if (!r || !course[mi]) continue
    const has = [...course[mi].quizzes, ...course[mi].assignments].some((x) => x.key === key)
    if (has) continue
    const list = byModule.get(mi)
    if (list) list.push(r)
    else byModule.set(mi, [r])
  }
  if (byModule.size === 0) return course
  return course.map((m, i) => {
    const add = byModule.get(i)
    if (!add) return m
    return {
      ...m,
      quizzes: [...m.quizzes, ...add.filter((r) => r.k === 'quiz')],
      assignments: [...m.assignments, ...add.filter((r) => r.k !== 'quiz')],
    }
  })
}
