// The AI surfaces and everything that reports on the tenant: Athena conversation
// history, the student tutor, per-student memory, the cached student/class
// insight summaries, the notification feed, analytics telemetry, and feedback.
//
// The insight summaries carry numbers that also appear on the gradebook and the
// mastery heatmap, so they are computed from the same maps the assessments layer
// produced rather than invented here.

import {
  db, det, up, ok, phase,
  INSTITUTION_ID, WEEKS_IN, daysAgo, rng, NOW, weekdayName,
} from './context'
import type { Campus, Person } from './roster'
import type { Assessments } from './assessments'
import type { Collab } from './collab'

const text = (t: string) => [{ type: 'text', text: t }]

// ── Athena ────────────────────────────────────────────────────────────

interface Turn { role: 'user' | 'assistant'; text: string }

async function seedAthena(campus: Campus, grades: Assessments) {
  const main = campus.main
  const prof = main.professor
  const s = main.students

  const convos: Array<{
    key: string
    user: Person
    surface: 'professor' | 'student' | 'studio'
    studioSurface?: 'authoring' | 'grade' | 'general'
    studioKind?: 'quiz' | 'files' | 'about' | null
    assignmentId?: string
    quizId?: string
    title: string
    daysBack: number
    turns: Turn[]
  }> = [
    {
      key: 'prof-atrisk', user: prof, surface: 'professor', title: 'Who is falling behind in CS 340-A?', daysBack: 3,
      turns: [
        { role: 'user', text: 'Who in section A is at risk right now, and what is the specific thing each of them is missing?' },
        { role: 'assistant', text:
          `Three students stand out, and the reasons are different.\n\n` +
          `**${s[9].first} ${s[9].last}** is the clearest case. They missed Quiz 2 entirely, have not submitted Homework 4, and they have attended 5 of the 9 live sessions against a class average of 8. Mastery sits well below the cohort on every foundation skill. This reads as disengagement rather than difficulty.\n\n` +
          `**${s[6].first} ${s[6].last}** is borderline on scores but the pattern is interesting: they opened a regrade request on Homework 3 and were right, so the understanding is there. Their weakest area is the metrics material from week 4.\n\n` +
          `**${s[3].first} ${s[3].last}** attends and submits, but the mastery trend has been flat for three weeks while the class average has climbed. Worth a conversation before the project deadline.\n\n` +
          `The fastest intervention is the shared one: the week-4 metrics material is the weakest topic across all three.` },
        { role: 'user', text: 'Draft a short message I could send the first one.' },
        { role: 'assistant', text:
          `Here is a draft. It names the specific thing rather than the pattern, which tends to get a reply:\n\n` +
          `> Hi ${s[9].first} — I noticed Homework 4 has not come in and you missed Quiz 2. No penalty conversation here, I just want to check whether something is going on and whether the material or the schedule is the problem. Office hours are Tuesday 2pm and Thursday 10am, or reply here and we can find another time.` },
      ],
    },
    {
      key: 'prof-quiz', user: prof, surface: 'studio', studioSurface: 'authoring', title: 'Draft Quiz 5 on evaluation', daysBack: 1,
      quizId: grades.quizIds.draft,
      turns: [
        { role: 'user', text: 'Draft a couple of questions on calibration and fairness, at the level of the week 13 and 14 material.' },
        { role: 'assistant', text:
          `Drafted two to start. The first tests whether they can tell calibration apart from accuracy — a model that says 0.7 and is right half the time is the case that separates the two. The second asks whether the common fairness criteria can all hold at once; they cannot, and the point is that the choice is yours to justify rather than something to optimise away.\n\n` +
          `Say the word and I will add two more on slice analysis and reliability diagrams.` },
      ],
    },
    {
      // `studio_surface: 'grade'` has no precedent in production — every studio
      // conversation there is 'authoring' — and listStudioConversations() scopes
      // on the exact (surface, kind, assignment_id, quiz_id) tuple, so a shape
      // nothing opens with is a conversation nobody can reach. Use the observed
      // assignment shape instead.
      // Scope confirmed by watching what the app actually requests, not by
      // guessing from existing rows. The assignment GRADER is the only screen
      // that opens a per-assignment thread: on ?tab=grading the dock fires a
      // list for (sectionId, 'grade', undefined, assignmentId), i.e.
      // studio_surface 'grade' with a NULL studio_kind. The authoring wizard
      // looks like the other candidate but omits assignmentId, so its scope
      // resolves to `assignment_id IS NULL` and never matches this row.
      // Production has no 'grade' rows yet, which means the surface is unused —
      // not that the shape is wrong.
      key: 'prof-grade', user: prof, surface: 'studio', studioSurface: 'grade', studioKind: null,
      title: 'Homework 4 — where the class lost marks', daysBack: 2,
      assignmentId: grades.assignmentIds.graded[3],
      turns: [
        { role: 'user', text: 'Summarise where the class lost marks on Homework 4.' },
        { role: 'assistant', text:
          `Most of the lost marks are on one criterion: "explains the gap in terms of variance". Students consistently reported that the library models scored better without saying why, which is exactly the reasoning step the question is testing.\n\n` +
          `The from-scratch tree criteria scored well. Nobody failed the stopping condition, which is a change from the last two cohorts.` },
      ],
    },
    {
      key: 'student-leak', user: s[0], surface: 'student', title: 'Why does my model score drop when I fix the split?', daysBack: 4,
      turns: [
        { role: 'user', text: 'My AUC went from 0.94 to 0.71 when I fixed the split for the project. Did I break something?' },
        { role: 'assistant', text:
          `You did not break it — you fixed it. The 0.94 was measuring how well your model could read a feature that already contained the answer.\n\n` +
          `Professor Vasquez made exactly this point in the week 2 class: "leakage is any information about the label that would not be available at prediction time". The 0.71 is the number your model would actually achieve on a new case, so it is the one to report.\n\n` +
          `The useful move now is to check it against your baseline. If your baseline is around 0.58, then 0.71 is a real improvement and the write-up should lead with the leak you found, not hide it.` },
        { role: 'user', text: 'Is this going to be on the midterm?' },
        { role: 'assistant', text:
          `Yes. In the week 8 review class the professor said the exam "covers weeks one through seven" and is conceptual, and specifically mentioned that one question asks you to find the leakage in a described setup. This is that material.` },
      ],
    },
    {
      key: 'student-study', user: s[6], surface: 'student', title: 'What should I revise first?', daysBack: 2,
      turns: [
        { role: 'user', text: 'I have about three hours before the quiz closes. What should I spend them on?' },
        { role: 'assistant', text:
          `Based on your own quiz answers, the highest-value hour is on classification metrics from week 4. You got the precision/recall question wrong on Quiz 3 and the same concept appears again on the midterm.\n\n` +
          `Second hour: the bias-variance decomposition. Your Quiz 2 answers were right but slow, which usually means the idea is memorised rather than understood.\n\n` +
          `Third hour: leave it. The week 9 material is your strongest area and revising it further will not move your score.` },
      ],
    },
    {
      // s[9] (Nadia) is the at-risk student named in prof-atrisk above — missed
      // Quiz 2 entirely, no Homework 4 submission, low attendance. The one
      // student most likely to need Athena's help had no conversation history
      // at all, while her own Preferences page claimed 3 remembered things
      // about her with nothing behind them.
      key: 'student-catchup', user: s[9], surface: 'student', title: 'I feel like I am behind, where do I start?', daysBack: 5,
      turns: [
        { role: 'user', text: 'I missed a couple of weeks and I do not think I ever really got bias-variance. Can you explain it simply, and tell me what I should catch up on first?' },
        { role: 'assistant', text:
          `Start with bias-variance, it is the idea everything else in this course builds on. Bias is your model being too simple to capture the real pattern — it is wrong in the same way every time. Variance is your model being too sensitive to the specific data it was trained on — it changes a lot if you trained it again on a slightly different sample. A good model finds the point where both are small, not where either one is zero.\n\n` +
          `Given where you are, I would go in this order: bias-variance first (you need it to understand everything after), then the train/validation/test split (Quiz 2 covered this and you missed it), then classification metrics. Homework 4 uses trees and ensembles, which lean on the bias-variance idea directly, so understanding it will make that easier too.` },
        { role: 'user', text: 'Is there a way to make up Quiz 2 or is it just gone?' },
        { role: 'assistant', text:
          `That is a question for Professor Vasquez directly — I cannot reopen a quiz or change a deadline. What I can do is help you actually learn the material it covered so you are not walking into the midterm with a gap. Want to start with a few practice questions on the train/validation/test split?` },
      ],
    },
  ]

  const convoRows: Record<string, unknown>[] = []
  const messageRows: Record<string, unknown>[] = []

  for (const c of convos) {
    const id = det(`athena-convo-${c.key}`)
    convoRows.push({
      id,
      institution_id: INSTITUTION_ID,
      section_id: main.id,
      user_id: c.user.id,
      title: c.title,
      title_locked: true,
      summary: null,
      is_archived: false,
      surface: c.surface,
      studio_surface: c.surface === 'studio' ? (c.studioSurface ?? 'general') : null,
      studio_kind: c.surface === 'studio' ? (c.studioKind === undefined ? 'quiz' : c.studioKind) : null,
      assignment_id: c.surface === 'studio' ? (c.assignmentId ?? null) : null,
      quiz_id: c.surface === 'studio' ? (c.quizId ?? null) : null,
      mode: 'standard',
      created_at: daysAgo(c.daysBack, 10),
      updated_at: daysAgo(c.daysBack, 11),
    })
    c.turns.forEach((t, i) => {
      messageRows.push({
        id: det(`athena-msg-${c.key}-${i}`),
        conversation_id: id,
        institution_id: INSTITUTION_ID,
        section_id: main.id,
        user_id: c.user.id,
        role: t.role,
        parts: t.role === 'user' ? text(t.text) : [{ type: 'step-start' }, { type: 'text', text: t.text, state: 'done' }],
        order_index: i,
        created_at: daysAgo(c.daysBack, 10 + i),
      })
    })
  }

  // `trg_athena_conversations_updated_at` stamps now() on every UPDATE, so an
  // upsert on a re-run makes every conversation read "30 minutes ago". Delete
  // first (messages cascade) so these are always INSERTs and the seeded
  // timestamps survive.
  await db.from('athena_conversations').delete().eq('institution_id', INSTITUTION_ID)
  await up('athena_conversations', convoRows)
  await up('athena_messages', messageRows)
  ok(`Athena: ${convoRows.length} conversations (professor, studio, student), ${messageRows.length} messages`)
}

