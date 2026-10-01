/**
 * ProfessorModuleItemRow — one item inside a module, with its controls.
 *
 * A row, not a card: the section owns the only border. Row actions stay hidden
 * until hover on pointer screens but are ALWAYS present below `sm` and appear
 * on keyboard focus (`group-focus-within`), because the previous build used
 * bare `opacity-0 group-hover` with native `title` attributes — unreachable by
 * touch and invisible to assistive tech.
 *
 * What's deliberately gone: the extraction telemetry line
 * ("93 pages · 26 images · 454 formulas"). Page count survives as a time
 * estimate; the rest was pipeline internals on a professor's screen. Only
 * states the professor can act on — processing, failed — still surface.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlertCircle,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  GripVertical,
  Maximize2,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCcw,
  Bot,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { MaterialViewer } from '@/components/ui/material-viewer'
import {
  itemVisual,
  itemTimeEstimate,
  itemExtractionDisplay,
  toViewerImages,
  toDownloadUrl,
  safeExternalUrl,
  FOCUS_RING,
  type ItemContent,
} from '@/components/shared/modules/module-item-display'
import {
  extractDocumentContent,
  enqueueExtractionJobAction,
  isExtractionV2Enabled,
} from '@/app/(dashboard)/professor/courses/[sectionId]/modules/actions'
import { PrimerControl, type PrimerState } from './PrimerControl'
import { ROW_ACTIONS, ICON_BUTTON, RowAction } from './ModuleRowActions'
import { MODULE_ITEM_TYPE_INFO, type ModuleItemType } from '@/lib/validations/module'
import type { ModuleItem } from '@/lib/supabase/types'

interface ProfessorModuleItemRowProps {
  item: ModuleItem
  moduleId: string
  sectionId: string
  primersEnabled?: boolean
  primerState?: PrimerState
  /** Read-only preview of the student view: no reordering, no editing. */
  studentPreview?: boolean
  /** The board's `reorderable` — false under any search/status filter, where a
   *  drag would write an order computed against rows that aren't on screen.
   *  Defaults true so callers that never filter keep item drag. */
  reorderable?: boolean
  /** This row has a mutation in flight — show it here, not 1800px up the page. */
  pending?: boolean
  /** Citation deep link (?item=&page=N) — open the file at this page. */
  openAtPage?: number
  onEdit: () => void
  onDelete: () => void
  onToggleVisibility: () => void
}

