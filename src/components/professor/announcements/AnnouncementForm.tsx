/**
 * AnnouncementForm — create/edit form for announcements.
 *
 * Uses react-hook-form + zod resolver. Works in create and edit modes.
 * Supports file attachments, external links, scheduling, visibility,
 * reactions/comments toggles, and rich text (via AnnouncementEditor).
 *
 * Type: Client Component
 */
'use client'

import { useState, useCallback, useRef } from 'react'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import {
  Plus, X, Paperclip, Link as LinkIcon, ExternalLink,
  Calendar, Users, MessageSquare, Smile, Star, CheckCircle2, Copy, Bot, Loader2,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Checkbox } from '@/components/ui/checkbox'
import { FileUpload } from '@/components/ui/file-upload'
import { AnnouncementEditor } from './AnnouncementEditor'
import { StudentPicker } from './StudentPicker'
import {
  createAnnouncement,
  updateAnnouncement,
  rewriteAnnouncementContent,
} from '@/app/(dashboard)/professor/courses/[sectionId]/announcements/actions'
import {
  createAnnouncementSchema,
  type CreateAnnouncementInput,
  type AnnouncementAttachment,
  type AnnouncementLink,
} from '@/lib/validations/announcement'
import { ACCEPTED_FILE_TYPES, type UploadResult } from '@/lib/supabase/storage'
import { extractPlainText, plainTextToJsonContent } from '@/lib/tiptap-utils'
import type { Json } from '@/lib/supabase/types'
import type { CourseItem } from '@/lib/tiptap/course-mention-extension'
import { toLocalDateTimeInput, fromLocalDateTimeInput } from '@/lib/datetime'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JSONContent = any

interface EnrolledStudent {
  id: string
  name: string | null
  email: string
}

interface PostableSection {
  id: string
  label: string
  sublabel?: string
}

interface AnnouncementFormProps {
  sectionId: string
  announcement?: {
    id: string
    title: string
    content: string
    rich_content?: Json | null
    is_pinned: boolean
    is_important?: boolean
    requires_acknowledgement?: boolean
    status: string
    scheduled_at?: string | null
    visibility?: string
    allow_reactions?: boolean
    allow_comments?: boolean
    attachments?: AnnouncementAttachment[]
    links?: AnnouncementLink[]
    /** Existing recipients, so an edit opens showing who it is aimed at (#666). */
    mentioned_student_ids?: string[]
  } | null
  enrolledStudents?: EnrolledStudent[]
  courseItems?: CourseItem[]
  otherSections?: PostableSection[]
  /** True when editing an announcement that is part of a multi-section group. */
  isGrouped?: boolean
  onSuccess?: () => void
  onCancel?: () => void
  basePath?: string
}

/* The FORM's shape is not the server's shape, and conflating them broke every
   announcement.

   `scheduled_at` in the form is whatever a datetime-local input holds: '' when
   unset, or an offset-less local wall-clock like '2026-08-27T10:30'.
   createAnnouncementSchema deliberately demands an ABSOLUTE instant
   (.datetime({offset:true})) because that is the server contract, and onSubmit
   converts with fromLocalDateTimeInput before sending. Using the strict schema as
   the RESOLVER validated the value before that conversion, so '' and every local
   string failed — and because the scheduled_at input only renders while status ===
   'scheduled', there was nowhere for the message to appear. Result: Publish and
   Update did nothing at all, silently, for drafts and published posts alike.

   So the resolver validates the form shape and the server keeps its strict
   contract. The scheduled case is still required — just checked here, where the
   field the professor can actually see is the one that gets the error. */
const announcementFormSchema = createAnnouncementSchema
  .extend({ scheduled_at: z.string().optional().nullable() })
  .superRefine((data, ctx) => {
    if (data.status === 'scheduled' && !data.scheduled_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduled_at'],
        message: 'Pick when this should publish.',
      })
    }
  })