// ── Student tutor history ─────────────────────────────────────────────

async function seedTutor(campus: Campus) {
  const main = campus.main
  const s = main.students
  const convos = [
    {
      key: 'ridge', student: s[1], title: 'Ridge vs lasso',
      turns: [
        { role: 'user', text: 'What is the actual difference between ridge and lasso? Both are just penalties.' },
        { role: 'assistant', text: 'Both add a penalty, but the shape of the penalty decides where the optimum can land. Ridge penalises squared coefficients, so the constraint region is a smooth ball and the solution slides toward the origin without reaching it. Lasso penalises absolute values, so the region is a diamond with corners sitting on the axes, and optima land on corners often. A corner means a coefficient is exactly zero.' },
      ],
    },
    {
      key: 'cv', student: s[4], title: 'Why nested cross-validation',
      turns: [
        { role: 'user', text: 'Why is a normal cross-validation score not enough if I tuned hyperparameters?' },
        { role: 'assistant', text: 'Because you used the same folds to choose and to measure. Each fold score carries noise; picking the maximum over many of them partly picks the luckiest noise. Nested cross-validation puts the tuning inside an outer loop, so the outer score never sees the data used to choose.' },
      ],
    },
  ]
  const convoRows = convos.map((c) => ({
    id: det(`tutor-convo-${c.key}`),
    student_id: c.student.id,
    section_id: main.id,
    title: c.title,
    metadata: {},
    created_at: daysAgo(12, 20),
    updated_at: daysAgo(12, 21),
  }))
  const msgRows = convos.flatMap((c) =>
    c.turns.map((t, i) => ({
      id: det(`tutor-msg-${c.key}-${i}`),
      conversation_id: det(`tutor-convo-${c.key}`),
      role: t.role,
      content: t.text,
      metadata: {},
      created_at: daysAgo(12, 20 + i),
    })),
  )
  await up('ai_conversations', convoRows)
  await up('ai_messages', msgRows)
  ok(`AI tutor: ${convoRows.length} conversations, ${msgRows.length} messages`)
}

