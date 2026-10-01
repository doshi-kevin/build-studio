/**
 * Tool set for the professor AI assistant.
 *
 * The DRAFT tools have NO `execute` — when the model calls one, the AI SDK
 * forwards the tool call to the client, where it renders as an editable card and
 * the professor approves/edits/discards (human-in-the-loop). Mutation happens
 * only on approval, via the existing vetted server actions. The model loop never
 * writes to the database.
 *
 * `ask_course_insights` is read-only, so it DOES have a server `execute` (a
 * scoped read-only snapshot) — there is nothing to approve.
 *
 * The ABET accreditation tools are NOT defined here any more. They live in
 * `@/lib/ai/tools/outcome-alignment` so the in-builder Athena can have the read-only
 * half too; defining every capability inside one surface's factory is what kept them
 * reachable from a single hidden URL (#628). This surface's set is unchanged.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { rememberWorkflow } from './remember-workflow'
import {
  announcementDraftSchema,
  replyDraftSchema,
  moduleDraftSchema,
  discussionDraftSchema,
  projectDraftSchema,
  assignmentDraftSchema,
  challengeDraftSchema,
  rubricDraftSchema,
  feedbackDraftSchema,
  differentiatedDraftSchema,
} from './schemas'
import { loadCourseSnapshot, loadStudentPerformance, loadLiveClassReport } from './context'
import { outcomeAlignmentTools } from '@/lib/ai/tools/outcome-alignment'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export function buildAssistantTools({
  adminDb,
  sectionId,
  userId,
  institutionId,
  sectionEndDate,
  canRememberWorkflow,
}: {
  adminDb: AdminDb
  sectionId: string
  userId: string
  institutionId: string
  sectionEndDate: string | null
  /** Only the professor gets the memory tool.
   *
   *  The route admits teaching assistants too, and they were able to save a
   *  preference — but both Preferences pages are gated on the profile role, so a
   *  teaching assistant could never see or delete what they had saved. The whole
   *  argument for saving silently is that the person can look at it and remove
   *  it, so where that is not true, we do not save. */
  canRememberWorkflow: boolean
}) {
  return {
    ...(canRememberWorkflow
      ? {
          remember_workflow: rememberWorkflow({
            adminDb,
            sectionId,
            userId,
            institutionId,
            sectionEndDate,
          }),
        }
      : {}),

    ...outcomeAlignmentTools({ adminDb, sectionId, userId, surface: 'console' }),

    draft_discussion: tool({
      description:
        'Draft a set of UNGRADED, open-ended discussion questions (a title, optional framing, and 1–10 open prompts) — NO answer keys, NO points, NEVER auto-graded. Use this whenever the professor asks for "discussion questions", seminar prompts, reflection prompts, or any open questions that are not an assessment. On approval it posts to a discussion channel for students to respond. This is the right tool for interpretive/Socratic/humanities prompts whenever the questions are not meant to be scored; scored assessments are built in the Quiz Studio, not here.',
      inputSchema: discussionDraftSchema,
    }),

    draft_announcement: tool({
      description:
        "Draft a one-way course announcement (title + body) in the professor's tone — for broadcasting information (deadlines, logistics, reminders), not for asking students questions. Does NOT publish anything — the professor approves the draft.",
      inputSchema: announcementDraftSchema,
    }),

    draft_reply: tool({
      description:
        "Draft a reply to ONE specific student's question or message, for the professor to review, edit, and post. Use this for a personal 1:1 response. For broadcasting to the whole class use draft_announcement; for opening a discussion use draft_discussion. Include the student message in studentQuestion for context. Does NOT send anything.",
      inputSchema: replyDraftSchema,
    }),

    draft_module_outline: tool({
      description:
        'Draft a module / lesson outline (title, optional description, ordered items with talking points) — the teaching plan/structure for a unit, not an assessment. On approval it is created as an UNPUBLISHED module. Does NOT publish anything.',
      inputSchema: moduleDraftSchema,
    }),

    draft_project: tool({
      description:
        'Draft a course PROJECT students complete, often in teams — a title, a brief/description, guidelines (deliverables, requirements, milestones, grading expectations), team size (1 = individual), and an optional due date. Use this when the professor wants an actual assignment students BUILD or SUBMIT in the course Projects area. Do NOT confuse it with draft_module_outline (a teaching/lesson plan, not something students submit). A scored assessment is a different object again, and is built in the Quiz Studio. On approval it is created as an active course project. Does NOT save anything until approved.',
      inputSchema: projectDraftSchema,
    }),

    draft_assignment: tool({
      description:
        'Draft an ASSIGNMENT — an individual student deliverable submitted as written text and/or a file upload: a title, instructions, points, an optional due date, and which file types are accepted (pdf, image, doc, ppt, txt, zip; leave empty for a text-box submission). Use this for an essay, problem set, lab report, reflection, response paper, or any graded work ONE student turns in. Do NOT confuse it with draft_project (a larger, often team-built deliverable with milestones in the Projects area) or draft_discussion (ungraded prompts students post replies to); a quiz auto-scored against answer keys is built in the Quiz Studio instead. On approval it is created as an UNPUBLISHED assignment the professor publishes from the UI. Does NOT save anything until approved.',
      inputSchema: assignmentDraftSchema,
    }),

    draft_challenge: tool({
      description:
        'Draft a gamified Challenge Board task students complete for points — a title, what to do, a type (general/coding/puzzle/research/creative/discussion), difficulty (easy/medium/hard/expert), base points, optional bonus points, an optional claim cap, and an optional due date. Use this when the professor wants an OPTIONAL, points-bearing, often fun/extra-credit task on the Challenge Board — NOT a formal submitted assignment/project (draft_project), and not a graded quiz (those are built in the Quiz Studio). On approval it is created as a DRAFT challenge the professor publishes. Does NOT save anything until approved.',
      inputSchema: challengeDraftSchema,
    }),

    draft_rubric: tool({
      description:
        'Draft a grading RUBRIC — criteria (rows) each with 2–6 performance levels (label + points + what that level looks like). Use this when the professor asks for a rubric, grading criteria, or "how should I grade this" for a PROJECT or assignment. On approval the professor picks an existing project and the rubric is appended to its guidelines (a rubric has no standalone page; projects have room for it, quiz descriptions do not). For a "rubric-aligned quiz", point the professor at the Quiz Studio\'s Athena instead (it puts the criteria in each question\'s explanation). This only DEFINES how work would be graded — it NEVER assigns a score to any student. Does NOT save anything until approved.',
      inputSchema: rubricDraftSchema,
    }),

    draft_feedback: tool({
      description:
        "Draft QUALITATIVE feedback for ONE student on their work or progress — strengths, specific and actionable next steps, in an encouraging teacherly voice. Ground it in the student's real picture (call get_student_performance first when drafting a check-in to a struggling student). NEVER include or suggest a numeric or letter grade — Athena does not grade; the professor does. On approval it is posted via the chosen discussion channel (like a reply). Use this for performance/work feedback to an individual; use draft_reply for answering a student's question, and draft_announcement to address the whole class. Does NOT send anything until approved.",
      inputSchema: feedbackDraftSchema,
    }),

    draft_differentiated_version: tool({
      description:
        'Draft an ALTERNATE version of a piece of content for accessibility/scaffolding — "simplified" (plainer language, shorter sentences), "ell" (multilingual / ESL-accessible, define jargon), or "advanced" (extended depth). Use this when the professor wants to adapt existing text (an announcement, a prompt, a passage) for a different group of learners. Frame it as scaffolding for mixed-prep / multilingual / first-generation students — NOT as a K-12 grade level. On approval it is saved as a DRAFT announcement the professor can place. Does NOT save anything until approved.',
      inputSchema: differentiatedDraftSchema,
    }),

    get_live_class_report: tool({
      description:
        "Read-only post-class report for the section's MOST RECENT live-classroom AI quiz that has a saved report. Returns per-concept accuracy (weakest concepts first), per-question accuracy, the overall accuracy, how many students answered, and which enrolled students did NOT respond. Call this when the professor asks how a live class went, what students struggled with in class, or who missed the in-class quiz ('how did today's class go?', 'what did they bomb?', 'who didn't answer?'). Then you can draft an announcement to remediate the weak concepts, or point the professor at the Quiz Studio to build a quiz on them. It only reads existing live-session results — it never grades. If no live quiz has been run and closed yet, it says so.",
      inputSchema: z.object({}),
      execute: async () => {
        return await loadLiveClassReport(adminDb, sectionId)
      },
    }),

    ask_course_insights: tool({
      description:
        "Read-only course snapshot. Call this ONLY when the professor EXPLICITLY asks about their course's current contents, status, OR class performance — modules (published vs draft), quizzes (published vs draft), enrollment count, what's been covered, AND now: the class average, per-quiz performance (attempts/average/how many below passing), and which students are at-risk (below pass on 2+ quizzes or missing 2+). Use it for questions like 'how's the class doing?', 'who's struggling?', or 'how did they do on the KNN quiz?'. Do NOT call it for greetings, small talk, general questions, or while drafting other content. It returns class-level aggregates, not a full per-student gradebook.",
      inputSchema: z.object({
        question: z
          .string()
          .describe('What the professor wants to know about their course (for your own focus; the full snapshot is returned).'),
      }),
      execute: async () => {
        const snapshot = await loadCourseSnapshot(adminDb, sectionId)
        return snapshot
      },
    }),

    get_student_performance: tool({
      description:
        "Read-only performance summary for ONE specific student, looked up by name. Returns the student's graded picture: official course grade (if set), quiz average (best attempt per quiz) vs the class, team project grades, missed/expected quizzes, late-submission pattern, days since last activity, an improving/declining/steady trend, topic strengths and weaknesses, and an at-risk flag. Use it when the professor asks about a named individual or before drafting a reply/check-in to a struggling student. It summarizes EXISTING scores only and never assigns or changes a grade; if the name doesn't resolve to exactly one enrolled student it returns suggestions or asks you to disambiguate — relay that instead of guessing.",
      inputSchema: z.object({
        studentName: z
          .string()
          .describe("The student's name as the professor referred to them (full or partial; resolved against this section's roster)."),
      }),
      execute: async ({ studentName }) => {
        return await loadStudentPerformance(adminDb, sectionId, studentName)
      },
    }),
  }
}
