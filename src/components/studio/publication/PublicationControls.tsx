'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Archive, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { PluginCard } from '@/lib/studio/plugin-card'
import type { BlockerCode, Issue, WarningCode } from '@/lib/studio/student-visibility'
import type { ValidationSummary } from '@/lib/studio/validator/service'
import {
  archiveInstallationAction,
  hideFromStudentsAction,
} from '@/app/(dashboard)/professor/courses/[sectionId]/studio/[installationId]/actions'
import { PublicationDialog } from './PublicationDialog'

export interface PublicationState {
  status: 'active' | 'archived'
  visibility: 'hidden' | 'visible'
  card: PluginCard
  blockers: Issue<BlockerCode>[]
  warnings: Issue<WarningCode>[]
  validation: ValidationSummary | null
  skillSlots: { key: string; label: string; skillId: string | null }[]
  sectionSkills: { id: string; name: string }[] | null
}

interface PublicationControlsProps extends PublicationState {
  sectionId: string
  installationId: string
  /** Previewing another version: showing would act on the active one, so it's not offered. */
  previewingOtherVersion?: boolean
}

type Confirming = 'hide' | 'archive' | null

const CONFIRM = {
  hide: {
    title: 'Hide this tool from students?',
    description: 'Students lose access right away, including anyone using it now. Their saved work is kept, and you can show it again.',
    action: 'Hide from students',
  },
  archive: {
    title: 'Remove this tool from the course?',
    description:
      'It leaves the course for everyone. Saved work is kept and stays readable, but the tool can’t be changed or shown to students again.',
    action: 'Remove from course',
  },
} as const

/** Who can see this tool, and the controls to change it. Section professor only. */
export function PublicationControls({
  sectionId,
  installationId,
  status,
  visibility,
  card,
  blockers,
  warnings,
  validation,
  skillSlots,
  sectionSkills,
  previewingOtherVersion = false,
}: PublicationControlsProps) {
  const router = useRouter()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [pending, startTransition] = useTransition()

  if (status === 'archived') {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <Archive className="h-3.5 w-3.5" aria-hidden="true" />
        Removed from course
      </Badge>
    )
  }

  const visible = visibility === 'visible'

  const run = (which: Exclude<Confirming, null>) =>
    startTransition(async () => {
      const act = which === 'hide' ? hideFromStudentsAction : archiveInstallationAction
      const result = await act(sectionId, installationId)
      setConfirming(null)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(which === 'hide' ? `${card.name} is hidden from students` : `${card.name} was removed from the course`)
      router.refresh()
    })

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={visible ? 'default' : 'secondary'} className="gap-1.5">
        {visible ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
        {visible ? 'Visible to students' : 'Hidden from students'}
      </Badge>
      {visible ? (
        <Button type="button" variant="outline" className="min-h-11" onClick={() => setConfirming('hide')} disabled={pending}>
          Hide from students
        </Button>
      ) : previewingOtherVersion ? null : (
        <Button type="button" className="min-h-11" onClick={() => setDialogOpen(true)} disabled={pending}>
          Show to students…
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 text-muted-foreground"
        onClick={() => setConfirming('archive')}
        disabled={pending}
      >
        <Archive className="h-4 w-4" aria-hidden="true" />
        Remove from course
      </Button>

      {dialogOpen && (
        <PublicationDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          sectionId={sectionId}
          installationId={installationId}
          card={card}
          blockers={blockers}
          warnings={warnings}
          validation={validation}
          skillSlots={skillSlots}
          sectionSkills={sectionSkills}
        />
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !pending && setConfirming(null)}>
        <AlertDialogContent>
          {confirming && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{CONFIRM[confirming].title}</AlertDialogTitle>
                <AlertDialogDescription>{CONFIRM[confirming].description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11" disabled={pending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-11"
                  // Removing can't be undone; hiding can.
                  variant={confirming === 'archive' ? 'destructive' : 'default'}
                  disabled={pending}
                  onClick={(e) => {
                    // Keep the dialog open until the server answers.
                    e.preventDefault()
                    run(confirming)
                  }}
                >
                  {pending ? 'Working…' : CONFIRM[confirming].action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