// ── Memory ────────────────────────────────────────────────────────────

async function seedMemory(campus: Campus) {
  const main = campus.main
  const rows: Record<string, unknown>[] = []

  const slots: Array<{ kind: string; text: string; value: Record<string, unknown> }> = [
    { kind: 'explanation_style', text: 'Prefers a worked example before the general rule.', value: { style: 'example_first' } },
    { kind: 'answer_length', text: 'Wants short answers — three sentences unless asked for more.', value: { length: 'short' } },
    { kind: 'context', text: 'Is doing the project on hospital readmission data.', value: { topic: 'healthcare' } },
    { kind: 'constraint', text: 'Has no GPU; wants solutions that run on a laptop CPU.', value: { hardware: 'cpu_only' } },
    { kind: 'explanation_style', text: 'Asks for the intuition before the notation.', value: { style: 'intuition_first' } },
    { kind: 'context', text: 'Is taking this alongside a databases course and likes SQL analogies.', value: { background: 'databases' } },
  ]

  main.students.forEach((st, i) => {
    // Two or three stated preferences each, well under the 10-per-slot quota trigger.
    const count = 2 + (i % 2)
    for (let k = 0; k < count; k++) {
      const slot = slots[(i + k) % slots.length]
      rows.push({
        id: det(`memory-${st.key}-${k}`),
        user_id: st.id,
        institution_id: INSTITUTION_ID,
        section_id: main.id,
        kind: slot.kind,
        value: slot.value,
        text: slot.text,
        source: k === 0 ? 'stated' : 'stated:inferred',
        observed_at: daysAgo(20 - i - k, 15),
      })
    }
  })

  // The professor has preferences too.
  rows.push({
    id: det('memory-prof-1'),
    user_id: main.professor.id,
    institution_id: INSTITUTION_ID,
    section_id: main.id,
    kind: 'answer_length',
    value: { length: 'brief' },
    text: 'Wants the answer first and the reasoning after, not the other way round.',
    source: 'stated',
    observed_at: daysAgo(14, 10),
  })

  await up('user_memory', rows)
  ok(`memory: ${rows.length} stated preferences across ${main.students.length + 1} people`)
}

