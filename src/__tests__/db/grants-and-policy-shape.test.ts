/**
 * Schema-wide invariants, read straight out of the catalog.
 *
 * The representative tests next door prove a handful of locks work. This proves a lock is FITTED
 * on every table, and costs milliseconds because it needs no fixture — it asks Postgres about
 * all ~156 tables and ~293 policies at once. It is also the backstop for the 280+ migrations
 * written before src/__tests__/migration-guards.test.ts existed, which only governs new ones.
 *
 * NECESSARY, NOT SUFFICIENT: finding an approved predicate inside a USING clause does not prove
 * the right column was passed to it. `is_team_member(created_by, auth.uid())` satisfies every
 * check here and is wrong. Catching that needs the behavioural tests next door, or review.
 *
 * Queries are unfiltered by schema where it matters. An earlier analysis of this same question
 * filtered on schemaname='public' and missed that storage.objects carries policies too —
 * including "Chat attachments: upload", which calls can_author_in_section. Storage is inside the
 * same tenant boundary.
 */
import { describe, it, expect } from 'vitest'
import { Client } from 'pg'
import { dbEnv } from './env'

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const client = new Client({ connectionString: dbEnv().pgUrl })
  await client.connect()
  try {
    const res = await client.query(sql)
    return res.rows as T[]
  } finally {
    await client.end()
  }
}

/** Predicates a policy may legitimately delegate its scoping to. */
const APPROVED = [
  'is_team_member', 'is_course_member', 'is_section_owner_or_staff', 'is_super_admin',
  'is_enrolled_or_professor', 'is_section_admin', 'is_admin', 'is_admin_of', 'is_project_owner',
  'is_dm_participant', 'can_access_phase', 'can_author_in_section', 'is_enrolled_in_section',
  'is_professor_of_section', 'is_project_member', 'is_staff_of_section', 'is_section_member',
  'is_section_staff',
]

/**
 * Functions anon/PUBLIC may execute. Each needs a reason, and the bar is "cannot touch data".
 *
 * Trigger and event-trigger functions are excluded by the query itself rather than listed here:
 * PostgREST does not expose them and calling one outside trigger context errors, so their PUBLIC
 * grant is not reachable.
 */
const ANON_EXECUTE_ALLOWLIST: Record<string, string> = {
  // text → uuid or NULL. Pure, reads nothing, writes nothing.
  safe_cast_uuid: 'pure parsing utility with no data access',
}

/**
 * Policies that are globally readable ON PURPOSE. Reviewed 2026-09-15; each is either reference
 * data with no tenant dimension, or a deliberately public surface. Listing them is what lets the
 * rule below fail loudly on a NEW unscoped policy instead of being switched off.
 */
const GLOBAL_READ_ALLOWLIST: Record<string, string> = {
  'public.accreditation_indicators › Anyone authenticated can read global indicators': 'ABET reference data, not tenant-owned',
  'public.accreditation_outcomes › Anyone authenticated can read global outcomes': 'ABET reference data, not tenant-owned',
  'public.accreditation_standards › Anyone authenticated can read global standards': 'ABET reference data, not tenant-owned',
  'public.project_showcase › Anyone can read public showcase': 'the showcase is a deliberately public surface',
  'storage.objects › Assignment cell images: public read': 'public bucket by design',
  'storage.objects › Avatars: public read': 'public bucket by design',
}

describe('every table is protected', () => {
  it('row-level security is enabled on every public table', async () => {
    const rows = await query<{ tablename: string }>(`
      select c.relname as tablename
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by 1
    `)
    expect(
      rows.map((r) => r.tablename),
      `these public tables have RLS disabled, so every row is readable by any signed-in user`,
    ).toEqual([])
  })

  it('finds a realistic number of tables and policies (guards a vacuous pass)', async () => {
    const [{ tables, policies }] = await query<{ tables: string; policies: string }>(`
      select
        (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind='r') as tables,
        (select count(*) from pg_policies where schemaname in ('public','storage')) as policies
    `)
    expect(Number(tables)).toBeGreaterThanOrEqual(140)
    expect(Number(policies)).toBeGreaterThanOrEqual(250)
  })
})

