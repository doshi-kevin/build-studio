/**
 * Read-only tool set for the Athena student tutor.
 *
 * The always-on state lane injects a compact weak-topic summary into every
 * prompt; these tools are the "full detail on demand" half (design doc §3 step
 * 4) — the model calls them only when a question needs the numbers, so unrelated
 * questions pay no token cost for them. Deliberately no web-search tool: v1
 * gives students no web grounding.
 *
 * Scoping is no longer per-tool discipline: every definition goes through
 * `defineStudentTool` (§13.1), which rejects any input field that could carry an
 * identifier, and every id below comes from `ctx` — built from the verified
 * session in /api/chat. Read `contract.ts` before adding one.
 */

import { z } from 'zod'
import { rankChallenges } from './challenge-match'
import { draftClassQuestion, mostRecentMiss } from './class-question'
import { draftBookingNote, nextOfficeHoursDate } from './booking-note'
import { fetchReviewableQuizzes } from './quiz-history'
import { fetchClassStatements } from './class-transcript'
import { fetchClassRecaps } from './class-recap'
import { buildStudyFocus } from '@/lib/roadmap/study-focus'
import {
  calendarQueries,
  challengeQueries,
  liveClassroomQueries,
  skillQueries,
} from '@/lib/supabase/queries'
import { MASTERY_THRESHOLDS } from '@/lib/skills/mastery'
import { fence } from '@/lib/ai/prompt-fence'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { studentRoute } from '@/lib/routes/student'
import { defineStudentTool, type AnyStudentTool, type AthenaStudentCtx } from './contract'
import { leaveStudyArtifact } from './study-artifact'
import { mapKnowledgePath } from './knowledge-map'
import { rememberPreference } from './remember-preference'

/** The columns `getPublishedChallenges` returns that the ranker actually uses. */
interface ChallengeRow {
  id: string
  title: string
  points: number | null
  bonus_points: number | null
  due_at: string | null
  difficulty: string | null
}

/** Tools take no input today — the study-focus `horizon` enum (§13.2) is the
 *  first one that will, and the contract is what makes that safe. */
const NO_INPUT = z.object({})

const getMyStudyFocus = defineStudentTool({
  name: 'get_my_study_focus',
  kind: 'read',
  label: 'What to study next',
  description:
    "Read-only: what THIS student should study next in this course — their weakest roadmap nodes (lecture/material), each with the topics it covers and their mastery on it, weakest first. It ALSO returns overallMasteryPercent, their course-wide standing across every tracked topic, so call it for \"how am I doing?\" / \"how much have I got left?\" as well as what to study. Call this whenever the student asks what to study, what to focus on, what to review, how to prepare for an exam or quiz, where they're behind, or how they're doing overall. overallMasteryPercent is null when nothing has been assessed yet — say so plainly rather than reporting 0%. Set `openTopNode: true` ONLY when the student asked to be TAKEN somewhere or to start studying (\"what should I study next\", \"take me to it\", \"where do I start\") — then the app opens the top node and you should write the answer as if they are about to see it. Leave it false for a question that only asks about STATUS (\"how am I doing\", \"what am I weak in\", \"how much is left\"): answer in words and leave them where they are. Moving a student off the page they are working on is a thing they asked for or it is an interruption.",
  /* The only tool with an input today, and it exists to separate READING the ranking
     from DRIVING the screen with it (#663). This used to navigate on every call, and its
     own description tells the model to call it for "how am I doing?" — so a student
     asking about their progress from an assignment page was silently moved to the
     roadmap. Chat-only mode already has the considered position here ("Didn't move you —
     it's ready when you are"); Co-pilot was applying a far looser trigger. */
  input: z.object({
    openTopNode: z
      .boolean()
      .default(false)
      .describe('True only when the student asked to be taken to the material, not merely about their standing.'),
  }),
  describe: (r) => (r.count === 0 ? 'nothing unmastered' : `${r.count} ranked, weakest first`),
  run: async (ctx: AthenaStudentCtx, input: { openTopNode?: boolean }) => {
    const { nodes: focus, overall } = await buildStudyFocus(ctx.adminDb, ctx.sectionId, ctx.userId)
    if (focus.length === 0) {
      return { count: 0, overallMasteryPercent: overall, nodes: [], note: 'No unmastered material — nothing to send them to.' }
    }
    /* The ranking still chooses WHICH node — the model only says whether the student
       asked to go anywhere. The key never leaves the server either way: navigation is
       the route's job. */
    if (input?.openTopNode) {
      ctx.emit({ type: 'goto_node', nodeKey: focus[0].key, title: focus[0].title })
    }
    return {
      count: focus.length,
      // Their course-wide standing, for context around the ranking below.
      overallMasteryPercent: overall,
      nodes: focus.map((n) => ({
        // Material titles and topic labels are professor- and pipeline-authored
        // free text heading into the tutor's prompt — fenced like every other
        // untrusted display string that gets there.
        material: fence(n.title, 120),
        topics: n.topics.map((t) => fence(t, 120)),
        masteryPercent: n.pct,
        standing:
          n.state === 'review_next'
            ? 'weak — review this first'
            : n.state === 'in_progress'
              ? 'started, not yet solid'
              : 'not started yet',
      })),
    }
  },
})

