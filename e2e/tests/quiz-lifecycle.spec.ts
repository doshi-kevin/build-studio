// P0 — Quiz lifecycle: enrolled student takes a seeded MCQ quiz, server
// grades the attempt, score renders on the results page and is persisted
// to quiz_attempts. Server-side grading is the single most important
// correctness guarantee in the LMS — a bug here silently ships wrong
// scores to student transcripts. Unit tests mock the grader; this spec
// drives `submitAttempt` through the real server action + DB path.
//
// We seed the quiz + question + assignment directly (admin client) rather
// than driving the professor editor. The editor has its own vitest
// coverage; this spec focuses on the grading + results read path that
// only an end-to-end run can validate.

import { test, expect } from '@playwright/test'
import { admin, seedIds } from '../helpers/db'
import { storageStatePath } from '../fixtures/test-users'

test.use({ storageState: storageStatePath('studentEnrolled') })

const QUIZ_TITLE = `E2E Quiz ${Date.now()}`
// Two choices; exactly one is correct. Picking the correct one → 100.
const CORRECT_CHOICE_ID = 'c1'
const WRONG_CHOICE_ID = 'c2'

let quizId: string | null = null
let questionId: string | null = null

test.beforeAll(async () => {
  const { section } = seedIds()
  const { users } = seedIds()
  const professorId = users['e2e-professor@scholera.test']

  // 1. Question — single-answer MCQ, worth 1 point.
  const { data: question, error: qErr } = await admin
    .from('quiz_questions')
    .insert({
      section_id: section,
      question_text: 'What is 2 + 2?',
      question_type: 'multiple_choice',
      content: {
        questionType: 'multiple_choice',
        choices: [
          { id: CORRECT_CHOICE_ID, text: '4', isCorrect: true },
          { id: WRONG_CHOICE_ID, text: '5', isCorrect: false },
        ],
        allowMultiple: false,
      },
      difficulty: 'easy',
      points: 1,
      tags: [],
    })
    .select('id')
    .single()
  if (qErr || !question) throw qErr ?? new Error('question insert failed')
  questionId = question.id

  // 2. Quiz — published, no shuffle (so choice order in the DOM matches our fixture),
  //    one attempt so we don't need to clean retries between runs.
  const { data: quiz, error: quizErr } = await admin
    .from('quizzes')
    .insert({
      section_id: section,
      created_by: professorId,
      title: QUIZ_TITLE,
      description: 'Seeded by E2E quiz-lifecycle spec',
      status: 'published',
      max_attempts: 5,
      shuffle_questions: false,
      shuffle_answers: false,
      pass_threshold: 60,
    })
    .select('id')
    .single()
  if (quizErr || !quiz) throw quizErr ?? new Error('quiz insert failed')
  quizId = quiz.id

  // 3. Wire question → quiz.
  const { error: asgErr } = await admin
    .from('quiz_question_assignments')
    .insert({ quiz_id: quiz.id, question_id: question.id, position: 0 })
  if (asgErr) throw asgErr
})

test.afterAll(async () => {
  // quiz_answers + quiz_attempts + quiz_question_assignments FK-cascade
  // from quizzes in most schemas, but delete explicitly for portability.
  if (quizId) {
    const { data: attempts } = await admin
      .from('quiz_attempts')
      .select('id')
      .eq('quiz_id', quizId)
    const attemptIds = (attempts ?? []).map((a) => a.id)
    if (attemptIds.length) {
      await admin.from('quiz_answers').delete().in('attempt_id', attemptIds)
      await admin.from('quiz_attempts').delete().in('id', attemptIds)
    }
    await admin.from('quiz_question_assignments').delete().eq('quiz_id', quizId)
    await admin.from('quizzes').delete().eq('id', quizId)
  }
  if (questionId) await admin.from('quiz_questions').delete().eq('id', questionId)
})

test('student attempts quiz → server grades → score on results page', async ({ page }) => {
  const { section } = seedIds()
  const { users } = seedIds()
  const studentId = users['e2e-student-enrolled@scholera.test']

  // ── 1. Quiz list shows the published quiz ─────────────────────────
  await page.goto(`/student/courses/${section}/quizzes`)
  await expect(page.getByText(QUIZ_TITLE)).toBeVisible({ timeout: 15_000 })

  // ── 2. Start → routed to the attempt page ─────────────────────────
  // 45s wait accommodates Next.js dev-server first-compile for the
  // attempt route; prod builds resolve this in <1s.
  await page.getByRole('button', { name: /^start$/i }).first().click()
  await page.waitForURL(/\/quizzes\/[^/]+\/attempt\//, { timeout: 45_000 })

  // ── 3. Answer the MCQ ─────────────────────────────────────────────
  // QuestionDisplay renders choices as role="option" rows with the
  // choice text in a MarkdownLatex span — click by the visible text.
  // 45s covers Next.js dev-server compile of the attempt route after
  // waitForURL resolves — URL change precedes first paint.
  await expect(page.getByText('What is 2 + 2?')).toBeVisible({ timeout: 45_000 })
  await page.getByRole('option', { name: '4' }).click()

  // ── 4. Submit via the sidebar button ──────────────────────────────
  // The player dialog is an AlertDialog, not a regular Dialog.
  await page.getByRole('button', { name: /^submit quiz$/i }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: /submit quiz/i }).click()

  // ── 5. Results page shows the score ───────────────────────────────
  await page.waitForURL(/\/quizzes\/[^/]+\/results\//, { timeout: 45_000 })
  await expect(page.getByRole('heading', { name: QUIZ_TITLE })).toBeVisible()
  // Score circle shows "100%" inside the results donut. Anchor to the
  // "Score 1/1" stat card as an additional independent signal that the
  // server returned full credit — catches cases where the donut renders
  // optimistically before the server write lands.
  await expect(page.getByText('100%').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('1/1').first()).toBeVisible()

  // ── 6. DB: attempt row is submitted with score=100 ────────────────
  // This is the load-bearing assertion — proves the server-side grader
  // actually wrote to quiz_attempts, not just rendered optimistically.
  const { data: attempt } = await admin
    .from('quiz_attempts')
    .select('status, score, earned_points, total_points')
    .eq('quiz_id', quizId!)
    .eq('student_id', studentId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  expect(attempt?.status).toBe('submitted')
  expect(attempt?.score).toBe(100)
  expect(attempt?.earned_points).toBe(1)
  expect(attempt?.total_points).toBe(1)
})
