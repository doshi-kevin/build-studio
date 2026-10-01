// Hero block editor — collects the fields that appear in the masthead at the
// top of the about page (banner image, course title/subtitle, instructor &
// semester meta, optional intro video, optional button). Uses persistent
// labels so the prof always knows what each field is for, and avoids jargon
// like "CTA" — students don't see those terms either, so neither should the
// prof while editing.

'use client'

import { useRef, useState } from 'react'
import { ImageIcon, Upload, Loader2, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { HeroBlock } from '@/lib/validations/course-about'
import { cn } from '@/lib/utils'
import { CANVAS_FIELD, useBlockEditor, parseVideoUrl } from '../../block-editor'
import { uploadFile, deleteFile, MAX_FILE_SIZE, formatFileSize } from '@/lib/supabase/storage'

interface Props {
  block: HeroBlock
}

export function HeroBlockEditor({ block }: Props) {
  const { dispatch, sectionId } = useBlockEditor()
  const fileRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isUploadingCta, setIsUploadingCta] = useState(false)

  const update = (data: Partial<HeroBlock['data']>) => {
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
      const previousPath = block.data.bannerPath
      // sectionId must be the FIRST path segment so the course-materials read
      // policy (is_section_member(foldername[1])) permits createSignedUrl.
      const { data, error } = await uploadFile(file, `${sectionId}/about-banners`)
      if (error || !data) {
        toast.error(error || 'Upload failed — please try again')
        return
      }
      update({ bannerSrc: data.url, bannerPath: data.path, bannerAlt: file.name })
      /* Best-effort cleanup of the previously-uploaded banner so storage
         doesn't accumulate orphans on every replace. */
      if (previousPath) {
        deleteFile(previousPath).catch(() => undefined)
      }
    } finally {
      setIsUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const handleRemove = () => {
    const path = block.data.bannerPath
    update({ bannerSrc: '', bannerPath: undefined, bannerAlt: '' })
    if (path) deleteFile(path).catch(() => undefined)
  }

  /* The action button used to accept a URL only, so pointing it at a syllabus PDF
     meant hosting the PDF somewhere else first — the whole of pilot item 3. Same
     bucket and helper as the banner above; ctaFilePath records that we own the
     object so a replace can clean up the old one. */
  const ctaFileRef = useRef<HTMLInputElement>(null)

  const handleCtaFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`That file is ${formatFileSize(file.size)} — the limit is ${formatFileSize(MAX_FILE_SIZE)}`)
      e.target.value = ''
      return
    }
    setIsUploadingCta(true)
    try {
      const previousPath = block.data.ctaFilePath
      const { data, error } = await uploadFile(file, `${sectionId}/about-cta`)
      if (error || !data) {
        toast.error(error || 'Upload failed — please try again')
        return
      }
      update({
        ctaUrl: data.url,
        ctaFilePath: data.path,
        ctaFileName: file.name,
        // Give the button a sensible label if it hasn't got one yet, so a single
        // upload is enough to produce a working button.
        ctaText: block.data.ctaText || file.name.replace(/\.[^.]+$/, ''),
      })
      if (previousPath) void deleteFile(previousPath)
    } finally {
      setIsUploadingCta(false)
      e.target.value = ''
    }
  }

  const clearCtaFile = () => {
    const path = block.data.ctaFilePath
    update({ ctaUrl: '', ctaFilePath: undefined, ctaFileName: undefined })
    if (path) void deleteFile(path)
  }

  const videoInfo = parseVideoUrl(block.data.introVideoUrl)

  return (
    <div className="space-y-5">
      {/* Banner image */}
      <div>
        <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-2 block">
          Banner image (optional)
        </Label>
        {block.data.bannerSrc ? (
          <div className="relative rounded-2xl overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={block.data.bannerSrc}
              alt={block.data.bannerAlt}
              className="w-full h-48 object-cover"
            />
            {/* Same fixed scrim the student render applies, so the prof sees
                how their photo will actually read behind the white title. */}
            <div className="absolute inset-0 bg-black/45" />
            <div
              className="absolute inset-0"
              style={{ background: 'linear-gradient(to bottom, transparent 30%, rgba(0,0,0,0.7) 100%)' }}
            />
            <div className="absolute bottom-2 right-2 flex gap-1">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={isUploading}>
                {isUploading ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading</> : 'Replace'}
              </Button>
              <Button variant="secondary" size="sm" onClick={handleRemove} disabled={isUploading}>
                Remove
              </Button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 border-2 border-dashed border-border rounded-2xl bg-muted/30">
            <ImageIcon className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground mb-3">Students see a standard course banner until you upload your own photo</p>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} className="rounded-full" disabled={isUploading}>
              {isUploading ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading</> : <><Upload className="h-3.5 w-3.5 mr-1.5" />Upload image</>}
            </Button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          </div>
        )}
      </div>

      {/* Course title + subtitle */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Course title
          </Label>
          <Input
            value={block.data.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="e.g. Introduction to Machine Learning"
            className={cn('font-semibold text-base', CANVAS_FIELD)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Course code or short description
          </Label>
          <Input
            value={block.data.subtitle}
            onChange={(e) => update({ subtitle: e.target.value })}
            placeholder="e.g. CS-559 · A practical intro to ML"
            className={cn(CANVAS_FIELD)}
          />
        </div>

        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Instructor
          </Label>
          <Input
            value={block.data.instructor}
            onChange={(e) => update({ instructor: e.target.value })}
            placeholder="Your name"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Semester
          </Label>
          <Input
            value={block.data.semester}
            onChange={(e) => update({ semester: e.target.value })}
            placeholder="e.g. Fall 2026"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Credits
          </Label>
          <Input
            value={block.data.credits}
            onChange={(e) => update({ credits: e.target.value })}
            placeholder="e.g. 3 credits"
            className={cn(CANVAS_FIELD)}
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
            Course intro video (optional)
          </Label>
          <Input
            value={block.data.introVideoUrl}
            onChange={(e) => update({ introVideoUrl: e.target.value })}
            placeholder="Paste a YouTube or Vimeo link"
            className={cn(CANVAS_FIELD)}
          />
        </div>
      </div>

      {/* Optional button — used to be labelled "CTA"; now plain language */}
      <div>
        <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-1.5 block">
          Action button (optional)
        </Label>
        <p className="text-[11px] text-muted-foreground mb-2">
          Adds a button at the top of the page. Paste a link, or upload a file such as the syllabus PDF.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            value={block.data.ctaText}
            onChange={(e) => update({ ctaText: e.target.value })}
            placeholder="Button label (e.g. View syllabus)"
            className={cn(CANVAS_FIELD)}
          />
          {block.data.ctaFilePath ? (
            /* An uploaded file: show its NAME, never the storage URL — the
               professor picked "syllabus.pdf", not a signed link they can't read. */
            <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{block.data.ctaFileName || 'Uploaded file'}</span>
              <Button variant="ghost" size="sm" onClick={clearCtaFile} className="h-7 shrink-0">
                Remove
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                value={block.data.ctaUrl}
                onChange={(e) => update({ ctaUrl: e.target.value })}
                placeholder="Paste a link (https://…)"
                className={cn(CANVAS_FIELD)}
              />
              <input
                ref={ctaFileRef}
                type="file"
                className="hidden"
                onChange={handleCtaFile}
              />
              {/* "or upload" rather than a second field: link and file are the same
                  destination expressed two ways, not two separate settings. */}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={isUploadingCta}
                onClick={() => ctaFileRef.current?.click()}
              >
                {isUploadingCta ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading</>
                ) : (
                  <><Upload className="h-3.5 w-3.5 mr-1.5" />Upload</>
                )}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Video preview */}
      {videoInfo.embedUrl && (
        <div>
          <Label className="text-xs uppercase tracking-[0.15em] font-semibold text-muted-foreground mb-2 block">
            Video preview
          </Label>
          <div className="aspect-video rounded-2xl overflow-hidden bg-muted max-w-sm border border-border">
            <iframe
              src={videoInfo.embedUrl}
              title="Intro video"
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      )}
    </div>
  )
}
