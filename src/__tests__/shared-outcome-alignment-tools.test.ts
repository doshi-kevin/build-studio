// The shared accreditation tools (#628).
//
// The issue behind this is structural, not about ABET: every Athena surface built its tool
// set from scratch, so a capability added to one was invisible to the others and each new
// surface started with nothing inherited. Extracting these two was the first case.
//
// What is worth pinning is the two DELIBERATE decisions, because both are the kind a later
// refactor would "tidy away":
//
//   1. The surfaces get DIFFERENT tools. `analyze_outcome_alignment` enqueues a job that
//      runs for minutes and reports through the console's progress chip and result card.
//      The in-builder panel is ephemeral by design, so a job started there finishes into a
//      surface the professor has left — no progress, no result, no notification. Console
//      gets both; builder gets the read only.
//   2. The surfaces get DIFFERENT descriptions for the SAME tool. The console's copy tells
//      the model the result renders "as a compact card". The builder has no card, and its
//      renderer does `if (!meta) return null` for an unmapped read tool — so shipping the
//      console wording there would have the model announce a card that never appears.
//
// Also asserted: the console's set is unchanged by the extraction. A refactor that moves
// code must not move behaviour.

import { describe, it, expect, vi } from 'vitest'
import { outcomeAlignmentTools } from '@/lib/ai/tools/outcome-alignment'

vi.mock('@/lib/jobs/enqueue', () => ({
  enqueueJob: vi.fn(async () => ({ jobId: 'job-1', alreadyActive: false })),
}))
vi.mock('@/lib/ai/professor-assistant/outcome-coverage', () => ({
  loadOutcomeCoverage: vi.fn(async () => ({ ok: true })),
}))

const CTX = { adminDb: {}, sectionId: 'sec-1', userId: 'user-1' } as const

/** A tool's description, however the SDK stores it. */
function describeOf(tools: Record<string, unknown>, name: string): string {
  const t = tools[name] as { description?: string } | undefined
  return t?.description ?? ''
}

describe('outcomeAlignmentTools surface split', () => {
  it('gives the console both tools', () => {
    const tools = outcomeAlignmentTools({ ...CTX, surface: 'console' })
    expect(Object.keys(tools).sort()).toEqual(
      ['analyze_outcome_alignment', 'show_outcome_coverage'].sort(),
    )
  })

  it('gives the builder the read only, never the job starter', () => {
    const tools = outcomeAlignmentTools({ ...CTX, surface: 'builder' })
    expect(Object.keys(tools)).toEqual(['show_outcome_coverage'])
  })

  it('does not promise the builder a card it cannot render', () => {
    /* The console tells the model to call the tool when "the card should (re)appear".
       Repeating that where no card exists makes the model describe UI that isn't there. */
    const builder = describeOf(outcomeAlignmentTools({ ...CTX, surface: 'builder' }), 'show_outcome_coverage')
    const console_ = describeOf(outcomeAlignmentTools({ ...CTX, surface: 'console' }), 'show_outcome_coverage')

    expect(console_).toContain('compact card')
    /* Not "contains no mention of a card" — the builder copy deliberately says there is
       NO card and to never point at one. The property is that it never PROMISES one, and
       never repeats the console's "call this when the card should appear" trigger. */
    expect(builder).not.toContain('compact card')
    expect(builder).not.toMatch(/card should \(re\)appear/i)
    expect(builder).toMatch(/NO card on this surface|nothing appears on screen/i)
    // And it must tell the model to answer in prose instead.
    expect(builder).toMatch(/IN YOUR REPLY/i)
  })

  it('tells the builder it cannot start an analysis', () => {
    const builder = describeOf(outcomeAlignmentTools({ ...CTX, surface: 'builder' }), 'show_outcome_coverage')
    expect(builder).toMatch(/cannot start one here/i)
  })
})

