// Live Classroom: past sessions with decks, transcripts, attendance, polls,
// in-class quizzes, student questions, annotations, notes, and the
// post-session reports.
//
// The reports are NOT hand-written JSON. They are produced by the same
// computeSessionStats / computeStudentInsights the app calls, fed the rows this
// file just inserted. That is the only way to guarantee the report agrees with
// the attendance list and the poll results sitting next to it on screen.

import {
  db, det, up, ok, phase, warn,
  WEEKS_IN, TERM_START, NOW, onWeekday, daysAgo, rng,
} from './context'
import type { Campus } from './roster'
import { WEEKS } from './curriculum'
import type { ContentIds } from './content'
import type { Assessments } from './assessments'
import { makeSlidePdf, upload, renderDeckPages } from './files'
import { computeSessionStats, type SessionReportInput } from '@/lib/live-classroom/report/compute'
import { computeStudentInsights } from '@/lib/live-classroom/insights/compute-student'

/** Four note-taking habits, applied by seat position so a student writes the
 *  same way every week. Each pulls from a different part of the real lecture,
 *  so no two notes in a room share a sentence and none of them repeats across
 *  the term — the content varies because the week's slides do. */
const NOTE_STYLES: Array<(w: (typeof WEEKS)[number]) => string> = [
  // The one who writes down the definition and flags what to follow up on.
  (w) =>
    `${w.slides[0].heading} — ${w.slides[0].bullets[0]}. ${w.slides[0].bullets[1] ?? w.blurb} Ask about this in office hours before the next quiz.`,
  // The bullet-list taker: whatever was on the second slide, compressed.
  (w) =>
    `${w.slides[1]?.heading ?? w.topic}\n· ${(w.slides[1]?.bullets ?? [w.blurb]).join('\n· ')}`,
  // The one who records the caveat rather than the claim.
  (w) => {
    const caution = w.slides[2] ?? w.slides[w.slides.length - 1]
    return `Careful with: ${caution.bullets[0]}. ${caution.bullets[1] ?? ''} He said this is where people lose marks, so worth rereading.`.trim()
  },
  // The one taking notes for the exam, tying the week back to the topic.
  (w) =>
    `Week ${w.n} (${w.topic}): ${w.blurb} Main thing to remember is "${w.slides[1]?.bullets[0] ?? w.slides[0].bullets[0]}". Likely exam material.`,
]

const DECK_BUCKET = 'live-classroom-decks'
const WEEK_MS = 7 * 86_400_000

/** Session dates land on the section's real meeting days, so the session list
 *  agrees with the schedule shown beside it. */
function sessionDates(meetingDays: number[], meetingHour: number): Date[] {
  const out: Date[] = []
  for (let w = 0; w < WEEKS_IN; w++) {
    const weekStart = new Date(TERM_START.getTime() + w * WEEK_MS)
    // The first meeting day of each week; the class meets twice but only the
    // main lecture is recorded here.
    const d = onWeekday(weekStart, meetingDays[0], meetingHour)
    if (d.getTime() < NOW.getTime()) out.push(d)
  }
  return out
}

