/**
 * `feedbacks.admin_notes` is staff commentary about the submitter and must not be
 * readable by the submitter.
 *
 * RLS cannot express this: the owner-read policy is row-level, so it hands over the
 * whole row. The protection is a COLUMN grant, which is a different mechanism — which
 * makes it easy to undo by accident. The realistic regression is someone hitting
 * "permission denied for table feedbacks" (a `select('*')` as a user now fails by
 * design) and repairing it with a table-wide `grant select on feedbacks`, silently
 * restoring the leak.
 *
 * This asserts the shape of the migration rather than querying a live database, so it
 * runs in CI. The behavioural proof — a real user JWT against PostgREST getting 403 on
 * `select=admin_notes` while the admin path still reads it — was done against the live
 * database when the migration was applied.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** EVERY migration, oldest first. Deliberately unfiltered: a schema-wide
 *  `grant ... on all tables in schema public` re-broadens feedbacks without ever containing the
 *  token "feedbacks", so filtering on that name would hide exactly the regression that matters. */
const allMigrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS, f), 'utf8') }))

const CLIENT_ROLE = /\banon\b|\bauthenticated\b/

describe('feedbacks.admin_notes column grants', () => {
  /* These tests read migration FILES, so they cannot observe effective privileges — that is a
     real limit, raised in review. What they can do is guarantee no LATER migration re-broadens
     what the fix narrowed, which is the regression they exist to catch. The effective state was
     verified directly against prod when the fix landed:
       select grantee, column_name from information_schema.column_privileges
       where table_name='feedbacks' and privilege_type='SELECT' and grantee in ('anon','authenticated')
     → `authenticated` holds SELECT on 12 columns, admin_notes NOT among them; `anon` holds none. */

  it('the LAST migration to grant SELECT on feedbacks is column-scoped and omits admin_notes', () => {
    const granting = allMigrations.filter((m) =>
      /grant\s+[^;]*\bselect\b[^;]*\son\s+(?:table\s+)?(?:public\.)?feedbacks\b/i.test(m.sql) ||
      /grant\s+select\s*\([^)]*\)\s*on\s+(?:table\s+)?(?:public\.)?feedbacks\b/i.test(m.sql),
    )
    expect(granting.length, 'no migration grants SELECT on feedbacks at all').toBeGreaterThan(0)

    // Only the newest one describes the CURRENT intent; earlier ones are superseded history.
    const newest = granting[granting.length - 1]
    const columnLists = [...newest.sql.matchAll(/grant\s+select\s*\(([^)]*)\)/gi)].map((x) => x[1])
    expect(
      columnLists.length,
      `${newest.name} is the newest SELECT grant on feedbacks but is not column-scoped`,
    ).toBeGreaterThan(0)
    for (const list of columnLists) {
      expect(list, `${newest.name} grants SELECT on admin_notes`).not.toMatch(/admin_notes/i)
    }
  })

  it('never grants table-wide SELECT/UPDATE/ALL on feedbacks to a client role', () => {
    for (const m of allMigrations) {
      /* A privilege list in any order — `insert, select`, `all`, `all privileges` — with NO
         column list before ON ... feedbacks. The earlier version anchored on select|update|all
         appearing FIRST, so `grant insert, select on feedbacks to authenticated` slipped past. */
      const tableWide = [
        ...m.sql.matchAll(
          /grant\s+((?:all(?:\s+privileges)?|select|update|insert|delete|references|trigger|truncate)(?:\s*,\s*(?:all(?:\s+privileges)?|select|update|insert|delete|references|trigger|truncate))*)\s+on\s+(?:table\s+)?(?:public\.)?feedbacks\s+to\s+([^;]+);/gi,
        ),
      ].filter((match) => /\bselect\b|\ball\b|\bupdate\b/i.test(match[1]))

      for (const match of tableWide) {
        expect(
          CLIENT_ROLE.test(match[2].toLowerCase()),
          `${m.name} grants table-wide "${match[1]}" on feedbacks to ${match[2].trim()} — this re-exposes admin_notes`,
        ).toBe(false)
      }
    }
  })

  it('never grants schema-wide SELECT/ALL to a client role — it would sweep feedbacks in', () => {
    for (const m of allMigrations) {
      const schemaWide = [
        ...m.sql.matchAll(
          /grant\s+([^;]*?)\s+on\s+all\s+tables\s+in\s+schema\s+public\s+to\s+([^;]+);/gi,
        ),
      ].filter((match) => /\bselect\b|\ball\b/i.test(match[1]))

      for (const match of schemaWide) {
        expect(
          CLIENT_ROLE.test(match[2].toLowerCase()),
          `${m.name} grants schema-wide "${match[1].trim()}" to ${match[2].trim()} — feedbacks.admin_notes is swept back in`,
        ).toBe(false)
      }
    }
  })
})
