import { describe, it, expect } from 'vitest'
import { applyDocumentOps } from '@/components/professor/assignments/studio/athena-document-adapter'
import { youtubeVideoId } from '@/components/professor/assignments/studio/athena-document-blocks'

/**
 * The silent-discard bug, pinned.
 *
 * Runtime QA watched a Frontier build turn announce "The 'Skip Scan' Challenge is ready on
 * your screen" over a document that was never touched. The model had emitted
 * `{op:'setDocument', text:'<h1>…'}` — `text` instead of `html`. That is accepted by Zod
 * because the op schema is deliberately a FLAT object with an `op` enum (Gemini mishandles
 * discriminated unions), so `text` is a legal sibling field belonging to `insertBlock`.
 *
 * The adapter then did `if (!op.html) break` — an UNCOUNTED no-op. Because the same call also
 * renamed the assignment, `changed` was 1, the host reported `applied: true`, and the summary
 * mentioned only the rename. The professor's authored body was gone with no chip, no error and
 * no console output.
 *
 * These tests assert the two properties that make that impossible: a content op with no
 * content is COUNTED, and it is NAMED in the summary.
 *
 * The editor is a throwing stub on purpose — for these ops the adapter must never reach it, so
 * "didn't throw" is itself part of the assertion.
 */
const untouchableEditor = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`adapter touched the editor (.${String(prop)}) for a content-less op`)
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) as any

