// Step 2: Send magic link invite emails to professor and all migrated students.
// Run this ONLY after verifying the data migration is correct.
// Each user receives an email with a magic link to set their password.
//
// Usage: npx dotenv -e .env.local -- npx tsx scripts/send-invites.ts
//
// Options:
//   --dry-run       Show who would be invited without sending (default)
//   --send          Actually send the emails
//   --professor     Only send to professor
//   --students      Only send to students

import {
  supabase, cleanup,
  log, logPhase, logOk, logWarn, logError,
} from './migrate-ss-shared'
import * as fs from 'fs'
import * as path from 'path'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = !args.includes('--send')
  const professorOnly = args.includes('--professor')
  const studentsOnly = args.includes('--students')
  const sendBoth = !professorOnly && !studentsOnly

  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║  Send Invite Emails (Magic Links)            ║')
  console.log('╚══════════════════════════════════════════════╝')

  if (dryRun) {
    console.log('\n  ⚠  DRY RUN — no emails will be sent.')
    console.log('     Add --send to actually send emails.\n')
  } else {
    console.log('\n  🔴 LIVE MODE — emails WILL be sent!\n')
  }

  // Load ID map
  const idMapPath = path.join(__dirname, 'ss-id-map.json')
  const idMap = JSON.parse(fs.readFileSync(idMapPath, 'utf-8'))

  let sent = 0
  let skipped = 0
  let failed = 0

  // ── Professor ─────────────────────────────────────────────────────────────
  if (sendBoth || professorOnly) {
    logPhase('Professor Invite')

    const { data: prof } = await supabase.from('profiles')
      .select('id, email, name')
      .eq('id', idMap.professorId)
      .single()

    if (!prof) {
      logError('Professor profile not found: ' + idMap.professorId)
    } else {
      log(`${prof.name} <${prof.email}>`)

      if (dryRun) {
        logOk('Would invite (dry run)')
        skipped++
      } else {
        const { error } = await supabase.auth.admin.inviteUserByEmail(
          prof.email,
          {
            data: { name: prof.name },
            redirectTo: `${SITE_URL}/auth/callback`,
          }
        )
        if (error) {
          logWarn(`${prof.email}: ${error.message}`)
          failed++
        } else {
          logOk(`Invited: ${prof.email}`)
          sent++
        }
      }
    }
  }

  // ── Students ──────────────────────────────────────────────────────────────
  if (sendBoth || studentsOnly) {
    logPhase('Student Invites')

    const studentEntries = Object.entries(idMap.users).filter(
      ([_, scholId]) => scholId !== idMap.professorId
    )

    log(`${studentEntries.length} students to invite`)

    for (const [ssId, scholaraId] of studentEntries) {
      const { data: profile } = await supabase.from('profiles')
        .select('id, email, name')
        .eq('id', scholaraId as string)
        .single()

      if (!profile) {
        logWarn(`Profile not found for SS user ${ssId} (${scholaraId})`)
        failed++
        continue
      }

      if (dryRun) {
        log(`Would invite: ${profile.name} <${profile.email}>`)
        skipped++
      } else {
        const { error } = await supabase.auth.admin.inviteUserByEmail(
          profile.email,
          {
            data: { name: profile.name },
            redirectTo: `${SITE_URL}/auth/callback`,
          }
        )

        if (error) {
          if (error.message.includes('already') || error.message.includes('exists')) {
            // User already invited or confirmed — generate a magic link instead
            const { error: linkError } = await supabase.auth.admin.generateLink({
              type: 'magiclink',
              email: profile.email,
              options: { redirectTo: `${SITE_URL}/auth/callback` },
            })
            if (linkError) {
              logWarn(`${profile.email}: ${linkError.message}`)
              failed++
            } else {
              logOk(`Magic link sent: ${profile.email}`)
              sent++
            }
          } else {
            logWarn(`${profile.email}: ${error.message}`)
            failed++
          }
        } else {
          logOk(`Invited: ${profile.email}`)
          sent++
        }

        // Rate limit
        if (sent % 10 === 0 && sent > 0) {
          log(`${sent} emails sent so far...`)
        }
        await new Promise(r => setTimeout(r, 50))
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n┌──────────────────────────────────┐')
  console.log(`│  ${dryRun ? 'Dry Run' : 'Invites Sent'}${' '.repeat(dryRun ? 18 : 16)}│`)
  console.log('├──────────────────────────────────┤')
  if (dryRun) {
    console.log(`│  Would send:  ${String(skipped).padStart(3)} emails         │`)
  } else {
    console.log(`│  Sent:        ${String(sent).padStart(3)} emails         │`)
  }
  console.log(`│  Failed:      ${String(failed).padStart(3)}                │`)
  console.log('└──────────────────────────────────┘')

  if (dryRun) {
    console.log('\nTo actually send: npx dotenv -e .env.local -- npx tsx scripts/send-invites.ts --send')
  }

  await cleanup()
}

main().catch(err => {
  logError(err.message)
  process.exit(1)
})
