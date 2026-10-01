'use client'

import { cn } from '@/lib/utils'
import type { ImageBlock } from '@/lib/validations/course-about'

interface Props {
  block: ImageBlock
}

export function ImageBlockPreview({ block }: Props) {
  if (!block.data.src) return null

  return (
    <figure className="space-y-2">
      <div className={cn(
        'flex',
        block.data.alignment === 'left' && 'justify-start',
        block.data.alignment === 'center' && 'justify-center',
        block.data.alignment === 'right' && 'justify-end',
      )}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={block.data.src}
          alt={block.data.alt}
          className="max-w-full max-h-[500px] rounded-lg object-contain"
        />
      </div>
      {block.data.caption && (
        <figcaption className="text-sm text-center text-muted-foreground">{block.data.caption}</figcaption>
      )}
    </figure>
  )
}
