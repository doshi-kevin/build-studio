// Upload-deck flow shown inside the live presenter when the room has no
// deck attached yet. Two tabs: "From Modules" (pick an existing lecture from
// course modules) and "Upload" (drag-drop a new file). PDF and — when the
// converter is enabled — PowerPoint (.pptx/.ppt) are accepted; both feed the
// same render pipeline once the source lands at {roomId}/source.<ext>
// (PPT/PPTX is converted to PDF server-side by the render route).

'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload,
  FileText,
  AlertCircle,
  Loader2,
  RefreshCw,
  FileUp,
  BookOpen,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { MAX_DECK_BYTES, MAX_PPTX_BYTES, MAX_DECK_PAGES } from '@/lib/validations/live-classroom'
import {
  createDeckUploadUrl,
  getDeckUploadConfig,
  getModuleDeckItems,
  applyModuleItemAsDeck,
} from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import type { ModuleDeckItem } from '@/app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions'
import type { DeckRenderState } from '@/lib/live-classroom/broadcast/use-slide-sync'
import { SPRING, SPRING_SNAPPY } from '@/lib/motion'

type DeckExt = 'pdf' | 'pptx' | 'ppt'

const CONTENT_TYPE_BY_EXT: Record<DeckExt, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
}

function deckExtFromName(name: string): DeckExt | null {
  const n = name.toLowerCase()
  if (n.endsWith('.pdf')) return 'pdf'
  if (n.endsWith('.pptx')) return 'pptx'
  if (n.endsWith('.ppt')) return 'ppt'
  return null
}

const MB = 1024 * 1024

/** Coarse lifecycle the pre-class setup screen reacts to. */
export type DeckSetupPhase = 'choosing' | 'working' | 'ready' | 'error'

interface UploadDeckDialogProps {
  roomId: string
  sectionId: string
  deckRender: DeckRenderState | null
  onResetDeckRender?: () => void
  /** Fired after a deck finishes rendering successfully. Used by the
   *  add-deck modal to close itself once the new deck is live. */
  onUploaded?: () => void
  /** Pre-class setup mode: render the deck WITHOUT activating it on the room
   *  (the professor activates it via "Start class"), and surface lifecycle to
   *  the parent setup screen instead of auto-dismissing on success. */
  initialSetup?: boolean
  /** (setup mode) Coarse phase changes so the parent can show the config panel
   *  and enable "Start class". */
  onPhaseChange?: (phase: DeckSetupPhase) => void
  /** (setup mode) The chosen deck's display title, for prefilling the session name. */
  onDeckTitle?: (title: string) => void
  /** (setup mode) The rendered deck's id, once it's ready to present. */
  onReady?: (deckId: string) => void
}

type UploadState = 'idle' | 'uploading-to-storage' | 'processing' | 'ready' | 'error'
type ActiveTab = 'modules' | 'upload'

function putToSignedUrl(
  signedUrl: string,
  token: string,
  file: File,
  onProgress: (pct: number) => void,
  contentType: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', signedUrl)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.min(100, (e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100)
        resolve()
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload was cancelled'))
    xhr.send(file)
  })
}

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return `${fallback} (HTTP ${response.status})`
  try {
    const data = JSON.parse(text) as { error?: string }
    if (data?.error) return data.error
  } catch {
    const firstLine = text.split('\n')[0].slice(0, 200)
    if (firstLine) return `${firstLine} (HTTP ${response.status})`
  }
  return `${fallback} (HTTP ${response.status})`
}

function formatFileSize(sizeStr: string): string {
  const bytes = parseInt(sizeStr, 10)
  if (isNaN(bytes)) return sizeStr || ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ── Stagger animation variants for module list ── */
const listContainerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.1,
    },
  },
}

const listItemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: SPRING,
  },
}

const groupHeaderVariants = {
  hidden: { opacity: 0, x: -6 },
  visible: {
    opacity: 1,
    x: 0,
    transition: SPRING,
  },
}

