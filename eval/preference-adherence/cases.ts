/**
 * The adherence cases: a stated preference, and a MECHANICAL check that the
 * answer obeyed it.
 *
 * Every check must be decidable by code with no judgement, because the thing
 * this gate exists to catch is precisely the case where the answer looks fine
 * to a reader and quietly ignored what the student asked for. The prototype
 * found "shorter answers" obeyed on one question and ignored on another; that
 * is invisible to eyeballing and obvious to a word count.
 *
 * Preferences are phrased the way `remember_preference` actually stores them,
 * so what is measured is the real stored form and not a hand-tuned instruction.
 */

export interface AdherenceCase {
  id: string
  /** The preference text, exactly as a stored row would hold it. */
  preference: string
  /** Which slot it would live in — recorded so the report reads like the table. */
  slot: string
  /** True when the answer obeyed. No model, no judgement. */
  check: (answer: string) => boolean
  /** What failure looks like, for the report line. */
  describe: (answer: string) => string
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

export const CASES: AdherenceCase[] = [
  {
    id: 'answer_length',
    slot: 'answer_length',
    preference: 'Keep every answer under 60 words.',
    check: (a) => words(a) <= 60,
    describe: (a) => `${words(a)} words`,
  },
  {
    id: 'no_code_blocks',
    slot: 'constraint',
    preference: 'Never use code blocks.',
    check: (a) => !a.includes('```'),
    describe: (a) => (a.includes('```') ? 'used a code fence' : 'no fences'),
  },
  {
    id: 'prose_not_bullets',
    slot: 'constraint',
    preference: 'Always answer in flowing prose, never bullet points or numbered lists.',
    check: (a) => !/^\s*([-*+]|\d+[.)])\s+/m.test(a),
    describe: (a) => (/^\s*([-*+]|\d+[.)])\s+/m.test(a) ? 'used a list' : 'prose'),
  },
  {
    id: 'no_questions_back',
    slot: 'tone',
    preference: 'Never end an answer by asking me a follow-up question.',
    check: (a) => !a.trim().endsWith('?'),
    describe: (a) => (a.trim().endsWith('?') ? 'ended on a question' : 'did not'),
  },
]

/**
 * The questions each preference is fired at. Deliberately mixed: one that
 * invites a long answer, one that invites a list, one that invites code, one
 * that invites a follow-up. A preference is only real if it survives a question
 * pulling the other way — which is exactly where the prototype saw one ignored.
 */
export const QUESTIONS: string[] = [
  'Can you explain cross-entropy to me?',
  'What are the main differences between L1 and L2 regularization?',
  'How would I implement softmax?',
  "I'm stuck on gradient descent, where do I start?",
  'Summarise what we covered on distributed representations.',
]
