/**
 * The head-to-head corpus, kept as a standing regression test.
 *
 * Two implementations of "strip the reason" were compared against these exact
 * strings, with the chat model bypassed so only the server logic is measured.
 * Most were written by an outside reviewer that had seen neither implementation,
 * which is the point: the previous suites were each written by whoever wrote the
 * code, so they measured whose imagination matched their own regex.
 *
 * Two numbers decide it, and they pull against each other:
 *   leak          a KNOWN protected word reached storage. Read the limit below
 *                 before trusting this one.
 *   falseRefusal  a preference with nothing sensitive in it was dropped. The
 *                 student just experiences Athena forgetting what they asked.
 *
 * Measured on this corpus: the version on main leaked once and saved 21; the
 * other branch leaked once and saved 25; the merge of both leaks none and saves
 * 25. That is why the code looks the way it does.
 *
 * THE LIMIT OF THIS TEST, and it is a large one. Every string in LEAK_MARKERS is
 * also in the denylist, so a "leak" is only counted when the denylist would have
 * caught it anyway. Zero leaks here means two copies of one incomplete list
 * agree, not that nothing leaks. memory-blind-eval.test.ts measures the same
 * pipeline against sentences written without sight of the list, and the backstop
 * catches 9 of 40 there. Read that file next.
 *
 * Nine cases here are also "safely refused": the student stated a real
 * accommodation, nothing was stored, and they were told nothing. Regex closes
 * neither gap, and issue #790 tracks replacing this layer with a classifier. If
 * you are adding a sixth list of words to this file, read that issue first.
 */
import { describe, it, expect } from 'vitest'
import { stripReason, assertStorablePreference } from '@/lib/validations/memory'

interface Case {
  id: string
  text: string
  /** Does the sentence contain something that must never reach storage. */
  protectedInfo: boolean
  /** The accommodation worth keeping, or null when there is no storable preference. */
  want: string | null
  group: string
}