// ── Insight summaries ─────────────────────────────────────────────────

async function seedInsightSummaries(campus: Campus, grades: Assessments) {
  const main = campus.main
  const students = main.students

  const masteryPctOf = (key: string): number => {
    const m = grades.masteryByStudent.get(key)
    if (!m || m.size === 0) return 0
    return Math.round([...m.values()].reduce((a, b) => a + b, 0) / m.size)
  }
  const classMastery = Math.round(
    students.reduce((a, st) => a + masteryPctOf(st.key), 0) / Math.max(1, students.length),
  )
  const classQuizAvg = Math.round(
    students.reduce((a, st) => a + (grades.quizAvgByStudent.get(st.key) ?? 0), 0) / Math.max(1, students.length),
  )

  const studentRows = students.map((st) => {
    const m = grades.masteryByStudent.get(st.key) ?? new Map<string, number>()
    const entries = [...m.entries()].sort((a, b) => a[1] - b[1])
    const masteryPct = masteryPctOf(st.key)
    const quizAvg = grades.quizAvgByStudent.get(st.key) ?? null
    const counts = {
      mastered: [...m.values()].filter((v) => v >= 85).length,
      in_progress: [...m.values()].filter((v) => v >= 40 && v < 85).length,
      review_next: [...m.values()].filter((v) => v < 40).length,
      not_started: 0,
    }
    return {
      id: det(`student-insight-${st.key}`),
      institution_id: INSTITUTION_ID,
      section_id: main.id,
      student_id: st.id,
      summary:
        masteryPct >= 75
          ? `${st.first} is tracking above the class on most topics. The weakest area is ${entries[0]?.[0] ?? 'none'}, which is worth a nudge but not a concern.`
          : masteryPct >= 50
            ? `${st.first} is roughly at the class average. ${entries[0]?.[0] ?? 'Their weakest topic'} is the gap worth closing before the project deadline.`
            : `${st.first} is behind on several foundation topics, ${entries[0]?.[0] ?? 'the basics'} most of all. Worth a direct conversation rather than another resource link.`,
      facts: {
        version: 2,
        masteryPct,
        classMasteryPct: classMastery,
        quizAvg,
        counts,
        weakestSkills: entries.slice(0, 3).map(([name, score]) => ({ name, score })),
        lateCount: 0,
        lateQuizzes: [],
        lateAssignments: [],
        fumbledCount: 0,
        fumbledQuestions: [],
        materialsOpened: { opened: Math.round(WEEKS_IN * 0.7), total: WEEKS_IN, pct: 70 },
        classMaterialsOpenedPct: 68,
      },
      signal_hash: det(`insight-hash-${st.key}`).slice(0, 16),
      model: 'demo-seed',
      generated_at: daysAgo(1, 6),
    }
  })
  await up('student_insight_summaries', studentRows)

  // Class-level skill roll-up, from the same per-student numbers.
  const skillNames = [...(grades.masteryByStudent.get(students[0].key)?.keys() ?? [])]
  const skillAvg = skillNames
    .map((name) => ({
      name,
      score: Math.round(
        students.reduce((a, st) => a + (grades.masteryByStudent.get(st.key)?.get(name) ?? 0), 0) / students.length,
      ),
      atRisk: students.filter((st) => (grades.masteryByStudent.get(st.key)?.get(name) ?? 0) < 50).length,
    }))
    .sort((a, b) => a.score - b.score)

  const byMastery = students
    .map((st) => ({ st, mastery: masteryPctOf(st.key), quiz: grades.quizAvgByStudent.get(st.key) ?? 0 }))
    .sort((a, b) => a.mastery - b.mastery)

  await up('class_insight_summaries', [
    {
      id: det('class-insight'),
      institution_id: INSTITUTION_ID,
      section_id: main.id,
      summary:
        `The class is averaging ${classMastery}% mastery and ${classQuizAvg}% on quizzes. ` +
        `The weakest shared topic is ${skillAvg[0]?.name ?? 'none'} at ${skillAvg[0]?.score ?? 0}%, ` +
        `which ${skillAvg[0]?.atRisk ?? 0} students are below 50% on. ` +
        `${byMastery.filter((x) => x.mastery < 50).length} students need attention before the project deadline.`,
      facts: {
        version: 1,
        totalStudents: students.length,
        classMasteryPct: classMastery,
        classQuizAvg,
        excelling: byMastery.filter((x) => x.mastery >= 80).length,
        onTrack: byMastery.filter((x) => x.mastery >= 50 && x.mastery < 80).length,
        needsSupport: byMastery.filter((x) => x.mastery < 50).length,
        noData: 0,
        journeyCounts: {
          mastered: skillAvg.filter((s) => s.score >= 85).length,
          in_progress: skillAvg.filter((s) => s.score >= 40 && s.score < 85).length,
          review_next: skillAvg.filter((s) => s.score < 40).length,
          not_started: 0,
        },
        weakestSkills: skillAvg.slice(0, 4),
        strongestSkills: skillAvg.slice(-4).reverse(),
        needsAttention: byMastery
          .filter((x) => x.mastery < 55)
          .slice(0, 4)
          .map((x) => ({ name: `${x.st.first} ${x.st.last}`, masteryPct: x.mastery, quizAvg: x.quiz })),
        noSignalStudents: [],
      },
      signal_hash: det('class-insight-hash').slice(0, 16),
      model: 'demo-seed',
      generated_at: daysAgo(1, 6),
    },
  ])
  ok(`insight summaries: ${studentRows.length} student, 1 class (class mastery ${classMastery}%, quiz avg ${classQuizAvg}%)`)
}