/*
 * Reach. A professor asked "ABET outcomes?" on the About page and got two errors and no
 * answer: that surface had no ABET tool, so the model reached for the only actionable tool
 * it did have and tried to EDIT THE PAGE. The lesson is that a professor does not know
 * which screen holds which knowledge, so the read belongs on all of them.
 *
 * Coverage is keyed by section and nothing else, so every surface reading it gets the same
 * numbers by construction. That is the whole cross-surface consistency guarantee — there is
 * no cache to keep in step, and this test is what stops a later refactor from quietly
 * dropping a surface back off the list.
 */
const READ_SURFACES = ['about', 'quiz', 'builder', 'grade', 'general'] as const

describe('every professor surface can read coverage', () => {
  it.each(READ_SURFACES)('exposes the read tool on %s', (surface) => {
    const tools = outcomeAlignmentTools({ ...CTX, surface })
    expect(Object.keys(tools)).toContain('show_outcome_coverage')
  })

  it.each(READ_SURFACES)('never gives %s the job starter', (surface) => {
    /* Starting a run is console-only on purpose: the progress chip, the completion watcher
       and the result card all live in AssistantConsole, so a job kicked off anywhere else
       is silent on success AND failure, and the professor ends up polling by asking. */
    const tools = outcomeAlignmentTools({ ...CTX, surface })
    expect(Object.keys(tools)).toEqual(['show_outcome_coverage'])
  })

  it.each(READ_SURFACES)('does not promise %s a card it cannot render', (surface) => {
    const d = describeOf(outcomeAlignmentTools({ ...CTX, surface }), 'show_outcome_coverage')
    expect(d).not.toContain('compact card')
    expect(d).toMatch(/NO card on this surface/i)
    expect(d).toMatch(/cannot start one here/i)
  })

  it.each(READ_SURFACES)('teaches %s that an unmeasured course is not an uncovered one', (surface) => {
    /* The single most damaging thing this tool can do is report a course nobody has
       analysed as a course that covers nothing. The payload says so structurally, and the
       description has to say so too. */
    const d = describeOf(outcomeAlignmentTools({ ...CTX, surface }), 'show_outcome_coverage')
    expect(d).toMatch(/never_run/)
    expect(d).toMatch(/NOT MEASURED/i)
  })

  it('forbids the grading surface from turning coverage into a grade', () => {
    /* Coverage describes how the COURSE is built. Beside one student's submission that is
       one short step from "your work missed an outcome", which it must never become.
       Matched on the rule, not the sentence, so rewording the copy does not fail this. */
    const grade = describeOf(outcomeAlignmentTools({ ...CTX, surface: 'grade' }), 'show_outcome_coverage')
    expect(grade).toMatch(/never.*individual student grade/i)
  })

  it('keeps the About surface off editing the page to improve the numbers', () => {
    const about = describeOf(outcomeAlignmentTools({ ...CTX, surface: 'about' }), 'show_outcome_coverage')
    expect(about).toMatch(/never edit the page.*numbers/i)
  })
})

describe('the console keeps exactly the tools it had before the extraction', () => {
  it('still records the calling professor as the job creator', async () => {
    const { enqueueJob } = await import('@/lib/jobs/enqueue')
    const adminDb = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: 'std-1' } }) }) }),
            maybeSingle: async () =>
              table === 'course_sections' ? { data: { institution_id: 'inst-1' } } : { data: { id: 'std-1' } },
          }),
        }),
      }),
    }
    const tools = outcomeAlignmentTools({
      adminDb,
      sectionId: 'sec-1',
      userId: 'user-1',
      surface: 'console',
    }) as Record<string, { execute: (a: unknown, b: unknown) => Promise<unknown> }>

    const out = (await tools.analyze_outcome_alignment.execute({}, {})) as { status: string }

    expect(out.status).toBe('started')
    /* createdBy is the reason the factory needs userId at all. Dropping it would still
       compile — the field is a plain string — and would silently attribute every
       professor's analysis to nobody. */
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'outcome_alignment', sectionId: 'sec-1', createdBy: 'user-1' }),
    )
  })
})
