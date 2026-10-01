'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface VersionPreviewPickerProps {
  /** The runtime page for this installation. */
  basePath: string
  /** Published versions of this plugin, newest first. */
  versions: { id: string; version: string }[]
  /** The version active in this course. */
  activeVersionId: string
  /** The version being previewed, if not the active one. */
  previewingVersionId?: string
  /** Kept when switching versions. */
  view: 'student' | 'professor'
}

const ACTIVE = 'active'

/**
 * Opens another published version on sample data. Only navigation: the page re-checks
 * that the version belongs to this plugin, and nothing about the course changes.
 */
export function VersionPreviewPicker({ basePath, versions, activeVersionId, previewingVersionId, view }: VersionPreviewPickerProps) {
  const router = useRouter()
  const [picked, setPicked] = useState(previewingVersionId ?? ACTIVE)
  const [pending, startTransition] = useTransition()
  const others = versions.filter((v) => v.id !== activeVersionId)
  if (others.length === 0) return null
  const active = versions.find((v) => v.id === activeVersionId)

  const open = (value: string) => {
    setPicked(value)
    const params = new URLSearchParams()
    if (view === 'student') params.set('view', 'student')
    if (value !== ACTIVE) params.set('version', value)
    const query = params.toString()
    startTransition(() => router.push(query ? `${basePath}?${query}` : basePath))
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="studio-preview-version" className="text-sm text-muted-foreground">
        Preview version
      </Label>
      <Select value={picked} onValueChange={open} disabled={pending}>
        <SelectTrigger id="studio-preview-version" className="min-h-11 w-44" aria-busy={pending}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ACTIVE}>{active ? `v${active.version} (active)` : 'Active version'}</SelectItem>
          {others.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              v{v.version}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
