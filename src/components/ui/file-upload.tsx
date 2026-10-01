/**
 * FileUpload — drag-and-drop file upload with progress.
 *
 * Uses Supabase Storage for persistence.
 * Shows upload state, file preview, and remove option.
 *
 * Type: Client Component
 */
'use client'

import { useState, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import { Upload, X, FileText, CheckCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { uploadFile, formatFileSize, MAX_FILE_SIZE, type UploadResult } from '@/lib/supabase/storage'

interface FileUploadProps {
  /** Storage folder path, e.g. "sectionId/moduleId" */
  folder: string
  /** MIME types to accept, e.g. ".pdf,.ppt,.docx" */
  accept?: string
  /** Called with upload result on success */
  onUpload: (result: UploadResult) => void
  /** Called when file is removed */
  onRemove?: () => void
  /** Existing file info (for edit mode) */
  existingFile?: { url: string; fileName: string; fileSize: number } | null
  /** Max file size override in bytes */
  maxSize?: number
  /** If true, resets to drop zone after each upload (for multi-file use) */
  multiple?: boolean
  /** Single-row dropzone (icon + text inline) for tight spots where the
   *  surrounding list needs the vertical space. */
  compact?: boolean
  /** Fires on upload start/finish — lets the parent gate actions (e.g. a
   *  submit button) while a file is still in flight. */
  onUploadingChange?: (uploading: boolean) => void
}

export interface FileUploadHandle {
  /** Run files through the same validate → upload pipeline as the dropzone —
   *  lets a parent make a larger area (e.g. a whole panel) a drop target. */
  handleFiles: (files: FileList | File[]) => void
}

export const FileUpload = forwardRef<FileUploadHandle, FileUploadProps>(function FileUpload({
  folder,
  accept,
  onUpload,
  onRemove,
  existingFile,
  maxSize = MAX_FILE_SIZE,
  multiple = false,
  compact = false,
  onUploadingChange,
}: FileUploadProps, ref) {
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<UploadResult | null>(
    existingFile
      ? {
          url: existingFile.url,
          fileName: existingFile.fileName,
          fileSize: existingFile.fileSize,
          path: '',
          mimeType: '',
        }
      : null
  )
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const setUploading = useCallback(
    (v: boolean) => {
      setIsUploading(v)
      onUploadingChange?.(v)
    },
    [onUploadingChange],
  )

  const handleFile = useCallback(async (file: File) => {
    setError(null)

    if (file.size > maxSize) {
      setError(`File too large. Maximum ${formatFileSize(maxSize)}.`)
      return
    }

    setUploading(true)
    const result = await uploadFile(file, folder)

    if (result.error) {
      setError(result.error)
      setUploading(false)
      return
    }

    if (result.data) {
      if (!multiple) {
        setUploadedFile(result.data)
      }
      onUpload(result.data)
      if (inputRef.current) inputRef.current.value = ''
    }
    setUploading(false)
  }, [folder, maxSize, multiple, onUpload, setUploading])

  // Shared entry point for drops (internal zone or a parent-provided target),
  // the file picker, and the imperative handle. Sequential so the uploading
  // signal stays truthful across a multi-file drop.
  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      let list = Array.from(files)
      // The native picker enforces `accept`, but drops don't — hold dropped
      // files to the same contract (extension entries only; MIME patterns in
      // `accept` are left to the picker as before).
      const exts = (accept ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.startsWith('.'))
      if (exts.length > 0) {
        list = list.filter((f) => exts.some((ext) => f.name.toLowerCase().endsWith(ext)))
        if (list.length === 0 && files.length > 0) {
          setError(`Only ${exts.join(', ')} files are supported.`)
          return
        }
      }
      if (list.length === 0) return
      if (!multiple) {
        void handleFile(list[0])
        return
      }
      void (async () => {
        for (const f of list) await handleFile(f)
      })()
    },
    [accept, handleFile, multiple],
  )

  useImperativeHandle(ref, () => ({ handleFiles }), [handleFiles])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }, [handleFiles])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files)
  }, [handleFiles])

  const handleRemove = () => {
    setUploadedFile(null)
    setError(null)
    onRemove?.()
    if (inputRef.current) inputRef.current.value = ''
  }

  // File already uploaded — show preview
  if (uploadedFile && !isUploading) {
    return (
      <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50">
          <CheckCircle className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{uploadedFile.fileName}</p>
          <p className="text-xs text-muted-foreground">{formatFileSize(uploadedFile.fileSize)}</p>
        </div>
        <button
          type="button"
          onClick={handleRemove}
          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  // Uploading state
  if (isUploading) {
    return (
      <div
        className={cn(
          'flex items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-muted/20',
          compact ? 'p-2' : 'p-6',
        )}
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">Uploading...</span>
      </div>
    )
  }

  // Drop zone
  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex items-center justify-center rounded-lg border-2 border-dashed cursor-pointer transition-colors',
          compact ? 'gap-2 p-2' : 'flex-col gap-2 p-6',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-muted/30'
        )}
      >
        {compact ? (
          <>
            {isDragging ? (
              <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Upload className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <p className="text-xs font-medium">
              {isDragging ? 'Drop file here' : 'Click to upload or drag and drop'}
            </p>
            <span className="text-xs text-muted-foreground">· max {formatFileSize(maxSize)}</span>
          </>
        ) : (
          <>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              {isDragging ? (
                <FileText className="h-5 w-5 text-primary" />
              ) : (
                <Upload className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">
                {isDragging ? 'Drop file here' : 'Click to upload or drag and drop'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Max {formatFileSize(maxSize)}
              </p>
            </div>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleChange}
          className="hidden"
        />
      </div>
      {error && (
        <p className="text-xs text-destructive mt-1.5">{error}</p>
      )}
    </div>
  )
})
