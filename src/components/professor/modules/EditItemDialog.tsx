/**
 * EditItemDialog — dialog for creating/editing module items.
 *
 * Shows common fields (title, description, visibility, instructor note)
 * plus type-specific fields rendered conditionally.
 * Includes file upload for lecture, video, and reference types.
 *
 * Type: Client Component
 */
'use client'

import { useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { FileUpload } from '@/components/ui/file-upload'
import {
  createModuleItem,
  updateModuleItem,
  extractDocumentContent,
  enqueueExtractionJobAction,
  isExtractionV2Enabled,
} from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'
import { createModuleItemSchema, type CreateModuleItemInput, type ModuleItemType } from '@/lib/validations/module'
import { detectVideoProvider, detectReferenceType, extractVenue } from '@/lib/modules/url-classify'
import { isSupportedFileType } from '@/lib/document-parser/utils'
import { ACCEPTED_FILE_TYPES, inferLectureFileType, type UploadResult } from '@/lib/supabase/storage'
import { syncFileToWarehouse } from '@/lib/warehouse/sync'
import { PickFromLibraryDialog } from './PickFromLibraryDialog'
import { Library, Presentation, Youtube, Video, Link2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WarehouseFile, FileType } from '@/lib/validations/warehouse'
import type { ModuleItem } from '@/lib/supabase/types'

interface EditItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  moduleId: string
  itemType: ModuleItemType
  item?: ModuleItem | null
}

/** Human labels for the detected lecture file format (read-only display). */
const LECTURE_FORMAT_LABELS: Record<string, string> = {
  pdf: 'PDF',
  ppt: 'PowerPoint',
  docx: 'Word',
  xlsx: 'Excel',
  image: 'Image',
  notes: 'Notes / text',
}

/**
 * Returns default content values per item type.
 * All string fields initialized to '' to prevent uncontrolled→controlled warnings.
 */
function getDefaultContent(type: ModuleItemType): Record<string, unknown> {
  switch (type) {
    case 'lecture':
      return { fileType: 'pdf', fileName: '', fileSize: '', fileUrl: '', filePath: '', useAsSlides: false }
    case 'video':
      // provider + duration are derived (from the URL / uploaded file), not
      // user-entered — kept in content but never surfaced as form fields.
      return { videoUrl: '', duration: null, provider: '', fileUrl: '', filePath: '' }
    case 'image':
      return { fileUrl: '', filePath: '', fileName: '', fileSize: '', alt: '' }
    case 'reference':
      return { url: '', referenceType: 'link', fileUrl: '', filePath: '' }
    case 'assignment':
      return { dueDate: '', points: null }
    case 'note':
      return { body: '' }
    case 'link':
      return { url: '' }
    case 'section_divider':
      return { label: '' }
    default:
      return {}
  }
}