export function UploadDeckDialog({
  roomId,
  sectionId,
  deckRender,
  onResetDeckRender,
  onUploaded,
  initialSetup = false,
  onPhaseChange,
  onDeckTitle,
  onReady,
}: UploadDeckDialogProps) {
  const router = useRouter()
  const [state, setState] = useState<UploadState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [lastSourcePath, setLastSourcePath] = useState<string | null>(null)
  const [lastDeckId, setLastDeckId] = useState<string | null>(null)

  // Module picker state
  const [activeTab, setActiveTab] = useState<ActiveTab>('modules')
  const [moduleItems, setModuleItems] = useState<ModuleDeckItem[]>([])
  const [loadingModules, setLoadingModules] = useState(true)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [copyingFromModule, setCopyingFromModule] = useState(false)

  // Whether PowerPoint upload is available (Gotenberg converter wired up).
  const [pptxEnabled, setPptxEnabled] = useState(false)
  // Tracks the format of the in-flight upload so the processing UI can show
  // an honest "Converting PowerPoint…" phase before render progress arrives.
  const [uploadedExt, setUploadedExt] = useState<DeckExt>('pdf')

  // Fetch module deck items + upload capability on mount
  useEffect(() => {
    let cancelled = false
    async function fetchItems() {
      setLoadingModules(true)
      const [config, result] = await Promise.all([
        getDeckUploadConfig(),
        getModuleDeckItems(sectionId),
      ])
      if (cancelled) return
      setPptxEnabled(config.pptxEnabled)
      setModuleItems(result.items)
      setLoadingModules(false)
      if (result.items.length === 0) {
        setActiveTab('upload')
      }
    }
    fetchItems()
    return () => { cancelled = true }
  }, [sectionId])

  const triggerRender = useCallback(
    async (deckId: string, sourcePath: string): Promise<void> => {
      onResetDeckRender?.()
      setState('processing')
      const response = await fetch('/api/live-classroom/render-deck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // In pre-class setup, render but DON'T activate — "Start class" activates it.
        body: JSON.stringify({ roomId, deckId, sourcePath, activate: !initialSetup }),
      })

      if (!response.ok) {
        const message = await parseErrorMessage(response, 'Failed to process PDF')
        setErrorMessage(message)
        setState('error')
        return
      }

      const data = (await response.json().catch(() => null)) as { pageCount?: number } | null

      // Setup mode: the deck is rendered but not yet live. Park on a "ready"
      // state and hand off to the parent setup screen (which owns "Start class")
      // instead of refreshing into the presenter.
      if (initialSetup) {
        setState('ready')
        onReady?.(deckId)
        return
      }

      toast.success(`Deck uploaded successfully (${data?.pageCount ?? 0} slides)`)
      setState('idle')
      router.refresh()
      onUploaded?.()
    },
    [roomId, router, onResetDeckRender, onUploaded, initialSetup, onReady],
  )

  // Handle "Use this presentation" from module picker
  const handleUseModuleItem = useCallback(async () => {
    if (!selectedItemId || copyingFromModule) return
    setCopyingFromModule(true)
    setErrorMessage(null)
    onResetDeckRender?.()
    const picked = moduleItems.find((i) => i.id === selectedItemId)
    if (picked) onDeckTitle?.(picked.title)

    try {
      const result = await applyModuleItemAsDeck({ roomId, moduleItemId: selectedItemId })
      if (result.error || !result.path || !result.deckId) {
        setErrorMessage(result.error ?? 'Failed to prepare module lecture')
        setState('error')
        setCopyingFromModule(false)
        return
      }

      setLastSourcePath(result.path)
      setLastDeckId(result.deckId)
      await triggerRender(result.deckId, result.path)
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Network error. Please check your connection and try again.'
      setErrorMessage(message)
      setState('error')
    } finally {
      setCopyingFromModule(false)
    }
  }, [roomId, selectedItemId, copyingFromModule, onResetDeckRender, triggerRender, moduleItems, onDeckTitle])

  const handleUpload = useCallback(
    async (file: File) => {
      const ext = deckExtFromName(file.name)
      if (!ext || (ext !== 'pdf' && !pptxEnabled)) {
        setErrorMessage(
          pptxEnabled
            ? 'Please upload a PDF or PowerPoint (.pptx/.ppt) file.'
            : 'Please upload a PDF file.',
        )
        setState('error')
        return
      }

      const sizeCap = ext === 'pdf' ? MAX_DECK_BYTES : MAX_PPTX_BYTES
      if (file.size > sizeCap) {
        setErrorMessage(
          ext === 'pdf'
            ? `File too large. Maximum size is ${Math.round(sizeCap / MB)} MB.`
            : `PowerPoint files can be up to ${Math.round(sizeCap / MB)} MB. For larger decks, export to PDF.`,
        )
        setState('error')
        return
      }

      setUploadedExt(ext)
      setState('uploading-to-storage')
      setErrorMessage(null)
      setUploadProgress(0)
      onResetDeckRender?.()
      onDeckTitle?.(file.name.replace(/\.(pdf|pptx|ppt)$/i, ''))

      try {
        const urlResult = await createDeckUploadUrl({ roomId, extension: ext, title: file.name })
        if (urlResult.error || !urlResult.signedUrl || !urlResult.token || !urlResult.path || !urlResult.deckId) {
          setErrorMessage(urlResult.error ?? 'Failed to prepare upload')
          setState('error')
          return
        }

        await putToSignedUrl(
          urlResult.signedUrl,
          urlResult.token,
          file,
          setUploadProgress,
          CONTENT_TYPE_BY_EXT[ext],
        )
        setLastSourcePath(urlResult.path)
        setLastDeckId(urlResult.deckId)

        await triggerRender(urlResult.deckId, urlResult.path)
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Network error. Please check your connection and try again.'
        setErrorMessage(message)
        setState('error')
      }
    },
    [roomId, pptxEnabled, onResetDeckRender, triggerRender, onDeckTitle],
  )

  const handleRenderRetry = useCallback(async () => {
    if (!lastSourcePath || !lastDeckId) return
    setErrorMessage(null)
    try {
      await triggerRender(lastDeckId, lastSourcePath)
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Network error. Please check your connection and try again.'
      setErrorMessage(message)
      setState('error')
    }
  }, [lastSourcePath, lastDeckId, triggerRender])

  const handleStartOver = useCallback(() => {
    setState('idle')
    setErrorMessage(null)
    setUploadProgress(0)
    setLastSourcePath(null)
    setLastDeckId(null)
    setCopyingFromModule(false)
    setSelectedItemId(null)
    onResetDeckRender?.()
  }, [onResetDeckRender])

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        handleUpload(file)
      }
    },
    [handleUpload],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) {
        handleUpload(file)
      }
    },
    [handleUpload],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const broadcastFailureMessage =
    deckRender?.failed
      ? (deckRender.reason === 'convert'
          ? "We couldn't convert your PowerPoint. Try again, or upload a PDF instead."
          : deckRender.reason === 'render'
            ? `Rendering page ${deckRender.page ?? '?'} failed. Please try again.`
            : deckRender.reason === 'upload'
              ? `Uploading page ${deckRender.page ?? '?'} to storage failed. Please try again.`
              : 'The presentation could not be processed. Please try again.')
      : null

  const effectiveState: UploadState =
    state === 'processing' && broadcastFailureMessage ? 'error' : state
  const effectiveErrorMessage = errorMessage ?? broadcastFailureMessage

  // Surface coarse phase to the pre-class setup screen so it can reveal the
  // config panel and enable "Start class".
  useEffect(() => {
    if (!onPhaseChange) return
    const phase: DeckSetupPhase =
      effectiveState === 'ready'
        ? 'ready'
        : effectiveState === 'error'
          ? 'error'
          : effectiveState === 'uploading-to-storage' || effectiveState === 'processing'
            ? 'working'
            : 'choosing'
    onPhaseChange(phase)
  }, [effectiveState, onPhaseChange])

  // Group module items by module name for display
  const groupedItems = moduleItems.reduce<Record<string, ModuleDeckItem[]>>((acc, item) => {
    if (!acc[item.moduleName]) acc[item.moduleName] = []
    acc[item.moduleName].push(item)
    return acc
  }, {})

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="rounded-3xl border border-border bg-background min-h-[60vh] flex items-center justify-center p-6 sm:p-12"
    >
      {effectiveState === 'ready' ? (
        <div className="flex flex-col items-center text-center max-w-md w-full">
          <div className="rounded-full bg-success-muted p-5 mb-6 border border-border">
            <Check className="h-10 w-10 text-success-muted-foreground" aria-hidden="true" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-2">Slides ready</h2>
          <p className="text-sm text-muted-foreground">
            Your presentation is prepared. Finish the settings and start the class when you&apos;re ready.
          </p>
        </div>
      ) : effectiveState === 'uploading-to-storage' || effectiveState === 'processing' ? (
        <div className="flex flex-col items-center text-center max-w-md w-full">
          <div className="rounded-full bg-muted/40 p-5 mb-6 border border-border">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-2">
            {effectiveState === 'uploading-to-storage' ? (
              <>Uploading your {uploadedExt === 'pdf' ? 'PDF' : 'file'}…</>
            ) : uploadedExt !== 'pdf' && (!deckRender || deckRender.totalPages === 0) ? (
              <>Converting your PowerPoint…</>
            ) : (
              <>Rendering slides…</>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            This may take a moment for larger presentations. Please keep this tab open.
          </p>

          {effectiveState === 'uploading-to-storage' && (
            <div className="mt-6 w-full max-w-xs">
              <div className="h-[3px] rounded-full bg-muted/60 overflow-hidden">
                <motion.div
                  className="h-full bg-foreground/80"
                  initial={false}
                  animate={{ width: `${uploadProgress}%` }}
                  transition={SPRING}
                />
              </div>
              <p className="mt-2 text-xs uppercase tracking-widest font-semibold text-muted-foreground tabular-nums">
                {uploadProgress.toFixed(0)}%
              </p>
            </div>
          )}

          {state === 'processing' && deckRender && !deckRender.failed && deckRender.totalPages > 0 && (
            <div className="mt-6 w-full max-w-xs">
              <div className="h-[3px] rounded-full bg-muted/60 overflow-hidden">
                <motion.div
                  className="h-full bg-foreground/80"
                  initial={false}
                  animate={{
                    width: `${Math.min(100, (deckRender.pagesRendered / deckRender.totalPages) * 100)}%`,
                  }}
                  transition={SPRING}
                />
              </div>
              <p className="mt-2 text-xs uppercase tracking-widest font-semibold text-muted-foreground tabular-nums">
                {deckRender.pagesRendered} of {deckRender.totalPages} pages
              </p>
            </div>
          )}

          <div className="mt-6 inline-flex items-center gap-1.5 text-xs uppercase tracking-widest font-semibold text-muted-foreground/70">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Preparing your presentation…
          </div>
        </div>
      ) : effectiveState === 'error' ? (
        <div className="flex flex-col items-center text-center max-w-md">
          <div className="rounded-full bg-muted/40 p-5 mb-6 border border-border">
            <AlertCircle className="h-10 w-10 text-muted-foreground" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Upload failed
          </h2>
          <p className="text-sm text-muted-foreground mb-8 max-w-sm">
            {effectiveErrorMessage}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {lastSourcePath && (
              <Button onClick={handleRenderRetry} className="rounded-full px-6 h-11">
                <RefreshCw className="h-4 w-4 mr-2" />
                Try again
              </Button>
            )}
            <Button
              onClick={handleStartOver}
              variant={lastSourcePath ? 'outline' : 'default'}
              className="rounded-full px-6 h-11"
            >
              <FileUp className="h-4 w-4 mr-2" />
              {lastSourcePath ? 'Upload a new slide' : 'Try again'}
            </Button>
          </div>
          {lastSourcePath && (
            <p className="mt-4 text-xs uppercase tracking-widest font-semibold text-muted-foreground/70">
              Try again retries the same PDF · upload skips re-sending the file
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center text-center w-full max-w-xl">
          <h2 className="text-2xl font-semibold tracking-tight mb-2">
            Add your presentation
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            Pick an existing lecture or upload a new {pptxEnabled ? 'file' : 'PDF'}
          </p>

          {/* Tab bar */}
          <div role="tablist" className="inline-flex items-center gap-1 rounded-full border border-border p-1 mb-8">
            <button
              role="tab"
              aria-selected={activeTab === 'modules'}
              aria-controls="panel-modules"
              type="button"
              onClick={() => setActiveTab('modules')}
              className={`inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold transition duration-200 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 ${
                activeTab === 'modules'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <BookOpen className="h-4 w-4" />
              From Modules
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'upload'}
              aria-controls="panel-upload"
              type="button"
              onClick={() => setActiveTab('upload')}
              className={`inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold transition duration-200 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 ${
                activeTab === 'upload'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Upload className="h-4 w-4" />
              {pptxEnabled ? 'Upload File' : 'Upload PDF'}
            </button>
          </div>

          {/* ── From Modules tab (polished) ── */}
          {activeTab === 'modules' && (
            <div id="panel-modules" role="tabpanel" className="w-full">
              {loadingModules ? (
                <div className="flex flex-col items-center py-16">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">Loading modules…</p>
                </div>
              ) : moduleItems.length === 0 ? (
                /* ── Empty state ── */
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={SPRING}
                  className="flex flex-col items-center py-16"
                >
                  <div className="relative mb-6">
                    {/* Layered decorative circles behind the icon */}
                    <div className="absolute inset-0 rounded-full bg-muted/20 scale-[1.6]" />
                    <div className="absolute inset-0 rounded-full bg-muted/30 scale-[1.25]" />
                    <div className="relative rounded-full bg-muted/50 p-5 border border-border">
                      <BookOpen className="h-8 w-8 text-muted-foreground" />
                    </div>
                  </div>
                  <h3 className="text-lg font-semibold tracking-tight mb-1.5">
                    No lectures yet
                  </h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-xs">
                    No lectures were found in your published modules. Upload one directly instead.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('upload')}
                    className="inline-flex items-center gap-2 rounded-full border border-border px-6 py-2.5 text-sm font-semibold text-foreground hover:bg-muted transition duration-200 ease-out"
                  >
                    <Upload className="h-4 w-4" />
                    Upload a new {pptxEnabled ? 'file' : 'PDF'} instead
                  </button>
                </motion.div>
              ) : (
                <>
                  {/* ── Scrollable module list ── */}
                  <motion.div
                    variants={listContainerVariants}
                    initial="hidden"
                    animate="visible"
                    className="max-h-[24rem] overflow-y-auto rounded-2xl border border-border bg-card/50 text-left"
                  >
                    {Object.entries(groupedItems).map(([moduleName, items], groupIdx) => (
                      <div key={moduleName}>
                        {/* ── Group header — editorial divider ── */}
                        <motion.div
                          variants={groupHeaderVariants}
                          className="sticky top-0 z-10 flex items-center gap-3 px-5 py-3 bg-card/95 backdrop-blur-sm"
                        >
                          <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">
                            {moduleName}
                          </span>
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground/50">
                            {items.length} {items.length === 1 ? 'file' : 'files'}
                          </span>
                        </motion.div>

                        {/* ── File items ── */}
                        <div className="px-3 pb-2 space-y-1.5">
                          {items.map((item) => {
                            const isSelected = selectedItemId === item.id
                            return (
                              <motion.button
                                key={item.id}
                                variants={listItemVariants}
                                type="button"
                                onClick={() => setSelectedItemId(isSelected ? null : item.id)}
                                className={`
                                  group relative w-full flex items-center gap-3.5 px-4 py-3.5 rounded-xl
                                  text-left transition duration-200 ease-out cursor-pointer
                                  focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2
                                  ${isSelected
                                    ? 'bg-foreground/[0.04] ring-1 ring-foreground/20 shadow-sm'
                                    : 'hover:bg-muted/30 hover:shadow-sm'
                                  }
                                `}
                              >
                                {/* Icon circle */}
                                <div
                                  className={`
                                    shrink-0 rounded-full p-2.5 transition duration-200 ease-out
                                    ${isSelected
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-muted/60 text-muted-foreground group-hover:bg-muted'
                                    }
                                  `}
                                >
                                  <AnimatePresence mode="wait" initial={false}>
                                    {isSelected ? (
                                      <motion.span
                                        key="check"
                                        initial={{ scale: 0.5, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ scale: 0.5, opacity: 0 }}
                                        transition={SPRING_SNAPPY}
                                      >
                                        <Check className="h-4 w-4" />
                                      </motion.span>
                                    ) : (
                                      <motion.span
                                        key="file"
                                        initial={{ scale: 0.5, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ scale: 0.5, opacity: 0 }}
                                        transition={SPRING_SNAPPY}
                                      >
                                        <FileText className="h-4 w-4" />
                                      </motion.span>
                                    )}
                                  </AnimatePresence>
                                </div>

                                {/* Text content */}
                                <div className="flex-1 min-w-0">
                                  <p className={`text-sm font-medium truncate transition-colors duration-200 ${
                                    isSelected ? 'text-foreground' : 'text-foreground/80 group-hover:text-foreground'
                                  }`}>
                                    {item.title}
                                  </p>
                                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                                    {item.fileName}
                                  </p>
                                </div>

                                {/* Metadata badges */}
                                <div className="shrink-0 flex items-center gap-2">
                                  <span className="text-xs uppercase tracking-widest font-semibold text-muted-foreground/70 border border-border rounded-full px-2 py-0.5">
                                    {item.fileType === 'ppt' ? 'PPT' : 'PDF'}
                                  </span>
                                  {item.fileSize && (
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                      {formatFileSize(item.fileSize)}
                                    </span>
                                  )}
                                </div>
                              </motion.button>
                            )
                          })}
                        </div>

                        {/* Separator between groups (except after the last) */}
                        {groupIdx < Object.entries(groupedItems).length - 1 && (
                          <div className="mx-5 border-b border-border/50" />
                        )}
                      </div>
                    ))}
                  </motion.div>

                  {/* ── CTA separator + button ── */}
                  <div className="w-full mt-6 pt-6 border-t border-border/60 flex flex-col items-center">
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...SPRING, delay: 0.3 }}
                    >
                      <Button
                        onClick={handleUseModuleItem}
                        disabled={!selectedItemId || copyingFromModule}
                        className="rounded-full px-8 py-4 h-auto font-semibold disabled:opacity-40"
                      >
                        {copyingFromModule ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
                            Preparing…
                          </>
                        ) : selectedItemId ? (
                          'Use this presentation'
                        ) : (
                          'Select a lecture above'
                        )}
                      </Button>
                    </motion.div>

                    {selectedItemId && (
                      <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ ...SPRING, delay: 0.1 }}
                        className="mt-3 text-xs uppercase tracking-widest font-semibold text-muted-foreground/60"
                      >
                        This will copy the lecture into your live session
                      </motion.p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Upload PDF tab */}
          {activeTab === 'upload' && (
            <div id="panel-upload" role="tabpanel" className="w-full">
              <p className="text-xs text-muted-foreground mb-4">
                {pptxEnabled
                  ? `PDF up to ${MAX_DECK_BYTES / MB} MB · PowerPoint up to ${MAX_PPTX_BYTES / MB} MB`
                  : `PDF format · up to ${MAX_DECK_BYTES / MB} MB`}{' '}
                · max {MAX_DECK_PAGES} pages
              </p>

              <label
                className={`
                  relative flex flex-col items-center justify-center
                  w-full h-72 border-2 border-dashed rounded-2xl
                  cursor-pointer transition duration-200 ease-out
                  ${dragOver
                    ? 'border-foreground bg-muted/30'
                    : 'border-border hover:border-foreground/40 hover:bg-muted/10'
                  }
                `}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <input
                  type="file"
                  accept={
                    pptxEnabled
                      ? '.pdf,.pptx,.ppt,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint'
                      : '.pdf,application/pdf'
                  }
                  onChange={handleFileInput}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  aria-label={pptxEnabled ? 'Upload PDF or PowerPoint' : 'Upload PDF'}
                />
                <div className="flex flex-col items-center pointer-events-none">
                  <div className={`rounded-full p-5 mb-5 transition-colors ${
                    dragOver ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    {dragOver ? (
                      <FileText className="h-9 w-9" />
                    ) : (
                      <Upload className="h-9 w-9" />
                    )}
                  </div>
                  <p className="text-lg font-medium mb-1.5">
                    {dragOver
                      ? `Drop your ${pptxEnabled ? 'file' : 'PDF'} here`
                      : `Drag & drop your ${pptxEnabled ? 'file' : 'PDF'}`}
                  </p>
                  <p className="text-sm text-muted-foreground">or click anywhere to browse</p>
                </div>
              </label>

              <div className="mt-6 inline-flex items-center gap-2 text-xs text-muted-foreground">
                <FileUp className="h-3.5 w-3.5" />
                <span>Optimised for instant sync to every student.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}