// ── Feed and notifications ────────────────────────────────────────────

async function seedFeed(campus: Campus, grades: Assessments, collab: Collab) {
  const main = campus.main
  const prof = main.professor
  const students = main.students
  const base = `/student/courses/${main.id}`

  const feed: Record<string, unknown>[] = []
  const push = (
    recipient: Person,
    key: string,
    type: string,
    title: string,
    body: string | null,
    link: string,
    entity: { type: string; id: string },
    opts: { back: number; read?: boolean; actionable?: boolean; done?: boolean; dueIn?: number } = { back: 1 },
  ) => {
    feed.push({
      id: det(`feed-${key}-${recipient.key}`),
      recipient_id: recipient.id,
      actor_id: prof.id,
      institution_id: INSTITUTION_ID,
      section_id: main.id,
      type,
      title,
      body,
      link_url: link,
      entity_type: entity.type,
      entity_id: entity.id,
      is_read: opts.read ?? false,
      read_at: opts.read ? daysAgo(opts.back, 18) : null,
      is_actionable: opts.actionable ?? false,
      is_done: opts.done ?? false,
      done_at: opts.done ? daysAgo(opts.back, 20) : null,
      due_at: opts.dueIn != null ? daysAgo(-opts.dueIn, 19) : null,
      metadata: {},
      created_at: daysAgo(opts.back, 9),
    })
  }

  // Named from the same offset the notification's own due_at uses (dueIn below)
  // rather than a fixed day — a hardcoded "Sunday" agrees with the real due
  // date only on the one day of the week that makes the math work out.
  const hw5Weekday = weekdayName(daysAgo(-6, 19))
  const quiz4Weekday = weekdayName(daysAgo(-4, 19))

  students.forEach((st, i) => {
    push(st, 'hw5', 'assignment_published', 'Homework 5 is open', `Due ${hw5Weekday} at 11:59 PM.`,
      `${base}/assignments/${grades.assignmentIds.open}`, { type: 'assignment', id: grades.assignmentIds.open },
      { back: 5, read: i % 3 !== 0, actionable: true, done: i % 3 === 0, dueIn: 6 })
    push(st, 'quiz4', 'quiz_published', 'Quiz 4 is open', `Closes ${quiz4Weekday}. Ten minutes once you start.`,
      `${base}/quizzes/${grades.quizIds.open}`, { type: 'quiz', id: grades.quizIds.open },
      { back: 3, read: i % 2 === 0, actionable: true, done: i % 2 === 0, dueIn: 4 })
    push(st, 'hw2grade', 'assignment_graded', 'Homework 2 has been graded', 'Rubric feedback is on your submission.',
      `${base}/assignments/${grades.assignmentIds.graded[1]}`, { type: 'assignment', id: grades.assignmentIds.graded[1] },
      { back: 2, read: i % 4 !== 0 })
    push(st, 'ann', 'announcement_posted', 'Homework 2 grades are released', null,
      `${base}/announcements`, { type: 'announcement', id: det('ann-grades') },
      { back: 2, read: i % 3 === 0 })
  })

  // The professor's own feed: things waiting on them.
  push(prof, 'regrade', 'regrade_requested', 'Regrade request on Homework 3', `${students[6].first} ${students[6].last} disputed criterion 2.1.`,
    `/professor/courses/${main.id}/assignments/${grades.assignmentIds.graded[2]}`,
    { type: 'regrade_request', id: det('regrade-1') }, { back: 18, read: true, actionable: true, done: true })
  push(prof, 'teamreq', 'team_invite', 'A student asked to join Shelf Life', null,
    `/professor/courses/${main.id}/projects/${collab.projectId}`,
    { type: 'team', id: collab.teamIds[2] }, { back: 2, actionable: true })
  push(prof, 'insights', 'class_insights_refreshed', 'Class insights are up to date', 'Mastery and quiz averages refreshed overnight.',
    `/professor/courses/${main.id}/intel`, { type: 'section', id: main.id }, { back: 1 })

  await up('feed_items', feed)

  // Bell notifications are a separate, narrower stream: mentions and DMs only.
  const notifications: Record<string, unknown>[] = [
    {
      id: det('notif-dm-1'),
      recipient_id: prof.id,
      actor_id: students[0].id,
      kind: 'dm',
      title: `${students[0].first} ${students[0].last} sent you a message`,
      body: 'Hi Professor — I am going to miss Thursday, I have a clinic appointment.',
      link_url: '/messages',
      is_read: true,
      read_at: daysAgo(5, 12),
      metadata: {},
      created_at: daysAgo(5, 11),
    },
    {
      id: det('notif-mention-1'),
      recipient_id: students[6].id,
      actor_id: students[1].id,
      kind: 'chat_mention',
      title: `${students[1].first} mentioned you in project-chat`,
      body: 'PSA for everyone: check whether your status/outcome fields are populated after the event.',
      link_url: `${base}/discussions`,
      is_read: false,
      metadata: {},
      created_at: daysAgo(20, 15),
    },
    {
      id: det('notif-dm-2'),
      recipient_id: students[1].id,
      actor_id: campus.roster.assistants[0].id,
      kind: 'dm',
      title: `${campus.roster.assistants[0].first} replied to you`,
      body: 'Until Friday. Open it from the submission page rather than messaging me.',
      link_url: '/messages',
      is_read: false,
      metadata: {},
      created_at: daysAgo(12, 11),
    },
  ]
  await up('app_notifications', notifications)
  ok(`feed: ${feed.length} items, ${notifications.length} bell notifications`)
}

