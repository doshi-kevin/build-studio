'use client'

import type { TextBlock } from '@/lib/validations/course-about'
import { RichTextView } from '../../RichText'
import { isDocEmpty } from '../../block-editor'

interface Props {
  block: TextBlock
}

export function TextBlockPreview({ block }: Props) {
  if (isDocEmpty(block.data.content)) return null
  return <RichTextView value={block.data.content} />
}
