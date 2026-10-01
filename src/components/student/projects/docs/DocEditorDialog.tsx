/**
 * DocEditorDialog — Full-screen modal hosting a PlanningEditor instance
 * for a single project_docs row.
 *
 * Responsibilities:
 *  - Fetch the doc by id via getDoc on open (with skeleton while loading)
 *  - Inline editable title (pinned "Planning" is rename-locked)
 *  - 1500ms debounced autosave of content via updateDocContent
 *  - Separate title save on blur via updateDocTitle
 *  - Shows "Saved HH:MM" / "Unsaved changes" / "Saving…" indicator
 *  - beforeunload warning when dirty
 *  - Portaled to <body>, because its host panel is display:none below `lg` (#145)
 *  - Optional delete for non-pinned docs (surfaces a confirm dialog)
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import {
  X,
  Loader2,
  CheckCircle2,
  Pin,
  Trash2,
  AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  getDoc,
  updateDocContent,
  updateDocTitle,
  deleteDoc,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/docs-actions'
import {
  docContentToHtml,
  DOC_TITLE_MAX,
} from '@/lib/validations/project-docs'

const PlanningEditor = dynamic(
  () => import('@/components/student/projects/PlanningEditor').then((m) => m.PlanningEditor),
  { ssr: false, loading: () => <div className="flex-1 bg-muted/20 rounded-xl animate-pulse" /> },
)

interface DocEditorDialogProps {
  docId: string | null
  sectionId: string
  open: boolean
  onClose: () => void
  onDeleted?: (docId: string) => void
}

interface DocState {
  id: string
  title: string
  html: string
  is_pinned: boolean
  updated_at: string
}

// Stable arguments for the hydration check (see `mounted` below), matching SetupSpotlight.
const subscribeNoop = () => () => {}
const snapshotTrue = () => true
const snapshotFalse = () => false

export function DocEditorDialog({
  docId,
  sectionId,
  open,
  onClose,
  onDeleted,
}: DocEditorDialogProps) {
  const [doc, setDoc] = useState<DocState | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  /* Portal target exists only in the browser: false during the SSR pass so it never touches
     document, true from the first client render. Same guard as SetupSpotlight. */
  const mounted = useSyncExternalStore(subscribeNoop, snapshotTrue, snapshotFalse)

  // Content (editor) state
  const [content, setContent] = useState('')
  const savedContentRef = useRef('')
  const [isSavingContent, setIsSavingContent] = useState(false)
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Title state
  const [title, setTitle] = useState('')
  const savedTitleRef = useRef('')
  const [isSavingTitle, setIsSavingTitle] = useState(false)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isDirtyContent = content !== savedContentRef.current
  const isDirtyTitle = title.trim() !== savedTitleRef.current

  // Fetch the doc whenever dialog opens with a new id
  useEffect(() => {
    if (!open || !docId) return
    let active = true

    setLoading(true)
    setLoadError(null)
    setDoc(null)
    setLastSaved(null)

    getDoc(docId)
      .then((res) => {
        if (!active) return
        if (res.error || !res.data) {
          setLoadError(res.error || 'Failed to load doc')
          return
        }
        const html = docContentToHtml(res.data.content)
        setDoc({
          id: res.data.id,
          title: res.data.title,
          html,
          is_pinned: res.data.is_pinned,
          updated_at: res.data.updated_at,
        })
        setContent(html)
        savedContentRef.current = html
        setTitle(res.data.title)
        savedTitleRef.current = res.data.title
      })
      .catch(() => {
        if (!active) return
        setLoadError('Failed to load doc')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [open, docId])

  // Clear state when dialog closes so the next open starts fresh
  useEffect(() => {
    if (open) return
    setDoc(null)
    setContent('')
    setTitle('')
    savedContentRef.current = ''
    savedTitleRef.current = ''
    setLastSaved(null)
    setLoadError(null)
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
  }, [open])

  // ── Autosave content (debounced 1500ms) ─────────────────────────
  // Returns true on success, false on failure. Callers that want to
  // guarantee a save landed (e.g. handleClose) use the return value
  // to keep the dialog open if the flush failed.
  const performContentSave = useCallback(
    async (html: string, targetDocId: string): Promise<boolean> => {
      if (html === savedContentRef.current) return true
      setIsSavingContent(true)
      try {
        const res = await updateDocContent(targetDocId, sectionId, html)
        if (res.error) {
          toast.error(res.error)
          return false
        }
        savedContentRef.current = html
        setLastSaved(
          new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        )
        return true
      } catch {
        toast.error('Failed to save. Check your connection.')
        return false
      } finally {
        setIsSavingContent(false)
      }
    },
    [sectionId],
  )

  useEffect(() => {
    if (!doc) return
    if (content === savedContentRef.current) return

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      performContentSave(content, doc.id)
    }, 1500)

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [content, doc, performContentSave])

  // ── Title save on blur / Enter ──────────────────────────────────
  const handleTitleSave = useCallback(async (): Promise<boolean> => {
    if (!doc) return true
    const trimmed = title.trim()
    if (!trimmed) {
      // Revert to saved title
      setTitle(savedTitleRef.current)
      return true
    }
    if (trimmed === savedTitleRef.current) return true
    if (trimmed.length > DOC_TITLE_MAX) {
      toast.error(`Title must be ${DOC_TITLE_MAX} characters or fewer`)
      setTitle(savedTitleRef.current)
      return true
    }

    setIsSavingTitle(true)
    try {
      const res = await updateDocTitle(doc.id, sectionId, { title: trimmed })
      if (res.error) {
        toast.error(res.error)
        setTitle(savedTitleRef.current)
        return false
      }
      savedTitleRef.current = trimmed
      // Surface the title save in the "Saved HH:MM" indicator so users
      // get confirmation even when only the title changed.
      setLastSaved(
        new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      )
      return true
    } catch {
      toast.error('Failed to rename')
      setTitle(savedTitleRef.current)
      return false
    } finally {
      setIsSavingTitle(false)
    }
  }, [doc, sectionId, title])

  // ── Warn before closing tab while dirty ─────────────────────────
  useEffect(() => {
    if (!isDirtyContent && !isDirtyTitle) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirtyContent, isDirtyTitle])

  // ── Body scroll lock while open ─────────────────────────────────
  // Prevents the underlying Discussions list from scrolling when the
  // user scrolls inside the paginated paper editor.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // ── Close handling — flush pending save first ───────────────────
  // If the flush save fails (network / validation / auth), we keep the
  // dialog open so the user sees the toast error and can retry or
  // manually copy-out before dismissing. Prevents silent data loss
  // where a user closes the editor after a failed save and never learns
  // their last edits didn't land.
  const handleClose = useCallback(async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    let allSaved = true
    if (doc && content !== savedContentRef.current) {
      const ok = await performContentSave(content, doc.id)
      if (!ok) allSaved = false
    }
    if (isDirtyTitle) {
      const ok = await handleTitleSave()
      if (!ok) allSaved = false
    }
    if (!allSaved) return
    onClose()
  }, [doc, content, performContentSave, isDirtyTitle, handleTitleSave, onClose])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, handleClose])

  // ── Delete flow ─────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!doc || doc.is_pinned) return
    setDeleting(true)
    try {
      const res = await deleteDoc(doc.id, sectionId)
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success('Canvas deleted')
        if (onDeleted) onDeleted(doc.id)
        setConfirmDelete(false)
        onClose()
      }
    } catch {
      toast.error('Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  if (!open) return null

  // Indicator shows Saving → Unsaved changes → Saved HH:MM.
  // Intentionally NO optimistic "All changes saved" before the first
  // confirmed save: on slow/failed loads we do not want to falsely
  // reassure the user that remote state is in sync.
  const saveIndicator = isSavingContent || isSavingTitle
    ? { icon: Loader2, text: 'Saving…', spin: true, tone: 'muted' as const }
    : isDirtyContent || isDirtyTitle
      ? { icon: null, text: 'Unsaved changes', spin: false, tone: 'amber' as const }
      : lastSaved
        ? { icon: CheckCircle2, text: `Saved ${lastSaved}`, spin: false, tone: 'emerald' as const }
        : null

  /* Portaled to <body> (#145). This overlay is rendered from ProjectResourcesSection, which
     lives inside `div.hidden lg:flex w-72` in StudentDiscussionsTab. Below the `lg` breakpoint
     that ancestor is `display: none`, and display:none removes a position:fixed DESCENDANT too,
     so the whole editor measured 0x0 while still reporting itself open: the student saw the
     project page with no editor and no error.

     It also made the footer lie. `pageCount` derives from scrollHeight, which is 0 when hidden,
     so a 3-page document read "1 page". Portaling fixes both, because the overlay no longer has
     a hidden ancestor to inherit.

     NOTE this only fixes rendering once open. The doc LIST lives in that same hidden panel, so
     below 1024px there is still no way to reach the editor. That half needs a layout decision
     and is deliberately not solved here. */
  const overlay = (
    <>
      <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-4 sm:px-6 py-3 border-b bg-background shrink-0">
          {/* Title + pin icon */}
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {doc?.is_pinned && (
              <span
                className="flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold shrink-0"
                title="This canvas cannot be deleted or renamed"
              >
                <Pin className="h-3 w-3" />
                Pinned
              </span>
            )}
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              disabled={!doc || doc.is_pinned}
              maxLength={DOC_TITLE_MAX}
              placeholder="Untitled"
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-lg sm:text-xl font-semibold tracking-tight text-foreground placeholder:text-muted-foreground/50 disabled:cursor-default"
            />
          </div>

          {/* Save indicator */}
          {saveIndicator && (
            <span
              className={`hidden sm:flex items-center gap-1.5 text-xs shrink-0 ${
                saveIndicator.tone === 'amber'
                  ? 'text-warning-muted-foreground'
                  : saveIndicator.tone === 'emerald'
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground'
              }`}
            >
              {saveIndicator.icon && (
                <saveIndicator.icon
                  className={`h-3.5 w-3.5 ${
                    saveIndicator.tone === 'emerald' ? 'text-success-muted-foreground' : ''
                  } ${saveIndicator.spin ? 'animate-spin' : ''}`}
                />
              )}
              {saveIndicator.text}
            </span>
          )}

          {/* Delete (non-pinned only) */}
          {doc && !doc.is_pinned && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              title="Delete canvas"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}

          {/* Close */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleClose}
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {loading && (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && loadError && (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <AlertCircle className="h-8 w-8 text-destructive mb-3" />
              <p className="text-sm font-medium text-foreground">{loadError}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Try closing and reopening the canvas.
              </p>
            </div>
          )}

          {!loading && !loadError && doc && (
            <div className="h-full">
              <PlanningEditor
                key={doc.id}
                initialContent={doc.html}
                editable
                onUpdate={setContent}
              />
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {doc?.title ? `"${doc.title}"` : 'this canvas'}?
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

  return mounted ? createPortal(overlay, document.body) : null
}
