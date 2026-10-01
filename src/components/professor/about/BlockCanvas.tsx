// Renders the editable About page.
//
// Layout (top to bottom):
//   1. Hero slot — fixed, non-draggable, non-deletable masthead.
//   2. Regular blocks — drag-to-reorder, hover-toolbar editing.
//   3. Persistent "+ Add section" button at the very end.
//
// Per UX feedback we ditched the hover-only inline + buttons between blocks
// (too easy for non-technical users to miss) in favor of one always-visible
// button at the bottom. Power users can still type "/" inside a Text block
// to insert content inline.

'use client'

import { useCallback, useEffect, useState } from 'react'
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
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useBlockEditor, getStarterTemplate, createBlock, BLOCK_REGISTRY, BLOCK_CATEGORIES } from './block-editor'
import { SortableBlockWrapper } from './blocks/SortableBlockWrapper'
import { BlockRenderer } from './blocks/BlockRenderer'
import { HeroSlot } from './blocks/HeroSlot'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Plus, LayoutTemplate } from 'lucide-react'
import type { CourseInfo } from './AboutPageBuilder'
import type { BlockType, HeroBlock } from '@/lib/validations/course-about'

interface Props {
  courseInfo: CourseInfo
  /** Set when the professor clicked this section in preview — scroll to it and
   *  put the caret in its first field, so editing existing copy is one click. */
  focusBlockId?: string | null
  onFocusHandled?: () => void
}

/** `smooth` unconditionally ignored a professor's OS-level reduced-motion
 *  setting on both scroll-into-view calls below. No existing helper for this
 *  in the repo (the framer-motion `reducedMotion="user"` config in
 *  MotionProvider only governs framer animations, not the browser's own
 *  scrollIntoView) — small enough to keep local to this file's two call sites
 *  rather than add a new shared one. */
const scrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'

export function BlockCanvas({ courseInfo, focusBlockId, onFocusHandled }: Props) {
  const { state, dispatch, changedIds } = useBlockEditor()
  const { blocks } = state

  /* Land the caret in the section the professor clicked. Runs after the canvas
     has mounted, so the block's inputs exist. Tiptap renders a contenteditable
     rather than an input, hence both in the selector. */
  useEffect(() => {
    if (!focusBlockId) return
    let frame = 0
    let raf = 0
    /* Tiptap builds its contenteditable asynchronously, so on the first frame
       after the canvas mounts the field does not exist yet and a focus() call
       finds nothing. Retry for a few frames, then give up rather than spin —
       the block is scrolled into view either way, so the worst case is the old
       two-click behaviour, never a hang. */
    const tryFocus = () => {
      const el = document.getElementById(`about-block-${focusBlockId}`)
      if (el) {
        if (frame === 0) el.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
        const field = el.querySelector<HTMLElement>(
          '[contenteditable="true"], input:not([type="checkbox"]):not([type="file"]), textarea',
        )
        if (field) {
          field.focus()
          onFocusHandled?.()
          return
        }
      }
      if (frame++ < 20) raf = requestAnimationFrame(tryFocus)
      else onFocusHandled?.()
    }
    raf = requestAnimationFrame(tryFocus)
    return () => cancelAnimationFrame(raf)
  }, [focusBlockId, onFocusHandled])

  /* Scroll to the first block Athena changed, so a fill that lands off-screen
     is not invisible. Runs once per turn: markChanged() replaces the whole set,
     so this only re-fires on a genuinely new fill, not on every Keep/Undo/manual
     edit that shrinks it afterward. */
  const firstChangedId = blocks.find((b) => changedIds.has(b.id))?.id
  useEffect(() => {
    if (!firstChangedId) return
    document.getElementById(`about-block-${firstChangedId}`)?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on a new turn's first id, not on every render where it's still present
  }, [changedIds])

  /* Split: one hero (always rendered in the fixed slot) + everything else. */
  const heroBlock = blocks.find((b) => b.type === 'hero') as HeroBlock | undefined
  const bodyBlocks = blocks.filter((b) => b.type !== 'hero')

  const [insertOpen, setInsertOpen] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const fromIndex = blocks.findIndex((b) => b.id === active.id)
    const toIndex = blocks.findIndex((b) => b.id === over.id)
    if (fromIndex !== -1 && toIndex !== -1) {
      dispatch({ type: 'MOVE_BLOCK', payload: { fromIndex, toIndex } })
    }
  }, [blocks, dispatch])

  const handleInsert = (type: BlockType) => {
    dispatch({ type: 'ADD_BLOCK', payload: { block: createBlock(type), afterIndex: blocks.length } })
    setInsertOpen(false)
  }

  /* Cold-start view — never been edited, no blocks at all */
  if (blocks.length === 0) {
    const handleApplyTemplate = () => {
      dispatch({ type: 'APPLY_TEMPLATE', payload: { blocks: getStarterTemplate(courseInfo) } })
    }
    return (
      <div className="rounded-3xl border border-border bg-card overflow-hidden">
        <div className="mx-auto max-w-xl px-8 py-16 text-center sm:px-12">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
            <LayoutTemplate className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mt-5 text-xl font-semibold tracking-tight text-foreground">
            Start your course page
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Drop in a starter layout — masthead, course description, learning outcomes, and a
            weekly schedule, pre-filled with this course&apos;s details. Edit, reorder, or remove
            any section.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Button onClick={handleApplyTemplate} className="gap-2 rounded-full">
              <LayoutTemplate className="h-4 w-4" />
              Use the starter layout
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 border-t border-border bg-muted/30 px-8 py-5 text-center sm:grid-cols-4 sm:px-12">
          {[
            { label: 'Masthead', sub: 'Course title' },
            { label: 'Description', sub: 'Rich text' },
            { label: 'Outcomes', sub: 'What students learn' },
            { label: 'Schedule', sub: 'Weekly plan' },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground">
                {item.label}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{item.sub}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Fixed masthead slot — always at top, never draggable */}
      {heroBlock && <HeroSlot block={heroBlock} />}

      {/* Regular sortable blocks */}
      <DndContext id="about-blocks-dnd" sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={bodyBlocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {bodyBlocks.map((block) => (
              <SortableBlockWrapper key={block.id} block={block}>
                <BlockRenderer block={block} />
              </SortableBlockWrapper>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Persistent Add section button — always visible, no hover required */}
      <div className="pt-3 flex justify-center">
        <Popover open={insertOpen} onOpenChange={setInsertOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="default" className="gap-2 rounded-full">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add section
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2 max-h-[60vh] overflow-y-auto rounded-2xl" align="center">
            {BLOCK_CATEGORIES.map((cat) => {
              const entries = Object.entries(BLOCK_REGISTRY).filter(
                ([type, entry]) => entry.category === cat.key && type !== 'hero'
              )
              if (entries.length === 0) return null
              return (
                <div key={cat.key} className="mb-2 last:mb-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 py-1">
                    {cat.label}
                  </p>
                  {entries.map(([type, entry]) => {
                    const Icon = entry.icon
                    return (
                      <button
                        key={type}
                        onClick={() => handleInsert(type as BlockType)}
                        className="flex items-center gap-3 w-full rounded-xl px-2 py-1.5 text-left hover:bg-muted transition-colors"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
                          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium leading-tight">{entry.label}</p>
                          <p className="text-xs text-muted-foreground leading-tight truncate">{entry.description}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
