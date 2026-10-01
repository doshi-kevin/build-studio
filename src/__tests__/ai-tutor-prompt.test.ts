// The AI tutor's shipped system prompt. Quiz integrity (G8) is NOT in here any
// more: hint mode was removed when /api/chat started refusing outright while an
// attempt is open, so these assert the prompt never grows a wording-based
// guardrail back — see athena-chat-quiz-lock.test.ts for the gate itself.
import { describe, it, expect } from 'vitest'
import { buildAiTutorPrompt } from '@/lib/ai/student-tutor/prompt'

const ctx = {
  courseTitle: 'Natural Language Processing',
  courseCode: 'CS584',
  sectionCode: 'A',
  content: '[Transformers, page 14] Attention weights sum to one.',
}

describe('buildAiTutorPrompt — one stance, no hint mode', () => {
  it('answers directly and carries no quiz-integrity wording', () => {
    const p = buildAiTutorPrompt(ctx)
    // Pilot round 1 (merged from main): the grounded stance is materials-first,
    // subject-bounded — no longer the old "ONLY based on the materials" wall.
    expect(p).toContain('The course materials below are your primary source.')
    // Integrity during a quiz is enforced by the route's 423, not by prose the
    // student can argue with. If this ever passes again, a prompt guardrail has
    // crept back in — fix the gate instead.
    expect(p).not.toContain('ACADEMIC INTEGRITY OVERRIDE')
    expect(p).not.toContain('HINT MODE')
  })

  it('keeps grounding, citations, and the course materials', () => {
    const p = buildAiTutorPrompt(ctx)
    expect(p).toContain('[Document Title, page N]') // citation rule
    expect(p).toContain('--- Course Materials ---')
    expect(p).toContain('Attention weights sum to one.') // the content itself
  })
})

describe('buildAiTutorPrompt — insufficient-context (G1/G2) mode', () => {
  it('refuses honestly, omits the materials block, and forbids general-knowledge answers', () => {
    const p = buildAiTutorPrompt(ctx, { insufficientContext: true })
    expect(p).toContain('NO RELEVANT COURSE MATERIAL FOUND')
    expect(p).toMatch(/do NOT answer .* from your own general knowledge/i)
    expect(p).toMatch(/never invent a citation/i)
    // No materials block, no page content, no normal role text.
    expect(p).not.toContain('--- Course Materials ---')
    expect(p).not.toContain('Attention weights sum to one.')
    // Re-anchored after the pilot rewrite: the old "ONLY based on the course
    // materials" line no longer exists anywhere, so asserting its absence here
    // could never fail again. These two DO exist in the normal branch, so they
    // still pin "the insufficient branch carries no normal role or cite text"
    // (its own head reads "Your role — NO RELEVANT ...", not "Your role:").
    expect(p).not.toContain('Your role:')
    expect(p).not.toContain('The course materials below are your primary source.')
  })

})

describe('buildAiTutorPrompt — student-state lane', () => {
  const state = 'Weak topics (lowest mastery first): Sequence-to-sequence models, Word alignment.'

  it('injects the private state block + a personalization rule when state is present', () => {
    const p = buildAiTutorPrompt(ctx, { studentState: state })
    expect(p).toContain('About this student')
    expect(p).toContain(state)
    expect(p).toMatch(/base the advice on their weak topics/i)
    // State comes before the volatile materials block (stable-prefix ordering).
    expect(p.indexOf('About this student')).toBeLessThan(p.indexOf('--- Course Materials ---'))
  })

  it('omits the state block entirely when no state is supplied', () => {
    const p = buildAiTutorPrompt(ctx)
    expect(p).not.toContain('About this student')
  })

  it('is dropped in insufficient-context mode (nothing to personalize against)', () => {
    const p = buildAiTutorPrompt(ctx, { insufficientContext: true, studentState: state })
    expect(p).not.toContain('About this student')
    expect(p).not.toContain(state)
  })
})

describe('buildAiTutorPrompt — on-demand tool awareness', () => {
  it('names all three self-data tools in normal mode', () => {
    const p = buildAiTutorPrompt(ctx)
    expect(p).toContain('get_my_quiz_performance')
    expect(p).toContain('get_my_quiz_review')
    expect(p).toContain('get_my_assignment_feedback')
  })

  it('offers the self-data tools as an escape hatch in insufficient-context mode (self-data vs out-of-corpus)', () => {
    // A grade/feedback/review question won't clear the retrieval floor →
    // insufficient mode; the tools let the model still answer self-data
    // questions while otherwise refusing out-of-corpus material questions.
    const p = buildAiTutorPrompt(ctx, { insufficientContext: true })
    expect(p).toContain('get_my_quiz_performance')
    expect(p).toContain('get_my_quiz_review')
    expect(p).toContain('get_my_assignment_feedback')
    expect(p).toContain('NO RELEVANT COURSE MATERIAL FOUND')
  })
})

describe('buildAiTutorPrompt — student attachments', () => {
  // The student's own file is not course material, so the two grounding stances
  // above would each hold it at arm's length: normal mode treats the materials
  // as its primary source, and insufficient mode refuses outright. The attachment
  // rule is what opens that door — without it, uploading a file gets the student
  // a polite "that isn't in your course materials" about their own homework.
  it('is silent about attachments when there are none', () => {
    expect(buildAiTutorPrompt(ctx)).not.toContain('ATTACHED')
    expect(buildAiTutorPrompt(ctx, { insufficientContext: true })).not.toContain('ATTACHED')
  })

  it('lets the model read an attachment in normal mode, without making it citable', () => {
    const p = buildAiTutorPrompt(ctx, { hasAttachments: true })
    expect(p).toContain('ATTACHED')
    expect(p).toMatch(/never cite an attachment/i)
    // The materials still win a disagreement — the attachment is context, not truth.
    expect(p).toContain('go with the materials')
  })

  it('lets the model read an attachment in insufficient-context mode too', () => {
    // The common case: a homework photo in a course whose materials don't cover
    // it. The refusal stance stays for course questions; the file is readable.
    const p = buildAiTutorPrompt(ctx, { insufficientContext: true, hasAttachments: true })
    expect(p).toContain('NO RELEVANT COURSE MATERIAL FOUND')
    expect(p).toContain('ATTACHED')
  })
})
