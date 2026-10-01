/**
 * Two complete tenants, built with the service-role client.
 *
 * WHY TWO WHOLE GRAPHS. The policies in this schema do not filter on an institution_id column.
 * They ask relationship questions — "does the caller own this section", "is the caller in this
 * team" — and tenant isolation falls out transitively:
 *
 *   institution → department → program → course → section → enrollment / section_staff
 *                                                 └→ project → project_team → project_member
 *
 * A single-tenant fixture cannot test any of that. Proving tenant A cannot see tenant B's rows
 * requires B to actually have rows, reachable through the same chain, so the only difference
 * between the two is who is asking.
 *
 * WHY EVERY ROLE. `is_section_owner_or_staff` is true for a TA and false for a grader; `is_admin`
 * is true only for an institution admin. Seeding just a professor and a student would make those
 * cases pass because the row does not exist, not because the predicate refused — a negative
 * result that proves nothing. Each tenant therefore gets professor, student, TA, grader and
 * institution admin.
 *
 * IDEMPOTENT. Deterministic uuidv5 ids under a namespace of their own, and upserts throughout, so
 * re-running never duplicates and never collides with e2e seed data (which uses its own
 * namespace, see scripts/seed-e2e.ts).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { v5 as uuidv5 } from 'uuid'
import { dbEnv } from './env'

const NS = uuidv5('scholera-rls-suite', uuidv5.DNS)
const id = (key: string) => uuidv5(key, NS)

export const PASSWORD = 'RlsSuite!2026'

export type TenantKey = 'a' | 'b'
export type RoleKey = 'professor' | 'student' | 'ta' | 'grader' | 'admin'

export interface Tenant {
  institution: string
  department: string
  program: string
  course: string
  section: string
  project: string
  team: string
  phase: string
  users: Record<RoleKey, { id: string; email: string }>
}

export type Fixture = Record<TenantKey, Tenant> & { outsider: { id: string; email: string } }

const ROLES: RoleKey[] = ['professor', 'student', 'ta', 'grader', 'admin']

function tenantShape(t: TenantKey): Tenant {
  const users = Object.fromEntries(
    ROLES.map((r) => [r, { id: id(`${t}:user:${r}`), email: `rls-${t}-${r}@scholera.test` }]),
  ) as Tenant['users']
  return {
    institution: id(`${t}:institution`),
    department: id(`${t}:department`),
    program: id(`${t}:program`),
    course: id(`${t}:course`),
    section: id(`${t}:section`),
    project: id(`${t}:project`),
    team: id(`${t}:team`),
    phase: id(`${t}:phase`),
    users,
  }
}

export const FIXTURE: Fixture = {
  a: tenantShape('a'),
  b: tenantShape('b'),
  // Signed in, real, and a member of nothing. Distinguishes "the predicate refused" from
  // "the predicate happened to return false for a stranger it never looked up".
  outsider: { id: id('outsider'), email: 'rls-outsider@scholera.test' },
}

export function serviceClient(): SupabaseClient {
  const { url, serviceKey } = dbEnv()
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function ensureUser(db: any, userId: string, email: string) {
  const { error } = await db.auth.admin.createUser({
    id: userId,
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  // Re-running the fixture is expected; anything else is a real failure worth surfacing.
  if (error && !/already|duplicate|exists/i.test(error.message ?? '')) {
    throw new Error(`createUser(${email}) failed: ${error.message}`)
  }
}

/**
 * `onConflict` must name the table's NATURAL unique key for link tables.
 *
 * Left to default, upsert conflicts on the primary key. A link row inserted by an earlier run
 * carries a generated id that a later run's deterministic id never matches, so the second run
 * INSERTs again and trips the real unique constraint — e.g. enrollments(section_id, student_id).
 * Naming the natural key makes re-seeding idempotent no matter what ran before.
 */
async function upsert(db: any, table: string, rows: unknown, onConflict?: string) {
  const { error } = await db.from(table).upsert(rows, onConflict ? { onConflict } : undefined)
  if (error) throw new Error(`seeding ${table} failed: ${error.message}`)
}

