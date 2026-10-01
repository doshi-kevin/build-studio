// Read-only "View as student" rendering of the About page.
//
// The published view is intentionally austere — no chrome, no labels, no
// borders, no toolbars. Hero and body both span the full container width
// (the page already provides the outer margins). Generous vertical rhythm
// between sections. This is the "published magazine" half of the
// drafting-desk-vs-published split.
//
// This exact component also renders the STUDENT route. The click-to-edit
// affordance exists only when `onEditBlock` is passed, which the student route
// never does — so no edit handler, ring, or hint reaches a student's DOM.

'use client'

import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AboutBlock } from '@/lib/validations/course-about'
import { BlockPreviewRenderer } from './blocks/BlockPreviewRenderer'

interface Props {
  blocks: AboutBlock[]
  /** Professor only. Present => clicking a section jumps into editing it. */
  onEditBlock?: (blockId: string) => void
}

/* Anything the reader is meant to operate in preview: the syllabus accordion,
   the hero's action button, a link inside body copy. A click that starts inside
   one of these belongs to that control, not to "edit this section" — otherwise
   opening a week would fling the professor into edit mode and the hero's CTA
   would try to navigate at the same time. */
/* contenteditable="true" only. The read-only Tiptap that renders body copy sets
   contenteditable="FALSE" on its root, so a bare [contenteditable] selector
   matched every paragraph on the page and swallowed the click that was supposed
   to open it for editing. */
const INTERACTIVE =
  'a,button,input,textarea,select,summary,iframe,[role="button"],[contenteditable="true"]'

function EditableBlock({
  block,
  onEditBlock,
}: {
  block: AboutBlock
  onEditBlock: (blockId: string) => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Edit this section`}
      className={cn(
        'group relative -mx-4 cursor-pointer rounded-2xl px-4 py-2 transition-colors duration-200',
        'hover:bg-muted/40 hover:ring-1 hover:ring-border',
        'focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return
        onEditBlock(block.id)
      }}
      onKeyDown={(e) => {
        // Enter/Space activates, same as a real button — this element carries
        // role="button" precisely so it needs to behave like one. Skipped
        // while focus is actually inside an interactive child (e.g. a link),
        // so pressing Enter on that link follows it instead of also opening
        // the editor underneath it.
        if ((e.key !== 'Enter' && e.key !== ' ') || (e.target as HTMLElement).closest(INTERACTIVE)) return
        e.preventDefault()
        onEditBlock(block.id)
      }}
    >
      <BlockPreviewRenderer block={block} />
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute right-3 top-2 rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground shadow-sm transition-opacity',
          // Always visible below sm — there is no hover on a touch screen to
          // reveal it, so without this a tap lands in the editor with zero
          // warning it was going to. Above sm, hover or keyboard focus reveals
          // it, same convention BlockToolbar uses for its own controls.
          'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100',
        )}
      >
        Click to edit
      </span>
    </div>
  )
}

export function BlockPreview({ blocks, onEditBlock }: Props) {
  if (blocks.length === 0) {
    /* This empty state is reachable from BOTH:
       - student route (no Edit affordance — they're just viewing)
       - professor's "View as student" mode (they can flip back to edit)
       The copy is written for the student case (the more common one);
       professors will recognise the situation either way. */
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        {/* The page's <h1> is normally the course title in the hero. With no
            blocks there is no hero, so on the student route this state is the
            only thing on the page and has to carry the heading. The professor's
            own preview does NOT get one: their page header is already rendering
            an <h1> above this, and two would be worse than none. */}
        {onEditBlock ? null : (
          <h1 className="mb-2 text-lg font-semibold text-foreground">About this course</h1>
        )}
        <p className="text-muted-foreground text-sm">
          Your professor hasn&apos;t set up the course page yet.
        </p>
      </div>
    )
  }

  /* Hero renders full-bleed; everything else flows in a centered reading
     column for comfortable line lengths. */
  const hero = blocks.find((b) => b.type === 'hero')
  const body = blocks.filter((b) => b.type !== 'hero')

  return (
    <article className="space-y-12">
      {hero && (
        <div>
          {onEditBlock
            ? <EditableBlock block={hero} onEditBlock={onEditBlock} />
            : <BlockPreviewRenderer block={hero} />}
        </div>
      )}
      {body.length > 0 && (
        <div className="space-y-10">
          {body.map((block) =>
            onEditBlock
              ? <EditableBlock key={block.id} block={block} onEditBlock={onEditBlock} />
              : <BlockPreviewRenderer key={block.id} block={block} />,
          )}
        </div>
      )}
    </article>
  )
}
