/**
 * `remember_preference` — how a stated preference gets into the memory layer.
 *
 * The student says "stop giving me the proofs, just show me a worked example"
 * and it survives the session, so the next conversation already knows. This is
 * the whole point of the memory layer: a prototype against real data showed the
 * derived facts change WHAT Athena talks about, while a stated preference
 * changes HOW, and the how is what reads as being known.
 *
 * `kind: 'create'` is forced, not chosen. `assertBoundedInput` rejects free
 * strings on read/propose tools at load time, and a preference is the student's
 * own words. `create` runs the no-identifier-fields guard instead, which this
 * passes: the text is content, the scope is a bounded enum, and every id comes
 * from the verified ctx. Unlike the other two create tools it is exposed in both
 * drive modes, because remembering something is not Athena driving the app.
 *
 * WHERE THE LINE SITS. Almost every preference about HOW to explain is
 * genuine and gets stored, including ones that sound like lowering the bar:
 * "give me the easiest version", "plain language", "no jargon", "keep it
 * short". Wanting an easier explanation is the accommodation this feature
 * exists to serve, and second-guessing it would make Athena worse at exactly
 * the thing she is for.
 *
 * Two narrow cases do not get stored. One is asking Athena to do the learning
 * instead of supporting it — hand over answers, write the submission, skip the
 * working. That is not a preference, it is an attempt to make cheating the
 * default for every future conversation. The other is a hard cap that makes a
 * real explanation impossible whatever the topic: "two sentences maximum"
 * reads like formatting but is a ceiling on teaching, and because preferences
 * persist, accepting it once applies it to every future turn until somebody
 * notices.
 *
 * The counter-offer matters as much as the refusal, and so does the register.
 * A student asking for two sentences wants less waffle, which is a real want
 * worth keeping in a form that does not cost them the explanation. Landing that
 * as "I cannot comply because complex topics require depth" is technically
 * right and reads like a policy notice; "can't promise two sentences, some of
 * this needs room, but I'll keep it tight" is the same answer from someone who
 * is on their side. Lead with what you can do, keep the reason to half a
 * sentence, and move on.
 *
 * NO CONFIRMATION DIALOG, deliberately. A blocking "shall I remember this?" is
 * clicked through without reading, which makes it a worse gate than none. It
 * saves quietly, says so in the answer, and the student can see and remove
 * anything at /student/preferences#memory. What protects them is visibility and
 * reversibility, not a modal. (There is no in-chat undo control — an earlier
 * version of this comment claimed one. Removing the row on the preferences page
 * IS the reversal, which is why that page has to be findable.)
 */

import { z } from 'zod'
import { logEvent } from '@/lib/supabase/event-logger'
import { writePreference } from '@/lib/memory/preferences'
import { PREFERENCE_MAX_CHARS, preferenceScopeSchema, studentSlotSchema } from '@/lib/validations/memory'
import { defineStudentTool, type AthenaStudentCtx } from './contract'

const INPUT = z.object({
  /* The slot decides what a new statement REPLACES, so an ambiguous description
     costs a student real data. Observed in QA: "use plain language" was filed as
     explanation_style and silently overwrote "prefers worked examples", two
     unrelated preferences colliding because both readings fit. So the boundary
     is drawn explicitly here: explanation_style owns ONLY the pedagogical axis,
     and anything of the always/never kind, accessibility included, is a
     constraint, which is multi-valued and therefore additive. */
  slot: studentSlotSchema.describe(
    'Which kind of preference this is. Each slot REPLACES whatever is already in it, EXCEPT ' +
      'constraint and context, which accumulate. So a slot must only ever hold ONE axis — ' +
      'putting two unrelated wishes in the same slot silently deletes the earlier one. ' +
      'answer_length = how LONG (short, brief, detailed, thorough). ' +
      'language_level = the VOCABULARY (plain language, no jargon, use the real technical terms). ' +
      'explanation_style = the TEACHING APPROACH (worked examples vs derivations, theory-first ' +
      'vs practice-first, analogies, just the definition). ' +
      'tone = how they want to be SPOKEN TO (blunt, encouraging, no jokes). ' +
      'constraint = an always/never rule that stands ALONGSIDE the others, and the right home ' +
      'for anything about FORMATTING or accessibility: "no bullet points", "no code blocks", ' +
      '"avoid red and green", "define any idioms". ' +
      'context = a durable fact about their situation in this course, such as retaking it. ' +
      'If a request could fit two slots, choose constraint — it accumulates, so it cannot ' +
      'destroy anything.',
  ),
  preference: z
    .string()
    .min(1)
    .max(PREFERENCE_MAX_CHARS)
    .describe(
      'The preference in the STUDENT\'s own words, rewritten as a short instruction to yourself. ' +
        '"Prefers worked examples over formal derivations." Never include WHY they want it.',
    ),
  scope: preferenceScopeSchema.describe(
    'course = only in this course (retaking it, this subject is hard). ' +
      'general = them as a learner, everywhere (answer length, tone, accessibility). ' +
      'When unsure choose course: a course preference wrongly marked general follows them ' +
      'into every other class, which is worse than one that simply does not travel.',
  ),
  lastsUntil: z
    .string()
    .max(40)
    .optional()
    .describe(
      'ONLY when the student put a time bound on it in their own words ("this week", "until the midterm"). ' +
        'Repeat their phrasing. Omit it for anything durable, which is almost everything.',
    ),
})

type Input = z.infer<typeof INPUT>
type Result = { saved: boolean; summary: string }

