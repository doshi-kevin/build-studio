/**
 * Deep-link targets for a concept's assessment sources (ConceptDetail modal).
 *
 * Quizzes AND exams live at /quizzes/[id]; assignments at /assignments/[id].
 * Live-classroom quizzes have no per-interaction page, so they deep-link to the
 * live-classroom hub (its Quizzes tab holds past live-quiz results). Pure so the
 * routing contract is unit-tested — it regressed once (quizzes dropped the id and
 * landed on the list page instead of the specific quiz).
 */

import type { ActivityType } from '@/lib/validations/skill'

export type ConceptSourceType = ActivityType | 'live_quiz'

/** Same-origin app paths only — `/x`, never `//host`, `javascript:` or an
 *  absolute URL. The gate that keeps a caller-supplied href from becoming a
 *  navigation primitive (CWE-601). Shared by the annotation layer's rich-text
 *  links and RoadmapEmptyState's CTA. */
export const safeAppPath = (href: string | undefined): string | null =>
  // A leading slash followed by neither / nor \. The backslash matters: the URL
  // parser folds `\` into `/` for special schemes, so `/\evil.com` is
  // protocol-relative and resolves off-origin exactly like `//evil.com`.
  href && /^\/(?![/\\])/.test(href) ? href : null

export function conceptSourceHref(
  sectionId: string,
  source: { type: ConceptSourceType; id: string },
): string {
  const base = `/professor/courses/${sectionId}`
  if (source.type === 'assignment') return `${base}/assignments/${source.id}`
  if (source.type === 'live_quiz') return `${base}/live-classroom`
  return `${base}/quizzes/${source.id}` // quiz | exam
}
