/**
 * Every admin / super-admin page that fetches data must authorize INLINE, before the
 * fetch — not rely on its layout.
 *
 * Why this exists as a test rather than a rule: Next's App Router renders layout and
 * page segments in PARALLEL, and both role layouts deny by RETURNING a <DeadEnd/>
 * instead of throwing. So the page still executes and still streams its data into the
 * response — the reader sees the dead end, the payload is in the network tab. That is
 * how ten pages leaked another institution's roster PII and lecture PDFs to any
 * logged-in student (audit 2026-08-06, PR #555).
 *
 * The regression this guards against is NOT "someone deletes an existing guard" — it is
 * "someone adds a new admin page and doesn't know the layout isn't enough." A rule in
 * .claude/rules/dead-ends.md documents it; this makes it fail the build.
 *
 * Deliberately asserts ORDER, not presence: a guard that runs after the fetch has
 * already leaked. Grepping only for the helper's name would pass on exactly the bug
 * this is meant to catch.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = [
  'src/app/(dashboard)/admin',
  'src/app/(dashboard)/super-admin',
]

function pageFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...pageFiles(full))
    else if (entry === 'page.tsx') out.push(full)
  }
  return out
}

/** Strip comments so a guard mentioned only in prose never counts as one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * A privileged read: constructing the RLS-bypassing admin client, or deriving the
 * caller's tenant. These are the two things that must not happen before the guard.
 *
 * Deliberately NOT `\w+Queries\.` — whether a query helper is privileged depends on
 * which client the caller passes, which a regex cannot tell. Worse, the guards
 * themselves use one: `profileQueries.getProfileById(supabase, user.id)` reads the
 * caller's OWN profile through the cookie-bound anon client to obtain their role.
 * Counting that as a privileged read fails super-admin/team, which is correct code.
 * Every one of the ten pages that actually leaked called createAdminClient() or
 * getCurrentInstitutionId() with no guard above it, so this is the load-bearing signal.
 */
const FETCH = /createAdminClient\s*\(|getCurrentInstitutionId\s*\(/
/**
 * An authorization gate. The two shared helpers, plus the hand-rolled
 * `profile.role !== '...'` shape that super-admin/team uses.
 */
const GUARD = /verifyInstitutionAdmin\s*\(|verifySuperAdmin\s*\(|profile\??\.role\s*!==/

const files = ROOTS.flatMap(pageFiles).sort()

describe('admin + super-admin pages authorize inline, not via their layout', () => {
  it('finds the pages (guards against the enumeration silently breaking)', () => {
    // If a refactor moves these trees, this test would otherwise pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(20)
  })

  it.each(files)('%s', (file) => {
    const src = stripComments(readFileSync(file, 'utf8'))
    const fetchAt = src.search(FETCH)

    // A page that reads nothing privileged needs no guard (e.g. a static style guide,
    // a create-form whose dropdowns load client-side).
    if (fetchAt === -1) return

    const guardAt = src.search(GUARD)

    expect(
      guardAt,
      `${file} performs a privileged read but has no inline authorization guard. ` +
        `Its layout is NOT enough — layout and page render in parallel, so this page ` +
        `still streams its data to a denied user. Add verifyInstitutionAdmin() / ` +
        `verifySuperAdmin() before the fetch. See .claude/rules/dead-ends.md.`,
    ).toBeGreaterThan(-1)

    expect(
      guardAt,
      `${file} has an authorization guard, but it runs AFTER the first privileged read ` +
        `(guard at index ${guardAt}, read at ${fetchAt}). By then the data has already ` +
        `been fetched. Move the guard above it.`,
    ).toBeLessThan(fetchAt)
  })
})
