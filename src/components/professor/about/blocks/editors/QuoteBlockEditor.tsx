'use client'

import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { QuoteBlock } from '@/lib/validations/course-about'
import { useBlockEditor } from '../../block-editor'

interface Props {
  block: QuoteBlock
}

export function QuoteBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()

  const update = (data: Partial<QuoteBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  return (
    <div className="border-l-2 border-foreground/40 pl-5 py-2 space-y-2">
      <Textarea
        value={block.data.text}
        onChange={(e) => update({ text: e.target.value })}
        placeholder="Enter quote text..."
        className="resize-none border-none bg-transparent text-lg italic focus-visible:ring-0 p-0 min-h-[60px]"
      />
      <Input
        value={block.data.attribution}
        onChange={(e) => update({ attribution: e.target.value })}
        placeholder="— Attribution (optional)"
        className="border-none bg-transparent text-sm text-muted-foreground focus-visible:ring-0 p-0 h-auto"
      />
    </div>
  )
}