const getMyQuizPerformance = defineStudentTool({
  name: 'get_my_quiz_performance',
  kind: 'read',
  label: 'Your quiz scores',
  description:
    "Read-only: look up THIS student's own submitted quiz attempts in this course — quiz title, percent score, points earned/total, and date, most recent first. Call this whenever the student asks about their own grades, scores, quiz results, or how they're doing/performing on quizzes. NEVER guess or estimate a score — always call this to get the real numbers. It reads only the asking student's own attempts.",
  input: NO_INPUT,
  describe: (r) =>
    r.count === 0
      ? 'no submitted attempts'
      : `${r.count} submitted attempt${r.count === 1 ? '' : 's'}`,
  run: async (ctx: AthenaStudentCtx) => {
    const { data } = await ctx.adminDb
      .from('quiz_attempts')
      .select('status, score, earned_points, total_points, submitted_at, quiz:quizzes(title)')
      .eq('section_id', ctx.sectionId)
      .eq('student_id', ctx.userId)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false })
      .limit(10)

    const attempts = ((data ?? []) as Array<{
      score: number | null
      earned_points: number | null
      total_points: number | null
      submitted_at: string | null
      quiz: { title?: string } | { title?: string }[] | null
    }>).map((a) => {
      const quiz = resolveJoin(a.quiz)
      return {
        quiz: quiz?.title ?? 'Untitled quiz',
        scorePercent: a.score,
        earnedPoints: a.earned_points,
        totalPoints: a.total_points,
        submittedOn: a.submitted_at ? String(a.submitted_at).slice(0, 10) : null,
      }
    })
    return { count: attempts.length, attempts }
  },
})

const getMyAssignmentFeedback = defineStudentTool({
  name: 'get_my_assignment_feedback',
  kind: 'read',
  label: 'Your assignment feedback',
  description:
    "Read-only: look up THIS student's own graded assignment submissions in this course — assignment title, score, status, the professor's written feedback, and the date graded, most recent first. Call this whenever the student asks about their assignments, essays, projects, their grades or feedback on them, or what a professor said about their work. NEVER invent a grade or feedback — always call this for the real record. It reads only the asking student's own submissions.",
  input: NO_INPUT,
  describe: (r) => (r.count === 0 ? 'nothing graded yet' : `${r.count} graded`),
  run: async (ctx: AthenaStudentCtx) => {
    const { data } = await ctx.adminDb
      .from('assignment_submissions')
      .select('score, status, feedback, graded_at, assignment:assignments!inner(title, section_id)')
      .eq('student_id', ctx.userId)
      .eq('assignment.section_id', ctx.sectionId)
      .eq('status', 'graded')
      .order('graded_at', { ascending: false })
      .limit(10)

    const submissions = ((data ?? []) as Array<{
      score: number | null
      status: string | null
      feedback: string | null
      graded_at: string | null
      assignment: { title?: string } | { title?: string }[] | null
    }>).map((s) => {
      const a = resolveJoin(s.assignment)
      return {
        assignment: a?.title ?? 'Untitled assignment',
        score: s.score,
        feedback: s.feedback ?? null,
        gradedOn: s.graded_at ? String(s.graded_at).slice(0, 10) : null,
      }
    })
    return { count: submissions.length, submissions }
  },
})

