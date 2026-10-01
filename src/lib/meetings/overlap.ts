/**
 * Group-availability overlap math (pure — unit-tested). Slots are compared
 * as canonical UTC instants so members painting in different timezones line
 * up on the same moments.
 */

export interface AvailabilityLike {
  slot_start: string
  user_id: string
}

const canonical = (iso: string) => new Date(iso).toISOString()

/** slot (UTC ISO) → set of user ids available at that slot. */
export function slotUserSets(slots: AvailabilityLike[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const s of slots) {
    const k = canonical(s.slot_start)
    if (!map.has(k)) map.set(k, new Set())
    map.get(k)!.add(s.user_id)
  }
  return map
}

/**
 * Future slots at least two people can do, ranked by headcount then time,
 * factoring the caller's (possibly unsaved) selection over their saved rows.
 */
export function bestCommonTimes(
  counts: Map<string, Set<string>>,
  selection: Set<string>,
  userId: string,
  nowMs: number,
  limit = 5,
): { iso: string; count: number }[] {
  const merged = new Map<string, number>()
  for (const [k, users] of counts) {
    const withMe = new Set(users)
    if (selection.has(k)) withMe.add(userId)
    else withMe.delete(userId)
    merged.set(k, withMe.size)
  }
  // Slots the caller picked that no one else (and no saved row) has yet.
  for (const k of selection) if (!merged.has(k)) merged.set(k, 1)

  return [...merged.entries()]
    .filter(([k, n]) => n >= 2 && new Date(k).getTime() >= nowMs)
    .sort((a, b) => b[1] - a[1] || new Date(a[0]).getTime() - new Date(b[0]).getTime())
    .slice(0, limit)
    .map(([iso, count]) => ({ iso, count }))
}
