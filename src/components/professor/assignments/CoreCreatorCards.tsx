/**
 * CoreCreatorCards: the three core assignment-type cards (File Upload, Blank Document,
 * Verbal Assessment). Extracted from AssignmentStudioEntry so both the entry page and the
 * full marketplace page share one implementation.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ChevronRight, Loader2, Upload, Mic, FilePlus2, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { createDocumentAssignment, createFileUploadAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

type Accent = { bar: string; tile: string }

const ACCENTS: Record<string, Accent> = {
  primary: { bar: 'bg-primary', tile: 'bg-primary/10 text-primary' },
  info: { bar: 'bg-info-muted-foreground', tile: 'bg-info-muted text-info-muted-foreground' },
  success: { bar: 'bg-success-muted-foreground', tile: 'bg-success-muted text-success-muted-foreground' },
  warning: { bar: 'bg-warning-muted-foreground', tile: 'bg-warning-muted text-warning-muted-foreground' },
  accent: { bar: 'bg-foreground/40', tile: 'bg-accent text-accent-foreground' },
}

type TemplateType = {
  id: string
  title: string
  desc: string
  icon: LucideIcon
  accent: keyof typeof ACCENTS
  action: 'file-upload' | 'verbal' | 'document'
}

const TYPES: TemplateType[] = [
  { id: 'file-upload', title: 'File Upload', desc: 'Instructions, the file types students may submit, and an optional written response.', icon: Upload, accent: 'success', action: 'file-upload' },
  { id: 'blank', title: 'Blank Document', desc: 'Start from a blank page and write freely, like a doc: headings, lists, to-dos, quotes, and more. Press / for blocks.', icon: FilePlus2, accent: 'info', action: 'document' },
  { id: 'verbal-assessment', title: 'Verbal Assessment', desc: 'An AI asks the student questions aloud; the student answers by voice. The full recording + transcript is saved for you to grade.', icon: Mic, accent: 'accent', action: 'verbal' },
]

interface CoreCreatorCardsProps {
  sectionId: string
}

export function CoreCreatorCards({ sectionId }: CoreCreatorCardsProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [pendingId, setPendingId] = useState<string | null>(null)

  function pickType(t: TemplateType) {
    setPendingId(t.id)
    startTransition(async () => {
      if (t.action === 'verbal') {
        router.push(`/professor/courses/${sectionId}/assignments/new/verbal`)
      } else if (t.action === 'document') {
        const res = await createDocumentAssignment(sectionId)
        if ('error' in res) {
          toast.error(res.error)
          setPendingId(null)
          return
        }
        router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
      } else if (t.action === 'file-upload') {
        const res = await createFileUploadAssignment(sectionId)
        if ('error' in res) {
          toast.error(res.error)
          setPendingId(null)
          return
        }
        router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
      }
    })
  }

  return (
    <div className="flex flex-wrap justify-center gap-4">
      {TYPES.map((t) => (
        <TypeCard key={t.id} type={t} onClick={() => pickType(t)} disabled={isPending} loading={pendingId === t.id} />
      ))}
    </div>
  )
}

function TypeCard({ type, onClick, disabled, loading }: { type: TemplateType; onClick: () => void; disabled?: boolean; loading?: boolean }) {
  const Icon = type.icon
  const accent = ACCENTS[type.accent]

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={loading}
      className="group block w-full cursor-pointer rounded-3xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-[320px]"
    >
      <Card className="relative h-full gap-0 overflow-hidden rounded-3xl py-0 transition-[box-shadow,transform] duration-300 hover:-translate-y-1 hover:shadow-lg">
        <div className={cn('absolute inset-x-0 top-0 h-1', accent.bar)} aria-hidden="true" />
        <CardContent className="flex h-full flex-col gap-4 p-6">
          <div className="flex items-start justify-between">
            <span className={cn('flex h-12 w-12 items-center justify-center rounded-2xl', accent.tile)}>
              {loading ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" /> : <Icon className="h-6 w-6" aria-hidden="true" />}
            </span>
            <ChevronRight className="h-5 w-5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">{type.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{type.desc}</p>
          </div>
        </CardContent>
      </Card>
    </button>
  )
}
