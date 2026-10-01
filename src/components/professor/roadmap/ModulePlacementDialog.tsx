/**
 * ModulePlacementDialog — "where does this live on the roadmap?" popup.
 *
 * Shown the moment a quiz/assignment first becomes real (first draft save /
 * creation) and again from quick-publish flows, so the roadmap always knows
 * which module a resource belongs under — even while it's still unpublished.
 * Placement is stored as a module→resource roadmap edge (see
 * lib/roadmap/placement-actions), idempotently, so re-picking just moves it.
 *
 * Type: Client Component
 */
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  getPlacementModules,
  getResourcePlacement,
  setResourcePlacement,
  type PlaceableResourceKind,
} from '@/lib/roadmap/placement-actions'

interface ModulePlacementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  kind: PlaceableResourceKind
  resourceId: string
  resourceTitle: string
  /** Called only after a placement is successfully saved. Dismissal/skip is
   *  observable via onOpenChange(false), which fires on every close path. */
  onPlaced?: (moduleId: string) => void
}

export function ModulePlacementDialog({
  open, onOpenChange, sectionId, kind, resourceId, resourceTitle, onPlaced,
}: ModulePlacementDialogProps) {
  const [modules, setModules] = useState<{ id: string; title: string; weekNumber: number | null }[] | null>(null)
  const [moduleId, setModuleId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    Promise.all([
      getPlacementModules(sectionId),
      getResourcePlacement(sectionId, kind, resourceId),
    ]).then(([mods, current]) => {
      if (!alive) return
      setModules(mods.data ?? [])
      if (current.data) setModuleId(current.data)
    })
    return () => { alive = false }
  }, [open, sectionId, kind, resourceId])

  const confirm = async () => {
    if (!moduleId) return
    setSaving(true)
    const res = await setResourcePlacement(sectionId, kind, resourceId, moduleId)
    setSaving(false)
    if (res.error) { toast.error(res.error); return }
    onPlaced?.(moduleId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Place it on the roadmap</DialogTitle>
          <DialogDescription>
            Pick the module &ldquo;{resourceTitle}&rdquo; belongs to — it shows there on the
            roadmap right away (marked unpublished until it goes live).
          </DialogDescription>
        </DialogHeader>

        {modules === null ? (
          <p className="text-xs text-muted-foreground">Loading modules…</p>
        ) : modules.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No modules in this section yet — add one to place this on the roadmap. Until then it stays in the Archive.
          </p>
        ) : (
          <Select value={moduleId} onValueChange={setModuleId}>
            <SelectTrigger className="w-full" aria-label="Module">
              <SelectValue placeholder="Pick a module…" />
            </SelectTrigger>
            <SelectContent>
              {modules.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.weekNumber ? `Week ${m.weekNumber} · ` : ''}{m.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Decide later
          </Button>
          <Button type="button" size="sm" onClick={confirm} disabled={saving || modules === null || modules.length === 0 || !moduleId}>
            {saving ? 'Saving…' : 'Place on roadmap'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
