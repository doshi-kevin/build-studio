// Left rail of the quiz studio — question thumbnails (drag to reorder), the
// one-click add split button (sticky last-used type), and the "Add from AI,
// bank & import" hub button. Option D of docs/designs/quizzes/quiz-editor-studio.md.

'use client'

import { useEffect, useRef } from 'react'
import { AlertTriangle, CloudOff, FolderInput, Trash2 } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { QUESTION_TYPE_LABELS, type QuizItemType } from '@/lib/validations/quiz'
import { blankPlaceholderText } from '@/lib/quiz/fill-in-blank'
import { AddQuestionSplitButton } from './AddQuestionSplitButton'
import type { WizardQuestion } from './QuestionEditorCard'

interface QuizStudioRailProps {
  questions: WizardQuestion[]
  selectedId: string | null
  onSelect: (clientId: string) => void
  onReorder: (questions: WizardQuestion[]) => void
  /** The sticky one-click type (last used) */
  stickyType: QuizItemType
  /** Add a question of the given type (also makes it the new sticky type) */
  onAddType: (type: QuizItemType) => void
  /** Remove a question (shown as a delete button on thumbnail hover) */
  onRemove: (clientId: string) => void
  /** Whether Adaptive Mode is on — unlocks the Explanation/Walkthrough types */
  adaptive: boolean
  /** Open the add hub in the canvas (AI / bank / JSON as full cards) */
  onOpenHub: () => void
  /** Hide the bottom add-controls — the center hub is showing the same actions,
   *  so the rail shouldn't duplicate them. */
  hideAddControls?: boolean
  /** A generation is streaming in — keep the one-click manual add live, but
   *  hide the AI/bank/import launcher (starting a second run would race the
   *  settle-time assignment sync). Nothing replaces it — the header banner and
   *  shimmer chips already signal that generation is active. */
  generating?: boolean
  /** Number of not-yet-arrived AI questions — rendered as shimmer placeholders
   *  below the real thumbnails while generation streams in. */
  pendingCount?: number
  /** clientIds flagged invalid at the last save attempt */
  flaggedIds?: Set<string>
  /** clientId → why autosave is holding it back (invalid → not persisted until fixed) */
  unsavedReasons?: Map<string, string>
  /** DndContext id — override so a second (mobile-sheet) instance doesn't emit
   *  a duplicate DOM id alongside the inline desktop rail. */
  dndId?: string
}

