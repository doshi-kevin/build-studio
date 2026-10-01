import type { AboutBlock } from '@/lib/validations/course-about'

export interface BlockState {
  blocks: AboutBlock[]
  /* Bumped ONLY when the whole array is replaced from outside the editors —
     an Athena fill, an undo, the starter template. A mounted rich-text editor
     (Tiptap) takes its document once at mount and never re-reads the prop, so
     after an external replacement it still holds the old document and the next
     keystroke writes that stale copy back over the change. Editors key
     themselves on this counter and remount when it moves. UPDATE_BLOCK does NOT
     bump it: that action IS an editor reporting its own typing, and remounting
     on every keystroke would throw away the cursor. */
  externalRev: number
}

export type BlockAction =
  | { type: 'ADD_BLOCK'; payload: { block: AboutBlock; afterIndex: number } }
  | { type: 'REMOVE_BLOCK'; payload: { blockId: string } }
  | { type: 'MOVE_BLOCK'; payload: { fromIndex: number; toIndex: number } }
  | { type: 'UPDATE_BLOCK'; payload: { blockId: string; data: Partial<AboutBlock['data']> } }
  | { type: 'DUPLICATE_BLOCK'; payload: { blockId: string } }
  | { type: 'SET_BLOCKS'; payload: { blocks: AboutBlock[] } }
  /* Replaces the canvas wholesale (starter template, Athena fill, undo of a fill).
     SET_BLOCKS is reserved for syncing data loaded from the server. Both bump
     externalRev — see the note on BlockState. */
  | { type: 'APPLY_TEMPLATE'; payload: { blocks: AboutBlock[] } }

export function blockReducer(state: BlockState, action: BlockAction): BlockState {
  switch (action.type) {
    case 'ADD_BLOCK': {
      const { block, afterIndex } = action.payload
      const blocks = [...state.blocks]
      blocks.splice(afterIndex, 0, block)
      return { ...state, blocks }
    }

    case 'REMOVE_BLOCK': {
      return {
        ...state,
        blocks: state.blocks.filter((b) => b.id !== action.payload.blockId),
      }
    }

    case 'MOVE_BLOCK': {
      const { fromIndex, toIndex } = action.payload
      if (fromIndex === toIndex) return state
      const blocks = [...state.blocks]
      const [moved] = blocks.splice(fromIndex, 1)
      blocks.splice(toIndex, 0, moved)
      return { ...state, blocks }
    }

    case 'UPDATE_BLOCK': {
      const { blockId, data } = action.payload
      return {
        ...state,
        blocks: state.blocks.map((b) =>
          b.id === blockId ? { ...b, data: { ...b.data, ...data } } as AboutBlock : b
        ),
      }
    }

    case 'DUPLICATE_BLOCK': {
      const idx = state.blocks.findIndex((b) => b.id === action.payload.blockId)
      if (idx === -1) return state
      const original = state.blocks[idx]
      const clone: AboutBlock = {
        ...JSON.parse(JSON.stringify(original)),
        id: crypto.randomUUID(),
      }
      const blocks = [...state.blocks]
      blocks.splice(idx + 1, 0, clone)
      return { ...state, blocks }
    }

    case 'SET_BLOCKS': {
      return { blocks: action.payload.blocks, externalRev: state.externalRev + 1 }
    }

    case 'APPLY_TEMPLATE': {
      return { blocks: action.payload.blocks, externalRev: state.externalRev + 1 }
    }

    default:
      return state
  }
}
