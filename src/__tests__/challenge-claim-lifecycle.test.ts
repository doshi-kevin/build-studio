/**
 * #703 parts 1 and 5: the claim lifecycle.
 *
 * PART 1. "Re-claim" was a dead button. `claimChallenge` did a plain INSERT, `withdrawClaim` only
 * flipped status to 'withdrawn', and `UNIQUE (challenge_id, user_id)` meant the re-insert ALWAYS
 * collided. The student got "you have already claimed this challenge" forever with no recovery path.
 *
 * The fix is one atomic upsert in an RPC, and the `where` clause on its DO UPDATE is the part worth
 * guarding: without it a student could reset their own APPROVED claim back to 'claimed' and wipe the
 * reviewer's note. That was verified against production directly (an approved claim survived the
 * call untouched and the call returned zero rows); what a unit test can hold is the wiring and the
 * message the action gives back.
 *
 * PART 5. A rejected claim told the student nothing. Approval fired badge and certificate
 * notifications; rejection emitted no event at all, so a student who submitted work and was declined
 * had no way to learn it short of noticing the status had changed.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MUST_HAVE_TYPES } from '@/lib/validations/notification-preferences'

const ACTIONS = join(process.cwd(), 'src/app/(dashboard)')
const MIGRATIONS = join(process.cwd(), 'supabase/migrations')

/** The whole rejection branch: from the status check through the emit call. */
function rejectionBranch(src: string): string {
  const start = src.indexOf("if (parsed.data.status === 'rejected')")
  if (start === -1) throw new Error('the rejection branch is missing')
  return src.slice(start, src.indexOf('logEvent({', start))
}

/** The reclaim migration, comments stripped so no assertion can pass on its own prose. */
function reclaimDdl(): string {
  const f = readdirSync(MIGRATIONS).find((n) => n.endsWith('_claim_challenge_revive_withdrawn.sql'))
  if (!f) throw new Error('the #703 part 1 migration is missing')
  return readFileSync(join(MIGRATIONS, f), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
}

const studentActions = readFileSync(
  join(ACTIONS, 'student/courses/[sectionId]/challenges/actions.ts'),
  'utf8',
)
const profActions = readFileSync(
  join(ACTIONS, 'professor/courses/[sectionId]/challenges/actions.ts'),
  'utf8',
)

describe('#703 part 1: reviving a withdrawn claim', () => {
  it('only revives a WITHDRAWN row, never an approved or rejected one', () => {
    /* The single most important line. An unconditional upsert would silently discard an awarded
       review, which is worse than the dead button it replaced. */
    expect(reclaimDdl()).toMatch(/where challenge_claims\.status = 'withdrawn'/i)
  })

  it('resets the claim timestamp rather than preserving it', () => {
    /* Preserving it reads as respectful of history and locks the student out: deadlines are computed
       from the claim time, so someone who withdrew, waited three days and re-claimed would hit an
       already-expired window. */
    expect(reclaimDdl()).toMatch(/claimed_at\s*=\s*now\(\)/i)
  })

  it('clears the previous review on revive', () => {
    /* A revived claim has not been reviewed, so carrying the old reviewer note forward would show
       the student a verdict on work they have since withdrawn. */
    const ddl = reclaimDdl()
    for (const col of ['reviewed_at', 'reviewed_by', 'reviewer_note']) {
      expect(ddl).toMatch(new RegExp(`${col}\\s*=\\s*null`, 'i'))
    }
  })

  it('is one statement, not update-then-insert', () => {
    /* Two statements is the read-decide-write race this codebase keeps removing: both callers find
       no active row, both insert, one collides anyway. */
    expect(reclaimDdl()).toMatch(/on conflict \(challenge_id, user_id\) do update/i)
  })

  it('is not granted to anon or authenticated', () => {
    /* Postgres grants EXECUTE to PUBLIC by default and Supabase exposes functions over PostgREST, so
       without the revoke a student could call this for an arbitrary user_id. */
    const ddl = reclaimDdl()
    expect(ddl).toMatch(/revoke all on function public\.claim_challenge\(uuid, uuid\) from anon, authenticated/i)
    expect(ddl).toMatch(/grant execute on function public\.claim_challenge\(uuid, uuid\) to service_role/i)
  })

  it('the action calls the RPC and no longer inserts directly', () => {
    expect(studentActions).toMatch(/\.rpc\('claim_challenge'/)
    expect(studentActions).not.toMatch(/from\('challenge_claims'\)\s*\n?\s*\.insert\(/)
  })

  it('distinguishes a revive from a first claim in the event log', () => {
    /* Otherwise a student's timeline shows a claim they never made twice, with no trace of the
       withdraw-and-return. */
    expect(studentActions).toContain("'challenge.reclaimed'")
  })
})

describe('#703 part 5: a declined claim tells the student why', () => {
  it('emits a notification on rejection', () => {
    expect(profActions).toContain("type: 'challenge_claim_rejected'")
  })

  it('carries the reviewer note as the body', () => {
    /* "Declined" with no reason is worse than silence, because there is nothing to act on. */
    const branch = rejectionBranch(profActions)
    expect(branch).toMatch(/body:/)
    expect(branch).toMatch(/reviewer_note/)
  })

  it('refreshes rather than dedups, so a second decline is not swallowed', () => {
    /* A student can resubmit and be declined again. With the default 'ignore' the second decision
       would be treated as a duplicate of the first and never delivered. */
    expect(rejectionBranch(profActions)).toMatch(/onDuplicate: 'refresh'/)
  })

  it('cannot be muted, matching how other decision outcomes are treated', () => {
    /* Same reasoning the codebase already applies to staff_request_rejected: a preference must not
       suppress the answer to something the person submitted and is waiting on. */
    expect(MUST_HAVE_TYPES).toContain('challenge_claim_rejected')
  })
})
