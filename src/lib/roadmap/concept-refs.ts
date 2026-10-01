/**
 * concept-refs — per-skill cross-references for a node modal's right rail:
 * which node TEACHES a skill, and which activities ASSESS it.
 *
 * Pure. "Taught in" is derived from the roadmap's own nodes (every item that
 * lists the skill among its topics) and was written out three times across the
 * two old roadmap clients and the redesigned one. It lives here now.
 *
 * "Assessed by" cannot be derived the same way: the professor reads it from the
 * section's concept analytics (keyed by topic id) and the student from their own
 * scores (keyed by name). Each caller flattens its own source to
 * `normalised skill name → activity titles` and passes it in.
 */

import { normalizeTopicKey } from './journey-state'
import type { AutoRoadmapData } from '@/lib/validations/auto-roadmap'

export interface ConceptRefs {
  /** Titles of the nodes that teach this skill. */
  taughtIn: string[]
  /** Titles of the quizzes / assignments that assess it. */
  assessedBy: string[]
}

/* The SAME normaliser getMyConceptScores keys the student's concept map with.
   Imported rather than re-spelled: these two have to agree or every student
   "Assessed by" row silently disappears, and a local copy makes that agreement
   a coincidence instead of a dependency. */
const norm = normalizeTopicKey

/** normalised skill name → the titles of the roadmap nodes that teach it. */
export function taughtInByName(data: AutoRoadmapData): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const add = (title: string, topics: string[] | undefined) => {
    for (const label of topics ?? []) (out[norm(label)] ??= []).push(title)
  }
  for (const w of data.weeks) for (const it of w.items) add(it.title, it.topics)
  return out
}

/**
 * Merge both directions into one map the modal can read by skill name.
 *
 * Keyed by NORMALISED name so a curated chip ("N-gram Language Models") and the
 * label stored on a node ("n-gram language models") land on the same entry.
 */
export function buildConceptRefs(
  data: AutoRoadmapData,
  assessedByName: Record<string, string[]>,
  /** Titles that are actually ON the map. Absent = everything in `data` is.
   *  Supplied by the student page, whose course has had the professor's archived
   *  nodes stripped out of it: this rail is read from the node modal, so without
   *  the filter an archived node's TITLE keeps reaching the student through a
   *  cross-reference — the last route by which a card taken off the map is still
   *  named on it. */
  onMap?: ReadonlySet<string>,
): Record<string, ConceptRefs> {
  const taught = taughtInByName(data)
  const out: Record<string, ConceptRefs> = {}
  for (const key of new Set([...Object.keys(taught), ...Object.keys(assessedByName)])) {
    const t = taught[key] ?? []
    out[key] = {
      taughtIn: onMap ? t.filter((title) => onMap.has(title)) : t,
      assessedBy: assessedByName[key] ?? [],
    }
  }
  return out
}
