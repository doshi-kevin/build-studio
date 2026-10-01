/**
 * Inline-editable assignment title for the professor detail page header. Click the title (or
 * the pencil) to rename; Enter/blur commits via renameAssignment, Escape cancels. Mirrors the
 * studio top-bar rename so the title is editable wherever a professor lands.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilLine } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { renameAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'

interface Props {
  sectionId: string
  assignmentId: string
  title: string
  /**
   * Whether the viewer may rename. renameAssignment gates on canWriteAsStaff, which
   * excludes graders — so a grader was shown a click-to-rename affordance whose save
   * the server refuses. Defaults to true so existing call sites are unchanged.
   */
  canEdit?: boolean
}

export function AssignmentTitleEditor({ sectionId, assignmentId, title: initialTitle, canEdit = true }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(initialTitle)
  const [saving, setSaving] = useState(false)

  async function commit() {
    setEditing(false)
    const next = title.trim()
    if (!next || next === initialTitle) {
      setTitle(initialTitle)
      return
    }
    setSaving(true)
    const res = await renameAssignment(sectionId, assignmentId, next)
    setSaving(false)
    if ('error' in res) {
      toast.error(res.error)
      setTitle(initialTitle)
      return
    }
    toast.success('Title updated')
    router.refresh()
  }

  if (editing) {
    return (
      <Input
        value={title}
        autoFocus
        disabled={saving}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setTitle(initialTitle)
            setEditing(false)
          }
        }}
        className="h-auto max-w-xl font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight"
        aria-label="Assignment title"
      />
    )
  }

  if (!canEdit) {
    return (
      <span className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">
        {title}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to rename"
      className="group flex items-center gap-2 text-left"
    >
      <span className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">{title}</span>
      <PencilLine className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
    </button>
  )
}
