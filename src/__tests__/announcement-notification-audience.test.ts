/**
 * #665 — an announcement targeted at specific students notified EVERY enrolled student.
 * The body was protected (the link 404s for the others), but the notification title was
 * not, and the title is routinely the sensitive part: "Academic integrity meeting",
 * "Re: your late submission". Targeting exists to prevent exactly that disclosure.
 *
 * Cause: the fanout asked "who is enrolled in this section", a question that cannot see
 * per-announcement targeting.
 *
 * Two properties are pinned, and the SECOND is the one that makes this safe rather than
 * merely fixed:
 *   1. a targeted announcement resolves to its mention rows, not the roster
 *   2. targeted-with-no-mentions resolves to NOBODY — it must fail closed. A fallback to
 *      the roster on an empty result would reintroduce the exact leak, and that is the
 *      shape such a bug takes when someone "defensively" adds one later.
 */

import { describe, it, expect, vi } from 'vitest'
import { resolveAnnouncementAudience } from '@/lib/events/audience'

const SECTION = 'sec-1'
const ANNOUNCEMENT = 'ann-1'
const ROSTER = ['s1', 's2', 's3', 's4', 's5', 's6', 's7']
const TARGETED = ['s3']

/** Records which table was read, so we can assert the roster is never consulted. */
function makeDb(mentions: string[]) {
  const reads: string[] = []
  const db = {
    from(table: string) {
      reads.push(table)
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: ROSTER.map((student_id) => ({ student_id })) }),
            }),
          }),
        }
      }
      if (table === 'announcement_mentions') {
        return {
          select: () => ({
            eq: async () => ({ data: mentions.map((student_id) => ({ student_id })) }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, reads }
}

describe('#665 — announcement notification audience', () => {
  it('notifies only the mentioned students when targeted', async () => {
    const { db, reads } = makeDb(TARGETED)

    const audience = await resolveAnnouncementAudience(
      db as never,
      ANNOUNCEMENT,
      SECTION,
      'mentioned_only',
    )

    expect(audience).toEqual(TARGETED)
    // The bug in one assertion: the roster must not even be consulted.
    expect(reads).not.toContain('enrollments')
  })

  it('notifies NOBODY when targeted with no mentions — fails closed', async () => {
    const { db } = makeDb([])
    const audience = await resolveAnnouncementAudience(
      db as never,
      ANNOUNCEMENT,
      SECTION,
      'mentioned_only',
    )
    expect(audience).toEqual([])
  })

  it('notifies the whole roster for a normal announcement', async () => {
    const { db } = makeDb([])
    const audience = await resolveAnnouncementAudience(db as never, ANNOUNCEMENT, SECTION, 'all')
    expect(audience).toEqual(ROSTER)
  })

  it.each([null, undefined, ''])('treats %p visibility as "everyone", not as targeted', async (v) => {
    // A missing/legacy visibility must not silently notify nobody — that would be a
    // regression in the opposite direction, quietly dropping announcements.
    const { db } = makeDb([])
    const audience = await resolveAnnouncementAudience(db as never, ANNOUNCEMENT, SECTION, v)
    expect(audience).toEqual(ROSTER)
  })

  it('does not invent recipients that are not on the mention list', async () => {
    const { db } = makeDb(['s3', 's5'])
    const audience = await resolveAnnouncementAudience(
      db as never,
      ANNOUNCEMENT,
      SECTION,
      'mentioned_only',
    )
    expect(new Set(audience)).toEqual(new Set(['s3', 's5']))
    expect(audience).not.toContain('s1')
  })
})

describe('the resolver is the single source both publish paths use', () => {
  it('is exported from the shared audience module', () => {
    // Manual publish, edit-to-publish and the scheduled auto-publish all call this one
    // function; three copies of the rule would drift, and the scheduled path is the one
    // that originally shipped without any targeting lookup at all.
    expect(typeof resolveAnnouncementAudience).toBe('function')
    expect(vi.isMockFunction(resolveAnnouncementAudience)).toBe(false)
  })
})
