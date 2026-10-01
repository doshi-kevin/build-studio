// Quizzes, assignments, the weighted gradebook, and skill mastery.
//
// One rule holds this together: every score a student gets anywhere comes from
// the same latent `ability` number. A demo falls apart the moment the gradebook
// says a student is strong and the mastery heatmap says they are struggling, so
// nothing here is rolled independently.

import {
  db, det, up, ok, phase, warn,
  INSTITUTION_ID, WEEKS_IN, daysAgo, rng, NOW, weekdayName,
} from './context'
import type { Campus, Person, SectionInfo } from './roster'
import { WEEKS } from './curriculum'
import type { ContentIds } from './content'
import { makeHandoutPdf, upload, signedUrl, placeholderSnapshotJpeg } from './files'
import { buildSubmissionPath } from '@/lib/assignments/files'
import { ASSIGNMENT_SUBMISSIONS_BUCKET } from '@/lib/supabase/storage'

export interface Assessments {
  /** Latent skill, 0-1. Drives every score in the tenant. */
  abilityByStudent: Map<string, number>
  /** Per-student quiz average as a percentage, 0-100. */
  quizAvgByStudent: Map<string, number>
  /** Per-student mastery by skill name, 0-100. Shared so the insight summaries
   *  report the same numbers the mastery heatmap shows. */
  masteryByStudent: Map<string, Map<string, number>>
  quizIds: { graded: string[]; open: string; draft: string; midterm: string }
  assignmentIds: { graded: string[]; open: string; draft: string }
  gradeSchemeId: string
  projectCategoryId: string
}

/**
 * Three students are pinned rather than random: the demo's named logins have to
 * mean what the guide says they mean. Leaving the "strong student" account to
 * chance put them 9th of 12.
 */
function abilityOf(p: Person, index: number): number {
  const r = rng(`ability-${p.key}`)
  if (index === 0) return 0.90 + r() * 0.08 // the strong-student login
  if (index === 9) return 0.34 + r() * 0.06 // consistently behind
  if (index === 6) return 0.46 + r() * 0.06 // borderline
  return 0.66 + r() * 0.26
}

/**
 * Mastery is not the same measure as a first-attempt quiz score, and mapping it
 * 1:1 from ability put the class average at 74 — inside the roadmap's "shaky"
 * band (weak <60, shaky 60-79, strong 80+, see src/lib/skills/mastery.ts). The
 * professor roadmap then annotated every completed week with "10 of 12 stuck
 * here" while the same nodes read 100% complete.
 *
 * Material already taught and revised should sit higher than the raw score, so
 * the curve lifts the middle of the class into "strong" while leaving the two
 * deliberately-struggling students clearly weak. Without that floor the curve
 * lifts them too, and the at-risk story disappears.
 */
function masteryFromAbility(ability: number): number {
  return ability < 0.6 ? ability * 0.95 : Math.pow(ability, 0.45)
}

/** A score in 0-1 for one attempt: ability plus a little noise, clamped. */
function perform(ability: number, seed: string, spread = 0.14): number {
  const r = rng(seed)
  const v = ability + (r() - 0.5) * 2 * spread
  return Math.min(0.99, Math.max(0.05, v))
}

const pct = (n: number) => Math.round(n * 100)

// ── Question bank ─────────────────────────────────────────────────────

type Q =
  | { key: string; type: 'multiple_choice'; text: string; choices: Array<{ t: string; c: boolean }>; skill: string; explain: string }
  | { key: string; type: 'true_false'; text: string; answer: boolean; skill: string; explain: string }
  | { key: string; type: 'short_answer'; text: string; accepted: string[]; skill: string; explain: string }
  | { key: string; type: 'fill_in_blank'; text: string; blanks: Array<{ id: string; accepted: string[] }>; skill: string; explain: string }

const BANK: Record<string, Q[]> = {
  q1: [
    { key: 'q1a', type: 'multiple_choice', skill: 'Train/Test Splitting',
      text: 'You fit a StandardScaler on the full dataset and then split into train and test. What has gone wrong?',
      choices: [
        { t: 'Nothing — scaling does not use the labels', c: false },
        { t: 'Information about the test set has influenced training', c: true },
        { t: 'The scaler will fail on unseen values', c: false },
        { t: 'The test set is now too small', c: false },
      ],
      explain: 'The scaler learned the mean and variance of the test rows. That statistic is now baked into the training features, so the test score is optimistic.' },
    { key: 'q1b', type: 'true_false', skill: 'Data Leakage', answer: false,
      text: 'A random train/test split is appropriate for a dataset where each row is a daily measurement over three years.',
      explain: 'Random splitting on time series trains on the future to predict the past. Split forward in time instead.' },
    { key: 'q1c', type: 'multiple_choice', skill: 'Problem Framing',
      text: 'Which of these is the strongest reason NOT to use machine learning for a task?',
      choices: [
        { t: 'The dataset has fewer than a million rows', c: false },
        { t: 'The rule is already known and can be written down', c: true },
        { t: 'The team has no GPU', c: false },
        { t: 'The labels are imbalanced', c: false },
      ],
      explain: 'If the rule is known, writing it is cheaper, exact, and reviewable. ML is for rules you cannot state.' },
    { key: 'q1d', type: 'short_answer', skill: 'Train/Test Splitting', accepted: ['validation', 'validation set'],
      text: 'Which split do you use to CHOOSE between candidate models? (one word)',
      explain: 'Validation is for choosing. Test is measured once, at the end, and reported.' },
  ],
  q2: [
    { key: 'q2a', type: 'multiple_choice', skill: 'Bias-Variance Tradeoff',
      text: 'Training error is low and validation error is much higher, and the gap is not closing as you add data. What is this?',
      choices: [
        { t: 'High bias', c: false },
        { t: 'High variance', c: true },
        { t: 'Label noise', c: false },
        { t: 'A broken metric', c: false },
      ],
      explain: 'A persistent gap between training and validation is variance. More data or more regularization is the lever.' },
    { key: 'q2b', type: 'multiple_choice', skill: 'Regularization',
      text: 'Which penalty can drive a coefficient to exactly zero?',
      choices: [
        { t: 'Ridge (L2)', c: false },
        { t: 'Lasso (L1)', c: true },
        { t: 'Neither', c: false },
        { t: 'Both, equally often', c: false },
      ],
      explain: 'The L1 ball has corners on the axes, so the optimum often lands exactly on one. L2 shrinks but never reaches zero.' },
    { key: 'q2c', type: 'true_false', skill: 'Regularization', answer: true,
      text: 'Increasing the regularization strength increases bias and decreases variance.',
      explain: 'That is the trade: a more constrained model is more stable across samples and less able to fit the truth.' },
    { key: 'q2d', type: 'fill_in_blank', skill: 'Bias-Variance Tradeoff',
      text: 'Error decomposes into ____, variance, and irreducible noise.',
      blanks: [{ id: 'b1', accepted: ['bias'] }],
      explain: 'Bias, variance, and irreducible noise. The third one you cannot do anything about.' },
  ],
  q3: [
    { key: 'q3a', type: 'multiple_choice', skill: 'Classification Metrics',
      text: 'A fraud model reaches 99.2% accuracy. Fraud is 0.8% of transactions. What does that tell you?',
      choices: [
        { t: 'The model is excellent', c: false },
        { t: 'Essentially nothing — predicting "no fraud" always scores the same', c: true },
        { t: 'The model is overfit', c: false },
        { t: 'The threshold is too high', c: false },
      ],
      explain: 'At a 0.8% base rate, the always-negative baseline scores 99.2%. Accuracy carries no information here; use precision and recall.' },
    { key: 'q3b', type: 'multiple_choice', skill: 'Classification Metrics',
      text: 'Of the items your model flagged, what fraction were genuinely positive?',
      choices: [
        { t: 'Recall', c: false },
        { t: 'Precision', c: true },
        { t: 'Specificity', c: false },
        { t: 'F1', c: false },
      ],
      explain: 'Precision is conditioned on what you flagged. Recall is conditioned on what was actually positive.' },
    { key: 'q3c', type: 'true_false', skill: 'Class Imbalance', answer: true,
      text: 'Under heavy class imbalance, a precision-recall curve is usually more informative than an ROC curve.',
      explain: 'ROC is flattered by the large pool of easy negatives. PR keeps the focus on the rare positive class.' },
    { key: 'q3d', type: 'short_answer', skill: 'Logistic Regression', accepted: ['sigmoid', 'logistic'],
      text: 'Logistic regression passes a linear score through which function?',
      explain: 'The sigmoid, also called the logistic function, which maps the real line to (0, 1).' },
  ],
  midterm: [
    { key: 'mt-a', type: 'multiple_choice', skill: 'Data Leakage',
      text: 'A churn model uses "days_since_last_login". The field is recomputed nightly and set to 0 when an account closes. What is the problem?',
      choices: [
        { t: 'Nothing — recency is a legitimate feature', c: false },
        { t: 'The feature encodes the outcome, so it will not exist at prediction time', c: true },
        { t: 'The feature needs scaling', c: false },
        { t: 'The feature is collinear with tenure', c: false },
      ],
      explain: 'Setting it to 0 on closure means the feature is partly a copy of the label. At prediction time the account is still open, so the value you trained on cannot occur.' },
    { key: 'mt-b', type: 'multiple_choice', skill: 'Cross-Validation',
      text: 'You tried 300 hyperparameter configurations and report the best cross-validation score. Why is that number optimistic?',
      choices: [
        { t: 'Cross-validation always overestimates', c: false },
        { t: 'Selecting the maximum over many noisy estimates biases it upward', c: true },
        { t: 'The folds were not stratified', c: false },
        { t: 'It is not optimistic', c: false },
      ],
      explain: 'Each fold score carries noise. Taking the maximum over 300 of them selects partly for luck. Nested cross-validation measures the honest number.' },
    { key: 'mt-c', type: 'multiple_choice', skill: 'Decision Trees',
      text: 'What does randomly subsetting features at each split buy a random forest?',
      choices: [
        { t: 'Faster training only', c: false },
        { t: 'Decorrelated trees, so averaging reduces variance more', c: true },
        { t: 'Lower bias per tree', c: false },
        { t: 'Immunity to overfitting', c: false },
      ],
      explain: 'Averaging only helps to the extent the trees make different errors. Feature subsetting is what makes them different.' },
    { key: 'mt-d', type: 'true_false', skill: 'Feature Construction', answer: false,
      text: 'Tree-based models require features to be scaled to a common range.',
      explain: 'Trees split on thresholds within a single feature, so monotone rescaling changes nothing.' },
    { key: 'mt-e', type: 'short_answer', skill: 'Categorical Encoding', accepted: ['one-hot', 'one hot', 'onehot'],
      text: 'Which encoding should you use for an unordered categorical with five levels? (name the encoding)',
      explain: 'One-hot. Assigning integers would tell the model an ordering that does not exist.' },
    { key: 'mt-f', type: 'multiple_choice', skill: 'Pipelines',
      text: 'Why wrap preprocessing and the model in a single pipeline object?',
      choices: [
        { t: 'It runs faster', c: false },
        { t: 'Cross-validation refits preprocessing per fold, so leakage becomes structurally impossible', c: true },
        { t: 'It reduces memory use', c: false },
        { t: 'It is required by scikit-learn', c: false },
      ],
      explain: 'The pipeline turns "remember not to leak" into "cannot leak", which is the only version that survives a deadline.' },
  ],
  q5draft: [
    { key: 'q5a', type: 'multiple_choice', skill: 'Calibration',
      text: 'Your model says 0.7 and is right about 50% of the time in that bucket. What is wrong?',
      choices: [
        { t: 'Accuracy is too low', c: false },
        { t: 'It is poorly calibrated — the number does not mean what it claims', c: true },
        { t: 'The threshold is wrong', c: false },
        { t: 'Nothing; 0.7 is just a ranking', c: false },
      ],
      explain: 'Calibration is whether the stated probability matches the observed frequency. A reliability diagram shows exactly where it drifts, and isotonic regression can correct it after the fact.' },
    { key: 'q5b', type: 'true_false', skill: 'Fairness', answer: false,
      text: 'Demographic parity, equal opportunity, and calibration within groups can generally all be satisfied at once.',
      explain: 'They are mathematically incompatible except in degenerate cases. You have to choose one and justify the choice — there is no technical escape from it.' },
  ],
  q4: [
    { key: 'q4a', type: 'multiple_choice', skill: 'Neural Networks',
      text: 'What does a stack of linear layers with no activation between them compute?',
      choices: [
        { t: 'An arbitrarily complex function', c: false },
        { t: 'A single linear function', c: true },
        { t: 'A piecewise linear function', c: false },
        { t: 'Nothing — it will not train', c: false },
      ],
      explain: 'Composing linear maps gives a linear map. The activation is the entire source of expressiveness.' },
    { key: 'q4b', type: 'true_false', skill: 'Optimization', answer: true,
      text: 'A loss that becomes NaN early in training usually means the learning rate is too high.',
      explain: 'Steps overshoot, activations explode, and the loss diverges. Lower the rate or add warmup.' },
    { key: 'q4c', type: 'short_answer', skill: 'Regularization', accepted: ['dropout'],
      text: 'Which technique randomly deactivates units during training only?',
      explain: 'Dropout. At inference every unit is active, with outputs scaled to compensate.' },
  ],
}

