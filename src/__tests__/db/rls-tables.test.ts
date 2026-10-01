/**
 * Real reads and writes as a signed-in user, proving the policies actually stop at the tenant
 * edge.
 *
 * The predicate suite proves each lock works. This proves a lock is FITTED — a policy that
 * forgets to call its helper, or calls it with the wrong column, passes every predicate test and
 * fails here. Representatives are chosen by distinct policy TOPOLOGY rather than by feature area,
 * because two tables in the same area can traverse different joins:
 *
 *   course_sections   professor_id / enrolment, checked directly on the row
 *   courses           one join further out, section → course
 *   project_teams     team membership, the is_team_member family behind 20 policies
 *   enrollments       a WRITE, refused by the policy itself (42501)
 *
 * The other ~125 tables are covered by the catalog-wide policy-shape sweep in
 * grants-and-policy-shape.test.ts, which proves every policy scopes to the caller but cannot
 * prove the right column was passed. Adding a representative here is the way to close that gap
 * for a table whose topology is not already in the list above.
 *
 * THREE RULES KEEP THESE FROM PASSING VACUOUSLY. They are the whole reason this file is longer
 * than "select and expect empty":
 *   1. the tenant-B row is confirmed to exist via the service client first, so "B's rows are
 *      absent" cannot be satisfied by B having no rows;
 *   2. the select itself is asserted error-free, so a malformed query does not read as a denial;
 *   3. refused writes assert the specific 42501 insufficient-privilege code on a structurally
 *      valid row, so a foreign-key or not-null violation cannot masquerade as RLS working.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FIXTURE, serviceClient } from './fixture'
import { asUser, asAnon } from './clients'

const A = FIXTURE.a
const B = FIXTURE.b

let profA: SupabaseClient
let studentA: SupabaseClient
let outsider: SupabaseClient
const service = serviceClient()

beforeAll(async () => {
  ;[profA, studentA, outsider] = await Promise.all([
    asUser(A.users.professor.email),
    asUser(A.users.student.email),
    asUser(FIXTURE.outsider.email),
  ])
})

/** Rule 1: the row we expect to be hidden must genuinely exist. */
async function confirmExists(table: string, id: string) {
  const { data, error } = await service.from(table).select('id').eq('id', id).maybeSingle()
  expect(error, `service-role read of ${table} failed: ${error?.message}`).toBeNull()
  expect(data, `fixture row ${table}:${id} is missing — the hiding test would pass vacuously`).not.toBeNull()
}

/** Rule 2: an empty result only counts as a denial if the query itself succeeded. */
async function idsVisibleTo(client: SupabaseClient, table: string, column = 'id') {
  const { data, error } = await client.from(table).select(column)
  expect(error, `select on ${table} errored (${error?.message}) — that is not a denial`).toBeNull()
  return (data ?? []).map((r) => (r as unknown as Record<string, string>)[column])
}

describe('a professor sees their own section and not the other tenant\'s', () => {
  it('course_sections: A\'s professor sees A, never B', async () => {
    await confirmExists('course_sections', B.section)
    const visible = await idsVisibleTo(profA, 'course_sections')
    expect(visible).toContain(A.section)
    expect(visible).not.toContain(B.section)
  })

  it('courses: the same boundary one join further out', async () => {
    await confirmExists('courses', B.course)
    const visible = await idsVisibleTo(profA, 'courses')
    expect(visible).not.toContain(B.course)
  })

  it('project_teams: reached through team membership, the is_team_member family', async () => {
    await confirmExists('project_teams', B.team)
    const visible = await idsVisibleTo(studentA, 'project_teams')
    expect(visible).not.toContain(B.team)
  })
})

describe('a signed-in stranger inside the same institution sees nothing of the course', () => {
  it('the outsider shares tenant A but is enrolled in nothing', async () => {
    /* Deliberately a member of institution A. If the policies scoped by institution_id alone
       this would leak; they scope by enrolment, so it must not. */
    await confirmExists('course_sections', A.section)
    const visible = await idsVisibleTo(outsider, 'course_sections')
    expect(visible).not.toContain(A.section)
    expect(visible).not.toContain(B.section)
  })

  it('the outsider cannot read the section\'s project teams', async () => {
    await confirmExists('project_teams', A.team)
    const visible = await idsVisibleTo(outsider, 'project_teams')
    expect(visible).not.toContain(A.team)
  })
})

