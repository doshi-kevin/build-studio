/**
 * Memory layer — the preference slot vocabulary and what may never be stored.
 *
 * Pure module: no DB, no server-only. The write path (lib/memory/preferences.ts)
 * enforces these, and the unit tests exercise them directly.
 *
 * A SLOT IS NOT A TAXONOMY. `kind` exists to decide which existing row a new
 * statement replaces — nothing more. The user's actual words go in `text`
 * verbatim, so the vocabulary never constrains what someone can say, only how
 * many competing statements of the same type can coexist. That distinction is
 * why the list is allowed to be this short: widening it later is one line, and
 * a rejected capture is logged so the real vocabulary comes from usage rather
 * than from guessing.
 */

import { z } from 'zod'

/** Slots that hold exactly one value — a second statement REPLACES the first,
 *  because "keep it short" and "give me full detail" cannot both be true.
 *
 *  `language_level` is split out from `explanation_style` deliberately. A
 *  simulated term of contradictory statements (tmp/sim/collisions.ts) showed one
 *  style slot absorbing three unrelated axes — register, teaching approach and
 *  formatting — so "use plain language, no jargon" evicted "show worked
 *  examples", and "show worked examples" was later evicted by "no bullet
 *  points". Roughly a third of all evictions destroyed something orthogonal.
 *  Replacement is only correct when the two statements genuinely contradict, so
 *  each single-value slot must own exactly ONE axis. Formatting is not a slot at
 *  all: it belongs in `constraint`, which accumulates. */
export const SINGLE_VALUE_SLOTS = ['answer_length', 'explanation_style', 'language_level', 'tone'] as const

/** Slots that hold several — a second statement APPENDS, because being
 *  colour-blind and being an international student are both true at once.
 *  Blind-upserting these is data loss: it silently erases the first constraint
 *  the moment a second arrives. */
export const MULTI_VALUE_SLOTS = ['constraint', 'context'] as const

/**
 * Professor slots. Deliberately NOT the student ones, for two reasons.
 *
 * Thrash: a professor's work is several modes at once — drafting an
 * announcement, writing a quiz, grading. "Warm and encouraging in announcements"
 * and "strict when grading" are both true, and both would land in the student
 * `tone` slot, where the second silently erases the first. Splitting by the kind
 * of work keeps them apart.
 *
 * Role separation: the same person can be a teaching assistant in one section
 * and a student in another. One table keyed on user_id would otherwise let their
 * general student preference ("explain it simply") bleed into announcement
 * drafting. Because each surface only ever reads its own slots, the boundary
 * falls out of the `kind` column with no extra column to keep in sync.
 */
export const PROFESSOR_SINGLE_VALUE_SLOTS = [
  'announcement_style',
  'quiz_style',
  'grading_style',
] as const

/** Additive on the professor side too: "no group work" and "always give a rubric"
 *  are separate standing rules, not competing values of one setting.
 *
 *  ONE additive slot, not two. `workflow` and `prof_constraint` both existed and
 *  behaved identically, so the model picked between them arbitrarily and a
 *  professor's standing rules ended up split across both. Two names for one
 *  behaviour earn nothing.
 *
 *  `workflow` is here rather than with the replacing slots because it is the
 *  catch-all, and a catch-all cannot replace. Observed in the browser: a
 *  professor said "never suggest group work in this course" and then "always
 *  include a worked example". Both landed in `workflow`, and because one was
 *  course-scoped and the other general, scope precedence silently dropped the
 *  second. Three rows were stored and two reached the prompt. The three named
 *  slots above still replace, because "warm announcements" and "formal
 *  announcements" really are competing values of one setting. */
export const PROFESSOR_MULTI_VALUE_SLOTS = ['workflow'] as const

export const PROFESSOR_SLOTS = [
  ...PROFESSOR_SINGLE_VALUE_SLOTS,
  ...PROFESSOR_MULTI_VALUE_SLOTS,
] as const
export type ProfessorSlot = (typeof PROFESSOR_SLOTS)[number]
export const professorSlotSchema = z.enum(PROFESSOR_SLOTS)

/** Every slot the student tutor reads and writes. */
export const STUDENT_SLOTS = [...SINGLE_VALUE_SLOTS, ...MULTI_VALUE_SLOTS] as const

export const PREFERENCE_SLOTS = [
  ...SINGLE_VALUE_SLOTS,
  ...MULTI_VALUE_SLOTS,
  ...PROFESSOR_SLOTS,
] as const
export type PreferenceSlot = (typeof PREFERENCE_SLOTS)[number]

/** Every slot that can appear in the table. For READING and parsing only — a
 *  capture tool must bind its own surface's schema, or the model on one surface
 *  can write a row the other surface will read. */
export const preferenceSlotSchema = z.enum(PREFERENCE_SLOTS)

/** What the STUDENT tutor's capture tool may write. */
export const studentSlotSchema = z.enum(STUDENT_SLOTS)

export function isProfessorSlot(slot: string): boolean {
  return (PROFESSOR_SLOTS as readonly string[]).includes(slot)
}

/** Where a preference applies. Not the same axis as how long it lasts. */
export const PREFERENCE_SCOPES = ['general', 'course'] as const
export type PreferenceScope = (typeof PREFERENCE_SCOPES)[number]
export const preferenceScopeSchema = z.enum(PREFERENCE_SCOPES)

/** How many rows a multi-value slot keeps per scope before the oldest drops. */
export const MULTI_VALUE_CAP = 3

/** Longest stored preference line. Long enough for a real sentence, short
 *  enough that no single row can dominate the prompt budget. */
export const PREFERENCE_MAX_CHARS = 160

