/**
 * Node keys and the pure helpers the node modal reads.
 *
 * A node key (`type:id`) is the roadmap's stable identity for one box — it joins
 * a card to the per-student journey map, to a `?node=` deep link, and to the
 * modal's typed content fetches. No DB/server imports: client-safe + testable.
 *
 * The old canvas' key→descriptor index (buildNodeIndex / resolveNodeDescriptor)
 * retired with it; the redesigned canvas builds its cards from the prototype
 * adapter instead.
 */

import { skillNamesMatch } from '@/lib/skills/canonical'

/** Every kind of box a node key can name. */
export type DrawerNodeKind =
  | 'module' | 'module_item'
  | 'quiz' | 'assignment' | 'live_session' | 'live_poll' | 'live_quiz'

export interface NodeRef {
  type: DrawerNodeKind
  id: string
}

export const nodeKey = (type: DrawerNodeKind, id: string) => `${type}:${id}`
export function parseNodeKey(key: string): NodeRef {
  const i = key.indexOf(':')
  return { type: key.slice(0, i) as DrawerNodeKind, id: key.slice(i + 1) }
}


/** Flatten an assignment's rubric JSON to its criteria descriptions. Defensive:
 *  the shape is { questions: [{ criteria: [{ description }] }] }; returns [] for a
 *  missing or malformed rubric. Pure — shared by the drawer query and tested. */
export function flattenRubricCriteria(rubric: unknown): string[] {
  const out: string[] = []
  const questions =
    rubric && typeof rubric === 'object' && Array.isArray((rubric as { questions?: unknown }).questions)
      ? (rubric as { questions: Array<{ criteria?: Array<{ description?: unknown }> }> }).questions
      : []
  for (const q of questions) {
    for (const c of q?.criteria ?? []) {
      if (typeof c?.description === 'string' && c.description.trim()) out.push(c.description.trim())
    }
  }
  return out
}

/** 1-based positions of the questions tagged with `skill`, in order — the
 *  "Question N" anchor targets for the unified quiz node modal (the analog of a
 *  topic's referencing page numbers in the material viewer). Also reused for a
 *  live session's children by mapping each child's skills to `tags`. Matches via
 *  skillNamesMatch — the same canonical rule that mapped raw question tags to
 *  curated pool skills in the first place — so a chip's curated name ("N-gram
 *  Language Models") still anchors its raw-tagged questions ("n-grams"). */
export function questionNumbersForSkill(questions: { tags: string[] }[], skill: string): number[] {
  if (!skill.trim()) return []
  const out: number[] = []
  questions.forEach((q, i) => {
    if (q.tags.some((t) => skillNamesMatch(t, skill))) out.push(i + 1)
  })
  return out
}
