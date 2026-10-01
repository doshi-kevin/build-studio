/**
 * #674 — a channel name made only of characters the sanitiser strips (`!!!`) produced a
 * channel with an EMPTY display name: a bare `#` row with no label, permanently consuming
 * one of the 5 MAX_COURSE_CHANNELS slots and awkward to identify in order to delete.
 *
 * Cause: both `.refine()` calls ran BEFORE the `.transform()`, so they validated the raw
 * input and nothing ever checked the result. The oracle is therefore the POST-transform
 * value — asserting that `!!!` is rejected while `general` is accepted is the whole test,
 * and the false-positive direction (rejecting a legitimate name) is what the accept cases
 * guard.
 */

import { describe, it, expect } from 'vitest'
import {
  createDiscussionChannelSchema,
  renameDiscussionChannelSchema,
} from '@/lib/validations/discussion'

describe.each([
  ['create', createDiscussionChannelSchema],
  ['rename', renameDiscussionChannelSchema],
])('#674 — %s rejects a name that sanitises to nothing', (_label, schema) => {
  it.each(['!!!', '...', '???', '@@@', '   !!!   '])('rejects %p', (name) => {
    const out = schema.safeParse({ name })
    expect(out.success).toBe(false)
  })

  it('rejects a name that reduces to only hyphens', () => {
    // Unlabelled in exactly the same way as the empty case.
    expect(schema.safeParse({ name: '- - -' }).success).toBe(false)
  })

  it.each([
    ['general', 'general'],
    ['Week 1', 'week-1'],
    ['Q&A', 'qa'],
    ['a', 'a'],
  ])('accepts %p and sanitises to %p', (name, expected) => {
    const out = schema.safeParse({ name })
    expect(out.success).toBe(true)
    if (out.success) expect(out.data.name).toBe(expected)
  })

  it('still accepts a name whose non-alphanumerics are merely trimmed away', () => {
    // "Week 1 📚" keeps letters and digits — stripping the emoji must not reject it.
    const out = schema.safeParse({ name: 'Week 1 📚' })
    expect(out.success).toBe(true)
  })

  it('still rejects an empty and a too-long name', () => {
    expect(schema.safeParse({ name: '' }).success).toBe(false)
    expect(schema.safeParse({ name: 'x'.repeat(51) }).success).toBe(false)
  })
})

/**
 * #674 second defect: the transform double-hyphenated. `.replace(/\s+/g, '-')` ran BEFORE
 * the strip, so punctuation that got removed left its own gap behind and "hey!! @#$ there"
 * became "hey--there". Strip, then collapse whitespace, then collapse repeated hyphens,
 * then trim the ends.
 */
describe.each([
  ['create', createDiscussionChannelSchema],
  ['rename', renameDiscussionChannelSchema],
])('#674 second defect: %s normalises to single hyphens', (_label, schema) => {
  it.each([
    ['hey!! @#$ there', 'hey-there'],
    ['a  b', 'a-b'],
    ['--lead and trail--', 'lead-and-trail'],
    ['Mixed CASE Name', 'mixed-case-name'],
  ])('%s becomes %s', (input, expected) => {
    const res = schema.safeParse({ name: input })
    expect(res.success).toBe(true)
    if (res.success) expect(res.data.name).toBe(expected)
  })
})
