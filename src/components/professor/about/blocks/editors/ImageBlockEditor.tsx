// Image block editor — uploads files to Supabase Storage instead of stuffing
// base64 data URIs into the JSONB row. Falls back to the legacy base64 src
// for any pre-existing data so old pages still render.

'use client'

import { useRef, useState } from 'react'
import { ImageIcon, Upload, AlignLeft, AlignCenter, AlignRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ImageBlock } from '@/lib/validations/course-about'
import { useBlockEditor } from '../../block-editor'
import { uploadFile, deleteFile, MAX_FILE_SIZE, formatFileSize } from '@/lib/supabase/storage'

interface Props {
  block: ImageBlock
}

export function ImageBlockEditor({ block }: Props) {
  const { dispatch, sectionId } = useBlockEditor()
  const fileRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)

  const update = (data: Partial<ImageBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file')
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`Image is too large (${formatFileSize(file.size)}). Max ${formatFileSize(MAX_FILE_SIZE)}.`)
      return
    }

    setIsUploading(true)
    try {
      const previousPath = block.data.srcPath
      const { data, error } = await uploadFile(file, `about/${sectionId}/images`)
      if (error || !data) {
        toast.error(error || 'Upload failed — please try again')
        return
      }
      update({ src: data.url, srcPath: data.path, alt: file.name })
      if (previousPath) {
        deleteFile(previousPath).catch(() => undefined)
      }
    } finally {
      setIsUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (!block.data.src) {
    return (
      <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-border rounded-lg">
        <ImageIcon className="h-10 w-10 text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground mb-3">Upload an image</p>
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={isUploading}>
          {isUploading ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading</> : <><Upload className="h-3.5 w-3.5 mr-1.5" />Choose File</>}
        </Button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Alignment controls */}
      <div className="flex items-center gap-1">
        {(['left', 'center', 'right'] as const).map((align) => {
          const icons = { left: AlignLeft, center: AlignCenter, right: AlignRight }
          const Icon = icons[align]
          return (
            <Button
              key={align}
              variant={block.data.alignment === align ? 'default' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={() => update({ alignment: align })}
            >
              <Icon className="h-3.5 w-3.5" />
            </Button>
          )
        })}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={isUploading}>
          {isUploading ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading</> : 'Replace'}
        </Button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
      </div>

      {/* Image preview */}
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
          className="max-w-full max-h-[400px] rounded-lg object-contain"
        />
      </div>

      {/* Caption */}
      <Input
        value={block.data.caption}
        onChange={(e) => update({ caption: e.target.value })}
        placeholder="Add a caption..."
        className="text-sm text-center text-muted-foreground border-none bg-transparent focus-visible:ring-0"
      />
    </div>
  )
}
