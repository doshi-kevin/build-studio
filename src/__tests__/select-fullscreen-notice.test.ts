// Unit tests for the fullscreen-notice selector and the snapshot mapping.
// Guards three rules in the selector:
//   1. Q&A questions never surface (only polls and quizzes need a response)
//   2. Dismissed ids are skipped
//   3. The most-recently opened candidate wins on tie-breaking
// And four rules in the mapping (computePendingFullscreenInteractions):
//   1. Only status==='open' interactions are projected
//   2. Already-responded ids are filtered out
//   3. Poll titles come from payload.question; quiz titles from payload.title
//   4. Missing payload fields fall back to a kind-appropriate label

import { describe, it, expect } from 'vitest'
import {
  selectFullscreenNotice,
  computePendingFullscreenInteractions,
  type FullscreenNoticeCandidate,
  type PendingInteractionSource,
} from '@/lib/live-classroom/select-fullscreen-notice'

function c(overrides: Partial<FullscreenNoticeCandidate> = {}): FullscreenNoticeCandidate {
  return {
    id: overrides.id ?? `i-${Math.random().toString(36).slice(2, 8)}`,
    kind: overrides.kind ?? 'poll',
    title: overrides.title ?? 'Untitled',
    opened_at: overrides.opened_at ?? null,
  }
}

describe('selectFullscreenNotice', () => {
  it('returns null when no candidates exist', () => {
    expect(selectFullscreenNotice([], new Set())).toBeNull()
  })

  it('returns null when only Q&A questions are pending', () => {
    const candidates = [c({ kind: 'question' }), c({ kind: 'question' })]
    expect(selectFullscreenNotice(candidates, new Set())).toBeNull()
  })

  it('filters Q&A out and keeps polls/quizzes', () => {
    const poll = c({ id: 'p1', kind: 'poll', opened_at: '2026-04-28T10:00:00Z' })
    const result = selectFullscreenNotice(
      [c({ id: 'q1', kind: 'question' }), poll],
      new Set(),
    )
    expect(result?.id).toBe('p1')
  })

  it('skips ids that are already dismissed', () => {
    const dismissed = c({ id: 'p1', kind: 'poll', opened_at: '2026-04-28T11:00:00Z' })
    const fresh = c({ id: 'p2', kind: 'poll', opened_at: '2026-04-28T10:00:00Z' })
    const result = selectFullscreenNotice([dismissed, fresh], new Set(['p1']))
    expect(result?.id).toBe('p2')
  })

  it('returns null when every candidate is dismissed', () => {
    const candidates = [
      c({ id: 'p1', kind: 'poll' }),
      c({ id: 'q1', kind: 'quiz' }),
    ]
    const result = selectFullscreenNotice(candidates, new Set(['p1', 'q1']))
    expect(result).toBeNull()
  })

  it('picks the most recently opened poll/quiz', () => {
    const older = c({ id: 'p1', kind: 'poll', opened_at: '2026-04-28T10:00:00Z' })
    const newer = c({ id: 'q1', kind: 'quiz', opened_at: '2026-04-28T11:00:00Z' })
    const result = selectFullscreenNotice([older, newer], new Set())
    expect(result?.id).toBe('q1')
  })

  it('treats null opened_at as oldest (epoch 0)', () => {
    const withTimestamp = c({ id: 'p1', kind: 'poll', opened_at: '2026-04-28T10:00:00Z' })
    const noTimestamp = c({ id: 'p2', kind: 'poll', opened_at: null })
    const result = selectFullscreenNotice([noTimestamp, withTimestamp], new Set())
    expect(result?.id).toBe('p1')
  })

  it('does not mutate the input array', () => {
    const candidates = [
      c({ id: 'a', kind: 'poll', opened_at: '2026-04-28T10:00:00Z' }),
      c({ id: 'b', kind: 'poll', opened_at: '2026-04-28T11:00:00Z' }),
    ]
    const before = candidates.map((x) => x.id).join(',')
    selectFullscreenNotice(candidates, new Set())
    const after = candidates.map((x) => x.id).join(',')
    expect(after).toBe(before)
  })
})