// ── Telemetry ─────────────────────────────────────────────────────────

/** Analytics dashboards read `events`. Without a history the engagement charts
 *  render as a flat line, which is the one chart a client always looks at. */
async function seedEvents(campus: Campus) {
  const main = campus.main
  const people = [...main.students, main.professor]
  const kinds: Array<[string, string]> = [
    ['page_view', 'navigation'],
    ['module_item_opened', 'content'],
    ['quiz_started', 'assessment'],
    ['assignment_viewed', 'assessment'],
    ['announcement_read', 'communication'],
    ['live_classroom_joined', 'live_classroom'],
  ]

  const rows: Record<string, unknown>[] = []
  for (const p of people) {
    const r = rng(`events-${p.key}`)
    // Roughly daily activity across the elapsed term, heavier near deadlines.
    for (let day = WEEKS_IN * 7; day >= 0; day--) {
      const weekday = new Date(NOW.getTime() - day * 86_400_000).getUTCDay()
      if (weekday === 0 || weekday === 6) { if (r() > 0.25) continue }
      const n = 1 + Math.floor(r() * 4)
      for (let k = 0; k < n; k++) {
        const [type, category] = kinds[Math.floor(r() * kinds.length)]
        rows.push({
          id: det(`event-${p.key}-${day}-${k}`),
          user_id: p.id,
          section_id: main.id,
          event_type: type,
          event_category: category,
          metadata: {},
          timestamp: daysAgo(day, 9 + Math.floor(r() * 11)),
          device_type: r() > 0.72 ? 'mobile' : 'desktop',
          page_url: `/student/courses/${main.id}`,
        })
      }
    }
  }
  await up('events', rows)
  ok(`telemetry: ${rows.length} events across ${WEEKS_IN} weeks`)
}

