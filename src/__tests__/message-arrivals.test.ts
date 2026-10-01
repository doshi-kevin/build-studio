/**
 * Which chat messages count as an ARRIVAL and earn an entrance animation.
 *
 * Every case below is a bug that browser QA actually found, so each one is a
 * regression test rather than a restatement of the code.
 */

import { describe, it, expect } from 'vitest'
import { isMessageArrival } from '@/lib/hooks/use-message-arrivals'

const seen = (...ids: string[]) => new Set(ids)

describe('isMessageArrival', () => {
  it('animates a new message from someone else at the end of the thread', () => {
    expect(isMessageArrival('m3', false, seen('m1', 'm2'), 'm3')).toBe(true)
  })

  it('does not replay scrollback when a conversation is opened', () => {
    // m2 was already on screen when the thread loaded.
    expect(isMessageArrival('m2', false, seen('m1', 'm2'), 'm2')).toBe(false)
  })

  it('stays quiet when older messages are paged in above', () => {
    // "Load older" prepends: old0 is unseen, but it is not the last message.
    expect(isMessageArrival('old0', false, seen('m1', 'm2'), 'm2')).toBe(false)
  })

  it('never animates your own send, even after its id changes', () => {
    // A confirmed send swaps optimistic-1 for a real UUID, which remounts the
    // row. Unseen and last, but yours — so it must not replay its entrance.
    expect(isMessageArrival('real-uuid', true, seen('m1'), 'real-uuid')).toBe(false)
  })

  it('animates nothing before the first fetch settles', () => {
    expect(isMessageArrival('m1', false, null, 'm1')).toBe(false)
  })

  it('animates the very first message in a previously empty conversation', () => {
    // The seed is an EMPTY set, not null: loading finished with no messages.
    // Seeding on "messages.length > 0" instead would have swallowed this.
    expect(isMessageArrival('m1', false, seen(), 'm1')).toBe(true)
  })
})
