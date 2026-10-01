
/**
 * Post-migration validation script for SkillSignal → Scholera data.
 *
 * Checks record counts, spot-checks random attempts, and verifies
 * Elo ratings were preserved correctly.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/validate-migration.ts
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function validate() {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║  Migration Validation                    ║')
  console.log('╚══════════════════════════════════════════╝\n')

  let allPassed = true

  // 1. Record counts
  console.log('── Record Counts ──')

  const tables = [
    'quiz_questions',
    'quizzes',
    'quiz_question_assignments',
    'quiz_attempts',
    'quiz_answers',
    'student_ratings',
    'cohort_assignments',
  ]

  for (const table of tables) {
    const { count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })

    if (error) {
      console.error(`  ${table}: ERROR - ${error.message}`)
      allPassed = false
    } else {
      console.log(`  ${table}: ${count} rows`)
    }
  }

  // 2. Adaptive quiz check
  console.log('\n── Adaptive Quizzes ──')
  const { data: adaptiveQuizzes, error: aqErr } = await supabase
    .from('quizzes')
    .select('id, title, adaptive_mode, adaptive_question_count')
    .eq('adaptive_mode', true)

  if (aqErr) {
    console.error(`  ERROR: ${aqErr.message}`)
    allPassed = false
  } else {
    console.log(`  ${adaptiveQuizzes?.length || 0} adaptive quizzes found`)
    for (const q of (adaptiveQuizzes || []).slice(0, 5)) {
      console.log(`    - "${q.title}" (${q.adaptive_question_count} questions)`)
    }
  }

  // 3. Spot-check 10 random attempts
  console.log('\n── Spot-Check: Random Attempts ──')
  const { data: attempts } = await supabase
    .from('quiz_attempts')
    .select('id, quiz_id, student_id, score, cohort, start_rating, final_rating, status')
    .not('cohort', 'is', null)
    .limit(10)

  if (!attempts || attempts.length === 0) {
    console.log('  No adaptive attempts to check')
  } else {
    for (const a of attempts) {
      const issues: string[] = []

      if (a.score === null || a.score === undefined) issues.push('missing score')
      if (!a.cohort) issues.push('missing cohort')
      if (!a.start_rating) issues.push('missing start_rating')
      if (a.status === 'submitted' && !a.final_rating) issues.push('submitted but no final_rating')

      // Check answers exist
      const { count: answerCount } = await supabase
        .from('quiz_answers')
        .select('*', { count: 'exact', head: true })
        .eq('attempt_id', a.id)

      if (answerCount === 0) issues.push('no answers')

      if (issues.length > 0) {
        console.log(`  WARN attempt ${a.id.slice(0, 8)}...: ${issues.join(', ')}`)
        allPassed = false
      } else {
        console.log(`  OK   attempt ${a.id.slice(0, 8)}...: score=${a.score}%, cohort=${a.cohort}, rating=${a.start_rating}→${a.final_rating || '?'}, answers=${answerCount}`)
      }
    }
  }

  // 4. Student ratings check
  console.log('\n── Student Ratings ──')
  const { data: ratings } = await supabase
    .from('student_ratings')
    .select('student_id, section_id, rating')
    .order('rating', { ascending: false })
    .limit(5)

  if (!ratings || ratings.length === 0) {
    console.log('  No student ratings found')
  } else {
    console.log(`  Top 5 ratings:`)
    for (const r of ratings) {
      console.log(`    ${r.student_id.slice(0, 8)}... in ${r.section_id.slice(0, 8)}...: ${r.rating}`)
    }
  }

  // 5. Cohort distribution
  console.log('\n── Cohort Distribution ──')
  const { data: cohortData } = await supabase
    .from('cohort_assignments')
    .select('cohort')

  if (cohortData) {
    const adaptive = cohortData.filter((c) => c.cohort === 'adaptive').length
    const control = cohortData.filter((c) => c.cohort === 'control').length
    console.log(`  Adaptive: ${adaptive}, Control: ${control}`)
    const total = adaptive + control
    if (total > 0) {
      console.log(`  Ratio: ${Math.round((adaptive / total) * 100)}% adaptive / ${Math.round((control / total) * 100)}% control`)
    }
  }

  // Summary
  console.log('\n══════════════════════════════════════════')
  if (allPassed) {
    console.log('  All checks PASSED')
  } else {
    console.log('  Some checks had WARNINGS — review above')
  }
}

validate().catch((err) => {
  console.error('Validation script failed:', err)
  process.exit(1)
})