function s(overrides: Partial<PendingInteractionSource> = {}): PendingInteractionSource {
  return {
    id: overrides.id ?? `s-${Math.random().toString(36).slice(2, 8)}`,
    kind: overrides.kind ?? 'poll',
    status: overrides.status ?? 'open',
    payload: overrides.payload ?? {},
    opened_at: overrides.opened_at ?? null,
  }
}

describe('computePendingFullscreenInteractions', () => {
  it('drops interactions whose status is not open', () => {
    const result = computePendingFullscreenInteractions(
      [
        s({ id: 'd', status: 'draft' }),
        s({ id: 'c', status: 'closed' }),
        s({ id: 'o', status: 'open' }),
      ],
      new Set(),
    )
    expect(result.map((r) => r.id)).toEqual(['o'])
  })

  it('drops interactions the student has already responded to', () => {
    const result = computePendingFullscreenInteractions(
      [s({ id: 'a' }), s({ id: 'b' })],
      new Set(['a']),
    )
    expect(result.map((r) => r.id)).toEqual(['b'])
  })

  it('uses payload.question as the title for polls', () => {
    const result = computePendingFullscreenInteractions(
      [s({ id: 'p', kind: 'poll', payload: { question: 'Pick a color' } })],
      new Set(),
    )
    expect(result[0]?.title).toBe('Pick a color')
  })

  it('uses payload.title as the title for quizzes', () => {
    const result = computePendingFullscreenInteractions(
      [s({ id: 'q', kind: 'quiz', payload: { title: 'Midterm Check', question: 'IGNORED' } })],
      new Set(),
    )
    expect(result[0]?.title).toBe('Midterm Check')
  })

  it('falls back to "Poll" when a poll payload is missing question', () => {
    const result = computePendingFullscreenInteractions(
      [s({ id: 'p', kind: 'poll', payload: {} })],
      new Set(),
    )
    expect(result[0]?.title).toBe('Poll')
  })

  it('falls back to "Quiz" when a quiz payload is missing title', () => {
    const result = computePendingFullscreenInteractions(
      [s({ id: 'q', kind: 'quiz', payload: {} })],
      new Set(),
    )
    expect(result[0]?.title).toBe('Quiz')
  })

  it('preserves opened_at and kind on each candidate', () => {
    const result = computePendingFullscreenInteractions(
      [
        s({
          id: 'p1',
          kind: 'poll',
          opened_at: '2026-04-28T10:00:00Z',
          payload: { question: 'A?' },
        }),
        s({
          id: 'q1',
          kind: 'quiz',
          opened_at: '2026-04-28T11:00:00Z',
          payload: { title: 'Q1' },
        }),
      ],
      new Set(),
    )
    expect(result).toEqual([
      { id: 'p1', kind: 'poll', title: 'A?', opened_at: '2026-04-28T10:00:00Z' },
      { id: 'q1', kind: 'quiz', title: 'Q1', opened_at: '2026-04-28T11:00:00Z' },
    ])
  })

  it('produces output the selector can consume end-to-end', () => {
    // Wiring guard: the mapping output is the exact shape selectFullscreenNotice
    // expects. If either side drifts, this test catches it before runtime does.
    const sources: PendingInteractionSource[] = [
      s({ id: 'old', kind: 'poll', opened_at: '2026-04-28T09:00:00Z', payload: { question: 'A' } }),
      s({ id: 'new', kind: 'quiz', opened_at: '2026-04-28T11:00:00Z', payload: { title: 'B' } }),
      s({ id: 'qa', kind: 'question', status: 'open', payload: { title: 'ignored' } }),
    ]
    const candidates = computePendingFullscreenInteractions(sources, new Set())
    const picked = selectFullscreenNotice(candidates, new Set())
    expect(picked?.id).toBe('new')
    expect(picked?.title).toBe('B')
  })
})