describe('applyDocumentOps — a content op with no content is counted, not swallowed', () => {
  it('counts setDocument carrying `text` instead of `html` as skipped, and applies nothing', () => {
    const res = applyDocumentOps(untouchableEditor, [
      // exactly what the model emitted in the QA run
      { op: 'setDocument', text: '<h1>The Skip Scan Challenge</h1>' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any)

    expect(res.skipped).toBe(1)
    expect(res.changed).toBe(0)
    expect(res.summary).toMatch(/skipped 1 change with no content/i)
  })

  it('still reports the skip when another op in the same call DID succeed', () => {
    // The exact shape that made this invisible: the rename counted, so the call looked fine.
    const res = applyDocumentOps(untouchableEditor, [
      { op: 'setMeta', title: 'Assignment: The Skip Scan Challenge' },
      { op: 'setDocument', text: '<h1>body that never landed</h1>' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any)

    expect(res.title).toBe('Assignment: The Skip Scan Challenge')
    expect(res.changed).toBe(1) // the rename
    expect(res.skipped).toBe(1) // the body
    // Both halves must be visible, or the summary lies by omission.
    expect(res.summary).toMatch(/renamed the assignment/i)
    expect(res.summary).toMatch(/skipped 1 change/i)
  })

  it('counts appendSection and replaceSection the same way', () => {
    const res = applyDocumentOps(untouchableEditor, [
      { op: 'appendSection', text: 'no html here' },
      { op: 'replaceSection', headingId: 's0' }, // headingId present, html missing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any)

    expect(res.skipped).toBe(2)
    expect(res.changed).toBe(0)
  })
})

/**
 * Unusable BLOCK links, pinned.
 *
 * A live probe of the real API caught Athena grounding a video's EXISTENCE and then inventing its
 * id: search returned one grounding chunk for `toptechboy.com` (Paul McWhorter's site), which
 * confirmed "LESSON 24: Understanding GPS NMEA Sentences" is real but carried no YouTube URL — so
 * the model emitted `watch?v=pD4UqjS3W2A`, which oEmbed 404s. Two of the three URLs in that same
 * reply WERE real, which is what makes it dangerous: most links work, so nobody audits them.
 *
 * `buildBlockNode` used to accept any non-empty string as a youtube src — strictly laxer than the
 * renderer, whose regex requires a YouTube host + an 11-char id. So a garbage "link" produced a
 * block the editor could only draw as "Video unavailable", and `insertBlock` broke out WITHOUT
 * touching either counter, so it was reported as a successful insert.
 *
 * These assert the two halves of the fix: the builder rejects what the renderer can't embed, and
 * the rejection is COUNTED and NAMED rather than swallowed.
 *
 * Note the deliberate limit, asserted below: a well-formed but fabricated id still passes. Proving
 * a video exists needs a network call, so that is the renderer's job — not this pure module's.
 */
describe('applyDocumentOps — a block with an unusable link is counted, not swallowed', () => {
  it('rejects a youtube block whose link is not a YouTube link, and says so', () => {
    const res = applyDocumentOps(untouchableEditor, [
      { op: 'insertBlock', blockType: 'youtube', text: 'a video about NMEA sentences' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any)

    expect(res.changed).toBe(0)
    expect(res.skipped).toBe(1)
    // "no content" would be a lie here — the professor needs to know a LINK was the problem.
    expect(res.summary).toMatch(/unusable link/i)
    expect(res.summary).not.toMatch(/no content/i)
  })

  it('rejects an image block with a relative or placeholder src', () => {
    const res = applyDocumentOps(untouchableEditor, [
      { op: 'insertBlock', blockType: 'image', config: '{"src":"/images/gps.png"}' },
      { op: 'insertBlock', blockType: 'image', config: '{"src":"[PLACEHOLDER]"}' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any)

    expect(res.changed).toBe(0)
    expect(res.skipped).toBe(2)
  })

  it('does NOT hide the rejection behind another op that succeeded', () => {
    // The shape that made the original bug invisible: something else counted, so the call
    // looked like a success and the omission never surfaced.
    const res = applyDocumentOps(untouchableEditor, [
      { op: 'setMeta', title: 'The GPS Translator' },
      { op: 'insertBlock', blockType: 'youtube', text: 'not-a-url' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any)

    expect(res.changed).toBe(1) // the rename
    expect(res.skipped).toBe(1) // the video
    expect(res.summary).toMatch(/renamed the assignment/i)
    expect(res.summary).toMatch(/unusable link/i)
  })
})

describe('youtubeVideoId — one rule shared by the builder and the renderer', () => {
  it.each([
    ['https://www.youtube.com/watch?v=aLeCaa7TUZA', 'aLeCaa7TUZA'],
    ['https://youtu.be/aLeCaa7TUZA', 'aLeCaa7TUZA'],
    ['https://www.youtube.com/shorts/aLeCaa7TUZA', 'aLeCaa7TUZA'],
    ['https://www.youtube.com/embed/aLeCaa7TUZA', 'aLeCaa7TUZA'],
  ])('accepts %s', (url, id) => {
    expect(youtubeVideoId(url)).toBe(id)
  })

  it.each([
    'a video about NMEA sentences',
    '[PLACEHOLDER]',
    'https://vimeo.com/123456789',
    'https://www.youtube.com/watch?v=tooshort',
    '',
  ])('rejects %s', (bad) => {
    expect(youtubeVideoId(bad)).toBeNull()
  })

  it('accepts a real share URL with params BEFORE the id', () => {
    // The consultant caught this: YouTube share links routinely carry `si`, `app`, `list`, `t`
    // before `v`. The first cut pattern-matched a literal `watch?v=` and so rejected the most
    // common link a professor would paste — the builder would have DROPPED their real video.
    // Parsed with the URL API now, so param order is irrelevant.
    expect(youtubeVideoId('https://www.youtube.com/watch?si=xYz&v=aLeCaa7TUZA')).toBe('aLeCaa7TUZA')
    expect(youtubeVideoId('https://www.youtube.com/watch?app=desktop&v=aLeCaa7TUZA&t=42s')).toBe(
      'aLeCaa7TUZA',
    )
    expect(youtubeVideoId('https://youtu.be/aLeCaa7TUZA?t=42')).toBe('aLeCaa7TUZA')
    // The renderer emits nocookie embeds, so a pasted one must round-trip.
    expect(youtubeVideoId('https://www.youtube-nocookie.com/embed/aLeCaa7TUZA')).toBe('aLeCaa7TUZA')
  })

  it('rejects a lookalike host — endsWith("youtube.com") is not a host check', () => {
    // `evilyoutube.com`.endsWith('youtube.com') is TRUE, which is why the host test is anchored
    // on an exact match or a leading dot.
    expect(youtubeVideoId('https://evilyoutube.com/watch?v=aLeCaa7TUZA')).toBeNull()
    expect(youtubeVideoId('https://youtube.com.attacker.net/watch?v=aLeCaa7TUZA')).toBeNull()
    // Protocol matters too — no javascript:/data: sneaking into an href.
    expect(youtubeVideoId('javascript:alert(1)//youtube.com/watch?v=aLeCaa7TUZA')).toBeNull()
  })

  it('rejects an id that is the right shape but the wrong length', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=aLeCaa7TUZAextra')).toBeNull()
  })

  it('CANNOT tell a fabricated id from a real one — that limit is deliberate', () => {
    // The exact fabricated URL from the live probe. It is well-formed, so it passes here;
    // proving a video EXISTS needs a network call and belongs in the renderer, not in this
    // pure module. This test exists so nobody later reads the guard as an existence check.
    expect(youtubeVideoId('https://www.youtube.com/watch?v=pD4UqjS3W2A')).toBe('pD4UqjS3W2A')
  })
})
