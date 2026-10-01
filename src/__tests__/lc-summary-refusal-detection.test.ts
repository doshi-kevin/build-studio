/**
 * #646 part 2 — with thin lecture material the model replies asking for the content
 * instead of summarizing it, and that reply was stored and shown to students AS their
 * lecture recap. One stored summary was a 222-character "Please provide the text from
 * the slides…". The only validation was non-emptiness, and a refusal is not empty.
 *
 * The risk runs BOTH ways, so both are pinned: too loose and a real summary gets
 * thrown away, which is worse than the bug — a student loses genuine content instead
 * of seeing an honest "unavailable". Hence the length ceiling and the
 * must-appear-at-the-start rule, and hence the false-positive cases below.
 */

import { describe, it, expect } from 'vitest'
import { looksLikeSummaryRefusal } from '@/lib/validations/lecture-summary'

describe('looksLikeSummaryRefusal', () => {
  it('catches the refusal actually observed in production', () => {
    expect(
      looksLikeSummaryRefusal(
        'Please provide the text from the slides and the transcription of the lecture so I can summarize it for you. I need the content to produce a summary.',
      ),
    ).toBe(true)
  })

  it.each([
    'I need the slide content to write a summary.',
    'No content was provided, so there is nothing to summarize.',
    "I don't have any lecture material to work from.",
    'Could you provide the transcript?',
  ])('catches: %s', (reply) => {
    expect(looksLikeSummaryRefusal(reply)).toBe(true)
  })

  it('does NOT discard a real summary that happens to mention missing content', () => {
    const real =
      'The lecture covered binary search trees, starting from the ordering invariant and moving to insertion and deletion. ' +
      'The professor noted that no content was provided for the final section on balancing, which will be covered next week. ' +
      'Rotations were introduced briefly, with AVL trees promised as the follow-up. Students asked about worst-case height ' +
      'and the professor worked through the degenerate case where every insertion appends to the right spine, giving O(n) ' +
      'lookups and motivating self-balancing structures in the first place.'
    expect(real.length).toBeGreaterThan(400)
    expect(looksLikeSummaryRefusal(real)).toBe(false)
  })

  it('does NOT discard a short but genuine summary', () => {
    expect(
      looksLikeSummaryRefusal('The class covered recursion, base cases, and two worked examples.'),
    ).toBe(false)
  })

  it('ignores a refusal-like phrase that appears late in a short reply', () => {
    // The rule is "opens with a refusal" — mid-sentence use is ordinary prose.
    const summary =
      'The session reviewed sorting. Where slides were missing the professor said he would please provide them later.'
    expect(looksLikeSummaryRefusal(summary)).toBe(false)
  })

  it('handles an empty string without matching', () => {
    expect(looksLikeSummaryRefusal('')).toBe(false)
  })
})
