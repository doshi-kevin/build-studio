// The "Athena just changed this" review state (BlockEditorContext): persists until the
// professor deals with it (Keep, Undo, or typing over it), never a timer. Two things live
// here that are easy to get backwards, so both are pinned:
//
//  1. Typing into a block Athena just touched clears THAT block's mark and flips the whole
//     turn's Undo unsafe — reverting a batch that includes a block the professor has since
//     hand-edited would silently discard what they typed.
//  2. A fresh turn (markChanged again) resets that unsafe flag — the new turn hasn't been
//     touched by hand yet, so it starts clean, independent of whatever happened to the last one.
import { describe, it, expect } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { BlockEditorProvider, useBlockEditor } from '@/components/professor/about/block-editor'
import type { AboutBlock } from '@/lib/validations/course-about'

function textBlock(id: string): AboutBlock {
  return {
    id,
    type: 'text',
    data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] } },
  } as AboutBlock
}

const BLOCKS = [textBlock('b1'), textBlock('b2'), textBlock('b3')]

function renderContext() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BlockEditorProvider initialBlocks={BLOCKS} sectionId="sec-1">{children}</BlockEditorProvider>
  )
  return renderHook(() => useBlockEditor(), { wrapper })
}

describe('BlockEditorContext — Athena change-review state', () => {
  it('starts empty and undo-safe', () => {
    const { result } = renderContext()
    expect(result.current.changedIds.size).toBe(0)
    expect(result.current.isUndoSafe()).toBe(true)
  })

  it('markChanged marks the given blocks, replacing whatever was there', () => {
    const { result } = renderContext()
    act(() => result.current.markChanged(['b1', 'b2']))
    expect(result.current.changedIds.has('b1')).toBe(true)
    expect(result.current.changedIds.has('b2')).toBe(true)
    expect(result.current.changedIds.has('b3')).toBe(false)

    // A second turn replaces the first — the earlier turn's marks are gone, not merged.
    act(() => result.current.markChanged(['b3']))
    expect(result.current.changedIds.has('b1')).toBe(false)
    expect(result.current.changedIds.has('b3')).toBe(true)
  })

  it('typing in a marked block clears just that block and flips the turn unsafe', () => {
    const { result } = renderContext()
    act(() => result.current.markChanged(['b1', 'b2']))

    act(() => result.current.dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: 'b1', data: {} } }))

    expect(result.current.changedIds.has('b1')).toBe(false)
    // b2 is untouched — one hand edit doesn't wipe the whole turn's markers.
    expect(result.current.changedIds.has('b2')).toBe(true)
    expect(result.current.isUndoSafe()).toBe(false)
  })

  it('typing in an UNmarked block does not flip undo-safety', () => {
    const { result } = renderContext()
    act(() => result.current.markChanged(['b1']))

    act(() => result.current.dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: 'b3', data: {} } }))

    expect(result.current.isUndoSafe()).toBe(true)
    expect(result.current.changedIds.has('b1')).toBe(true)
  })

  it('a fresh turn resets undo-safety even if the previous turn was made unsafe', () => {
    const { result } = renderContext()
    act(() => result.current.markChanged(['b1']))
    act(() => result.current.dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: 'b1', data: {} } }))
    expect(result.current.isUndoSafe()).toBe(false)

    act(() => result.current.markChanged(['b2']))
    expect(result.current.isUndoSafe()).toBe(true)
  })

  it('dismissChanged (Keep, or the tail of Undo) clears all marks and the active undo', () => {
    const { result } = renderContext()
    act(() => result.current.markChanged(['b1', 'b2']))
    act(() => result.current.setActiveUndo(() => {}))
    expect(result.current.activeUndo).not.toBeNull()

    act(() => result.current.dismissChanged())

    expect(result.current.changedIds.size).toBe(0)
    expect(result.current.activeUndo).toBeNull()
  })

  it('getActiveUndo lets a stale closure detect it was already resolved elsewhere', () => {
    // This is the exact bug found live: Keep clicked on the canvas clears the
    // canvas's own marker, but the chat panel's Undo chip is separate React state
    // in a sibling component tree — it has no way to know Keep happened, so it
    // stays clickable. Before this check, clicking it called the SAME undo
    // closure and silently reverted content the professor had just chosen to
    // keep. AboutPageBuilder's undo() calls getActiveUndo() === undo as its
    // first line specifically to catch this from either direction.
    const { result } = renderContext()
    act(() => result.current.markChanged(['b1']))
    const undoFn = () => {}
    act(() => result.current.setActiveUndo(undoFn))
    expect(result.current.getActiveUndo()).toBe(undoFn)

    // Keep (canvas or chat — both call dismissChanged) resolves the turn.
    act(() => result.current.dismissChanged())

    // The chat's chip still holds its own reference to undoFn and could still
    // call it; getActiveUndo() no longer points at it, so a caller checking
    // `getActiveUndo() !== undoFn` correctly sees it as stale and refuses.
    expect(result.current.getActiveUndo()).not.toBe(undoFn)
    expect(result.current.getActiveUndo()).toBeNull()
  })

  it('getActiveUndo reflects a NEWER turn superseding an older one', () => {
    const { result } = renderContext()
    const firstUndo = () => {}
    const secondUndo = () => {}
    act(() => {
      result.current.markChanged(['b1'])
      result.current.setActiveUndo(firstUndo)
    })
    expect(result.current.getActiveUndo()).toBe(firstUndo)

    act(() => {
      result.current.markChanged(['b2'])
      result.current.setActiveUndo(secondUndo)
    })

    // A stale reference to the first turn's undo is no longer the live one.
    expect(result.current.getActiveUndo()).not.toBe(firstUndo)
    expect(result.current.getActiveUndo()).toBe(secondUndo)
  })

  it('APPLY_TEMPLATE (an Athena fill or its undo) does not itself touch changedIds', () => {
    // Only UPDATE_BLOCK means "the professor typed here". Athena's own write to the
    // reducer must not be mistaken for a hand edit that would flip undo-safety.
    const { result } = renderContext()
    act(() => result.current.markChanged(['b1']))

    act(() => result.current.dispatch({ type: 'APPLY_TEMPLATE', payload: { blocks: BLOCKS } }))

    expect(result.current.changedIds.has('b1')).toBe(true)
    expect(result.current.isUndoSafe()).toBe(true)
  })
})