// ── Feedback ──────────────────────────────────────────────────────────

async function seedFeedback(campus: Campus) {
  const main = campus.main
  await up('feedbacks', [
    {
      id: det('feedback-1'),
      user_id: main.students[2].id,
      user_role: 'student',
      rating: 3,
      category: 'general',
      message: 'The mastery view is the first thing that has actually told me what to revise instead of just showing me a grade.',
      page_url: `/student/courses/${main.id}/roadmap`,
      page_context: {},
      status: 'reviewed',
      institution_id: INSTITUTION_ID,
      created_at: daysAgo(9, 20),
    },
    {
      id: det('feedback-2'),
      user_id: main.professor.id,
      user_role: 'professor',
      rating: 3,
      category: 'feature_request',
      message: 'Being able to see the session report right after class ends has changed how I plan the next one. Would like it emailed to me too.',
      page_url: `/professor/courses/${main.id}/live-classroom`,
      page_context: {},
      status: 'new',
      institution_id: INSTITUTION_ID,
      created_at: daysAgo(4, 16),
    },
    {
      id: det('feedback-3'),
      user_id: main.students[7].id,
      user_role: 'student',
      rating: 2,
      category: 'ux',
      message: 'On my phone the quiz timer is hidden behind the keyboard when I type a short answer.',
      page_url: `/student/courses/${main.id}/quizzes`,
      page_context: {},
      status: 'new',
      institution_id: INSTITUTION_ID,
      created_at: daysAgo(6, 22),
    },
  ])
  ok('3 pieces of in-app feedback')
}

// ── Entry point ───────────────────────────────────────────────────────

export async function seedAi(campus: Campus, grades: Assessments, collab: Collab) {
  phase('Athena, memory, insights, notifications, telemetry')
  await seedAthena(campus, grades)
  await seedTutor(campus)
  await seedMemory(campus)
  await seedInsightSummaries(campus, grades)
  await seedFeed(campus, grades, collab)
  await seedEvents(campus)
  await seedFeedback(campus)
}