function questionContent(q: Q) {
  switch (q.type) {
    case 'multiple_choice':
      return {
        questionType: 'multiple_choice',
        allowMultiple: false,
        choices: q.choices.map((c, i) => ({ id: det(`${q.key}-choice-${i}`), text: c.t, isCorrect: c.c })),
      }
    case 'true_false':
      return { questionType: 'true_false', correctAnswer: q.answer }
    case 'short_answer':
      return { questionType: 'short_answer', caseSensitive: false, acceptedAnswers: q.accepted }
    case 'fill_in_blank':
      return {
        questionType: 'fill_in_blank',
        blanks: q.blanks.map((b) => ({ id: det(`${q.key}-${b.id}`), caseSensitive: false, acceptedAnswers: b.accepted })),
      }
  }
}

function answerFields(q: Q, correct: boolean): Record<string, unknown> {
  switch (q.type) {
    case 'multiple_choice': {
      const ci = q.choices.findIndex((c) => c.c)
      const wi = q.choices.findIndex((c) => !c.c)
      return { selected_choice_ids: [det(`${q.key}-choice-${correct ? ci : wi}`)] }
    }
    case 'true_false':
      return { boolean_answer: correct ? q.answer : !q.answer }
    case 'short_answer':
      return { text_answer: correct ? q.accepted[0] : 'not sure' }
    case 'fill_in_blank': {
      const blanks: Record<string, string> = {}
      for (const b of q.blanks) blanks[det(`${q.key}-${b.id}`)] = correct ? b.accepted[0] : 'variance'
      return { blank_answers: blanks }
    }
  }
}

// ── Quizzes ───────────────────────────────────────────────────────────

interface QuizDef {
  key: keyof typeof BANK
  title: string
  description: string
  weeksBack: number
  proctored?: boolean
}

async function seedQuizzes(
  campus: Campus,
  ability: Map<string, number>,
  quizAvg: Map<string, number>,
): Promise<Assessments['quizIds']> {
  const main = campus.main
  const prof = main.professor
  const active = main.students

  const past: QuizDef[] = [
    { key: 'q1', title: 'Quiz 1 — Framing and the split', description: 'Weeks 1-2. Ten minutes, one attempt.', weeksBack: 7 },
    { key: 'q2', title: 'Quiz 2 — Regularization and the bias-variance trade', description: 'Weeks 3. Ten minutes, one attempt.', weeksBack: 5 },
    { key: 'q3', title: 'Quiz 3 — Classification metrics', description: 'Week 4. Ten minutes, one attempt.', weeksBack: 3 },
    { key: 'midterm', title: 'Midterm Exam', description: 'Weeks 1-7, in class. Closed book, webcam proctoring on.', weeksBack: 1, proctored: true },
  ]

  const quizRows: Record<string, unknown>[] = []
  const questionRows: Record<string, unknown>[] = []
  const linkRows: Record<string, unknown>[] = []
  const attemptRows: Record<string, unknown>[] = []
  const answerRows: Record<string, unknown>[] = []
  const statRows: Record<string, unknown>[] = []
  const proctoringLogRows: Record<string, unknown>[] = []
  const proctoringSnapshotRows: Record<string, unknown>[] = []
  const abilityRows: Record<string, unknown>[] = []
  // question key -> [correctCount, total], so quiz_item_stats matches the answers.
  const tally = new Map<string, [number, number]>()

  const addQuestions = (qs: Q[], quizId: string) => {
    qs.forEach((q, i) => {
      questionRows.push({
        id: det(q.key),
        section_id: main.id,
        question_text: q.text,
        question_type: q.type,
        content: questionContent(q),
        difficulty: i === 0 ? 'easy' : i < 3 ? 'medium' : 'hard',
        blooms_level: q.type === 'multiple_choice' ? 'analyze' : 'understand',
        tags: [q.skill],
        points: 1,
        explanation: q.explain,
        is_complete: true,
        expected_time_seconds: 75,
      })
      linkRows.push({ id: det(`${q.key}-link`), quiz_id: quizId, question_id: det(q.key), position: i })
    })
  }

  for (const def of past) {
    const quizId = det(`quiz-${def.key}`)
    const qs = BANK[def.key]
    const dueDays = Math.max(1, (WEEKS_IN - (WEEKS_IN - def.weeksBack)) * 0 + def.weeksBack * 7)
    quizRows.push({
      id: quizId,
      section_id: main.id,
      created_by: prof.id,
      title: def.title,
      description: def.description,
      status: 'published',
      time_limit_minutes: def.proctored ? 75 : 10,
      shuffle_questions: true,
      shuffle_answers: true,
      max_attempts: 1,
      pass_threshold: 60,
      due_date: daysAgo(dueDays, 19),
      show_explanations: 'after_due_date',
      show_leaderboard: false,
      proctoring_enabled: def.proctored ?? false,
      video_proctoring_enabled: def.proctored ?? false,
      created_at: daysAgo(dueDays + 5, 10),
    })
    addQuestions(qs, quizId)

    for (const st of active) {
      const a = ability.get(st.key)!
      const score = perform(a, `quiz-${def.key}-${st.key}`)
      // One student misses one quiz outright, which is what "best 4 of 5" is for.
      if (st.key === active[9].key && def.key === 'q2') continue

      const attemptId = det(`attempt-${def.key}-${st.key}`)
      const r = rng(`ans-${def.key}-${st.key}`)
      let earned = 0
      qs.forEach((q) => {
        const correct = r() < score
        if (correct) earned++
        const t = tally.get(q.key) ?? [0, 0]
        tally.set(q.key, [t[0] + (correct ? 1 : 0), t[1] + 1])
        answerRows.push({
          id: det(`answer-${def.key}-${st.key}-${q.key}`),
          attempt_id: attemptId,
          question_id: det(q.key),
          is_correct: correct,
          earned_points: correct ? 1 : 0,
          time_spent_seconds: 40 + Math.floor(r() * 80),
          ...answerFields(q, correct),
        })
      })

      // Comfortably BEFORE the 19:00 deadline. This was hour 20 — one hour after
      // the quiz closed — which badged every attempt by every student "Late",
      // including the top of the class.
      const started = daysAgo(dueDays, def.proctored ? 14 : 16)
      // Pulled out of the summary literal below so the detail rows (events,
      // snapshots) derive from the exact numbers the summary claims, instead
      // of rolling a second, possibly-disagreeing set — CONTEXT.md's "derive,
      // do not roll" rule.
      const tabSwitchCount = st.key === active[6].key ? 14 : Math.floor(r() * 3)
      const totalKeystrokes = 120 + Math.floor(r() * 200)
      attemptRows.push({
        id: attemptId,
        quiz_id: quizId,
        student_id: st.id,
        section_id: main.id,
        mode: 'graded',
        status: 'submitted',
        // `score` is a PERCENTAGE 0-100, not points — see the type in
        // src/lib/quiz/scoring.ts and gradeAttempt()'s clamp. Writing raw points
        // here made every quiz screen in the tenant read 1-6% and badge the whole
        // class "Fail", directly above the correct per-question numbers.
        score: pct(earned / qs.length),
        total_points: qs.length,
        earned_points: earned,
        started_at: started,
        submitted_at: new Date(new Date(started).getTime() + (def.proctored ? 62 : 8) * 60_000).toISOString(),
        time_spent_seconds: (def.proctored ? 62 : 8) * 60,
        proctoring_summary: def.proctored
          ? {
              // Every event this tenant logs is a tab-switch/blur (see the events
              // array built below), so eventCount IS tabSwitchCount — rolling it
              // separately (found by red-team audit) violated the same
              // derive-don't-roll rule the comment above this block states.
              eventCount: tabSwitchCount,
              tabSwitchCount,
              copyCount: 0,
              pasteCount: 0,
              cutCount: 0,
              webcamDenied: false,
              snapshotCount: 6,
              totalKeystrokes,
              suspiciousFlags: st.key === active[6].key ? ['frequent_tab_switches'] : [],
              firstEventAt: started,
              lastEventAt: new Date(new Date(started).getTime() + 60 * 60_000).toISOString(),
            }
          : null,
      })

      // Every proctored attempt's summary above claims real detail behind it
      // (a tab-switch count, 6 snapshots) — without matching rows here, only
      // whichever student happens to be checked gets a populated drill-down
      // and everyone else's Event Timeline/Violation Snapshots read empty.
      if (def.proctored) {
        const startMs = new Date(started).getTime()
        // Shape must match proctoringEventSchema (src/lib/validations/proctoring.ts):
        // compact keys only (t = ms offset, type = short code) — the timeline reads
        // event.t directly, so any other field name renders as "NaN:NaN".
        const events = Array.from({ length: tabSwitchCount }, (_, i) => ({
          t: Math.floor((i + 1) * ((62 * 60_000) / (tabSwitchCount + 1))),
          type: 'bl' as const,
          qi: i % qs.length,
        }))
        proctoringLogRows.push({
          id: det(`proctor-log-${def.key}-${st.key}`),
          attempt_id: attemptId,
          student_id: st.id,
          quiz_id: quizId,
          section_id: main.id,
          batch_index: 0,
          events,
          keystroke_count: totalKeystrokes,
          created_at: started,
        })

        // Snapshots are periodic risk-monitoring captures, unrelated to tab
        // switching — every attempt's summary claims the same snapshotCount: 6,
        // so every attempt gets 6 real rows regardless of that student's own
        // tab-switch count.
        for (let i = 0; i < 6; i++) {
          const offsetMs = Math.floor((i + 1) * ((62 * 60_000) / 7))
          const path = `${main.id}/${quizId}/${attemptId}/${offsetMs}.jpg`
          const violation = i % 2 === 0 ? 'mf' : 'ph'
          try {
            const label = violation === 'mf' ? 'Multiple Faces' : 'Phone Detected'
            await upload('proctoring-snapshots', path, await placeholderSnapshotJpeg(label), 'image/jpeg')
            proctoringSnapshotRows.push({
              id: det(`proctor-snap-${def.key}-${st.key}-${i}`),
              attempt_id: attemptId,
              student_id: st.id,
              quiz_id: quizId,
              section_id: main.id,
              violation_type: violation,
              storage_path: path,
              snapshot_url: await signedUrl('proctoring-snapshots', path),
              timestamp_offset: offsetMs,
              question_index: i % qs.length,
              face_count: violation === 'mf' ? 2 : 1,
              created_at: new Date(startMs + offsetMs).toISOString(),
            })
          } catch (err) {
            warn(`proctoring snapshot upload failed for ${st.key} (${(err as Error).message})`)
          }
        }
      }
    }
  }

  // A quiz that is open right now, with about half the class already through it.
  const openId = det('quiz-open')
  const quiz4DueDate = daysAgo(-4, 19)
  quizRows.push({
    id: openId,
    section_id: main.id,
    created_by: prof.id,
    title: 'Quiz 4 — Neural network training',
    // Named from due_date below, not a fixed day — see weekdayName's own comment.
    description: `Weeks 9-10. Open until ${weekdayName(quiz4DueDate)}, ten minutes once you start.`,
    status: 'published',
    time_limit_minutes: 10,
    shuffle_questions: true,
    shuffle_answers: true,
    max_attempts: 1,
    pass_threshold: 60,
    due_date: quiz4DueDate,
    show_explanations: 'after_due_date',
    created_at: daysAgo(3, 9),
  })
  addQuestions(BANK.q4, openId)
  active.forEach((st, i) => {
    if (i % 2 === 1) return // half have not started it
    const a = ability.get(st.key)!
    const score = perform(a, `quiz-open-${st.key}`)
    const attemptId = det(`attempt-open-${st.key}`)
    const r = rng(`ans-open-${st.key}`)
    // One attempt is still in progress, which is what an open quiz looks like.
    const inProgress = i === 4
    let earned = 0
    BANK.q4.forEach((q, qi) => {
      if (inProgress && qi > 0) return
      const correct = r() < score
      if (correct) earned++
      const t = tally.get(q.key) ?? [0, 0]
      tally.set(q.key, [t[0] + (correct ? 1 : 0), t[1] + 1])
      answerRows.push({
        id: det(`answer-open-${st.key}-${q.key}`),
        attempt_id: attemptId,
        question_id: det(q.key),
        is_correct: correct,
        earned_points: correct ? 1 : 0,
        time_spent_seconds: 45,
        ...answerFields(q, correct),
      })
    })
    attemptRows.push({
      id: attemptId,
      quiz_id: openId,
      student_id: st.id,
      section_id: main.id,
      mode: 'graded',
      status: inProgress ? 'in_progress' : 'submitted',
      score: inProgress ? null : pct(earned / BANK.q4.length),
      total_points: BANK.q4.length,
      earned_points: inProgress ? null : earned,
      started_at: daysAgo(inProgress ? 0 : 1, 19),
      submitted_at: inProgress ? null : daysAgo(1, 19),
      time_spent_seconds: inProgress ? 180 : 470,
    })
  })

  // A draft the professor is still writing.
  const draftId = det('quiz-draft')
  quizRows.push({
    id: draftId,
    section_id: main.id,
    created_by: prof.id,
    title: 'Quiz 5 — Evaluation and fairness (draft)',
    description: 'Not published yet. Two questions drafted, two more to write.',
    status: 'draft',
    time_limit_minutes: 10,
    max_attempts: 1,
    created_at: daysAgo(1, 16),
  })

  // A draft with real questions in it: the description says two are drafted, and
  // "0 questions" beside that wording reads as broken rather than unfinished.
  addQuestions(BANK.q5draft, draftId)

  await up('quizzes', quizRows)
  await up('quiz_questions', questionRows)
  await up('quiz_question_assignments', linkRows)
  await up('quiz_attempts', attemptRows)
  await up('quiz_answers', answerRows)
  await up('quiz_proctoring_logs', proctoringLogRows)
  await up('proctoring_snapshots', proctoringSnapshotRows)

  // Item statistics computed from the answers just written, so the item-analysis
  // view and the attempt rows cannot disagree.
  for (const def of [...past, { key: 'q4' as const, title: '', description: '', weeksBack: 0 }]) {
    const quizId = def.key === 'q4' ? openId : det(`quiz-${def.key}`)
    for (const q of BANK[def.key]) {
      const [correct, total] = tally.get(q.key) ?? [0, 0]
      if (total === 0) continue
      const difficulty = correct / total
      statRows.push({
        quiz_id: quizId,
        question_id: det(q.key),
        section_id: main.id,
        difficulty: Number(difficulty.toFixed(3)),
        // Point-biserial style: harder items separate the class more.
        discrimination: Number((0.18 + (1 - Math.abs(difficulty - 0.5) * 2) * 0.42).toFixed(3)),
        n_attempts: total,
        computed_at: daysAgo(1),
      })
    }
  }
  await up('quiz_item_stats', statRows, 'quiz_id,question_id')

  // Quiz average per student, straight off the attempts just written.
  for (const st of active) {
    const mine = attemptRows.filter((x) => x.student_id === st.id && x.earned_points != null)
    const earned = mine.reduce((n, x) => n + (x.earned_points as number), 0)
    const possible = mine.reduce((n, x) => n + (x.total_points as number), 0)
    quizAvg.set(st.key, possible > 0 ? Math.round((earned / possible) * 100) : 0)
  }

  for (const st of active) {
    const a = ability.get(st.key)!
    abilityRows.push({
      id: det(`student-ability-${st.key}`),
      student_id: st.id,
      section_id: main.id,
      theta: Number(((a - 0.5) * 3).toFixed(3)),
      se: Number((0.62 - a * 0.25).toFixed(3)),
      attempts: past.length,
      updated_at: daysAgo(1),
    })
  }
  await up('student_ability', abilityRows)

  ok(
    `${quizRows.length} quizzes, ${questionRows.length} questions, ${attemptRows.length} attempts, ` +
      `${answerRows.length} answers, ${statRows.length} item stats`,
  )
  return {
    graded: past.filter((d) => d.key !== 'midterm').map((d) => det(`quiz-${d.key}`)),
    midterm: det('quiz-midterm'),
    open: openId,
    draft: draftId,
  }
}

