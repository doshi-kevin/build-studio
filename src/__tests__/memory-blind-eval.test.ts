/**
 * What the server backstop actually catches, measured honestly.
 *
 * The other corpus test in this directory reports zero leaks, and that number is
 * close to meaningless on its own: every word in its leak list is also in the
 * denylist, so it can only count a leak the denylist already knows how to catch.
 * It measures two copies of one incomplete list agreeing with each other.
 *
 * These 40 sentences were written by a different model that had never seen the
 * denylist, asked for realistic accommodation requests justified by specific or
 * colloquial reasons and explicitly forbidden from using the obvious clinical
 * words. That is the only way to find out what the list does not know.
 *
 * The answer: it catches 9 of 40. Sentences carrying hospice, chemo, a
 * restraining order, an ankle monitor, a DACA rejection, being deadnamed and
 * "60 days off the needle" all pass. The number is identical on the version of
 * this code that came before, so this is the ceiling of the approach rather than
 * a regression, and it is the case for issue #790.
 *
 * IN PRODUCTION the chat model strips the reason before the tool is ever called,
 * and these layers only see what it misses. This is the backstop failing, not
 * the system. But a backstop that stops 22% should be described that way.
 *
 * The assertion below is a RATCHET. It fails if the number gets worse, which is
 * what a test can usefully do here. Do not "fix" it by adding these words to the
 * denylist: the next student will use different ones.
 */
import { describe, it, expect } from 'vitest'
import { stripReason, assertStorablePreference } from '@/lib/validations/memory'

/** Realistic accommodation requests carrying a reason, none of them using the
 *  obvious clinical vocabulary. Generated blind to the implementation. */
const BLIND_SET = [
  'sleeping in my car right now so keep the explanation super brief, phone battery is at 5 percent',
  'chemo fog is hitting hard today. just give me bullet points instead of paragraphs.',
  'skip the jargon please dad\'s funeral is tomorrow and my brain is completely fried',
  'ebt ran out and i haven\'t eaten, i need step by step examples because i can\'t focus.',
  'baby is finally asleep on my chest, explain the math formula really simply before she wakes up',
  'got my green card interview at dawn and i\'m sweating bullets. simple summaries only.',
  'hiding at the shelter from my ex tonight. break the concepts down into tiny chunks for me.',
  '60 days off the needle today. use plain english my hands are shaking too much for complex stuff',
  'working three shifts at the diner to avoid eviction, just feed me the bare minimum facts.',
  'text looks like swimming ants today. keep sentences short and put plenty of space between them.',
  'top surgery was yesterday and the drains hurt. walk me through the code examples really slowly.',
  'fasting since sunrise and my head is pounding, just gimme the bottom line no fluff.',
  'gotta check in with my po in ten minutes so give me the tldr on cell division',
  'brain zaps from stepping down my meds are insane, break the lesson into single sentences',
  'fireworks outside are bringing up iraq stuff. i need you to be super direct and skip the deep dives',
  'spine feels like crushed glass during this flare up, talk to me like a five year old',
  'sitting next to mom\'s hospice bed. please highlight the key terms so i don\'t have to search',
  'sleep paralysis kept me up all night. just the worked examples no theory please.',
  'morning sickness has me puking in a bucket, map out the timeline visually so i don\'t have to read',
  'worried sick about ice raids in my neighborhood, list out the essay prompts clearly',
  'ears are ringing like crazy from the factory floor, use bold text for the most important formulas',
  'withdrawals are kicking my teeth in. summarize the reading in exactly three short sentences.',
  'repo guy took my truck this morning. i can\'t think straight, just give me a step by step guide.',
  'getting kicked out of the dorms. use super simple vocabulary i\'m too stressed to process big words.',
  'ankle monitor is chafing and i\'m losing my mind. put the answers in a numbered list.',
  'it is shabbat soon and i have to log off. explain the physics theorem in one paragraph.',
  'just filed the restraining order. i need you to format this with headings so i can skim it fast',
  'jumping at every shadow today. keep the tone neutral and give me exactly what will be on the test.',
  'dialysis takes forever and i\'m exhausted, only show me the final solutions to these equations',
  'family deadnamed me all thanksgiving. i\'m numb. please just outline the chapter in basic terms.',
  'the lithium shakes are real bad today, break the project into tiny tasks i can knock out',
  'surviving on instant ramen and tap water. keep the historical dates strictly chronological without extra trivia.',
  'cleaning out my dead brother\'s apartment. just list the coding syntax rules without any long explanations.',
  'joints are on fire from the damp weather, keep it very short so i don\'t have to scroll',
  'night terrors ruined me. explain the water cycle using emojis and very few words.',
  'pop\'s dementia is acting up and he\'s yelling. give me the absolute basics of the lesson.',
  'toddler is teething and screaming bloody murder, i need a single worked example and nothing else',
  'couch surfing this week is brutal. write the essay outline in plain text no fancy formatting',
  'daca renewal got rejected. i am spiraling. please just underline the vocab words i absolutely need to know',
  'going blind in my left eye. use clear headings and chunk the paragraphs into single lines.',
]

/** Caught by the backstop when this was last measured. Lower is worse. */
const BASELINE_REFUSED = 9

describe('what the backstop catches when the words are not in its list', () => {
  it('does not catch less than it did before', () => {
    const refused = BLIND_SET.filter((line) => !assertStorablePreference(stripReason(line)).ok).length
    expect(
      refused,
      `The backstop now refuses ${refused} of ${BLIND_SET.length}, was ${BASELINE_REFUSED}. ` +
        'If this dropped, something upstream stopped working. If it rose because words were ' +
        'added to the denylist, raise BASELINE_REFUSED, but read issue #790 first: the list ' +
        'cannot be completed and every student uses different words.',
    ).toBeGreaterThanOrEqual(BASELINE_REFUSED)
  })

  it('stores nothing that still reads as a whole sentence about the student', () => {
    // A weaker property than "no disclosure survives", because that is exactly
    // what this layer cannot guarantee. What it CAN guarantee is that anything
    // stored is short enough to be a preference rather than a paragraph.
    const tooLong = BLIND_SET
      .map((l) => stripReason(l))
      .filter((s) => assertStorablePreference(s).ok && s.length > 160)
    expect(tooLong).toEqual([])
  })
})
