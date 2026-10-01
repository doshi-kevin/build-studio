// Tests for content-change notifications (published assignment/quiz due-date/instructions
// edits). The helper must: only fire when something notable changed, use the right event
// type per entity, ride the 'refresh' path (so a repeat edit re-notifies), and never be an
// actionable to-do (the publish notification already owns the to-do).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEmitEvent = vi.fn()
vi.mock('@/lib/events/emit', () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
let emitContentChange: any
let dueDatesDiffer: any
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(async () => {
  vi.resetModules()
  mockEmitEvent.mockReset().mockResolvedValue(undefined)
  const mod = await import('@/lib/events/content-change')
  emitContentChange = mod.emitContentChange
  dueDatesDiffer = mod.dueDatesDiffer
})

describe('dueDatesDiffer', () => {
  it('treats null/null as unchanged and null/value as changed', () => {
    expect(dueDatesDiffer(null, null)).toBe(false)
    expect(dueDatesDiffer(null, '2026-07-20T17:00:00Z')).toBe(true)
    expect(dueDatesDiffer('2026-07-20T17:00:00Z', null)).toBe(true)
  })
  it('compares by instant, not string — same time in different formats is unchanged', () => {
    expect(dueDatesDiffer('2026-07-20T17:00:00Z', '2026-07-20T17:00:00.000+00:00')).toBe(false)
  })
  it('detects a different instant', () => {
    expect(dueDatesDiffer('2026-07-20T17:00:00Z', '2026-07-21T17:00:00Z')).toBe(true)
  })
})

describe('emitContentChange', () => {
  const base = {
    sectionId: 's1',
    actorId: 'p1',
    entityId: 'a1',
    title: 'HW1',
    linkUrl: '/student/courses/s1/assignments/a1',
  }

  it('is a no-op when nothing notable changed', async () => {
    await emitContentChange({
      ...base,
      entityKind: 'assignment',
      oldDueAt: '2026-07-20T17:00:00Z',
      newDueAt: '2026-07-20T17:00:00Z',
      oldInstructions: 'same',
      newInstructions: 'same',
    })
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('emits assignment_updated via the refresh path, as a non-actionable notice, on a due-date change', async () => {
    await emitContentChange({
      ...base,
      entityKind: 'assignment',
      oldDueAt: '2026-07-20T17:00:00Z',
      newDueAt: '2026-07-22T17:00:00Z',
    })
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    const arg = mockEmitEvent.mock.calls[0][0]
    expect(arg.type).toBe('assignment_updated')
    expect(arg.onDuplicate).toBe('refresh') // a repeat edit re-notifies, not deduped
    expect(arg.actionable).toBe(false) // notice, not a new to-do
    expect(arg.entity).toEqual({ type: 'assignment', id: 'a1' })
    expect(arg.dueAt).toBe('2026-07-22T17:00:00Z')
    expect(String(arg.body).toLowerCase()).toContain('due date')
  })

  it('uses quiz_updated and names the settings when a quiz setting changed', async () => {
    await emitContentChange({
      ...base,
      entityKind: 'quiz',
      oldDueAt: null,
      newDueAt: null,
      settingsChanged: true,
    })
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    const arg = mockEmitEvent.mock.calls[0][0]
    expect(arg.type).toBe('quiz_updated')
    expect(String(arg.body).toLowerCase()).toContain('settings')
  })

  it('detects an instructions-only change', async () => {
    await emitContentChange({
      ...base,
      entityKind: 'assignment',
      oldDueAt: null,
      newDueAt: null,
      oldInstructions: 'old text',
      newInstructions: 'new text',
    })
    expect(mockEmitEvent).toHaveBeenCalledTimes(1)
    expect(String(mockEmitEvent.mock.calls[0][0].body).toLowerCase()).toContain('instructions')
  })

  /* #696 part 2. The verb used to be chosen by counting CHANGED PHRASES, not by grammatical
     number, so a lone change whose phrase is a plural noun read "The instructions was
     updated." Two of the three phrases are plural nouns, so counting was wrong more often
     than right. The old test only checked the body mentioned "instructions", which passed
     either way. */
  it('agrees the verb with the subject, not with how many things changed', async () => {
    await emitContentChange({
      ...base,
      entityKind: 'assignment',
      oldDueAt: null,
      newDueAt: null,
      oldInstructions: 'old text',
      newInstructions: 'new text',
    })
    expect(String(mockEmitEvent.mock.calls[0][0].body)).toContain('The instructions were updated')
  })

  it('keeps a singular subject singular', async () => {
    await emitContentChange({
      ...base,
      entityKind: 'assignment',
      oldDueAt: '2026-01-01T00:00:00Z',
      newDueAt: '2026-01-08T00:00:00Z',
    })
    expect(String(mockEmitEvent.mock.calls[0][0].body)).toContain('The due date was updated')
  })

  it('uses the plural for a joined subject', async () => {
    await emitContentChange({
      ...base,
      entityKind: 'assignment',
      oldDueAt: '2026-01-01T00:00:00Z',
      newDueAt: '2026-01-08T00:00:00Z',
      oldInstructions: 'old text',
      newInstructions: 'new text',
    })
    expect(String(mockEmitEvent.mock.calls[0][0].body)).toContain(
      'The due date and the instructions were updated',
    )
  })
})