// ── Assignments ───────────────────────────────────────────────────────

/** Named so a homework can never be added without its write-up: WRITEUPS is
 *  keyed by this union, so a missing entry is a compile error rather than an
 *  undefined at upload time. */
type HwKey = 'hw1' | 'hw2' | 'hw3' | 'hw4'

interface HwDef {
  key: HwKey
  title: string
  guidelines: string
  weeksBack: number
  points: number
  type: 'written' | 'files' | 'link' | 'code'
  week: number
  rubric: Array<{ label: string; points: number; criteria: Array<{ points: number; description: string }> }>
}

const HOMEWORK: HwDef[] = [
  {
    key: 'hw1', title: 'Homework 1 — Framing and the split', weeksBack: 7, points: 20, type: 'files', week: 2,
    guidelines:
      'Take the provided customer dataset. State the decision a model would support, build a defensible train/validation/test split, and fit a baseline. Submit one notebook that runs top to bottom on a fresh kernel.',
    rubric: [
      { label: 'Problem framing', points: 6, criteria: [
        { points: 3, description: 'States the decision the model supports, not just the target column' },
        { points: 3, description: 'Names who is affected by a wrong prediction in each direction' },
      ] },
      { label: 'Split discipline', points: 8, criteria: [
        { points: 4, description: 'Split is constructed before any statistic is computed' },
        { points: 4, description: 'Justifies random vs temporal splitting for this dataset' },
      ] },
      { label: 'Baseline', points: 6, criteria: [
        { points: 3, description: 'Baseline is genuinely simple and correctly evaluated' },
        { points: 3, description: 'Reports the base rate alongside the score' },
      ] },
    ],
  },
  {
    key: 'hw2', title: 'Homework 2 — Regularized linear models', weeksBack: 5, points: 25, type: 'files', week: 3,
    guidelines:
      'Fit ordinary least squares, ridge, and lasso on the housing dataset. Select lambda by cross-validation and report the full validation curve, not just the winning value.',
    rubric: [
      { label: 'Implementation', points: 10, criteria: [
        { points: 5, description: 'All three models fit inside a pipeline' },
        { points: 5, description: 'Lambda selected by cross-validation, not by eye' },
      ] },
      { label: 'Interpretation', points: 10, criteria: [
        { points: 5, description: 'Explains which coefficients lasso zeroed and why that is plausible' },
        { points: 5, description: 'Connects the result to the bias-variance trade' },
      ] },
      { label: 'Reporting', points: 5, criteria: [
        { points: 5, description: 'Validation curve is plotted and readable' },
      ] },
    ],
  },
  {
    key: 'hw3', title: 'Homework 3 — Classification and thresholds', weeksBack: 3, points: 25, type: 'files', week: 4,
    guidelines:
      'Build a classifier on the imbalanced transactions dataset. Choose an operating threshold from an explicit cost assumption and defend it.',
    rubric: [
      { label: 'Metric choice', points: 10, criteria: [
        { points: 5, description: 'Chooses a metric justified by the cost of each error type' },
        { points: 5, description: 'Does not report bare accuracy as the headline' },
      ] },
      { label: 'Threshold', points: 10, criteria: [
        { points: 5, description: 'States the cost assumption explicitly' },
        { points: 5, description: 'Shows the metric as a function of the threshold' },
      ] },
      { label: 'Write-up', points: 5, criteria: [
        { points: 5, description: 'A non-technical reader could follow the recommendation' },
      ] },
    ],
  },
  {
    // Deliberately NOT 'code': ProfessorAssignmentGrader renders answers/files/text
    // and never reads `code_content`, so a code submission shows the grader
    // "Empty submission." The app bug is logged; the demo does not walk into it.
    key: 'hw4', title: 'Homework 4 — Trees and ensembles', weeksBack: 1, points: 25, type: 'files', week: 5,
    guidelines:
      'Implement a decision tree from scratch, then compare it against a random forest and a boosted tree from a library. Explain the gap.',
    rubric: [
      { label: 'From-scratch tree', points: 12, criteria: [
        { points: 6, description: 'Splitting criterion implemented correctly' },
        { points: 6, description: 'Handles a stopping condition and does not recurse forever' },
      ] },
      { label: 'Comparison', points: 8, criteria: [
        { points: 4, description: 'Compares on the same split with the same metric' },
        { points: 4, description: 'Explains the gap in terms of variance, not "the library is better"' },
      ] },
      { label: 'Code quality', points: 5, criteria: [
        { points: 5, description: 'Runs unmodified and finishes in under five minutes' },
      ] },
    ],
  },
]

// ── Submission write-ups ──────────────────────────────────────────────
//
// The attached PDF used to be a single line: `{ heading: 'Approach', body:
// <one sentence> }`, and that same sentence was also the submission's
// text_content. So the grader opened a submission and read the identical
// sentence twice — once in the written-response box and once in an almost
// empty PDF pane. It was the most obviously fabricated screen in the tenant.
//
// The fix follows the seed's own derive-don't-roll rule, one level deeper
// than scores. A write-up section is keyed by the SAME `${qi}:${ci}` string
// the rubric tick list uses, and the PDF renders `earned` for a criterion the
// student actually got and `thin` for one they missed. So a student whose
// rubric shows "Reports the base rate alongside the score" unticked has a
// results section that genuinely never mentions the base rate. The document
// and the rubric panel beside it cannot disagree, because they are the same
// decision rendered twice.
//
// `thin` is deliberately a weaker attempt rather than an omission: students
// who lose a rubric point usually wrote something, just not enough. A missing
// section reads as a truncated file; a hand-wavy paragraph reads as a student.

interface CriterionWriteup {
  heading: string
  /** Rendered when the student earned this criterion. */
  earned: string
  /** Rendered when they did not — same topic, visibly less work behind it. */
  thin: string
  /** The grader's note when it was missed, shown on the rubric card. */
  note: string
}

interface Writeup {
  /** Cover notes for text_content — what a student types in the box when the
   *  real work is the attachment. Indexed per student so the roster varies. */
  covers: string[]
  intro: string
  /** Keyed `${rubricGroupIndex}:${criterionIndex}`. */
  criteria: Record<string, CriterionWriteup>
  closing: string
}