const getMyQuizReview = defineStudentTool({
  name: 'get_my_quiz_review',
  kind: 'read',
  label: 'Your quiz answers',
  description:
    "Read-only: a PER-QUESTION review of THIS student's own submitted quizzes in this course — for each quiz, which questions they got right vs wrong, and for each question their answer vs the correct answer. Call this when the student asks what they got wrong, to review a quiz, to go over their mistakes, or which questions they missed. It reads only the asking student's own attempts and answers.",
  input: NO_INPUT,
  describe: (r) =>
    r.count === 0
      ? 'no reviewable attempts'
      : `${r.count} quiz${r.count === 1 ? '' : 'zes'}, question by question`,
  run: async (ctx: AthenaStudentCtx) => {
    const quizzes = await fetchReviewableQuizzes(ctx)
    return {
      count: quizzes.length,
      // `submittedAt` is an ordering signal for the caller, not something the
      // model needs in the payload.
      quizzes: quizzes.map(({ quiz, scorePercent, questions }) => ({
        quiz,
        scorePercent,
        questions,
      })),
    }
  },
})

/**
 * C14 — the first `propose` tool (§14). It reads, ranks, and drives the student
 * to the challenge board with the matching card highlighted. It does not claim
 * anything: `claimChallenge()` runs when the student clicks on the real page,
 * and re-authenticates when they do.
 */
const findMeAChallenge = defineStudentTool({
  name: 'find_me_a_challenge',
  kind: 'propose',
  label: 'A challenge that fits',
  description:
    "Propose-only: find an open challenge in this course that matches what THIS student is already strong at, and take them to it on the challenge board. Call this when the student asks for a challenge, for extra credit or bonus points, what they can win or earn, or something to do that plays to their strengths. It does NOT claim the challenge — the student claims it themselves on the page you send them to, so write the answer as if they are about to see the board with that challenge highlighted. If it reports no match, say so plainly and do not invent a challenge.",
  input: NO_INPUT,
  steps: [
    { id: 'strengths', label: 'Your strongest topics' },
    { id: 'open', label: "What's still open" },
    { id: 'match', label: 'Best fit, soonest deadline' },
  ],
  describe: () => '',
  run: async (ctx: AthenaStudentCtx, _input: unknown, plan) => {
    const [mastery, skills] = await plan.step(
      'strengths',
      () =>
        Promise.all([
          skillQueries.getStudentMasteryRows(ctx.adminDb, ctx.sectionId, ctx.userId),
          skillQueries.listSectionSkills(ctx.adminDb, ctx.sectionId),
        ]),
      ([rows]) => {
        const n = rows.filter((r) => (r.score ?? 0) >= MASTERY_THRESHOLDS.strong).length
        return n === 0 ? 'nothing at mastery yet' : `${n} at mastery`
      },
    )

    const [challenges, claims, activitySkills] = await plan.step(
      'open',
      () =>
        Promise.all([
          challengeQueries.getPublishedChallenges(ctx.adminDb, ctx.sectionId),
          challengeQueries.getStudentClaims(ctx.adminDb, ctx.sectionId, ctx.userId),
          skillQueries.getSectionActivitySkills(ctx.adminDb, ctx.sectionId),
        ]),
      ([published]) =>
        published.length === 0 ? 'none published' : `${published.length} published`,
    )

    // challengeId → the skills it builds, from the shared activity_skills map
    // (the same one the challenge board reads).
    const skillsByChallenge = new Map<string, string[]>()
    for (const link of activitySkills) {
      if (link.activity_type !== 'challenge') continue
      const list = skillsByChallenge.get(link.activity_id) ?? []
      list.push(link.skill_id)
      skillsByChallenge.set(link.activity_id, list)
    }

    return plan.step(
      'match',
      async () => {
        const match = rankChallenges({
          candidates: (challenges as ChallengeRow[]).map((c) => ({
            id: c.id,
            title: c.title,
            points: c.points ?? 0,
            bonusPoints: c.bonus_points ?? 0,
            dueAt: c.due_at ?? null,
            difficulty: c.difficulty ?? 'unknown',
            skillIds: skillsByChallenge.get(c.id) ?? [],
          })),
          strongSkillIds: mastery
            .filter((r) => (r.score ?? 0) >= MASTERY_THRESHOLDS.strong)
            .map((r) => r.skill_id),
          skillNameById: Object.fromEntries(skills.map((s) => [s.id, s.name])),
          claimedChallengeIds: (claims as Array<{ challenge_id?: string }>)
            .map((c) => c.challenge_id)
            .filter((id): id is string => !!id),
          now: new Date().toISOString(),
        })

        if (!match.matched) return match
        // The id never reaches the model — the route is built here, from a value
        // the ranking chose, and the drive is the route's job.
        ctx.emit({
          type: 'goto_page',
          route: studentRoute.challenge(ctx.sectionId, match.top.id),
          label: `Challenges · ${match.top.title}`,
          said: "Opened the board on that challenge — claim it when you're ready.",
        })
        return {
          matched: true as const,
          challenge: {
            title: match.top.title,
            points: match.top.points,
            bonusPoints: match.top.bonusPoints,
            difficulty: match.top.difficulty,
            matchedSkills: match.top.matchedSkills,
            closesInDays: match.top.closesInDays,
          },
          alsoOpen: match.alternatives.map((a) => ({ title: a.title, points: a.points })),
        }
      },
      (r) => (r.matched ? r.challenge.title : r.reason.replace(/_/g, ' ')),
    )
  },
})

