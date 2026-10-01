/**
 * Re-engagement copy — witty, tiered prompts that win back dormant students.
 *
 * Inspired by Zomato/CRED-style consumer nudges, rebuilt for a classroom. Two hard
 * rules keep clever from tipping into creepy (see docs/briefs/scholera-pulse):
 *   1. OWN DATA ONLY — a prompt references only the student's own signal (their name,
 *      one of their courses, how long they've been away). Never another student's data,
 *      never a fabricated fact, never anything cross-app we can't actually see.
 *   2. TEASE, DON'T REVEAL — no grades/scores in the copy; the payoff is behind a login.
 *
 * The tone escalates with the silence: a wink at 3 days, a genuine last-call at 30.
 * Selection is DETERMINISTIC (seeded off the recipient id) so it's testable and a given
 * student gets a stable prompt rather than a coin-flip on every run.
 */

/** Dormancy tiers, in days. Ascending — tone escalates as the gap grows. */
export const REENGAGEMENT_TIERS = [3, 7, 14, 30] as const
export type ReengagementTier = (typeof REENGAGEMENT_TIERS)[number]

/** Own-data context used to personalise a prompt. All fields are the student's own. */
export interface ReengagementContext {
  /** Student's name (first name is used); falls back to a friendly generic. */
  name: string | null
  /** One course the student is enrolled in (e.g. "CS 546"); may be null. */
  courseLabel: string | null
  /** Whole days since the student was last active. */
  daysDormant: number
  /** One concrete thing the memory layer knows to name, or null. The nudge
   *  reads better when it points at the actual thing they left ("your weakest
   *  topic is cross-entropy") instead of gesturing at the course. Optional
   *  because it is empty for most students, and the copy must read the same
   *  when it is absent rather than leaving a gap. */
  hook?: string | null
}

export interface ReengagementCopy {
  title: string
  body: string
}

/**
 * The highest tier a student has crossed for a given dormancy length, or null if they
 * aren't dormant yet (< the smallest tier). E.g. 20 days → tier 14; 2 days → null.
 */
export function tierForDays(daysDormant: number): ReengagementTier | null {
  let tier: ReengagementTier | null = null
  for (const threshold of REENGAGEMENT_TIERS) {
    if (daysDormant >= threshold) tier = threshold
  }
  return tier
}

/** Stable non-negative hash of a string — deterministic prompt rotation per student. */
export function seedFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

// Prompt pools per tier. Tokens filled from own-data context only:
//   {name}   → first name (or "there")   {course} → a course label (or "your courses")
//   {days}   → whole days dormant
// Keep titles short (they headline a push/bell); bodies one witty line with a way back.
const POOLS: Record<ReengagementTier, ReengagementCopy[]> = {
  3: [
    {
      title: 'the only app we can see is ours 👋',
      body: "{name}, it's been a few days — and {course} misses you. one tap back in?",
    },
    {
      title: 'your assignments are starting to whisper 👀',
      body: "a few quiet days in {course}. nothing's on fire yet — let's keep it that way.",
    },
    {
      title: 'your to-dos are getting ideas 👀',
      body: "a few days off {course} and they start plotting, {name}. come reclaim them?",
    },
  ],
  7: [
    {
      title: 'a whole week 👀',
      body: "{course} kept moving without you, {name} — and it adds up faster than you'd think.",
    },
    {
      title: 'your AI tutor is talking to an empty room 🤖',
      body: "i've been explaining {course} to nobody for about a week, {name}. please come back?",
    },
    {
      title: 'your Scholera streak lapsed',
      body: 'about a week away. the good news: opening it today resets the clock.',
    },
    {
      title: 'the training montage started without you 🎬',
      body: "everyone's mid-semester grind is on — don't be the one who skipped it, {name}. {course}'s waiting.",
    },
  ],
  14: [
    {
      title: '{course} filed a missing-persons report 🔍',
      body: 'last seen: about two weeks ago, vibing. come back and close the case?',
    },
    {
      title: 'your notes are collecting dust 📈',
      body: "your deadlines, meanwhile, are collecting interest. two weeks is a lot — let's chip at it, {name}.",
    },
    {
      title: 'we kept your seat warm 🔥',
      body: "a couple weeks off, but your deadlines didn't take the break you did, {name}. let's catch up.",
    },
    {
      title: 'discipline is a flex 💪',
      body: "your {course} work is the gym; we're the 6am alarm you'll thank later. two weeks off — let's get back to it, {name}.",
    },
  ],
  30: [
    {
      title: "one month. it's not you, it's… okay it's a little you 🥺",
      body: "come back, {name}? {course} is still here, no lecture required.",
    },
    {
      title: 'final boarding call for your semester 🎓',
      body: "a month is a lot to catch up on — this deadline won't wait, but we did. one tap starts it.",
    },
  ],
}

function firstName(name: string | null): string {
  const n = (name ?? '').trim().split(/\s+/)[0]
  return n || 'there'
}

function fill(template: string, ctx: ReengagementContext): string {
  const course = ctx.courseLabel?.trim() || 'your coursework'
  return template
    .replaceAll('{name}', firstName(ctx.name))
    .replaceAll('{course}', course)
    .replaceAll('{days}', String(ctx.daysDormant))
}

/** Append the memory hook as its own sentence, when there is one. Kept out of
 *  the templates so every existing pool line still reads correctly with no
 *  hook, which is the common case. */
function withHook(body: string, hook: string | null | undefined): string {
  const trimmed = hook?.trim()
  return trimmed ? `${body} ${trimmed}` : body
}

/**
 * Pick + personalise a prompt for a tier. Selection is deterministic in `seed` (pass
 * seedFromId(recipientId)) so it's stable per student and testable.
 */
export function pickReengagementCopy(
  tier: ReengagementTier,
  ctx: ReengagementContext,
  seed: number,
): ReengagementCopy {
  const pool = POOLS[tier]
  const chosen = pool[seed % pool.length]
  return { title: fill(chosen.title, ctx), body: withHook(fill(chosen.body, ctx), ctx.hook) }
}
