/**
 * The SECURITY DEFINER predicates that every row-level-security policy delegates to.
 *
 * WHY THESE FIRST. Policies in this schema do not compare an institution_id. They call one of
 * ~18 helper functions — `is_team_member` backs 20 policies, `is_course_member` 9,
 * `is_section_owner_or_staff` 7 — and tenant isolation is whatever those functions decide. One
 * wrong join here silently opens every policy that calls it, and a per-table test would report
 * that as twenty unrelated failures. Testing the predicate directly means a failure names the
 * one function to fix.
 *
 * They are callable over .rpc() because `authenticated` must hold EXECUTE for the policies to
 * evaluate at all, so this tests them exactly as Postgres invokes them.
 *
 * SHAPE OF EACH CASE. Same-tenant argument → true. Cross-tenant argument → false. That second
 * one is the whole point: tenant B's section/team/course is a real, populated row, so a `false`
 * means the predicate refused, not that it looked up nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FIXTURE } from './fixture'
import { asUser } from './clients'

const A = FIXTURE.a
const B = FIXTURE.b

let prof: SupabaseClient
let student: SupabaseClient
let ta: SupabaseClient
let grader: SupabaseClient
let admin: SupabaseClient
let outsider: SupabaseClient

beforeAll(async () => {
  ;[prof, student, ta, grader, admin, outsider] = await Promise.all([
    asUser(A.users.professor.email),
    asUser(A.users.student.email),
    asUser(A.users.ta.email),
    asUser(A.users.grader.email),
    asUser(A.users.admin.email),
    asUser(FIXTURE.outsider.email),
  ])
})

/** Call a predicate and fail loudly rather than treating an RPC error as `false`. */
async function pred(client: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}(${JSON.stringify(args)}) errored: ${error.message}`)
  return data as boolean
}

describe('section predicates scope to the caller\'s own section', () => {
  it('is_professor_of_section: true for the owner, false across tenants', async () => {
    expect(await pred(prof, 'is_professor_of_section', { s_id: A.section })).toBe(true)
    expect(await pred(prof, 'is_professor_of_section', { s_id: B.section })).toBe(false)
    expect(await pred(student, 'is_professor_of_section', { s_id: A.section })).toBe(false)
  })

  it('is_enrolled_in_section: true for the enrolled student only', async () => {
    expect(await pred(student, 'is_enrolled_in_section', { s_id: A.section })).toBe(true)
    expect(await pred(student, 'is_enrolled_in_section', { s_id: B.section })).toBe(false)
    expect(await pred(outsider, 'is_enrolled_in_section', { s_id: A.section })).toBe(false)
  })

  it('is_staff_of_section: true for assigned staff, false in the other tenant', async () => {
    expect(await pred(ta, 'is_staff_of_section', { s_id: A.section })).toBe(true)
    expect(await pred(ta, 'is_staff_of_section', { s_id: B.section })).toBe(false)
    expect(await pred(outsider, 'is_staff_of_section', { s_id: A.section })).toBe(false)
  })

  it('is_section_owner_or_staff: owner and staff yes, stranger no', async () => {
    expect(await pred(prof, 'is_section_owner_or_staff', { p_section_id: A.section })).toBe(true)
    expect(await pred(ta, 'is_section_owner_or_staff', { p_section_id: A.section })).toBe(true)
    expect(await pred(prof, 'is_section_owner_or_staff', { p_section_id: B.section })).toBe(false)
    expect(await pred(outsider, 'is_section_owner_or_staff', { p_section_id: A.section })).toBe(false)
  })

  it('is_enrolled_or_professor: covers both roles and neither across tenants', async () => {
    expect(await pred(prof, 'is_enrolled_or_professor', {
      p_section_id: A.section, p_user_id: A.users.professor.id,
    })).toBe(true)
    expect(await pred(student, 'is_enrolled_or_professor', {
      p_section_id: A.section, p_user_id: A.users.student.id,
    })).toBe(true)
    expect(await pred(prof, 'is_enrolled_or_professor', {
      p_section_id: B.section, p_user_id: A.users.professor.id,
    })).toBe(false)
  })

  it('can_author_in_section: a TA may author, a grader may not', async () => {
    /* The branch that is one boolean apart and easy to get wrong. Graders are read-only for
       authoring, matching canWriteAsStaff() in the application layer — a grader who could post
       as staff would be a privilege escalation inside the section. */
    expect(await pred(ta, 'can_author_in_section', {
      p_section_id: A.section, p_user_id: A.users.ta.id,
    })).toBe(true)
    expect(await pred(grader, 'can_author_in_section', {
      p_section_id: A.section, p_user_id: A.users.grader.id,
    })).toBe(false)
    expect(await pred(student, 'can_author_in_section', {
      p_section_id: A.section, p_user_id: A.users.student.id,
    })).toBe(true)
    expect(await pred(prof, 'can_author_in_section', {
      p_section_id: B.section, p_user_id: A.users.professor.id,
    })).toBe(false)
  })
})

describe('course and team predicates scope transitively', () => {
  it('is_course_member: reached through the section, and stops at the tenant edge', async () => {
    expect(await pred(prof, 'is_course_member', { p_course_id: A.course })).toBe(true)
    expect(await pred(student, 'is_course_member', { p_course_id: A.course })).toBe(true)
    expect(await pred(prof, 'is_course_member', { p_course_id: B.course })).toBe(false)
    expect(await pred(outsider, 'is_course_member', { p_course_id: A.course })).toBe(false)
  })

  it('is_team_member: the predicate behind 20 policies', async () => {
    expect(await pred(student, 'is_team_member', {
      p_team_id: A.team, p_user_id: A.users.student.id,
    })).toBe(true)
    expect(await pred(student, 'is_team_member', {
      p_team_id: B.team, p_user_id: A.users.student.id,
    })).toBe(false)
    expect(await pred(outsider, 'is_team_member', {
      p_team_id: A.team, p_user_id: FIXTURE.outsider.id,
    })).toBe(false)
  })

  it('is_project_member and is_project_owner separate a member from an owner', async () => {
    /* Both read project_members; only is_project_owner also requires role='owner'. A member who
       tested as an owner would get write access to the whole project, so the pair has to
       disagree for the student and agree for the owner. */
    expect(await pred(student, 'is_project_member', {
      p_project_id: A.project, p_user_id: A.users.student.id,
    })).toBe(true)
    expect(await pred(student, 'is_project_owner', {
      p_project_id: A.project, p_user_id: A.users.student.id,
    })).toBe(false)

    expect(await pred(prof, 'is_project_owner', {
      p_project_id: A.project, p_user_id: A.users.professor.id,
    })).toBe(true)

    // and neither reaches across the tenant edge
    expect(await pred(student, 'is_project_member', {
      p_project_id: B.project, p_user_id: A.users.student.id,
    })).toBe(false)
    expect(await pred(prof, 'is_project_owner', {
      p_project_id: B.project, p_user_id: A.users.professor.id,
    })).toBe(false)
  })

  it('can_access_phase follows the team, not the caller', async () => {
    expect(await pred(student, 'can_access_phase', {
      p_phase_id: A.phase, p_user_id: A.users.student.id,
    })).toBe(true)
    expect(await pred(student, 'can_access_phase', {
      p_phase_id: B.phase, p_user_id: A.users.student.id,
    })).toBe(false)
  })
})

describe('role predicates read the caller\'s own role, not an argument', () => {
  it('is_admin is true only for an institution admin', async () => {
    expect(await pred(admin, 'is_admin', {})).toBe(true)
    expect(await pred(prof, 'is_admin', {})).toBe(false)
    expect(await pred(student, 'is_admin', {})).toBe(false)
  })

  it('is_admin_of is true only for the admin\'s OWN institution', async () => {
    expect(await pred(admin, 'is_admin_of', { p_institution_id: A.institution })).toBe(true)
    expect(await pred(admin, 'is_admin_of', { p_institution_id: B.institution })).toBe(false)
  })

  it('is_super_admin is false for every seeded role', async () => {
    /* The fixture deliberately contains no super admin: that role sees across institutions, so
       a stray one would quietly weaken every cross-tenant assertion in this suite. Asserting the
       absence keeps that assumption honest. */
    for (const [label, client] of [
      ['professor', prof], ['student', student], ['ta', ta],
      ['grader', grader], ['institution admin', admin],
    ] as const) {
      expect(await pred(client, 'is_super_admin', {}), `${label} must not be super admin`).toBe(false)
    }
  })
})
