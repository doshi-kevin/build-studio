// Remap professor: Replace dummy prof account with real zzhu41@stevens.edu.
// Creates fresh auth user, updates profile, and remaps all FK references.
//
// Usage: npx dotenv -e .env.local -- npx tsx scripts/remap-professor.ts

import {
  supabase, cleanup,
  log, logPhase, logOk, logWarn, logError,
} from './migrate-ss-shared'
import * as fs from 'fs'
import * as path from 'path'

const OLD_PROF_ID = '2947ea05-27df-4ce6-b650-3564298b3027' // dummy doshikevin1012@gmail.com
const SECTION_ID = 'b58a8ce1-a897-5a12-850f-e521bb67e3f6'

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║  Remap Professor: zzhu41@stevens.edu          ║')
  console.log('╚══════════════════════════════════════════════╝')

  // ── Step 1: Create auth user for Prof Zhu ─────────────────────────────────
  logPhase('Step 1: Create auth user')

  let newProfId: string

  // Check if zzhu41@stevens.edu already exists
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', 'zzhu41@stevens.edu')
    .maybeSingle()

  if (existingProfile) {
    newProfId = existingProfile.id
    logOk(`Already exists: ${newProfId}`)
  } else {
    // Create account silently — no email sent. Use send-invites.ts later.
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email: 'zzhu41@stevens.edu',
      email_confirm: true,
      user_metadata: { name: 'Zining Zhu' },
    })

    if (createError) {
      // Might exist in auth already
      if (createError.message.includes('already') || createError.message.includes('exists')) {
        const { data: { users } } = await supabase.auth.admin.listUsers()
        const authUser = users.find(u => u.email === 'zzhu41@stevens.edu')
        if (authUser) {
          newProfId = authUser.id
          logOk(`Found in auth: ${newProfId}`)
        } else {
          logError(`Cannot find or create zzhu41@stevens.edu: ${createError.message}`)
          process.exit(1)
        }
      } else {
        logError(`Failed to create: ${createError.message}`)
        process.exit(1)
      }
    } else {
      newProfId = createData.user.id
      logOk(`Created auth user: ${newProfId} (no email sent)`)
    }

    // Wait for trigger to fire
    await new Promise(r => setTimeout(r, 200))

    // Upsert profile
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: newProfId,
      email: 'zzhu41@stevens.edu',
      first_name: 'Zining',
      last_name: 'Zhu',
      name: 'Zining Zhu',
      role: 'professor',
      status: 'active',
      phone: '2012163573',
      onboarding_completed: true,
      invite_status: 'pending',
    }, { onConflict: 'id' })

    if (profileError) logWarn(`Profile upsert: ${profileError.message}`)
    else logOk('Profile created')
  }

  log(`Old professor ID: ${OLD_PROF_ID}`)
  log(`New professor ID: ${newProfId!}`)

  // ── Step 2: Remap course_sections.professor_id ────────────────────────────
  logPhase('Step 2: Remap Section D')

  const { error: secErr } = await supabase.from('course_sections')
    .update({ professor_id: newProfId! })
    .eq('id', SECTION_ID)

  if (secErr) logWarn(`Section update: ${secErr.message}`)
  else logOk('Section D professor_id updated')

  // ── Step 3: Remap quizzes.created_by ──────────────────────────────────────
  logPhase('Step 3: Remap quizzes')

  const { data: quizzes } = await supabase.from('quizzes')
    .select('id, title')
    .eq('section_id', SECTION_ID)
    .eq('created_by', OLD_PROF_ID)

  if (quizzes && quizzes.length > 0) {
    const { error: quizErr } = await supabase.from('quizzes')
      .update({ created_by: newProfId! })
      .eq('section_id', SECTION_ID)
      .eq('created_by', OLD_PROF_ID)

    if (quizErr) logWarn(`Quiz remap: ${quizErr.message}`)
    else logOk(`${quizzes.length} quizzes remapped`)
  } else {
    log('No quizzes to remap')
  }

  // ── Step 4: Remap Prof Zhu's own quiz attempt ─────────────────────────────
  logPhase('Step 4: Remap Prof Zhu attempt')

  const { data: profAttempts } = await supabase.from('quiz_attempts')
    .select('id')
    .eq('student_id', OLD_PROF_ID)
    .eq('section_id', SECTION_ID)

  if (profAttempts && profAttempts.length > 0) {
    const { error: attErr } = await supabase.from('quiz_attempts')
      .update({ student_id: newProfId! })
      .eq('student_id', OLD_PROF_ID)
      .eq('section_id', SECTION_ID)

    if (attErr) logWarn(`Attempt remap: ${attErr.message}`)
    else logOk(`${profAttempts.length} attempt(s) remapped`)
  } else {
    log('No attempts to remap')
  }

  // ── Step 5: Remap student_ratings ─────────────────────────────────────────
  logPhase('Step 5: Remap student rating')

  const { error: ratingErr } = await supabase.from('student_ratings')
    .update({ student_id: newProfId! })
    .eq('student_id', OLD_PROF_ID)
    .eq('section_id', SECTION_ID)

  if (ratingErr) logWarn(`Rating remap: ${ratingErr.message}`)
  else logOk('Student rating remapped')

  // ── Step 6: Remap cohort_assignments ──────────────────────────────────────
  logPhase('Step 6: Remap cohort assignment')

  const { error: cohortErr } = await supabase.from('cohort_assignments')
    .update({ student_id: newProfId! })
    .eq('student_id', OLD_PROF_ID)
    .eq('section_id', SECTION_ID)

  if (cohortErr) logWarn(`Cohort remap: ${cohortErr.message}`)
  else logOk('Cohort assignment remapped')

  // ── Step 7: Update ID map ─────────────────────────────────────────────────
  logPhase('Step 7: Update ID map')

  const idMapPath = path.join(__dirname, 'ss-id-map.json')
  const idMap = JSON.parse(fs.readFileSync(idMapPath, 'utf-8'))
  idMap.professorId = newProfId!
  idMap.users['317'] = newProfId!
  fs.writeFileSync(idMapPath, JSON.stringify(idMap, null, 2))
  logOk('ss-id-map.json updated')

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n┌─────────────────────────────────────────────┐')
  console.log('│  Professor Remap Complete                    │')
  console.log('├─────────────────────────────────────────────┤')
  console.log(`│  Email:    zzhu41@stevens.edu                │`)
  console.log(`│  New ID:   ${newProfId!.slice(0, 8)}...                       │`)
  console.log(`│  Old ID:   ${OLD_PROF_ID.slice(0, 8)}... (dummy)              │`)
  console.log('├─────────────────────────────────────────────┤')
  console.log('│  Remapped: section, quizzes, attempts,      │')
  console.log('│            ratings, cohorts, ID map          │')
  console.log('└─────────────────────────────────────────────┘')
  console.log('\n⚠  Update PROF_ZHU_SCHOLERA_ID in migrate-ss-shared.ts')
  console.log('   to: ' + newProfId!)

  await cleanup()
}

main().catch(err => {
  logError(err.message)
  process.exit(1)
})