/**
 * Turn a phrase the student used into an expiry, or null.
 *
 * Deliberately a small table rather than a model call or a date parser. If the
 * phrase is not one we recognise, the preference is durable, which is the safe
 * direction: an over-long preference is visible and deletable on the
 * preferences page, whereas one that silently vanished is neither.
 */
/**
 * Everything lapses eventually, even without a stated time bound.
 *
 * Stress-test pass 1 stored five of six preferences as never-expiring,
 * including "can only study on campus during the day", which the student said
 * as "I sleep in my car AT THE MOMENT". A circumstance that was temporary when
 * they said it becomes permanent, and the only exit is the student
 * remembering to open a settings page and delete it.
 *
 * That is the case where memory is worse than no memory: a September "I'm bad
 * at this, give me the easiest explanation" still suppressing rigour in
 * December, with the system never reconsidering. A term is the natural
 * boundary — beyond it, a preference nobody has restated is a guess about a
 * person who has moved on.
 */
export const DEFAULT_TTL_DAYS = 120

const HORIZONS: ReadonlyArray<[RegExp, number]> = [
  [/\btoday\b|\btonight\b/i, 1],
  [/\btomorrow\b/i, 2],
  [/\bthis week\b|\bthis weekend\b|\bnext few days\b/i, 7],
  [/\bnext week\b/i, 10],
  [/\bmidterm\b|\bexam\b|\bfinals?\b|\bquiz\b|\btest\b/i, 21],
  [/\bthis month\b|\bthis unit\b|\bthis chapter\b/i, 30],
  [/\bthis (semester|term)\b|\brest of the (semester|term)\b/i, DEFAULT_TTL_DAYS],
]


/**
 * Turn a phrase the student used into an expiry.
 *
 * Takes the SHORTEST horizon of every phrase that matches, not the first one
 * found. "until the midterm next week" contains both "next week" and
 * "midterm"; returning the first match gave 14 days for an exam about 7 days
 * away, so answers stayed truncated for a week afterwards with no explanation.
 * The nearest signal in the sentence is the one the student meant.
 *
 * With no recognised phrase this falls back to the term default rather than to
 * "forever" — see DEFAULT_TTL_DAYS.
 */
export function expiryFromPhrase(phrase: string | undefined, now = Date.now()): string {
  let days = DEFAULT_TTL_DAYS
  if (phrase) {
    for (const [pattern, horizon] of HORIZONS) {
      if (pattern.test(phrase)) days = Math.min(days, horizon)
    }
  }
  return new Date(now + days * 86_400_000).toISOString()
}

export const rememberPreference = defineStudentTool({
  name: 'remember_preference',
  kind: 'create',
  label: 'Remembering that',
  description:
"Remember how THIS student wants to be helped, so future conversations already know. STORE almost anything about HOW they want things explained, including requests that sound like lowering the bar — \"give me the easiest version\", \"plain language\", \"no jargon\", \"keep it short\" are all genuine and all get stored. Wanting things simpler is the point of this feature, not something to argue with. DECLINE only two narrow kinds. First, anything asking you to do the learning instead of supporting it: hand over answers, write the submission, skip the working, stop correcting mistakes. Storing that makes cheating the default in every future conversation. Second, a hard cap that makes a real explanation impossible on any topic, such as \"two sentences maximum\" — that is a ceiling on teaching rather than a formatting choice. HOW TO DECLINE, and this matters as much as the decision: be warm and land it lightly. Give the reason in half a sentence, not a paragraph, then spend the rest on what you CAN do — \"I can't hold every answer to two sentences, some of this needs room to explain properly, but I can keep things crisp and cut the waffle\". The student asked for something real; find the version of it you can honour and offer that, in their register, then get on with helping. Never lecture them about why the request was wrong, never stack up justifications, and never make it sound like a policy. Call it when they tell you a preference about your answers — shorter, more examples, less theory, a different tone, something to always avoid — or when they state a durable fact about their situation in this course such as retaking it. Do NOT call it for a one-off instruction about the current answer (\"just this once\", \"for this question\"), for anything they are venting rather than asking for (\"I'm so bad at this\"), or for something you inferred rather than heard. NEVER store WHY they want something when the reason is health, a disability, family, money, immigration, or any protected characteristic: store only the accommodation itself, so \"I'm dyslexic, use plain language\" is remembered as \"Prefers plain language\" and the reason is dropped. Never store grades, scores, contact details, or anything about another person. Saving is silent and instant. Afterwards tell the student in one short clause what you saved, and get straight on with answering them. Mention that they can change it on their Preferences page ONLY the first time you save something in a conversation — repeating it every time reads as nagging.",
  input: INPUT,
  describe: (r: Result) => r.summary,
  run: async (ctx: AthenaStudentCtx, input: Input): Promise<Result> => {
    const result = await writePreference(ctx.adminDb, {
      userId: ctx.userId,
      institutionId: ctx.institutionId,
      // `general` writes a null section. The tool never names a section id —
      // the one it could write to is the verified one on the ctx.
      sectionId: input.scope === 'general' ? null : ctx.sectionId,
      slot: input.slot,
      text: input.preference,
      expiresAt: expiryFromPhrase(input.lastsUntil),
    })

    if (!result.ok) {
      // Hand the reason back so the model can retry with just the accommodation
      // instead of silently dropping what the student asked for.
      return { saved: false, summary: `not saved: ${result.reason}` }
    }

    await logEvent({
      userId: ctx.userId,
      sectionId: ctx.sectionId,
      eventType: 'memory.preference_saved',
      eventCategory: 'student',
      metadata: { slot: input.slot, scope: input.scope, expires: !!input.lastsUntil },
    })

    return { saved: true, summary: input.scope === 'general' ? 'saved for every course' : 'saved for this course' }
  },
})
