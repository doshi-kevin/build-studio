/**
 * Tool set for the assignment-scoped Athena.
 *
 * FILL tools (apply_edits, fill_feedback) have NO `execute` — when the model calls
 * one, the AI SDK forwards the call to the client, where the panel writes the values
 * into the on-screen editor's React state (auto-apply). Mutation to the database
 * never happens here; the editor's own Save/autosave commits, unchanged.
 *
 * READ-ONLY tools (get_class_struggles, list_section_assignments,
 * summarize_submission) execute server-side and are lazy-loaded context — the model
 * calls them only when relevant, keeping the always-on prompt small.
 *
 * The factory returns ONLY the tools the mounted SURFACE exposes:
 *  - 'authoring' → apply_edits (typed per template `kind` via the registry) + reads.
 *  - 'grade'     → summarize_submission (IDOR-hardened) + fill_feedback.
 * A new template needs NO change here: apply_edits picks up its op schema from the
 * registry by kind.
 *
 * `mode` is a SEPARATE axis from `surface`: on authoring, 'frontier' adds two more fills
 * (set_rubric, set_design_notes) for the assignment-DESIGN arc. It is additive only — it
 * never removes a tool standard mode has, so a mid-arc mode change cannot orphan a tool
 * call the model already made.
 *
 * summarize_submission never receives a submission id from the model — it uses the
 * route-verified selectedSubmissionId and re-verifies (via join) that the submission's
 * assignment belongs to the route-verified section + institution, fail-closed.
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { assignmentQueries } from '@/lib/supabase/queries'
import { isLateSubmission } from '@/lib/assignments/submissions'
import {
  fillFeedbackSchema,
  designNotesSchema,
  frontierRubricSchema,
  DEFAULT_ASSIGNMENT_ASSISTANT_MODE,
  type AssignmentAssistantMode,
  type AssignmentAssistantSurface,
} from './schemas'
import { getTemplateConfig, quizSettingsSchema, generateQuestionsSchema } from './templates/registry'
import { outcomeAlignmentTools } from '@/lib/ai/tools/outcome-alignment'
import {
  loadAboutCourseData,
  loadClassStruggles,
  loadProjectAuthoringContext,
  loadQuizSourceModules,
} from './context'

// The admin client is loosely typed across the codebase (the generated types don't
// cover the assignment tables yet); mirror that here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export function buildAssignmentAssistantTools({
  adminDb,
  sectionId,
  institutionId,
  userId,
  surface,
  mode = DEFAULT_ASSIGNMENT_ASSISTANT_MODE,
  kind,
  assignmentId,
  selectedSubmissionId,
}: {
  adminDb: AdminDb
  sectionId: string
  institutionId: string
  /** Route-verified caller. Shared tools record it; see @/lib/ai/tools/outcome-alignment. */
  userId: string
  surface: AssignmentAssistantSurface
  /** Orthogonal standard/frontier switch (authoring only; the route coerces it). */
  mode?: AssignmentAssistantMode
  /** Authoring surface only — which template the professor is editing (registry key). */
  kind?: string
  /** The subject the two Frontier fills persist against. ABSENT on the create wizard,
   *  which registers before a row exists — which is exactly why they are gated on it. */
  assignmentId?: string
  /** The submission currently selected on the grading screen (route-validated shape). */
  selectedSubmissionId?: string
}): ToolSet {
  /* One read per request, however many times the model asks for it.
   *
   * This tool takes no arguments, so every call in a request is by definition the
   * same question — but the model does sometimes call it repeatedly within one
   * agent loop, and `MAX_AGENT_STEPS` only bounds a single request: a stream that
   * ends on `finishReason: 'tool-calls'` is auto-resubmitted by the panel, so the
   * loop can span requests too. Observed in QA: one prompt produced 11 requests ×
   * 6 executions. Memoising the promise (not the value) collapses the executions
   * within a request to a single whole-section `skill_mastery` read, which is by
   * far the most expensive thing behind this tool. */
  let classStruggles: Promise<unknown> | null = null

  // Read-only context tools shared by every authoring template.
  const authoringReadTools = {
    get_class_struggles: tool({
      description:
        "Read-only: what THIS class actually struggled with. Returns three things: (1) topicMastery — the course's own tracked topics with the class score on each, weakest first, and what share of students are at risk on it; this is the authoritative, semester-long signal, so lead with it. (2) the most recent live-class quiz's concept accuracy — one session, more recent, narrower. (3) published-quiz performance. Call this when the professor wants ideas for what to assign, asks about weak spots, or wants a remediation/practice assignment — so your suggestion targets a real gap, not a generic topic. CALL IT AT MOST ONCE PER CONVERSATION TURN — it takes no arguments, so a second call returns exactly the same data; if you have already called it, the result is in your context and you must answer from it rather than calling again. You do NOT need it at all when the professor already named the topic to build on. Read topicMastery.metric and use THAT WORD for the number you quote — it is the median, not the average, unless the professor changed it. Never report a topic as untracked just because it is absent from the list — an absent topic is either stronger or not yet assessed, and note/truncated say which. Returns CLASS-LEVEL data only (no student names). If nothing has been run yet, it says so.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await (classStruggles ??= loadClassStruggles(adminDb, sectionId))
        } catch (err) {
          logger.error('get_class_struggles: failed', err, { sectionId })
          // Don't let one failure poison every later call in the same request.
          classStruggles = null
          return { error: 'Could not load class performance right now.' }
        }
      },
    }),

    list_section_assignments: tool({
      description:
        "Read-only: the assignments that already exist in this section (title, points, status, due date). Call this to avoid proposing a duplicate, to align points/scope with the professor's existing assignments, or when they ask what they've already assigned. Titles and metadata only — no student data.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const rows = await assignmentQueries.listSectionAssignments(adminDb, sectionId)
          return {
            assignments: (rows ?? []).map(
              (a: { title: string; points: number; status: string; due_at: string | null; is_graded: boolean }) => ({
                title: a.title,
                points: a.points,
                status: a.status,
                dueAt: a.due_at,
                graded: a.is_graded,
              }),
            ),
          }
        } catch (err) {
          logger.error('list_section_assignments: failed', err, { sectionId })
          return { error: 'Could not load existing assignments right now.' }
        }
      },
    }),
  }

  // Frontier-only fills. Both are HOST-INDEPENDENT — the panel persists them through vetted
  // server actions rather than forwarding to an editor — and both need a saved subject row,
  // so they are gated on assignmentId: the create wizard registers its surface BEFORE an
  // assignment exists, and a tool called with no subject would fail on a NULL uuid instead
  // of degrading gracefully. Withheld entirely in standard mode so no other surface pays
  // their prompt tax.
  //
  // set_rubric is gated on kind: a quiz has no settings.rubric and no assignment-level point
  // budget, so there is nowhere for it to land. set_design_notes applies to both — the design
  // record carries either an assignment_id or a quiz_id (one-subject XOR in the table).
  // Typed as ToolSet explicitly: a bare conditional spread widens each key to
  // `Tool | undefined`, which the ToolSet index signature rejects.
  const frontierFills: ToolSet =
    mode === 'frontier' && assignmentId
      ? {
          set_design_notes: tool({
            description:
              "Save the PRIVATE design record behind this Frontier assignment — the spine and shell, what makes a copied submission visibly wrong, the verification mode, the failure modes and their acceptance clauses, the reference invariants, and the rot notes saying what will go stale and when. Professor-and-staff only: it is stored separately and NEVER appears in any student-facing field, because the individuation axis and the invariants are precisely what make the assignment hard to copy. Call this LAST, after the canvas and the rubric, once per design. REQUIRED SHAPE: at least TWO failure modes (up to four), each with its own acceptance clause — a single one is rejected by the schema and the whole call is lost, so write two before you send it. The rot notes are the whole reason this assignment can be refreshed next term instead of rewritten, so write them to be acted on, not to look complete.",
            inputSchema: designNotesSchema,
          }),
          ...(kind === 'quiz'
            ? {}
            : {
          set_rubric: tool({
            description:
              "Save the assignment's grading rubric — questions, each with its own points and its criteria. Weight it so MOST OF THE POINTS sit on criteria a grader can check without judgment, and tag each criterion auto or judgment. The point budget is enforced: question points cannot exceed the assignment total and a question's criteria cannot exceed that question's points, and an over-budget rubric is REJECTED with the reason, so fix and call again rather than claiming it saved. Criterion order matters — it is how already-saved grades are keyed — so when revising, keep the existing order and change only what was asked.",
            inputSchema: frontierRubricSchema,
          }),
              }),
        }
      : {}

  if (surface === 'authoring') {
    const config = getTemplateConfig(kind)
    if (!config) {
      // Unknown/absent kind: expose only the read tools so Athena can still brainstorm.
      return {
        ...authoringReadTools,
        ...outcomeAlignmentTools({ adminDb, sectionId, userId, surface: 'general' }),
      }
    }
    const apply_edits = tool({
      description: `Build or edit the ${config.label} the professor is authoring on screen. Provide a batch of ordered operations (insert / update / remove / reorder / setMeta as this template supports); the available operations and fields are in this tool's schema, and the current components (with ids) are in <screen>. For a fresh/empty ${config.label}, produce a complete, course-appropriate draft; for a targeted change, operate ONLY on the referenced component(s) by id and leave the rest untouched. Bundle ALL changes for one request into a SINGLE call. This does NOT publish — the professor reviews on the canvas and saves.`,
      inputSchema: config.opSchema,
    })

    // The About page trades the assignment-brainstorm reads for its ONE read tool:
    // the real course (due dates, categories, office hours, staff, section facts)
    // behind schedule derivation and the drift check. Gated on kind so no other
    // surface pays its prompt tax — and the About surface pays nobody else's:
    // two tools total is the whole set (see docs/reference/athena-cost-analysis.md, step 3).
    // No frontier fills either — Frontier is an assignment-design arc and the
    // route coerces the mode off this kind.
    if (config.kind === 'about') {
      let courseData: Promise<unknown> | null = null
      return {
        apply_edits,
        ...outcomeAlignmentTools({ adminDb, sectionId, userId, surface: 'about' }),
        get_course_data: tool({
          description:
            "Read-only: what THIS course actually contains — assignments and quizzes with due dates and points, modules, the gradebook's category weights (and what they sum to), the professor's office hours, the current staff (TAs), and the section's own semester/credits. Call it BEFORE deriving the weekly schedule, and whenever you check whether the About page matches the real course (grading table vs real weights, week rows vs real due dates, contact card vs real office hours, named TAs vs current staff). CALL IT AT MOST ONCE PER CONVERSATION TURN — it takes no arguments, so a second call returns the same data. Aggregate course metadata only — no student data.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              return await (courseData ??= loadAboutCourseData(adminDb, sectionId))
            } catch (err) {
              logger.error('get_course_data: failed', err, { sectionId })
              courseData = null
              return { error: 'Could not load the course data right now.' }
            }
          },
        }),
      }
    }

    // The project surface trades the assignment-brainstorm reads for ONE read tool
    // that answers everything it needs: the brief, the structure that exists, the
    // section's placeable assignments/quizzes, and whether anything is scored yet.
    // Gated on kind so no other surface pays its prompt tax, and two tools total is
    // the whole set (see docs/reference/athena-cost-analysis.md, step 3).
    if (config.kind === 'project') {
      let projectData: Promise<unknown> | null = null
      return {
        apply_edits,
        get_project_context: tool({
          description:
            "Read-only: everything about THIS project — the professor's own brief (description + guidelines), the phases and weighted rubric rows that already exist, the assignments and quizzes in this section you could place on a phase (with their real ids), the current weight total, and whether any of this project's work is already scored or released. Call it BEFORE proposing a phase timeline or a rubric: the brief is what you build the structure from, and the library is the only place real ids come from. CALL IT AT MOST ONCE PER CONVERSATION TURN — it takes no arguments, so a second call returns the same data. Aggregate project metadata only — no student work and no scores, only whether any score exists.",
          inputSchema: z.object({}),
          execute: async () => {
            if (!assignmentId) {
              return { error: 'No project is open on screen right now.' }
            }
            try {
              // assignmentId carries the PROJECT id on this surface (the same slot the
              // Quiz Studio overloads). The loader re-binds it to the route-verified
              // section, so an id from elsewhere resolves to "not found".
              return await (projectData ??= loadProjectAuthoringContext(adminDb, sectionId, assignmentId))
            } catch (err) {
              logger.error('get_project_context: failed', err, { sectionId, projectId: assignmentId })
              projectData = null
              return { error: 'Could not load this project right now.' }
            }
          },
        }),
      }
    }

    // The quiz surface trades `list_section_assignments` (meaningless here) for the three
    // quiz tools. Gated on kind so no other surface pays their prompt tax.
    if (config.kind === 'quiz') {
      return {
        apply_edits,
        ...outcomeAlignmentTools({ adminDb, sectionId, userId, surface: 'quiz' }),
        set_quiz_settings: tool({
          description:
            "Change the quiz's own settings — title, description, time limit, attempts, pass mark, due date, shuffling, when explanations appear, negative marking, and Adaptive mode. Send ONLY the settings the professor asked to change. You cannot publish or schedule a quiz, change proctoring, or touch scoring internals — those stay with the professor. This does NOT save; the studio saves as they work.",
          inputSchema: quizSettingsSchema,
        }),
        list_modules: tool({
          description:
            "Read-only: this course's modules and the lecture files inside them — ids, titles, and whether each file's text has been extracted yet (only extracted files can be generated from). Call this BEFORE generating so you can turn what the professor said ('module 1', 'the backprop lecture', 'all my modules') into real ids, and so they can see what is available. It renders as a pickable card in the chat. Titles and readiness only — no student data.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              return await loadQuizSourceModules(adminDb, sectionId)
            } catch (err) {
              logger.error('list_modules: failed', err, { sectionId })
              return { error: 'Could not load this course\'s modules right now.' }
            }
          },
        }),
        generate_questions: tool({
          description:
            "Generate questions from the course material and stream them onto the quiz. Pass the moduleItemIds you got from list_modules — NEVER an id you invented. Max 50 per call; call again to add more (a second run appends, it does not restart). The run happens in the background and takes a minute or two: questions appear on the professor's screen batch by batch, already saved as a draft. So do NOT claim it is finished when this returns — say it is running. Do not call this while the screen reports a generation already in progress.",
          inputSchema: generateQuestionsSchema,
        }),
        get_class_struggles: authoringReadTools.get_class_struggles,
        ...frontierFills,
      }
    }

    /* Accreditation coverage, shared from @/lib/ai/tools/outcome-alignment (#628).
     *
     * Only the READ half reaches this surface. The analysis it would otherwise start runs
     * for minutes and reports progress through the console's chip and card; this panel is
     * ephemeral, so a job kicked off here finishes into a surface the professor has left.
     * The prompt tells the model to send them to the console for that.
     *
     * The read is now on EVERY branch above as well, not just this one. It used to be here
     * alone, on the argument that authoring an assignment is the moment "does this close a
     * gap?" is actionable and the other branches should not pay another tool's prompt tax.
     * What that missed is that a professor does not know which screen holds the knowledge:
     * asking "ABET outcomes?" on the About page reached a surface with no such tool, so the
     * model tried to EDIT THE PAGE instead and the turn died with two errors and no answer.
     * Measured against real traffic the tax is a few hundred input tokens on a Flash turn,
     * which does not buy that failure. Coverage is section-scoped, so every branch reading
     * it gets the same numbers by construction.
     */
    return {
      apply_edits,
      ...authoringReadTools,
      ...outcomeAlignmentTools({ adminDb, sectionId, userId, surface: 'builder' }),
      ...frontierFills,
    }
  }

  // surface === 'grade'
  /* Coverage is course-level and this surface is about one submission, so the tool's
     grade description forbids using it to justify an individual mark. It is here because a
     professor mid-grading who asks "is this assignment even hitting an outcome?" should get
     an answer rather than a surface that has never heard of ABET. */
  return {
    ...outcomeAlignmentTools({ adminDb, sectionId, userId, surface: 'grade' }),
    summarize_submission: tool({
      description:
        "Read-only: load the student submission currently selected on screen and return its content, submission time, due date, and a precomputed on-time/late fact, so you can give the professor a short, NEUTRAL digest and answer timing questions. Cite submittedAt/dueAt/timingNote verbatim for any timing question — never compute the gap yourself, you will get the arithmetic wrong. It never scores, never maps to the rubric, and never grades. Returns an error note if nothing is selected or it can't be loaded.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!selectedSubmissionId) {
          return { ok: false as const, note: 'No submission is selected on screen right now.' }
        }
        try {
          // Ironclad ownership check: fetch the submission joined to its assignment
          // and assert the assignment belongs to the ROUTE-VERIFIED section +
          // institution. !inner drops rows with no matching assignment; the explicit
          // equality checks fail-closed on any cross-tenant / cross-section id.
          const { data, error } = await adminDb
            .from('assignment_submissions')
            .select(
              'id, text_content, files, answers, status, submitted_at, assignment:assignments!inner(section_id, institution_id, title, due_at)',
            )
            .eq('id', selectedSubmissionId)
            .maybeSingle()

          if (error) {
            logger.error('summarize_submission: query failed', error, { sectionId })
            return { ok: false as const, note: 'Could not load that submission.' }
          }
          const asg = Array.isArray(data?.assignment) ? data?.assignment[0] : data?.assignment
          if (!data || !asg || asg.section_id !== sectionId || asg.institution_id !== institutionId) {
            // Fail-closed: not found OR outside this section/tenant. Same message
            // either way so it can't be used to probe other tenants' ids.
            return { ok: false as const, note: 'That submission could not be found in this course.' }
          }

          const files: { name?: string }[] = Array.isArray(data.files) ? data.files : []
          const answers = Array.isArray(data.answers) ? data.answers : []
          // Computed here, not left to the model: an LLM asked to reason about a
          // raw pair of ISO timestamps will confidently get the arithmetic wrong
          // (this is exactly how a professor was told a late submission was
          // "13 hours before the deadline"). Same isLateSubmission the grader's
          // own Late badge uses, so the two can't disagree.
          const late = isLateSubmission(data.submitted_at, asg.due_at)
          return {
            ok: true as const,
            assignmentTitle: asg.title ?? '',
            status: data.status ?? 'submitted',
            submittedAt: data.submitted_at ?? null,
            dueAt: asg.due_at ?? null,
            timingNote:
              data.submitted_at && asg.due_at
                ? late
                  ? 'Submitted AFTER the deadline (late).'
                  : 'Submitted before the deadline (on time).'
                : 'Submission or due date is missing — do not state a timing claim.',
            // Wrapped as untrusted: the system prompt forbids obeying anything inside.
            untrustedStudentText: data.text_content
              ? `<untrusted_student_content>\n${data.text_content}\n</untrusted_student_content>`
              : '',
            fileNames: files.map((f) => f?.name).filter(Boolean),
            verbalAnswerCount: answers.length,
            note:
              !data.text_content && files.length === 0 && answers.length === 0
                ? 'This submission has no written text or files to read.'
                : 'Give a short, neutral, descriptive digest only. Do not evaluate quality, map to the rubric, or suggest a score.',
          }
        } catch (err) {
          logger.error('summarize_submission: exception', err, { sectionId })
          return { ok: false as const, note: 'Could not load that submission.' }
        }
      },
    }),

    fill_feedback: tool({
      description:
        "Draft qualitative feedback into the feedback box for the selected student — strengths and specific, actionable next steps, in the professor's voice, grounded in what they tell you (their notes, the criteria they ticked). NEVER include a numeric or letter grade, a score, or points. This does NOT save — the professor edits it and clicks Save grade. The score field stays entirely theirs.",
      inputSchema: fillFeedbackSchema,
    }),
  }
}