describe('writes into another tenant are refused by the database, not just the app', () => {
  it('a professor cannot enrol anyone into the other tenant\'s section', async () => {
    /* Rule 3: the row is structurally valid — real section, real student, valid status — so the
       only thing that can reject it is the policy. A malformed row would be rejected by a
       constraint and would prove nothing. */
    const { error } = await studentA.from('enrollments').insert({
      student_id: A.users.student.id,
      section_id: B.section,
      status: 'enrolled',
    })
    expect(error, 'writing into another tenant SUCCEEDED — this is a cross-tenant write').not.toBeNull()
    expect(
      error!.code,
      `expected 42501 (insufficient privilege, i.e. RLS refused) but got ${error!.code}: ` +
        `${error!.message}. A different code means something other than the policy rejected this, ` +
        `so the policy was never actually exercised.`,
    ).toBe('42501')
  })

  it('a student cannot create a section, and the tenant trigger refuses first', async () => {
    /* Refused with P0001 "Parent course not found", not 42501, and the reason is worth pinning.
       enforce_section_tenant_match() is a BEFORE INSERT trigger that is NOT security definer, so
       its `SELECT institution_id FROM courses` runs as the caller. Row-level security hides the
       course from a student, the lookup comes back NULL, and the trigger raises before the
       policy's WITH CHECK is ever reached.

       So RLS is still the thing doing the work; it simply surfaces through the trigger. Asserting
       42501 here would be asserting something untrue about the mechanism, and asserting only
       "some error" would let a typo in the row satisfy the test. Pin both: refused, and refused
       for a tenant reason rather than a schema one. */
    const { error } = await studentA.from('course_sections').insert({
      course_id: A.course,
      professor_id: A.users.student.id,
      section_code: 'HACK',
      semester: 'Fall',
      year: 2026,
      institution_id: A.institution,
    })
    expect(error, 'a student created a course section').not.toBeNull()
    expect(['42501', 'P0001']).toContain(error!.code)
    expect(
      error!.message,
      `refused, but for a schema reason rather than a tenant one: ${error!.message}`,
    ).toMatch(/not found|Tenant mismatch|row-level security/i)
  })
})

describe('the revoked predicate RPC still works for the callers that need it', () => {
  it('an authenticated user can still call can_author_in_section', async () => {
    /* The half of the revoke that can break production. Two policies call this helper and both
       evaluate as the calling role — public.discussion_messages "Message: can insert if channel
       accessible and active", and storage.objects "Chat attachments: upload". If authenticated
       lost EXECUTE, students would stop being able to post in a course discussion or attach a
       file, so this is the regression the migration most needs pinned.
     *
     * THE ANON HALF IS DELIBERATELY NOT TESTED HERE, and not from laziness: calling this RPC as
     * anon SEGFAULTS local Postgres 17.6 (signal 11, whole stack into recovery), reproduced four
     * times on 2026-09-15. It is an image bug, not a product bug — the same family as the
     * is_super_admin() crash already recorded in memory — but a test that reliably kills the
     * database is worse than no test. The anon side is asserted from the catalog instead, in
     * grants-and-policy-shape.test.ts, which proves the same property without touching the
     * crashing path. Do not re-add an anon .rpc() probe here. */
    const { data, error } = await studentA.rpc('can_author_in_section', {
      p_section_id: A.section,
      p_user_id: A.users.student.id,
    })
    expect(error, `authenticated lost access, which breaks both dependent policies: ${error?.message}`).toBeNull()
    expect(data).toBe(true)
  })
})

describe('the anon role reaches nothing', () => {
  it('an anonymous client reads no rows from tenant-scoped tables', async () => {
    /* anon is the role behind the publishable key in the browser bundle. The 2026-08-24 anon
       privilege hardening removed its table grants and an event trigger keeps new tables clean;
       this asserts the outcome rather than the mechanism. */
    const anon = asAnon()
    for (const table of ['course_sections', 'courses', 'profiles', 'enrollments', 'project_teams']) {
      const { data, error } = await anon.from(table).select('id')
      // Either a hard refusal or an empty set is acceptable; a row is not.
      expect(data ?? [], `anon could read rows from ${table}`).toEqual([])
      if (!error) continue
      expect(
        ['42501', 'PGRST301', '42P01'],
        `anon got an unexpected error from ${table}: ${error.code} ${error.message}`,
      ).toContain(error.code)
    }
  })
})