export function EditItemDialog({
  open,
  onOpenChange,
  sectionId,
  moduleId,
  itemType,
  item,
}: EditItemDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const isEditMode = !!item

  const effectiveType = (item?.item_type as ModuleItemType) || itemType

  // Merge defaults with existing content so every field is initialized
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existingContent = (item?.content || {}) as Record<string, any>
  const mergedContent = { ...getDefaultContent(effectiveType), ...existingContent }

  const form = useForm<CreateModuleItemInput>({
    resolver: zodResolver(createModuleItemSchema),
    defaultValues: {
      item_type: effectiveType,
      title: item?.title || '',
      description: item?.description || '',
      is_visible: item?.is_visible ?? true,
      instructor_note: item?.instructor_note || '',
      content: mergedContent,
    },
  })

  const onSubmit = async (data: CreateModuleItemInput) => {
    // Synchronous guard — `disabled={isSubmitting}` only takes effect a render later,
    // so without this a fast second submit creates a duplicate item (and, for lectures,
    // a second extraction job). See CreateModuleDialog.
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    try {
      const result = isEditMode
        ? await updateModuleItem(item!.id, moduleId, sectionId, data)
        : await createModuleItem(moduleId, sectionId, data)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      // Document extraction for PDF/PPT lectures. V2 enqueues into a
      // durable Postgres-backed queue and kicks the worker; V1 is the
      // legacy fire-and-forget path. Flag-gated so we can flip per
      // environment without a redeploy.
      const fileType = (data.content?.fileType as string) || ''
      if (data.item_type === 'lecture' && isSupportedFileType(fileType)) {
        const itemId = !isEditMode
          ? (result as { moduleItemId?: string }).moduleItemId
          : item?.id

        // On create: extract immediately; on edit: re-extract if file changed
        const shouldExtract = !isEditMode
          ? !!itemId
          : !!(data.content?.filePath && data.content.filePath !== existingContent.filePath)

        if (shouldExtract && itemId) {
          const v2 = await isExtractionV2Enabled()
          if (v2) {
            enqueueExtractionJobAction(itemId, sectionId)
          } else {
            extractDocumentContent(itemId, sectionId).catch(() => {})
          }
        }
      }

      toast.success(isEditMode ? 'Item updated' : 'Item added')
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const currentType = form.watch('item_type')
  const typeLabel = TYPE_LABELS[currentType] || 'Item'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? `Edit ${typeLabel}` : `Add ${typeLabel}`}</DialogTitle>
          <DialogDescription>
            {isEditMode ? `Update the ${typeLabel.toLowerCase()} details.` : `Add a new ${typeLabel.toLowerCase()} to this module.`}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Title — skip for section divider (use content.label instead) */}
            {currentType !== 'section_divider' && (
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder={getPlaceholder(currentType)} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Description — skip for section divider and note */}
            {currentType !== 'section_divider' && currentType !== 'note' && (
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Brief description..."
                        className="resize-none"
                        rows={2}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Type-specific fields */}
            <TypeSpecificFields
              type={currentType}
              form={form}
              sectionId={sectionId}
              moduleId={moduleId}
            />

            {/* Visibility + Instructor Note — skip for section divider */}
            {currentType !== 'section_divider' && (
              <>
                <FormField
                  control={form.control}
                  name="is_visible"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className="mt-0! cursor-pointer">Visible to students</FormLabel>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="instructor_note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Instructor Note
                        <span className="text-xs text-muted-foreground ml-1">(private)</span>
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Private note for yourself..."
                          className="resize-none bg-warning-muted border-warning/30"
                          rows={2}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? (isEditMode ? 'Updating…' : 'Adding…')
                  : (isEditMode ? `Update ${typeLabel}` : `Add ${typeLabel}`)}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ── Type-specific fields ─────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  lecture: 'Lecture Material',
  video: 'Video',
  image: 'Image',
  reference: 'Reference',
  assignment: 'Assignment',
  note: 'Note',
  link: 'Link',
  section_divider: 'Section Divider',
}

/** Read an image file's natural pixel size, client-side. */
function probeImageSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new window.Image()
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Read a video file's length (rounded minutes) from its metadata, client-side. */
function probeVideoDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      const secs = v.duration
      resolve(isFinite(secs) && secs > 0 ? Math.max(1, Math.round(secs / 60)) : null)
    }
    v.onerror = () => resolve(null)
    v.src = url
  })
}

function getPlaceholder(type: string): string {
  switch (type) {
    case 'lecture': return 'Chapter 3 — Sorting Algorithms'
    case 'video': return 'Lecture Recording: Week 3'
    case 'image': return 'Diagram: Transformer Architecture'
    case 'reference': return 'Additional Reading: Design Patterns'
    case 'assignment': return 'Homework 2: Data Structures'
    case 'note': return 'Quick note for students'
    case 'link': return 'Course Resources Portal'
    default: return 'Item title'
  }
}

/** Map module item types to acceptable library file types for the picker */
function getLibraryFileTypes(itemType: string): FileType[] | undefined {
  switch (itemType) {
    case 'lecture': return ['pdf', 'ppt', 'image', 'doc']
    case 'video': return ['video']
    case 'image': return ['image']
    default: return undefined
  }
}

