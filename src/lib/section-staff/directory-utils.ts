// Pure helpers for the admin TA/Grader directory. Extracted from
// StaffDirectoryTable so the branching status logic can be unit tested without
// mounting React. Used by the admin staff directory to collapse the raw
// (status, ends_at) pair into a single display status.

import type { StaffStatus } from '@/lib/validations/section-staff'

/** Display status shown in the admin directory — "ended" covers both natural expiry and manual end. */
export type DerivedStaffStatus = 'active' | 'ended' | 'removed'

/** True when `ends_at` is a valid ISO date at or before `now`. */
export function isExpired(
  ends_at: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!ends_at) return false
  const t = new Date(ends_at).getTime()
  if (Number.isNaN(t)) return false
  return t <= now.getTime()
}

/**
 * Derive a display status from the raw `section_staff` row.
 *
 * Rules (in priority order):
 * 1. `status === 'removed'` → always "removed", regardless of dates.
 * 2. `status === 'active'` AND not past `ends_at` → "active".
 * 3. Everything else (active-but-expired, already ended, etc.) → "ended".
 */
export function derivedStatus(
  row: { status: StaffStatus | string | null | undefined; ends_at: string | null | undefined },
  now: Date = new Date(),
): DerivedStaffStatus {
  if (row.status === 'removed') return 'removed'
  if (row.status === 'active' && !isExpired(row.ends_at, now)) return 'active'
  return 'ended'
}
