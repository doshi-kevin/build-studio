// The Quiz Studio's Athena is now the only AI surface for quizzes: it sees the
// quiz on screen, generates from the professor's real lecture files, and edits
// questions in place. The course console's `draft_quiz` was the weaker duplicate
// — docs/designs/quizzes/athena-quiz-authoring.md called for deleting it outright
// on the grounds that a duplicate, inferior AI surface is a tax on trust as well
// as engineering — and the merge that shipped the Studio surface didn't actually
// remove it. This commit does.
//
// The failure mode worth guarding is NOT the tool coming back — that would be
// obvious. It is SILENT MIS-ROUTING. Five sibling tools disambiguated themselves
// *against* draft_quiz ("reach for draft_quiz only when they ask for a quiz…"),
// so deleting the tool while leaving those clauses would point the model at
// something that no longer exists — and its most likely fallback is
// draft_assignment, which would hand the professor an assignment they didn't ask
// for. So these tests pin two things: the tool is gone from the exposed set, and
// no prompt or tool description still names it.

import { describe, it, expect, vi } from 'vitest'
import { buildAssistantTools } from '@/lib/ai/professor-assistant/tools'
import { buildProfessorAssistantSystemPrompt } from '@/lib/ai/professor-assistant/prompts'
import * as schemas from '@/lib/ai/professor-assistant/schemas'
import { SUGGESTIONS } from '@/components/professor/assistant/AssistantConsole'
import type { AssistantContext } from '@/lib/ai/professor-assistant/context'

/** buildAssistantTools only closes over these; nothing here executes a tool. */
const tools = buildAssistantTools({
  adminDb: { from: vi.fn() } as never,
  sectionId: 'section-1',
  userId: 'prof-1',
  institutionId: 'inst-1',
  sectionEndDate: null,
  canRememberWorkflow: true,
})

const ctx: AssistantContext = {
  institutionId: 'inst-1',
  professorName: 'Dr. Chen',
  courseTitle: 'Intro to CS',
  courseCode: 'CS 101',
  sectionCode: 'A',
  rosterCount: 30,
  modules: [{ title: 'Week 1', published: true }],
  recentAnnouncements: [],
  memory: null,
  sectionEndDate: null,
}
const prompt = buildProfessorAssistantSystemPrompt(ctx)

describe('the console no longer drafts quizzes', () => {
  it('exposes exactly the intended tool set — draft_quiz gone, nothing else lost', () => {
    /* One full-set assertion rather than a `not.toContain` plus a handful of
       `toContain`s: it catches over-deletion as well as under-deletion, and it
       fails loudly if a later change adds a tool without anyone deciding to.
       Borrowed from assignment-assistant-tools.test.ts, which pins the Quiz
       Studio's set the same way. `google_search` is absent on purpose — the
       route injects it separately, outside this builder. */
    expect(Object.keys(tools).sort()).toEqual([
      'analyze_outcome_alignment',
      'ask_course_insights',
      'draft_announcement',
      'draft_assignment',
      'draft_challenge',
      'draft_differentiated_version',
      'draft_discussion',
      'draft_feedback',
      'draft_module_outline',
      'draft_project',
      'draft_reply',
      'draft_rubric',
      'get_live_class_report',
      'get_student_performance',
      // Memory: lets the professor state how they want the assistant to work.
      // Deliberately in the set — it writes to user_memory, so it belongs in the
      // list a reviewer has to look at when it changes.
      'remember_workflow',
      'show_outcome_coverage',
    ])
  })

  it('offers no starter chip that asks for a quiz', () => {
    /* The USER-facing half, and the likeliest way the mis-routing actually
       happens: a chip literally labelled "Draft a quiz" whose only job was to
       invoke the deleted tool. A professor clicking it lands in exactly the state
       the prompt now has to talk its way out of — so the affordance goes, not
       just the wiring behind it. Cheaper and far more durable than any prose
       match on the prompt. */
    const quizChips = SUGGESTIONS.filter((sg) => /\bquiz(zes)?\b/i.test(`${sg.label} ${sg.prompt}`))
    expect(quizChips).toEqual([])
  })

  it('exports no quiz-draft schema', () => {
    expect(schemas).not.toHaveProperty('quizDraftSchema')
    expect(schemas).not.toHaveProperty('quizQuestionDraftSchema')
  })
})

describe('nothing still points the model at the deleted tool', () => {
  it('no tool description mentions draft_quiz', () => {
    // A dangling reference is worse than the duplicate surface: the model is
    // told to use a tool it cannot call, and silently substitutes another.
    const offenders = Object.entries(tools)
      .filter(([, t]) => JSON.stringify((t as { description?: string }).description ?? '').includes('draft_quiz'))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it('the system prompt never mentions draft_quiz', () => {
    expect(prompt).not.toContain('draft_quiz')
  })

  it('the prompt carries the redirect bullet itself, not just the words "Quiz Studio"', () => {
    /* Anchored to the bullet, because "Quiz Studio" now appears in four unrelated
       sibling bullets — asserting that token alone stays GREEN when the whole
       redirect instruction is deleted, which is the mutation that matters. The
       forbid clause is the load-bearing half: draft_assignment's description used
       to end "reach for draft_quiz only when they ask for a quiz", so an
       assignment is precisely the wrong object a quiz request would fall through
       to. */
    const redirect = prompt
      .split('\n')
      .find((l) => l.includes('QUIZZES ARE NOT DRAFTED HERE'))
    expect(redirect).toBeDefined()
    expect(redirect).toContain('Quiz Studio')
    expect(redirect).toMatch(/do NOT substitute draft_assignment or draft_discussion/i)
  })

  it('nothing in the prompt still instructs this console to draft a quiz', () => {
    /* The symbol checks above are not enough on their own: the first pass of this
       change rewrote every mention of `draft_quiz` and left the CAPABILITY
       instructions behind — "when the professor asks you to make a quiz … CALL
       THE MATCHING DRAFT TOOL", and "NEVER write a quiz … as plain text", both in
       the contract block that is concatenated BEFORE the tool guidance and so
       outranks the redirect. Assert on the capability, not the identifier.
       Read-only mentions (insights describing what it can report) are fine, as is
       the redirect and the "weighing choices" example of when NOT to draft. */
    const offenders = prompt
      .split('\n')
      .filter((l) => /\bquiz(zes)?\b/i.test(l))
      .filter(
        (l) =>
          !/QUIZZES ARE NOT DRAFTED HERE|Quiz Studio|live.class|in-class quiz|quiz average|per-quiz|expected quizzes|quiz X|quizzes, roster|quizzes, announcements|weighing choices/i.test(
            l,
          ),
      )
    expect(offenders).toEqual([])
  })
})
