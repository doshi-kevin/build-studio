// Pure validation for lecture-summary output. Lives here rather than in
// llm-client.ts on purpose: that module has no `server-only` guard, so every pure
// export added to it is one more reason for someone to import it from a client
// component — which would pull the whole AI client and its provider config into the
// browser bundle with nothing failing the build.

/**
 * True when a lecture-summary reply is the model asking for content rather than
 * summarizing it (#646). With thin material the model answers with a request for the
 * slides, and that reply used to be stored and rendered to students AS their lecture
 * recap — one stored summary was a 222-character "Please provide the text from the
 * slides…". Only emptiness was checked, and a refusal is not empty.
 *
 * Deliberately conservative, because the failure modes are not symmetric: a false
 * positive discards a REAL summary and leaves a student with nothing, which is worse
 * than the bug. Two guards — the phrase must OPEN the reply (60 chars, not enough for
 * ordinary prose to reach it), and the whole reply must be short. A refusal is a
 * sentence or two; a real recap of a lecture is not.
 */
export function looksLikeSummaryRefusal(text: string): boolean {
  const REFUSAL_MAX_CHARS = 400
  if (typeof text !== 'string' || text.length > REFUSAL_MAX_CHARS) return false
  /* 60 chars, not 160: an earlier draft used the wider window and matched a genuine
     summary reading "…the professor said he would please provide them later", which
     would have thrown away real content. */
  const opening = text.slice(0, 60).toLowerCase()
  return [
    'please provide',
    'please share',
    'i need the',
    'i was not provided',
    "i don't have any",
    'i do not have any',
    'no content was provided',
    'there is no content',
    'could you provide',
  ].some((phrase) => opening.includes(phrase))
}