/**
 * C11 — "what should I ask in class?". Drafts a question from the student's own
 * most recent wrong answer and pre-fills the live classroom's question box. She
 * does not send it: `askQuestion()` runs when the student presses Send on the
 * real form, which is also where they edit or discard the draft.
 */
const draftAClassQuestion = defineStudentTool({
  name: 'draft_a_question_for_class',
  kind: 'propose',
  label: 'A question to ask in class',
  description:
    "Propose-only: draft a question THIS student could ask in the live class happening right now, built from a question they actually got wrong, and pre-fill it into the classroom's question box for them to edit and send. Call this when the student asks what they should ask in class, what to raise with the professor, or for help putting a question into words during a live session. It does NOT send the question — the student sends it themselves. If it reports no live room, say the class isn't live right now; if it reports nothing missed, say so. Never invent a question they got wrong.",
  input: NO_INPUT,
  steps: [
    { id: 'room', label: "Whether class is live" },
    { id: 'missed', label: 'What you got wrong recently' },
    { id: 'draft', label: 'Wording it for you' },
  ],
  describe: () => '',
  run: async (ctx: AthenaStudentCtx, _input: unknown, plan) => {
    const room = await plan.step(
      'room',
      () => liveClassroomQueries.getActiveRoomForSection(ctx.adminDb, ctx.sectionId),
      (r) => (r ? (r.name ?? 'in session') : 'not in session'),
    )
    if (!room) return { drafted: false as const, reason: 'no_live_room' as const }

    const miss = await plan.step(
      'missed',
      async () => mostRecentMiss(await fetchReviewableQuizzes(ctx)),
      (m) => (m ? m.quiz : 'nothing missed yet'),
    )
    if (!miss) return { drafted: false as const, reason: 'nothing_missed_yet' as const }

    return plan.step(
      'draft',
      async () => {
        const draft = draftClassQuestion(miss)
        // Ids resolved server-side; the draft rides the pre-fill handoff rather
        // than the URL, because it is prose (§14.4).
        ctx.emit({
          type: 'goto_page',
          route: studentRoute.liveRoom(ctx.sectionId, room.id),
          label: `Live class · ${room.name ?? 'question box'}`,
          said: 'Put the question in the class question box — edit it before you send.',
          prefill: { kind: 'lc_question', text: draft.text },
        })
        return {
          drafted: true as const,
          // The model writes the surrounding prose; it does not rewrite the
          // draft, which is already in the box by the time the answer lands.
          draft: draft.text,
          builtFrom: { quiz: miss.quiz, question: miss.question },
        }
      },
      () => 'ready in the question box',
    )
  },
})

