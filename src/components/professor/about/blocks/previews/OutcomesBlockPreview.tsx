// Learning Outcomes block — pure monochrome rendering. Core outcomes get a
// filled foreground bullet; supplemental ones get an outline bullet. No
// accent colors — the rest of Scholera is intentionally monochrome.

'use client'

import type { LearningOutcomesBlock } from '@/lib/validations/course-about'

interface Props {
  block: LearningOutcomesBlock
}

export function OutcomesBlockPreview({ block }: Props) {
  const title = block.data.title

  /* Coming-soon stub — prof has flagged this section as not ready */
  if (block.data.tba) {
    return (
      <div className="space-y-3">
        {title && (
          <h2 className="font-serif text-2xl text-foreground">
            {title}
          </h2>
        )}
        <div className="rounded-2xl border border-dashed border-border bg-muted/30 px-5 py-4">
          <p className="text-[10px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
            Coming soon
          </p>
          <p className="text-sm text-foreground mt-1">
            Learning outcomes will be posted here before the course starts.
          </p>
        </div>
      </div>
    )
  }

  /* Filter out empty rows — the editor seeds blanks for the prof to fill in,
     but students should only ever see populated outcomes. If nothing is filled
     in, hide the whole section rather than render a column of bare dots. */
  const visible = block.data.outcomes.filter((o) => o.text.trim() !== '')
  if (visible.length === 0) return null

  return (
    <div className="space-y-3">
      {title && (
        <h2 className="font-serif text-2xl text-foreground">
          {title}
        </h2>
      )}
      <ul className="space-y-2.5">
        {visible.map((outcome) => (
          <li key={outcome.id} className="flex items-start gap-3">
            <span
              aria-hidden
              className={
                outcome.isCore
                  ? 'mt-2 h-1.5 w-1.5 rounded-full bg-foreground shrink-0'
                  : 'mt-2 h-1.5 w-1.5 rounded-full border border-foreground/60 shrink-0'
              }
            />
            <span className="text-sm text-foreground leading-relaxed">{outcome.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