async function seedTenant(db: any, key: TenantKey) {
  const t = FIXTURE[key]
  const label = key.toUpperCase()

  await upsert(db, 'institutions', {
    id: t.institution,
    name: `RLS Tenant ${label}`,
    slug: `rls-tenant-${key}`,
  })

  for (const role of ROLES) {
    const u = t.users[role]
    await ensureUser(db, u.id, u.email)
    await upsert(db, 'profiles', {
      id: u.id,
      email: u.email,
      name: `RLS ${label} ${role}`,
      role: role === 'admin' ? 'institution_admin' : role === 'student' ? 'student' : 'professor',
      institution_id: t.institution,
      status: 'active',
    })
  }

  await upsert(db, 'departments', {
    id: t.department, name: `Dept ${label}`, code: `D${label}`, institution_id: t.institution,
  })
  // department_id is not NOT NULL, but enforce_program_tenant_match() rejects a program whose
  // parent department it cannot resolve — the trigger that stops a program being filed under
  // another tenant's department.
  await upsert(db, 'programs', {
    id: t.program, name: `Program ${label}`, code: `P${label}`,
    department_id: t.department, institution_id: t.institution,
  })
  await upsert(db, 'courses', {
    id: t.course, title: `Course ${label}`, code: `C${label}101`,
    department_id: t.department, institution_id: t.institution, status: 'active',
  })
  await upsert(db, 'course_sections', {
    id: t.section, course_id: t.course, professor_id: t.users.professor.id,
    section_code: `S${label}`, semester: 'Fall', year: 2026,
    institution_id: t.institution, status: 'active',
  })
  /* Every link row gets a deterministic id. Without one, upsert conflicts on the PRIMARY KEY,
     which a generated id never matches, so a second run INSERTs again and trips the
     (section_id, student_id) unique constraint. Supplying the id is what makes re-running free. */
  await upsert(db, 'enrollments', {
    id: id(`${key}:enrollment`),
    student_id: t.users.student.id, section_id: t.section, status: 'enrolled',
  }, 'section_id,student_id')

  // A TA can author in the section; a grader deliberately cannot. Both are "staff", and the
  // difference between them is a real branch in can_author_in_section.
  const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  await upsert(db, 'section_staff', [
    { id: id(`${key}:staff:ta`), section_id: t.section, staff_id: t.users.ta.id, role: 'ta', status: 'active', ends_at: farFuture },
    { id: id(`${key}:staff:grader`), section_id: t.section, staff_id: t.users.grader.id, role: 'grader', status: 'active', ends_at: farFuture },
  ], 'section_id,staff_id')

  await upsert(db, 'projects', {
    id: t.project, section_id: t.section, created_by: t.users.professor.id,
    title: `Project ${label}`,
  })
  await upsert(db, 'project_teams', {
    id: t.team, project_id: t.project, created_by: t.users.professor.id, name: `Team ${label}`,
  })
  /* Owner and member are both project_members rows distinguished by `role` — is_project_owner()
     checks role='owner', it does NOT read projects.created_by. Seeding both makes the two
     predicates separable; with only one row they would agree and neither would be tested. */
  await upsert(db, 'project_members', [
    { id: id(`${key}:member:owner`), project_id: t.project, team_id: t.team, user_id: t.users.professor.id, role: 'owner' },
    { id: id(`${key}:member:student`), project_id: t.project, team_id: t.team, user_id: t.users.student.id, role: 'member' },
  ], 'project_id,user_id')
  await upsert(db, 'project_phases', {
    id: t.phase, project_id: t.project, team_id: t.team, title: `Phase ${label}`,
  })
}

/** Build both tenants. Safe to call repeatedly. */
export async function seedFixture(): Promise<Fixture> {
  const db = serviceClient()
  // Tenants first: the outsider's profile carries tenant A's institution_id, so A has to exist.
  // The outsider belongs to A on PURPOSE — sharing an institution with the people whose rows they
  // must not see proves the policies scope by relationship, not merely by tenant column.
  await seedTenant(db, 'a')
  await seedTenant(db, 'b')
  await ensureUser(db, FIXTURE.outsider.id, FIXTURE.outsider.email)
  await upsert(db, 'profiles', {
    id: FIXTURE.outsider.id, email: FIXTURE.outsider.email, name: 'RLS Outsider',
    role: 'student', institution_id: FIXTURE.a.institution, status: 'active',
  })
  return FIXTURE
}
/* eslint-enable @typescript-eslint/no-explicit-any */
