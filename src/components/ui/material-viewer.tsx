/**
 * MaterialViewer — fullscreen-capable dialog for viewing uploaded course materials.
 *
 * Supports:
 * - PDFs: embedded iframe viewer with browser-native controls
 * - Images: inline viewer with zoom in/out/reset
 * - Videos: HTML5 video player with native controls
 * - Other files: download prompt with file info
 *
 * Type: Client Component
 */
'use client'

import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import {
  Download,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  X,
  FileText,
  ClipboardList,
  Image as ImageIcon,
  Film,
  File,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  ArrowUpRight,
  Bot,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { VisuallyHidden } from 'radix-ui'
import { formatFileSize } from '@/lib/supabase/storage'
import { masteryTier, scoreLabel as fmtScore, TIER_META } from '@/lib/skills/mastery'
import { TIER_STYLES } from '@/lib/skills/tier-styles'

/** Shape of each extracted image the viewer can surface in the
 * Images tab. Mirrors `ExtractedImageData` from the validation
 * schema, but re-declared here so the UI component stays free of
 * server-only imports.
 */
export interface MaterialViewerImage {
  pageNumber: number
  storageUrl: string
  altText?: string
  pixelWidth?: number
  pixelHeight?: number
}

/** A cross-referenced node (assessed-by activity / taught-in lecture): a label and
 *  an optional node key ("quiz:<id>") that, when present, links into that node's
 *  modal. Kept as an opaque string so this generic viewer stays free of the
 *  roadmap's node-drawer types. */
export interface SkillCrossRef {
  label: string
  nodeKey?: string
}

/** Optional "what's this about" sidebar shown next to the material. */
export interface MaterialViewerDetail {
  /** One-line summary of the material. */
  summary?: string
  /** Topics covered. Clicking one activates its referencing pages (the reference
   *  rail + prev/next stepper). Optional mastery fields (used on the roadmap)
   *  surface the class score + where the concept is assessed/taught, inline. */
  topics?: {
    label: string
    /** Pages that reference this topic (semantic match), ranked. */
    pages?: number[]
    /** Pre-formatted class score, e.g. "74%" or "—". */
    scoreLabel?: string
    /** Mastery tone for the score colour (kept generic — no topic-lib import here). */
    tone?: 'weak' | 'shaky' | 'strong' | 'none'
    /** Activities that assess this concept — clickable into their node modal. */
    assessedBy?: SkillCrossRef[]
    /** Lectures where this concept is taught — clickable into their node modal. */
    taughtIn?: SkillCrossRef[]
    /** When set (student view, low mastery), a link to study this concept with
     *  the AI Tutor. Renders a "Study with AI Tutor" action under the topic. */
    studyHref?: string
  }[]
}

/** A concept shown WITHOUT a material — the viewer renders a compact panel (no
 *  PDF) with the class score and where the concept is assessed / taught. This is
 *  the roadmap's concept view; it replaces the former standalone ConceptDetail. */
export interface MaterialViewerConcept {
  name: string
  score: number | null
  /** Activities assessing this concept, each linking to its own page. */
  sources: { key: string; title: string; typeLabel: string; href: string }[]
  /** Lectures teaching it; `href` routes to the module page when it's a real item. */
  taughtIn: { title: string; href?: string }[]
}

interface MaterialViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  url: string
  fileName: string
  fileSize?: number
  mimeCategory?: 'pdf' | 'image' | 'video' | 'document' | 'unknown'
  /** For PDFs: open directly at this page number (appends #page=N to the iframe src) */
  initialPage?: number
  /** If set and non-empty, adds an "Images" tab listing extracted page images. */
  extractedImages?: MaterialViewerImage[]
  /**
   * Module item id — enables inline slide rendering for PowerPoint/Office files
   * (the `document` category) via the /api/extraction/page endpoint, the same
   * server-render path the AI tutor uses for cited slides. Requires `pageCount`.
   */
  itemId?: string
  /** Total page/slide count (from the item's extraction). Needed for slide paging. */
  pageCount?: number
  /** When set, shows a "what's this about" sidebar (summary · topics). */
  detail?: MaterialViewerDetail
  /** Pre-select a topic's reference rail on open (highlights its row + jumps to
   *  its first anchored page), as if the user clicked it inside the navigator. */
  initialTopic?: { label: string; pages?: number[] }
  /** When set, the viewer renders the compact concept panel (no PDF). */
  concept?: MaterialViewerConcept
  /** Optional analytics hook fired when the user downloads the file from the
   *  toolbar (the download itself still happens either way). */
  onDownload?: () => void
}

/** Detect file category from file name or explicit category */
function detectCategory(fileName: string, explicit?: string): 'pdf' | 'image' | 'video' | 'document' | 'unknown' {
  if (explicit && explicit !== 'unknown') return explicit as 'pdf' | 'image' | 'video' | 'document'
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return 'video'
  if (['ppt', 'pptx', 'doc', 'docx', 'txt', 'epub'].includes(ext)) return 'document'
  return 'unknown'
}

