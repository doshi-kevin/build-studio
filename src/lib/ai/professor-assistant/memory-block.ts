/**
 * Turn what memory knows about a professor into prompt lines.
 *
 * The professor twin of student-tutor/memory-block.ts, and separate from it on
 * purpose. Both read the same `user_memory` table through the same state layer,
 * but they address different people about different work: one is telling a tutor
 * how a learner wants to be taught, the other is telling an assistant how a
 * professor wants their drafts written. Sharing a renderer would mean one string
 * template with a role flag threaded through every line.
 */

import 'server-only'
import type { StoredPreference } from '@/lib/memory/preferences'

/** Nothing here is derived, so the only budget that matters is the preference
 *  list. Kept short because the professor prompt already carries the course
 *  snapshot, the module list and recent announcements. */
const MAX_PREFERENCES = 5

const SLOT_LABELS: Record<string, string> = {
  announcement_style: 'When writing announcements',
  quiz_style: 'When writing quizzes',
  grading_style: 'When grading',
  workflow: 'How they like to work',
}

/**
 * Returns null when there is nothing worth saying, which is the normal case for
 * a professor who has never stated a preference. Callers must render nothing at
 * all rather than an empty heading.
 */
export function renderProfessorMemory(state: { preferences: StoredPreference[] }): string | null {
  const prefs = state.preferences.slice(0, MAX_PREFERENCES)
  if (prefs.length === 0) return null

  const lines = prefs.map((p) => {
    const label = SLOT_LABELS[p.slot] ?? 'Preference'
    const scope = p.sectionId === null ? ' (in every course)' : ''
    return `- ${label}${scope}: ${p.text}`
  })

  return [
    'WHAT THIS PROFESSOR HAS TOLD YOU ABOUT HOW THEY WORK',
    'They stated these themselves. Follow them without mentioning that you',
    'remembered, and never treat them as facts about the course or its students.',
    ...lines,
  ].join('\n')
}