/**
 * C10 — office-hours escalation. Drives to the booking page on the right
 * professor and the next day they hold office hours, with a note drafted from
 * what this student has actually been getting wrong. `createBooking()` runs
 * when they press Book on that page; Athena books nothing.
 */
const draftAnOfficeHoursBooking = defineStudentTool({
  name: 'draft_an_office_hours_booking',
  kind: 'propose',
  label: 'Office hours with your professor',
  description:
    "Propose-only: take THIS student to the office-hours booking page for this course's professor, on the next day they hold office hours, with a note drafted from the topics they're weakest on and a question they actually got wrong. Call this when the student asks to see or meet the professor, to book or attend office hours, or says they're stuck and need help from a person. It does NOT book anything — the student picks a slot and presses Book themselves, so write the answer as if they are about to see the booking page. If it reports no office hours, say the professor hasn't published any.",
  input: NO_INPUT,
  steps: [
    { id: 'slots', label: 'When your professor is free' },
    { id: 'evidence', label: "What you'd want to raise" },
    { id: 'note', label: 'Drafting your note' },
  ],
  describe: () => '',
  run: async (ctx: AthenaStudentCtx, _input: unknown, plan) => {
    const found = await plan.step(
      'slots',
      async () => {
        const { data: section } = await ctx.adminDb
          .from('course_sections')
          .select('professor_id')
          .eq('id', ctx.sectionId)
          .single()
        const professorId = (section as { professor_id?: string | null } | null)?.professor_id
        if (!professorId) return null
        const hours = await calendarQueries.getActiveOfficeHoursForProfessor(
          ctx.adminDb,
          professorId,
        )
        const date = nextOfficeHoursDate(
          (hours as Array<{ day_of_week: string }>).map((h) => h.day_of_week),
          new Date().toISOString(),
        )
        return date ? { professorId, date } : null
      },
      (r) => (r ? `next open ${r.date}` : 'no office hours published'),
    )
    if (!found) return { drafted: false as const, reason: 'no_office_hours' as const }

    const { weakTopics, miss } = await plan.step(
      'evidence',
      async () => {
        // One round trip for both halves — they are independent reads.
        const [mastery, skills, quizzes] = await Promise.all([
          skillQueries.getStudentMasteryRows(ctx.adminDb, ctx.sectionId, ctx.userId),
          skillQueries.listSectionSkills(ctx.adminDb, ctx.sectionId),
          fetchReviewableQuizzes(ctx),
        ])
        const name = new Map(skills.map((sk) => [sk.id, sk.name]))
        const weak = mastery
          .filter((r) => r.score !== null && r.score < MASTERY_THRESHOLDS.strong)
          .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
          .map((r) => name.get(r.skill_id))
          .filter((n): n is string => !!n)
        return { weakTopics: weak, miss: mostRecentMiss(quizzes) }
      },
      (r) =>
        r.weakTopics.length === 0 && !r.miss
          ? 'nothing specific yet'
          : `${r.weakTopics.length} weak topic${r.weakTopics.length === 1 ? '' : 's'}`,
    )

    return plan.step(
      'note',
      async () => {
        const note = draftBookingNote(weakTopics, miss)
        ctx.emit({
          type: 'goto_page',
          route: studentRoute.officeHours(found.professorId, found.date),
          label: `Office hours · ${found.date}`,
          said: 'Opened booking with a note ready — pick a slot and press Book.',
          prefill: { kind: 'booking_note', text: note },
        })
        return {
          drafted: true as const,
          onDate: found.date,
          note,
          aboutTopics: weakTopics.slice(0, 3),
        }
      },
      () => 'ready on the booking page',
    )
  },
})