export function ProfessorModuleItemRow({
  item,
  moduleId,
  sectionId,
  primersEnabled,
  primerState,
  studentPreview,
  reorderable = true,
  pending,
  openAtPage,
  onEdit,
  onDelete,
  onToggleVisibility,
}: ProfessorModuleItemRowProps) {
  /* A citation link names a page, so honour it by opening the file. A plain
     ?item= link still only scrolls. */
  const [viewerOpen, setViewerOpen] = useState(!!openAtPage)
  const [isRetrying, setIsRetrying] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { type: 'item', moduleId },
    /* Also off whenever the board is non-reorderable — i.e. under any search or
       status filter. Not cosmetic: the section renders `visibleItemsByModule`
       (filtered) while the board's drag handler computes indices against
       `itemsByModule` (unfiltered), so a drag on a filtered list writes the wrong
       order — items jump over rows that were never on screen. The board's note
       promises reordering is off while filtering; this is what makes that true one
       level down. */
    disabled: studentPreview || !reorderable,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }

  const itemType = item.item_type as ModuleItemType
  const content = (item.content ?? {}) as ItemContent

  /* One leading slot, three states — the same rule the module header applies a
     level up (`showGrip`/`showSpinner`/`padForMissingGrip` in
     ProfessorModuleSection). A grip renders only where a drag can actually
     land: under a search or status filter `reorderable` is false and the
     sortable above is already disabled, so a grip drawn there is keyboard-
     focusable, reads as grabbable, and moves nothing.

     Scope note: the three-state rule holds for the item branch below. The
     divider branch uses `canReorder` only — it has no saving spinner, so a
     divider rename/delete gives no in-row feedback. Pre-existing. */
  const canReorder = !studentPreview && reorderable
  const showSpinner = !studentPreview && !!pending
  const showGrip = canReorder && !pending
  const padForMissingGrip = !showGrip && !showSpinner

  // Dividers are structure — a labelled rule with its own small actions.
  if (itemType === 'section_divider') {
    const label = typeof content.label === 'string' && content.label ? content.label : 'Section'
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn('group flex items-center gap-3 px-4 py-3', isDragging && 'opacity-50')}
      >
        {canReorder && (
          <button
            type="button"
            aria-label={`Reorder ${label}`}
            className={cn(
              "flex cursor-grab text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing",
              "min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center",
              FOCUS_RING,
            )}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
        )}
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="h-px flex-1 bg-border" />
        {!studentPreview && (
          <div className={ROW_ACTIONS}>
            <RowAction icon={Pencil} label={`Edit ${label}`} onClick={onEdit} />
            <RowAction icon={Trash2} label={`Delete ${label}`} onClick={onDelete} destructive />
          </div>
        )}
      </div>
    )
  }

  const { Icon, chip } = itemVisual(itemType, content)
  const fileUrl = safeExternalUrl(typeof content.fileUrl === 'string' ? content.fileUrl : undefined)
  /* Reference/Link items keep their address in content.url (video in content.videoUrl),
     never content.fileUrl — so reading fileUrl alone left every URL-only item with no way
     to open it from this board, including in the board's own "Student view" preview.
     Resolved exactly as StudentModuleItemRow does, safeExternalUrl included: that helper
     is what keeps a `javascript:` URL from becoming clickable, so it must not be bypassed
     here or the professor side becomes the weaker path. */
  const videoUrl = safeExternalUrl(typeof content.videoUrl === 'string' ? content.videoUrl : undefined)
  const itemUrl = safeExternalUrl(typeof content.url === 'string' ? content.url : undefined)
  const externalUrl = !fileUrl ? (videoUrl ?? itemUrl) : undefined
  const fileName =
    (typeof content.fileName === 'string' && content.fileName) || item.title || 'file'
  const fileSize = typeof content.fileSize === 'string' ? Number(content.fileSize) : undefined
  const timeEstimate = itemTimeEstimate(itemType, content)
  const extraction = itemExtractionDisplay(itemType, content)
  /* Titles are optional on items. Falling back to `fileName` labelled an untitled Note
     "file"; use the item type's own label (the same one the add-item popover shows) so
     the row says what the thing actually is. */
  const typeLabel = MODULE_ITEM_TYPE_INFO.find((t) => t.key === itemType)?.label ?? 'Item'
  const title =
    item.title || (typeof content.fileName === 'string' && content.fileName) || typeLabel
  const isQuizUpload = !!content.quizUpload

  const retryExtraction = async () => {
    setIsRetrying(true)
    try {
      // V2 enqueues into the durable worker queue; V1 runs inline via the
      // legacy action. Flag-gated so it can flip per environment.
      const v2 = await isExtractionV2Enabled()
      const result = v2
        ? await enqueueExtractionJobAction(item.id, sectionId)
        : await extractDocumentContent(item.id, sectionId)
      if (result?.error) toast.error(result.error)
      else toast.success('Reading this file again…')
    } catch {
      toast.error('Could not retry — please try again')
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        id={`module-item-${item.id}`}
        className={cn(
          'group flex flex-wrap items-center gap-x-1.5 gap-y-1 pb-3 pr-3 transition-colors hover:bg-muted/40 sm:flex-nowrap sm:pb-0',
          isDragging && 'opacity-50',
          !item.is_visible && 'bg-muted/20',
        )}
      >
        {showSpinner && (
          <span className="py-3 pl-2 text-muted-foreground" aria-live="polite" aria-label="Saving">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          </span>
        )}
        {showGrip && (
          <button
            type="button"
            aria-label={`Reorder ${title}`}
            className={cn(
              "flex cursor-grab text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing",
              "min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center py-3 pl-2",
              FOCUS_RING,
            )}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
        )}

        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
            /* Keep one left edge whether or not a grip is there to drag — the
               module header pads its title the same way. */
            padForMissingGrip && 'ml-4',
            chip,
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </div>

        <div className={cn('ml-3 min-w-0 flex-1 basis-0 py-3', !item.is_visible && 'opacity-70')}>
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{title}</p>
            {!item.is_visible && (
              <Badge variant="outline" className="shrink-0 text-xs">
                Hidden
              </Badge>
            )}
            {isQuizUpload && (
              <Badge className="shrink-0 gap-1 bg-ai-muted text-ai-muted-foreground hover:bg-ai-muted">
                <Bot className="h-3 w-3" aria-hidden />
                Quiz upload
              </Badge>
            )}
            {item.instructor_note && !studentPreview && (
              <MessageSquare
                className="h-3 w-3 shrink-0 text-warning-muted-foreground"
                aria-label="Has a private note"
              />
            )}
          </div>

          {item.description && (
            <p className="line-clamp-1 text-xs text-muted-foreground">{item.description}</p>
          )}

          {(fileUrl || timeEstimate) && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {[fileUrl ? fileName : null, timeEstimate].filter(Boolean).join('  ·  ')}
            </p>
          )}

          {extraction === 'processing' && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
              Reading this file…
            </p>
          )}
          {extraction === 'failed' && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertCircle className="h-3 w-3 text-destructive" aria-hidden />
              Couldn’t read this file
              <button
                type="button"
                onClick={retryExtraction}
                disabled={isRetrying}
                className="inline-flex items-center gap-0.5 text-primary hover:underline disabled:opacity-50"
              >
                <RotateCcw
                  className={cn('h-3 w-3', isRetrying && 'animate-spin motion-reduce:animate-none')}
                  aria-hidden
                />
                Retry
              </button>
            </p>
          )}
        </div>

        {/* Full width below sm so the title above never gets squeezed to 0. */}
        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
          {primersEnabled && itemType === 'lecture' && !studentPreview && (
            <PrimerControl
              sectionId={sectionId}
              moduleItemId={item.id}
              initialState={primerState ?? { status: 'none', available: false }}
            />
          )}

          {studentPreview ? (
            externalUrl ? (
              <RowAction
                icon={ExternalLink}
                label={`Open ${title}`}
                onClick={() => window.open(externalUrl, '_blank', 'noopener,noreferrer')}
              />
            ) : (
            fileUrl && (
              /* Mirror the real student row exactly, Download included — a
                 preview a professor can't trust is worse than no preview. */
              <>
                <RowAction
                  icon={Maximize2}
                  label={`Open ${fileName}`}
                  onClick={() => setViewerOpen(true)}
                />
                <a
                  href={toDownloadUrl(fileUrl, fileName)}
                  download={fileName}
                  rel="noopener noreferrer"
                  aria-label={`Download ${fileName}`}
                  className={cn(ICON_BUTTON, 'hover:bg-muted hover:text-foreground')}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                </a>
              </>
            )
            )
          ) : (
            <div className={ROW_ACTIONS}>
              {fileUrl && (
                <RowAction
                  icon={Maximize2}
                  label={`Open ${fileName}`}
                  onClick={() => setViewerOpen(true)}
                />
              )}
              {externalUrl && (
                <RowAction
                  icon={ExternalLink}
                  label={`Open ${title}`}
                  onClick={() => window.open(externalUrl, '_blank', 'noopener,noreferrer')}
                />
              )}
              <RowAction
                icon={item.is_visible ? Eye : EyeOff}
                label={
                  item.is_visible ? `Hide ${title} from students` : `Show ${title} to students`
                }
                onClick={onToggleVisibility}
              />
              <RowAction icon={Pencil} label={`Edit ${title}`} onClick={onEdit} />
              <RowAction icon={Trash2} label={`Delete ${title}`} onClick={onDelete} destructive />
            </div>
          )}
        </div>
      </div>

      {fileUrl && (
        <MaterialViewer
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          url={fileUrl}
          fileName={fileName}
          fileSize={Number.isFinite(fileSize) ? fileSize : undefined}
          extractedImages={toViewerImages((content.extraction as ItemContent | undefined)?.images)}
          initialPage={openAtPage}
        />
      )}
    </>
  )
}
