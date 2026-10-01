// Dialog that shows every image + formula already extracted from the
// professor's lectures in this section. Quiz author clicks one and
// the parent form inserts it.
//
// Two tabs: Images, Formulas. Each supports:
//   - filter by originating lecture
//   - free-text search
//   - empty state ("upload a lecture to populate this")
//   - loading state
//
// Multi-pick: the dialog does NOT auto-close on pick. The caller
// handles insertion (and usually shows a toast); the professor is
// free to switch tabs and keep picking (e.g. one image + several
// formulas in a single session) before dismissing with Esc / X.
//
// We cap the rendered list at 200 entries and add a "more matches —
// narrow with filter" hint beyond that so a 458-formula dump doesn't
// lag the DOM. No full virtualization — 200 DOM nodes render fine.
'use client'

import { useEffect, useState, useMemo } from 'react'
import { ImageIcon, FunctionSquare, Search, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { getLibraryForSection } from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type {
  LibraryImage,
  LibraryFormula,
  SectionLibrary,
} from '@/lib/extraction/library-queries'

interface InsertFromLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  /** Which tab to focus when opened — either caller has just clicked the image picker, or the formula picker. */
  initialTab: 'images' | 'formulas'
  onPickImage?: (image: LibraryImage) => void
  onPickFormula?: (formula: LibraryFormula) => void
}

const MAX_RENDERED = 200

