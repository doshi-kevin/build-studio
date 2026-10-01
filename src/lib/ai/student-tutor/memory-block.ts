/**
 * Athena's view of the memory layer: `UserState` in, prompt lines out.
 *
 * This lives on Athena's side rather than in lib/memory because everything it
 * does is presentation. The 8-line ceiling is a context-window constraint, not
 * a statement about what is true, so a dashboard or an email reading the same
 * state gets the whole thing.
 *
 * Rendering, never summarising: no model runs here. Turning
 * `{score: 16, completedActivities: 2}` into "16% across 2 activities" is
 * formatting, and putting an LLM in this path would add cost, latency and a
 * place for facts to drift from their source.
 */

import type { UserState } from '@/lib/memory/state'

/** Per-category caps, so no one category crowds out the rest. Nine lines total
 *  sits just above the six weak topics the shipped prompt already carries and
 *  is known safe; unbounded memory measurably degrades recall. */
const CAPS = { preferences: 3, weakSkills: 3, dueSoon: 2, lastClass: 1 } as const

/**
 * Which three preferences reach the prompt when someone has more than three.
 *
 * Not the three most recent, which is what a plain slice gives you.
 * `readPreferences` returns newest first, so slicing drops whatever was stated
 * earliest — and what a person states earliest is usually the accommodation. A
 * student who said "avoid red and green as the only difference" in week 1 and
 * then three ordinary style preferences in weeks 8 to 12 lost the colour
 * pairing from the prompt entirely, with nothing anywhere to say it had
 * happened.
 *
 * `constraint` comes first because it is the slot that holds the things the
 * model cannot guess a sensible default for: a screen reader, a colour pairing,
 * no animation. The style slots come next, and `context` last, because a model
 * with no context still answers correctly while a model that ignores an
 * accommodation does not. Ordering within each group is left alone, so recency
 * still decides between two constraints.
 */
const SLOT_ORDER: Record<string, number> = {
  constraint: 0,
  answer_length: 1,
  explanation_style: 1,
  language_level: 1,
  tone: 1,
  context: 2,
}

const DAY_MS = 86_400_000

/** "in 3 days" / "tomorrow" — a due date is only useful as a distance. */
function whenDue(dueAt: string): string {
  const days = Math.round((new Date(dueAt).getTime() - Date.now()) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

function whenEnded(endedAt: string): string {
  const days = Math.round((Date.now() - new Date(endedAt).getTime()) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 13) return `${days} days ago`
  return new Date(endedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

/**
 * Build the block, or return null when there is nothing worth saying.
 *
 * Null rather than an empty section on purpose: a heading with nothing under it
 * reads to the model as a fact about the student ("we know nothing about them")
 * and invites it to comment on the emptiness. Silence says nothing at all,
 * which is correct, and is the common case — most students have no memory yet.
 */
export function renderAthenaMemory(state: UserState): string | null {
  const sections: string[] = []

  // Sort is stable, so this reorders by slot without disturbing recency inside
  // a slot group.
  const preferences = [...state.preferences]
    .sort((a, b) => (SLOT_ORDER[a.slot] ?? 2) - (SLOT_ORDER[b.slot] ?? 2))
    .slice(0, CAPS.preferences)
    .map((p) => p.text)
  if (preferences.length > 0) {
    sections.push(`  <preferences>\n    ${preferences.join('\n    ')}\n  </preferences>`)
  }

  const standing = state.weakSkills
    .slice(0, CAPS.weakSkills)
    .map(
      (s) =>
        `${s.skill}, ${s.score}% across ${s.completedActivities} graded ${
          s.completedActivities === 1 ? 'activity' : 'activities'
        }.`,
    )
  if (standing.length > 0) {
    sections.push(`  <where_they_are>\n    ${standing.join('\n    ')}\n  </where_they_are>`)
  }

  const now: string[] = []
  for (const item of state.dueSoon.slice(0, CAPS.dueSoon)) {
    now.push(`${item.title} (${item.kind}) is due ${whenDue(item.dueAt)}.`)
  }
  // Attendance is only worth a line when they were ABSENT. "You attended the
  // last class" tells the model nothing it can act on, and spends a line.
  if (state.lastClass && !state.lastClass.attended) {
    now.push(
      `Missed the live class ${whenEnded(state.lastClass.endedAt)}.` +
        (state.lastClass.hasRecap ? ' A recap is available.' : ''),
    )
  }
  if (now.length > 0) {
    sections.push(`  <right_now>\n    ${now.join('\n    ')}\n  </right_now>`)
  }

  if (sections.length === 0) return null
  return `<memory>\n${sections.join('\n')}\n</memory>`
}
