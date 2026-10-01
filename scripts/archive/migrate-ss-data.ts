// Phases 1-5: Migrate questions, quizzes, attempts, answers, ratings, and cohorts.
// Reads from skillsignal.* schema, writes to public.* (Scholera tables).
// Requires Phase 0 to have run first (ss-id-map.json must exist).
//
// Usage: npx dotenv -e .env.local -- npx tsx scripts/migrate-ss-data.ts

import {
  supabase, ssQuery, cleanup, loadIdMap,
  log, logPhase, logOk, logWarn, logError,
  questionUuid, choiceUuid, quizUuid, attemptUuid,
  SS_COURSE_ID, PROF_ZHU_SCHOLERA_ID,
} from './migrate-ss-shared'

// ── Types for SkillSignal rows ──────────────────────────────────────────────
interface SSQuestion {
  id: number
  content: string
  explanation: string | null
  choice_order: string | null
  difficulty: string | null
  expected_time_sec: number | null
  question_rating: number | null
}

interface SSChoice {
  id: number
  question_id: number
  choice_text: string
  correct: boolean
}

interface SSQuiz {
  id: number
  title: string
  description: string | null
  use_adaptive_mode: boolean
  active_from: string | null
  active_until: string | null
  timestamp: string
}

interface SSSitting {
  id: number
  user_id: number
  quiz_id: number
  question_list: string
  question_order: string
  incorrect_questions: string
  user_answers: string
  current_score: number
  complete: boolean
  cohort: string
  start_rating: number
  current_rating: number
  final_rating: number | null
  start: string
  end: string | null
}

interface SSEvent {
  sitting_id: number
  question_id: number
  is_correct: boolean
  time_taken_sec: number
  option_changes: number
  tab_switches: number
  copy_attempts: number
}

interface SSRating {
  user_id: number
  rating: number
  updated_at: string
}

