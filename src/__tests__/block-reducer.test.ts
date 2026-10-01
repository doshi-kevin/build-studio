// Tests for blockReducer — about page block editor state machine.
// Covers block CRUD, reordering, duplication, and collapse.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  blockReducer,
  type BlockState,
} from '@/components/professor/about/block-editor/use-block-reducer'
import type { AboutBlock } from '@/lib/validations/course-about'

// ── Helpers ──────────────────────────────────────────────────

function buildTextBlock(id: string, text = 'Hello'): AboutBlock {
  return {
    id,
    type: 'text',
    data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
  }
}

function buildDividerBlock(id: string): AboutBlock {
  return { id, type: 'divider', data: {} } as AboutBlock
}

function buildState(overrides: Partial<BlockState> = {}): BlockState {
  return {
    blocks: [
      buildTextBlock('b-1', 'First'),
      buildTextBlock('b-2', 'Second'),
      buildTextBlock('b-3', 'Third'),
    ],
    externalRev: 0,
    ...overrides,
  }
}

beforeEach(() => {
  // Mock crypto.randomUUID for DUPLICATE_BLOCK
  vi.stubGlobal('crypto', { randomUUID: () => 'mocked-uuid' })
})

// ── ADD_BLOCK ────────────────────────────────────────────────

describe('ADD_BLOCK', () => {
  it('inserts a block at the beginning (afterIndex=0)', () => {
    const state = buildState()
    const newBlock = buildDividerBlock('b-new')
    const result = blockReducer(state, {
      type: 'ADD_BLOCK',
      payload: { block: newBlock, afterIndex: 0 },
    })
    expect(result.blocks.length).toBe(4)
    expect(result.blocks[0].id).toBe('b-new')
  })

  it('inserts a block at the end', () => {
    const state = buildState()
    const newBlock = buildDividerBlock('b-end')
    const result = blockReducer(state, {
      type: 'ADD_BLOCK',
      payload: { block: newBlock, afterIndex: 3 },
    })
    expect(result.blocks[3].id).toBe('b-end')
  })

  it('inserts a block in the middle', () => {
    const state = buildState()
    const newBlock = buildDividerBlock('b-mid')
    const result = blockReducer(state, {
      type: 'ADD_BLOCK',
      payload: { block: newBlock, afterIndex: 1 },
    })
    expect(result.blocks[1].id).toBe('b-mid')
    expect(result.blocks[2].id).toBe('b-2')
  })
})

// ── REMOVE_BLOCK ─────────────────────────────────────────────

describe('REMOVE_BLOCK', () => {
  it('removes an existing block', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'REMOVE_BLOCK',
      payload: { blockId: 'b-2' },
    })
    expect(result.blocks.length).toBe(2)
    expect(result.blocks.map((b) => b.id)).toEqual(['b-1', 'b-3'])
  })

  it('does nothing when blockId is not found', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'REMOVE_BLOCK',
      payload: { blockId: 'nonexistent' },
    })
    expect(result.blocks.length).toBe(3)
  })
})

// ── MOVE_BLOCK ───────────────────────────────────────────────

describe('MOVE_BLOCK', () => {
  it('moves a block forward', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'MOVE_BLOCK',
      payload: { fromIndex: 0, toIndex: 2 },
    })
    expect(result.blocks.map((b) => b.id)).toEqual(['b-2', 'b-3', 'b-1'])
  })

  it('moves a block backward', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'MOVE_BLOCK',
      payload: { fromIndex: 2, toIndex: 0 },
    })
    expect(result.blocks.map((b) => b.id)).toEqual(['b-3', 'b-1', 'b-2'])
  })

  it('is a no-op when fromIndex equals toIndex', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'MOVE_BLOCK',
      payload: { fromIndex: 1, toIndex: 1 },
    })
    expect(result).toBe(state) // reference equality
  })
})

// ── UPDATE_BLOCK ─────────────────────────────────────────────

describe('UPDATE_BLOCK', () => {
  it('merges partial data into block', () => {
    const state = buildState({
      blocks: [
        {
          id: 'b-quote',
          type: 'quote',
          data: { text: 'original', attribution: 'author' },
        } as AboutBlock,
      ],
    })
    const result = blockReducer(state, {
      type: 'UPDATE_BLOCK',
      payload: { blockId: 'b-quote', data: { text: 'updated' } },
    })
    const updated = result.blocks[0] as AboutBlock & { data: { text: string; attribution: string } }
    expect(updated.data.text).toBe('updated')
    expect(updated.data.attribution).toBe('author') // preserved
  })

  it('does not modify other blocks', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'UPDATE_BLOCK',
      payload: { blockId: 'b-1', data: {} },
    })
    expect(result.blocks[1]).toEqual(state.blocks[1])
    expect(result.blocks[2]).toEqual(state.blocks[2])
  })
})