export function InsertFromLibraryDialog({
  open,
  onOpenChange,
  sectionId,
  initialTab,
  onPickImage,
  onPickFormula,
}: InsertFromLibraryDialogProps) {
  const [tab, setTab] = useState<'images' | 'formulas'>(initialTab)
  const [library, setLibrary] = useState<SectionLibrary | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [lectureFilter, setLectureFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  // Reset when re-opened so stale data from a prior open doesn't flash.
  // Synchronous resets here are intentional — the dialog stays mounted
  // between opens and we want a clean slate the moment `open` flips true.
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTab(initialTab)
    setLectureFilter('all')
    setSearch('')
    setErrorMsg(null)
    setLoading(true)
    let cancelled = false
    ;(async () => {
      const res = await getLibraryForSection(sectionId)
      if (cancelled) return
      if (res.error) {
        setErrorMsg(res.error)
        setLibrary({ images: [], formulas: [], lectures: [] })
      } else {
        setLibrary(res.data ?? { images: [], formulas: [], lectures: [] })
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, initialTab, sectionId])

  const filteredImages = useMemo(() => {
    if (!library) return []
    const q = search.trim().toLowerCase()
    return library.images.filter((img) => {
      if (lectureFilter !== 'all' && img.lectureId !== lectureFilter) return false
      if (!q) return true
      return (
        img.lectureTitle.toLowerCase().includes(q) ||
        String(img.pageNumber).includes(q) ||
        (img.altText?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [library, lectureFilter, search])

  const filteredFormulas = useMemo(() => {
    if (!library) return []
    const q = search.trim().toLowerCase()
    return library.formulas.filter((f) => {
      if (lectureFilter !== 'all' && f.lectureId !== lectureFilter) return false
      if (!q) return true
      return (
        f.latex.toLowerCase().includes(q) ||
        f.lectureTitle.toLowerCase().includes(q) ||
        String(f.pageNumber).includes(q)
      )
    })
  }, [library, lectureFilter, search])

  const imagesToRender = filteredImages.slice(0, MAX_RENDERED)
  const formulasToRender = filteredFormulas.slice(0, MAX_RENDERED)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Insert from lecture library
          </DialogTitle>
          <DialogDescription>
            Pick content extracted from your uploaded lectures. Switch tabs to insert an image and
            one or more formulas in the same session — the dialog stays open until you close it.
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="px-6 pt-3 flex items-center gap-1 border-b">
          <TabButton
            active={tab === 'images'}
            onClick={() => setTab('images')}
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            label="Images"
            count={library?.images.length ?? 0}
          />
          <TabButton
            active={tab === 'formulas'}
            onClick={() => setTab('formulas')}
            icon={<FunctionSquare className="h-3.5 w-3.5" />}
            label="Formulas"
            count={library?.formulas.length ?? 0}
          />
        </div>

        {/* Filter strip */}
        <div className="px-6 py-3 flex items-center gap-3 border-b bg-muted/10">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tab === 'images' ? 'Search images…' : 'Search formulas (LaTeX text)…'}
              className="pl-8 h-9"
            />
          </div>
          {(library?.lectures.length ?? 0) > 0 && (
            <select
              value={lectureFilter}
              onChange={(e) => setLectureFilter(e.target.value)}
              className="h-9 rounded-xl border border-border bg-background px-2 text-sm"
            >
              <option value="all">All lectures</option>
              {library?.lectures.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading library…
            </div>
          )}

          {!loading && errorMsg && (
            <div className="py-16 text-center text-destructive text-sm">{errorMsg}</div>
          )}

          {!loading && !errorMsg && library && (
            <>
              {tab === 'images' && (
                <ImagesTab
                  images={imagesToRender}
                  totalMatches={filteredImages.length}
                  libraryTotal={library.images.length}
                  onPick={(img) => onPickImage?.(img)}
                />
              )}
              {tab === 'formulas' && (
                <FormulasTab
                  formulas={formulasToRender}
                  totalMatches={filteredFormulas.length}
                  libraryTotal={library.formulas.length}
                  onPick={(f) => onPickFormula?.(f)}
                />
              )}
            </>
          )}
        </div>

        {/* Footer: explicit close — multi-pick stays open until user clicks Done.
            Outline variant so Done reads as an exit affordance rather than
            competing with the picks below as a primary CTA. */}
        <div className="px-6 py-3 border-t bg-muted/10 flex items-center justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-sm rounded-xl rounded-b-none border-b-2 transition-colors',
        active
          ? 'border-foreground font-semibold'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
      <span className="text-[11px] text-muted-foreground tabular-nums">({count})</span>
    </button>
  )
}

function ImagesTab({
  images,
  totalMatches,
  libraryTotal,
  onPick,
}: {
  images: LibraryImage[]
  totalMatches: number
  libraryTotal: number
  onPick: (image: LibraryImage) => void
}) {
  if (libraryTotal === 0) {
    return (
      <EmptyState
        title="No images yet"
        body="Upload a PDF or PPT lecture — extracted images will appear here automatically once the pipeline finishes."
      />
    )
  }
  if (totalMatches === 0) {
    return <EmptyState title="No matches" body="Clear the search or pick a different lecture filter." />
  }
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {images.map((img) => (
          <button
            type="button"
            key={`${img.lectureId}:${img.storagePath}`}
            onClick={() => onPick(img)}
            className="group relative rounded-xl border bg-background overflow-hidden text-left hover:-translate-y-0.5 hover:shadow-sm transition duration-200 ease-out"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.storageUrl}
              alt={img.altText || `Page ${img.pageNumber}`}
              loading="lazy"
              className="w-full h-28 object-contain bg-muted/20"
            />
            <div className="px-2 py-1.5 text-[11px]">
              <p className="truncate text-foreground">{img.lectureTitle}</p>
              <p className="text-muted-foreground">Page {img.pageNumber}</p>
            </div>
          </button>
        ))}
      </div>
      {totalMatches > MAX_RENDERED && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Showing {MAX_RENDERED} of {totalMatches} — narrow the search or filter to find more.
        </p>
      )}
    </>
  )
}

function FormulasTab({
  formulas,
  totalMatches,
  libraryTotal,
  onPick,
}: {
  formulas: LibraryFormula[]
  totalMatches: number
  libraryTotal: number
  onPick: (formula: LibraryFormula) => void
}) {
  if (libraryTotal === 0) {
    return (
      <EmptyState
        title="No formulas yet"
        body="Upload a math-heavy PDF lecture — extracted formulas will appear here once the pipeline finishes."
      />
    )
  }
  if (totalMatches === 0) {
    return <EmptyState title="No matches" body="Clear the search or pick a different lecture filter." />
  }
  return (
    <>
      <ul className="divide-y divide-border rounded-xl border">
        {formulas.map((f, idx) => (
          <li key={`${f.lectureId}:${f.pageNumber}:${idx}:${f.latex.slice(0, 16)}`}>
            <button
              type="button"
              onClick={() => onPick(f)}
              className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              <div className="flex-1 min-w-0">
                {/* Render the LaTeX as display math so the professor actually sees it */}
                <div className="text-sm">
                  <MarkdownLatex content={`$$${f.latex}$$`} variant="compact" />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  <span className="truncate">{f.lectureTitle}</span>
                  {' · '}Page {f.pageNumber}
                  {' · '}
                  <span className="uppercase tracking-widest">{f.kind}</span>
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {totalMatches > MAX_RENDERED && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Showing {MAX_RENDERED} of {totalMatches} — narrow the search or filter to find more.
        </p>
      )}
    </>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">{body}</p>
    </div>
  )
}
