'use client'

import { useCallback, useRef, useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Upload, FileUp, X, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import {
  FILE_TYPES,
  FILE_TYPE_LABELS,
  type WarehouseCourse,
  type WarehouseTerm,
  type WarehouseFile,
  type FileType,
} from '@/lib/validations/warehouse'
import { generateId } from '@/lib/quiz/utils'
import { getFileTypeFromMime, getFileTypeFromExtension, formatFileSize } from '@/lib/warehouse/utils'
import { uploadWarehouseFile } from '@/lib/supabase/storage'

const ACCEPTED_TYPES =
  '.pdf,.ppt,.pptx,.doc,.docx,.txt,.rtf,.md,.mp4,.mov,.avi,.webm,.mkv,.png,.jpg,.jpeg,.gif,.webp,.svg,.xls,.xlsx,.csv,.zip'

const uploadSchema = z.object({
  name: z.string().min(1, 'File name is required').max(300),
  fileType: z.enum(FILE_TYPES),
  courseId: z.string().nullable(),
  termId: z.string().nullable(),
  week: z.coerce.number().int().min(1).max(52).nullable(),
  topic: z.string().max(200),
  tags: z.string(),
  note: z.string().max(2000),
})

type UploadValues = z.infer<typeof uploadSchema>

interface UploadFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  courses: WarehouseCourse[]
  terms: WarehouseTerm[]
  professorId: string | null
  onSave: (file: WarehouseFile) => void
}

export function UploadFileDialog({
  open,
  onOpenChange,
  courses,
  terms,
  professorId,
  onSave,
}: UploadFileDialogProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const form = useForm<UploadValues>({
    resolver: zodResolver(uploadSchema) as Resolver<UploadValues>,
    defaultValues: {
      name: '',
      fileType: 'pdf',
      courseId: null,
      termId: null,
      week: null,
      topic: '',
      tags: '',
      note: '',
    },
  })

  const handleFileSelected = useCallback(
    (file: File) => {
      setSelectedFile(file)
      form.setValue('name', file.name)
      // Detect type from mime first, fall back to extension
      const detectedType = file.type
        ? getFileTypeFromMime(file.type)
        : getFileTypeFromExtension(file.name)
      form.setValue('fileType', detectedType)
    },
    [form],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files?.[0]
      if (file) handleFileSelected(file)
    },
    [handleFileSelected],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleFileSelected(file)
    },
    [handleFileSelected],
  )

  const clearFile = useCallback(() => {
    setSelectedFile(null)
    form.setValue('name', '')
    form.setValue('fileType', 'pdf')
    if (inputRef.current) inputRef.current.value = ''
  }, [form])

  const onSubmit = useCallback(
    async (data: UploadValues) => {
      setIsUploading(true)
      let fileUrl: string | null = null
      let filePath: string | null = null

      // Upload to Supabase Storage if we have a file and professor ID
      if (selectedFile && professorId) {
        const result = await uploadWarehouseFile(selectedFile, professorId)
        if (result.error) {
          toast.error(`Upload failed: ${result.error}`)
          setIsUploading(false)
          return
        }
        if (result.data) {
          fileUrl = result.data.url
          filePath = result.data.path
        }
      }

      const now = new Date().toISOString()
      const tags = data.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const file: WarehouseFile = {
        id: generateId(),
        name: data.name,
        fileType: data.fileType,
        mimeType: selectedFile?.type ?? 'application/octet-stream',
        courseId: data.courseId,
        termId: data.termId,
        week: data.week,
        topic: data.topic,
        tags,
        note: data.note,
        size: selectedFile?.size ?? 0,
        favorite: false,
        usedInCourseIds: data.courseId ? [data.courseId] : [],
        fileUrl,
        filePath,
        createdAt: now,
        lastUsedAt: now,
        updatedAt: now,
      }

      onSave(file)
      form.reset()
      setSelectedFile(null)
      setIsUploading(false)
      if (inputRef.current) inputRef.current.value = ''
      onOpenChange(false)
    },
    [onSave, form, onOpenChange, selectedFile, professorId],
  )

  const handleClose = useCallback(
    (v: boolean) => {
      if (!v) {
        form.reset()
        setSelectedFile(null)
        if (inputRef.current) inputRef.current.value = ''
      }
      onOpenChange(v)
    },
    [form, onOpenChange],
  )

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[85vh] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>Upload File</DialogTitle>
          <DialogDescription>
            Select a file to add to your library.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(85vh-8rem)] px-6 pb-6">
          <Form {...form}>
            {/* eslint-disable-next-line react-hooks/refs */}
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Drop zone / file picker */}
              {!selectedFile ? (
                <div
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => inputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                    dragOver
                      ? 'border-primary bg-primary/5'
                      : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50'
                  }`}
                >
                  <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    Drag & drop a file here, or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    PDF, PPT, DOC, Video, Image, and more
                  </p>
                  <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPTED_TYPES}
                    onChange={handleInputChange}
                    className="hidden"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/50 border border-border">
                  <FileUp className="h-5 w-5 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(selectedFile.size)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 shrink-0"
                    onClick={clearFile}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}

              {/* File name */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>File Name *</FormLabel>
                    <FormControl>
                      <Input placeholder="lecture-03-neural-networks.pdf" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* File type */}
              <FormField
                control={form.control}
                name="fileType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>File Type</FormLabel>
                    <Select value={field.value} onValueChange={(v) => field.onChange(v as FileType)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {FILE_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {FILE_TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              {/* Course + Term row */}
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="courseId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Course</FormLabel>
                      <Select
                        value={field.value ?? 'none'}
                        onValueChange={(v) => field.onChange(v === 'none' ? null : v)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="None" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {courses.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.code ? `${c.code} — ${c.name}` : c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="termId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Term</FormLabel>
                      <Select
                        value={field.value ?? 'none'}
                        onValueChange={(v) => field.onChange(v === 'none' ? null : v)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="None" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {terms.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              </div>

              {/* Week + Topic */}
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="week"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Week</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={52}
                          placeholder="1-52"
                          value={field.value ?? ''}
                          onChange={(e) =>
                            field.onChange(e.target.value ? parseInt(e.target.value) : null)
                          }
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="topic"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Topic</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Backpropagation" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

              {/* Tags */}
              <FormField
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tags</FormLabel>
                    <FormControl>
                      <Input placeholder="neural-nets, deep-learning (comma-separated)" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />

              {/* Note */}
              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Quick Note</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Personal note about this file..."
                        rows={2}
                        className="resize-none"
                        {...field}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={() => handleClose(false)} disabled={isUploading}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isUploading}>
                  {isUploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    'Upload File'
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
