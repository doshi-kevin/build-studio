// React context that wraps the block-editor reducer plus the edit/preview
// toggle. Components anywhere under <BlockEditorProvider> can read state and
// dispatch block actions via the useBlockEditor() hook.
//
// sectionId is exposed so block editors (Hero, Image) can build storage paths
// for uploads scoped to this course section.

'use client'

import { createContext, useCallback, useContext, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { AboutBlock } from '@/lib/validations/course-about'
import { isLongBlock } from './block-utils'
import { blockReducer, type BlockState, type BlockAction } from './use-block-reducer'

interface BlockEditorContextValue {
  state: BlockState
  dispatch: React.Dispatch<BlockAction>
  isEditing: boolean
  setIsEditing: (editing: boolean) => void
  /** The course section this editor is operating on — needed for scoped uploads. */
  sectionId: string
  /** Blocks folded shut in the canvas. Editor-only: the student view never reads it. */
  collapsedIds: ReadonlySet<string>
  toggleCollapsed: (blockId: string) => void
  /** Open a block and scroll to it — the preview's click-to-edit entry point. */
  expand: (blockId: string) => void
  /** Blocks Athena changed on its latest turn that the professor hasn't dealt with yet.
   *  Persists until Keep, Undo, or a manual edit to that block — never a timer. See the
   *  note on `markChanged` for why this lives here instead of in AboutPageBuilder. */
  changedIds: ReadonlySet<string>
  /** Call when a fill lands: replaces the set with that turn's touched blocks and resets
   *  the undo-safety flag. A later turn superseding an earlier one is exactly this call
   *  landing again — the previous turn's marks clear because they're not in the new set. */
  markChanged: (ids: string[]) => void
  /** Keep, or the tail end of Undo: clears every remaining mark from the current turn.
   *  Never touches block content — the fill is already saved either way. */
  dismissChanged: () => void
  /** False once ANY block the current turn touched has been hand-edited since. Read at
   *  Undo time: reverting a batch that includes a block the professor has since typed
   *  into would silently discard that typing, so Undo is refused instead. */
  isUndoSafe: () => boolean
  /** The current turn's revert function, for the canvas's own Undo button — the same
   *  closure the chat's Undo chip calls, so there is one source of truth to click. */
  activeUndo: (() => void) | null
  setActiveUndo: (fn: (() => void) | null) => void
  /** Reads `activeUndo` WITHOUT subscribing to it — for a closure to check, at click
   *  time, whether it is still the live one. See the note inside `setActiveUndo`. */
  getActiveUndo: () => (() => void) | null
}

const BlockEditorContext = createContext<BlockEditorContextValue | null>(null)

export function useBlockEditor() {
  const ctx = useContext(BlockEditorContext)
  if (!ctx) throw new Error('useBlockEditor must be used within BlockEditorProvider')
  return ctx
}

interface ProviderProps {
  initialBlocks: AboutBlock[]
  sectionId: string
  children: ReactNode
}

export function BlockEditorProvider({ initialBlocks, sectionId, children }: ProviderProps) {
  const [state, rawDispatch] = useReducer(blockReducer, {
    blocks: initialBlocks,
    externalRev: 0,
  })
  const [isEditing, setIsEditing] = useState(false)

  /* Collapse is a view preference for the professor's canvas, so it lives in
     React state, not in the block data. It used to be persisted on the block and
     written to the database on every toggle — a student-visible column taking a
     write for something students never see.

     Seeded ONCE, from the blocks as they loaded: anything the professor had
     previously folded stays folded, and anything long enough to bury the rest of
     the page starts folded. Deliberately not recomputed, because isLongBlock()
     crosses its threshold mid-edit — adding a 4th week to a 3-week schedule would
     otherwise fold the block shut under the professor's cursor. */
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
    () => new Set(initialBlocks.filter((b) => b.collapsed || isLongBlock(b)).map((b) => b.id)),
  )

  const toggleCollapsed = useCallback((blockId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (!next.delete(blockId)) next.add(blockId)
      return next
    })
  }, [])

  const expand = useCallback((blockId: string) => {
    setCollapsedIds((prev) => {
      if (!prev.has(blockId)) return prev
      const next = new Set(prev)
      next.delete(blockId)
      return next
    })
  }, [])

  /* Athena change-review state. Lives here, not in AboutPageBuilder, for one reason:
     "typing in a marked block means you've taken ownership of it" has to see every
     UPDATE_BLOCK dispatch, and every editor calls dispatch through this context
     directly — AboutPageBuilder never sees those calls. Wrapping dispatch here is the
     one place that can catch all of them without touching 12 editor files. */
  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(new Set())
  const [activeUndo, setActiveUndoState] = useState<(() => void) | null>(null)
  /* Refs, not state: read inside the undo() closure at click time, not at render time —
     a professor could type into a marked block, or resolve the turn some other way,
     several renders after the closure was created, and it must see that, not a stale
     snapshot from when it was made. */
  const undoUnsafeRef = useRef(false)
  const activeUndoRef = useRef<(() => void) | null>(null)

  /* Call as setActiveUndo(undo), passing the function itself — NOT setActiveUndo(() =>
     undo). The wrapper below does its OWN internal wrapping for the raw useState
     setter (which needs the functional-updater form so React doesn't call `fn`
     immediately, mistaking it for an updater); double-wrapping at the call site
     would store "a function that returns undo" instead of undo itself, and every
     identity check against getActiveUndo() would then silently, permanently fail.
     TypeScript will not catch this: `() => void` is permissive about what a function
     returns, so `() => undo` type-checks fine here despite being wrong. A test
     catches it instead — see about-change-review.test.tsx.

     Keeping the ref in lockstep here, rather than syncing it in a useEffect, means a
     closure created and resolved inside the same tick (Undo calling dismissChanged()
     at its own end) never sees a stale ref. */
  const setActiveUndo = useCallback((fn: (() => void) | null) => {
    activeUndoRef.current = fn
    setActiveUndoState(() => fn)
  }, [])
  const getActiveUndo = useCallback(() => activeUndoRef.current, [])

  const markChanged = useCallback((ids: string[]) => {
    undoUnsafeRef.current = false
    setChangedIds(new Set(ids))
  }, [])

  const dismissChanged = useCallback(() => {
    setChangedIds(new Set())
    setActiveUndo(null)
  }, [setActiveUndo])

  const isUndoSafe = useCallback(() => !undoUnsafeRef.current, [])

  const dispatch = useCallback<React.Dispatch<BlockAction>>((action) => {
    if (action.type === 'UPDATE_BLOCK') {
      setChangedIds((prev) => {
        if (!prev.has(action.payload.blockId)) return prev
        undoUnsafeRef.current = true
        const next = new Set(prev)
        next.delete(action.payload.blockId)
        return next
      })
    }
    rawDispatch(action)
  }, [])

  const value = useMemo(() => ({
    state, dispatch, isEditing, setIsEditing, sectionId, collapsedIds, toggleCollapsed, expand,
    changedIds, markChanged, dismissChanged, isUndoSafe, activeUndo, setActiveUndo, getActiveUndo,
  }), [
    state, isEditing, sectionId, collapsedIds, toggleCollapsed, expand, dispatch,
    changedIds, markChanged, dismissChanged, isUndoSafe, activeUndo, setActiveUndo, getActiveUndo,
  ])

  return (
    <BlockEditorContext.Provider value={value}>
      {children}
    </BlockEditorContext.Provider>
  )
}