describe('the anon role reaches nothing', () => {
  it('holds no privileges on any public table', async () => {
    const rows = await query<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon'
      order by 1, 2
    `)
    expect(
      rows.map((r) => `${r.table_name}:${r.privilege_type}`),
      'anon holds table privileges — the browser key can read these directly',
    ).toEqual([])
  })

  it('cannot execute any function in the public schema', async () => {
    /* Postgres grants EXECUTE to PUBLIC on every new function by default, and the
       ensure_no_anon_grants event trigger only covers CREATE TABLE. That gap is how
       can_author_in_section became callable by anyone holding the publishable key — it is
       SECURITY DEFINER and takes the user id as a parameter, so it answered "is this person in
       that section?" for an anonymous caller. */
    const rows = await query<{ routine_name: string; grantee: string }>(`
      select distinct r.routine_name, r.grantee
      from information_schema.role_routine_grants r
      join pg_proc p on p.proname = r.routine_name
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where r.specific_schema = 'public'
        and r.privilege_type = 'EXECUTE'
        and r.grantee in ('anon', 'PUBLIC')
        -- Trigger bodies are not callable over PostgREST, so their PUBLIC grant is unreachable.
        and pg_get_function_result(p.oid) not in ('trigger', 'event_trigger')
      order by 1
    `)
    const offenders = rows
      .filter((r) => !(r.routine_name in ANON_EXECUTE_ALLOWLIST))
      .map((r) => `${r.routine_name} (${r.grantee})`)
    expect(
      offenders,
      `anon/PUBLIC can execute these: ${offenders.join(', ')}. ` +
        `Add to the migration: REVOKE ALL ON FUNCTION public.<fn>(<args>) FROM PUBLIC, anon;`,
    ).toEqual([])
  })
})

describe('every policy scopes to the caller', () => {
  it('references an approved predicate, auth.uid(), or an explicit scoping subquery', async () => {
    /* Only policies a browser can actually reach. A policy granted solely to
       `supabase_auth_admin` — the four token-hook reads on profiles and the sso_* tables — is
       scoped by ROLE instead of by predicate: GoTrue needs them to mint a JWT and no client
       session can assume that role. Judging those by predicate shape would report correct
       design as a defect. */
    const rows = await query<{ schemaname: string; tablename: string; policyname: string; clause: string }>(`
      select schemaname, tablename, policyname,
             coalesce(qual, '') || ' ' || coalesce(with_check, '') as clause
      from pg_policies
      where schemaname in ('public', 'storage')
        and (roles && array['anon','authenticated','public']::name[])
      order by schemaname, tablename, policyname
    `)
    const scoped = new RegExp(`auth\\.uid\\(|\\b(?:${APPROVED.join('|')})\\s*\\(`, 'i')
    const offenders = rows
      .filter((r) => !scoped.test(r.clause))
      .map((r) => `${r.schemaname}.${r.tablename} › ${r.policyname}`)
      .filter((k) => !(k in GLOBAL_READ_ALLOWLIST))
    expect(
      offenders,
      `these policies mention neither auth.uid() nor an approved predicate, so they do not ` +
        `appear to scope to the caller: ${offenders.join(', ')}. If one is deliberately global, ` +
        `add it to GLOBAL_READ_ALLOWLIST with the reason.`,
    ).toEqual([])
  })

  it('no policy is a bare USING (true) for a CLIENT role on a tenant-scoped table', async () => {
    /* The single worst shape: RLS enabled, a policy present, and it lets everything through.
       Restricted to roles a browser can actually reach. Three policies here are `USING (true)`
       for `supabase_auth_admin` only — the JWT custom-access-token hook, which runs inside
       GoTrue and needs to read profiles and SSO config to mint a token. Those are scoped by
       ROLE rather than by predicate, so ignoring the roles column would report correct design
       as a defect. */
    const rows = await query<{ schemaname: string; tablename: string; policyname: string }>(`
      select p.schemaname, p.tablename, p.policyname
      from pg_policies p
      where p.schemaname in ('public', 'storage')
        and btrim(coalesce(p.qual, '')) = 'true'
        and (p.roles && array['anon','authenticated','public']::name[])
        and exists (
          select 1 from information_schema.columns c
          where c.table_schema = p.schemaname and c.table_name = p.tablename
            and c.column_name in ('institution_id', 'section_id', 'student_id', 'user_id')
        )
      order by 1, 2, 3
    `)
    expect(
      rows.map((r) => `${r.schemaname}.${r.tablename} › ${r.policyname}`),
      'a tenant-scoped table has a policy that permits every row',
    ).toEqual([])
  })
})

describe('the fix for the anon-executable predicate holds', () => {
  it('lc_add_upvote is no longer callable by anon — it is SECURITY DEFINER and it WRITES', async () => {
    /* Found by this very test on 2026-09-15, the same class of bug as can_author_in_section but
       worse: it UPDATEs lc_interactions.payload, and takes p_user_id as a parameter rather than
       reading auth.uid(). Anyone with the publishable key and an interaction id could inflate a
       live-classroom question's upvote count and attribute the vote to any user.
       service_role must keep EXECUTE — upvoteQuestion() reaches it through the admin client, and
       the function's ACL had no explicit service_role grant before the fix. */
    const rows = await query<{ grantee: string }>(`
      select distinct grantee
      from information_schema.role_routine_grants
      where specific_schema = 'public' and routine_name = 'lc_add_upvote'
        and privilege_type = 'EXECUTE'
      order by 1
    `)
    const grantees = rows.map((r) => r.grantee)
    expect(grantees).not.toContain('anon')
    expect(grantees).not.toContain('PUBLIC')
    expect(grantees, 'service_role lost EXECUTE, which breaks upvoting').toContain('service_role')
  })

  it('can_author_in_section is callable by authenticated and by nobody else', async () => {
    /* Verified by BEHAVIOUR of the grant, not by the migration text. Two policies depend on this
       function — discussion_messages insert and storage.objects "Chat attachments: upload" — so
       authenticated losing EXECUTE would break both. */
    const rows = await query<{ grantee: string }>(`
      select distinct grantee
      from information_schema.role_routine_grants
      where specific_schema = 'public'
        and routine_name = 'can_author_in_section'
        and privilege_type = 'EXECUTE'
      order by 1
    `)
    const grantees = rows.map((r) => r.grantee)
    expect(grantees).toContain('authenticated')
    expect(grantees).not.toContain('anon')
    expect(grantees).not.toContain('PUBLIC')
  })

  it('project_teams.submission and .planning_doc are readable by NO client role', async () => {
    /* Verified by EFFECTIVE PRIVILEGE, not by the migration text. These two columns hold a
       team's submitted coursework and their private planning doc, and they sit on a row every
       enrolled student is allowed to read (students browse teams to join) — so row-level
       security cannot protect them. A column-scoped SELECT grant is what does.

       This catches BOTH regression shapes in one query. Someone hitting "permission denied for
       table project_teams" and repairing it with a table-wide `grant select ... to authenticated`
       shows up here, because column_privileges expands a table grant into every column. So does
       someone simply adding these columns back to the keep-list. */
    const rows = await query<{ grantee: string; column_name: string }>(`
      select grantee, column_name
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'project_teams'
        and privilege_type = 'SELECT'
        and grantee in ('anon', 'authenticated', 'PUBLIC')
        and column_name in ('submission', 'planning_doc')
      order by 1, 2
    `)
    expect(rows).toEqual([])
  })

  it('project_teams grants authenticated the safe columns but anon nothing at all', async () => {
    /* The other half: proving the lockdown did not overshoot. The roster columns must stay
       readable or the team-browsing pages break silently (getProjectTeams swallows its error
       and returns []). And anon must hold nothing — note that role_table_grants does NOT
       surface column-only grants, so the repo's "anon reaches nothing" invariant cannot see
       this table and this assertion is the only thing watching it. */
    const rows = await query<{ grantee: string; column_name: string }>(`
      select grantee, column_name
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'project_teams'
        and privilege_type = 'SELECT'
        and grantee in ('anon', 'authenticated', 'PUBLIC')
      order by 1, 2
    `)
    expect(rows.filter((r) => r.grantee !== 'authenticated')).toEqual([])
    const cols = rows.map((r) => r.column_name).sort()
    expect(cols).toEqual(
      ['created_at', 'created_by', 'description', 'id', 'name', 'project_id', 'status', 'updated_at', 'workspace_enabled'],
    )
  })
})