export function isSingleValueSlot(slot: PreferenceSlot): boolean {
  return (
    (SINGLE_VALUE_SLOTS as readonly string[]).includes(slot) ||
    (PROFESSOR_SINGLE_VALUE_SLOTS as readonly string[]).includes(slot)
  )
}

/** The slots one surface may read, so a dual-role user's student rows never
 *  reach the professor prompt and vice versa. */
export function slotsForSurface(surface: 'student' | 'professor'): readonly string[] {
  return surface === 'professor' ? PROFESSOR_SLOTS : STUDENT_SLOTS
}

/** Words too generic to make two preferences "the same rule". */
const PREFERENCE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'use', 'used', 'using', 'not', 'never', 'always',
  'please', 'answer', 'answers', 'response', 'responses', 'explain', 'explanation',
  'explanations', 'prefers', 'prefer', 'wants', 'want', 'student', 'them', 'they',
  'avoid', 'give', 'keep', 'make', 'your', 'you', 'this', 'that', 'when', 'only',
  // Words that recur across unrelated preferences in a course context. Left in,
  // they are the single shared token that makes two different rules look alike.
  'course', 'example', 'examples', 'describe', 'code', 'step', 'steps',
])

/** The content words of a preference, for deciding whether two say the same thing. */
export function preferenceTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !PREFERENCE_STOPWORDS.has(t)),
  )
}

/**
 * Do two preferences express the SAME rule?
 *
 * Exact-text dedup is not enough, and the gap is not theoretical. In the stress
 * test a student said "do not use bullet points", then "NEVER USE BULLET POINTS,
 * use paragraphs only", then "please avoid bullet lists". Three rows, one rule,
 * and between them they consumed the whole three-row cap and evicted the
 * student's "never suggest studying on Saturdays" — an accommodation they had
 * given a real reason for. No adversarial intent, just a person rephrasing.
 *
 * So a new statement REPLACES an existing one when they share a content word.
 * Deliberately lexical, like the deriver's near-synonym collapse: catching
 * "no lists" against "use prose" needs embeddings, which this layer does not
 * have. Erring toward replace is the safe direction here — the alternative is
 * eviction of something unrelated, which is what actually hurt.
 */
/**
 * How alike two preferences must be to count as one rule, measured as shared
 * content words over the union of both.
 *
 * Set from the two cases that pull in opposite directions. "do not use bullet
 * points" and "please avoid bullet lists" ARE one rule and score 0.33. "avoid
 * green tea as an example" and "avoid red and green pairings, I cannot tell
 * them apart" are NOT, and score 0.13, because the second carries a colour-
 * blindness accommodation the first knows nothing about. A single shared word
 * cannot separate those; the proportion of each preference it represents can.
 */
const SAME_RULE_MIN_OVERLAP = 0.3

/**
 * Whether two preferences say the same thing, so the newer one should replace
 * the older rather than sit beside it.
 *
 * Deliberately hard to satisfy. Matching wrongly DELETES the older row, and the
 * rows most likely to collide by accident are the specific ones — a screen
 * reader, a colour pairing — which are exactly the accommodations that matter
 * most. Failing to match only risks the cap evicting the oldest, which the
 * student can see in the pane and restate. Err toward keeping both.
 */
export function isSameRule(a: string, b: string): boolean {
  const ta = preferenceTokens(a)
  const tb = preferenceTokens(b)
  if (ta.size === 0 || tb.size === 0) return false

  let shared = 0
  for (const t of ta) if (tb.has(t)) shared += 1
  if (shared === 0) return false

  const union = ta.size + tb.size - shared
  return shared / union >= SAME_RULE_MIN_OVERLAP
}

// ── What may never be stored ─────────────────────────────────────────────────

/**
 * Categories the memory layer refuses, checked server-side before the insert.
 *
 * The tool description also tells the model not to capture these, but a prompt
 * rule is guidance and this is the control. The governing principle is **store
 * the accommodation, never the reason**: "I'm dyslexic, use plain language"
 * should persist as `use plain language`, because the accommodation is the
 * entire useful part and the diagnosis is a health disclosure we have no reason
 * to hold.
 *
 * Deliberately keyword-based rather than a model call. It runs on every write,
 * it must be deterministic and testable, and a false positive costs one
 * un-remembered preference while a false negative puts a health disclosure in a
 * database. Erring toward refusal is correct here.
 */
