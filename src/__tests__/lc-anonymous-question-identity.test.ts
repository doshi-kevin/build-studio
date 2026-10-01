/**
 * #658 — an anonymous question's `created_by` is the asker's real user id, and it reached
 * every student unmodified. Non-anonymous questions carry BOTH the id and the name in the
 * SAME response, so a classmate could build a uuid→name map from those and attribute every
 * anonymous question whose created_by matched. `upvotedBy` leaked who upvoted what.
 *
 * askQuestion is deliberate about this — it stores `authorName: null` and its own comment
 * calls keeping the name "a privacy regression" — so the control was real and undone by the
 * id travelling beside it.
 *
 * The oracle is the SERIALISED interaction: the asker's id must not appear anywhere in what
 * ships. And the counter-oracle matters as much — the viewer's own upvote state has to
 * survive, or the fix trades a privacy leak for letting students upvote repeatedly.
 */

import { describe, it, expect } from 'vitest'
import { stripAnonymousAuthor } from '@/lib/live-classroom/snapshot-utils'
import type { SnapshotInteraction } from '@/lib/live-classroom/snapshot'

const ASKER = 'aaaaaaaa-0000-4000-8000-000000000001'
const VIEWER = 'bbbbbbbb-0000-4000-8000-000000000002'
const OTHER = 'cccccccc-0000-4000-8000-000000000003'

const question = (over: Record<string, unknown> = {}): SnapshotInteraction =>
  ({
    id: 'q-1',
    room_id: 'r-1',
    kind: 'question',
    status: 'open',
    created_by: ASKER,
    created_at: '2026-06-14T10:00:00Z',
    opened_at: null,
    closed_at: null,
    payload: { text: 'Why is it O(log n)?', anonymous: true, upvotes: 2, upvotedBy: [VIEWER, OTHER], ...over },
  }) as unknown as SnapshotInteraction

describe('#658 — an anonymous question must not carry its asker', () => {
  it('removes the asker id from the payload entirely', () => {
    const json = JSON.stringify(stripAnonymousAuthor(question(), VIEWER))
    expect(json).not.toContain(ASKER)
  })

  it('keeps the question text — only the identity goes', () => {
    const out = stripAnonymousAuthor(question(), VIEWER)
    expect((out.payload as { text: string }).text).toBe('Why is it O(log n)?')
    expect((out.payload as { upvotes: number }).upvotes).toBe(2)
  })

  it('drops authorName if one was ever stored on an anonymous question', () => {
    const out = stripAnonymousAuthor(question({ authorName: 'Sam Rivera' }), VIEWER)
    expect(JSON.stringify(out)).not.toContain('Sam Rivera')
  })

  it('does NOT anonymise a question the student chose to sign', () => {
    const out = stripAnonymousAuthor(question({ anonymous: false, authorName: 'Sam Rivera' }), VIEWER)
    expect(out.created_by).toBe(ASKER)
    expect((out.payload as { authorName: string }).authorName).toBe('Sam Rivera')
  })
})

describe('#658 — upvote state survives, other voters do not', () => {
  it("preserves the VIEWER's own upvote so the button stays disabled", () => {
    // QuestionList reads upvotedBy.includes(currentUserId). Deleting the field would let a
    // student upvote the same question repeatedly — a correctness bug traded for a privacy fix.
    const out = stripAnonymousAuthor(question(), VIEWER)
    expect((out.payload as { upvotedBy: string[] }).upvotedBy).toEqual([VIEWER])
  })

  it('hides everyone else who upvoted', () => {
    const json = JSON.stringify(stripAnonymousAuthor(question(), VIEWER))
    expect(json).not.toContain(OTHER)
  })

  it('reports an empty list for a viewer who has not upvoted', () => {
    const out = stripAnonymousAuthor(question({ upvotedBy: [OTHER] }), VIEWER)
    expect((out.payload as { upvotedBy: string[] }).upvotedBy).toEqual([])
  })

  it('hides other voters on NON-anonymous questions too', () => {
    // Who asked is public there; who upvoted never is.
    const out = stripAnonymousAuthor(question({ anonymous: false, upvotedBy: [VIEWER, OTHER] }), VIEWER)
    expect((out.payload as { upvotedBy: string[] }).upvotedBy).toEqual([VIEWER])
  })
})

describe('#658 — leaves other interaction kinds alone', () => {
  it('passes a poll through untouched', () => {
    const poll = { ...question(), kind: 'poll' } as unknown as SnapshotInteraction
    expect(stripAnonymousAuthor(poll, VIEWER)).toEqual(poll)
  })

  it('does not mutate its input', () => {
    const q = question()
    const before = JSON.stringify(q)
    stripAnonymousAuthor(q, VIEWER)
    expect(JSON.stringify(q)).toBe(before)
  })
})
