/**
 * Static checks on new migrations, for the failures that are fatal and cheap to catch.
 *
 * WHY STATIC. The real row-level-security suite (src/__tests__/db/) runs against a live Postgres
 * and is a LOCAL pre-merge gate, so it does not gate `main`. These rules need nothing but the
 * .sql text, so they run in CI on every PR and are the only automated thing standing between a
 * bad migration and `main`. They are a floor, not a substitute: a policy can satisfy every rule
 * here and still be wired to the wrong column. That is what the live suite and review are for.
 *
 * WHY A CUTOFF. There are 280+ existing migrations written before these rules existed, and
 * retroactively failing them would just force a blanket opt-out. Rules apply only to migrations
 * named after the cutoff below, so the standard ratchets forward from the day it was introduced.
 * The live suite in src/__tests__/db/ covers the grandfathered ones.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'

/**
 * Migrations named at or after this are held to the rules below. This is the timestamp of
 * 20260915061311_revoke_anon_can_author_in_section.sql, the migration that fixed the anon-
 * executable predicate these rules exist to prevent recurring.
 */
const CUTOFF = '20260915061311'

/**
 * The SECURITY DEFINER predicate helpers that policies are allowed to delegate to, read off prod
 * on 2026-09-15. Tenant isolation here is TRANSITIVE — policies do not filter on an
 * institution_id column, they ask "is the caller a member of this section / team / course", and
 * these are the functions that answer. A policy referencing none of them and not mentioning
 * auth.uid() either is almost certainly unscoped.
 */
const APPROVED_PREDICATES = [
  'is_team_member', 'is_course_member', 'is_section_owner_or_staff', 'is_super_admin',
  'is_enrolled_or_professor', 'is_section_admin', 'is_admin', 'is_admin_of', 'is_project_owner',
  'is_dm_participant', 'can_access_phase', 'can_author_in_section', 'is_enrolled_in_section',
  'is_professor_of_section', 'is_project_member', 'is_staff_of_section', 'is_section_member',
  'is_section_staff',
]

/** SQL line comments removed so a rule never fires on prose describing what NOT to do. */
function stripSql(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, '')
}

const allMigrations = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const governed = allMigrations.filter((f) => f.slice(0, 14) >= CUTOFF)

interface Migration { file: string; sql: string }
const governedSql: Migration[] = governed.map((f) => ({
  file: f,
  sql: stripSql(readFileSync(join(DIR, f), 'utf8')),
}))

describe('new migrations keep the tenant boundary intact', () => {
  it('finds the migrations and the cutoff still exists', () => {
    // If the directory moves or the cutoff migration is renamed, every rule below would pass
    // against an empty list and nobody would notice.
    expect(allMigrations.length).toBeGreaterThanOrEqual(280)
    expect(allMigrations.some((f) => f.startsWith(CUTOFF))).toBe(true)
  })

  it('every new function revokes the default PUBLIC execute grant', () => {
    /* Postgres grants EXECUTE on a new function to PUBLIC automatically, and PUBLIC includes
       anon — the role behind the publishable key in the browser bundle. A SECURITY DEFINER
       helper left at the default is callable by anyone on the internet. This is exactly how
       can_author_in_section became an unauthenticated membership oracle. */
    const offenders: string[] = []
    for (const { file, sql } of governedSql) {
      const created = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)/gi)]
      for (const m of created) {
        const fn = m[1]
        const revoked = new RegExp(
          `REVOKE[\\s\\S]{0,200}?ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\b[\\s\\S]{0,200}?FROM[^;]*\\b(?:PUBLIC|anon)\\b`,
          'i',
        ).test(sql)
        if (!revoked) offenders.push(`${file} › ${fn}()`)
      }
    }
    expect(
      offenders,
      `these functions never revoke the default PUBLIC/anon EXECUTE grant: ${offenders.join(', ')}. ` +
        `Add: REVOKE ALL ON FUNCTION public.<fn>(<args>) FROM PUBLIC, anon;  ` +
        `then GRANT EXECUTE back to the roles that genuinely need it.`,
    ).toEqual([])
  })

  it('no new migration grants function execute to anon or PUBLIC', () => {
    const offenders: string[] = []
    for (const { file, sql } of governedSql) {
      if (/GRANT[\s\S]{0,200}?ON\s+FUNCTION[\s\S]{0,200}?TO[^;]*\b(?:anon|PUBLIC)\b/i.test(sql)) {
        offenders.push(file)
      }
    }
    expect(
      offenders,
      `grants function EXECUTE to anon/PUBLIC in: ${offenders.join(', ')}. ` +
        `anon is the browser's role — it should reach nothing in this schema.`,
    ).toEqual([])
  })

  it('every new policy scopes by an approved predicate or auth.uid()', () => {
    /* The one check that catches a table shipped with `USING (true)`. Necessary, not sufficient:
       it cannot tell whether the right column was passed to the predicate. */
    const offenders: string[] = []
    const scoped = new RegExp(`auth\\.uid\\s*\\(|\\b(?:${APPROVED_PREDICATES.join('|')})\\s*\\(`, 'i')
    for (const { file, sql } of governedSql) {
      // A policy body runs from CREATE POLICY to the statement terminator.
      for (const m of sql.matchAll(/CREATE\s+POLICY\s+([\s\S]*?);/gi)) {
        const body = m[1]
        const name = /"([^"]+)"|'([^']+)'/.exec(body)?.[1] ?? body.slice(0, 40).replace(/\s+/g, ' ')
        if (!scoped.test(body)) offenders.push(`${file} › ${name}`)
      }
    }
    expect(
      offenders,
      `these policies reference neither auth.uid() nor an approved predicate, so they are ` +
        `probably unscoped: ${offenders.join(', ')}. A tenant-scoped policy must ask who the ` +
        `caller is. If this one is deliberately open, say so in a comment above it.`,
    ).toEqual([])
  })

  it('no new migration weakens row-level security', () => {
    /* Covering the bypasses, not just the happy path: a rule that only inspects CREATE POLICY is
       sidestepped by dropping or loosening an existing one instead. DROP POLICY is legitimate
       when the same file creates a replacement — that is the standard idiom here, since Postgres
       has no CREATE POLICY IF NOT EXISTS. */
    const offenders: string[] = []
    for (const { file, sql } of governedSql) {
      if (/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql)) {
        offenders.push(`${file} (DISABLE ROW LEVEL SECURITY)`)
      }
      const drops = [...sql.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?([\s\S]*?);/gi)].length
      const creates = [...sql.matchAll(/CREATE\s+POLICY/gi)].length
      if (drops > 0 && creates === 0) {
        offenders.push(`${file} (drops ${drops} policies and creates none)`)
      }
    }
    expect(
      offenders,
      `row-level security weakened in: ${offenders.join(', ')}. ` +
        `Dropping a policy without a replacement removes a tenant boundary.`,
    ).toEqual([])
  })
})
