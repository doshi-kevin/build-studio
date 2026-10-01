/**
 * StudentModuleItemRow — one piece of course material, read-only.
 *
 * Deliberately separate from the professor row rather than one component with
 * a `mode` prop: the previous build rendered the professor's card here, which
 * shipped drag-and-drop and seven professor server actions into the student
 * bundle and left three no-op callbacks wired up. This tree imports neither.
 *
 * A row is a row — not a card. The surrounding section owns the only border,
 * so a long list reads as one surface instead of a stack of nested boxes.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { Download, Maximize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MaterialViewer } from '@/components/ui/material-viewer'
import { StudentPrimerButton } from '@/components/student/primers/StudentPrimerButton'
import { logMaterialEvent } from '@/lib/events/material-events'
import {
  itemVisual,
  itemTimeEstimate,
  toDownloadUrl,
  safeExternalUrl,
  FOCUS_RING,
  type ItemContent,
} from '@/components/shared/modules/module-item-display'
import type { ModuleItemType } from '@/lib/validations/module'
import type { StudentModuleItem } from './types'

interface StudentModuleItemRowProps {
  item: StudentModuleItem
  sectionId: string
  /** This lecture has a primer the professor has made available. */
  primerAvailable?: boolean
  /** Pulsed briefly when arrived at via ?item= */
  highlighted?: boolean
  /** Citation deep link (?item=&page=N) — open the file at this page. */
  openAtPage?: number
}

/** Same chrome + tap floor as the professor row's controls. */
const ICON_BUTTON_STUDENT = `flex items-center justify-center rounded-full text-muted-foreground transition-colors min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 p-2.5 sm:p-1.5 hover:bg-muted hover:text-foreground ${FOCUS_RING}`

export function StudentModuleItemRow({
  item,
  sectionId,
  primerAvailable,
  highlighted,
  openAtPage,
}: StudentModuleItemRowProps) {
  /* A citation link names a page, so honour it by opening the file. A plain
     ?item= link still only scrolls and pulses. */
  const [viewerOpen, setViewerOpen] = useState(!!openAtPage)

  const itemType = item.item_type as ModuleItemType
  const content = (item.content ?? {}) as ItemContent

  // Section dividers are structure, not material — a labelled rule, no chrome.
  if (itemType === 'section_divider') {
    const label = typeof content.label === 'string' && content.label ? content.label : 'Section'
    return (
      <div className="flex items-center gap-3 px-4 py-3" role="separator" aria-label={label}>
        <div className="h-px flex-1 bg-border" aria-hidden />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
    )
  }

  const { Icon, chip } = itemVisual(itemType, content)
  const fileUrl = safeExternalUrl(typeof content.fileUrl === 'string' ? content.fileUrl : undefined)
  const videoUrl = safeExternalUrl(typeof content.videoUrl === 'string' ? content.videoUrl : undefined)
  const itemUrl = safeExternalUrl(typeof content.url === 'string' ? content.url : undefined)
  const fileName = (typeof content.fileName === 'string' && content.fileName) || item.title || 'file'
  const fileSize = typeof content.fileSize === 'string' ? Number(content.fileSize) : undefined
  const noteBody = itemType === 'note' && typeof content.body === 'string' ? content.body : undefined

  const externalUrl = !fileUrl ? (videoUrl ?? itemUrl) : undefined
  const isOpenable = !!fileUrl || !!externalUrl
  const timeEstimate = itemTimeEstimate(itemType, content)

  /* Content-consumption signals. The roadmap's engagement lens reads these
     (lib/roadmap/engagement.ts): `downloaded` drives the re-download signal,
     `link_clicked` the reference open-rate. Fire-and-forget — a failed log must
     never block the student from opening their material. */
  const open = () => {
    if (fileUrl) {
      void logMaterialEvent(sectionId, item.id, 'viewed')
      setViewerOpen(true)
    } else if (externalUrl) {
      void logMaterialEvent(sectionId, item.id, 'link_clicked')
      window.open(externalUrl, '_blank', 'noopener,noreferrer')
    }
  }

  const logDownload = () => void logMaterialEvent(sectionId, item.id, 'downloaded')

  // Only openable rows behave like buttons. A note, or a link whose URL was
  // never filled in, used to render identical clickable chrome and then do
  // nothing when clicked.
  const RowTag = isOpenable ? 'button' : 'div'

  return (
    <>
      <div
        id={`module-item-${item.id}`}
        className={cn(
          'flex flex-wrap items-center gap-x-1.5 gap-y-1 pb-3 pr-3 transition-colors sm:flex-nowrap sm:pb-0',
          isOpenable && 'hover:bg-muted/40',
          highlighted && 'rounded-xl ring-2 ring-primary ring-offset-2',
        )}
      >
        {/* Only the material itself is the click target; the trailing controls
            are siblings, never nested inside it. */}
        <RowTag
          {...(isOpenable ? { type: 'button' as const, onClick: open } : {})}
          className={cn('flex min-w-0 flex-1 basis-0 items-center gap-3 py-3 pl-4 text-left', isOpenable && FOCUS_RING)}
        >
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', chip)}>
            <Icon className="h-4 w-4" aria-hidden />
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {item.title || fileName}
            </p>
            {item.description && (
              <p className="line-clamp-1 text-xs text-muted-foreground">{item.description}</p>
            )}
            {noteBody && (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {noteBody}
              </p>
            )}
            {(fileUrl || timeEstimate) && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {[fileUrl ? fileName : null, timeEstimate].filter(Boolean).join('  ·  ')}
              </p>
            )}
          </div>
        </RowTag>

        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
          {primerAvailable && itemType === 'lecture' && (
            <StudentPrimerButton sectionId={sectionId} moduleItemId={item.id} />
          )}
          {fileUrl && (
            <>
              <button
                type="button"
                onClick={() => {
                  void logMaterialEvent(sectionId, item.id, 'viewed')
                  setViewerOpen(true)
                }}
                aria-label={`Open ${item.title || fileName}`}
                className={cn(ICON_BUTTON_STUDENT)}
              >
                <Maximize2 className="h-3.5 w-3.5" aria-hidden />
              </button>
              <a
                href={toDownloadUrl(fileUrl, fileName)}
                download={fileName}
                rel="noopener noreferrer"
                onClick={logDownload}
                aria-label={`Download ${fileName}`}
                className={cn(ICON_BUTTON_STUDENT)}
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
              </a>
            </>
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
          // Extracted images are intentionally not surfaced to students: the
          // set still contains duplicates and low-value fragments that aren't
          // useful as a standalone gallery (issue #556). Professors still see
          // them via ProfessorModuleItemRow. Restore this prop once the set is
          // curated enough to help students.
          initialPage={openAtPage}
          onDownload={logDownload}
        />
      )}
    </>
  )
}
