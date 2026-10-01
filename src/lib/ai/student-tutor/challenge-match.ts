/**
 * C14 — challenge matchmaking. Design doc §12.2, built as the first `propose`
 * action (§14).
 *
 * "You've mastered graph traversal; challenge #3 matches, 50 pts, closes
 * Sunday." The join is cheap — the challenges page already reads every input —
 * but the ranking is where it can quietly go wrong, so it lives here as a pure
 * function with the IO lifted out and unit tests over the edges.
 *
 * Narrow on purpose (§14.7 D4): strengths only, soonest deadline first. C14's
 * fuller shape (difficulty fit, skills the student is *close* to mastering)
 * belongs to N6, which will widen the input rather than rewrite the ranker.
 *
 * `now` is a parameter, never `Date.now()` — a ranker that reads the clock
 * can't be tested on a deadline boundary.
 */

/** One published challenge, already narrowed to this section. */
export interface ChallengeCandidate {
  id: string
  title: string
  points: number
  bonusPoints: number
  /** ISO, or null for an open-ended challenge. */
  dueAt: string | null
  difficulty: string
  /** Skills this challenge builds, from `activity_skills`. */
  skillIds: string[]
}

export interface RankChallengesInput {
  candidates: ChallengeCandidate[]
  /** Skills the student is already strong on — the match signal. */
  strongSkillIds: string[]
  skillNameById: Record<string, string>
  /** Challenges they've already claimed; proposing one again is noise. */
  claimedChallengeIds: string[]
  now: string
}

export interface RankedChallenge {
  id: string
  title: string
  points: number
  bonusPoints: number
  difficulty: string
  /** Names, not ids — the model writes prose from this and never sees a key. */
  matchedSkills: string[]
  dueAt: string | null
  /** Whole days until it closes; null when it never does. Negative is filtered
   *  out upstream, so this is only ever ≥ 0 here. */
  closesInDays: number | null
}

/** Why there is nothing to propose. An honest named branch beats improvised
 *  advice — the same discipline as the insufficient-context refusal. */
export type NoMatchReason =
  | 'no_open_challenges'
  | 'no_strong_skills'
  | 'no_matching_challenge'

export type ChallengeMatch =
  | { matched: false; reason: NoMatchReason }
  | { matched: true; top: RankedChallenge; alternatives: RankedChallenge[] }

const DAY_MS = 24 * 60 * 60 * 1000

function daysUntil(dueAt: string | null, now: number): number | null {
  if (!dueAt) return null
  return Math.floor((new Date(dueAt).getTime() - now) / DAY_MS)
}

export function rankChallenges(input: RankChallengesInput): ChallengeMatch {
  const now = new Date(input.now).getTime()
  const claimed = new Set(input.claimedChallengeIds)
  const strong = new Set(input.strongSkillIds)

  // A closed challenge and an already-claimed one are both "not on offer".
  // An unparseable due date is treated as open rather than dropped: a bad row
  // should cost the student a ranking signal, not the whole suggestion.
  const open = input.candidates.filter((c) => {
    if (claimed.has(c.id)) return false
    if (!c.dueAt) return true
    const due = new Date(c.dueAt).getTime()
    return Number.isNaN(due) || due > now
  })
  if (open.length === 0) return { matched: false, reason: 'no_open_challenges' }
  if (strong.size === 0) return { matched: false, reason: 'no_strong_skills' }

  const ranked: RankedChallenge[] = open
    .map((c) => ({
      id: c.id,
      title: c.title,
      points: c.points,
      bonusPoints: c.bonusPoints,
      difficulty: c.difficulty,
      matchedSkills: c.skillIds
        .filter((s) => strong.has(s))
        .map((s) => input.skillNameById[s])
        .filter((n): n is string => !!n),
      dueAt: c.dueAt,
      closesInDays: daysUntil(c.dueAt, now),
    }))
    .filter((c) => c.matchedSkills.length > 0)

  if (ranked.length === 0) return { matched: false, reason: 'no_matching_challenge' }

  ranked.sort((a, b) => {
    // Strongest match first — that's the claim the answer makes.
    if (b.matchedSkills.length !== a.matchedSkills.length) {
      return b.matchedSkills.length - a.matchedSkills.length
    }
    // Then what closes soonest; open-ended sinks below anything with a date.
    if (a.closesInDays !== b.closesInDays) {
      if (a.closesInDays === null) return 1
      if (b.closesInDays === null) return -1
      return a.closesInDays - b.closesInDays
    }
    if (b.points !== a.points) return b.points - a.points
    // Title last, so the order is stable across identical rows.
    return a.title.localeCompare(b.title)
  })

  // Two alternatives, not the whole board: the proposal is "claim this one",
  // and a list of ten is a menu, which is the thing the drive exists to avoid.
  return { matched: true, top: ranked[0], alternatives: ranked.slice(1, 3) }
}
