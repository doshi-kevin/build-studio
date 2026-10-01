/**
 * PlainAssignmentActions — Edit and Publish buttons for plain (kind 'file') assignments.
 *
 * Shown in the professor assignment detail header for assignments without a studio editor
 * (file-based, text-only). Handles the edit wizard and draft-to-published flow.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CreateAssignmentWizard, type EditAssignmentData } from './CreateAssignmentWizard'
import { ModulePlacementDialog } from '@/components/professor/roadmap/ModulePlacementDialog'
import { setAssignmentStatus } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

interface PlainAssignmentActionsProps {
  sectionId: string
  assignmentId: string
  status: string
  editData: EditAssignmentData
}

export function PlainAssignmentActions({
  sectionId,
  assignmentId,
  status,
  editData,
}: PlainAssignmentActionsProps) {
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [placementOpen, setPlacementOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handlePublish() {
    startTransition(async () => {
      const result = await setAssignmentStatus(sectionId, assignmentId, 'published')
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success('Assignment published')
      setPlacementOpen(true)
    })
  }

  /* 'draft' and 'closed' were supported by setAssignmentStatus but unreachable from the
     product — the only exit from published was permanent deletion, which destroys
     submissions. Both transitions are non-destructive: nothing removes submissions. */
  function setStatus(next: 'draft' | 'closed', success: string) {
    startTransition(async () => {
      const result = await setAssignmentStatus(sectionId, assignmentId, next)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(success)
      router.refresh()
    })
  }

  function handlePlacementClose() {
    setPlacementOpen(false)
    router.refresh()
  }

  return (
    <>
      <Button variant="outline" onClick={() => setEditOpen(true)}>
        <PencilLine className="h-4 w-4" />
        Edit assignment
      </Button>

      {status === 'draft' && (
        <Button onClick={handlePublish} disabled={isPending}>
          Publish
        </Button>
      )}

      {/* Close keeps the assignment visible and graded, and only stops new submissions —
          so it needs no confirmation. Unpublishing hides it from students entirely, so the
          server refuses it outright once anyone has submitted and says why. */}
      {status === 'published' && (
        <>
          <Button
            variant="outline"
            onClick={() => setStatus('closed', 'Submissions closed')}
            disabled={isPending}
          >
            Close submissions
          </Button>
          <Button
            variant="outline"
            onClick={() => setStatus('draft', 'Assignment unpublished')}
            disabled={isPending}
          >
            Unpublish
          </Button>
        </>
      )}

      {status === 'closed' && (
        <Button onClick={handlePublish} disabled={isPending}>
          Reopen submissions
        </Button>
      )}

      <CreateAssignmentWizard
        sectionId={sectionId}
        assignment={editData}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <ModulePlacementDialog
        open={placementOpen}
        onOpenChange={(o) => {
          if (!o) handlePlacementClose()
        }}
        sectionId={sectionId}
        kind="assignment"
        resourceId={assignmentId}
        resourceTitle={editData.title}
      />
    </>
  )
}
