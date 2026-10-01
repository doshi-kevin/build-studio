/**
 * AssignmentPdfCard — professor-side upload / view / remove of the assignment's PDF
 * briefs. Files go to the section-readable course-materials bucket via a server action;
 * students see the same PDFs on their assignment page. Supports multiple PDFs, each of
 * which the AI rubric generator can draft from.
 *
 * Type: Client Component
 */
'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Upload, X, Paperclip, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  uploadAssignmentPdf,
  removeAssignmentPdf,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { MAX_ASSIGNMENT_PDFS } from '@/lib/validations/assignment'

interface AssignmentPdfCardProps {
  sectionId: string
  assignmentId: string
  pdfs: { name: string; url: string | null; path: string }[]
}

export function AssignmentPdfCard({ sectionId, assignmentId, pdfs }: AssignmentPdfCardProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isPending, startTransition] = useTransition()
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  function onPick(file: File | undefined) {
    if (!file) return
    const fd = new FormData()
    fd.append('pdf', file)
    startTransition(async () => {
      const res = await uploadAssignmentPdf(sectionId, assignmentId, fd)
      if ('error' in res) toast.error(res.error)
      else {
        toast.success('Assignment PDF uploaded')
        router.refresh()
      }
      if (inputRef.current) inputRef.current.value = ''
    })
  }

  function remove(path: string) {
    startTransition(async () => {
      const res = await removeAssignmentPdf(sectionId, assignmentId, path)
      if ('error' in res) toast.error(res.error)
      else {
        toast.success('PDF removed')
        if (previewPath === path) setPreviewPath(null)
        router.refresh()
      }
    })
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">Assignment PDFs</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        {pdfs.length < MAX_ASSIGNMENT_PDFS && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={isPending}
          >
            <Upload className="h-4 w-4" />
            {pdfs.length ? 'Add PDF' : 'Upload PDF'}
          </Button>
        )}
      </div>

      {pdfs.length ? (
        <ul className="space-y-2">
          {pdfs.map((pdf) => (
            <li key={pdf.path}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => pdf.url && setPreviewPath((p) => (p === pdf.path ? null : pdf.path))}
                  disabled={!pdf.url}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{pdf.name}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                    {previewPath === pdf.path ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {previewPath === pdf.path ? 'Hide' : 'Preview'}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(pdf.path)}
                  disabled={isPending}
                  aria-label={`Remove ${pdf.name}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {previewPath === pdf.path && pdf.url && (
                <iframe
                  src={pdf.url}
                  title={pdf.name}
                  className="mt-2 h-[70vh] w-full rounded-xl border border-border"
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          Upload the assignment or question PDFs — students can view them on their assignment page.
        </p>
      )}
    </div>
  )
}
