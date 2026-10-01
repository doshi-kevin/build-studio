'use client'

import type { VideoBlock } from '@/lib/validations/course-about'
import { parseVideoUrl } from '../../block-editor/block-utils'

interface Props {
  block: VideoBlock
}

export function VideoBlockPreview({ block }: Props) {
  const { embedUrl, provider } = parseVideoUrl(block.data.url)
  if (!embedUrl) return null

  return (
    <figure className="space-y-2">
      <div className="aspect-video rounded-lg overflow-hidden bg-muted">
        <iframe
          src={embedUrl}
          title={block.data.caption || `${provider} video`}
          className="w-full h-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
      {block.data.caption && (
        <figcaption className="text-sm text-center text-muted-foreground">{block.data.caption}</figcaption>
      )}
    </figure>
  )
}