// ── DUPLICATE_BLOCK ──────────────────────────────────────────

describe('DUPLICATE_BLOCK', () => {
  it('deep clones a block and inserts after the original', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'DUPLICATE_BLOCK',
      payload: { blockId: 'b-2' },
    })
    expect(result.blocks.length).toBe(4)
    expect(result.blocks[1].id).toBe('b-2') // original
    expect(result.blocks[2].id).toBe('mocked-uuid') // clone
    expect(result.blocks[2].type).toBe('text')
  })

  it('creates an independent clone (not same reference)', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'DUPLICATE_BLOCK',
      payload: { blockId: 'b-1' },
    })
    expect(result.blocks[0]).not.toBe(result.blocks[1])
  })

  it('is a no-op when blockId is not found', () => {
    const state = buildState()
    const result = blockReducer(state, {
      type: 'DUPLICATE_BLOCK',
      payload: { blockId: 'nonexistent' },
    })
    expect(result).toBe(state)
  })
})

// ── externalRev ──────────────────────────────────────────────
// A mounted Tiptap editor reads its document once and never re-reads the prop,
// so after the array is replaced from outside (an Athena fill, an undo, the
// starter template) the editor still holds the OLD document and the next
// keystroke writes it back over the change. Editors key on externalRev and
// remount when it moves, so these two groups must stay on opposite sides:
// replacements bump it, the editor's own typing must not.

describe('externalRev', () => {
  it('bumps on APPLY_TEMPLATE and SET_BLOCKS (an external replacement)', () => {
    const state = buildState({ externalRev: 4 })
    expect(
      blockReducer(state, { type: 'APPLY_TEMPLATE', payload: { blocks: [buildDividerBlock('t')] } })
        .externalRev,
    ).toBe(5)
    expect(
      blockReducer(state, { type: 'SET_BLOCKS', payload: { blocks: [buildDividerBlock('t')] } })
        .externalRev,
    ).toBe(5)
  })

  it('does NOT bump on UPDATE_BLOCK — that is an editor reporting its own typing', () => {
    const state = buildState({ externalRev: 4 })
    const result = blockReducer(state, {
      type: 'UPDATE_BLOCK',
      payload: { blockId: 'b-1', data: { content: { type: 'doc', content: [] } } },
    })
    // Bumping here would remount the editor mid-sentence and drop the caret.
    expect(result.externalRev).toBe(4)
  })

  it('does not bump on add, remove, move or duplicate', () => {
    const state = buildState({ externalRev: 4 })
    const actions = [
      { type: 'ADD_BLOCK', payload: { block: buildDividerBlock('n'), afterIndex: 0 } },
      { type: 'REMOVE_BLOCK', payload: { blockId: 'b-1' } },
      { type: 'MOVE_BLOCK', payload: { fromIndex: 0, toIndex: 2 } },
      { type: 'DUPLICATE_BLOCK', payload: { blockId: 'b-1' } },
    ] as const
    for (const action of actions) {
      expect(blockReducer(state, action).externalRev).toBe(4)
    }
  })
})

// ── SET_BLOCKS ───────────────────────────────────────────────

describe('SET_BLOCKS', () => {
  it('replaces all blocks', () => {
    const state = buildState()
    const newBlocks = [buildDividerBlock('b-new')]
    const result = blockReducer(state, {
      type: 'SET_BLOCKS',
      payload: { blocks: newBlocks },
    })
    expect(result.blocks).toEqual(newBlocks)
  })
})

// ── APPLY_TEMPLATE ───────────────────────────────────────────
// Replaces the canvas wholesale: the starter template, an Athena fill, and the
// undo of a fill all land here. SET_BLOCKS is the same shape but reserved for
// syncing data loaded from the server.

describe('APPLY_TEMPLATE', () => {
  it('replaces blocks', () => {
    const state = buildState()
    const newBlocks = [buildDividerBlock('t-1'), buildTextBlock('t-2', 'Template')]
    const result = blockReducer(state, {
      type: 'APPLY_TEMPLATE',
      payload: { blocks: newBlocks },
    })
    expect(result.blocks).toEqual(newBlocks)
  })
})

// ── Unknown action ───────────────────────────────────────────

describe('unknown action', () => {
  it('returns state unchanged', () => {
    const state = buildState()
    // @ts-expect-error — intentionally passing unknown action
    const result = blockReducer(state, { type: 'UNKNOWN' })
    expect(result).toBe(state)
  })
})