const WRITEUPS: Record<HwKey | 'hw5', Writeup> = {
  hw1: {
    covers: [
      'Notebook runs top to bottom on a fresh kernel. Framing is in section 1, the split in section 2, and the baseline comparison in section 3.',
      'Attached the notebook and a short write-up. I reported the base rate next to every score, as the guidelines ask.',
      'Went with a temporal split rather than random — the reasoning is in the first markdown cell, before any of the numbers.',
      'Write-up attached. I led with the decision the model supports rather than the target column, which changed how I picked the baseline.',
      'Ran out of time to tidy the plots in section 3, but the framing, the split and the baseline are all there and all run.',
      'Notebook attached. I compared against two baselines because the majority-class one felt too easy to beat.',
    ],
    intro:
      'The dataset is a year of customer records with a churn flag. Rather than start from the flag, I started from the decision it supports: which accounts the retention team should call this month, given they can only reach a few hundred. That framing decided everything downstream, including which errors I care about and which baseline is worth beating.',
    criteria: {
      '0:0': {
        heading: 'The decision this model supports',
        earned:
          'The model exists to rank accounts for a retention call, not to label customers as churners. That distinction matters because the team acts on a ranked list with a fixed capacity, so what I actually need is good ordering at the top of the list rather than a calibrated probability for every account. I state the capacity constraint explicitly in the notebook and carry it through to how I evaluate.',
        thin:
          'The task is to predict the churn column. I treat it as a binary classification problem and report how often the prediction matches the label.',
        note: 'Name the decision the model supports, not the column it predicts — the two lead to different evaluations.',
      },
      '0:1': {
        heading: 'Who a wrong prediction lands on',
        earned:
          'A false positive costs a retention call to someone who was never going to leave: a few minutes of an agent, a small discount, and mild annoyance for the customer. A false negative is a customer who leaves without ever being contacted, which costs the remaining contract value and cannot be recovered once they have gone. The two are not symmetric, and that asymmetry is why I do not optimise plain accuracy.',
        thin:
          'Getting it wrong in either direction is bad for the business. I aim to reduce total errors.',
        note: 'Say who absorbs each kind of error. "Bad for the business" does not distinguish a wasted call from a lost customer.',
      },
      '1:0': {
        heading: 'Constructing the split',
        earned:
          'I built the split as the first operation after loading, before computing a single summary statistic. Nothing about the test set informs any choice in the notebook: the scaler, the imputation values and the threshold are all fit inside the training fold and applied outward. I checked this by rerunning with the test set replaced by noise, and every reported training number was unchanged.',
        thin:
          'I looked at the distributions first to understand the data, then split it 70/15/15. The split is in the second cell.',
        note: 'Summary statistics computed before the split leak the test set into your choices. Split first, then look.',
      },
      '1:1': {
        heading: 'Random or temporal',
        earned:
          'I used a temporal split, training on the first nine months and testing on the last three. A random split would let the model learn from accounts in a month it is then scored on, and because churn here is seasonal that inflates the result. In deployment the model always predicts forward, so the evaluation should match that. I ran both to quantify it: the random split scored 0.08 AUC higher, and that gap is the leak rather than skill.',
        thin:
          'I used a random 70/15/15 split with a fixed seed so the results are reproducible.',
        note: 'A random split on time-ordered data trains on the future. Run both and the gap tells you what it cost.',
      },
      '2:0': {
        heading: 'The baseline',
        earned:
          'The baseline is a single rule: rank by days since last purchase, most recent last. No fitting, no features beyond one column. It is evaluated on exactly the same test fold and the same metric as the model, which is the only way the comparison means anything. Logistic regression beats it, but by less than I expected, and the write-up says so.',
        thin:
          'I used a logistic regression as the baseline and then fit a gradient boosting model on top of it to see the improvement.',
        note: 'A fitted model is not a baseline. Use something a spreadsheet could do, or you have nothing to measure against.',
      },
      '2:1': {
        heading: 'Base rate',
        earned:
          'Churn runs at 11.4% in the test window, so predicting "nobody leaves" is already 88.6% accurate. I report that number next to every score in the notebook, because without it a reader sees 89% accuracy and concludes the model works when it has in fact learned nothing. Precision at the top hundred ranked accounts is the number I would actually defend.',
        thin:
          'The model reaches 89% accuracy on the held-out set, which is a solid result for this dataset.',
        note: 'Report the base rate beside the score. 89% accuracy on an 11% base rate is the majority class, not a model.',
      },
    },
    closing:
      'If I had another week I would spend it on the cost assumption rather than the model. The ranking is only as good as the capacity number it assumes, and I took that as given rather than asking whether it is stable month to month.',
  },

  hw2: {
    covers: [
      'Attached the notebook and the validation curves. All three models are in one pipeline and lambda is picked inside the cross-validation loop, not by eye.',
      'Write-up attached. I plotted the validation curve for every lambda I tried, not just the one that won.',
      'Notebook runs clean on a fresh kernel. The coefficient discussion is in section 3 and the bias-variance argument in section 4.',
      'Submitted the notebook plus a short write-up. The lasso path plot is the one worth looking at first.',
      'Ran out of time to tidy section 4, but the fits, the selection and the curves are all there and reproducible.',
      'Attached. I scaled inside the pipeline after getting nonsense from lasso the first time — noted in section 2.',
    ],
    intro:
      'Three models on the housing data: ordinary least squares, ridge, and lasso. The interesting part is not which one wins, it is what the coefficient paths say about the features once the penalty starts biting. I fit everything inside one pipeline so the scaling cannot leak across folds, which mattered more than I expected for lasso.',
    criteria: {
      '0:0': {
        heading: 'Pipeline construction',
        earned:
          'All three models sit inside a single pipeline: impute, then standardise, then fit. The scaler is refit inside every cross-validation fold rather than once on the full frame. This is not a style preference for lasso specifically — the penalty is applied to coefficients in scaled units, so a scaler fit on data that includes the validation fold quietly changes which features get zeroed.',
        thin:
          'I standardised the features and then fit the three models on the scaled data. The transformations are in the cell above the fitting code.',
        note: 'Scaling outside the pipeline fits on the validation fold too. Put the scaler inside so it refits per fold.',
      },
      '0:1': {
        heading: 'Selecting lambda',
        earned:
          'Lambda is chosen by five-fold cross-validation over a log-spaced grid of forty values, scored on validation RMSE. I did not pick the visual elbow. The selected value for lasso is 0.043, and the curve is flat enough either side of it that I would not defend the third decimal place — which is itself worth saying, because it means the exact lambda matters less than the order of magnitude.',
        thin:
          'I tried several values of lambda and chose the one that gave the best score on the validation set. It is around 0.05.',
        note: 'Selecting on a single validation split, or by eye off the curve, is not cross-validation. Show the folds.',
      },
      '1:0': {
        heading: 'What lasso zeroed',
        earned:
          'At the selected lambda, lasso zeroes eleven of the thirty-four coefficients. Most of them are plausible: three are near-duplicates of features it kept, two are almost constant across the sample, and four are the one-hot tail of a category where nearly every row falls in one level. The one I did not expect was year built, which ridge keeps with a real coefficient. Looking at the correlation matrix, it is largely absorbed by neighbourhood, and lasso picks one of the pair rather than splitting the weight.',
        thin:
          'Lasso set several coefficients to zero, which is expected because the L1 penalty encourages sparsity. The remaining features are the important ones.',
        note: 'Name the coefficients it zeroed and say why each is plausible. "L1 encourages sparsity" restates the method.',
      },
      '1:1': {
        heading: 'Where this sits on the bias-variance trade',
        earned:
          'Ordinary least squares has the lowest training error and the highest test error, which is the trade in its plainest form. Increasing lambda raises training error monotonically while test error falls and then rises, and the minimum is the point where the variance saved exceeds the bias introduced. What convinced me was the fold-to-fold spread rather than the mean: at low lambda the five folds disagree by roughly 12% of RMSE, and at the selected lambda they disagree by 4%. That collapse in spread is the variance reduction made visible.',
        thin:
          'Regularization trades a little bias for less variance, which is why the regularized models generalise better than ordinary least squares here.',
        note: 'Ground this in your own numbers — the fold-to-fold spread in your results shows the trade directly.',
      },
      '2:0': {
        heading: 'The validation curve',
        earned:
          'The curve plots training and validation RMSE against lambda on a log x-axis, with the five folds drawn as a shaded band rather than collapsed to a mean, and the selected lambda marked. Both models are on the same axes so the comparison is readable in one look. The band is the part that carries the argument, so hiding it behind an average would have thrown away the finding.',
        thin:
          'The validation curve is plotted at the end of section 3. The best lambda is where the line is lowest.',
        note: 'Plot the folds, not just their mean, and mark the selected lambda. The spread is the interesting part.',
      },
    },
    closing:
      'The thing I would chase next is the correlation structure. Lasso is choosing between near-duplicate features somewhat arbitrarily, and elastic net would probably keep both at lower weight, which is more honest about what the data can actually tell apart.',
  },

  hw3: {
    covers: [
      'Notebook and write-up attached. The cost assumption is stated at the top of section 2 and everything downstream follows from it.',
      'Attached. I led with the recommendation in plain language and pushed the modelling detail into the appendix.',
      'Write-up attached. The threshold sweep is the plot to look at — the operating point is marked on it.',
      'Submitted the notebook plus a one-page summary. I avoided quoting accuracy anywhere, for reasons the write-up explains.',
      'Ran out of time on the appendix, but the metric argument, the threshold sweep and the recommendation are complete.',
      'Attached. I checked the class balance before picking a metric, which changed what I reported.',
    ],
    intro:
      'The transactions data is heavily imbalanced: 0.7% of rows are fraudulent. That single number decides most of the assignment, because it rules out accuracy as a headline and forces a threshold to be chosen against an explicit cost rather than left at the default 0.5.',
    criteria: {
      '0:0': {
        heading: 'Choosing a metric',
        earned:
          'I report precision and recall at the chosen operating point, with average precision as the single summary number. Average precision is the right summary here because it integrates over thresholds without being flattered by the enormous negative class the way ROC AUC is. I show both, and the gap between them is instructive: ROC AUC is 0.97 and average precision is 0.61, and the second number is the honest one.',
        thin:
          'I used ROC AUC as the main metric since it is standard for binary classification and does not depend on the threshold.',
        note: 'ROC AUC flatters a 0.7% positive rate. Show average precision beside it and the gap makes the point for you.',
      },
      '0:1': {
        heading: 'Not leading with accuracy',
        earned:
          'Accuracy appears nowhere in the summary. Predicting "never fraud" scores 99.3% here, so quoting accuracy would describe a model that catches nothing as a near-perfect one. Where a reader might expect it, I give the confusion matrix in counts instead, which makes both error types visible at the scale they actually occur.',
        thin:
          'The model reaches 99.4% accuracy, and I also report precision and recall further down for completeness.',
        note: 'A 99.3% base rate makes accuracy meaningless here. Leading with it undersells a model that is genuinely working.',
      },
      '1:0': {
        heading: 'The cost assumption',
        earned:
          'I assume a missed fraud costs about fifteen times a false alarm: the fraud loses the transaction value plus the chargeback fee, the false alarm costs a review analyst a couple of minutes. I put the number in the notebook as a named constant rather than burying it in an argument, so a reader who disagrees can change one line and rerun. The whole threshold choice hangs off it, and I say so explicitly.',
        thin:
          'Missing fraud is worse than a false alarm, so I shifted the threshold down from 0.5 to catch more of the positive class.',
        note: 'Put a number on it. "Worse" cannot pick a threshold; a 15:1 ratio can, and a reader can then argue with the 15.',
      },
      '1:1': {
        heading: 'Metric against threshold',
        earned:
          'I sweep the threshold from 0 to 1 and plot precision, recall and expected cost under the stated ratio, all on one axis with the chosen point marked. Expected cost has a visible minimum at 0.23, which is where I operate. The curve is fairly flat between 0.18 and 0.30, so I note that the exact value is not load-bearing and that anywhere in that band is defensible.',
        thin:
          'I tried a few thresholds and settled on 0.3, which gave a reasonable balance between precision and recall.',
        note: 'Sweep it and plot it. Trying three values cannot show you whether the minimum is sharp or flat.',
      },
      '2:0': {
        heading: 'Recommendation',
        earned:
          'In plain terms: flag about one transaction in four hundred for human review. That catches roughly seven in ten of the fraud by value, and about a third of what gets flagged turns out to be genuine fraud, so reviewers are not wading through noise. If the review team can absorb more volume, the threshold can drop and recall rises; the plot in section 3 shows exactly what that trade buys at each level. No model term is needed to follow any of this.',
        thin:
          'We recommend using a threshold of 0.3 on the predicted probability, which gives the best F1 score on the held-out test set.',
        note: 'Write the recommendation for the person who acts on it. An F1 number does not tell a review manager what to do.',
      },
    },
    closing:
      'The weakest part is that I treat the cost ratio as fixed across all transaction sizes, which is obviously wrong: a missed fraud on a large transaction is worth far more than on a small one. A value-weighted cost would change the threshold and probably sharpen the minimum.',
  },

  hw4: {
    covers: [
      'Notebook attached. The from-scratch tree is in section 1, the library comparison in section 3, and the variance argument in section 4.',
      'Attached the notebook and a short write-up. All three models are evaluated on the same split with the same metric.',
      'Write-up attached. My tree agrees with the library implementation to within rounding on the same data, which is in the test cell.',
      'Submitted the notebook plus the write-up. Section 4 is the one that took the longest — explaining the gap rather than just reporting it.',
      'Ran out of time to tidy section 4, but the tree, the comparison and the timings are all there and it runs clean.',
      'Attached. The whole notebook finishes in about ninety seconds on my machine; the timing cell is at the bottom.',
    ],
    intro:
      'A decision tree written from scratch, then the same data through a random forest and a gradient boosted tree from scikit-learn. The point of the exercise is the gap between the first and the other two, so most of the write-up is about explaining that rather than about the implementation.',
    criteria: {
      '0:0': {
        heading: 'Splitting criterion',
        earned:
          'I split on Gini impurity, evaluating every candidate threshold as the midpoint between consecutive sorted values of each feature. Sorting once per feature per node and sweeping the class counts incrementally takes the split search from quadratic to linearithmic in the node size, which is what makes the from-scratch version finish at all. I verified the criterion against scikit-learn on a small frame: the two pick the same root split and the same first two levels.',
        thin:
          'I implemented the splitting using Gini impurity, computing it for each feature and choosing the best split at each node.',
        note: 'Say how you searched the thresholds and how you know the criterion is right. A sanity check against the library is one line.',
      },
      '0:1': {
        heading: 'Stopping and recursion',
        earned:
          'Recursion stops on any of four conditions: maximum depth reached, fewer than the minimum samples to split, the node is pure, or no candidate split reduces impurity. The last one matters and is the one I originally missed — with duplicate rows carrying different labels, no split separates them, and without that check the recursion builds an infinite chain of single-child nodes. I have a test for the duplicate-row case in the notebook.',
        thin:
          'I stop splitting when the maximum depth is reached or the node is pure, which keeps the tree from growing indefinitely.',
        note: 'Depth and purity alone do not terminate on duplicate rows with conflicting labels. Add a no-useful-split condition.',
      },
      '1:0': {
        heading: 'Comparing fairly',
        earned:
          'All three models train on the same training fold, are scored on the same held-out test fold, and are compared on macro F1. I did not retune the split or the metric between models. The library models keep their defaults apart from the tree depth, which I pinned to the same value as my own so the comparison is about the ensemble rather than about capacity.',
        thin:
          'I compared my tree against the random forest and the boosted tree and reported the accuracy each one achieved.',
        note: 'State that the split and the metric were held fixed. Otherwise the gap could be either the model or the setup.',
      },
      '1:1': {
        heading: 'Explaining the gap',
        earned:
          'My single tree gets 0.71 macro F1, the forest 0.83, the boosted tree 0.85. The forest gap is variance: a single deep tree fits the noise in its particular training sample, and averaging many trees grown on bootstrap samples with random feature subsets cancels most of that without adding bias. I can show it rather than assert it — refitting my tree on ten bootstrap resamples gives predictions that disagree with each other on 19% of test rows, and averaging those ten alone recovers most of the forest gap. Boosting gains the remaining amount differently, by fitting successive trees to the residual, which reduces bias rather than variance.',
        thin:
          'The library models perform better, which is expected since ensembles generally outperform a single decision tree on most datasets.',
        note: 'Demonstrate the variance rather than naming it — refit on resamples and measure how much the predictions disagree.',
      },
      '2:0': {
        heading: 'Running it',
        earned:
          'The notebook runs top to bottom on a fresh kernel in 94 seconds, timed in the last cell. Every random operation takes an explicit seed, so the numbers quoted in this write-up are the ones it prints. There are no absolute paths and no cells that depend on having run an earlier version of the notebook.',
        thin:
          'The notebook runs, though the from-scratch tree takes a while on the full dataset so I subsampled for that section.',
        note: 'Seed the random operations and time the full run. A notebook whose numbers move between runs cannot be checked.',
      },
    },
    closing:
      'What I would do differently is build the bootstrap-variance measurement first instead of last. I spent most of my time on the from-scratch tree and arrived at the actual question — why the ensemble wins — with the least time left, which is backwards.',
  },

  hw5: {
    covers: [
      'Two-layer network, cosine schedule, early stopping at epoch 31. The diagnosis and the fix are both in section 3.',
      'Learning curve showed a gap that never closed, so I read it as variance and added dropout. Before and after are both plotted.',
      'Both curves were high and flat, which is bias, so I widened the layers rather than gathering more data. Section 4 has the comparison.',
      'First run diverged — the learning rate was far too high. Warmup fixed it. I left the failed run in as evidence.',
      'Trained on CPU so I kept the network small. The diagnosis still holds and I explain why in the last section.',
    ],
    intro:
      'A two-layer fully connected network trained end to end on the provided dataset. The assignment is really about reading the learning curve rather than about reaching a particular number, so the write-up spends most of its length on what the curve said and what I did about it.',
    criteria: {
      '0:0': {
        heading: 'Training stability',
        earned:
          'The final run trains without divergence and reproduces: same seed, same hardware, same loss to four decimal places across three runs. Gradient norms stay under 5 throughout after I added clipping, where the first attempt had them spiking past 300 in the second epoch. The loss curve is smooth apart from the expected step at each schedule change.',
        thin:
          'The network trains and the loss goes down. There is some noise between runs but the final accuracy is around the same place each time.',
        note: 'Pin the seed and report the run-to-run spread. "Around the same place" is not reproducibility.',
      },
      '0:1': {
        heading: 'Learning rate',
        earned:
          'I ran a short range test, sweeping the learning rate from 1e-6 to 1e-1 over a few hundred steps and taking the point about an order of magnitude below where the loss turned up. That gave 3e-4, with 500 steps of linear warmup and then cosine decay. The warmup is not decoration: without it the first run diverged within twenty steps, and that failed run is still in the notebook as evidence.',
        thin:
          'I used a learning rate of 1e-3, which is a common default for Adam and worked reasonably well here.',
        note: 'A default is not a justification. A range test takes a few minutes and gives you a number you can defend.',
      },
      '1:0': {
        heading: 'Reading the learning curve',
        earned:
          'Training and validation loss are plotted per epoch on the same axes. Training loss falls steadily to 0.21 while validation loss bottoms out at 0.48 around epoch 30 and then climbs. A gap that widens while training loss keeps falling is variance, not bias: the capacity is sufficient and the model is fitting sample-specific noise. The alternative reading, that both are high and flat, would have meant the opposite action, so I checked the absolute level as well as the gap before deciding.',
        thin:
          'The learning curve is plotted in section 2. Validation loss stops improving after about thirty epochs, so I stopped training there.',
        note: 'Say which of bias or variance the curve shows and why. Stopping early is the action, not the diagnosis.',
      },
      '1:1': {
        heading: 'Acting on the diagnosis',
        earned:
          'Because the diagnosis was variance, I added regularisation rather than capacity: dropout at 0.3 on both hidden layers, weight decay at 1e-4, and early stopping on validation loss with a patience of five. Validation loss drops from 0.48 to 0.39 and the gap narrows by roughly half. I deliberately did not widen the layers, which would have been the fix for the opposite diagnosis and would have made this worse.',
        thin:
          'I added dropout and trained for fewer epochs, and also made the network a bit wider to help it learn more.',
        note: 'Widening adds capacity, which is the fix for bias. Applying both fixes means the curve never told you anything.',
      },
      '2:0': {
        heading: 'Before and after',
        earned:
          'Section 4 has both runs on the same axes: the original overfitting curve and the regularised one, with the best validation epoch marked on each. The diverged first attempt is in an appendix cell with its learning rate labelled, because the failure is the clearest evidence for why the range test was worth running.',
        thin:
          'The final learning curve is plotted at the end. The earlier runs were overwritten while I was iterating.',
        note: 'Keep the before run. A single after-curve cannot show that the change you made is what improved it.',
      },
    },
    closing:
      'The obvious next step is that I tuned dropout and weight decay by hand, two values at a time, which is not a search. A proper sweep over both would probably find something better, and more importantly would tell me how sensitive the result is to either one.',
  },
}

