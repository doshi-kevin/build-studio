/**
 * The plan-change diff. This is the copy a school actually reads, and the two
 * ways it can be wrong are both silent: announcing a change that did not happen,
 * or staying quiet about one that did.
 */

import { describe, it, expect } from 'vitest'
import { describePlanChange } from '@/lib/notifications/entitlements'
import {
  ENTITLEMENT_CONFIG_DEFAULT,
  type EntitlementConfig,
} from '@/lib/entitlements/entitled-features'

const NOW = new Date('2026-09-09T12:00:00Z')
const config = (over: Partial<EntitlementConfig> = {}): EntitlementConfig => ({
  ...ENTITLEMENT_CONFIG_DEFAULT,
  ...over,
})

describe('describePlanChange', () => {
  it('says nothing when nothing changed', () => {
    expect(describePlanChange(config(), config(), NOW)).toBeNull()
  })

  it('announces a grant to admins AND professors', () => {
    // Professors are the ones who can now do something new, and per the product
    // brief they will not go looking for it.
    const change = describePlanChange(config({ revoked: ['quizzes'] }), config(), NOW)
    expect(change?.audience).toBe('admins-and-professors')
    expect(change?.title).toBe('Quizzes is now available')
  })

  it('announces a revocation to admins ONLY', () => {
    // A professor cannot act on it, and it is their own administration's news
    // to break, not a bell we ring.
    const change = describePlanChange(config(), config({ revoked: ['quizzes'] }), NOW)
    expect(change?.audience).toBe('admins')
    expect(change?.body).toContain('No longer available: Quizzes.')
  })

  it('promises that nothing is deleted, because that is the first fear', () => {
    const change = describePlanChange(config(), config({ revoked: ['quizzes'] }), NOW)
    expect(change?.body).toContain('Existing work is never deleted')
  })

  it('announces a future cutoff even though nothing is off yet', () => {
    const change = describePlanChange(
      config(),
      config({ pendingRevocation: { quizzes: '2026-12-20T00:00:00Z' } }),
      NOW,
    )
    expect(change?.title).toBe('A change to your plan is scheduled')
    expect(change?.body).toContain('Quizzes will switch off on December 20, 2026')
  })

  it('renders the cutoff date in UTC, matching what the admin picked', () => {
    // Stored as UTC midnight. Formatting it locally would name the day before.
    const change = describePlanChange(
      config(),
      config({ pendingRevocation: { quizzes: '2026-12-01T00:00:00Z' } }),
      NOW,
    )
    expect(change?.body).toContain('December 1, 2026')
  })

  it('does not re-announce a cutoff that was already scheduled', () => {
    const scheduled = config({ pendingRevocation: { quizzes: '2026-12-20T00:00:00Z' } })
    expect(describePlanChange(scheduled, scheduled, NOW)).toBeNull()
  })

  it('stays quiet when a revocation is only rewritten, not changed in effect', () => {
    // Moving a key from an already-passed pendingRevocation into `revoked` is
    // bookkeeping. The school's experience is identical, so saying "your plan
    // changed" would be a lie.
    const before = config({ pendingRevocation: { quizzes: '2026-08-01T00:00:00Z' } })
    const after = config({ revoked: ['quizzes'] })
    expect(describePlanChange(before, after, NOW)).toBeNull()
  })

  it('handles a grant and a revocation in one save', () => {
    const change = describePlanChange(
      config({ revoked: ['projects'] }),
      config({ revoked: ['quizzes'] }),
      NOW,
    )
    expect(change?.body).toContain('Now available: Projects.')
    expect(change?.body).toContain('No longer available: Quizzes.')
    // A mixed save contains bad news, so it follows the revocation audience.
    expect(change?.audience).toBe('admins')
  })

  it('fits inside the database limits on title and body', () => {
    // app_notifications caps title at 300 chars and body at 1000. The worst
    // case is every product changing at once.
    const change = describePlanChange(
      config({
        revoked: [
          'quizzes',
          'assignments',
          'live-classroom',
          'projects',
          'discussions',
          'challenges',
          'athena',
        ],
      }),
      config(),
      NOW,
    )
    expect(change).not.toBeNull()
    expect((change as { title: string }).title.length).toBeLessThanOrEqual(300)
    expect((change as { body: string }).body.length).toBeLessThanOrEqual(1000)
  })
})