const REFUSED_PATTERNS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  {
    /* Word boundaries cut both ways and this list has been caught on each in
       turn. A missing plural means the singular matched and the word people use
       did not. A prefix does the same at the front: `depress\w*` cannot see
       "antidepressants", because the boundary it needs sits in the middle of
       the word. Anything that commonly takes a prefix is listed in its own
       right rather than left to a stem.

       Several entries carried no plural, so the singular matched and the word
       people actually use did not: wave 6 stored "no examples with loud noises,
       they set off my migraines" because the pattern said `migraine` and the
       word boundary refused to end mid-word. Anything that can be pluralised
       carries \w* now.

       `stutter`, `hard of hearing`, `wheelchair`, `seizure` and `learning plan`
       were added after wave 2 of the stress corpus stored "do not ask me to read
       aloud, I stutter" whole. The list is not a taxonomy of disability, it is a
       record of the words people have actually used that the previous version
       missed. */
    category: 'health or disability',
    pattern:
      /\b(dyslex\w*|dyscalcul\w*|adhd|special ed(ucation)?\b|\biep\b|504 plan|autis\w*|asperger\w*|aspie|neurodiverg\w*|disabilit\w*|disabled|impair\w*|blind|deaf|chronic|illness|ill|sick|diagnos\w*|disorder\w*|syndrome\w*|medicat\w*|therapy|therapist|depress\w*|anxiet\w*|anxious|bipolar|ptsd|ocd|adderall|ritalin|antidepressant\w*|antipsychotic\w*|\bssri\w*|beta[- ]?blocker\w*|concussion\w*|migraine\w*|surger\w*|hospital\w*|stutter\w*|stammer\w*|speech (impediment|difference|delay)|non[- ]?verbal|hard of hearing|low vision|wheelchair|crutches|seizure\w*|epilep\w*|learning plan|stroke\w*|heart attack\w*|cancer|dialysis|transplant|relapse|flare[- ]?up)\b/i,
  },
  {
    category: 'family, financial, immigration or housing circumstances',
    /* `hospice` and the "my <relative>" shapes were added after a stress run
       stored "keep it gentle right now, my mum is in hospice" whole. The line
       has no causal connective, so stripReason leaves it alone, and none of the
       words above appear in it. Naming a relative is the shape these
       disclosures actually take. */
    pattern:
      /\b(divorc\w*|custody|bereave\w*|funeral|died|passed away|evict\w*|homeless|temporary housing|emergency housing|housing|hostel|sofa surf\w*|broke|poverty|scholarship|financial aid|fafsa|loan|debt|visa|immigrat\w*|deport\w*|asylum|undocumented|green card|refugee|first in my famil\w*|first[- ]generation|first[- ]gen\b|hospice|palliative|terminally ill|life support|rent|mortgage|utility bills|paying the bills|paycheck|pay check|minimum wage|work nights|night shift|two jobs|second job|payment plan|tuition|bursary|hardship fund|food stamps|my (mum|mom|mother|dad|father|grandma|grandpa|grandmother|grandfather|brother|sister|husband|wife|partner|son|daughter|kid|kids|child|children))\b/i,
  },
  {
    /* Military service sits here because in the United States it is a protected
       characteristic, and because "I am a veteran and have been out of education
       for a decade" was stored whole by every earlier version. */
    category: 'protected characteristic',
    pattern:
      /\b(muslim|christian|jewish|hindu|buddhist|sikh|atheist|catholic|religio\w*|my faith|devout|my religion|gay|lesbian|bisexual|transgender|trans|queer|lgbt\w*|pregnan\w*|black|white|asian|latino|latina|hispanic|race|racial|ethnic\w*|republican|democrat|conservative|liberal|veterans?|army|air force|marine corps|national guard|rotc|active duty|military service|deployed overseas|woman|women|nonbinary|non[- ]binary|my pronouns|gender identity)\b/i,
  },
  {
    /* Observed slipping through in stress-test pass 1. Every one of these is a
       real thing a student says, and none matched the original list. Keyword
       matching will never be complete — that is why `stripReason` below exists
       as the structural half — but the misses we have actually seen belong
       here. */
    category: 'a personal circumstance',
    pattern:
      /\b(brain (runs|works)|processing (difference|issue)|slower in the|sleep in my car|couch ?surf\w*|shelter|food bank|skip meals|academic probation|probation|suspend\w*|expel\w*|sabbath|shabbat|shabbos|hijab\w*|prayer\w*|mosque|church|synagogue|temple|fast\w* during|ramadan|passover|lent|eid|diwali|yom kippur|rosh hashanah|mature student|my age|pills|meds|drowsy|insomnia|panic|burn(t|ed) out|breakdown|unwell|passed|caring for|carer|custody|court date)\b/i,
  },
  {
    /* National origin and language background. This gap was found by a simulated
       term (tmp/sim/collisions.ts), which stored "Define complex words because
       English is not the student's first language" — the accommodation kept
       along with the reason, which is exactly what the rule forbids. Refusing
       the whole line is right: the model is handed the category and retries with
       just "define complex words", as it already does for a health disclosure. */
    category: 'national origin or language background',
    pattern:
      /\b(first language|native (language|speaker)|second language|non[- ]native|esl\b|english (is|isn't|is not|as a)\b|international student|grew up speaking|from (china|india|korea|japan|brazil|mexico|nigeria|iran|vietnam)\b|nationality|citizenship|accent)\b/i,
  },
  {
    /* Age. Not a keyword at all, which is why no list was ever going to hold it:
       what gives it away is the shape "I am <two digits>". Added after wave 3
       stored "I am 52 and coming back to study after a long time away". */
    category: 'age',
    pattern: /\b(i am|i'?m)\s+\d{2}\b|\b\d{2}\s+years old\b/i,
  },
  {
    category: 'contact details or identifiers',
    pattern:
      /(\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|\b\d{9}\b|\bpassword\b|\bssn\b)/i,
  },
  {
    category: 'a grade or score',
    // Grades are derived live and never copied, so a stored one can only go stale.
    pattern: /\b(\d{1,3}\s?%|got an? [a-df][+-]?\b|scored\b|my gpa\b|failed the\b|passed the\b)/i,
  },
]

/**
 * A standing request to be handed the answer instead of doing the work.
 *
 * Checked separately from the list above, and only for student slots, because
 * it is not a disclosure and because the same words are ordinary coming from a
 * professor: "skip the explanation in announcements" is a reasonable house
 * style, and "do not make me re-enter the rubric" is a reasonable workflow.
 *
 * It belongs in the memory layer rather than only in the tutor's prompt because
 * MEMORY is what makes it durable. A single turn of "just give me the answer"
 * is one turn the tutor can decline. The same sentence stored as a preference
 * re-asserts itself on every future turn, including graded work, and the
 * student never has to ask again.
 *
 * The line between this and a legitimate preference is whether the reasoning is
 * being reordered or removed. "give me the answer first, then the explanation"
 * and "lead with the short answer, then expand" are structure and are kept.
 *
 * Two of these arms are narrower than they look, and both were widened once and
 * had to be pulled back:
 *
 *  - "answer ... directly" needs an explicit object and must not be followed by
 *    a clause that puts the reasoning back. Without the object it fired on
 *    "for quiz questions answer directly"; without the lookahead it refused
 *    "answer questions directly, then give the detail", which is the same
 *    answer-first structure the paragraph above promises to keep.
 *  - "submit" only counts after "I can". Matching a bare "to submit" refused
 *    "remind me what I need to do to submit the assignment", which is a person
 *    asking about logistics and nothing to do with handing over work.
 */
const STANDING_ANSWER_REQUEST =
  /\b(?:no|without|skip(?:ping)?|omit(?:ting)?)\s+(?:the\s+)?(?:explanation|explanations|explaining|reasoning|rationale|justification|working(?:\s+out)?)\b|\b(?:do|write|complete|finish|solve|fill in)\s+(?:my|the)\s+(?:\w+\s+){0,2}(?:homework|assignment|assignments|problem set|problem sets|coursework|essay|lab report|worksheet|blanks|discussion post|reflection|journal entry|quiz|exam|solution|solutions|proof|answer key)\b|\b(?:don'?t|do not|never)\s+make me\s+(?:work|think|figure|solve|derive|prove|try)\b|\b(?:don'?t|do not|never)\s+(?:teach|tutor|quiz)\s+me\b|\bpaste\b[^.]{0,40}\b(?:assignment|homework|submission|problem set|quiz|exam)\b|\banswer\s+(?:them|it|the\s+questions?|questions?)\s+directly\b(?![^.]*\b(?:then|after that|followed by)\b)|\bi can\s+(?:submit|hand in|turn in)\b|\b(?:tell|give)\s+me\s+(?:which|the)\s+(?:option|answer|choice)\s+(?:is|that is)?\s*(?:correct|right)\b|\bno need to (?:show|explain|justify)\b|\b(?:i will not|i'?m not|i won'?t)\s+(?:be\s+)?(?:read|reading|looking at)\s+(?:it|them|any of it|the code|the answer|the solution|the output)\b/i

/** Refuse a student preference that makes "just give me the answer" permanent. */
export function assertNotStandingAnswerRequest(text: string): PreferenceCheck {
  if (!STANDING_ANSWER_REQUEST.test(text)) return { ok: true }
  return {
    ok: false,
    reason:
      'asks me to hand over answers rather than work through them, and storing it would ' +
      'apply to every future turn. Say how you want answers shaped instead.',
  }
}

const INSTRUCTION_OPENER =
  /^\s*(keep|use|explain|avoid|give|show|define|never|no\b|don'?t|do not|add|prefer|describe|skip|lead|make|start|stick|break|write|include|leave|put|treat|ask|check|focus|limit|go|walk|talk|speak|stay|tell|send|remind|split|simplify|expand|shorten)\b/i

/** A clause about the student rather than about the answer. */
const FIRST_PERSON = /\b(i|i'?m|i'?ve|i'?d|my|me|mine)\b/i

function looksLikeInstruction(clause: string): boolean {
  if (INSTRUCTION_OPENER.test(clause)) return true
  return !FIRST_PERSON.test(clause)
}

function carriesDisclosure(clause: string): boolean {
  return REFUSED_PATTERNS.some(({ pattern }) => pattern.test(clause))
}

/**
 * Remove the REASON from a preference, keeping the accommodation.
 *
 * Keyword lists chase phrasings forever; this chases GRAMMAR, which is a much
 * smaller space. "Use plain language because I'm dyslexic" and "I'm dyslexic so
 * use plain language" are the same shape: an accommodation and a justification
 * joined by a causal connective. Whatever the justification is, health, housing,
 * faith, money, something we never thought of, it sits on one side of that word
 * and can be cut without knowing what it says.
 *
 * WHICH side is the trap. "because" and "since" always introduce the reason, so
 * the head survives. "so" does not: "keep it short so I stay focused" puts the
 * purpose second, while "I'm dyslexic so use plain words" puts the accommodation
 * second. An earlier version always kept the tail after "so" and therefore
 * stored "I stay focused" while deleting "keep it short", writing in exactly the
 * disclosure it exists to remove. Position is not a signal; shape is.
 *
 * Not complete either: "I'm on probation, keep it encouraging" has no
 * connective, which is what the keyword list is still for. Two partial defences
 * that fail differently beat one that fails everywhere.
 */
export function stripReason(text: string): string {
  let out = text.trim()

  /* Three shapes where the reason is attached WITHOUT a causal word. These turn
     refusals into clean saves: "As someone with ADHD, break things down" used to
     be dropped whole, so the student lost the accommodation and got no
     explanation.

     GUARDED, and the guard is the whole point. These cut at the first comma and
     keep the remainder, so without a check on what survives they will happily
     delete the clause the denylist would have caught and store the one it does
     not know: "As a student with dyslexia, my mom is in hospice, keep answers
     gentle" cut down to a stored hospice disclosure, where refusing the whole
     line was the correct answer. So the survivor has to read as an instruction
     to us, and must not be a sentence about the student. If it does not, keep
     the original and let the keyword check refuse it.

     A fourth shape, splitting on " and ", was tried and removed. It needed no
     comma, so it fired on ordinary sentences and silently deleted half of them:
     "I am fine with long answers and never use bullet points" stored only the
     second half. It closed no measured leak. */
  const cutByShape = (m: RegExpMatchArray | null): boolean => {
    if (!m) return false
    const candidate = m[1].trim()
    if (!INSTRUCTION_OPENER.test(candidate) || FIRST_PERSON.test(candidate)) return false
    out = candidate
    return true
  }

  const SHAPES: RegExp[] = [
    /^as\s+(?:a|an|someone|one)\b[^,]+,\s*(.+)$/i,
    /^(?:being|having|dealing with|living with|suffering from|diagnosed with)\b[^,]+,\s*(.+)$/i,
    /^(?:i\s+(?:am|have|was)|i'm|my\s+(?:situation|background)\s+is)\b[^,]+,\s*(.+)$/i,
  ]
  for (const shape of SHAPES) {
    if (cutByShape(out.match(shape))) break
  }

  // "accommodation BECAUSE reason" — these connectives only ever introduce the
  // reason, so the head is always the part worth keeping.
  const trailing = out.match(
    // "bc", "cuz", "b/c" and "coz" are here because people type them constantly
    // and leaving them out did not just miss the cut, it destroyed the whole
    // preference: "pls no bullet points bc my adhd goes crazy" kept the reason,
    // hit the health keyword, and the student lost "no bullet points" entirely.
    // A connective list written in formal English fails the people most likely
    // to be stating an accommodation in the first place.
    /^(.{6,}?)[,;]?\s+\b(because|becos|becoz|bc|b\/c|bcs|cuz|coz|cos|since|as i|due to|owing to|on account of)\b/i,
  )
  if (trailing) out = trailing[1]

  // "so" is ambiguous and position tells us nothing. "Keep it short SO I stay
  // focused" puts the purpose second; "I'm dyslexic SO use plain words" puts the
  // accommodation second. Decide by which half reads as an instruction to us,
  // and failing that by which half carries the disclosure.
  const split = out.match(/^(.{6,}?)[,;]?\s+\b(?:so(?: that)?|therefore|which means|meaning)\b[,]?\s+(.{6,})$/i)
  if (split) {
    const [head, tail] = [split[1].trim(), split[2].trim()]
    const headIsInstruction = looksLikeInstruction(head)
    const tailIsInstruction = looksLikeInstruction(tail)
    if (headIsInstruction !== tailIsInstruction) {
      out = headIsInstruction ? head : tail
    } else if (carriesDisclosure(head) !== carriesDisclosure(tail)) {
      out = carriesDisclosure(head) ? tail : head
    } else {
      // Genuinely ambiguous. Keep the head, which is the commoner shape, and
      // let assertStorablePreference refuse it if it carries anything.
      out = head
    }
  }

  return out.replace(/\s+/g, ' ').replace(/^[,;\s]+|[,;\s]+$/g, '').trim()
}

/**
 * Whether a professor's line is ABOUT SOMEONE ELSE rather than about how the
 * assistant should behave.
 *
 * This is the professor side's version of "store the accommodation, never the
 * reason", and it matters more. A student talking to the tutor is talking about
 * themselves. A professor is talking about a room full of other people: "Sarah
 * keeps missing deadlines", "the back row is disengaged", "plan for my three
 * failing students". Storing any of that writes a named or identifiable
 * student's academic standing into an AI prompt store that only the professor
 * can see or delete, which is not ours to keep and not something the student
 * ever agreed to.
 *
 * Name detection alone does not work, because "the back row" and "the student
 * failing the midterm" carry no name. So this looks for the SHAPE of a sentence
 * about other people: a third-person subject, a possessive over a person noun,
 * or a count of students. It is a backstop under a tool description that already
 * says configuration only, not the first line of defence.
 *
 * It will occasionally refuse something legitimate ("address students by their
 * first name"). That is the right direction to fail: the professor sees the
 * refusal and can rephrase, whereas a student whose data we stored sees nothing.
 */
const THIRD_PARTY_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  {
    category: 'a specific student or group of students',
    // "Sarah is...", "the back row", "my three failing students", "those kids"
    pattern:
      /\b(\d+|one|two|three|several|some|most|a few|the)\s+(of\s+(my|the)\s+)?(student|kid|learner|freshman|senior|athlete|TA|teaching assistant)s?\b|\bthe (back|front) row\b|\b(this|that|those|these) (student|kid|group|section|cohort)s?\b/i,
  },
  {
    category: 'someone else\'s performance or behaviour',
    pattern:
      /\b(keeps? (missing|skipping|forgetting)|turns? (it |them )?in late|hands? (it |them )?in late|missing (deadlines|classes|lectures|sessions)|struggl\w*|disengag\w*|failing|falling behind|cheat\w*|plagiaris\w*|absent|skipping|dropped out|at risk|repeat offender|low performer|high performer|first[- ]generation|(the|my|our|those|these)\s+(first|second|third|fourth)[- ]years|finalists?|strugglers?|repeaters?|the ones who|those who|median was|average was|attendance has|bottom (quartile|third|half|quarter|decile)|top (quartile|third|quarter|decile)|intervention plan|turns? (it |them )?in late|hands? (it |them )?in late)\b/i,
  },
  {
    category: 'a particular person',
    // Possessive over a name or a person: "Sarah's essay", "her work", "his
    // accommodation". The docstring claimed this from the start and it was not
    // actually implemented, which is why "Sarah's essay was weak" was stored.
    pattern: /\b(\w+'s\s+(essay|submission|grade|accommodation|attendance|behaviour|behavior|participation|iep)|(her|his|their|that student's|the student's)\s+\p{L}{3,})\b/iu,
  },
  {
    category: 'a portion of the class',
    pattern:
      /\b((half|most|many|some|a lot|a couple|a handful)\s+(of\s+)?(my|the|them|this)?\s*(class|students|kids|room|cohort|section)|the\s+\w+\s+ones|the\s+ones\b|everyone\s+(is|was|has|struggles)|nobody\s+(is|was|has|did)|the (quiet|loud|strong|weak|struggling|advanced|slower|faster)\s+\w*)/i,
  },
  {
    category: 'a particular person by identifier',
    // Names are not the only way to point at one student. An id, a seat, or a
    // set of initials singles someone out just as precisely, and the roster
    // check cannot see any of them.
    pattern:
      /(\b(id|user|student|learner|submission)\s*#?\s*\d{2,}\b|#\s*\d{1,6}\b|\b(seat|desk|row|table|station|bench)\s+(\w*\d\w*|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b([a-z]\s*\.\s*){2,}[a-z]?\b|\b(\d{1,3}\.){3}\d{1,3}\b)/i,
  },
  {
    category: 'an accommodation, medical need, or protected characteristic of a student',
    // The most likely real incident is not a clever attack. It is a professor
    // sincerely trying to honour an accommodation and telling us who has it.
    pattern:
      /\b(iep\b|504\s*plan|accommodation|extra time|screen reader|visually impaired|hearing impaired|neurodiverg\w*|non[- ]native|esl\b|pregnan\w*|allerg\w*|mental health|medical|diagnos\w*|disabilit\w*|counsel\w*|withdrawn learner)/i,
  },
  {
    category: 'one unnamed individual singled out',
    pattern:
      /\b(the (new|quiet|loud|shy|older|younger|tall|short|angry|difficult|smart|slow) (kid|one|student|guy|girl|boy|man|woman)|the kid\b|the one (who|in|with)|in the corner|the (frat|football|athlete)s? (boys?|guys?|kids?)?|the two (boys|girls|kids|students))/i,
  },
  {
    category: 'students identified by a score threshold',
    // "anyone under 60 percent" names a set of real students by their grades.
    pattern:
      /((under|below|above|over|less than|more than)\s+\d{1,3}\s*(percent|%|marks?|points?)|(bottom|top)\s+(\d{1,3}\s*(percent|%)|(twenty|thirty|forty|fifty|ten|five|quarter|half|third)\b))/i,
  },
  {
    category: 'a person picked out without naming them',
    /* No name at all, and still exactly one real student. Written as SHAPES
       rather than a word list, because the word list is what kept failing:
       "the girl who missed week two" and "my weakest writer" both name somebody
       precisely without using a listed adjective. */
    pattern:
      /\b(whoever|whichever (student|one)|any(one|body) who|those who|the \w+ who\b|the (person|girl|boy|guy|man|woman|kid|child|student|one)\b|(my|our) (\w+est|best|worst|top|only|star|strongest|weakest) \w+|(transfer|exchange|international|mature|returning) student|the student (i|we)\s|the one (i|we)\s|mr|mrs|ms|miss|dr)\b/i,
  },
  {
    category: 'an instruction that would override how you work rather than configure it',
    // Never a legitimate working preference, and it lands in every future prompt
    // for the section, so a single line could change how a whole class is graded.
    pattern:
      /\b(ignore (all |your |the )?(previous|prior|above|earlier)|disregard (the|your|all)|override your|full marks to (everyone|all)|grant (everyone|all) full|system prompt|your (initial|hidden|secret)? ?instructions|reveal your|print your (system|initial)|repeat your|grant full marks|award (full|100)|automatically (fail|zero|penali[sz]e)|auto[- ]fail)/i,
  },
  {
    category: 'a third party rather than how to help you',
    // "he/she/they" as a sentence subject. "them" and "their" are excluded on
    // purpose: "explain it to them simply" is about the audience, not a person.
    /* "he" or "she" followed by ANY verb-shaped word. The previous version
       listed the verbs, which is the mistake this file keeps making: "he writes
       slowly", "she speaks softly" and "he learns visually" all walked through a
       list built from "is/was/has/needs".
       "they" is deliberately NOT here. It is the pronoun a professor uses for
       the whole class ("make sure they understand the basics"), so treating it
       as a person would refuse ordinary preferences. Singular he/she cannot mean
       the class. */
    pattern: /\b(he|she)\s+\p{L}{2,}\b/iu,
  },
]

/**
 * Refuse anything that reads as a fact about the world or about a person rather
 * than an instruction for the assistant. Professor surfaces only.
 */
export function assertStorableProfessorPreference(text: string): PreferenceCheck {
  const base = assertStorablePreference(text)
  if (!base.ok) return base

  for (const { category, pattern } of THIRD_PARTY_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ok: false,
        reason:
          `looks like it describes ${category}. Memory holds how you want me to work, ` +
          'not facts about your students. Tell me the working preference on its own.',
      }
    }
  }

  return { ok: true }
}

/**
 * The same check plus an exact test against this section's roster.
 *
 * The proper-noun rule above is a heuristic and will miss a lowercase name or an
 * unusual one. The roster is not a heuristic: if the text contains the first or
 * last name of somebody enrolled in this section, it is about them. Worth the one
 * extra query because writes are rare and the cost of being wrong is a student's
 * record sitting in a prompt store they cannot see.
 */
/** Escape a roster name before it goes into a regex.
 *
 *  Names are user data. "O(Brien" makes an unterminated group and throws, and a
 *  name of "." matches everything, which would refuse every preference the
 *  professor ever states. Neither fails toward storing a name, but both break
 *  the control using nothing more than ordinary roster data. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The same check plus a test against this section's roster.
 *
 * The roster is the part that is not a guess. Regexes describe the shape of a
 * sentence about people; the roster answers the only question that actually
 * matters, which is whether this text names somebody enrolled in this course.
 * It is also why an earlier capitalisation heuristic could be removed: that
 * blocked "APA", "Excel" and "Foucault", and taught professors to write in
 * lowercase, which would have broken this check too. This one is
 * case-insensitive on purpose.
 */
export function assertStorableProfessorPreferenceWithRoster(
  text: string,
  rosterNames: readonly string[],
  /** Students in the professor's OTHER sections, as "First Last" pairs.
   *
   *  Matched as a full name rather than on either part alone, and that split is
   *  the whole point. Checking every section's first names against every
   *  preference sounded safer and was not: a student called "Line" in one course
   *  made "quote the line you applied" unstorable in all of them, and the same
   *  goes for Grace, May, Art and Page. Caught in the browser, not in review.
   *  Where the professor is talking, a single name is enough to mean a person.
   *  Referring to somebody in a different course almost always uses both parts,
   *  and requiring both keeps the common-word collisions out. */
  otherSectionFullNames: readonly string[] = [],
): PreferenceCheck {
  const base = assertStorableProfessorPreference(text)
  if (!base.ok) return base

  /* Compare with accents folded away. A roster "Chloe" and a typed "Chloë" are
     the same student, and a check that misses that is a check a professor can
     defeat by accident. */
  const fold = (v: string) =>
    v
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Zero-width and other format characters read as nothing to a person and
      // to the model, but would otherwise split a name in two here.
      .replace(/\p{Cf}/gu, '')
      .toLowerCase()
  const lower = fold(text)
  const refusal = (matchedName: string): PreferenceCheck => ({
    ok: false,
    reason:
      'names someone on this roster. Memory holds how you want me to work, not ' +
      'anything about a particular student. Say the working preference without the name.',
    matchedName,
  })

  for (const raw of rosterNames) {
    const name = fold(raw.trim())
    /* Two LETTERS cannot distinguish a person from an ordinary word, so the
       floor is three. Two Han characters are a whole given name and one is a
       whole surname, so that same floor silently switches this check off for
       Chinese, Japanese and Korean names — the population the unicode word
       boundary below exists for. Measured: a roster entry of 李 小明 splits into
       a one-character surname and a two-character given name, both fell under
       the floor, and "李 小明 asked for the reading list in advance" was stored.

       A character in one of those scripts carries about what a whole Latin word
       does, so it gets a floor of one. */
    const dense = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name)
    if (name.length < (dense ? 1 : 3)) continue

    const safe = escapeForRegex(name)

    /* A whole-word match, plus a short extension so a roster "Alex" still
       catches "alexander".

       The extension is bounded on purpose. An unbounded prefix match blocked
       every sentence containing "announcement" for a roster with an "Ann" in it,
       and "announcement_style" is one of the five slots. Measured, a four-student
       roster was refusing roughly a quarter of ordinary preferences, and short
       surnames were hit hardest, which is a fairness problem as well as a
       usability one. Requiring at least four characters and allowing at most
       five more keeps "alex" to "alexander" while leaving "ann", "sam", "lin"
       and "eve" as whole words only. */
    /* A unicode-aware boundary, NOT \b.
       \b is defined against \w, which is [A-Za-z0-9_] and is never widened by
       any flag. A name written in a non-Latin script contains no character it
       can assert against, so the match can never fire. Measured: roster names in
       Chinese, Arabic, Japanese, Korean, Hebrew, Thai, Cyrillic, Devanagari and
       Greek were ALL stored while Latin ones refused. The one control this
       feature calls decidable was doing nothing for a whole population of
       students, and saying nothing about it. */
    /* Scripts without spaces get a plain substring test, not a word boundary.
       Korean and Chinese write a full name with no separator, so a roster of
       ["김", "민준"] against the text "김민준" never matches on a boundary: the
       surname is immediately followed by another letter. Word boundaries are a
       property of scripts that delimit words with spaces, and applying them here
       switched the check off for the same students the floor above did. A lone
       Han or Hangul character inside an English preference is not a real risk,
       and refusing one is the direction this control is supposed to fail in. */
    if (dense) {
      if (lower.includes(name)) return refusal(raw)
      continue
    }

    const whole = new RegExp(`(?<![\\p{L}\\p{N}])${safe}(?![\\p{L}\\p{N}])`, 'iu')
    if (whole.test(lower)) return refusal(raw)

    if (name.length >= 4) {
      const extended = new RegExp(`(?<![\\p{L}\\p{N}])${safe}\\p{L}{1,5}(?![\\p{L}\\p{N}])`, 'iu')
      if (extended.test(lower)) return refusal(raw)
    }
  }

  /* No fallback heuristic here, deliberately, and this is the fifth version of
     this decision.

     Every previous attempt tried to answer "does this text name a person?" from
     the text alone: a list of verbs after a name, then a capitalisation rule,
     then a list of sentence shapes. Each was better than the last on the strings
     the previous review had pinned, and no better on the question, because the
     pinned strings quietly became the specification. The last one stored 26 of
     40 realistic name-bearing preferences while refusing 11 of 40 ordinary ones.

     The roster answers a decidable question instead, and measures 0% false
     positives. So the caller's job is to bring a roster that covers everywhere
     the row can be read, and there is nothing to fall back TO. */

  const full = findRosterFullName(text, otherSectionFullNames)
  if (full !== null) return refusal(full)

  return { ok: true }
}

const MARK_OR_FORMAT = /[\p{M}\p{Cf}]/u
const APOSTROPHES = /[\u{2018}\u{2019}\u{02BC}\u{0060}\u{00B4}\u{FF07}]/gu
const DASHES = /[\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]/gu

/** One character folded the way roster names compare: compatibility forms (ligatures, full
 * width) expanded, accents and format characters removed, curly apostrophes and Unicode
 * dashes made plain, lowercased. May be empty or several characters. */
function foldChar(ch: string): string {
  return ch.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').replace(APOSTROPHES, "'").replace(DASHES, '-').toLowerCase()
}

/** How roster names compare: every character folded. */
function foldName(v: string): string {
  let out = ''
  for (const ch of v.normalize('NFD')) out += foldChar(ch)
  return out
}

/** foldName, keeping for each folded character the index (in the NFD form) it came from. */
function foldWithMap(v: string): { nfd: string; folded: string; map: number[] } {
  const nfd = v.normalize('NFD')
  let folded = ''
  const map: number[] = []
  for (let i = 0; i < nfd.length; ) {
    const ch = String.fromCodePoint(nfd.codePointAt(i)!)
    for (const c of foldChar(ch)) {
      folded += c
      map.push(i)
    }
    i += ch.length
  }
  return { nfd, folded, map }
}

/** The patterns one roster name is matched by: "First Last" and "Last, First". */
function namePatterns(full: string): string[] {
  const parts = foldName(full).split(/\s+/).filter((v) => v.length > 1).map(escapeForRegex)
  if (parts.length < 2) return []
  const last = parts[parts.length - 1]
  // \s* between the parts: a name whose space was lost (a zero-width character removed, or
  // text run together in an extracted PDF) still matches as a whole.
  return [parts.join('\\s*'), `${last}\\s*,\\s*${parts.slice(0, -1).join('\\s*')}`]
}

const WHOLE = (pattern: string) => `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`

/** Each roster name's two patterns, compiled once per roster array (rosters are loaded once and
 * reused for every excerpt, label and check). */
const compiledRosters = new WeakMap<readonly string[], { full: string; patterns: RegExp[] }[]>()
function compiledRoster(fullNames: readonly string[]): { full: string; patterns: RegExp[] }[] {
  let compiled = compiledRosters.get(fullNames)
  if (!compiled) {
    compiled = fullNames.map((full) => ({ full, patterns: namePatterns(full).map((p) => new RegExp(WHOLE(p), 'giu')) }))
    compiledRosters.set(fullNames, compiled)
  }
  return compiled
}

/**
 * The first roster full name that appears in the text as a whole, as "First Last" or
 * "Last, First", or null. Matched on both parts together, never on either alone, which
 * keeps ordinary words that happen to be someone's first name ("Grace", "Page") out of
 * it. Used for memory preferences across a professor's other sections, and by the Studio
 * builder to keep student names out of generated tools and out of course excerpts.
 */
export function findRosterFullName(text: string, fullNames: readonly string[]): string | null {
  const lower = foldName(text)
  for (const { full, patterns } of compiledRoster(fullNames)) {
    for (const re of patterns) {
      re.lastIndex = 0
      if (re.test(lower)) return full
    }
  }
  return null
}

/**
 * The text with every roster full name ("First Last" or "Last, First") replaced, matched
 * the way findRosterFullName matches (accents and case folded), and replaced in the
 * original text so everything else keeps its accents and case.
 */
export function redactRosterNames(text: string, fullNames: readonly string[], replacement = '[student]'): string {
  if (fullNames.length === 0 || text.length === 0) return text
  const { nfd, folded, map } = foldWithMap(text)
  const ranges: [number, number][] = []
  for (const { patterns } of compiledRoster(fullNames)) {
    for (const re of patterns) {
      for (const m of folded.matchAll(re)) {
        const start = map[m.index]
        const lastStart = map[m.index + m[0].length - 1]
        let end = lastStart + String.fromCodePoint(nfd.codePointAt(lastStart)!).length
        // Combining marks and format characters folded away belong to the last letter of the name.
        while (end < nfd.length && MARK_OR_FORMAT.test(nfd[end])) end++
        ranges.push([start, end])
      }
    }
  }
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let out = ''
  let at = 0
  for (const [start, end] of ranges) {
    if (start < at) {
      at = Math.max(at, end)
      continue
    }
    out += nfd.slice(at, start) + replacement
    at = end
  }
  return (out + nfd.slice(at)).normalize('NFC')
}

export interface PreferenceCheck {
  ok: boolean
  /** The word that caused a roster refusal.
   *
   *  Shown to the professor so they can rephrase, and NEVER logged: it is a
   *  student's name, which is the one thing this whole check exists to keep out
   *  of our records. Without it, a refusal is unactionable — the professor is
   *  told the line looks like it names a student and cannot tell which word did
   *  it, and neither can the model retrying on their behalf. That matters
   *  because a roster of ordinary names refuses a few percent of perfectly good
   *  preferences: a student surnamed Four made "four options" unstorable. */
  matchedName?: string
  /** Why it was refused — logged WITHOUT the offending text, and shown to the model. */
  reason?: string
}

/**
 * Decide whether one preference line may be stored. Returns a reason rather
 * than throwing, so the caller can tell the model why and let it try again with
 * just the accommodation.
 */
export function assertStorablePreference(text: string): PreferenceCheck {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  if (trimmed.length > PREFERENCE_MAX_CHARS) {
    return { ok: false, reason: `longer than ${PREFERENCE_MAX_CHARS} characters` }
  }
  for (const { category, pattern } of REFUSED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: `looks like it carries ${category}; store only the accommodation, not the reason`,
      }
    }
  }

  return { ok: true }
}
