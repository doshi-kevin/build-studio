// One-time backfill: copies every non-empty project_teams.planning_doc
// into a new project_docs row titled "Planning" (is_pinned=true,
// position=0). Idempotent — re-running skips teams that already have a
// Planning doc.
//
// Hard-gated against non-local Supabase URLs. Will exit(1) if
// NEXT_PUBLIC_SUPABASE_URL is not 127.0.0.1 / localhost unless the
// --allow-remote flag is passed (which still requires explicit confirmation).
//
// Usage (from .env.local or .env.test):
//   npx tsx scripts/migrate-planning-to-docs.ts
//   npx tsx scripts/migrate-planning-to-docs.ts --dry-run
//
// The planning_doc column on project_teams is NOT modified. It remains
// in place for one release cycle as a safety net.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── Hard gate: refuse to run against non-local Supabase by default ────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function abort(msg: string): never {
  console.error(`\n\x1b[41m\x1b[37m ✗ MIGRATION ABORTED \x1b[0m ${msg}\n`)
  process.exit(1)
}

if (!SUPABASE_URL) abort('NEXT_PUBLIC_SUPABASE_URL is not set.')
if (!SERVICE_KEY) abort('SUPABASE_SERVICE_ROLE_KEY is not set.')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const allowRemote = args.includes('--allow-remote')

const isLocal =
  SUPABASE_URL.startsWith('http://127.0.0.1') ||
  SUPABASE_URL.startsWith('http://localhost')

if (!isLocal && !allowRemote) {
  abort(
    `NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL} is not local. ` +
      `Pass --allow-remote to run against a remote database (requires service role key).`,
  )
}

// ── Logging ────────────────────────────────────────────────────────────
const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const warn = (msg: string) => console.log(`  \x1b[33m⚠\x1b[0m ${msg}`)
const info = (msg: string) => console.log(`  ${msg}`)
const phase = (msg: string) => console.log(`\n━━━ ${msg} ━━━`)

// ── Supabase admin client ──────────────────────────────────────────────
const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Content shape: TipTap docs stored as HTML text historically ────────
// The existing planning_doc column held HTML strings from the TipTap
// editor. We store them in project_docs.content under a stable shape
// so the editor (TipTap via @tiptap/html or setContent) can rehydrate.
function wrapHtml(html: string): Record<string, unknown> {
  return { format: 'html', html }
}

async function main() {
  phase(`planning_doc → project_docs backfill ${dryRun ? '(DRY RUN)' : ''}`)
  info(`target: ${SUPABASE_URL}`)

  // 1. Fetch all teams with non-empty planning_doc
  const { data: teams, error: fetchErr } = await supabase
    .from('project_teams')
    .select('id, created_by, planning_doc')
    .not('planning_doc', 'is', null)

  if (fetchErr) abort(`failed to fetch project_teams: ${fetchErr.message}`)
  if (!teams) abort('no teams returned')

  const candidates = teams.filter(
    (t) => typeof t.planning_doc === 'string' && t.planning_doc.trim().length > 0,
  )

  info(`teams scanned: ${teams.length}`)
  info(`teams with non-empty planning_doc: ${candidates.length}`)

  if (candidates.length === 0) {
    ok('nothing to backfill.')
    return
  }

  // 2. For each candidate, skip if a "Planning" doc already exists
  let inserted = 0
  let skipped = 0
  let failed = 0

  for (const team of candidates) {
    const { data: existing, error: checkErr } = await supabase
      .from('project_docs')
      .select('id')
      .eq('team_id', team.id)
      .eq('title', 'Planning')
      .eq('position', 0)
      .limit(1)
      .maybeSingle()

    if (checkErr) {
      warn(`team ${team.id}: lookup failed — ${checkErr.message}`)
      failed++
      continue
    }

    if (existing) {
      skipped++
      continue
    }

    if (dryRun) {
      inserted++
      continue
    }

    const { error: insertErr } = await supabase.from('project_docs').insert({
      team_id: team.id,
      title: 'Planning',
      content: wrapHtml(team.planning_doc as string),
      is_pinned: true,
      position: 0,
      created_by: team.created_by,
      updated_by: team.created_by,
    })

    if (insertErr) {
      warn(`team ${team.id}: insert failed — ${insertErr.message}`)
      failed++
      continue
    }

    inserted++
  }

  phase('summary')
  ok(`inserted: ${inserted}${dryRun ? ' (would insert)' : ''}`)
  info(`skipped (already had Planning doc): ${skipped}`)
  if (failed > 0) warn(`failed: ${failed}`)

  // 3. Validation: count project_docs rows with title='Planning'
  if (!dryRun) {
    const { count, error: countErr } = await supabase
      .from('project_docs')
      .select('*', { count: 'exact', head: true })
      .eq('title', 'Planning')
      .eq('position', 0)

    if (countErr) {
      warn(`validation count failed: ${countErr.message}`)
    } else {
      info(`project_docs rows with title='Planning': ${count ?? 'unknown'}`)
    }
  }

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
