// The Keep/Undo pair shown on a block Athena just changed. Rendered inline on
// the block itself AND, separately, as a chip in the chat panel — both call the
// EXACT SAME functions from BlockEditorContext (dismissChanged / activeUndo), so
// there is one source of truth for "has this been reviewed", not two states that
// can drift apart. Whichever one the professor clicks, the mark clears in both
// places at once, because it's the same state.
//
// "Keep" and "Undo", not "Accept" and "Reject": the edit is already applied and
// already saved by the time this renders. "Accept" would teach the professor a
// false mental model — that students haven't seen it yet.
//
// SCOPE IS PER-TURN, NOT PER-BLOCK, even though a bar like this renders on every
// block Athena touched: one batch is one reversal unit (a heading and the
// schedule it references may only make sense together — partial rollback can
// leave the page inconsistent), so clicking Keep or Undo on ANY block resolves
// ALL of them. This bar says so out loud once more than one block is marked —
// UX review caught that "Keep" on block 1 silently discarding block 2's Undo,
// with nothing labeled that way, reads as a scope violation even though it is
// the intended design.

'use client'

import { Check, Undo2 } from 'lucide-react'
import { useBlockEditor } from '../block-editor'

export function ChangeReviewBar() {
  const { activeUndo, dismissChanged, changedIds } = useBlockEditor()
  const isBatch = changedIds.size > 1

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-full border border-ai-muted-foreground/30 bg-ai-muted py-0.5 pl-2.5 pr-0.5 text-ai-muted-foreground">
      <span className="text-[10px] font-semibold uppercase tracking-wide">Changed by Athena</span>
      <button
        type="button"
        onClick={dismissChanged}
        className="-my-0.5 inline-flex min-h-11 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors hover:bg-ai-muted-foreground/10 md:min-h-8"
      >
        <Check className="h-3.5 w-3.5" aria-hidden="true" /> {isBatch ? 'Keep all' : 'Keep'}
      </button>
      {/* Guarded rather than assumed non-null: belt-and-suspenders against the one
          instant between markChanged() and setActiveUndo() landing. undo() itself
          — not this button — is what refuses when a hand edit has made it unsafe,
          so the professor gets a specific reason instead of a vanished button. */}
      {activeUndo && (
        <button
          type="button"
          onClick={activeUndo}
          className="-my-0.5 ml-1 inline-flex min-h-11 items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-ai-muted-foreground/10 hover:text-ai-muted-foreground md:min-h-8"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> {isBatch ? 'Undo all' : 'Undo'}
        </button>
      )}
    </div>
  )
}
