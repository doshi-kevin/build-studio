// Phase 0: Create student accounts, Section D, and enrollments.
// - Cleans dummy NLP quiz data
// - Creates new course section for Prof Zhu's NLP class
// - Creates 42 SkillSignal student accounts via createUser (NO invite emails sent)
// - Enrolls all students in the new section
// - Persists user ID mappings to ss-id-map.json
//
// Students are created silently — use inviteUserByEmail separately when ready to onboard.
//
// Usage: npx dotenv -e .env.local -- npx tsx scripts/migrate-ss-phase0.ts

import {
  supabase, ssQuery, cleanup, saveIdMap,
  log, logPhase, logOk, logWarn, logError,
  PROF_ZHU_SCHOLERA_ID, SS_COURSE_ID, NLP_COURSE_ID_SCHOLERA, sectionUuid,
} from './migrate-ss-shared'

interface SSUser {
  id: number
  email: string
  first_name: string
  last_name: string
  is_student: boolean
  is_lecturer: boolean
  cwid: string | null
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║  SkillSignal → Scholera: Phase 0 (Accounts) ║')
  console.log('╚══════════════════════════════════════════════╝')

  // ── Step 1: Clean dummy NLP quiz data ───────────────────────────────────
  logPhase('Step 1: Clean dummy NLP quiz data')

  // Get all NLP section IDs
  const { data: nlpSections } = await supabase
    .from('course_sections')
    .select('id')
    .eq('course_id', NLP_COURSE_ID_SCHOLERA)

  if (nlpSections && nlpSections.length > 0) {
    const sectionIds = nlpSections.map(s => s.id)

    // Delete in FK order: answers → attempts → assignments → questions → quizzes
    for (const sid of sectionIds) {
      const { data: quizzes } = await supabase.from('quizzes').select('id').eq('section_id', sid)
      if (quizzes && quizzes.length > 0) {
        const quizIds = quizzes.map(q => q.id)

        // Delete attempts and their answers
        const { data: attempts } = await supabase.from('quiz_attempts').select('id').in('quiz_id', quizIds)
        if (attempts && attempts.length > 0) {
          const attemptIds = attempts.map(a => a.id)
          await supabase.from('quiz_answers').delete().in('attempt_id', attemptIds)
          await supabase.from('proctoring_snapshots').delete().in('attempt_id', attemptIds)
          await supabase.from('quiz_proctoring_logs').delete().in('attempt_id', attemptIds)
          await supabase.from('quiz_attempts').delete().in('id', attemptIds)
        }

        // Delete assignments
        await supabase.from('quiz_question_assignments').delete().in('quiz_id', quizIds)

        // Delete quizzes
        await supabase.from('quizzes').delete().in('id', quizIds)
      }

      // Delete orphaned questions for this section
      await supabase.from('quiz_questions').delete().eq('section_id', sid)

      // Delete ratings and cohorts
      await supabase.from('student_ratings').delete().eq('section_id', sid)
      await supabase.from('cohort_assignments').delete().eq('section_id', sid)
    }

    logOk(`Cleaned dummy quiz data from ${sectionIds.length} NLP section(s)`)
  } else {
    log('No existing NLP sections found')
  }

  // ── Step 2: Create Section D ────────────────────────────────────────────
  logPhase('Step 2: Create Section D for NLP (Prof Zhu)')

  const newSectionId = sectionUuid()

  const { error: sectionError } = await supabase
    .from('course_sections')
    .upsert({
      id: newSectionId,
      course_id: NLP_COURSE_ID_SCHOLERA,
      section_code: 'D',
      semester: 'spring',
      year: 2026,
      professor_id: PROF_ZHU_SCHOLERA_ID,
      max_students: 60,
      modality: 'in_person',
      status: 'active',
      settings: {
        features: {
          ai_tutor: true,
          adaptive_quizzes: true,
          group_projects: false,
          ai_quiz_generation: true,
          ai_course_generation: true,
          office_hours_booking: true,
        },
      },
    }, { onConflict: 'id' })

  if (sectionError) {
    logError(`Failed to create section: ${sectionError.message}`)
    process.exit(1)
  }
  logOk(`Section D created: ${newSectionId}`)

  // ── Step 3: Fetch SkillSignal students ──────────────────────────────────
  logPhase('Step 3: Invite SkillSignal students')

  const students = await ssQuery<SSUser>(`
    SELECT u.id, u.email, u.first_name, u.last_name, u.is_student, u.is_lecturer,
      s.cwid
    FROM accounts_user u
    LEFT JOIN accounts_student s ON s.student_id = u.id
    WHERE u.is_student = true
      AND u.email LIKE '%@stevens.edu'
      AND u.id IN (
        SELECT DISTINCT user_id FROM quiz_sitting WHERE course_id = $1 AND complete = true
      )
    ORDER BY u.email
  `, [SS_COURSE_ID])

