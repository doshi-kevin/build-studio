'use client'

import { Info, AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { CalloutBlock, CalloutVariant } from '@/lib/validations/course-about'
import { useBlockEditor } from '../../block-editor'
import { RichTextField } from '../../RichText'

const VARIANTS: { value: CalloutVariant; label: string; icon: typeof Info }[] = [
  { value: 'info', label: 'Note', icon: Info },
  { value: 'warning', label: 'Warning', icon: AlertTriangle },
  { value: 'success', label: 'Success', icon: CheckCircle },
  { value: 'alert', label: 'Alert', icon: AlertCircle },
]

interface Props {
  block: CalloutBlock
}

export function CalloutBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()
  const variant = VARIANTS.find((v) => v.value === block.data.variant) ?? VARIANTS[0]
  const Icon = variant.icon

  const update = (data: Partial<CalloutBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  return (
    <div className="rounded-2xl border border-border bg-muted/30 p-5">
      {/* Variant selector — pill row, monochrome */}
      <div className="flex gap-1 mb-3">
        {VARIANTS.map((v) => (
          <button
            key={v.value}
            onClick={() => update({ variant: v.value })}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] uppercase tracking-widest font-semibold transition-colors',
              block.data.variant === v.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-background'
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="flex gap-3">
        <Icon className="h-5 w-5 mt-0.5 shrink-0 text-foreground" />
        <div className="flex-1 space-y-2">
          <Input
            value={block.data.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="Callout title..."
            className="border-none bg-transparent font-semibold focus-visible:ring-0 p-0 h-auto"
          />
          <RichTextField
            value={block.data.content}
            onChange={(content) => update({ content })}
            className="text-sm"
          />
        </div>
      </div>
    </div>
  )
}