const categoryIcons = {
  pdf: FileText,
  image: ImageIcon,
  video: Film,
  document: File,
  unknown: File,
}

export function MaterialViewer({
  open,
  onOpenChange,
  url,
  fileName,
  fileSize,
  mimeCategory,
  initialPage,
  extractedImages,
  itemId,
  pageCount,
  detail,
  initialTopic,
  concept,
  onDownload,
}: MaterialViewerProps) {
  const [isFullscreen, setIsFullscreen] = useState(false)

  const category = detectCategory(fileName, mimeCategory)
  const CategoryIcon = categoryIcons[category]
  const hasDetail = !!(detail && (detail.summary || detail.topics?.length))

  // Reference rail: the currently-selected topic and the pages that reference it,
  // with a cursor the prev/next stepper walks through. The selected page is applied
  // by <MaterialBody> via the controlled `targetPage` (activePages[activeIdx]).
  const [activeTopic, setActiveTopic] = useState<string | null>(null)
  const [activePages, setActivePages] = useState<number[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [appliedTopicKey, setAppliedTopicKey] = useState<string | null>(null)

  const selectTopic = useCallback((label: string, pages: number[] | undefined) => {
    const pgs = (pages ?? []).filter((p) => p > 0)
    if (!pgs.length) return
    if (activeTopic === label) {
      // Clicking the active topic again toggles the rail off.
      setActiveTopic(null)
      setActivePages([])
      setActiveIdx(0)
      return
    }
    setActiveTopic(label)
    setActivePages(pgs)
    setActiveIdx(0)
  }, [activeTopic])

  const stepTo = useCallback((idx: number) => {
    setActivePages((pgs) => {
      if (!pgs.length) return pgs
      const next = ((idx % pgs.length) + pgs.length) % pgs.length
      setActiveIdx(next)
      return pgs
    })
  }, [])

  // Pre-select the incoming topic's rail (or clear a stale one) so a chip click
  // lands on the concept highlighted, exactly like selecting it in the navigator.
  // Adjust-state-during-render (keyed on the topic) rather than an effect — a
  // manual in-viewer selection leaves the key unchanged, so it isn't clobbered.
  const initialTopicKey = open ? `${initialTopic?.label ?? ''}|${(initialTopic?.pages ?? []).join(',')}` : null
  if (initialTopicKey !== appliedTopicKey) {
    setAppliedTopicKey(initialTopicKey)
    const pgs = (initialTopic?.pages ?? []).filter((p) => p > 0)
    const hasTopic = open && !!initialTopic?.label && pgs.length > 0
    setActiveTopic(hasTopic ? initialTopic!.label : null)
    setActivePages(hasTopic ? pgs : [])
    setActiveIdx(0)
  }

  const handleDownload = useCallback(() => { onDownload?.(); downloadFile(url, fileName) }, [url, fileName, onDownload])
  const toggleFullscreen = useCallback(() => setIsFullscreen((f) => !f), [])

  // Concept-only mode — no material to show, so render the compact concept panel
  // (class score + where it's assessed/taught) instead of the file viewer.
  if (concept) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <ConceptPanel concept={concept} />
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setIsFullscreen(false); onOpenChange(v) }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'flex flex-col gap-0 p-0 overflow-hidden',
          isFullscreen
            ? 'sm:max-w-[100vw] max-w-[100vw] w-[100vw] h-[100vh] rounded-none border-0'
            : 'sm:max-w-4xl max-w-[calc(100%-2rem)] h-[85vh]'
        )}
      >
        {/* Accessible title (visually hidden) */}
        <VisuallyHidden.Root>
          <DialogTitle>{fileName}</DialogTitle>
        </VisuallyHidden.Root>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/30 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <CategoryIcon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">{fileName}</span>
            {fileSize != null && fileSize > 0 && (
              <span className="text-xs text-muted-foreground shrink-0">
                ({formatFileSize(fileSize)})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <ToolbarButton onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </ToolbarButton>
            <ToolbarButton onClick={handleDownload} title="Download">
              <Download className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton onClick={() => onOpenChange(false)} title="Close">
              <X className="h-4 w-4" />
            </ToolbarButton>
          </div>
        </div>

        {/* Docked reference bar — shared with the resource node modals. */}
        {activePages.length > 0 && (
          <NavigatorBar
            unitNoun="page"
            activeLabel={activeTopic}
            value={activePages[activeIdx]}
            idx={activeIdx}
            total={activePages.length}
            onStep={stepTo}
            onClear={() => { setActiveTopic(null); setActivePages([]); setActiveIdx(0) }}
          />
        )}

        {/* Content area (+ optional detail sidebar) */}
        <div className="flex-1 flex min-h-0">
          <MaterialBody
            url={url}
            fileName={fileName}
            fileSize={fileSize}
            mimeCategory={mimeCategory}
            initialPage={initialPage}
            extractedImages={extractedImages}
            itemId={itemId}
            pageCount={pageCount}
            targetPage={activePages[activeIdx]}
            railPages={activePages}
            railIdx={activeIdx}
            onRailStep={stepTo}
          />

          {hasDetail && (
            <MaterialDetailAside
              detail={detail!}
              onSelectTopic={selectTopic}
              activeTopic={activeTopic}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Trigger a browser download of a file at `url` as `fileName`. Shared by the
 *  standalone viewer's toolbar and the roadmap node modal's Download button. */
export function downloadFile(url: string, fileName: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export interface MaterialBodyProps {
  url: string
  fileName: string
  fileSize?: number
  mimeCategory?: 'pdf' | 'image' | 'video' | 'document' | 'unknown'
  /** Fallback page shown when the rail isn't driving a jump (e.g. a pinned page). */
  initialPage?: number
  extractedImages?: MaterialViewerImage[]
  itemId?: string
  pageCount?: number
  /** Controlled current page from the shell's reference rail (a skill/topic jump). */
  targetPage?: number
  /** Rail pages (in rank order) + cursor, for the spatial page-tag minimap. */
  railPages?: number[]
  railIdx?: number
  onRailStep?: (idx: number) => void
  /** Preview mode: drop the file-local control strip AND the PDF's own browser
   *  toolbar, leaving just the scrolling document. For shells that embed the
   *  file as a preview and offer their own "open the full viewer" action. */
  chromeless?: boolean
}

/**
 * MaterialBody — the file-rendering column shared by the standalone MaterialViewer
 * and the roadmap's unified node modal. Renders the document itself (PDF iframe /
 * image / video / server-rendered Office slides) plus its file-local controls
 * (Document/Images tabs, zoom) and the page-tag minimap, so a file looks identical
 * whether opened on its own or as a roadmap node. The surrounding shell owns the
 * title bar, Download/Expand/Close, the docked NavigatorBar, and the skills column.
 * Current page is controlled via `targetPage` (a rail jump); clicking an extracted
 * image thumbnail jumps locally.
 */
export function MaterialBody({
  url, fileName, fileSize, mimeCategory, initialPage, extractedImages, itemId, pageCount,
  targetPage, railPages, railIdx = 0, onRailStep, chromeless,
}: MaterialBodyProps) {
  const [zoom, setZoom] = useState(1)
  const [activeTab, setActiveTab] = useState<'document' | 'images'>('document')
  const [focusedImagePage, setFocusedImagePage] = useState<number | null>(null)
  const [appliedTarget, setAppliedTarget] = useState<number | null>(null)
  // The document itself has no loading affordance of its own, and a blank white
  // frame is indistinguishable from "this item has no file". Every rail jump
  // remounts the iframe (see its key), so this re-arms on each jump too.
  const [docState, setDocState] = useState<'loading' | 'ready' | 'error'>('loading')

  const category = detectCategory(fileName, mimeCategory)
  const CategoryIcon = categoryIcons[category]
  const hasImages = !!(extractedImages && extractedImages.length > 0)
  // Office files (pptx/ppt/doc…) can't preview natively, so we hand the item to
  // DocumentDeck, which converts once via /api/extraction/pdf and caches.
  //
  // Deliberately NOT gated on pageCount. It used to be, from when this rendered a
  // slide-by-slide PNG pager that needed to know the count up front. DocumentDeck
  // does not take pageCount at all any more, so the gate guarded nothing and only
  // mis-fired: a deck whose extraction hasn't produced a count yet fell through to
  // the "cannot be previewed in the browser" branch below, while
  // /api/extraction/pdf returned a perfectly good PDF for that same item.
  //
  // Availability is DocumentDeck's job, not this gate's — it HEAD-probes the route
  // and says so plainly when the answer is no.
  const slideMode = category === 'document' && !!itemId
  // Decks now render in the PDF frame, which brings the browser's own zoom — our
  // toolbar buttons would be a second, weaker control next to it. Images still
  // need ours.
  const showZoom = category === 'image'
  const rail = railPages ?? []

  // A rail jump from the shell drives the shown page. Adjust-state-during-render
  // (keyed on targetPage) rather than an effect, so a manual image-grid jump isn't
  // clobbered on unrelated re-renders.
  if ((targetPage ?? null) !== appliedTarget) {
    setAppliedTarget(targetPage ?? null)
    if (targetPage && targetPage > 0) {
      setFocusedImagePage(targetPage)
      setActiveTab('document')
      setDocState('loading')
    }
  }

  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.25, 3)), [])
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.25, 0.25)), [])
  const handleZoomReset = useCallback(() => setZoom(1), [])

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      {/* File-local controls — tabs (when images were extracted) + zoom (images /
          rendered slides). Plain PDFs need neither, so no strip is shown. */}
      {(hasImages || showZoom) && !chromeless && (
        <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-1.5 shrink-0">
          {hasImages ? (
            <div className="flex items-center rounded-md border bg-background p-0.5">
              <TabButton active={activeTab === 'document'} onClick={() => setActiveTab('document')}>
                Document
              </TabButton>
              <TabButton active={activeTab === 'images'} onClick={() => setActiveTab('images')}>
                Images ({extractedImages!.length})
              </TabButton>
            </div>
          ) : (
            <span />
          )}
          {showZoom && (
            <div className="flex items-center gap-1">
              <ToolbarButton onClick={handleZoomOut} title="Zoom out" disabled={zoom <= 0.25}>
                <ZoomOut className="h-4 w-4" />
              </ToolbarButton>
              <span className="w-12 text-center text-xs text-muted-foreground tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <ToolbarButton onClick={handleZoomIn} title="Zoom in" disabled={zoom >= 3}>
                <ZoomIn className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton onClick={handleZoomReset} title="Reset zoom">
                <RotateCcw className="h-3.5 w-3.5" />
              </ToolbarButton>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-w-0 overflow-auto bg-muted/10 relative">
        {activeTab === 'images' && hasImages && (
          <ExtractedImagesGrid
            images={extractedImages!}
            focusedImagePage={focusedImagePage}
            onImageClick={(pageNumber) => {
              // Jump to the page in the PDF viewer. #page=N only takes effect after
              // we swap the iframe src — setting focusedImagePage + tab does both.
              setFocusedImagePage(pageNumber)
              setActiveTab('document')
            }}
          />
        )}
        {activeTab === 'document' && category === 'pdf' && (
          // Chromeless: leave only the scrolling document. Chrome/Edge honour
          // the #toolbar=0 open parameter; Firefox's pdf.js has no such switch,
          // so there the frame is grown by its toolbar's height and pulled up
          // inside this clipping wrapper, which crops the toolbar away.
          <div className={cn('relative h-full w-full', chromeless && 'overflow-hidden')}>
            <DocumentLoading state={docState} fileName={fileName} />
            <PdfFrame
              src={url}
              fileName={fileName}
              page={focusedImagePage && focusedImagePage > 0 ? focusedImagePage : initialPage}
              chromeless={chromeless}
              onState={setDocState}
            />
          </div>
        )}

        {activeTab === 'document' && category === 'image' && (
          <div className="relative w-full h-full flex items-center justify-center overflow-auto p-4">
            <DocumentLoading state={docState} fileName={fileName} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={fileName}
              onLoad={() => setDocState('ready')}
              onError={() => setDocState('error')}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
              className="max-w-full max-h-full object-contain transition-transform duration-150"
              draggable={false}
            />
          </div>
        )}

        {activeTab === 'document' && category === 'video' && (
          <div className="w-full h-full flex items-center justify-center bg-black">
            <video
              src={url}
              controls
              controlsList="nodownload"
              className="max-w-full max-h-full"
            >
              Your browser does not support the video tag.
            </video>
          </div>
        )}

        {activeTab === 'document' && slideMode && (() => {
          const slidePage = focusedImagePage && focusedImagePage > 0 ? focusedImagePage : initialPage
          return (
            <DocumentDeck
              /* Keyed on the ITEM ONLY, deliberately. Including the page here
                 remounted the whole thing on every rail jump, which re-ran the
                 availability probe and blanked the deck to a centered spinner —
                 where a PDF just moves. The page still remounts the inner frame
                 (that is how #page=N takes effect); nothing above it needs to. */
              key={itemId}
              itemId={itemId!}
              fileName={fileName}
              initialPage={slidePage}
              chromeless={chromeless}
            />
          )
        })()}

        {activeTab === 'document' && !slideMode && (category === 'document' || category === 'unknown') && (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <CategoryIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">{fileName}</p>
              {fileSize != null && fileSize > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">{formatFileSize(fileSize)}</p>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                This file type cannot be previewed in the browser.
              </p>
            </div>
            <button
              onClick={() => downloadFile(url, fileName)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Download className="h-4 w-4" />
              Download File
            </button>
          </div>
        )}

        {/* Reference rail — page-number tags for the active topic, placed along the
            right edge by page position; click a tag to jump. The docked bar above is
            the primary control; this rail is the spatial minimap. */}
        {rail.length > 0 && !!pageCount && pageCount > 1 && (
          <div className="absolute inset-y-3 right-1.5 z-20 w-12">
            <div className="relative h-full w-full">
              {(() => {
                // The rail is a spatial minimap, so render tags in PAGE order
                // (railPages is in similarity-rank order — kept for the stepper).
                // Position each by its page, nudging any that would collide down by
                // a minimum gap so numbers never overlap. Each tag keeps its rank
                // index so clicking it drives the same stepper. Keyboard/SR users
                // use the docked bar; the rail is a mouse-only shortcut (tabIndex -1).
                const total = pageCount!
                const GAP = 6 // minimum % between tag centres
                let prev = -Infinity
                return rail
                  .map((pg, idx) => ({ pg, idx }))
                  .sort((a, b) => a.pg - b.pg)
                  .map(({ pg, idx }) => {
                    const top = Math.min(Math.max(((pg - 0.5) / total) * 100, prev + GAP), 100)
                    prev = top
                    return (
                      // The pill centers on `top` via a negative margin, not
                      // `-translate-y-1/2` — the global press-feedback rule
                      // (`:active { translate: 0 1px }` in globals.css) clobbers
                      // the whole `translate` value on mousedown, which used to
                      // snap the pill ~12px down and make its own click miss.
                      <div
                        key={pg}
                        className={cn('absolute right-0 -mt-3', idx === railIdx && 'z-10')}
                        style={{ top: `${top}%` }}
                      >
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => onRailStep?.(idx)}
                          aria-label={`Go to page ${pg}`}
                          title={`Page ${pg}`}
                          // Whole pill is the hit target (h-6, min-w-6) — clicking
                          // anywhere on the chip jumps, not just on the digit.
                          className={cn(
                            'flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-[10px] font-semibold tabular-nums shadow-sm transition-[color,background-color,border-color,box-shadow,transform]',
                            idx === railIdx
                              ? 'scale-110 bg-primary text-primary-foreground'
                              : 'border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          {pg}
                        </button>
                      </div>
                    )
                  })
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Small mono section label used in the detail sidebar. */
function DetailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{children}</div>
  )
}

// Mastery tone → semantic colour (mirrors lib/topics tier styles; kept local so
// this generic viewer doesn't import the topic-mastery domain).
const TONE_DOT: Record<'weak' | 'shaky' | 'strong' | 'none', string> = {
  weak: 'bg-destructive',
  shaky: 'bg-warning',
  strong: 'bg-success',
  none: 'bg-muted-foreground/60',
}
const TONE_TEXT: Record<'weak' | 'shaky' | 'strong' | 'none', string> = {
  weak: 'text-destructive',
  shaky: 'text-warning-muted-foreground',
  strong: 'text-success-muted-foreground',
  none: 'text-muted-foreground',
}

/**
 * Concept panel (concept-only mode): the class score + where the concept is
 * assessed and taught, with links to each source. Shown when the viewer opens
 * for a concept that has no material — replaces the former ConceptDetail modal.
 */
function ConceptPanel({ concept }: { concept: MaterialViewerConcept }) {
  const tier = masteryTier(concept.score)
  return (
    <>
      <DialogHeader>
        <DialogTitle>{concept.name}</DialogTitle>
        <DialogDescription>How the class is doing, and where this concept is taught &amp; assessed.</DialogDescription>
      </DialogHeader>

      <div className="min-w-0 space-y-5">
        <div className="flex items-center gap-3">
          <span className={cn('text-3xl font-semibold tabular-nums', TIER_STYLES[tier].text)}>
            {fmtScore(concept.score)}
          </span>
          <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', TIER_STYLES[tier].badge)}>
            {TIER_META[tier].label}
          </span>
          <span className="text-xs text-muted-foreground">class score</span>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Assessed by</div>
          {concept.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not mapped to any quiz, exam, or assignment yet.</p>
          ) : (
            <div className="space-y-1.5">
              {concept.sources.map((s) => (
                <Link
                  key={s.key}
                  href={s.href}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                >
                  <ClipboardList className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{s.title}</span>
                  <span className="shrink-0 text-xs capitalize text-muted-foreground">{s.typeLabel}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {concept.taughtIn.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Taught in</div>
            <div className="flex flex-wrap gap-1.5">
              {concept.taughtIn.map((t, i) =>
                t.href ? (
                  <Link
                    key={i}
                    href={t.href}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted/50"
                  >
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    {t.title}
                  </Link>
                ) : (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs text-foreground">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    {t.title}
                  </span>
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * Docked reference-navigator bar — shows the active topic/skill, a prev/next
 * cursor over its referencing units, and a clear button. Shared by the material
 * viewer (unit = page) and the resource node modals (unit = question / section)
 * so the "anchor to the thing" affordance is identical everywhere.
 */
export function NavigatorBar({
  unitNoun,
  activeLabel,
  value,
  idx,
  total,
  onStep,
  onClear,
}: {
  /** Lower-case singular unit, e.g. "page" / "question" / "section". */
  unitNoun: string
  activeLabel: string | null
  /** The unit number shown (1-based page/question/section). */
  value: number
  idx: number
  total: number
  onStep: (idx: number) => void
  onClear: () => void
}) {
  const Unit = unitNoun.charAt(0).toUpperCase() + unitNoun.slice(1)
  return (
    // aria-live so the active target ("<label> — Question 2 of 5") is announced to
    // screen readers as the user steps or selects, since the highlight is visual.
    <div className="flex shrink-0 items-center gap-2 border-b bg-card px-3 py-1.5" aria-live="polite">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden>
        <FileText className="h-3 w-3" />
      </span>
      <span className="min-w-0 truncate text-xs font-medium text-foreground" title={activeLabel ?? undefined}>
        {activeLabel}
        <span className="sr-only"> — {Unit} {value}, reference {idx + 1} of {total}</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => onStep(idx - 1)}
          aria-label={`Previous ${unitNoun} referencing this`}
          title={`Previous ${unitNoun}`}
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {/* "Page N" / "Question N" (spelled out) so it reads as a target, not a count. */}
        <span className="min-w-[4.25rem] text-center text-xs font-medium tabular-nums text-foreground">
          {Unit} {value}
        </span>
        <button
          type="button"
          onClick={() => onStep(idx + 1)}
          aria-label={`Next ${unitNoun} referencing this`}
          title={`Next ${unitNoun}`}
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <span
          className="ml-1 shrink-0 text-[11px] tabular-nums text-muted-foreground"
          title={`Reference ${idx + 1} of ${total}`}
        >
          {idx + 1} of {total}
        </span>
        <div className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear reference navigation"
          title="Clear reference navigation"
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

/**
 * "What's this about" sidebar (V1.1 node detail): a one-line summary and the
 * topic chips. Progressive disclosure — this is revealed only once the material
 * is opened, so the collapsed roadmap node stays glanceable. Clicking a topic
 * with a page jumps the viewer there.
 */
function MaterialDetailAside({
  detail,
  onSelectTopic,
  activeTopic,
}: {
  detail: MaterialViewerDetail
  onSelectTopic: (label: string, pages: number[] | undefined) => void
  activeTopic: string | null
}) {
  return (
    <aside className="hidden sm:flex w-72 shrink-0 flex-col gap-5 overflow-auto border-l bg-card p-4">
      {detail.summary && (
        <div className="space-y-1.5">
          <DetailLabel>Summary</DetailLabel>
          <p className="text-sm leading-relaxed text-foreground">{detail.summary}</p>
        </div>
      )}

      {detail.topics && detail.topics.length > 0 && (
        <div className="space-y-1.5">
          <DetailLabel>Topics</DetailLabel>
          <SkillDetailList topics={detail.topics} activeTopic={activeTopic} onSelectTopic={onSelectTopic} unitNoun="page" />
        </div>
      )}
    </aside>
  )
}

/**
 * The clickable skill/topic rows shared by the material viewer's "what's this
 * about" sidebar and the resource node modals' right column: tone dot + label +
 * jump arrow + score, with assessed-by / taught-in beneath. A row is clickable
 * when it has referencing units (pages / questions / sections), which selects it
 * and lights the docked NavigatorBar. `unitNoun` only tunes the tooltip wording.
 */
export function SkillDetailList({
  topics,
  activeTopic,
  onSelectTopic,
  onNavigateRef,
  unitNoun = 'page',
}: {
  topics: NonNullable<MaterialViewerDetail['topics']>
  activeTopic: string | null
  onSelectTopic: (label: string, units: number[] | undefined) => void
  /** Open a cross-referenced node's modal (focused on the row's skill). */
  onNavigateRef?: (nodeKey: string, skill: string) => void
  unitNoun?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      {topics.map((t, i) => {
        const unitCount = t.pages?.length ?? 0
        const clickable = unitCount > 0
        const isActive = activeTopic === t.label
        return (
          <div key={i} className={cn('rounded-xl px-1 py-1', isActive && 'bg-primary/5')}>
            <div className="flex items-center gap-2">
              {t.tone && <span className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[t.tone])} aria-hidden />}
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onSelectTopic(t.label, t.pages)}
                  title={`Show the ${unitCount} ${unitNoun}${unitCount === 1 ? '' : 's'} referencing “${t.label}”`}
                  className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span className={cn('min-w-0 truncate text-xs group-hover:underline', isActive ? 'font-medium text-primary' : 'text-foreground')}>
                    {t.label}
                  </span>
                  {/* Jump affordance — the count lives in the NavigatorBar's "n/m". */}
                  <ArrowUpRight
                    aria-hidden
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5',
                      isActive ? 'text-primary' : 'text-muted-foreground',
                    )}
                  />
                </button>
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-xs text-foreground"
                  title={`Not tied to a specific ${unitNoun}`}
                >
                  {t.label}
                </span>
              )}
              {t.scoreLabel && (
                <span className={cn('shrink-0 text-xs font-semibold tabular-nums', t.tone ? TONE_TEXT[t.tone] : 'text-muted-foreground')}>
                  {t.scoreLabel}
                </span>
              )}
            </div>
            {t.assessedBy && t.assessedBy.length > 0 && (
              <div className="mt-0.5 pl-3.5 text-[11px] text-muted-foreground">
                Assessed by <CrossRefs items={t.assessedBy} skill={t.label} onNavigateRef={onNavigateRef} />
              </div>
            )}
            {t.taughtIn && t.taughtIn.length > 0 && (
              <div className="pl-3.5 text-[11px] text-muted-foreground">
                Taught in <CrossRefs items={t.taughtIn} skill={t.label} onNavigateRef={onNavigateRef} />
              </div>
            )}
            {t.studyHref && (
              <a
                href={t.studyHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 ml-3.5 inline-flex items-center gap-1 rounded-md text-[11px] font-medium text-primary hover:underline"
              >
                <Bot className="h-3 w-3" />
                Study this with AI Tutor
                <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Comma-separated cross-reference labels; each becomes a link into its node's
 *  modal (focused on `skill`) when it carries a nodeKey and a handler is given. */
function CrossRefs({ items, skill, onNavigateRef }: {
  items: SkillCrossRef[]
  skill: string
  onNavigateRef?: (nodeKey: string, skill: string) => void
}) {
  return (
    <>
      {items.map((it, i) => (
        <span key={i}>
          {i > 0 ? ', ' : ''}
          {it.nodeKey && onNavigateRef ? (
            // A role=button span (not <button>) so the label flows inline with the
            // "Assessed by …" sentence and wraps word-by-word, left-aligned — a real
            // <button> is forced to inline-block and drops to its own centered line.
            <span
              role="button"
              tabIndex={0}
              onClick={() => onNavigateRef(it.nodeKey!, skill)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onNavigateRef(it.nodeKey!, skill)
                }
              }}
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {it.label}
            </span>
          ) : (
            it.label
          )}
        </span>
      ))}
    </>
  )
}

/**
 * Inline slide/page viewer for Office files (pptx/ppt/doc). Each page is
 * rendered server-side to PNG by /api/extraction/page (PPTX→PDF via LibreOffice,
 * cached) — the same endpoint the AI tutor uses. Pages through the deck with
 * prev/next and respects the toolbar zoom.
 */
/** Overlay for the document itself while it loads (or if it won't). Absolute so
 *  the frame underneath keeps its layout; `pointer-events-none` so a loaded-but-
 *  slow-painting PDF is still scrollable. Matches DocumentSlides' treatment. */
type DocState = 'loading' | 'ready' | 'error'

/**
 * The embedded PDF frame, shared by real PDFs (signed storage URL) and office
 * decks (/api/extraction/pdf). Extracted when decks moved onto it, because every
 * quirk below had to hold for both — and each was a bug once.
 */
function PdfFrame({
  src,
  fileName,
  page,
  chromeless,
  onState,
}: {
  src: string
  fileName: string
  page?: number
  chromeless?: boolean
  onState: (s: DocState) => void
}) {
  return (
    <iframe
      /* Re-key on the target page so a jump REMOUNTS the iframe: a browser ignores
         a hash-only `src` change on an already-loaded iframe (and a PDF document
         can't be scripted), so the page link would otherwise do nothing.
         `chromeless` is in the key for the same reason — toolbar=0 is read at
         document load, so toggling full screen has to reload or Chrome keeps the
         cropped toolbar it was given (Firefox hides it in CSS and would look fine,
         which is exactly how this shipped unnoticed). */
      key={`pdf-${chromeless ? 'bare' : 'full'}-${page ?? 1}`}
      src={(() => {
        const params = [page && page > 1 ? `page=${page}` : '', chromeless ? 'toolbar=0' : ''].filter(Boolean)
        return params.length ? `${src}#${params.join('&')}` : src
      })()}
      title={fileName}
      /* The embedded viewer picks its theme from the OS, not from us, so on a
         dark-mode machine the page sits in a near-black surround inside our
         light-only UI. color-scheme propagates into the nested browsing context,
         which flips it back to the light chrome. */
      style={{ colorScheme: 'light' }}
      className={cn(
        'w-full h-full border-0',
        chromeless && 'supports-[-moz-appearance:none]:-mt-8 supports-[-moz-appearance:none]:h-[calc(100%+2rem)]',
      )}
      onLoad={() => onState('ready')}
      onError={() => onState('error')}
    />
  )
}

function DocumentLoading({ state, fileName }: { state: DocState; fileName: string }) {
  if (state === 'ready') return null
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center bg-muted/10 pt-12">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {state === 'loading' ? (
          <><Loader2 className="h-4 w-4 animate-spin" /> Loading document…</>
        ) : (
          <><AlertCircle className="h-4 w-4 shrink-0" /> Couldn&apos;t load {fileName}.</>
        )}
      </div>
    </div>
  )
}

/**
 * An office deck (PPTX/PPT), shown as ONE SCROLLING DOCUMENT — the same frame a
 * PDF gets, pointed at /api/extraction/pdf, which converts once and caches.
 *
 * This replaced a slide-by-slide PNG pager. Decks are read the way PDFs are (scroll,
 * pinch-zoom, Ctrl+F over real text), and page jumps from the skills rail land the
 * same way, because it is literally the same viewer.
 *
 * The HEAD probe is what keeps a failure honest: an iframe's `onLoad` fires even
 * for a 415 body, so without it a converter-down deck would render the route's
 * error TEXT inside our chrome. The probe costs nothing real — the response is
 * `private, max-age=300`, so the frame's own GET is served from the browser cache.
 */
function DocumentDeck({
  itemId,
  fileName,
  initialPage,
  chromeless,
}: {
  itemId: string
  fileName: string
  initialPage?: number
  chromeless?: boolean
}) {
  const src = `/api/extraction/pdf?item=${encodeURIComponent(itemId)}`
  const [available, setAvailable] = useState<'checking' | 'yes' | 'no'>('checking')
  const [frameState, setFrameState] = useState<DocState>('loading')

  // No reset of `available` here: the parent keys this component on the item (and
  // the target page), so a different deck arrives as a fresh mount already in
  // 'checking' — and resetting inside the effect is a cascading render.
  useEffect(() => {
    let cancelled = false
    fetch(src, { method: 'HEAD' })
      .then((res) => {
        if (!cancelled) setAvailable(res.ok ? 'yes' : 'no')
      })
      .catch(() => {
        if (!cancelled) setAvailable('no')
      })
    return () => {
      cancelled = true
    }
  }, [src])

  if (available === 'checking') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Preparing {fileName}…
      </div>
    )
  }

  if (available === 'no') {
    // A real dead end, said plainly (.claude/rules/dead-ends.md) — not a blank
    // frame and not the browser's error page.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          This deck can&apos;t be previewed right now. Download it to open in PowerPoint.
        </p>
      </div>
    )
  }

  return (
    <div className={cn('relative h-full w-full', chromeless && 'overflow-hidden')}>
      <DocumentLoading state={frameState} fileName={fileName} />
      <PdfFrame
        src={src}
        fileName={fileName}
        page={initialPage}
        chromeless={chromeless}
        onState={setFrameState}
      />
    </div>
  )
}

/** Tab pill used to switch between "Document" and "Images". */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2 py-0.5 text-[11px] font-medium rounded transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** Grid of extracted page images. Grouped by pageNumber, click to jump. */
function ExtractedImagesGrid({
  images,
  focusedImagePage,
  onImageClick,
}: {
  images: MaterialViewerImage[]
  focusedImagePage: number | null
  onImageClick: (pageNumber: number) => void
}) {
  // Group by page so a single slide with multiple images renders together.
  const byPage = new Map<number, MaterialViewerImage[]>()
  for (const img of images) {
    const existing = byPage.get(img.pageNumber) ?? []
    existing.push(img)
    byPage.set(img.pageNumber, existing)
  }
  const orderedPages = Array.from(byPage.keys()).sort((a, b) => a - b)

  return (
    <div className="p-4 space-y-6">
      {orderedPages.map((pageNumber) => {
        const pageImages = byPage.get(pageNumber)!
        const isFocused = focusedImagePage === pageNumber
        return (
          <section key={pageNumber}>
            <h3 className="mb-2 text-[11px] uppercase tracking-widest font-semibold text-muted-foreground">
              Page {pageNumber} · {pageImages.length} {pageImages.length === 1 ? 'image' : 'images'}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {pageImages.map((img, idx) => (
                <button
                  key={`${pageNumber}-${idx}`}
                  type="button"
                  onClick={() => onImageClick(pageNumber)}
                  className={cn(
                    'group relative rounded-xl border bg-background overflow-hidden text-left transition-[box-shadow,transform,border-color] hover:-translate-y-0.5 hover:shadow-sm',
                    isFocused && 'border-[1.5px] border-foreground',
                  )}
                  title={`Jump to page ${pageNumber}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.storageUrl}
                    alt={img.altText || `Page ${pageNumber} image`}
                    loading="lazy"
                    className="w-full h-32 object-contain bg-muted/20"
                  />
                  <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    {img.altText ?? `Page ${pageNumber}`}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** Small toolbar icon button */
function ToolbarButton({
  children,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'p-1.5 rounded-md transition-colors',
        disabled
          ? 'text-muted-foreground/30 cursor-not-allowed'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
      )}
    >
      {children}
    </button>
  )
}