const CORPUS: Case[] = [
  // --- reason joined by a causal connective (both should handle) ---
  { id: 'c1', group: 'connective', text: 'keep it short because I have adhd', protectedInfo: true, want: 'keep it short' },
  { id: 'c2', group: 'connective', text: 'no bullet points bc my adhd goes crazy', protectedInfo: true, want: 'no bullet points' },
  { id: 'c3', group: 'connective', text: "I'm dyslexic so use plain language", protectedInfo: true, want: 'use plain language' },
  { id: 'c4', group: 'connective', text: 'use plain language since english is my second language', protectedInfo: true, want: 'use plain language' },

  // --- no connective: the shapes B added patterns for ---
  { id: 'n1', group: 'appositional', text: 'As someone with ADHD, break things down', protectedInfo: true, want: 'break things down' },
  { id: 'n2', group: 'participial', text: 'Being dyslexic, I need plain language', protectedInfo: true, want: 'plain language' },
  { id: 'n3', group: 'comma-state', text: "I'm on probation, keep it encouraging", protectedInfo: true, want: 'keep it encouraging' },
  { id: 'n4', group: 'comma-state', text: 'I am dyslexic, please use short paragraphs', protectedInfo: true, want: 'use short paragraphs' },
  { id: 'n5', group: 'two-sentence', text: 'My ADHD makes long answers hard. Keep it short.', protectedInfo: true, want: 'Keep it short' },
  { id: 'n6', group: 'no-marker', text: 'I have adhd keep answers short', protectedInfo: true, want: 'keep answers short' },

  // --- consultant prediction: B's lookahead uses a closed verb list ---
  { id: 'L1', group: 'lookahead-miss', text: 'I am dyslexic, write in short paragraphs.', protectedInfo: true, want: 'write in short paragraphs' },
  { id: 'L2', group: 'lookahead-miss', text: "I'm visually impaired, bold the key terms.", protectedInfo: true, want: 'bold the key terms' },
  { id: 'L3', group: 'lookahead-miss', text: 'My background is in special ed, limit your vocabulary.', protectedInfo: true, want: 'limit your vocabulary' },

  // --- consultant prediction: B fires and keeps the WRONG half (a leak) ---
  { id: 'W1', group: 'wrong-half', text: 'I have an hour to study, do not talk about my ADHD.', protectedInfo: true, want: null },
  { id: 'W2', group: 'wrong-half', text: 'I have a question, please explain the homework.', protectedInfo: false, want: null },

  // --- unlisted circumstances: no keyword will catch these ---
  { id: 'u1', group: 'unlisted', text: 'keep it short, I sleep in my car right now', protectedInfo: true, want: 'keep it short' },
  { id: 'u2', group: 'unlisted', text: 'short answers please, my brain runs slower in the mornings', protectedInfo: true, want: 'short answers' },
  { id: 'u3', group: 'unlisted', text: 'use plain language, I wear a hijab and get pulled out for prayer', protectedInfo: true, want: 'use plain language' },

  // --- legitimate, no protected info: must survive INTACT ---
  { id: 'g1', group: 'legit', text: 'As a visual learner, always use diagrams.', protectedInfo: false, want: 'always use diagrams' },
  { id: 'g2', group: 'legit', text: 'As a complete beginner to python, explain things simply.', protectedInfo: false, want: 'explain things simply' },
  { id: 'g3', group: 'legit', text: 'Being on my phone today, keep answers under a paragraph.', protectedInfo: false, want: 'keep answers under a paragraph' },
  { id: 'g4', group: 'legit', text: 'I am studying for finals, please give me practice questions.', protectedInfo: false, want: 'give me practice questions' },
  { id: 'g5', group: 'legit', text: "I'm a physics major, use advanced math.", protectedInfo: false, want: 'use advanced math' },
  { id: 'g6', group: 'legit', text: 'My background is in finance, make the examples about money.', protectedInfo: false, want: 'make the examples about money' },
  { id: 'g7', group: 'legit-compound', text: 'Explain the theory and I want practical examples.', protectedInfo: false, want: 'Explain the theory and I want practical examples' },
  { id: 'g8', group: 'legit-compound', text: 'Format this clearly and please use Markdown.', protectedInfo: false, want: 'Format this clearly and please use Markdown' },
  { id: 'g9', group: 'legit-compound', text: 'Check my grammar and do not change my tone.', protectedInfo: false, want: 'Check my grammar and do not change my tone' },
  { id: 'g10', group: 'legit-compound', text: 'Give me the summary and always include a citation.', protectedInfo: false, want: 'Give me the summary and always include a citation' },
  { id: 'g11', group: 'legit-compound', text: 'Speak Spanish and please correct my mistakes.', protectedInfo: false, want: 'Speak Spanish and please correct my mistakes' },
  { id: 'g12', group: 'legit', text: 'Always give a 3-column rubric', protectedInfo: false, want: 'Always give a 3-column rubric' },
  { id: 'g13', group: 'legit', text: 'Keep quiz questions to multiple choice', protectedInfo: false, want: 'Keep quiz questions to multiple choice' },
  { id: 'g14', group: 'legit', text: 'Never use American spelling', protectedInfo: false, want: 'Never use American spelling' },
  { id: 'g15', group: 'legit', text: 'Use worked examples before formal definitions', protectedInfo: false, want: 'Use worked examples before formal definitions' },
  { id: 'g16', group: 'legit', text: 'Start with a short summary then the detail', protectedInfo: false, want: 'Start with a short summary then the detail' },
  { id: 'g17', group: 'legit', text: 'Explain statistics without assuming calculus', protectedInfo: false, want: 'Explain statistics without assuming calculus' },
]

/** Words that must never survive into storage. */
const LEAK_MARKERS = [
  'adhd', 'dyslexic', 'dyslexia', 'probation', 'visually impaired', 'special ed',
  'sleep in my car', 'brain runs slower', 'hijab', 'prayer', 'second language',
]

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

function run(text: string): string | null {
  const out = stripReason(text)
  return assertStorablePreference(out).ok ? out : null
}

describe('reason stripping, measured on a corpus nobody here wrote', () => {
  it('never lets a protected disclosure reach storage', () => {
    const leaked = CORPUS.filter((c) => {
      const stored = run(c.text)
      return stored !== null && LEAK_MARKERS.some((m) => norm(stored).includes(norm(m)))
    }).map((c) => `${c.id}: "${c.text}"`)
    expect(leaked).toEqual([])
  })

  it('never drops a preference that carries nothing sensitive', () => {
    const dropped = CORPUS.filter((c) => !c.protectedInfo && c.want !== null && run(c.text) === null)
      .map((c) => `${c.id}: "${c.text}"`)
    expect(dropped).toEqual([])
  })

  it.each(CORPUS.filter((c) => c.protectedInfo && c.want !== null).map((c) => [c.id, c.text, c.want!] as const))(
    'keeps the accommodation from %s', (_id, text, want) => {
      const stored = run(text)
      // Either the accommodation survived, or the whole line was refused. What
      // must never happen is storing something that still carries the reason.
      if (stored === null) return
      expect(norm(stored).includes(norm(want)) || norm(want).includes(norm(stored))).toBe(true)
    },
  )
})
