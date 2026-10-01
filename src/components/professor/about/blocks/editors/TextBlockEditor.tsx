'use client'

import type { TextBlock, TiptapDoc } from '@/lib/validations/course-about'
import { useBlockEditor } from '../../block-editor'
import { RichTextField } from '../../RichText'

interface Props {
  block: TextBlock
}

export function TextBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()

  return (
    <div className="min-h-[80px]">
      <RichTextField
        className="p-2"
        value={block.data.content}
        onChange={(content: TiptapDoc) =>
          dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data: { content } } })
        }
      />
    </div>
  )
}
