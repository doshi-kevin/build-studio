/**
 * Two "no dead ends, no validator-speak" fixes.
 *
 * #379 part 2: the adaptive player's error screen was a true dead end. Browser QA measured ZERO
 * links and ZERO buttons on it, so a student who landed on "Maximum attempts reached" was stranded
 * with only the sidebar. The race that puts them there did not reproduce, and the dead end does not
 * depend on it: a screen with no way forward is its own bug, so it is fixed regardless.
 *
 * #703 part 6: `title` carried human validation messages and the numeric fields did not, so Zod's
 * own text reached the professor as a toast ("Too big: expected number to be <=1000"). Same family
 * as #617 and #717 part 4.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createChallengeSchema } from '@/lib/validations/challenge'

const PLAYER = readFileSync(
  join(process.cwd(), 'src/components/student/quizzes/AdaptiveQuizPlayer.tsx'),
  'utf8',
)

describe('#379 part 2: the error screen has a way out', () => {
  it('renders a navigation action, not just the error text', () => {
    /* The whole defect in one assertion. The previous render was
       `<CenterMsg><XCircle /> {error}</CenterMsg>` and nothing else. */
    const errorBlock = PLAYER.slice(
      PLAYER.indexOf("if (status === 'error')"),
      PLAYER.indexOf("if (status === 'done')"),
    )
    expect(errorBlock).toMatch(/<Button/)
    expect(errorBlock).toMatch(/router\.push/)
  })

  it('words the exhausted case as an outcome rather than a failure', () => {
    /* Using all your attempts is a normal thing to do, so it should not carry an error icon and
       destructive styling. */
    const errorBlock = PLAYER.slice(
      PLAYER.indexOf("if (status === 'error')"),
      PLAYER.indexOf("if (status === 'done')"),
    )
    expect(errorBlock).toMatch(/maximum attempts/i)
    expect(errorBlock).toMatch(/used all your attempts/i)
  })
})

describe('#703 part 6: no raw Zod strings on challenge validation', () => {
  /* Asserted through the real schema rather than by grepping for `.message`, so the test fails if a
     bound is added later without one. Zod's own text starts with "Too big"/"Too small"/"Invalid",
     and none of ours should. */
  const zodOwnVoice = /^(Too big|Too small|Invalid|Expected|Required)/i

  it('gives a readable message when points exceed the cap', () => {
    const r = createChallengeSchema.safeParse({ title: 'X', points: 5000 })
    expect(r.success).toBe(false)
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? ''
      expect(msg).not.toMatch(zodOwnVoice)
      expect(msg).toMatch(/1,000 or fewer/)
    }
  })

  it('gives a readable message for negative bonus points', () => {
    const r = createChallengeSchema.safeParse({ title: 'X', bonus_points: -1 })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.message ?? '').not.toMatch(zodOwnVoice)
    }
  })

  it('gives a readable message for an out-of-range max_claims', () => {
    const r = createChallengeSchema.safeParse({ title: 'X', max_claims: 9999 })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.message ?? '').not.toMatch(zodOwnVoice)
    }
  })
})
