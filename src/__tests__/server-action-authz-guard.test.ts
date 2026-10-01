/**
 * Every server action must establish WHO is calling before it reads through the RLS-bypassing
 * admin client.
 *
 * Same shape and the same reasoning as admin-page-inline-authz-guard.test.ts, applied to the
 * other half of the attack surface. That file covers ~20 admin pages; this covers 559 exported
 * server actions, every one of which is an unauthenticated HTTP endpoint from an attacker's point
 * of view. `createAdminClient()` uses the service-role key, which bypasses row-level security
 * entirely — so a query through it before the caller is known is a straight read of every
 * institution's data.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 * Proves: the action authenticates before the first service-role query. That closes anonymous
 * service-role reads across all 559.
 * Does NOT prove: that the action checked the caller was allowed to touch the ID they passed in.
 * An authenticated student handing over another student's submission ID is IDOR, it is a
 * different bug, and this test cannot see it. Ownership is the job of the per-action behavioural
 * tests and of the row-level-security suite in src/__tests__/db/. Read this file as "nobody
 * anonymous got in", never as "these actions are safe".
 *
 * Asserts ORDER, not presence: a guard that runs after the query has already read the rows.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Comments blanked, line count preserved, so an index comparison stays meaningful.
 *
 * LINE comments are stripped BEFORE block comments, and the order is load-bearing. Doing it the
 * other way round silently destroys real code: `src/lib/auth/admin-context.ts` has the line
 * comment `// across admin/*​/actions.ts`, whose glob contains both a `/*` and a `*​/`. A
 * block-first pass treats that as the start of a comment and blanks everything down to the next
 * `*​/` forty lines later — taking `verifyInstitutionAdmin`'s declaration with it, which made
 * this test report the guard as missing when it was right there.
 */