interface SSCohort {
  user_id: number
  cohort: string
  assigned_at: string
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function parseCSV(val: string | null): number[] {
  if (!val || val.trim() === '') return []
  return val.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
}

function parseJSON(val: string | null): Record<string, number> {
  if (!val || val.trim() === '' || val.trim() === '{}') return {}
  try {
    return JSON.parse(val)
  } catch {
    return {}
  }
}

function defaultElo(difficulty: string | null): number {
  if (difficulty === 'easy') return 800
  if (difficulty === 'hard') return 1600
  return 1200
}

function defaultTime(difficulty: string | null): number {
  if (difficulty === 'easy') return 30
  if (difficulty === 'hard') return 60
  return 45
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔═══════════════════════════════════════════════╗')
  console.log('║  SkillSignal → Scholera: Data Migration       ║')
  console.log('╚═══════════════════════════════════════════════╝')

  // Load ID map from Phase 0
  const idMap = loadIdMap()
  const sectionId = idMap.sectionId
  const userIdMap = new Map(Object.entries(idMap.users))

  log(`Loaded ID map: ${userIdMap.size} users, section ${sectionId.slice(0, 8)}...`)

  // Maps built during migration
  const questionIdMap = new Map<number, string>()   // SS question ID → Scholera UUID
  const choiceIdMap = new Map<string, string>()      // "ssQid-ssChoiceId" → Scholera choice UUID
  const quizIdMap = new Map<number, string>()        // SS quiz ID → Scholera UUID
  const attemptIdMap = new Map<number, string>()     // SS sitting ID → Scholera UUID

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Questions + Choice ID Map
  // ═══════════════════════════════════════════════════════════════════════════
  logPhase('Phase 1: Questions + Choice ID Map')

  // Get all questions for course 2
  const questions = await ssQuery<SSQuestion>(`
    SELECT DISTINCT q.id, q.content, q.explanation,
      mc.choice_order, qm.difficulty, qm.expected_time_sec, qm.question_rating
    FROM quiz_question q
    JOIN quiz_mcquestion mc ON mc.question_ptr_id = q.id
    LEFT JOIN quiz_questionmeta qm ON qm.question_id = q.id
    WHERE q.id IN (
      SELECT DISTINCT qq.question_id
      FROM quiz_question_quiz qq
      JOIN quiz_quiz qz ON qz.id = qq.quiz_id
      WHERE qz.course_id = $1
    )
    ORDER BY q.id
  `, [SS_COURSE_ID])

  log(`Found ${questions.length} questions to migrate`)

  let qMigrated = 0
  for (const q of questions) {
    const qId = Number(q.id) // pg returns bigint as string — normalize to number
    const scQuestionId = questionUuid(qId)
    questionIdMap.set(qId, scQuestionId)

    // Get choices for this question
    const choices = await ssQuery<SSChoice>(`
      SELECT id, question_id, choice_text, correct
      FROM quiz_choice WHERE question_id = $1
      ORDER BY id
    `, [qId])

    // Build JSONB content with translated choice IDs
    const mappedChoices = choices.map(c => {
      const cId = Number(c.id)
      const scChoiceId = choiceUuid(qId, cId)
      choiceIdMap.set(`${qId}-${cId}`, scChoiceId)
      return {
        id: scChoiceId,
        text: c.choice_text,
        isCorrect: c.correct,
      }
    })

    const content = {
      questionType: 'multiple_choice',
      choices: mappedChoices,
      allowMultiple: choices.filter(c => c.correct).length > 1,
    }

    const { error } = await supabase.from('quiz_questions').upsert({
      id: scQuestionId,
      section_id: sectionId,
      question_text: q.content,
      question_type: 'multiple_choice',
      content,
      difficulty: q.difficulty || 'medium',
      points: 1,
      explanation: q.explanation || '',
      tags: [],
      elo_rating: q.question_rating || defaultElo(q.difficulty),
      expected_time_seconds: q.expected_time_sec || defaultTime(q.difficulty),
    }, { onConflict: 'id' })

    if (error) {
      logWarn(`Question ${q.id}: ${error.message}`)
    } else {
      qMigrated++
    }
  }

  logOk(`${qMigrated} questions migrated, ${choiceIdMap.size} choice IDs mapped`)

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Quizzes + Assignments
  // ═══════════════════════════════════════════════════════════════════════════
  logPhase('Phase 2: Quizzes + Question Assignments')

  const quizzes = await ssQuery<SSQuiz>(`
    SELECT id, title, description, use_adaptive_mode, active_from, active_until, timestamp
    FROM quiz_quiz WHERE course_id = $1
    ORDER BY id
  `, [SS_COURSE_ID])

  log(`Found ${quizzes.length} quizzes to migrate`)

  for (const quiz of quizzes) {
    const quizId = Number(quiz.id)
    const scQuizId = quizUuid(quizId)
    quizIdMap.set(quizId, scQuizId)

    // Get question links for this quiz
    const qLinks = await ssQuery<{ question_id: number }>(`
      SELECT question_id FROM quiz_question_quiz WHERE quiz_id = $1 ORDER BY id
    `, [quizId])

    const { error: quizError } = await supabase.from('quizzes').upsert({
      id: scQuizId,
      section_id: sectionId,
      created_by: PROF_ZHU_SCHOLERA_ID,
      title: quiz.title,
      description: quiz.description || '',
      status: 'published',
      adaptive_mode: quiz.use_adaptive_mode,
      adaptive_ratio: 60,
      adaptive_question_count: qLinks.length || 10,
      control_distribution: { easy: 3, medium: 3, hard: 4 },
      max_attempts: 1,
      pass_threshold: 60,
    }, { onConflict: 'id' })

    if (quizError) {
      logWarn(`Quiz "${quiz.title}": ${quizError.message}`)
      continue
    }

    // Create question assignments
    let assigned = 0
    for (let i = 0; i < qLinks.length; i++) {
      const scQId = questionIdMap.get(Number(qLinks[i].question_id))
      if (!scQId) continue

      const { error: assignError } = await supabase.from('quiz_question_assignments').upsert({
        quiz_id: scQuizId,
        question_id: scQId,
        position: i,
      }, { onConflict: 'quiz_id,question_id' })

      if (!assignError) assigned++
    }

    logOk(`Quiz "${quiz.title}": ${assigned} questions assigned`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Attempts + Answers (with Choice ID Translation)
  // ═══════════════════════════════════════════════════════════════════════════
  logPhase('Phase 3: Attempts + Answers')

  const sittings = await ssQuery<SSSitting>(`
    SELECT id, user_id, quiz_id, question_list, question_order, incorrect_questions,
      user_answers, current_score, complete, cohort,
      start_rating, current_rating, final_rating,
      start, "end"
    FROM quiz_sitting
    WHERE course_id = $1 AND complete = true
    ORDER BY id
  `, [SS_COURSE_ID])

  log(`Found ${sittings.length} completed attempts to migrate`)

  let attemptsMigrated = 0
  let answersMigrated = 0

  for (const sitting of sittings) {
    const sittingId = Number(sitting.id)
    const studentId = userIdMap.get(String(sitting.user_id))
    const scQuizId = quizIdMap.get(Number(sitting.quiz_id))
    if (!studentId || !scQuizId) {
      logWarn(`Skipping sitting ${sittingId}: missing student or quiz mapping`)
      continue
    }

    const scAttemptId = attemptUuid(sittingId)
    attemptIdMap.set(sittingId, scAttemptId)

    // Parse question list and build resolved_question_ids
    // parseCSV already returns numbers, which match our questionIdMap keys
    const questionOrder = parseCSV(sitting.question_order || sitting.question_list)
    const resolvedQuestionIds = questionOrder
      .map(qid => questionIdMap.get(qid))
      .filter((id): id is string => !!id)

    const incorrectSet = new Set(parseCSV(sitting.incorrect_questions))
    const totalQ = resolvedQuestionIds.length || 1
    const correctCount = totalQ - incorrectSet.size
    const score = Math.round((Math.max(0, correctCount) / totalQ) * 100)

    // Compute time spent
    let timeSpent = 0
    if (sitting.start && sitting.end) {
      timeSpent = Math.round((new Date(sitting.end).getTime() - new Date(sitting.start).getTime()) / 1000)
    }

    // Map cohort: "normal" → "control"
    const cohort = sitting.cohort === 'normal' ? 'control' : (sitting.cohort || 'adaptive')

    const { error: attemptError } = await supabase.from('quiz_attempts').upsert({
      id: scAttemptId,
      quiz_id: scQuizId,
      student_id: studentId,
      section_id: sectionId,
      status: 'submitted',
      score: Math.max(0, score),
      total_points: totalQ,
      earned_points: Math.max(0, correctCount),
      resolved_question_ids: resolvedQuestionIds,
      started_at: sitting.start,
      submitted_at: sitting.end || sitting.start,
      time_spent_seconds: timeSpent,
      cohort,
      start_rating: sitting.start_rating || 1200,
      current_rating: sitting.current_rating || 1200,
      final_rating: sitting.final_rating || sitting.current_rating || 1200,
      adaptive_question_index: resolvedQuestionIds.length,
    }, { onConflict: 'id' })

    if (attemptError) {
      logWarn(`Attempt ${sitting.id}: ${attemptError.message}`)
      continue
    }
    attemptsMigrated++

    // Parse user_answers and create quiz_answers with TRANSLATED choice IDs
    const userAnswers = parseJSON(sitting.user_answers)

    for (const [ssQIdStr, ssChoiceIdRaw] of Object.entries(userAnswers)) {
      const ssQId = parseInt(ssQIdStr)
      const ssChoiceId = Number(ssChoiceIdRaw)
      const scQuestionId = questionIdMap.get(ssQId)
      if (!scQuestionId) continue

      // Translate the choice ID (key format: "qId-choiceId")
      const scChoiceId = choiceIdMap.get(`${ssQId}-${ssChoiceId}`)
      const isCorrect = !incorrectSet.has(ssQId)

      const { error: ansError } = await supabase.from('quiz_answers').upsert({
        attempt_id: scAttemptId,
        question_id: scQuestionId,
        selected_choice_ids: scChoiceId ? [scChoiceId] : null,
        is_correct: isCorrect,
        earned_points: isCorrect ? 1 : 0,
      }, { onConflict: 'attempt_id,question_id' })

      if (!ansError) answersMigrated++
    }
  }

  logOk(`${attemptsMigrated} attempts migrated, ${answersMigrated} answers created`)

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Behavioral Events → quiz_answers UPDATE
  // ═══════════════════════════════════════════════════════════════════════════
  logPhase('Phase 4: Behavioral Events')

  const events = await ssQuery<SSEvent>(`
    SELECT sitting_id, question_id, is_correct, time_taken_sec,
      option_changes, tab_switches, copy_attempts
    FROM quiz_questionattemptevent
    WHERE course_id = $1
    ORDER BY sitting_id, question_id
  `, [SS_COURSE_ID])

  log(`Found ${events.length} behavioral events to merge`)

  let eventsApplied = 0
  for (const event of events) {
    const scAttemptId = attemptIdMap.get(Number(event.sitting_id))
    const scQuestionId = questionIdMap.get(Number(event.question_id))
    if (!scAttemptId || !scQuestionId) continue

    const { error } = await supabase.from('quiz_answers').update({
      time_spent_seconds: Math.round(event.time_taken_sec),
      option_changes: event.option_changes,
      tab_switches: event.tab_switches,
      copy_attempts: event.copy_attempts,
    })
      .eq('attempt_id', scAttemptId)
      .eq('question_id', scQuestionId)

    if (!error) eventsApplied++
  }

  logOk(`${eventsApplied} behavioral events applied to quiz_answers`)

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: Student Ratings + Cohort Assignments
  // ═══════════════════════════════════════════════════════════════════════════
  logPhase('Phase 5: Student Ratings + Cohort Assignments')

  // Student ratings
  const ratings = await ssQuery<SSRating>(`
    SELECT user_id, rating, updated_at
    FROM quiz_studentrating WHERE course_id = $1
  `, [SS_COURSE_ID])

  let ratingsCreated = 0
  for (const r of ratings) {
    const studentId = userIdMap.get(String(r.user_id))
    if (!studentId) continue

    // Count completed attempts for quizzes_taken
    const { count } = await supabase.from('quiz_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('student_id', studentId)
      .eq('section_id', sectionId)
      .eq('status', 'submitted')

    const { error } = await supabase.from('student_ratings').upsert({
      student_id: studentId,
      section_id: sectionId,
      rating: r.rating,
      quizzes_taken: count || 0,
      updated_at: r.updated_at,
    }, { onConflict: 'student_id,section_id' })

    if (!error) ratingsCreated++
  }

  logOk(`${ratingsCreated} student ratings created`)

  // Cohort assignments
  const cohorts = await ssQuery<SSCohort>(`
    SELECT user_id, cohort, assigned_at
    FROM quiz_coursecohortassignment WHERE course_id = $1
  `, [SS_COURSE_ID])

  let cohortsCreated = 0
  for (const c of cohorts) {
    const studentId = userIdMap.get(String(c.user_id))
    if (!studentId) continue

    const { error } = await supabase.from('cohort_assignments').upsert({
      student_id: studentId,
      section_id: sectionId,
      cohort: c.cohort === 'normal' ? 'control' : (c.cohort || 'adaptive'),
      assigned_by: 'auto',
      assigned_at: c.assigned_at,
    }, { onConflict: 'student_id,section_id' })

    if (!error) cohortsCreated++
  }

  logOk(`${cohortsCreated} cohort assignments created`)

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n┌──────────────────────────────────────┐')
  console.log('│  Data Migration Complete              │')
  console.log('├──────────────────────────────────────┤')
  console.log(`│  Questions:      ${String(qMigrated).padStart(5)}              │`)
  console.log(`│  Choice mappings:${String(choiceIdMap.size).padStart(5)}              │`)
  console.log(`│  Quizzes:        ${String(quizzes.length).padStart(5)}              │`)
  console.log(`│  Attempts:       ${String(attemptsMigrated).padStart(5)}              │`)
  console.log(`│  Answers:        ${String(answersMigrated).padStart(5)}              │`)
  console.log(`│  Behavioral:     ${String(eventsApplied).padStart(5)}              │`)
  console.log(`│  Ratings:        ${String(ratingsCreated).padStart(5)}              │`)
  console.log(`│  Cohorts:        ${String(cohortsCreated).padStart(5)}              │`)
  console.log('└──────────────────────────────────────┘')
  console.log('\nRun validate-migration.ts to verify data integrity.')

  await cleanup()
}

main().catch(err => {
  logError(err.message)
  console.error(err)
  process.exit(1)
})
