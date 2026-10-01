// Unit tests for notification-preference parsing + the mute helpers — the logic that
// decides whether a student receives a given notification kind. Must-have kinds can never
// be muted (a preference must not suppress a critical alert), which is the safety-critical
// property here.
import { describe, it, expect } from 'vitest'
import {
  parseNotificationPreferences,
  isTypeMuted,
  isMutableNotificationType,
} from '@/lib/validations/notification-preferences'

describe('parseNotificationPreferences', () => {
  it('returns defaults for missing / malformed settings', () => {
    const def = { mutedTypes: [], digestHour: null, digestFrequency: 'daily' }
    expect(parseNotificationPreferences(null)).toEqual(def)
    expect(parseNotificationPreferences(undefined)).toEqual(def)
    expect(parseNotificationPreferences({})).toEqual(def)
    expect(parseNotificationPreferences({ notifications: 'nope' })).toEqual(def)
  })

  it('reads muted optional kinds and a valid digest hour', () => {
    const prefs = parseNotificationPreferences({
      notifications: { mutedTypes: ['assignment_published', 'badge_earned'], digestHour: 9 },
    })
    expect(prefs.mutedTypes).toEqual(['assignment_published', 'badge_earned'])
    expect(prefs.digestHour).toBe(9)
  })

  it('drops non-optional / unknown muted values and out-of-range hours', () => {
    const prefs = parseNotificationPreferences({
      notifications: {
        mutedTypes: ['deadline_approaching', 'bogus', 'quiz_published'],
        digestHour: 99,
      },
    })
    // deadline_approaching is must-have (not optional) and 'bogus' isn't a kind → both dropped.
    expect(prefs.mutedTypes).toEqual(['quiz_published'])
    expect(prefs.digestHour).toBeNull()
  })
})

describe('digest frequency preference', () => {
  it('reads a valid frequency', () => {
    expect(
      parseNotificationPreferences({ notifications: { digestFrequency: 'weekly' } }).digestFrequency,
    ).toBe('weekly')
    expect(
      parseNotificationPreferences({ notifications: { digestFrequency: 'biweekly' } }).digestFrequency,
    ).toBe('biweekly')
  })

  it('defaults to daily for missing or invalid values', () => {
    expect(parseNotificationPreferences({}).digestFrequency).toBe('daily')
    expect(parseNotificationPreferences({ notifications: {} }).digestFrequency).toBe('daily')
    // Unsupported / wrong-typed values fall back to daily rather than throwing.
    expect(
      parseNotificationPreferences({ notifications: { digestFrequency: 'monthly' } }).digestFrequency,
    ).toBe('daily')
    expect(
      parseNotificationPreferences({ notifications: { digestFrequency: 42 } }).digestFrequency,
    ).toBe('daily')
  })
})

describe('isTypeMuted', () => {
  it('is true for a muted optional kind', () => {
    expect(isTypeMuted({ mutedTypes: ['quiz_published'], digestHour: null, digestFrequency: 'daily' }, 'quiz_published')).toBe(
      true,
    )
  })

  it('is false for an unmuted kind', () => {
    expect(
      isTypeMuted({ mutedTypes: ['quiz_published'], digestHour: null, digestFrequency: 'daily' }, 'announcement_posted'),
    ).toBe(false)
  })

  it('never mutes a must-have kind, even if present in the muted list', () => {
    expect(
      isTypeMuted({ mutedTypes: ['booking_confirmed'], digestHour: null, digestFrequency: 'daily' }, 'booking_confirmed'),
    ).toBe(false)
    expect(
      isTypeMuted({ mutedTypes: ['resubmit_requested'], digestHour: null, digestFrequency: 'daily' }, 'resubmit_requested'),
    ).toBe(false)
  })
})

describe('isMutableNotificationType', () => {
  it('is true for optional kinds, false for must-have + non-notifiable + unknown', () => {
    expect(isMutableNotificationType('assignment_published')).toBe(true)
    expect(isMutableNotificationType('re_engagement')).toBe(true)
    // certificate_earned + quiz_ai_ready are now in the optional list (BUG-16) — muteable.
    expect(isMutableNotificationType('certificate_earned')).toBe(true)
    expect(isMutableNotificationType('quiz_ai_ready')).toBe(true)
    expect(isMutableNotificationType('deadline_approaching')).toBe(false) // no producer — in no list
    expect(isMutableNotificationType('assignment_submitted')).toBe(false) // completion event
    expect(isMutableNotificationType('nope')).toBe(false)
  })
})

// Roster + staff kinds. enrollment_added is a roster change the student must not miss;
// the staff-request outcomes are decisions the professor is waiting on — a preference
// can never suppress either. The retired approval-pipeline kinds (enrollment_requested/
// approved/rejected) have no producer and must no longer be mutable toggles.
describe('roster and staff notification kinds', () => {
  it('never mutes enrollment_added (must-have), even if listed as muted', () => {
    expect(isMutableNotificationType('enrollment_added')).toBe(false)
    expect(
      isTypeMuted({ mutedTypes: ['enrollment_added'], digestHour: null, digestFrequency: 'daily' }, 'enrollment_added'),
    ).toBe(false)
  })

  it('drops the retired approval-pipeline kinds from the preference surface', () => {
    expect(isMutableNotificationType('enrollment_requested')).toBe(false)
    expect(isMutableNotificationType('enrollment_approved')).toBe(false)
    expect(isMutableNotificationType('enrollment_rejected')).toBe(false)
  })

  it('never mutes staff-request outcomes (must-have), even if listed as muted', () => {
    expect(isMutableNotificationType('staff_request_approved')).toBe(false)
    expect(isMutableNotificationType('staff_request_rejected')).toBe(false)
    expect(
      isTypeMuted({ mutedTypes: ['staff_request_approved'], digestHour: null, digestFrequency: 'daily' }, 'staff_request_approved'),
    ).toBe(false)
    expect(
      isTypeMuted({ mutedTypes: ['staff_request_rejected'], digestHour: null, digestFrequency: 'daily' }, 'staff_request_rejected'),
    ).toBe(false)
  })
})
