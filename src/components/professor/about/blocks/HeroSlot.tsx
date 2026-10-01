// Fixed Hero slot at the top of the About page editor.
//
// The Course Masthead is the page's title — every course needs one. Treating
// it as a draggable / deletable block was hostile to professors who'd
// accidentally remove it and panic. So Hero now lives in its own slot above
// the regular block canvas: no drag handle, no delete button, no
// "Add Course Masthead" entry in the insert menu. It's just the top of the
// page, like a book's title page.

'use client'

import { cn } from '@/lib/utils'
import type { HeroBlock } from '@/lib/validations/course-about'
import { useBlockEditor } from '../block-editor'
import { HeroBlockEditor } from './editors/HeroBlockEditor'
import { ChangeReviewBar } from './ChangeReviewBar'

interface Props {
  block: HeroBlock
}

export function HeroSlot({ block }: Props) {
  const { changedIds } = useBlockEditor()
  // Athena can update the hero's text fields (never its banner/CTA file), so it
  // needs the same review marker as every other block — same id attribute too,
  // so the canvas's scroll-to-first-changed can find it if it's the target.
  const recentlyChanged = changedIds.has(block.id)

  return (
    /* No heavy card or explanatory banner any more: the masthead used to open
       the canvas with a bordered panel, a caps label and two lines of prose
       before the professor reached a single field. It is the top of the page —
       it can just look like the top of the page. */
    <section
      id={`about-block-${block.id}`}
      data-block-id={block.id}
      className={cn(
        'relative rounded-2xl border border-transparent transition-colors',
        recentlyChanged && 'border-ai-muted-foreground/40 bg-ai-muted',
      )}
    >
      {/* Eyebrow treatment (matches the courses-page pattern), and more space
          above than below so it visibly belongs to what follows, not what's
          above — it was reading quieter than the field labels inside it. */}
      <p className="px-3 sm:px-4 pt-4 pb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Course masthead
      </p>
      {recentlyChanged && (
        <div className="px-3 sm:px-4 pb-2">
          <ChangeReviewBar />
        </div>
      )}
      <div className="px-3 sm:px-4 pb-4">
        <HeroBlockEditor block={block} />
      </div>
    </section>
  )
}