export function AnnouncementForm({ sectionId, announcement, enrolledStudents, courseItems, otherSections = [], isGrouped = false, onSuccess, onCancel, basePath }: AnnouncementFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isRewriting, setIsRewriting] = useState(false)
  // Bumped to remount the (uncontrolled) editor with fresh content after a
  // rewrite / undo — Novel only reads initialContent at mount.
  const [editorKey, setEditorKey] = useState(0)
  /* Holds the pre-rewrite content while the rewrite is UNRESOLVED, i.e. the
     professor has neither accepted nor rejected it yet. Non-null = a decision is
     pending. Renders INLINE in the form, not as a toast — a toast sits behind the
     dialog overlay here and its buttons aren't clickable.
     Accept/Reject rather than Undo: that is how coding assistants (Copilot,
     Cursor) present a proposed edit — two explicit, equally-weighted actions
     next to the change, so neither outcome is the silent default. */
  const [preRewriteContent, setPreRewriteContent] = useState<JSONContent | null>(null)
  /* Seeded from the announcement's existing mentions so reopening a targeted
     announcement shows its current recipients rather than an empty picker (#666). */
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>(
    announcement?.mentioned_student_ids ?? [],
  )
  // Multi-section posting (create only): which other sections to also post to.
  const [selectedSectionIds, setSelectedSectionIds] = useState<string[]>([])
  // Edit-sync confirm dialog: holds the validated payload awaiting a scope choice.
  const [pendingPayload, setPendingPayload] = useState<CreateAnnouncementInput | null>(null)
  const isEditMode = !!announcement

  // Rich content state (managed outside react-hook-form because JSONContent is complex)
  const richContentRef = useRef<JSONContent>(
    announcement?.rich_content
      ? (announcement.rich_content as JSONContent)
      : announcement?.content
        ? plainTextToJsonContent(announcement.content)
        : null
  )

  // Parse existing attachments/links from DB (stored as Json)
  const existingAttachments = (Array.isArray(announcement?.attachments) ? announcement.attachments : []) as AnnouncementAttachment[]
  const existingLinks = (Array.isArray(announcement?.links) ? announcement.links : []) as AnnouncementLink[]

  const form = useForm<CreateAnnouncementInput>({
    /* Drop fully-blank link rows BEFORE validation (#669). onSubmit already filtered
       them, but zodResolver runs first, so one empty row failed "URL is required" and
       blocked the entire save — title, body and every valid link with it — until the
       professor spotted the row and removed it. An empty optional row is an unfinished
       thought, not an error. A row with a label but no URL is still rejected: that one
       IS a mistake worth reporting. */
    resolver: ((values: CreateAnnouncementInput, ctx: unknown, options: unknown) => {
      const cleaned = {
        ...values,
        links: (values.links ?? []).filter(
          (l) => (l?.url ?? '').trim() !== '' || (l?.label ?? '').trim() !== '',
        ),
      }
      return (zodResolver(announcementFormSchema) as never as (
        v: unknown,
        c: unknown,
        o: unknown,
      ) => unknown)(cleaned, ctx, options)
    }) as never,
    defaultValues: {
      title: announcement?.title || '',
      content: announcement?.content || '',
      is_pinned: announcement?.is_pinned ?? false,
      is_important: announcement?.is_important ?? false,
      requires_acknowledgement: announcement?.requires_acknowledgement ?? false,
      status: (announcement?.status as 'draft' | 'published' | 'scheduled') || 'published',
      /* A timestamptz fed straight to <input type="datetime-local"> is rejected
         by the browser, so the field rendered EMPTY on every edit of a scheduled
         announcement and read as "the schedule was lost". */
      scheduled_at: toLocalDateTimeInput(announcement?.scheduled_at),
      visibility: (announcement?.visibility as 'all' | 'mentioned_only') || 'all',
      allow_reactions: announcement?.allow_reactions ?? false,
      allow_comments: announcement?.allow_comments ?? false,
      attachments: existingAttachments,
      links: existingLinks,
    },
  })

  const watchStatus = form.watch('status')
  const watchVisibility = form.watch('visibility')
  const watchImportant = form.watch('is_important')
  const canPostToOtherSections = !isEditMode && otherSections.length > 0 && watchVisibility !== 'mentioned_only'

  const { fields: attachmentFields, append: appendAttachment, remove: removeAttachment } = useFieldArray({
    control: form.control,
    name: 'attachments',
  })

  const { fields: linkFields, append: appendLink, remove: removeLink } = useFieldArray({
    control: form.control,
    name: 'links',
  })

  const handleFileUpload = useCallback((result: UploadResult) => {
    appendAttachment({
      fileName: result.fileName,
      fileSize: result.fileSize,
      fileUrl: result.url,
      filePath: result.path,
      mimeType: result.mimeType,
    })
  }, [appendAttachment])

  const handleAddLink = useCallback(() => {
    appendLink({ url: '', label: '' })
  }, [appendLink])

  const handleEditorChange = useCallback((json: JSONContent) => {
    richContentRef.current = json
  }, [])

  // "Rewrite with Athena": polish the current draft prose. Replaces the editor
  // content (remount via editorKey) and leaves the rewrite pending an explicit
  // Accept/Reject — plain text in/out, so any rich formatting or @-mentions in
  // the body are not preserved.
  const handleRewrite = useCallback(async () => {
    const current = extractPlainText(richContentRef.current)
    if (!current.trim()) {
      toast.error('Add a few words and Athena will polish them for you.')
      return
    }
    setIsRewriting(true)
    try {
      const result = await rewriteAnnouncementContent(sectionId, { content: current })
      if (result.error || !result.text) {
        toast.error(result.error || 'Could not rewrite. Please try again.')
        return
      }
      const previous = richContentRef.current
      richContentRef.current = plainTextToJsonContent(result.text)
      setEditorKey((k) => k + 1)
      // Leaves the decision pending — see preRewriteContent.
      setPreRewriteContent(previous)
    } catch {
      toast.error('Could not rewrite. Please try again.')
    } finally {
      setIsRewriting(false)
    }
  }, [sectionId])

  /** Reject: put the professor's own words back and clear the pending state. */
  const handleRejectRewrite = useCallback(() => {
    setPreRewriteContent((previous: JSONContent | null) => {
      richContentRef.current = previous
      setEditorKey((k) => k + 1)
      return null
    })
  }, [])

  /** Accept: keep what Athena wrote. Only drops the pre-rewrite copy, because the
   *  editor already holds the rewrite — so this must never touch richContentRef. */
  const handleAcceptRewrite = useCallback(() => {
    setPreRewriteContent(null)
  }, [])

  /** Validation rejected the form. Say so — and name the field, since the offender
   *  may be one the professor can't see. */
  const onInvalid = (errors: Record<string, { message?: string }>) => {
    const first = Object.entries(errors)[0]
    const detail = first?.[1]?.message
    toast.error(detail ? `Can't save yet — ${detail}` : "Can't save yet — please check the form.")
    logger.warn('AnnouncementForm.onInvalid', { fields: Object.keys(errors) })
  }

  // Send the payload to the server. `syncScope` only applies when editing a
  // multi-section group ('all' propagates content to sibling copies).
  const submitPayload = async (payload: CreateAnnouncementInput, syncScope?: 'this' | 'all') => {
    setIsSubmitting(true)
    try {
      const result = isEditMode
        ? await updateAnnouncement(announcement!.id, sectionId, { ...payload, sync_scope: syncScope })
        : await createAnnouncement(sectionId, payload)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success(isEditMode ? 'Announcement updated' : 'Announcement created')
      onSuccess?.()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
      setPendingPayload(null)
    }
  }

  const onSubmit = async (data: CreateAnnouncementInput) => {
    // Filter out empty links
    const cleanedLinks = (data.links || []).filter((l) => l.url.trim() !== '')

    // Extract plain text from rich content
    const rawRichContent = richContentRef.current
    // ProseMirror uses Object.create(null) for attrs, which Next.js Server Actions
    // strip during network serialization. We must deep clone to a plain object first.
    const richContent = rawRichContent ? JSON.parse(JSON.stringify(rawRichContent)) : null
    const plainText = rawRichContent ? extractPlainText(rawRichContent) : data.content || ''

    // Validate student selection when mentioned_only
    if (data.visibility === 'mentioned_only' && selectedStudentIds.length === 0) {
      toast.error('Please select at least one student when using "Selected students only" visibility.')
      return
    }

    const payload: CreateAnnouncementInput = {
      ...data,
      content: plainText,
      rich_content: richContent,
      /* The field's value is local wall-clock with no offset; Postgres reads such
         a string as UTC, so a 10:30 typed in New York was stored as 10:30Z and
         the auto-publish sweep fired four hours early. Convert to an absolute
         instant here — the browser is the only place the offset is known. */
      scheduled_at:
        data.status === 'scheduled' ? fromLocalDateTimeInput(data.scheduled_at) : null,
      links: cleanedLinks,
      mentioned_student_ids: selectedStudentIds.length > 0 ? selectedStudentIds : undefined,
      additional_section_ids: canPostToOtherSections && selectedSectionIds.length > 0 ? selectedSectionIds : undefined,
    }

    // Editing a multi-section group: ask whether to apply to all sections first.
    if (isEditMode && isGrouped) {
      setPendingPayload(payload)
      return
    }

    await submitPayload(payload)
  }

  return (
    <Form {...form}>
      {/* onInvalid is not optional garnish: without it react-hook-form swallows a
          resolver rejection, and a field whose input isn't rendered (scheduled_at
          outside 'scheduled') has nowhere to show a message — which is exactly how
          a dead Publish button went unnoticed. Surface it. */}
      <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title *</FormLabel>
              <FormControl>
                <Input placeholder="Week 3 Update" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Rich Text Editor */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm font-medium">Content</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRewrite}
                    disabled={isRewriting || isSubmitting}
                    className="h-7 min-w-[9.5rem] text-xs text-muted-foreground hover:text-foreground"
                  >
                    {isRewriting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Bot className="h-3.5 w-3.5" />
                    )}
                    {isRewriting ? 'Rewriting…' : 'Rewrite with Athena'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Polishes clarity and tone. Works on plain text — formatting and linked items are removed.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <AnnouncementEditor
            key={editorKey}
            initialContent={richContentRef.current}
            onChange={handleEditorChange}
            courseItems={courseItems}
            sectionId={sectionId}
            basePath={basePath}
          />
          {preRewriteContent !== null && (
            /* role=status: the bar appears after an async action that moves no
               focus, so without it a screen-reader user is never told a rewrite
               is waiting on them. */
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/40 px-3 py-1.5 text-xs"
            >
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Bot className="h-3 w-3" />
                Athena rewrote this — keep it?
              </span>
              {/* Two labelled actions, no unlabelled dismiss: an "x" that silently
                  meant accept left the professor guessing which way it resolved. */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleRejectRewrite}
                  /* min-h-9 on small screens: at 24px these were under the touch minimum, on a
                     decision you really do not want mis-tapped. */
                  className="min-h-9 rounded-xl px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-0 sm:px-2.5 sm:py-1"
                >
                  Reject
                </button>
                <button
                  type="button"
                  onClick={handleAcceptRewrite}
                  className="min-h-9 rounded-xl bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-0 sm:px-2.5 sm:py-1"
                >
                  Accept
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Attachments */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Attachments</span>
          </div>

          {attachmentFields.length > 0 && (
            <div className="space-y-1.5">
              {attachmentFields.map((field, index) => (
                <div key={field.id} className="flex items-center gap-2 px-3 py-2 rounded-xl border bg-muted/20">
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm truncate flex-1">{field.fileName}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <FileUpload
            folder={`announcements/${sectionId}`}
            accept={[ACCEPTED_FILE_TYPES.lecture, ACCEPTED_FILE_TYPES.image].join(',')}
            onUpload={handleFileUpload}
            multiple
          />
        </div>

        {/* Links */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Links</span>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={handleAddLink} className="h-7 text-xs">
              <Plus className="h-3 w-3 mr-1" />
              Add Link
            </Button>
          </div>

          {linkFields.length > 0 && (
            <div className="space-y-2">
              {linkFields.map((field, index) => {
                // These inputs are plain `register()` calls with no FormField
                // wrapper, so linkSchema's messages ('URL is required', and the
                // http(s) scheme rule) had nowhere to render — submit just failed
                // silently and the save button read as broken. Surface it inline.
                const urlError = form.formState.errors.links?.[index]?.url?.message
                return (
                  <div key={field.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1" />
                      <div className="flex-1 grid grid-cols-2 gap-2">
                        <Input
                          placeholder="https://..."
                          aria-invalid={!!urlError}
                          {...form.register(`links.${index}.url`)}
                          className="h-8 text-sm"
                        />
                        <Input
                          placeholder="Label (optional)"
                          {...form.register(`links.${index}.label`)}
                          className="h-8 text-sm"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLink(index)}
                        className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {urlError && (
                      <p className="pl-6 text-xs text-destructive">{urlError}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Status + Scheduling */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {watchStatus === 'scheduled' && (
            <FormField
              control={form.control}
              name="scheduled_at"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5" />
                    Publish At
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="datetime-local"
                      {...field}
                      value={field.value || ''}
                      className="h-9"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        {/* Visibility */}
        <FormField
          control={form.control}
          name="visibility"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" />
                Audience
              </FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="all">All enrolled students</SelectItem>
                  <SelectItem value="mentioned_only">Selected students only</SelectItem>
                </SelectContent>
              </Select>
              {watchVisibility === 'mentioned_only' && (
                <p className="text-[11px] text-warning-muted-foreground">
                  Only selected students will see this announcement.
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Student Picker — shown when visibility is mentioned_only */}
        {watchVisibility === 'mentioned_only' && enrolledStudents && enrolledStudents.length > 0 && (
          <StudentPicker
            students={enrolledStudents}
            selectedIds={selectedStudentIds}
            onChange={setSelectedStudentIds}
          />
        )}

        {/* Post to multiple sections — create mode only, incompatible with mentioned_only */}
        {!isEditMode && otherSections.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">Also post to</span>
            </div>
            {watchVisibility === 'mentioned_only' ? (
              <p className="text-[11px] text-muted-foreground">
                Posting to multiple sections isn&apos;t available with &ldquo;Selected students only&rdquo; audience.
              </p>
            ) : (
              <div className="space-y-1.5 rounded-xl border border-border bg-muted/20 p-3 max-h-40 overflow-y-auto">
                {otherSections.map((s) => {
                  const checked = selectedSectionIds.includes(s.id)
                  return (
                    <label
                      key={s.id}
                      className="flex items-center gap-2.5 cursor-pointer rounded-xl px-1.5 py-1 hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          setSelectedSectionIds((prev) =>
                            v ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium truncate">{s.label}</span>
                        {s.sublabel && (
                          <span className="block text-[11px] text-muted-foreground truncate">{s.sublabel}</span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {canPostToOtherSections && selectedSectionIds.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                This announcement will be posted to {selectedSectionIds.length + 1} sections.
              </p>
            )}
          </div>
        )}

        {/* Importance + acknowledgement */}
        <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
          <FormField
            control={form.control}
            name="is_important"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between gap-3">
                <FormLabel className="!mt-0 cursor-pointer flex items-center gap-1.5">
                  <Star className="h-3.5 w-3.5 text-warning-muted-foreground" />
                  Mark as important
                </FormLabel>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={(v) => {
                      field.onChange(v)
                      // Acknowledgement only makes sense on important posts.
                      if (!v) form.setValue('requires_acknowledgement', false)
                    }}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          {watchImportant && (
            <FormField
              control={form.control}
              name="requires_acknowledgement"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
                  <div>
                    <FormLabel className="!mt-0 cursor-pointer flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                      Require acknowledgement
                    </FormLabel>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Students must click &ldquo;I have read this&rdquo; after reading to the end.
                    </p>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
          )}
        </div>

        {/* Toggles row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
          <FormField
            control={form.control}
            name="is_pinned"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel className="!mt-0 cursor-pointer">Pin to top</FormLabel>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="allow_reactions"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2">
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel className="!mt-0 cursor-pointer flex items-center gap-1">
                  <Smile className="h-3.5 w-3.5" />
                  Reactions
                </FormLabel>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="allow_comments"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2">
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel className="!mt-0 cursor-pointer flex items-center gap-1">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Comments
                </FormLabel>
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={isSubmitting}>
            {isSubmitting
              ? (isEditMode ? 'Updating…' : 'Publishing…')
              : (isEditMode ? 'Update Announcement' : (watchStatus === 'draft' ? 'Save Draft' : watchStatus === 'scheduled' ? 'Schedule' : 'Publish Announcement'))}
          </Button>
        </div>
      </form>

      {/* Multi-section edit: choose whether to sync content to all sections */}
      <AlertDialog open={!!pendingPayload} onOpenChange={(open) => { if (!open) setPendingPayload(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply to all sections?</AlertDialogTitle>
            <AlertDialogDescription>
              This announcement was posted to multiple sections. Update the content in every
              section, or only in this one? (Comments, reactions and read status always stay
              separate per section.)
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={isSubmitting}
              onClick={() => pendingPayload && submitPayload(pendingPayload, 'this')}
            >
              Only this section
            </Button>
            <AlertDialogAction
              disabled={isSubmitting}
              onClick={() => pendingPayload && submitPayload(pendingPayload, 'all')}
            >
              All sections
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  )
}
