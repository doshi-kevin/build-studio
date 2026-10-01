'use client'

import { Video } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { VideoBlock } from '@/lib/validations/course-about'
import { useBlockEditor } from '../../block-editor'
import { parseVideoUrl } from '../../block-editor/block-utils'

interface Props {
  block: VideoBlock
}

export function VideoBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()
  const { embedUrl, provider } = parseVideoUrl(block.data.url)

  const update = (data: Partial<VideoBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  return (
    <div className="space-y-3">
      <Input
        value={block.data.url}
        onChange={(e) => update({ url: e.target.value })}
        placeholder="Paste YouTube or Vimeo URL..."
        className="text-sm"
      />

      {embedUrl ? (
        <div className="aspect-video rounded-lg overflow-hidden bg-muted">
          <iframe
            src={embedUrl}
            title={block.data.caption || `${provider} video`}
            className="w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : block.data.url ? (
        <div className="flex flex-col items-center justify-center py-12 rounded-lg bg-muted/50 text-muted-foreground">
          <Video className="h-8 w-8 mb-2" />
          <p className="text-sm">Invalid video URL. Please paste a YouTube or Vimeo link.</p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 rounded-lg bg-muted/50 text-muted-foreground">
          <Video className="h-8 w-8 mb-2" />
          <p className="text-sm">Paste a video URL above to embed it</p>
        </div>
      )}

      <Input
        value={block.data.caption}
        onChange={(e) => update({ caption: e.target.value })}
        placeholder="Add a caption (optional)..."
        className="text-sm text-center text-muted-foreground border-none bg-transparent focus-visible:ring-0"
      />
    </div>
  )
}