export async function seedClassroom(campus: Campus, content: ContentIds, grades: Assessments) {
  phase('Live Classroom sessions and reports')

  const main = campus.main
  const prof = main.professor
  const students = main.students
  const dates = sessionDates(main.meetingDays, main.meetingHour)

  const roomRows: Record<string, unknown>[] = []
  const deckRows: Record<string, unknown>[] = []
  const transcriptRows: Record<string, unknown>[] = []
  const attendanceRows: Record<string, unknown>[] = []
  const interactionRows: Record<string, unknown>[] = []
  const responseRows: Record<string, unknown>[] = []
  const annotationRows: Record<string, unknown>[] = []
  const noteRows: Record<string, unknown>[] = []
  const reportRows: Record<string, unknown>[] = []
  const studentInsightRows: Record<string, unknown>[] = []
  const transcriptInsightRows: Record<string, unknown>[] = []

  let rendered = 0

  for (let i = 0; i < dates.length; i++) {
    const week = WEEKS[i]
    const started = dates[i]
    const ended = new Date(started.getTime() + 80 * 60_000)
    const roomId = det(`room-${i}`)
    const deckId = det(`deck-${i}`)
    const deckVersion = String(1_700_000_000_000 + i)
    const r = rng(`room-${i}`)

    // ── The deck: a real PDF, rendered to the page images the viewer reads ──
    const pdf = makeSlidePdf(`Week ${week.n} — ${week.topic}`, `CS 340 · ${week.blurb}`, week.slides)
    const pageCount = week.slides.length + 1
    const prefix = `${roomId}/${deckId}/${deckVersion}`
    let deckUrl: string | null = null
    try {
      await upload(DECK_BUCKET, `${roomId}/${deckId}/source.pdf`, pdf, 'application/pdf')
      const n = await renderDeckPages(pdf, DECK_BUCKET, prefix, pageCount)
      if (n) {
        deckUrl = `${DECK_BUCKET}/${prefix}`
        rendered++
      }
    } catch (err) {
      warn(`week ${week.n} deck upload failed (${(err as Error).message})`)
    }

    const maxSlide = pageCount - 1
    // created_at == started_at on purpose. The session-list card derives its
    // duration from `created_at` while the report uses `started_at`, so any
    // setup window showed one class with two different lengths ("1h 45m" on the
    // card, "1h 20m" one click later). The app should use started_at; until it
    // does, not opening a gap is the honest demo.
    deckRows.push({
      id: deckId,
      room_id: roomId,
      position: 1,
      title: `Week ${week.n} — ${week.topic}`,
      deck_url: deckUrl,
      page_count: pageCount,
      current_slide: maxSlide,
      max_slide: maxSlide,
      module_item_id: content.lectureItemByWeek.get(week.n) ?? null,
      source_file_path: `${roomId}/${deckId}/source.pdf`,
      extraction: {
        jobId: det(`extract-${i}`),
        error: null,
        pages: [
          { text: `Week ${week.n} — ${week.topic}. CS 340. ${week.blurb}` },
          ...week.slides.map((s) => ({ text: `${s.heading}. ${s.bullets.join('. ')}.` })),
        ],
      },
      created_at: started.toISOString(),
    })

    // ── Room ──
    // Inserted directly as 'ended'. Going live-then-ended would fire the realtime
    // broadcast triggers for a class that is months in the past.
    roomRows.push({
      id: roomId,
      section_id: main.id,
      prof_id: prof.id,
      status: 'ended',
      name: `Week ${week.n} — ${week.topic}`,
      deck_url: deckUrl,
      deck_page_count: pageCount,
      current_slide: maxSlide,
      module_item_id: content.lectureItemByWeek.get(week.n) ?? null,
      source_file_path: `${roomId}/${deckId}/source.pdf`,
      lecture_summary_enabled: true,
      setup_completed: true,
      created_at: started.toISOString(),
      started_at: started.toISOString(),
      ended_at: ended.toISOString(),
      lecture_summary: {
        text:
          `### ${week.topic}\n` +
          week.slides
            .map((s) => `*   **${s.heading}:** ${s.bullets.join('; ')}.`)
            .join('\n'),
      },
    })

    // ── Transcript, one entry per slide (page_number is 0-based) ──
    week.transcript.forEach((text, p) => {
      transcriptRows.push({
        id: det(`transcript-${i}-${p}`),
        room_id: roomId,
        deck_id: deckId,
        page_number: p,
        text,
        updated_at: new Date(started.getTime() + p * 9 * 60_000).toISOString(),
      })
    })

    // ── Attendance: ~85% present, a couple late, one student often absent ──
    const present: string[] = []
    students.forEach((st, si) => {
      const chronic = si === 9
      const show = chronic ? r() < 0.55 : r() < 0.93
      if (!show) return
      const late = r() < 0.18
      // Never before the class starts: a negative offset credited students with
      // more attended minutes than the session's own stated duration.
      const joined = new Date(started.getTime() + (late ? 14 : si % 4) * 60_000)
      present.push(st.id)
      attendanceRows.push({
        room_id: roomId,
        student_id: st.id,
        joined_at: joined.toISOString(),
        last_seen_at: new Date(ended.getTime() - (r() < 0.15 ? 12 : 1) * 60_000).toISOString(),
      })
    })

    // ── A poll ──
    const pollId = det(`poll-${i}`)
    const pollChoices = [
      { id: 'c1', text: 'Completely clear' },
      { id: 'c2', text: 'Mostly, one part fuzzy' },
      { id: 'c3', text: 'Lost about halfway' },
      { id: 'c4', text: 'Please go over it again' },
    ]
    const pollCounts: Record<string, number> = {}
    present.forEach((sid, pi) => {
      const ability = grades.abilityByStudent.get(students.find((s) => s.id === sid)!.key) ?? 0.7
      const choice = ability > 0.8 ? 'c1' : ability > 0.6 ? (pi % 3 === 0 ? 'c1' : 'c2') : pi % 2 === 0 ? 'c3' : 'c4'
      pollCounts[choice] = (pollCounts[choice] ?? 0) + 1
      responseRows.push({
        id: det(`poll-resp-${i}-${sid}`),
        interaction_id: pollId,
        student_id: sid,
        response: { choiceIds: [choice] },
        submitted_at: new Date(started.getTime() + 34 * 60_000).toISOString(),
      })
    })
    interactionRows.push({
      id: pollId,
      room_id: roomId,
      kind: 'poll',
      status: 'closed',
      created_by: prof.id,
      payload: {
        // Slide headings already start with their own article ("The confusion
        // matrix"), so prefixing "the" produced "How well did the the confusion
        // matrix land?". Use the heading as written.
        question: `How well did "${week.slides[1]?.heading ?? 'the last section'}" land?`,
        pollType: 'single_choice',
        choices: pollChoices,
        counts: pollCounts,
      },
      created_at: new Date(started.getTime() + 30 * 60_000).toISOString(),
      opened_at: new Date(started.getTime() + 31 * 60_000).toISOString(),
      closed_at: new Date(started.getTime() + 36 * 60_000).toISOString(),
      last_aggregate_at: new Date(started.getTime() + 36 * 60_000).toISOString(),
    })

    // ── An in-class quiz, concept-tagged ──
    //
    // FOUR questions, not two, and this is a correctness requirement rather than
    // a taste one. The report flags a student atRisk below 60% accuracy, so on a
    // two-question quiz getting one right scores 50% and flags them — which put
    // 8 of 12 students in the at-risk list and made the feature look broken.
    // Four questions give 0/25/50/75/100, so a student who knows most of it
    // lands above the line where they belong.
    const quizId = det(`lcquiz-${i}`)
    const qs = Array.from({ length: 4 }, (_, qi) => {
      const skill = week.skills[qi % week.skills.length]
      const slide = week.slides[qi % week.slides.length]
      const other = week.slides[(qi + 1) % week.slides.length]
      return {
        id: `q${qi + 1}`,
        prompt:
          qi % 2 === 0
            ? `Which statement about ${skill.toLowerCase()} is correct?`
            : `Following on from ${slide.heading.toLowerCase()} — which of these holds?`,
        // Rotate which letter is correct. Always putting the true statement
        // first is the kind of pattern a professor spots in the first minute of
        // a demo, and it makes the answer distribution look fabricated.
        choices: ['a', 'b', 'c'].map((letter, ci) => ({
          id: letter,
          text:
            [
              slide.bullets[0] ?? 'It always applies',
              other.bullets[0] ?? 'It never applies',
              slide.bullets[1] ?? other.bullets[1] ?? 'Neither of the above',
            ][(ci - qi + 3) % 3],
        })),
        correctChoiceId: ['a', 'b', 'c'][qi % 3],
        concept: skill,
        explanation: `See the ${slide.heading} slide — this follows directly from it.`,
      }
    })
    let submissions = 0
    present.forEach((sid) => {
      const st = students.find((s) => s.id === sid)!
      const ability = grades.abilityByStudent.get(st.key) ?? 0.7
      const rr = rng(`lcquiz-${i}-${st.key}`)
      // A few students still sit it out — but not so many that "answered
      // nothing" becomes the ordinary case, since that alone flags them.
      if (rr() > 0.93) return
      submissions++
      // How many they get right is driven by ability with a little jitter, NOT by
      // an independent coin flip per question. Independent flips give a capable
      // student a real chance of scoring 2 of 4, which is below the report's
      // 60% struggle threshold — so the at-risk list filled up with students who
      // were simply unlucky, and the panel stopped meaning anything.
      const correctCount = Math.max(
        0,
        Math.min(qs.length, Math.round(ability * qs.length + (rr() - 0.5) * 1.1)),
      )
      // Vary WHICH ones they miss, so every wrong answer is not on question 4.
      const offset = Math.floor(rr() * qs.length)
      const answers: Record<string, string> = {}
      qs.forEach((q, qi) => {
        const rank = (qi + offset) % qs.length
        if (rank < correctCount) {
          answers[q.id] = q.correctChoiceId
          return
        }
        // Spread the wrong answers across the distractors rather than everyone
        // picking the same one, so the per-question breakdown looks real.
        const wrong = q.choices.filter((c) => c.id !== q.correctChoiceId)
        answers[q.id] = wrong[Math.floor(rr() * wrong.length)].id
      })
      responseRows.push({
        id: det(`lcquiz-resp-${i}-${sid}`),
        interaction_id: quizId,
        student_id: sid,
        response: { answers },
        submitted_at: new Date(started.getTime() + 58 * 60_000).toISOString(),
      })
    })
    interactionRows.push({
      id: quizId,
      room_id: roomId,
      kind: 'quiz',
      status: 'closed',
      created_by: prof.id,
      payload: {
        title: `${week.topic} — concept check`,
        questions: qs,
        timeLimitSeconds: 120,
        counts: { submissions },
      },
      created_at: new Date(started.getTime() + 54 * 60_000).toISOString(),
      opened_at: new Date(started.getTime() + 55 * 60_000).toISOString(),
      closed_at: new Date(started.getTime() + 59 * 60_000).toISOString(),
      last_aggregate_at: new Date(started.getTime() + 59 * 60_000).toISOString(),
    })

    // ── Student questions ──
    // Nine sessions carrying the same two verbatim questions with the same
    // upvote counts is the clearest "this is fixture data" tell on the report.
    const GENERIC_QUESTIONS = [
      'Does this still hold if the rows are not independent?',
      'Is there a worked example of this in the notes?',
      'How would this change with a much smaller dataset?',
      'Is this the part that shows up on the homework?',
      'Can you say more about where this breaks down?',
      'What would you use instead in industry?',
      'Does the library do this for us, or do we implement it?',
      'Is this going to be on the midterm?',
      'How do we know the baseline is a fair one here?',
    ]
    const questions = [
      { text: `Can you go over ${week.slides[2]?.heading.toLowerCase() ?? 'the last point'} again?`, anon: false, answered: true, up: 2 + (i % 5) },
      { text: GENERIC_QUESTIONS[i % GENERIC_QUESTIONS.length], anon: true, answered: true, up: 3 + ((i * 2) % 6) },
      { text: GENERIC_QUESTIONS[(i + 4) % GENERIC_QUESTIONS.length], anon: false, answered: i % 3 !== 0, up: 1 + (i % 3) },
    ]
    questions.forEach((q, qi) => {
      const asker = students[(i + qi) % students.length]
      interactionRows.push({
        id: det(`question-${i}-${qi}`),
        room_id: roomId,
        kind: 'question',
        status: 'closed',
        created_by: q.anon ? prof.id : asker.id,
        payload: {
          text: q.text,
          upvotes: q.up,
          answered: q.answered,
          anonymous: q.anon,
          upvotedBy: [],
          answeredBy: q.answered ? prof.id : null,
          authorName: q.anon ? null : `${asker.first} ${asker.last}`,
        },
        created_at: new Date(started.getTime() + (20 + qi * 15) * 60_000).toISOString(),
      })
    })

    // ── Ink on the slides ──
    for (let a = 0; a < 3; a++) {
      annotationRows.push({
        id: det(`annotation-${i}-${a}`),
        room_id: roomId,
        deck_id: deckId,
        slide_index: 1 + a,
        author_id: prof.id,
        stroke: {
          color: '#ef4444',
          width: 4,
          points: Array.from({ length: 8 }, (_, p) => ({ x: 0.2 + p * 0.06, y: 0.4 + (p % 2) * 0.05 })),
        },
        created_at: new Date(started.getTime() + (25 + a * 10) * 60_000).toISOString(),
      })
    }

    // ── Student notes ──
    // Three of the four note-takers per session used to share one string, so
    // the same sentence appeared verbatim across students and across weeks —
    // the most visible tell in the tenant after the submission PDFs. Each
    // note-taker now reads a different part of the same real lecture, which is
    // what four people in one room actually produce. NOTE_STYLES is indexed by
    // position, so a given student keeps a consistent habit all term rather
    // than writing like a different person each week.
    students.slice(0, 4).forEach((st, si) => {
      noteRows.push({
        room_id: roomId,
        student_id: st.id,
        content: NOTE_STYLES[si](week),
        created_at: new Date(started.getTime() + 40 * 60_000).toISOString(),
        updated_at: ended.toISOString(),
      })
    })

    // Recordings are deliberately NOT seeded. There is no media file behind a
    // seeded row, and a recording marked 'ready' renders an empty ~470px video
    // player — the largest element on every session report and on the student
    // insights page. No row means the surface simply omits it.

    // ── Reports, computed by the app's own functions ──
    const reportInput: SessionReportInput = {
      room: { createdAt: started.toISOString(), startedAt: started.toISOString(), endedAt: ended.toISOString() },
      decks: [
        {
          id: deckId,
          title: `Week ${week.n} — ${week.topic}`,
          position: 1,
          pageCount,
          maxSlideShown: maxSlide,
          transcriptions: week.transcript.map((text, p) => ({ page_number: p, text })),
        },
      ],
      interactions: interactionRows
        .filter((x) => x.room_id === roomId)
        .map((x) => ({
          id: x.id as string,
          kind: x.kind as 'poll' | 'quiz' | 'question',
          payload: x.payload as Record<string, unknown>,
          status: x.status as 'draft' | 'open' | 'closed',
          created_by: x.created_by as string,
        })),
      responses: responseRows
        .filter((x) => {
          const iid = x.interaction_id as string
          return iid === pollId || iid === quizId
        })
        .map((x) => ({
          interaction_id: x.interaction_id as string,
          student_id: x.student_id as string,
          response: x.response as Record<string, unknown>,
        })),
      enrolledStudents: students.map((s) => ({ id: s.id, name: `${s.first} ${s.last}` })),
      attendance: attendanceRows
        .filter((x) => x.room_id === roomId)
        .map((x) => ({
          student_id: x.student_id as string,
          joined_at: x.joined_at as string,
          last_seen_at: x.last_seen_at as string,
        })),
    }

    const report = computeSessionStats(reportInput)
    report.aiNarrative =
      `The class covered ${week.topic.toLowerCase()}. ` +
      `${report.attendance.attendedCount} of ${report.attendance.enrolledCount} students attended, and ` +
      `${report.participation.activeCount} took part in a poll, quiz, or question.\n\n` +
      (report.struggleConcepts.length > 0
        ? `The weakest area was **${report.struggleConcepts[0].concept}** at ` +
          `${report.struggleConcepts[0].correctRate}% correct. Worth five minutes at the start of next class.\n\n`
        : `No concept fell below the struggle threshold this session.\n\n`) +
      `${report.qa.total} questions were asked, ${report.qa.answeredCount} of them answered in class.`

    reportRows.push({
      room_id: roomId,
      report,
      status: 'ready',
      generated_at: new Date(ended.getTime() + 6 * 60_000).toISOString(),
    })

    const insights = computeStudentInsights(reportInput)
    // computeStudentInsights() leaves the three AI parts null and sets
    // `extrasPending`, expecting an orchestrator to fill them in. Storing that
    // as-is with status 'ready' left students staring at "Writing your lecture
    // summary..." forever, because nothing was ever coming. Fill them here and
    // clear the flag.
    // Built so it reads correctly whatever the slide content is. The previous
    // template spliced a sentence fragment into "...and the practical
    // consequence is that {topic}", which was ungrammatical in all nine sessions
    // — on a student-facing screen a demo opens.
    const lastSlide = week.slides[week.slides.length - 1]
    insights.summary =
      `${week.blurb} ` +
      `We worked through ${week.slides.length} sections, from "${week.slides[0].heading}" ` +
      `to "${lastSlide.heading}". ` +
      `If you take one thing away: ${week.slides[0].bullets[0]}.`
    insights.extrasPending = false
    // The concept label has to describe THIS card. Indexing the week's skill
    // list by slide position paired "Forward pass" with "Backpropagation" — the
    // tag was consistently one card out. The slide's own heading always matches.
    insights.flashcards = week.slides.slice(0, 4).map((slide) => ({
      front: slide.heading,
      back: slide.bullets.join(' '),
      concept: slide.heading.slice(0, 60),
    }))
    insights.practiceQuiz = {
      questions: [
        {
          type: 'multiple_choice' as const,
          prompt: `Which of these best describes ${week.slides[0].heading.toLowerCase()}?`,
          options: [week.slides[0].bullets[0], week.slides[1].bullets[0], 'None of these'].slice(0, 3),
          correctAnswer: week.slides[0].bullets[0],
          explanation: `Covered on the ${week.slides[0].heading} slide.`,
          concept: week.skills[0].slice(0, 60),
        },
        {
          type: 'true_false' as const,
          prompt: `${week.slides[1].bullets[0]} — true or false?`,
          options: ['True', 'False'],
          correctAnswer: 'True',
          explanation: `Stated directly on the ${week.slides[1].heading} slide.`,
          concept: week.skills[Math.min(1, week.skills.length - 1)].slice(0, 60),
        },
        {
          type: 'short_answer' as const,
          prompt: `In one sentence, why does ${week.topic.toLowerCase()} matter in practice?`,
          options: [],
          correctAnswer: week.blurb,
          explanation: 'Compare your answer with the summary above — the wording does not need to match.',
          concept: week.skills[0].slice(0, 60),
        },
      ],
    }
    studentInsightRows.push({
      room_id: roomId,
      content: insights,
      status: 'ready',
      generated_at: new Date(ended.getTime() + 8 * 60_000).toISOString(),
    })

    // ── Transcript claims, anchored to real quotes from the transcript above ──
    const claims: Array<Record<string, unknown>> = []
    if (i % 3 === 0 && week.transcript.length > 1) {
      claims.push({
        kind: 'emphasis',
        summary: `${week.slides[1]?.heading ?? week.topic} is the idea the rest of the week builds on.`,
        quote: week.transcript[1].slice(0, 300),
        deckId,
        deckTitle: `Week ${week.n} — ${week.topic}`,
        pageNumber: 1,
        topic: week.skills[0].slice(0, 60),
      })
    }
    if (week.n === 8) {
      claims.push({
        kind: 'exam_scope',
        summary: 'The exam covers weeks 1 through 7 and is conceptual rather than recall.',
        quote: week.transcript[0].slice(0, 300),
        deckId,
        deckTitle: `Week ${week.n} — ${week.topic}`,
        pageNumber: 0,
        topic: 'midterm',
      })
    }
    transcriptInsightRows.push({
      room_id: roomId,
      insights: {
        version: 1,
        empty: false,
        claims,
        depth: week.transcript.map((t, p) => ({
          deckId,
          pageNumber: p,
          words: t.split(/\s+/).length,
          minutes: Number((t.split(/\s+/).length / 130).toFixed(2)),
        })),
        droppedClaims: 0,
      },
      status: 'ready',
      generated_at: new Date(ended.getTime() + 10 * 60_000).toISOString(),
    })
  }

  // ── The next class, scheduled but not started ──
  const nextWeek = WEEKS[Math.min(WEEKS.length - 1, dates.length)]
  const nextDate = onWeekday(new Date(NOW.getTime() + 86_400_000), main.meetingDays[0], main.meetingHour)
  roomRows.push({
    id: det('room-upcoming'),
    section_id: main.id,
    prof_id: prof.id,
    status: 'scheduled',
    name: `Week ${nextWeek.n} — ${nextWeek.topic}`,
    lecture_summary_enabled: true,
    setup_completed: false,
    scheduled_at: nextDate.toISOString(),
    created_at: daysAgo(2, 9),
  })

  // lc_rooms.active_deck_id and lc_decks.room_id reference each other, so one of
  // them has to be filled in on a second pass. Rooms go in without their active
  // deck, the decks follow, then each room is pointed at its own.
  await up('lc_rooms', roomRows)
  await up('lc_decks', deckRows)
  for (const deck of deckRows) {
    const { error } = await db
      .from('lc_rooms')
      .update({ active_deck_id: deck.id as string })
      .eq('id', deck.room_id as string)
    if (error) throw new Error(`link active deck to room: ${error.message}`)
  }
  await up('lc_transcriptions', transcriptRows)
  await up('lc_attendance', attendanceRows, 'room_id,student_id')
  await up('lc_interactions', interactionRows)
  await up('lc_responses', responseRows)
  await up('lc_slide_annotations', annotationRows)
  await up('lc_notes', noteRows, 'room_id,student_id')
  await up('lc_session_reports', reportRows, 'room_id')
  await up('lc_class_insights_student', studentInsightRows, 'room_id')
  await up('lc_transcript_insights', transcriptInsightRows, 'room_id')

  ok(
    `${dates.length} ended sessions + 1 scheduled · ${transcriptRows.length} transcript slides · ` +
      `${attendanceRows.length} attendance rows · ${interactionRows.length} interactions · ` +
      `${responseRows.length} responses`,
  )
  ok(`${reportRows.length} session reports and student insight blobs, computed by the app's own functions`)
  if (rendered === 0) warn('no deck slide images were rendered — Live Classroom replay will show no slides')
  else ok(`${rendered} decks rendered to slide images in storage`)

  // Pre-class primers are deliberately NOT seeded. Generating one needs a
  // text-to-speech call, and a primer row with no audio behind it gives the demo
  // a player that 404s. With no row, the professor sees the clean "generate
  // primer" affordance on the lecture row, which is the better thing to show.
  warn('pre-class primers not seeded (no TTS in the seed) — generate one live during the demo')
}
