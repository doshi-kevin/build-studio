// Callout block preview — monochrome variant. We distinguish info/warning/
// success/alert through icon shape and a small "label" pill rather than
// color, since Scholera is intentionally pure monochrome (no brand color).

'use client'

import { Info, AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react'
import type { CalloutBlock, CalloutVariant } from '@/lib/validations/course-about'
import { RichTextView } from '../../RichText'
import { isDocEmpty } from '../../block-editor'

const VARIANTS: Record<CalloutVariant, { icon: typeof Info; label: string }> = {
  info: { icon: Info, label: 'Note' },
  warning: { icon: AlertTriangle, label: 'Warning' },
  success: { icon: CheckCircle, label: 'Success' },
  alert: { icon: AlertCircle, label: 'Alert' },
}

interface Props {
  block: CalloutBlock
}

export function CalloutBlockPreview({ block }: Props) {
  const variant = VARIANTS[block.data.variant]
  const Icon = variant.icon
  /* isDocEmpty walks nested nodes. The old check only looked at direct text
     children, so a bulleted list read as empty and an untitled callout holding
     one disappeared from the student's page entirely. */
  const empty = isDocEmpty(block.data.content)

  if (!block.data.title && empty) return null

  return (
    <div className="rounded-2xl border border-border bg-muted/30 p-5">
      <div className="flex gap-3">
        <Icon className="h-5 w-5 mt-0.5 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">
              {variant.label}
            </span>
            {block.data.title && (
              <p className="text-sm font-semibold text-foreground">{block.data.title}</p>
            )}
          </div>
          {!empty && <RichTextView value={block.data.content} className="text-sm leading-relaxed" />}
        </div>
      </div>
    </div>
  )
}