  // Handle duplicate kdoshi7: pick the one with actual quiz data
  const kdoshiDuplicates = students.filter(s => s.email === 'kdoshi7@stevens.edu')
  let filteredStudents = students.filter(s => s.email !== 'kdoshi7@stevens.edu')
  if (kdoshiDuplicates.length > 0) {
    // Pick the one with the most sittings
    let bestKdoshi = kdoshiDuplicates[0]
    for (const k of kdoshiDuplicates) {
      const rows = await ssQuery<{ cnt: string }>(`
        SELECT count(*) as cnt FROM quiz_sitting WHERE user_id = $1 AND course_id = $2 AND complete = true
      `, [k.id, SS_COURSE_ID])
      const cnt = parseInt(rows[0]?.cnt || '0')
      const bestRows = await ssQuery<{ cnt: string }>(`
        SELECT count(*) as cnt FROM quiz_sitting WHERE user_id = $1 AND course_id = $2 AND complete = true
      `, [bestKdoshi.id, SS_COURSE_ID])
      if (cnt > parseInt(bestRows[0]?.cnt || '0')) bestKdoshi = k
    }
    filteredStudents.push(bestKdoshi)
  }

  // Skip test/admin accounts
  filteredStudents = filteredStudents.filter(s =>
    !s.email.includes('teacher@') &&
    !s.email.includes('admin@') &&
    !s.email.includes('skylearn')
  )

  log(`Found ${filteredStudents.length} students to migrate`)

  // ── Step 4: Create accounts via inviteUserByEmail ───────────────────────
  const userIdMap: Record<string, string> = {}
  let created = 0
  let existing = 0
  let failed = 0

  for (const student of filteredStudents) {
    // Check if already exists in Scholera (by email)
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', student.email)
      .maybeSingle()

    if (existingProfile) {
      userIdMap[String(student.id)] = existingProfile.id
      existing++
      continue
    }

    // Create user silently via createUser (NO invite email sent)
    const { data: createData, error: createError } = await supabase.auth.admin.createUser({
      email: student.email,
      email_confirm: true, // mark email as confirmed so account is usable
      user_metadata: {
        name: `${student.first_name} ${student.last_name}`.trim(),
      },
    })

    if (createError) {
      // User might already exist in auth but not in profiles
      if (createError.message.includes('already been registered') || createError.message.includes('already exists')) {
        // Fetch by email from auth
        const { data: { users } } = await supabase.auth.admin.listUsers()
        const authUser = users.find(u => u.email === student.email)
        if (authUser) {
          userIdMap[String(student.id)] = authUser.id
          existing++
          continue
        }
      }
      logWarn(`Failed to create ${student.email}: ${createError.message}`)
      failed++
      continue
    }

    const scholaraId = createData.user.id
    userIdMap[String(student.id)] = scholaraId

    // Update profile with student details (handle_new_user trigger creates base profile)
    // Small delay to let the trigger fire
    await new Promise(r => setTimeout(r, 100))

    await supabase.from('profiles').upsert({
      id: scholaraId,
      email: student.email,
      first_name: student.first_name,
      last_name: student.last_name,
      name: `${student.first_name} ${student.last_name}`.trim(),
      role: 'student',
      status: 'active',
      cwid: student.cwid || null,
      invite_status: 'pending',
      onboarding_completed: true,
    }, { onConflict: 'id' })

    created++

    // Rate limit: small delay between creates
    if (created % 10 === 0) {
      log(`Created ${created} student accounts so far...`)
    }
    await new Promise(r => setTimeout(r, 50))
  }

  logOk(`Students: ${created} created (no emails), ${existing} already existed, ${failed} failed`)

  // ── Step 5: Enroll students in Section D ────────────────────────────────
  logPhase('Step 4: Enroll students in Section D')

  let enrolled = 0
  for (const [ssId, scholaraId] of Object.entries(userIdMap)) {
    // Verify this is a student (not professor)
    const student = filteredStudents.find(s => String(s.id) === ssId)
    if (!student) continue

    const { error: enrollError } = await supabase
      .from('enrollments')
      .upsert({
        student_id: scholaraId,
        section_id: newSectionId,
        status: 'enrolled',
      }, { onConflict: 'student_id,section_id' })

    if (enrollError) {
      logWarn(`Failed to enroll ${student.email}: ${enrollError.message}`)
    } else {
      enrolled++
    }
  }

  logOk(`Enrolled ${enrolled} students in Section D`)

  // ── Step 6: Save ID map ─────────────────────────────────────────────────
  logPhase('Step 5: Save ID map')

  saveIdMap({
    generatedAt: new Date().toISOString(),
    sectionId: newSectionId,
    professorId: PROF_ZHU_SCHOLERA_ID,
    users: userIdMap,
  })

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n┌────────────────────────────────┐')
  console.log('│  Phase 0 Complete              │')
  console.log('├────────────────────────────────┤')
  console.log(`│  Section D:  ${newSectionId.slice(0, 8)}...│`)
  console.log(`│  Students:   ${String(created).padStart(3)} created        │`)
  console.log(`│  Existing:   ${String(existing).padStart(3)} skipped        │`)
  console.log(`│  Enrolled:   ${String(enrolled).padStart(3)} students       │`)
  console.log(`│  Failed:     ${String(failed).padStart(3)}                 │`)
  console.log('└────────────────────────────────┘')

  await cleanup()
}

main().catch(err => {
  logError(err.message)
  process.exit(1)
})