function TypeSpecificFields({ type, form, sectionId, moduleId }: {
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: any
  sectionId: string
  moduleId: string
}) {
  const folder = `${sectionId}/${moduleId}`
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)

  /** Handle file upload result — set fileUrl, filePath, fileName, fileSize in form content */
  const handleFileUpload = (result: UploadResult) => {
    form.setValue('content.fileUrl', result.url, { shouldDirty: true })
    form.setValue('content.filePath', result.path, { shouldDirty: true })
    form.setValue('content.fileName', result.fileName, { shouldDirty: true })
    form.setValue('content.fileSize', String(result.fileSize), { shouldDirty: true })
    // Format is the file's own property — infer it from the name rather than
    // trusting a dropdown the professor might forget to change (lecture only).
    if (type === 'lecture') {
      form.setValue('content.fileType', inferLectureFileType(result.fileName), { shouldDirty: true })
    }
    // An uploaded video file has no URL — its provider is 'upload'. Read its
    // length from the file's own metadata (client-side) so duration is never
    // hand-entered.
    if (type === 'video') {
      form.setValue('content.provider', 'upload', { shouldDirty: true })
      void probeVideoDuration(result.url).then((mins) => {
        if (mins != null) form.setValue('content.duration', mins, { shouldDirty: true })
      })
    }
    // Read the image's pixel size so its node can show the "W×H" badge.
    if (type === 'image') {
      void probeImageSize(result.url).then((d) => {
        if (d) {
          form.setValue('content.width', d.w, { shouldDirty: true })
          form.setValue('content.height', d.h, { shouldDirty: true })
        }
      })
    }

    // Auto-sync to warehouse (library) — sectionId maps to warehouse courseId
    syncFileToWarehouse({
      uploadResult: result,
      courseId: sectionId,
      itemType: type,
    })
  }

  const handleFileRemove = () => {
    form.setValue('content.fileUrl', '', { shouldDirty: true })
    form.setValue('content.filePath', '', { shouldDirty: true })
    form.setValue('content.fileName', '', { shouldDirty: true })
    form.setValue('content.fileSize', '', { shouldDirty: true })
  }

  /** Handle picking a file from the library */
  const handleLibraryPick = (warehouseFile: WarehouseFile) => {
    if (warehouseFile.fileUrl) {
      form.setValue('content.fileUrl', warehouseFile.fileUrl, { shouldDirty: true })
      form.setValue('content.filePath', warehouseFile.filePath ?? '', { shouldDirty: true })
      form.setValue('content.fileName', warehouseFile.name, { shouldDirty: true })
      form.setValue('content.fileSize', String(warehouseFile.size), { shouldDirty: true })
      if (type === 'lecture') {
        form.setValue('content.fileType', inferLectureFileType(warehouseFile.name), { shouldDirty: true })
      }
      if (type === 'video') {
        form.setValue('content.provider', 'upload', { shouldDirty: true })
      }
      if (type === 'image' && warehouseFile.fileUrl) {
        void probeImageSize(warehouseFile.fileUrl).then((d) => {
          if (d) {
            form.setValue('content.width', d.w, { shouldDirty: true })
            form.setValue('content.height', d.h, { shouldDirty: true })
          }
        })
      }

      // Pre-fill title if empty
      const currentTitle = form.getValues('title')
      if (!currentTitle) {
        const nameWithoutExt = warehouseFile.name.replace(/\.[^/.]+$/, '')
        form.setValue('title', nameWithoutExt, { shouldDirty: true })
      }
    }
  }

  // Build existing file info from form state for FileUpload
  const contentFileUrl = form.watch('content.fileUrl')
  const contentFileName = form.watch('content.fileName')
  const contentFileSize = form.watch('content.fileSize')
  const contentFileType = form.watch('content.fileType') as string | undefined
  const contentVideoUrl = form.watch('content.videoUrl') as string | undefined
  const existingFile = contentFileUrl
    ? { url: contentFileUrl, fileName: contentFileName || 'Uploaded file', fileSize: Number(contentFileSize) || 0 }
    : null

  switch (type) {
    case 'lecture':
      return (
        <div className="space-y-4">
          {/* Slide-deck flag — the one attribute that sets a classroom deck apart
              from a plain upload. Given a subtle accent card so it reads as a
              deliberate choice, not just another checkbox. */}
          <FormField
            control={form.control}
            name="content.useAsSlides"
            render={({ field }: { field: { value?: boolean; onChange: (v: boolean) => void } }) => (
              <FormItem className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <FormControl>
                  <Checkbox checked={!!field.value} onCheckedChange={field.onChange} className="mt-0.5" />
                </FormControl>
                <div className="space-y-0.5">
                  <FormLabel className="mt-0! flex items-center gap-1.5 cursor-pointer">
                    <Presentation className="h-4 w-4 text-primary" />
                    Use as classroom slides
                  </FormLabel>
                  <p className="text-xs text-muted-foreground">
                    Present this deck in the live classroom and walk through it slide by slide in class.
                  </p>
                </div>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="content.fileName"
            render={({ field }: { field: React.ComponentProps<typeof Input> }) => (
              <FormItem>
                <FormLabel>File Name</FormLabel>
                <FormControl>
                  <Input placeholder="lecture-3.pdf" {...field} value={field.value ?? ''} />
                </FormControl>
                {/* Format is detected from the file — no dropdown to keep in sync.
                    Only shown once a real file exists (not for the 'pdf' default),
                    and the 'notes' catch-all reads as "won't be extracted", not a format. */}
                {contentFileName && contentFileType && (
                  <p className="text-xs text-muted-foreground">
                    {contentFileType === 'notes'
                      ? 'No structured extraction for this file type — it will be imported as plain text only.'
                      : `Detected format: ${LECTURE_FORMAT_LABELS[contentFileType] ?? contentFileType}`}
                  </p>
                )}
              </FormItem>
            )}
          />
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">Upload File</p>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLibraryPickerOpen(true)}>
                <Library className="h-3.5 w-3.5 mr-1" />
                From Library
              </Button>
            </div>
            <FileUpload
              folder={folder}
              accept={ACCEPTED_FILE_TYPES.lecture}
              onUpload={handleFileUpload}
              onRemove={handleFileRemove}
              existingFile={existingFile}
            />
          </div>
          <PickFromLibraryDialog
            open={libraryPickerOpen}
            onOpenChange={setLibraryPickerOpen}
            acceptFileTypes={getLibraryFileTypes(type)}
            onPick={handleLibraryPick}
          />
        </div>
      )

    case 'video': {
      // One control, two paths: upload a file OR paste a link. Provider is
      // derived from the URL (or "upload" for a file); duration is detected
      // downstream — neither is a manual field anymore.
      const videoUrl = (contentVideoUrl || '').trim()
      const hasFile = !!existingFile
      const provider = videoUrl ? detectVideoProvider(videoUrl) : null
      const ProviderIcon = provider === 'youtube' ? Youtube : provider === 'vimeo' ? Video : Link2
      const providerLabel = provider === 'youtube' ? 'YouTube' : provider === 'vimeo' ? 'Vimeo' : 'Link'

      const clearUrl = () => {
        form.setValue('content.videoUrl', '', { shouldDirty: true })
        form.setValue('content.provider', '', { shouldDirty: true })
      }

      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Video</p>
            {!videoUrl && !hasFile && (
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLibraryPickerOpen(true)}>
                <Library className="h-3.5 w-3.5 mr-1" />
                From Library
              </Button>
            )}
          </div>

          {hasFile ? (
            // An uploaded file — FileUpload owns its own preview + remove.
            <FileUpload
              folder={folder}
              accept={ACCEPTED_FILE_TYPES.video}
              onUpload={handleFileUpload}
              onRemove={handleFileRemove}
              existingFile={existingFile}
            />
          ) : (
            // One box: a drop zone up top, a paste-a-link row pinned inside it.
            // Typing a link hides the drop zone (you've chosen the link path);
            // the input stays mounted so typing is never interrupted.
            <div className="overflow-hidden rounded-xl border transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring">
              {!videoUrl && (
                <div className="p-3">
                  <FileUpload
                    folder={folder}
                    accept={ACCEPTED_FILE_TYPES.video}
                    onUpload={handleFileUpload}
                    onRemove={handleFileRemove}
                    existingFile={null}
                  />
                </div>
              )}
              <div className={cn('flex items-center gap-2 px-3 py-2.5', !videoUrl && 'border-t bg-muted/20')}>
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {videoUrl ? 'Link' : 'or paste a link'}
                </span>
                <Input
                  placeholder="YouTube or Vimeo URL"
                  value={contentVideoUrl ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    form.setValue('content.videoUrl', v, { shouldDirty: true })
                    form.setValue('content.provider', v.trim() ? detectVideoProvider(v) : '', { shouldDirty: true })
                  }}
                  className="h-8 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
                {videoUrl && (
                  <>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      <ProviderIcon className="h-3 w-3" />
                      {providerLabel}
                    </span>
                    <button
                      type="button"
                      onClick={clearUrl}
                      aria-label="Remove link"
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Paste a link or upload a file — the source and length are detected automatically.
          </p>

          <PickFromLibraryDialog
            open={libraryPickerOpen}
            onOpenChange={setLibraryPickerOpen}
            acceptFileTypes={getLibraryFileTypes(type)}
            onPick={handleLibraryPick}
          />
        </div>
      )
    }

    case 'image':
      return (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">Upload Image</p>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLibraryPickerOpen(true)}>
                <Library className="h-3.5 w-3.5 mr-1" />
                From Library
              </Button>
            </div>
            <FileUpload
              folder={folder}
              accept={ACCEPTED_FILE_TYPES.image}
              onUpload={handleFileUpload}
              onRemove={handleFileRemove}
              existingFile={existingFile}
            />
          </div>
          <FormField
            control={form.control}
            name="content.alt"
            render={({ field }: { field: React.ComponentProps<typeof Input> }) => (
              <FormItem>
                <FormLabel>
                  Alt text
                  <span className="text-xs text-muted-foreground ml-1">(for screen readers)</span>
                </FormLabel>
                <FormControl>
                  <Input placeholder="Describe the image…" {...field} value={field.value ?? ''} />
                </FormControl>
              </FormItem>
            )}
          />
          <PickFromLibraryDialog
            open={libraryPickerOpen}
            onOpenChange={setLibraryPickerOpen}
            acceptFileTypes={getLibraryFileTypes(type)}
            onPick={handleLibraryPick}
          />
        </div>
      )

    // 'link' is dissolved into Reference (a link is a subset) — existing link
    // items still edit here; new links are added as References.
    // Reference is just a URL — no upload, no type dropdown. The type
    // (paper / reading / link) is classified from the URL on save.
    case 'reference':
    case 'link':
      return (
        <FormField
          control={form.control}
          name="content.url"
          render={({ field }: { field: React.ComponentProps<typeof Input> }) => (
            <FormItem>
              <FormLabel>URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://..."
                  {...field}
                  value={field.value ?? ''}
                  onChange={(e) => {
                    field.onChange?.(e)
                    const v = e.target.value.trim()
                    const rt = v ? detectReferenceType(v) : 'link'
                    form.setValue('content.referenceType', rt, { shouldDirty: true })
                    // Venue only applies to papers; clear it otherwise.
                    const ven = rt === 'paper' ? extractVenue(v) : null
                    form.setValue('content.venue', ven?.venue ?? '', { shouldDirty: true })
                    form.setValue('content.venueId', ven?.venueId ?? '', { shouldDirty: true })
                  }}
                />
              </FormControl>
            </FormItem>
          )}
        />
      )

    case 'assignment':
      return (
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="content.dueDate"
            render={({ field }: { field: React.ComponentProps<typeof Input> }) => (
              <FormItem>
                <FormLabel>Due Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} value={field.value ?? ''} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="content.points"
            render={({ field }: { field: React.ComponentProps<typeof Input> }) => (
              <FormItem>
                <FormLabel>Points</FormLabel>
                <FormControl>
                  <Input type="number" min={0} placeholder="100" {...field} value={field.value ?? ''} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
      )

    case 'note':
      return (
        <FormField
          control={form.control}
          name="content.body"
          render={({ field }: { field: React.ComponentProps<typeof Textarea> }) => (
            <FormItem>
              <FormLabel>Note Content</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Note visible to students..."
                  className="resize-none"
                  rows={4}
                  {...field}
                  value={field.value ?? ''}
                />
              </FormControl>
            </FormItem>
          )}
        />
      )

    case 'section_divider':
      return (
        <FormField
          control={form.control}
          name="content.label"
          render={({ field }: { field: React.ComponentProps<typeof Input> }) => (
            <FormItem>
              <FormLabel>Section Label</FormLabel>
              <FormControl>
                <Input placeholder="Pre-Class Reading" {...field} value={field.value ?? ''} />
              </FormControl>
            </FormItem>
          )}
        />
      )

    default:
      return null
  }
}