/** Assemble the PDF body for one student, rendering each rubric criterion at
 *  the depth their own rubric ticks say they reached. `earnedKeys` is the same
 *  `${qi}:${ci}` set that produced their score, so the document cannot claim
 *  work the rubric says they did not do. */
function buildWriteup(
  hwKey: HwKey | 'hw5',
  earnedKeys: ReadonlySet<string>,
): Array<{ heading: string; body: string }> {
  const w = WRITEUPS[hwKey]
  const sections = [{ heading: 'Approach', body: w.intro }]
  for (const [key, c] of Object.entries(w.criteria)) {
    sections.push({ heading: c.heading, body: earnedKeys.has(key) ? c.earned : c.thin })
  }
  sections.push({ heading: 'What I would change', body: w.closing })
  return sections
}

/** Which criteria a student of this ability reached, when there is no rubric
 *  tick list to read it off (the open assignment is ungraded; sections B and C
 *  run without a rubric at all).
 *
 *  Deliberately NOT an independent draw per criterion. CONTEXT.md records why
 *  for the in-class quiz: independent flips give a capable student a real
 *  chance of missing most of a short list, which then contradicts the score
 *  sitting next to it. Take `round(frac * n)` of them and choose WHICH by a
 *  seeded shuffle, so the count tracks ability and the selection still varies
 *  between students. */
function earnedByAbility(
  keys: readonly string[],
  frac: number,
  seed: string,
): Set<string> {
  const count = Math.max(0, Math.min(keys.length, Math.round(frac * keys.length)))
  const order = rng(seed)
  return new Set(
    keys
      .map((key) => ({ key, sort: order() }))
      .sort((x, y) => x.sort - y.sort)
      .slice(0, count)
      .map((x) => x.key),
  )
}

/** The grader's per-rubric-card comments, one line per criterion the student
 *  missed, keyed by `String(groupIndex)` — the shape StudentRubricBreakdown and
 *  ProfessorAssignmentGrader both read. A group where nothing was missed gets
 *  no key at all, so the comment only appears where it has something to say. */
function buildRubricComments(
  hwKey: HwKey | 'hw5',
  earnedKeys: ReadonlySet<string>,
): Record<string, string> {
  const w = WRITEUPS[hwKey]
  const byGroup = new Map<string, string[]>()
  for (const [key, c] of Object.entries(w.criteria)) {
    if (earnedKeys.has(key)) continue
    const group = key.split(':')[0]
    byGroup.set(group, [...(byGroup.get(group) ?? []), c.note])
  }
  return Object.fromEntries([...byGroup].map(([g, notes]) => [g, notes.join(' ')]))
}


/** The open assignment's rubric criteria, in `${groupIndex}:${criterionIndex}`
 *  order — the same keys WRITEUPS.hw5 is written against. Listed rather than
 *  derived because the open assignment's rubric is declared inline below, after
 *  this point in the file. */
const OPEN_CRITERIA = ['0:0', '0:1', '1:0', '1:1', '2:0'] as const

/** Homework 1's criteria, same ordering. Sections B and C run this assignment
 *  without a rubric, so their write-up depth is derived from ability directly
 *  rather than from ticks that do not exist. */
const HW1_CRITERIA = ['0:0', '0:1', '1:0', '1:1', '2:0', '2:1'] as const