const getWhatWasSaidInClass = defineStudentTool({
  name: 'get_what_was_said_in_class',
  kind: 'read',
  label: 'What was said in class',
  description:
    "Read-only: what the professor SAID OUT LOUD in this course's finished live classes, as opposed to what the slides show — announcements and promises (a moved deadline, an extension, a cancelled class), what an exam does or does not cover, what they explicitly called important or exam-worthy, and topics they explained in class that are on no slide. Each item comes with the professor's verbatim words and the class and slide it was said on. Call this whenever the student asks what the professor said, whether something was announced, what is on an exam or what it covers, what the professor stressed or said was important, what they missed by not attending, or what was taught that isn't in the slides. NEVER answer these from the course materials or from memory — the slides do not record any of it. If this returns nothing, tell the student plainly that nothing was said about it; never infer, soften, or guess an announcement.",
  input: NO_INPUT,
  describe: (r) =>
    r.count === 0 ? 'nothing on record' : `${r.count} statement${r.count === 1 ? '' : 's'}`,
  run: async (ctx: AthenaStudentCtx) => {
    const statements = await fetchClassStatements(ctx.adminDb, ctx.sectionId)
    return {
      count: statements.length,
      statements,
      // Said to the model, not the student: the quotes are the whole reason
      // this tool is trustworthy, so losing them in a paraphrase loses the
      // feature (guardrail G13).
      note: 'Quote the professor exactly when you report any of these, and name the class it was said in. Render each quote as a markdown blockquote (> ) with NO surrounding quotation marks. Report nothing that is not in this list.',
    }
  },
})

const getClassRecap = defineStudentTool({
  name: 'get_class_recap',
  kind: 'read',
  // Second-person like every sibling label, and deliberately the counterpart
  // of "What was said in class" — missed vs said is a distinction a student
  // can act on when both cards fire in one turn.
  label: 'What you missed in class',
  description:
    "Read-only: a catch-up on this course's most recent finished live classes (N4). Each session comes with what was taught (the class summary and its concepts), the in-class quizzes with THIS student's own result vs the class accuracy and the specific questions they got wrong, whether they attended, and their own in-class notes. Call this when the student asks what they missed in a class, what happened in a session, to catch them up, or how they did on an in-class quiz. It covers the last few sessions only — match by the date or class name when they name one. If it returns nothing, say no finished class has a recap yet; never invent what a session covered.",
  input: NO_INPUT,
  describe: (r) =>
    r.count === 0 ? 'nothing to catch up on' : `${r.count} recent class${r.count === 1 ? '' : 'es'}`,
  run: async (ctx: AthenaStudentCtx) => {
    const sessions = await fetchClassRecaps(ctx.adminDb, ctx.sectionId, ctx.userId)
    return {
      count: sessions.length,
      sessions,
      // Said to the model: the recap's value is the PERSONAL half — their own
      // misses vs the class — not a generic summary they could read themselves.
      note: 'Lead with what the session covered, then how THIS student did: name the questions they missed with the correct answer, and compare to classAccuracy only when it is non-null (null means too few respondents to show). If attended is false, say the recap covers what they missed. Mention their own notes only if myNotes is present. For "what did the professor SAY" questions, use get_what_was_said_in_class instead — this tool is the session content, that one is the spoken record.',
    }
  },
})

/** Every tool the student surface exposes. The route binds these to a request. */
export const STUDENT_TOOLS: AnyStudentTool[] = [
  getMyStudyFocus,
  getMyQuizPerformance,
  getMyAssignmentFeedback,
  getMyQuizReview,
  findMeAChallenge,
  draftAClassQuestion,
  draftAnOfficeHoursBooking,
  getWhatWasSaidInClass,
  getClassRecap,
  // A `create` tool that lives in the BASE set: remembering a preference is not
  // Athena driving the app, so chat-only mode gets it too.
  rememberPreference,
]

/** The set for a request, by drive mode. The two tools added here put things on
 *  the ROADMAP — Athena driving the app — so chat-only mode doesn't get them.
 *  Gating is this explicit list, not the `create` kind: `remember_preference` is
 *  also a create tool and ships in both modes from STUDENT_TOOLS above. */
export function studentToolsFor(driveMode: 'copilot' | 'chat'): AnyStudentTool[] {
  return driveMode === 'copilot'
    ? [...STUDENT_TOOLS, leaveStudyArtifact, mapKnowledgePath]
    : STUDENT_TOOLS
}
