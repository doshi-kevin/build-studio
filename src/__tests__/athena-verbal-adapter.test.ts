import { describe, it, expect } from 'vitest'
import { applyVerbalOps, serializeVerbalForAthena } from '@/lib/assignments/verbal/athena-verbal-adapter'
import { defaultVerbalAssessment, type VerbalAssessmentConfig } from '@/lib/assignments/verbal/config'

function emptyConfig(): VerbalAssessmentConfig {
  return { version: 2, topic: '', voiceId: 'v', maxFollowUpDepth: 2, timeLimitMinutes: 10, cells: [] }
}

describe('applyVerbalOps', () => {
  it('inserts an mcq, translating options[] + correctOptionIndex to {id,text}[] + correctOptionId', () => {
    const { config } = applyVerbalOps(emptyConfig(), [
      { op: 'insert', cellType: 'mcq', prompt: 'Pick one', options: ['A', 'B', 'C'], correctOptionIndex: 2 },
    ])
    expect(config.cells).toHaveLength(1)
    const mcq = config.cells[0]
    expect(mcq.type).toBe('mcq')
    expect(mcq.options?.map((o) => o.text)).toEqual(['A', 'B', 'C'])
    // correctOptionId points at the option at index 2 ("C") — never an out-of-range index.
    expect(mcq.correctOptionId).toBe(mcq.options?.[2].id)
  })

  it('sets the topic via setMeta and appends question cells in order', () => {
    const { config, summary } = applyVerbalOps(emptyConfig(), [
      { op: 'setMeta', topic: 'Recursion' },
      { op: 'insert', cellType: 'greeting', prompt: 'Hi' },
      { op: 'insert', cellType: 'question', prompt: 'Base case?', answerType: 'short' },
    ])
    expect(config.topic).toBe('Recursion')
    expect(config.cells.map((c) => c.type)).toEqual(['greeting', 'question'])
    expect(config.cells[1].answerType).toBe('short')
    expect(summary).toContain('set the topic')
  })

  it('updates a cell by id, removes by id, and reorders after another id', () => {
    const base = defaultVerbalAssessment() // greeting, question, ai_followup
    const [greeting, question, followup] = base.cells
    const updated = applyVerbalOps(base, [{ op: 'update', id: question.id, prompt: 'Reworded?' }])
    expect(updated.config.cells.find((c) => c.id === question.id)?.prompt).toBe('Reworded?')

    const removed = applyVerbalOps(base, [{ op: 'remove', id: greeting.id }])
    expect(removed.config.cells.find((c) => c.id === greeting.id)).toBeUndefined()

    // move the followup to just after the greeting (front)
    const reordered = applyVerbalOps(base, [{ op: 'reorder', id: followup.id, afterId: greeting.id }])
    expect(reordered.config.cells.map((c) => c.id)).toEqual([greeting.id, followup.id, question.id])
  })

  it('is pure — the original config is not mutated', () => {
    const base = emptyConfig()
    applyVerbalOps(base, [{ op: 'insert', cellType: 'greeting', prompt: 'Hi' }])
    expect(base.cells).toHaveLength(0)
  })

  it('reports changed=0 (no false success) for ops that match nothing or lack a cellType', () => {
    const base = defaultVerbalAssessment()
    const { config, changed } = applyVerbalOps(base, [
      { op: 'update', id: 'not-a-real-id', prompt: 'x' },
      { op: 'remove', id: 'also-missing' },
      { op: 'insert', prompt: 'orphan with no cellType' },
    ])
    expect(changed).toBe(0)
    expect(config.cells).toHaveLength(base.cells.length) // untouched
  })
})

describe('serializeVerbalForAthena', () => {
  it('renders mcq options with a ✓ on the correct one and exposes the topic as meta', () => {
    const { config } = applyVerbalOps(emptyConfig(), [
      { op: 'setMeta', topic: 'Trees' },
      { op: 'insert', cellType: 'mcq', prompt: 'Which?', options: ['X', 'Y'], correctOptionIndex: 1 },
    ])
    const state = serializeVerbalForAthena(config)
    expect(state.kind).toBe('verbal')
    expect(state.meta?.topic).toBe('Trees')
    const mcqContent = state.components?.[0].content ?? ''
    expect(mcqContent).toContain('Which?')
    expect(mcqContent).toContain('Y')
    expect(mcqContent).toContain('✓')
  })
})