const STRONG_FEEDBACK = [
  'Clean work. The threshold justification in particular was well argued — you stated the cost assumption first and then let it pick the number, which is the order almost nobody uses. Keep doing that.',
  'This is the strongest write-up in the batch. You led with the decision rather than the architecture, and the result is that I could follow your reasoning without checking your code. That is rarer than it should be.',
  'Correct throughout, and you caught the leakage without being prompted. The part I want to single out is that you quantified what it cost you rather than just removing it and moving on.',
  'Exactly the right level of skepticism about your own number. You reported the result and then immediately said what would make it wrong, which is what a reader actually needs. Say this in the final report too.',
  'You justified every rubric point without me having to go looking for it, and the write-up is shorter than most of the others. Length is not the same as thoroughness and this shows it. That is the standard.',
]
const MIDDLING_FEEDBACK = [
  'Solid. The one habit to fix is ordering: state the assumption before the number that depends on it, not after. Read your own section three and notice that the reader meets the result before they know what it rests on.',
  'Good mechanics. The evaluation section undersells what you actually did — you have a real finding in there and you report it in a subordinate clause. Say the number, then defend it.',
  'Right answer, thin justification. Show me why the split you chose is the defensible one rather than asserting that it is; a sentence on what the alternative would have done differently is usually enough.',
  'The result is there, but it reads like you found it before you understood why. Walk it back through the reasoning — if you cannot explain the mechanism, you cannot tell whether it will hold on the next dataset.',
  'Correct, but only just. The margin between your model and the baseline needs its own sentence, because as written a reader cannot tell whether the gap is meaningful or inside the noise. Report the spread as well as the mean.',
]
const WEAK_FEEDBACK = [
  'The mechanics are there but the reasoning is thin. Most of the lost points are in the justification, not the implementation, which is the easier gap to close. Come to office hours and we will walk through the split.',
  'You beat the baseline, but I cannot tell from this whether the comparison was fair — the two models are not clearly on the same fold with the same metric. Let us go through it before the next one, because everything downstream depends on it.',
  'Start earlier on the next one. The first half is genuinely good and the last section reads like it was written in a hurry, which is a pacing problem rather than an understanding one.',
  'A few of the rubric points are missing entirely, not just underexplained. Check the assignment page against what you turned in — several of these are a paragraph of work each, and you left real marks on the table.',
  'The number is plausible but unsupported. Show the calculation, not just the result: as it stands I have no way to tell a correct answer from a lucky one, and neither will you in three weeks.',
]
// Below this the ABOVE lines stop being credible — "you beat the baseline" or
// "the number is plausible" both assume the core work was basically done, which
// a near-failing score contradicts. Most of the rubric is genuinely missing.
const VERY_WEAK_FEEDBACK = [
  'Most of the rubric is missing, not just thin — this reads like a partial attempt rather than a finished one. Come to office hours before the next assignment; the gap here is large enough that it will compound if we leave it.',
  'The core pieces the assignment asks for are not here. Start from the rubric rather than from the write-up and rebuild it section by section, because the structure is what is missing more than the content.',
  'This is well short of what is expected at this point in the course. Let us go through the assignment page together so the gap is clear, and do that before the next deadline rather than after it.',
]

/** Pick a feedback line for the given tone that this student has not already
 *  received on an earlier homework — three homeworks all reading "strongest
 *  write-up in the batch" is the exact repetition this exists to prevent. */
function pickFeedback(
  pool: readonly string[],
  rngFn: () => number,
  usedByStudent: Set<string>,
): string {
  const order = pool
    .map((text, i) => ({ i, sort: rngFn() }))
    .sort((x, y) => x.sort - y.sort)
    .map((x) => x.i)
  const fresh = order.find((i) => !usedByStudent.has(pool[i]))
  const chosen = pool[fresh ?? order[0]]
  usedByStudent.add(chosen)
  return chosen
}

