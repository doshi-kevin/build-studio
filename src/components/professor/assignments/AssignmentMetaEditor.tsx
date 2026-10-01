/**
 * AssignmentMetaEditor — inline edit of an assignment's due date + total points
 * from the detail header. Display mode shows the values; clicking the pencil
 * reveals a datetime + points field with Save / Cancel. Points are hidden for
 * ungraded assignments (they carry no score), and read-only when a rubric exists
 * (the rubric defines the total; the server ignores points sent in that case).
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Clock, Pencil, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateAssignmentMeta } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { LocalDateTime } from '@/components/shared/LocalDateTime'
import { toLocalDateTimeInput } from '@/lib/datetime'


interface AssignmentMetaEditorProps {
  sectionId: string
  assignmentId: string
  dueAt: string | null
  points: number
  isGraded: boolean
  status: string
  /** When a rubric exists, it defines the total — the points field becomes read-only. */
  hasRubric: boolean
  /**
   * Whether the viewer may edit. updateAssignmentMeta gates on canWriteAsStaff, which
   * excludes graders — so a grader was shown an Edit button whose save the server
   * refuses. Defaults to true so existing call sites are unchanged.
   */
  canEdit?: boolean
}

export function AssignmentMetaEditor({
  sectionId,
  assignmentId,
  dueAt,
  points,
  isGraded,
  status,
  hasRubric,
  canEdit = true,
}: AssignmentMetaEditorProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [due, setDue] = useState(toLocalDateTimeInput(dueAt))
  const [pts, setPts] = useState(String(points))
  const [saving, startSave] = useTransition()

  function save() {
    startSave(async () => {
      const res = await updateAssignmentMeta(sectionId, assignmentId, {
        dueAt: due ? new Date(due).toISOString() : null,
        points: Number(pts),
      })
      if ('error' in res) {
        toast.error(res.error)
      } else {
        // Name the outcome — clearing a due date is a meaningful, easy-to-miss change.
        toast.success(dueAt && !due ? 'Due date removed' : 'Assignment updated')
        setEditing(false)
        router.refresh()
      }
    })
  }

  function cancel() {
    setDue(toLocalDateTimeInput(dueAt))
    setPts(String(points))
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="meta-due" className="text-xs">
            Due date
          </Label>
          <Input
            id="meta-due"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="h-9 w-56"
          />
        </div>
        {isGraded && !hasRubric && (
          <div className="space-y-1">
            <Label htmlFor="meta-points" className="text-xs">
              Points
            </Label>
            <Input
              id="meta-points"
              type="number"
              min={0}
              max={1000}
              value={pts}
              onChange={(e) => setPts(e.target.value)}
              className="h-9 w-24 tabular-nums"
            />
          </div>
        )}
        {isGraded && hasRubric && (
          <div className="space-y-1">
            <Label className="text-xs">Points</Label>
            <p className="flex h-9 items-center gap-1 text-sm text-muted-foreground">
              {points} <span className="text-xs">(set by rubric)</span>
            </p>
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            <Check className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="outline" onClick={cancel} disabled={saving}>
            <X className="h-4 w-4" />
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Clock className="h-4 w-4" />
        {dueAt ? <LocalDateTime iso={dueAt} mode="datetime" prefix="Due" /> : 'No due date'}
      </span>
      {isGraded && <span className="tabular-nums">{points} points</span>}
      <span className="capitalize">{status}</span>
      {canEdit && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => setEditing(true)}
          aria-label="Edit due date and points"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      )}
    </div>
  )
}
