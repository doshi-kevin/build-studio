/**
 * ProjectResourcesSection — Sidebar section in the Discussions tab listing
 * all project_docs (canvases) for the team.
 *
 * Responsibilities:
 *  - Fetch doc list via listTeamDocs (sorted: pinned first, then by position)
 *  - "+ Add canvas" opens CanvasTypePickerDialog, then creates the chosen
 *    canvas type and opens its editor
 *  - Clicking a row opens DocEditorDialog for that doc
 *  - Dropdown menu offers Rename / Delete for non-pinned rows
 *  - Local optimistic state mutations keep list in sync without a full refetch
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  FileText,
  Plus,
  Pin,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  createDoc,
  deleteDoc,
  listTeamDocs,
  updateDocTitle,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/docs-actions'
import { DocEditorDialog } from '@/components/student/projects/docs/DocEditorDialog'
import {
  CanvasTypePickerDialog,
  type CanvasType,
} from '@/components/student/projects/docs/CanvasTypePickerDialog'
import { DOC_TITLE_MAX } from '@/lib/validations/project-docs'

interface DocRow {
  id: string
  title: string
  is_pinned: boolean
  position: number
  updated_at: string
  updated_by: string | null
}

interface ProjectResourcesSectionProps {
  teamId: string
  sectionId: string
  /** Section heading. Defaults to "Resources" (the Discussions-tab sidebar
   *  context); the standalone Planning tab passes "Planning Canvases". */
  title?: string
}

export function ProjectResourcesSection({
  teamId,
  sectionId,
  title = 'Resources',
}: ProjectResourcesSectionProps) {
  const [docs, setDocs] = useState<DocRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [openDocId, setOpenDocId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Rename dialog state (for sidebar rename action)
  const [renameTarget, setRenameTarget] = useState<DocRow | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)

  // Delete confirm state
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchDocs = useCallback(async () => {
    const res = await listTeamDocs(teamId)
    if (res.error) {
      setLoadError(res.error)
      setDocs([])
    } else {
      setLoadError(null)
      setDocs(res.data || [])
    }
    setLoading(false)
  }, [teamId])

  useEffect(() => {
    fetchDocs()
  }, [fetchDocs])

  const sortedDocs = useMemo(() => {
    return [...docs].sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return a.position - b.position
    })
  }, [docs])

  // ── Handlers ────────────────────────────────────────────────────

  const handleAddCanvasClick = () => {
    if (creating) return
    setPickerOpen(true)
  }

  const handleCreateByType = async (type: CanvasType) => {
    if (creating) return
    setCreating(true)
    try {
      // Only 'document' is supported today; switch stays for future types.
      if (type !== 'document') {
        toast.error('Unsupported canvas type')
        return
      }
      const res = await createDoc(teamId, sectionId, { title: 'Untitled' })
      if (res.error || !res.data) {
        toast.error(res.error || 'Failed to create canvas')
        return
      }
      await fetchDocs()
      setPickerOpen(false)
      setOpenDocId(res.data.id)
    } catch {
      toast.error('Failed to create canvas')
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const trimmed = renameValue.trim()
    if (!trimmed) {
      toast.error('Title cannot be empty')
      return
    }
    if (trimmed === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    try {
      const res = await updateDocTitle(renameTarget.id, sectionId, { title: trimmed })
      if (res.error) {
        toast.error(res.error)
      } else {
        setDocs((prev) =>
          prev.map((d) => (d.id === renameTarget.id ? { ...d, title: trimmed } : d)),
        )
        setRenameTarget(null)
      }
    } catch {
      toast.error('Failed to rename')
    } finally {
      setRenaming(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await deleteDoc(deleteTarget.id, sectionId)
      if (res.error) {
        toast.error(res.error)
      } else {
        setDocs((prev) => prev.filter((d) => d.id !== deleteTarget.id))
        setDeleteTarget(null)
        toast.success('Canvas deleted')
      }
    } catch {
      toast.error('Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  const handleEditorClose = () => {
    setOpenDocId(null)
    // Refetch to pick up any title / updated_at changes made in the editor
    fetchDocs()
  }

  const handleEditorDeleted = (deletedId: string) => {
    setDocs((prev) => prev.filter((d) => d.id !== deletedId))
  }

  // ── Render ──────────────────────────────────────────────────────

  return (
    <>
      <div className="flex flex-col min-h-0">
        {/* Header */}
        <div className="p-3 border-y flex items-center justify-between shrink-0">
          <h3
            className="text-sm font-semibold flex items-center gap-1.5"
            title="Team canvases — rich-text docs any team member can edit"
          >
            {title}
          </h3>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleAddCanvasClick}
            disabled={creating}
            title="Add canvas"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && loadError && (
            <p className="text-xs text-destructive px-2 py-1.5">{loadError}</p>
          )}

          {!loading && !loadError && sortedDocs.length === 0 && (
            <button
              onClick={handleAddCanvasClick}
              disabled={creating}
              className="w-full text-left text-xs text-muted-foreground px-2 py-2 rounded-xl hover:bg-muted hover:text-foreground transition-colors"
            >
              No canvases yet. Click + to add one.
            </button>
          )}

          {!loading &&
            !loadError &&
            sortedDocs.map((doc) => (
              <div
                key={doc.id}
                className={cn(
                  'group flex items-center gap-1.5 px-2 py-1.5 rounded-xl cursor-pointer text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                onClick={() => setOpenDocId(doc.id)}
                title={doc.title}
              >
                {doc.is_pinned ? (
                  <Pin className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate flex-1">{doc.title}</span>

                {!doc.is_pinned && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Resource actions"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenameTarget(doc)
                          setRenameValue(doc.title)
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5 mr-2" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget(doc)
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            ))}
        </div>
      </div>

      {/* Canvas type picker */}
      <CanvasTypePickerDialog
        open={pickerOpen}
        onOpenChange={(v) => {
          if (!creating) setPickerOpen(v)
        }}
        onSelect={handleCreateByType}
        creating={creating}
      />

      {/* Editor dialog */}
      <DocEditorDialog
        docId={openDocId}
        sectionId={sectionId}
        open={!!openDocId}
        onClose={handleEditorClose}
        onDeleted={handleEditorDeleted}
      />

      {/* Rename dialog */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(v) => {
          if (!v) setRenameTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename canvas</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            maxLength={DOC_TITLE_MAX}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename()
            }}
            placeholder="Canvas title"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={renaming}
            >
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={renaming || !renameValue.trim()}>
              {renaming && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget ? `"${deleteTarget.title}"` : 'this canvas'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the canvas and its contents. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              variant="destructive"
            >
              {deleting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
