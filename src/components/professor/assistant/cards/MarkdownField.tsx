'use client'

import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { cn } from '@/lib/utils'

/**
 * A long-form draft field that RENDERS markdown (bold/italics/headings/lists)
 * when not being edited, and swaps to a plain textarea on click — so the
 * professor reviews formatted text but can still edit it inline. Empty fields
 * show the textarea directly so the placeholder + typing work.
 */
export function MarkdownField({
  label,
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const showEditor = editing || !value.trim()

  return (
    <div>
      {/* The Edit affordance is NOT gated on `label`. It used to be, and no draft
          card passes a label — so the pencil never rendered anywhere, and every
          Athena draft body looked like static rendered text. The only hint was a
          `title` tooltip, which is invisible on touch and easy to miss on desktop.
          That is why drafts were reported as "cannot be edited" (pilot #7): they
          always could, nothing said so. */}
      {(label || !showEditor) && (
        <div className={cn('mb-1 flex items-center', label ? 'justify-between' : 'justify-end')}>
          {label && (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          )}
          {!showEditor && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex items-center gap-1 rounded-xl px-1.5 py-0.5 text-xs text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          )}
        </div>
      )}
      {showEditor ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          autoFocus={editing}
          rows={rows}
          placeholder={placeholder}
          className="resize-none text-sm leading-relaxed"
        />
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') setEditing(true) }}
          title="Click to edit"
          className="cursor-text rounded-xl border border-input bg-background px-3 py-2"
        >
          <MarkdownLatex content={value} className="prose-sm break-words" />
        </div>
      )}
    </div>
  )
}
