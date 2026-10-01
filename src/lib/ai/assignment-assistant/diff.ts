/**
 * Change-awareness for the authoring Athena.
 *
 * The panel remembers the canvas state as Athena LAST LEFT IT (a per-session in-memory
 * baseline). Before each message it diffs that baseline against the current on-screen
 * state and sends a COMPACT change list, so the model knows what the professor did by
 * hand (edited / added / removed / reordered a component, renamed, etc.) or via Undo —
 * not just the final state. This is what stops Athena trusting a stale "I already drafted
 * that" over a canvas the professor has since changed, and lets it edit intelligently
 * around manual work.
 *
 * Cheap by design: the diff is a handful of short strings (change DESCRIPTIONS, never full
 * content — the full current state already rides in <screen>), computed client-side, and
 * the baseline lives in memory only (the chat is ephemeral, so nothing to persist).
 *
 * Pure + client-safe (no imports beyond the shared types) so it's unit-testable and safe
 * in the browser bundle.
 */
import type { AuthoringState } from './schemas'

export interface StateSnapshot {
  meta: Record<string, string | number | boolean | string[]>
  components: { id: string; type: string; content: string }[]
}

export function snapshotOf(state: AuthoringState | undefined): StateSnapshot {
  return { meta: state?.meta ?? {}, components: state?.components ?? [] }
}

const MAX_LISTED_IDS = 8

function metaChanges(prev: StateSnapshot['meta'], curr: StateSnapshot['meta']): string[] {
  const out: string[] = []
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)])
  for (const k of keys) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(curr[k])) out.push(`changed ${k}`)
  }
  return out
}

/**
 * A compact list of what changed from `prev` → `curr`. Empty array = no changes since the
 * baseline. Returns [] when there's no baseline yet (the first turn), so nothing is claimed.
 */
export function diffAuthoring(prev: StateSnapshot | null, curr: StateSnapshot): string[] {
  if (!prev) return []
  const prevById = new Map(prev.components.map((c) => [c.id, c]))
  const currById = new Map(curr.components.map((c) => [c.id, c]))

  const added = curr.components.filter((c) => !prevById.has(c.id))
  const removed = prev.components.filter((c) => !currById.has(c.id))
  const edited = curr.components.filter((c) => {
    const p = prevById.get(c.id)
    return p && p.content !== c.content
  })

  const changes: string[] = []

  // Special-case a full clear so the model unmistakably knows the canvas is empty now
  // (the exact Undo scenario: "rebuild it" rather than "I already did that").
  if (curr.components.length === 0 && removed.length > 0) {
    changes.push('the professor cleared the canvas — it is now empty (e.g. an Undo or a manual delete)')
  } else {
    if (added.length) changes.push(`added ${added.length} component${added.length > 1 ? 's' : ''}`)
    if (removed.length) changes.push(`removed ${removed.length} component${removed.length > 1 ? 's' : ''}`)
    if (edited.length) {
      const ids = edited.slice(0, MAX_LISTED_IDS).map((c) => c.id).join(', ')
      const more = edited.length > MAX_LISTED_IDS ? `, +${edited.length - MAX_LISTED_IDS} more` : ''
      changes.push(`edited component${edited.length > 1 ? 's' : ''} ${ids}${more}`)
    }
    // Reorder: same id set, different order (only meaningful when nothing was added/removed).
    if (!added.length && !removed.length && prev.components.length === curr.components.length) {
      const reordered = prev.components.some((c, i) => curr.components[i]?.id !== c.id)
      if (reordered) changes.push('reordered components')
    }
  }

  changes.push(...metaChanges(prev.meta, curr.meta))
  return changes
}
