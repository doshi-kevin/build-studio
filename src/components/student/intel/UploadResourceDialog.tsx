/**
 * UploadResourceDialog -- Dialog for uploading a resource file to the
 * Course Alumni Intelligence Panel.
 *
 * Form with title, description, category select, file upload with drag-and-drop,
 * and anonymous toggle. Handles two-step upload: file to storage, then metadata
 * via server action.
 *
 * Type: Client Component
 */
'use client'

import { useState, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form'
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
import { AnonymousToggle } from './AnonymousToggle'
import {
  createResourceSchema,
  RESOURCE_CATEGORIES,
  RESOURCE_CATEGORY_LABELS,
  type CreateResourceInput,
} from '@/lib/validations/intel'
import { uploadResource } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'
import {
  uploadResourceFile,
  RESOURCE_FILE_TYPES,
  MAX_RESOURCE_SIZE,
  formatFileSize,
} from '@/lib/supabase/storage'
import { cn } from '@/lib/utils'

interface UploadResourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  courseId: string
}

export function UploadResourceDialog({
  open,
  onOpenChange,
  sectionId,
  courseId,
}: UploadResourceDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const form = useForm<CreateResourceInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createResourceSchema) as any,
    defaultValues: {
      title: '',
      description: '',
      category: 'notes',
      is_anonymous: false,
    },
  })

  const handleFileSelect = (file: File | undefined) => {
    if (!file) return

    if (file.size > MAX_RESOURCE_SIZE) {
      toast.error(`File too large. Maximum size is ${formatFileSize(MAX_RESOURCE_SIZE)}.`)
      /* Clear the input so re-picking the SAME file still fires a `change` event (#699 part
         5, same shape as the two chat composers). Via the ref rather than the event, because
         this handler also serves the drop zone and receives a File, not the event. Clearing
         it is harmless on the drop path. */
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    setSelectedFile(file)

    // Auto-fill title from filename if empty
    if (!form.getValues('title')) {
      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '')
      form.setValue('title', nameWithoutExt)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    handleFileSelect(file)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = () => {
    setIsDragOver(false)
  }

  const onSubmit = async (data: CreateResourceInput) => {
    if (!selectedFile) {
      toast.error('Please select a file to upload')
      return
    }

    setIsSubmitting(true)
    try {
      // Step 1: Upload file to Supabase Storage
      const { data: uploadData, error: uploadError } = await uploadResourceFile(
        selectedFile,
        courseId
      )

      if (uploadError || !uploadData) {
        /* The raw value here is a storage message — this path was returning
           "Bucket not found" straight to the user while the bucket was missing (#704),
           which ui-design.md rules out anywhere on screen. Plain sentence for the reader,
           real detail in the log so the next failure is still diagnosable.

           Honest note: browser QA reported that NO toast appeared on this path at all,
           and I could not reproduce that from code — this branch does fire and the
           Toaster is mounted on the dashboard. Either it was a measurement artifact or
           there is a second cause I haven't found. Worth re-checking now the bucket
           exists and the path is reachable in the ordinary case. */
        logger.error('UploadResourceDialog: file upload failed', null, { uploadError })
        toast.error("Couldn't upload that file. Check your connection and try again.")
        return
      }

      // Step 2: Save metadata via server action
      const result = await uploadResource(
        sectionId,
        data,
        uploadData.path,
        uploadData.fileName,
        uploadData.fileSize,
        uploadData.mimeType,
      )

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Resource uploaded')
      form.reset()
      setSelectedFile(null)
      onOpenChange(false)
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => {
      onOpenChange(o)
      if (!o) {
        setSelectedFile(null)
        setIsDragOver(false)
      }
    }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Resource</DialogTitle>
          <DialogDescription>
            Share study materials, notes, or practice exams to help fellow students.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Midterm Study Guide" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Brief description of this resource (optional)..."
                      className="resize-none"
                      rows={2}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category *</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {RESOURCE_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {RESOURCE_CATEGORY_LABELS[cat]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* File upload area */}
            <div className="space-y-2">
              <FormLabel>File *</FormLabel>
              <div
                className={cn(
                  'relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 transition-colors duration-200 ease-out cursor-pointer',
                  isDragOver
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                )}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-8 w-8 text-muted-foreground/50" />
                {selectedFile ? (
                  <div className="text-center">
                    <p className="text-sm font-medium">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(selectedFile.size)}
                    </p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">
                      Drag and drop a file here, or click to browse
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      Max {formatFileSize(MAX_RESOURCE_SIZE)}
                    </p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={RESOURCE_FILE_TYPES}
                  className="hidden"
                  onChange={(e) => handleFileSelect(e.target.files?.[0])}
                />
              </div>
            </div>

            <FormField
              control={form.control}
              name="is_anonymous"
              render={({ field }) => (
                <FormItem>
                  <AnonymousToggle
                    value={field.value}
                    onChange={field.onChange}
                  />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting || !selectedFile}>
                {isSubmitting ? 'Uploading...' : 'Upload Resource'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
