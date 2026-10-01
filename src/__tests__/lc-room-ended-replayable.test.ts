/**
 * #764: a room that ends must end on every device.
 *
 * THE CAUSE, and it was not what the issue first said. `lc_rooms_after_update` DOES emit
 * `room_ended` on a live -> ended transition, via `lc_send_event`, which both inserts into
 * `lc_events` and broadcasts over realtime. The bug was the statement immediately after:
 *
 *     DELETE FROM lc_events WHERE room_id = NEW.id;
 *
 * It removed every event for the room, including the `room_ended` row just written. So the ephemeral
 * broadcast was the ONLY notification, and a client that was asleep, offline or mid-reconnect at
 * that instant replayed into an empty buffer and never learned the class was over. A professor tab
 * logged 104 `lc.replay.empty` against 2 `lc.replay.applied` and kept rendering live controls for
 * about four hours.
 *
 * Production confirmed it: `lc_events` held 0 rows across 231 ended rooms. Every replay buffer had
 * been purged, 231 times. It affected the MANUAL end path too, not only the cron reaper.
 *
 * This file guards the migration's shape. The behaviour itself was verified against production: a
 * probe room with 3 slide_changed events was ended, the 3 were purged, and `room_ended` survived at
 * a real seq, which is what makes it replayable.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase/migrations')

/** The migration, comments stripped, so an assertion cannot pass on its own explanatory prose. */
function ddl(): string {
  const f = readdirSync(MIGRATIONS).find((n) =>
    n.endsWith('_room_ended_replayable_and_no_deck_deletes.sql'),
  )
  if (!f) throw new Error('the #764 migration is missing')
  return readFileSync(join(MIGRATIONS, f), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

describe('#764: room_ended survives the replay-buffer purge', () => {
  it('excludes room_ended from the delete', () => {
    /* The one-line difference between "ends everywhere" and "ends only for whoever happened to be
       listening at that millisecond". */
    expect(ddl()).toMatch(/delete from lc_events\s+where room_id = new\.id\s+and event_type <> 'room_ended'/i)
  })

  it('never deletes the whole buffer unconditionally', () => {
    /* The original statement. If it comes back, replay goes silent again. */
    expect(ddl()).not.toMatch(/delete from lc_events where room_id = new\.id;/i)
  })

  it('writes room_ended AFTER the purge', () => {
    /* Belt and braces on ordering. The exclusion alone is enough, but purging first and writing
       second means neither statement can remove the terminal event even if the exclusion is later
       edited. Cheap insurance on the exact line that broke. */
    const d = ddl()
    const purge = d.search(/delete from lc_events/i)
    const write = d.search(/lc_send_event\(new\.id, 'room_ended'/i)
    expect(purge).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(purge)
  })
})

describe('#764: the reaper stops destroying decks', () => {
  it('does not touch storage', () => {
    /* It was deleting the room's objects from the deck bucket. endRoom's own comment says deck
       images are deliberately NOT deleted, because Class Insights and the student quiz review link
       back to slide images, and a promoted deck's `lc_decks.module_item_id` points at live course
       material whose file this was removing. */
    expect(ddl()).not.toMatch(/storage\.objects/i)
    expect(ddl()).not.toMatch(/live-classroom-decks/i)
  })

  it('does not swallow errors', () => {
    /* `EXCEPTION WHEN OTHERS THEN NULL` around a storage delete hid every failure. */
    expect(ddl()).not.toMatch(/exception\s+when\s+others\s+then\s+null/i)
  })

  it('is idempotent through its WHERE clause', () => {
    /* Two overlapping cron runs must not double-end a room. The status filter is the guard, and the
       trigger additionally only fires on a genuine live -> ended transition. */
    const d = ddl()
    expect(d).toMatch(/where status = 'live'/i)
    expect(d).toMatch(/where status = 'scheduled'/i)
  })
})