export function QuizStudioRail({
  questions,
  selectedId,
  onSelect,
  onReorder,
  stickyType,
  onAddType,
  adaptive,
  onOpenHub,
  onRemove,
  hideAddControls,
  generating = false,
  pendingCount = 0,
  flaggedIds,
  unsavedReasons,
  dndId = 'quiz-studio-rail-dnd',
}: QuizStudioRailProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = questions.findIndex((q) => q.clientId === active.id)
    const newIndex = questions.findIndex((q) => q.clientId === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    onReorder(arrayMove(questions, oldIndex, newIndex))
  }

  return (
    <div className="flex h-full w-48 shrink-0 flex-col border-r bg-muted/20">
      {/* Thumbnails — the only scrollable part. Extra left padding reserves a
          gutter so each thumb's delete button sits OUTSIDE the chip on hover,
          never over its text. */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto py-3 pl-6 pr-3">
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={questions.map((q) => q.clientId)}
            strategy={verticalListSortingStrategy}
          >
            {questions.map((q, idx) => (
              <RailThumb
                key={q.clientId}
                question={q}
                index={idx}
                selected={q.clientId === selectedId}
                flagged={flaggedIds?.has(q.clientId) ?? false}
                unsavedReason={unsavedReasons?.get(q.clientId) ?? null}
                onSelect={() => onSelect(q.clientId)}
                onRemove={() => onRemove(q.clientId)}
              />
            ))}
          </SortableContext>
        </DndContext>
        {/* AI questions still streaming in — placeholder chips carrying the
            forthcoming question number + "New question…" over the subtle
            shimmer, so they read as pending questions rather than empty boxes.
            (No type: with a mix requested the AI decides each one per batch.)
            Capped at 8 — the header banner carries the exact "N of M" count. */}
        {pendingCount > 0 &&
          Array.from({ length: Math.min(pendingCount, 8) }).map((_, i) => (
            <div
              key={`pending-${i}`}
              aria-hidden="true"
              className="ai-shimmer w-full rounded-xl border border-border/60 p-2 text-xs"
            >
              <div className="relative z-10">
                <span className="font-semibold text-muted-foreground tabular-nums">
                  {questions.length + i + 1}
                </span>
                <span className="mt-0.5 block truncate text-muted-foreground/70">
                  New question…
                </span>
              </div>
            </div>
          ))}
      </div>

      {/* Add controls — pinned at the bottom. Hidden while the center hub is
          showing (it offers the same actions — don't duplicate them). Kept
          visible during generation so the professor can keep hand-authoring
          questions (the AI/bank/import launcher is hidden then — see below). */}
      {!hideAddControls && (
        <div className="shrink-0 space-y-2 border-t p-3">
          <AddQuestionSplitButton
            stickyType={stickyType}
            onAddType={onAddType}
            adaptive={adaptive}
            size="sm"
            menuAlign="start"
            className="w-full"
          />
          {/* AI/bank/import launcher — hidden while generating (a second run
              would race the settle-time assignment sync). Manual one-click add
              above stays available. */}
          {!generating && (
            <button
              type="button"
              onClick={onOpenHub}
              className="w-full rounded-xl border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <FolderInput className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
              Add from bank &amp; import
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function RailThumb({
  question,
  index,
  selected,
  flagged,
  unsavedReason,
  onSelect,
  onRemove,
}: {
  question: WizardQuestion
  index: number
  selected: boolean
  flagged: boolean
  unsavedReason: string | null
  onSelect: () => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: question.clientId,
  })
  // Keep the selected thumb visible when selection comes from elsewhere
  // (failed-save flag, add at the end of a long quiz).
  const nodeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (selected) nodeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    // The whole thumb drags (no grip): pointer listeners live on the wrapper —
    // clicks still reach the inner select button thanks to the sensor's 8px
    // activation distance. Keyboard drag only fires when the WRAPPER itself is
    // focused; bubbled Enter/Space from the inner button must keep selecting,
    // so the onKeyDown after the spread filters on event.target.
    <div
      ref={(node) => {
        setNodeRef(node)
        nodeRef.current = node
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget) listeners?.onKeyDown?.(e)
      }}
      // dnd-kit's attributes default to role="button", which would nest the
      // real select <button> inside another button (invalid ARIA). The wrapper
      // stays focusable (tabIndex from attributes) for keyboard reorder.
      role="group"
      aria-label={`Reorder question ${index + 1}`}
      className={cn(
        'group relative cursor-grab touch-none rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
        isDragging && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'w-full rounded-xl border bg-card p-2 text-left text-xs transition-colors',
          selected
            ? 'border-primary ring-2 ring-primary/20'
            : 'border-border hover:border-foreground/30',
          flagged && !selected && 'border-destructive/60',
        )}
      >
        {/* Name truncates; the ⚠ status glyph never does. No per-thumb AI
            marker — with mostly-AI quizzes it was pure noise; provenance
            lives on the editor card's source chip. */}
        <span
          className={cn(
            'flex items-center gap-1 font-semibold',
            selected ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <span className="truncate">
            {index + 1} · {QUESTION_TYPE_LABELS[question.questionType]}
          </span>
          {/* One status glyph: a blocking flag (from a failed save) outranks
              the passive "autosave is holding this back" marker. */}
          {flagged ? (
            <span
              className="shrink-0 text-destructive"
              title="This question blocked the last save — open it to see the problem"
            >
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Blocked the last save</span>
            </span>
          ) : unsavedReason ? (
            <span
              className="shrink-0 text-warning-muted-foreground"
              title={`Not saved yet — ${unsavedReason}`}
            >
              <CloudOff className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">Not saved yet — {unsavedReason}</span>
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-muted-foreground">
          {/* FIB stems carry {{blank:id:answers}} tokens — show "_____" (also
              strips the answer) instead of the raw token in the thumbnail. */}
          {blankPlaceholderText(question.questionText).trim() || 'New question…'}
        </span>
      </button>
      {/* Delete — a subtle glyph in the gutter OUTSIDE the chip's left border
          (right-full puts its right edge at the chip's left edge), revealed on
          hover/focus so it never sits over the chip's text. Sibling of the
          select button (not nested → no invalid nested-button ARIA);
          stopPropagation on pointerdown keeps a click off the drag sensor. */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={`Delete question ${index + 1}`}
        className="absolute inset-y-0 right-full z-10 mr-1 flex items-center rounded-full p-0.5 text-muted-foreground/50 opacity-0 transition hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