function stripComments(src: string): string {
  return src
    .replace(/^(\s*)\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * Helpers that actually establish the caller's identity, i.e. their own body reaches
 * `supabase.auth.getUser()`.
 *
 * This list is MEASURED, not guessed, and the first test below re-derives it. A name pattern like
 * /\b(verify|load|require)[A-Z]\w*\(/ looks reasonable and is unsound: `loadRoom()` only SELECTs
 * from lc_rooms, and `loadAssessmentContext()` trusts a `userId` its caller passes in. Both read
 * like guards and authenticate nobody, so a pattern-based rule would wave through an action whose
 * only "guard" was one of them.
 */
const IDENTITY_HELPERS = [
  'getAuthUser',
  'authorizeSubmissionFile',
  'authorizeTeam',
  'currentUserId',
  'getStudent',
  'guardStaff',
  'loadOwnedSection',
  'loadReleasedSubmissionContext',
  'requireSectionWriter',
  'resolveSectionStaff',
  'resolveStaff',
  'verifyInstitutionAdmin',
  'verifyProfessor',
  'verifyProfessorOwnsSection',
  'verifyStudent',
  'verifySuperAdmin',
] as const

const IDENTITY = new RegExp(
  `auth\\s*\\.\\s*getUser\\s*\\(|\\b(?:${IDENTITY_HELPERS.join('|')})\\s*\\(`,
)

/**
 * A privileged read. Name-independent on purpose: the client is aliased as `adminDb` in most
 * files but also as `admin`, `db` and others, and a storage read goes through `.storage.from(`.
 * Anchoring on a hardcoded `adminDb.` prefix would miss those.
 */
const ADMIN_CLIENT = /createAdminClient\s*\(/
const QUERY = /\.\s*(?:from|rpc)\s*\(|\.\s*storage\s*\.\s*from\s*\(|\.\s*auth\s*\.\s*admin\s*\./

/**
 * Actions that legitimately run before anyone is authenticated. Each needs a reason, and the
 * list must stay tiny — it is the only way to defeat this test.
 */
const PRE_AUTH_ALLOWLIST: Record<string, string> = {
  // The login flow itself: both run for a signed-out visitor by definition. Their enumeration
  // safety (identical answer whether or not the account exists) is pinned separately in
  // login-cwid-enumeration-oracle.test.ts, which is the property that actually matters here.
  resolveCwidToEmail: 'pre-auth login lookup',
  sendPasswordResetForIdentifier: 'pre-auth password reset',
  // Internal grading hooks. Not reachable as endpoints in practice — they are invoked by grading
  // actions that already authorized the caller, and take an evidence object rather than a
  // caller-supplied ID.
  applyGradeToSkillMastery: 'internal hook, called by an already-authorized grading action',
  applyNodeCheckPassToSkillMastery: 'internal hook, called by an already-authorized grading action',
}

interface Action {
  file: string
  name: string
  body: string
}

const actions: Action[] = []
const serverFiles: string[] = []
for (const file of tsFiles(SRC)) {
  const raw = readFileSync(file, 'utf8')
  if (!raw.includes("'use server'")) continue
  serverFiles.push(file)
  const src = stripComments(raw)
  const marks = [...src.matchAll(/export\s+async\s+function\s+(\w+)/g)]
  marks.forEach((m, i) => {
    const start = m.index!
    const end = i + 1 < marks.length ? marks[i + 1].index! : src.length
    actions.push({ file, name: m[1], body: src.slice(start, end) })
  })
}

/** Actions that reach a service-role query — the only ones this rule applies to. */
const privileged = actions.filter((a) => ADMIN_CLIENT.test(a.body) && QUERY.test(a.body))

describe('server actions authenticate before their first service-role query', () => {
  it('finds the server actions (guards against the enumeration silently breaking)', () => {
    // Without this, a moved directory or a changed directive would make every case below pass
    // against an empty list.
    expect(serverFiles.length).toBeGreaterThanOrEqual(80)
    expect(actions.length).toBeGreaterThanOrEqual(500)
    expect(privileged.length).toBeGreaterThanOrEqual(140)
  })

  it('every helper on the identity allowlist really does authenticate', () => {
    /* "Stale entries rot the map", borrowed from ai-call-site-coverage.test.ts. If one of these
       is refactored to take a userId parameter instead of reading the session, it silently stops
       being a guard and this whole test weakens without anyone noticing. Checking the claim is
       what makes the allowlist trustworthy. */
    const all = tsFiles(SRC).map((f) => stripComments(readFileSync(f, 'utf8')))
    const notAuthenticating: string[] = []

    for (const helper of IDENTITY_HELPERS) {
      if (helper === 'getAuthUser') continue // the base case: it IS the auth.getUser() wrapper
      const defn = new RegExp(
        `(?:async\\s+function\\s+${helper}\\b|const\\s+${helper}\\s*=)([\\s\\S]{0,2500})`,
      )
      const found = all.map((s) => defn.exec(s)).find((m) => m !== null)
      if (!found) {
        notAuthenticating.push(`${helper} (definition not found)`)
        continue
      }
      if (!/auth\s*\.\s*getUser\s*\(|\bgetAuthUser\s*\(/.test(found[1])) {
        notAuthenticating.push(`${helper} (body never reaches auth.getUser())`)
      }
    }

    expect(
      notAuthenticating,
      `these are trusted as authentication guards but do not authenticate: ` +
        `${notAuthenticating.join(', ')}. Either fix the helper or drop it from IDENTITY_HELPERS ` +
        `— leaving it listed makes every action that relies on it pass unchecked.`,
    ).toEqual([])
  })

  it('the pre-auth allowlist stays small and every entry still exists', () => {
    // An allowlist is the one way to defeat this test, so it gets its own guard rail.
    expect(Object.keys(PRE_AUTH_ALLOWLIST).length).toBeLessThanOrEqual(8)
    const names = new Set(actions.map((a) => a.name))
    const stale = Object.keys(PRE_AUTH_ALLOWLIST).filter((n) => !names.has(n))
    expect(stale, `allowlisted actions that no longer exist: ${stale.join(', ')}`).toEqual([])
  })

  it.each(privileged.map((a) => [`${a.file.replace(/^src\//, '')} › ${a.name}`, a] as const))(
    '%s',
    (_label, action) => {
      if (action.name in PRE_AUTH_ALLOWLIST) return

      const clientAt = action.body.search(ADMIN_CLIENT)
      const queryAt = action.body.slice(clientAt).search(QUERY) + clientAt
      const identityAt = action.body.search(IDENTITY)

      expect(
        identityAt,
        `${action.file} › ${action.name}() queries through the service-role client without ` +
          `authenticating anyone first. The service-role key bypasses row-level security, so this ` +
          `reads every institution's rows for an anonymous caller. Call getAuthUser() (or another ` +
          `helper in IDENTITY_HELPERS) before the query. If it genuinely runs pre-auth, add it to ` +
          `PRE_AUTH_ALLOWLIST with a reason.`,
      ).toBeGreaterThan(-1)

      expect(
        identityAt,
        `${action.file} › ${action.name}() authenticates, but only AFTER its first service-role ` +
          `query (auth at ${identityAt}, query at ${queryAt}). By then the rows have been read. ` +
          `Move the guard above the query.`,
      ).toBeLessThan(queryAt)
    },
  )
})