async function seedAssignments(
  campus: Campus,
  ability: Map<string, number>,
  ids: ContentIds,
): Promise<Assessments['assignmentIds']> {
  const main = campus.main
  const prof = main.professor
  const grader = campus.roster.assistants[1]
  const active = main.students

  const rows: Record<string, unknown>[] = []
  const subs: Record<string, unknown>[] = []
  const comments: Record<string, unknown>[] = []
  /** `${hw}-${student}` -> the score actually stored, so the regrade request
   *  below can quote real numbers instead of invented ones. */
  const scoreOf = new Map<string, number>()
  /** Per-student history of feedback lines already used, across all homeworks —
   *  what pickFeedback consults so the same line never repeats on one student's
   *  own grade history. */
  const feedbackHistory = new Map<string, Set<string>>()

  for (const hw of HOMEWORK) {
    const id = det(`assignment-${hw.key}`)
    const dueDays = hw.weeksBack * 7
    const scores: number[] = []

    for (const st of active) {
      const a = ability.get(st.key)!
      const frac = perform(a, `hw-${hw.key}-${st.key}`, 0.16)
      // One student has not submitted the most recent homework at all.
      if (st.key === active[9].key && hw.key === 'hw4') continue

      // Pick the ticked criteria FIRST, then let their total BE the score.
      // Choosing the two independently put "18/25" next to a rubric panel
      // showing 25/25 with every box ticked, on the same screen.
      const target = Math.round(frac * hw.points)
      const flat = hw.rubric.flatMap((q, qi) =>
        q.criteria.map((c, ci) => ({ key: `${qi}:${ci}`, points: c.points })),
      )
      const order = rng(`crit-order-${hw.key}-${st.key}`)
      const shuffled = flat
        .map((c) => ({ c, sort: order() }))
        .sort((x, y) => x.sort - y.sort)
        .map((x) => x.c)
      const chosen: string[] = []
      let earnedFromRubric = 0
      for (const c of shuffled) {
        if (earnedFromRubric + c.points > target) continue
        chosen.push(c.key)
        earnedFromRubric += c.points
      }
      const score = earnedFromRubric
      scores.push(score)
      scoreOf.set(`${hw.key}-${st.key}`, score)

      // Twelve identical sentences down the grader's roster reads as placeholder
      // data, which is exactly what it was. Vary the prose per student.
      const coverIndex = Math.floor(rng(`note-${hw.key}-${st.key}`)() * WRITEUPS[hw.key].covers.length)
      const submittedAt = daysAgo(dueDays + (rng(`late-${hw.key}-${st.key}`)() < 0.12 ? -1 : 1), 21)

      // A real uploaded file, in the same bucket/path shape the app itself
      // writes — every homework here accepts 'files', and none had ever had
      // an attachment: "show me the notebook they turned in" had nothing to
      // click.
      //
      // The document renders each rubric criterion at the depth `earned` says
      // the student reached, so an unticked box on the rubric card has a
      // visibly thinner section behind it in the PDF. Same set, rendered twice.
      const earned = new Set(chosen)
      const files: Record<string, unknown>[] = []
      try {
        const fileName = `${hw.key}-writeup.pdf`
        const path = buildSubmissionPath(main.id, id, st.id, fileName, `seed-${hw.key}-${st.key}`)
        const pdf = makeHandoutPdf(hw.title, buildWriteup(hw.key, earned))
        await upload(ASSIGNMENT_SUBMISSIONS_BUCKET, path, pdf.buffer, 'application/pdf')
        files.push({ path, name: fileName, size: pdf.buffer.length, type: 'application/pdf' })
      } catch (err) {
        warn(`${hw.key} submission file upload failed for ${st.key} (${(err as Error).message})`)
      }

      subs.push({
        id: det(`sub-${hw.key}-${st.key}`),
        assignment_id: id,
        student_id: st.id,
        institution_id: INSTITUTION_ID,
        status: 'graded',
        text_content: WRITEUPS[hw.key].covers[coverIndex],
        code_content: null,
        code_language: null,
        files,
        score,
        // Tone follows the ACTUAL percentage stored (score/hw.points), not the
        // pre-rubric frac — the two can land in different bands once rubric
        // quantization rounds the target, which used to put "strongest write-up
        // in the batch" next to a 76%.
        feedback: pickFeedback(
          score / hw.points > 0.85
            ? STRONG_FEEDBACK
            : score / hw.points > 0.65
              ? MIDDLING_FEEDBACK
              : score / hw.points > 0.35
                ? WEAK_FEEDBACK
                : VERY_WEAK_FEEDBACK,
          rng(`feedback-${hw.key}-${st.key}`),
          feedbackHistory.get(st.key) ?? feedbackHistory.set(st.key, new Set()).get(st.key)!,
        ),
        graded_by: grader.id,
        graded_at: daysAgo(Math.max(0, dueDays - 4), 12),
        submitted_at: submittedAt,
        rubric_scores: chosen,
        rubric_comments: buildRubricComments(hw.key, earned),
        graded_with_rubric: true,
        created_at: submittedAt,
      })
    }

    const n = scores.length
    const sorted = [...scores].sort((x, y) => x - y)
    const counts = Array.from({ length: 5 }, (_, b) =>
      scores.filter((s) => {
        const p = s / hw.points
        return p >= b / 5 && (b === 4 ? p <= 1 : p < (b + 1) / 5)
      }).length,
    )

    rows.push({
      id,
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      module_id: ids.moduleByWeek.get(hw.week) ?? null,
      created_by: prof.id,
      title: hw.title,
      description: hw.guidelines.slice(0, 160),
      guidelines: hw.guidelines,
      submission_type: hw.type,
      status: 'closed',
      points: hw.points,
      rubric: [],
      reference_materials: [],
      is_graded: true,
      start_at: daysAgo(dueDays + 7, 9),
      due_at: daysAgo(dueDays, 19),
      end_at: daysAgo(dueDays - 2, 19),
      published_at: daysAgo(dueDays + 7, 9),
      created_at: daysAgo(dueDays + 8, 9),
      settings: {
        rubric: { questions: hw.rubric.map((q) => ({ label: q.label, points: q.points, criteria: q.criteria })) },
        // The rubric editor gates on settings.skillModules, NOT on
        // assignments.module_id — without it the seeded rubric is invisible
        // behind "Tag at least one module above to unlock the rubric editor".
        skillModules: [ids.moduleByWeek.get(hw.week)].filter(Boolean),
        accepts: { fileTypes: hw.type === 'files' ? ['pdf', 'ipynb'] : ['pdf'] },
        gradesPublished: true,
        gradesPublishedAt: daysAgo(Math.max(0, dueDays - 3), 12),
        statsPublished: true,
        statsPublishedAt: daysAgo(Math.max(0, dueDays - 3), 12),
        publishedStats: {
          n,
          points: hw.points,
          avg: n ? Number((scores.reduce((s, v) => s + v, 0) / n).toFixed(2)) : 0,
          median: n ? sorted[Math.floor(n / 2)] : 0,
          low: n ? sorted[0] : 0,
          high: n ? sorted[n - 1] : 0,
          counts,
        },
      },
    })
  }

  // The one that is open right now.
  const openId = det('assignment-open')
  rows.push({
    id: openId,
    section_id: main.id,
    institution_id: INSTITUTION_ID,
    module_id: ids.moduleByWeek.get(Math.min(WEEKS.length, WEEKS_IN)) ?? null,
    created_by: prof.id,
    title: 'Homework 5 — Training a network end to end',
    description: 'Train a small network on the provided dataset and diagnose one failure from evidence.',
    guidelines:
      'Train a two-hidden-layer network on the provided dataset. Produce a learning curve, diagnose whether you are bias- or variance-limited, and act on the diagnosis. Show both the before and the after.',
    submission_type: 'files',
    status: 'published',
    points: 25,
    rubric: [],
    reference_materials: [],
    // `is_graded` drives the "Ungraded" label. False beside 25 points and a
    // full rubric made the card, the dashboard and the grader disagree.
    is_graded: true,
    start_at: daysAgo(5, 9),
    due_at: daysAgo(-6, 19),
    published_at: daysAgo(5, 9),
    created_at: daysAgo(6, 9),
    settings: {
      rubric: {
        questions: [
          { label: 'Training', points: 10, criteria: [
            { points: 5, description: 'Network trains without divergence and the run is reproducible' },
            { points: 5, description: 'Learning-rate choice is justified' },
          ] },
          { label: 'Diagnosis', points: 10, criteria: [
            { points: 5, description: 'Learning curve is produced and read correctly' },
            { points: 5, description: 'The action taken follows from the diagnosis' },
          ] },
          { label: 'Evidence', points: 5, criteria: [{ points: 5, description: 'Before and after are both shown' }] },
        ],
      },
      accepts: { fileTypes: ['pdf', 'ipynb'] },
      gradesPublished: false,
      statsPublished: false,
    },
  })

  // A third of the class has already submitted; one has a draft going.
  for (const [i, st] of active.entries()) {
    if (i % 3 !== 0 && i !== 1) continue
    const draft = i === 1

    // Nothing here is graded yet, so there are no rubric ticks to render the
    // write-up against. Depth comes from the student's own ability instead —
    // the same number that will decide their score when this IS graded, so
    // the strong submissions in the queue are strong for the same reason they
    // will score well, and a demo that grades one live stays consistent.
    const openEarned = earnedByAbility(
      OPEN_CRITERIA,
      perform(ability.get(st.key)!, `open-quality-${st.key}`, 0.16),
      `open-crit-${st.key}`,
    )

    // This is the assignment the professor dashboard points at as the top
    // task, so the grading queue is the first thing a demo clicks through —
    // it, more than any graded homework, needs a real file behind it.
    const files: Record<string, unknown>[] = []
    if (!draft) {
      try {
        const fileName = 'hw5-writeup.pdf'
        const path = buildSubmissionPath(main.id, openId, st.id, fileName, `seed-open-${st.key}`)
        const pdf = makeHandoutPdf(
          'Homework 5 — Training a network end to end',
          buildWriteup('hw5', openEarned),
        )
        await upload(ASSIGNMENT_SUBMISSIONS_BUCKET, path, pdf.buffer, 'application/pdf')
        files.push({ path, name: fileName, size: pdf.buffer.length, type: 'application/pdf' })
      } catch (err) {
        warn(`open-assignment submission file upload failed for ${st.key} (${(err as Error).message})`)
      }
    }

    subs.push({
      id: det(`sub-open-${st.key}`),
      assignment_id: openId,
      student_id: st.id,
      institution_id: INSTITUTION_ID,
      status: draft ? 'draft' : 'submitted',
      // One shared paragraph made all four submissions look fabricated.
      text_content: draft
        ? 'Learning curve is plotted, still working out whether this is bias or variance. Will attach the notebook once section 4 is written up.'
        : WRITEUPS.hw5.covers[i % WRITEUPS.hw5.covers.length],
      files,
      submitted_at: draft ? null : daysAgo(1, 22),
      created_at: daysAgo(3, 20),
    })
  }

  const draftId = det('assignment-draft')
  rows.push({
    id: draftId,
    section_id: main.id,
    institution_id: INSTITUTION_ID,
    created_by: prof.id,
    title: 'Homework 6 — Fairness audit (draft)',
    description: 'Not published. Waiting on the dataset licence.',
    guidelines: 'Audit the provided model for subgroup performance gaps and recommend one mitigation.',
    submission_type: 'written',
    status: 'draft',
    points: 20,
    rubric: [],
    reference_materials: [],
    is_graded: false,
    created_at: daysAgo(2, 11),
    settings: { rubric: { questions: [] }, gradesPublished: false, statsPublished: false },
  })

  await up('assignments', rows)
  await up('assignment_submissions', subs)

  // Per-question conversation on one graded submission.
  const target = active[6]
  const REGRADE_CRITERION_POINTS = 5
  const regradedScore = scoreOf.get(`hw3-${target.key}`) ?? REGRADE_CRITERION_POINTS
  comments.push(
    {
      id: det('sub-comment-1'),
      submission_id: det(`sub-hw3-${target.key}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      question_index: 1,
      question_label: 'Threshold',
      author_id: target.id,
      author_role: 'student',
      body: 'I stated the cost ratio in the notebook cell above the plot — did that not count?',
      created_at: daysAgo(18, 17),
    },
    {
      id: det('sub-comment-2'),
      submission_id: det(`sub-hw3-${target.key}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      question_index: 1,
      question_label: 'Threshold',
      author_id: grader.id,
      author_role: 'staff',
      body: `It did, and I missed it. Adjusted — the criterion is now marked and your score went up by ${REGRADE_CRITERION_POINTS}.`,
      created_at: daysAgo(17, 10),
    },
  )

  // Two more threads so the per-question conversation does not look like a
  // feature that got used exactly once. One of them is deliberately left
  // unanswered — an open student question sitting in the professor's queue is
  // both realistic and something to click on in a demo.
  const asker = active[2]
  const unanswered = active[9]
  comments.push(
    {
      id: det('sub-comment-3'),
      submission_id: det(`sub-hw4-${asker.key}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      question_index: 1,
      question_label: 'Comparison',
      author_id: asker.id,
      author_role: 'student',
      body: 'I did hold the split and the metric fixed across all three — it is set once at the top of the notebook and never reassigned. Is the issue that I did not say so in the write-up?',
      created_at: daysAgo(6, 15),
    },
    {
      id: det('sub-comment-4'),
      submission_id: det(`sub-hw4-${asker.key}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      question_index: 1,
      question_label: 'Comparison',
      author_id: grader.id,
      author_role: 'staff',
      body: 'That is exactly the issue. I can see it in your code, but the write-up has to stand on its own — a reader who is not going to open the notebook cannot tell whether the comparison was fair. One sentence would have covered it.',
      created_at: daysAgo(5, 11),
    },
    {
      id: det('sub-comment-5'),
      submission_id: det(`sub-hw4-${asker.key}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      question_index: 1,
      question_label: 'Comparison',
      author_id: asker.id,
      author_role: 'student',
      body: 'Understood. I will state the setup explicitly next time rather than leaving it in the code.',
      created_at: daysAgo(5, 14),
    },
    {
      id: det('sub-comment-6'),
      submission_id: det(`sub-hw2-${unanswered.key}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      question_index: 1,
      question_label: 'Interpretation',
      author_id: unanswered.id,
      author_role: 'student',
      body: 'Could I get a bit more on this one? I named the zeroed coefficients but I am not sure what "say why each is plausible" wants beyond pointing at the correlation matrix.',
      created_at: daysAgo(3, 20),
    },
  )
  await up('assignment_submission_comments', comments)

  await up('assignment_regrade_requests', [
    {
      id: det('regrade-1'),
      submission_id: det(`sub-hw3-${target.key}`),
      assignment_id: det('assignment-hw3'),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      student_id: target.id,
      questions: [1],
      reason: 'The cost assumption was stated in the cell above the plot, so I think criterion 2.1 should be marked.',
      status: 'resolved',
      // The resolved request restored one 5-point criterion, so the submission's
      // stored score IS the post-regrade number and the original was 5 lower.
      // Hard-coding these meant the regrade contradicted the submission beside it.
      old_score: regradedScore - REGRADE_CRITERION_POINTS,
      new_score: regradedScore,
      resolution_note: 'Agreed, the assumption was stated. Criterion marked and the score updated.',
      resolved_by: grader.id,
      resolved_at: daysAgo(17, 10),
      created_at: daysAgo(18, 17),
    },
    {
      // Still open, so it sits in the professor's queue during a demo. An open
      // request has not changed anything yet: old_score and new_score stay
      // null rather than echoing the current score, which would read as a
      // decided regrade that simply forgot to move the number.
      id: det('regrade-2'),
      submission_id: det(`sub-hw4-${asker.key}`),
      assignment_id: det('assignment-hw4'),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      student_id: asker.id,
      questions: [1],
      reason: 'The split and the metric were held fixed for all three models — it is set once at the top of the notebook. I accept that I did not write it down, but the comparison itself was fair.',
      status: 'open',
      old_score: null,
      new_score: null,
      resolution_note: '',
      resolved_by: null,
      resolved_at: null,
      created_at: daysAgo(5, 14),
    },
    {
      id: det('regrade-3'),
      submission_id: det(`sub-hw2-${unanswered.key}`),
      assignment_id: det('assignment-hw2'),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      student_id: unanswered.id,
      questions: [2],
      reason: 'I think the validation curve criterion should be marked — the plot is there at the end of section 3.',
      status: 'withdrawn',
      old_score: null,
      new_score: null,
      resolution_note: '',
      resolved_by: null,
      resolved_at: null,
      created_at: daysAgo(12, 16),
    },
  ])

  // The answer key behind one homework — staff-only, and a real stored file.
  try {
    const keyPdf = makeHandoutPdf('Homework 3 — Answer key', [
      { heading: 'Metric choice', body: 'Full marks for any metric justified by an explicit cost assumption. Bare accuracy scores zero on this criterion regardless of the number.' },
      { heading: 'Threshold', body: 'Look for the cost ratio stated in prose, not only implied by the plot. A threshold chosen without a stated assumption gets half.' },
      { heading: 'Write-up', body: 'Read the first paragraph only. If it leads with architecture instead of the recommendation, mark it down.' },
    ])
    const keyPath = `${main.id}/${det('assignment-hw3')}/answer-key.pdf`
    await upload('course-materials', keyPath, keyPdf.buffer, 'application/pdf')
    await up('assignment_answer_keys', [
      {
        id: det('answer-key-hw3'),
        assignment_id: det('assignment-hw3'),
        section_id: main.id,
        institution_id: INSTITUTION_ID,
        source_path: keyPath,
        text: 'Metric choice: full marks for any metric justified by an explicit cost assumption...',
        created_at: daysAgo(20),
      },
    ])
  } catch (err) {
    warn(`answer key skipped: ${(err as Error).message}`)
  }

  ok(`${rows.length} assignments, ${subs.length} submissions, 1 resolved regrade request`)
  return { graded: HOMEWORK.map((h) => det(`assignment-${h.key}`)), open: openId, draft: draftId }
}

/** B and C get one graded homework each so their gradebooks are not blank. */
async function seedSideAssessments(sections: SectionInfo[], ability: Map<string, number>) {
  const rows: Record<string, unknown>[] = []
  const subs: Record<string, unknown>[] = []
  for (const s of sections) {
    const id = det(`assignment-${s.code}-hw1`)
    rows.push({
      id,
      section_id: s.id,
      institution_id: INSTITUTION_ID,
      created_by: s.professor.id,
      title: 'Homework 1 — Framing and the split',
      description: 'Frame the decision, build the split, fit a baseline.',
      guidelines: 'Submit one notebook that runs top to bottom on a fresh kernel.',
      submission_type: 'files',
      status: 'closed',
      points: 20,
      rubric: [],
      reference_materials: [],
      is_graded: true,
      due_at: daysAgo(21, 19),
      published_at: daysAgo(28, 9),
      created_at: daysAgo(29, 9),
      settings: { rubric: { questions: [] }, gradesPublished: true, statsPublished: false },
    })
    for (const st of s.students) {
      const a = ability.get(st.key) ?? 0.7
      const frac = perform(a, `side-${s.code}-${st.key}`, 0.12)

      // B and C stay shallower than A on purpose — no rubric, no quizzes,
      // because uneven adoption across sections is what a real campus looks
      // like. Shallow is not the same as fake, though: twelve submissions all
      // reading "Notebook attached." with byte-identical feedback was the
      // latter. They get the same real attachment and the same varied prose
      // as A; what they do not get is the rubric workflow on top.
      const earned = earnedByAbility(HW1_CRITERIA, frac, `side-crit-${s.code}-${st.key}`)
      const files: Record<string, unknown>[] = []
      try {
        const fileName = 'hw1-writeup.pdf'
        const path = buildSubmissionPath(s.id, id, st.id, fileName, `seed-${s.code}-hw1-${st.key}`)
        const pdf = makeHandoutPdf('Homework 1 — Framing and the split', buildWriteup('hw1', earned))
        await upload(ASSIGNMENT_SUBMISSIONS_BUCKET, path, pdf.buffer, 'application/pdf')
        files.push({ path, name: fileName, size: pdf.buffer.length, type: 'application/pdf' })
      } catch (err) {
        warn(`${s.code} hw1 submission file upload failed for ${st.key} (${(err as Error).message})`)
      }

      subs.push({
        id: det(`sub-${s.code}-hw1-${st.key}`),
        assignment_id: id,
        student_id: st.id,
        institution_id: INSTITUTION_ID,
        status: 'graded',
        text_content: WRITEUPS.hw1.covers[
          Math.floor(rng(`side-cover-${s.code}-${st.key}`)() * WRITEUPS.hw1.covers.length)
        ],
        files,
        score: Math.round(frac * 20),
        feedback: pickFeedback(
          frac > 0.85 ? STRONG_FEEDBACK : frac > 0.65 ? MIDDLING_FEEDBACK : frac > 0.35 ? WEAK_FEEDBACK : VERY_WEAK_FEEDBACK,
          rng(`side-feedback-${s.code}-${st.key}`),
          new Set(),
        ),
        graded_by: s.professor.id,
        graded_at: daysAgo(16, 12),
        submitted_at: daysAgo(21, 21),
        created_at: daysAgo(21, 21),
      })
    }
  }
  await up('assignments', rows)
  await up('assignment_submissions', subs)
  ok(`sections B and C: ${rows.length} assignments, ${subs.length} graded submissions`)
}

// ── Gradebook ─────────────────────────────────────────────────────────

const CATEGORIES = [
  { key: 'homework', name: 'Homework', weight: 30, aggregation: 'best_of_n', keep: 4 },
  { key: 'quizzes', name: 'Quizzes', weight: 15, aggregation: 'best_of_n', keep: 3 },
  { key: 'midterm', name: 'Midterm', weight: 20, aggregation: 'single', keep: null },
  { key: 'project', name: 'Team Project', weight: 25, aggregation: 'single', keep: null },
  { key: 'participation', name: 'Participation', weight: 10, aggregation: 'average', keep: null },
] as const

async function seedGradebook(
  campus: Campus,
  quizIds: Assessments['quizIds'],
  assignmentIds: Assessments['assignmentIds'],
): Promise<{ schemeId: string; projectCategoryId: string }> {
  const main = campus.main
  const schemeId = det('grading-scheme')

  const total = CATEGORIES.reduce((n, c) => n + c.weight, 0)
  if (total !== 100) warn(`category weights sum to ${total}, not 100 — the gradebook will warn`)

  await up('grading_schemes', [
    {
      id: schemeId,
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      // Standard US scale, matching DEFAULT_LETTER_CUTOFFS in src/lib/grades/compute.ts.
      letter_cutoffs: [
        { letter: 'A+', min: 97 }, { letter: 'A', min: 93 }, { letter: 'A-', min: 90 },
        { letter: 'B+', min: 87 }, { letter: 'B', min: 83 }, { letter: 'B-', min: 80 },
        { letter: 'C+', min: 77 }, { letter: 'C', min: 73 }, { letter: 'C-', min: 70 },
        { letter: 'D+', min: 67 }, { letter: 'D', min: 63 }, { letter: 'D-', min: 60 },
        { letter: 'F', min: 0 },
      ],
      created_by: main.professor.id,
    },
  ])

  await up(
    'grade_categories',
    CATEGORIES.map((c, i) => ({
      id: det(`grade-cat-${c.key}`),
      scheme_id: schemeId,
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      name: c.name,
      weight: c.weight,
      aggregation: c.aggregation,
      keep_n: c.keep,
      score_mode: 'points',
      is_extra_credit: false,
      position: i,
    })),
  )

  const items: Record<string, unknown>[] = []
  assignmentIds.graded.concat(assignmentIds.open).forEach((id, i) =>
    items.push({
      id: det(`grade-item-hw-${i}`),
      category_id: det('grade-cat-homework'),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      item_type: 'assignment',
      item_id: id,
      is_extra_credit: false,
    }),
  )
  quizIds.graded.concat(quizIds.open).forEach((id, i) =>
    items.push({
      id: det(`grade-item-quiz-${i}`),
      category_id: det('grade-cat-quizzes'),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      item_type: 'quiz',
      item_id: id,
      is_extra_credit: false,
    }),
  )
  items.push({
    id: det('grade-item-midterm'),
    category_id: det('grade-cat-midterm'),
    section_id: main.id,
    institution_id: INSTITUTION_ID,
    item_type: 'quiz',
    item_id: quizIds.midterm,
    is_extra_credit: false,
  })
  await up('grade_category_items', items)

  // One documented excusal — a student who was hospitalised during Quiz 2.
  await up('grade_exceptions', [
    {
      id: det('grade-exception-1'),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      student_id: main.students[9].id,
      item_type: 'quiz',
      item_id: quizIds.graded[1],
      status: 'excused',
      created_by: main.professor.id,
      created_at: daysAgo(30),
    },
  ])

  ok(`gradebook: ${CATEGORIES.length} categories (${total}% total), ${items.length} items, 1 excusal`)
  return { schemeId, projectCategoryId: det('grade-cat-project') }
}

// ── Skill mastery ─────────────────────────────────────────────────────

async function seedMastery(
  campus: Campus,
  ids: ContentIds,
  ability: Map<string, number>,
  quizIds: Assessments['quizIds'],
  assignmentIds: Assessments['assignmentIds'],
  masteryByStudent: Map<string, Map<string, number>>,
) {
  const main = campus.main
  const taught = WEEKS.filter((w) => w.n <= WEEKS_IN).flatMap((w) => w.skills)
  const taughtSet = [...new Set(taught)]

  // Which activity exercises which skill. Drives the mastery attribution and the
  // "what should I review" surfaces.
  const links: Record<string, unknown>[] = []
  const linkSkill = (activityId: string, type: string, skill: string, tag: string) => {
    const skillId = ids.skillIdByName.get(skill)
    if (!skillId) return
    links.push({
      id: det(`activity-skill-${tag}-${skill}`),
      section_id: main.id,
      institution_id: INSTITUTION_ID,
      activity_id: activityId,
      activity_type: type,
      skill_id: skillId,
    })
  }
  quizIds.graded.concat([quizIds.midterm, quizIds.open]).forEach((qid, i) => {
    const bankKey = ['q1', 'q2', 'q3', 'midterm', 'q4'][i]
    const qs = BANK[bankKey as keyof typeof BANK] ?? []
    for (const skill of new Set(qs.map((q) => q.skill))) linkSkill(qid, 'quiz', skill, `quiz${i}`)
  })
  HOMEWORK.forEach((hw, i) => {
    const week = WEEKS.find((w) => w.n === hw.week)
    for (const skill of week?.skills ?? []) linkSkill(assignmentIds.graded[i], 'assignment', skill, `hw${i}`)
  })
  await up('activity_skills', links)

  // Mastery per (student, skill), derived from ability with a per-skill offset so
  // each student has a genuinely different weakest topic.
  const mastery: Record<string, unknown>[] = []
  const snapshots: Record<string, unknown>[] = []
  // Everyone climbing along the same curve makes twelve identical trend lines,
  // and it also made a claim in the seeded Athena conversation false ("their
  // mastery has been flat for three weeks while the class average climbed").
  // Give each student a shape: most climb steadily, one plateaus late, one
  // starts slowly and catches up.
  type Shape = 'steady' | 'plateau' | 'late-bloom'
  const shapeOf = (index: number): Shape =>
    index === 3 ? 'plateau' : index === 8 ? 'late-bloom' : 'steady'

  /** Fraction of final mastery reached by week `w`, 0-1. */
  const trajectory = (shape: Shape, w: number): number => {
    const t = w / WEEKS_IN
    if (shape === 'plateau') {
      // Climbs normally, then stops moving for the last three weeks.
      const capped = Math.min(w, WEEKS_IN - 3) / WEEKS_IN
      return 0.45 + 0.55 * (capped / Math.max(0.01, (WEEKS_IN - 3) / WEEKS_IN))
    }
    if (shape === 'late-bloom') return 0.45 + 0.55 * t * t
    return 0.45 + 0.55 * t
  }

  main.students.forEach((st, studentIndex) => {
    const a = ability.get(st.key)!
    const shape = shapeOf(studentIndex)
    const mine = new Map<string, number>()
    masteryByStudent.set(st.key, mine)
    for (const skill of taughtSet) {
      const skillId = ids.skillIdByName.get(skill)
      if (!skillId) continue
      const offset = (rng(`skill-${st.key}-${skill}`)() - 0.5) * 0.3
      const score = Math.min(0.98, Math.max(0.08, masteryFromAbility(a) + offset))
      mine.set(skill, pct(score))
      mastery.push({
        id: det(`mastery-${st.key}-${skill}`),
        section_id: main.id,
        institution_id: INSTITUTION_ID,
        student_id: st.id,
        skill_id: skillId,
        score: pct(score),
        state: { n: 3, t: Number((pct(score) * 3).toFixed(1)), w: 3, lastAt: new Date(NOW).getTime() },
        updated_at: daysAgo(1),
      })

      // Weekly snapshots so the mastery trend line has a shape rather than a dot.
      for (let w = 1; w <= WEEKS_IN; w++) {
        const ramp = trajectory(shape, w)
        // Both columns are on the same 0-100 scale; the check constraint allows
        // 0-100 for `estimate` too, so a 0-1 value here would pass the database
        // and then render as a flat zero line on the mastery trend.
        const point = pct(Math.min(0.98, score * ramp))
        snapshots.push({
          student_id: st.id,
          skill_id: skillId,
          section_id: main.id,
          institution_id: INSTITUTION_ID,
          score: point,
          estimate: point,
          captured_on: daysAgo((WEEKS_IN - w) * 7).slice(0, 10),
        })
      }
    }
  })
  // onConflict='student_id,skill_id', not 'id': the live app also writes this
  // table (quiz attempts recompute mastery), so a demo student who was ever
  // actually used to click through the app can already have a real row for a
  // skill under a real (non-deterministic) id. Conflicting on the seed's own
  // id would insert a second row and hit the table's other unique constraint;
  // conflicting on the natural key overwrites whatever row is really there.
  await up('skill_mastery', mastery, 'student_id,skill_id')
  await up('skill_mastery_snapshots', snapshots, 'student_id,skill_id,captured_on')
  ok(`mastery: ${links.length} activity links, ${mastery.length} scores, ${snapshots.length} weekly snapshots`)
}

// ── Entry point ───────────────────────────────────────────────────────

export async function seedAssessments(campus: Campus, ids: ContentIds): Promise<Assessments> {
  phase('Quizzes, assignments, gradebook, mastery')

  const abilityByStudent = new Map<string, number>()
  campus.sections.forEach((s) => s.students.forEach((st, i) => abilityByStudent.set(st.key, abilityOf(st, i))))

  const quizAvgByStudent = new Map<string, number>()
  const masteryByStudent = new Map<string, Map<string, number>>()

  const quizIds = await seedQuizzes(campus, abilityByStudent, quizAvgByStudent)
  const assignmentIds = await seedAssignments(campus, abilityByStudent, ids)
  await seedSideAssessments(campus.sections.slice(1), abilityByStudent)
  const { schemeId, projectCategoryId } = await seedGradebook(campus, quizIds, assignmentIds)
  await seedMastery(campus, ids, abilityByStudent, quizIds, assignmentIds, masteryByStudent)

  return {
    abilityByStudent,
    quizAvgByStudent,
    masteryByStudent,
    quizIds,
    assignmentIds,
    gradeSchemeId: schemeId,
    projectCategoryId,
  }
}

// ── Final standing ────────────────────────────────────────────────────

/**
 * Write each student's overall percentage into `enrollments.final_score`.
 *
 * The student dashboard's "Average Grade" card reads this column and shows "—"
 * when it is null, so without it a student with nine weeks of graded work has a
 * blank headline metric.
 *
 * The number is produced by the app's OWN grade pipeline — `fetchSectionGradeData`
 * then `computeGrade` — rather than a second implementation here. Re-deriving the
 * weighting (best-of-n, drop-lowest, excusals, release state) would be a second
 * source of truth, and the first time it disagreed with the Grades page the demo
 * would be showing a contradiction on its headline number.
 */
export async function seedFinalScores(campus: Campus) {
  const { fetchSectionGradeData } = await import('@/lib/grades/fetch')
  const { computeGrade, hasEnoughGradedData } = await import('@/lib/grades/compute')
  const { professorScores } = await import('@/lib/grades/fetch')

  let written = 0
  let skipped = 0
  for (const section of campus.sections) {
    const studentIds = section.students.map((s) => s.id)
    const { scheme, scoresByStudent } = await fetchSectionGradeData(db, section.id, studentIds)
    if (!scheme) {
      skipped += studentIds.length
      continue
    }

    for (const student of section.students) {
      const scores = scoresByStudent[student.id] ?? {}
      const result = computeGrade(scheme.categories, professorScores(scores), scheme.cutoffs)
      // Below the graded-weight floor the app itself declines to show a grade;
      // storing one anyway would contradict the Grades page.
      if (!hasEnoughGradedData(result) || result.currentPercent == null) {
        skipped++
        continue
      }
      const { error } = await db
        .from('enrollments')
        .update({ final_score: Number(result.currentPercent.toFixed(2)) })
        .eq('section_id', section.id)
        .eq('student_id', student.id)
      if (error) throw new Error(`final_score for ${student.email}: ${error.message}`)
      written++
    }
  }
  ok(`final standing written for ${written} enrolments${skipped ? `, ${skipped} skipped (not enough graded weight)` : ''}`)
}
