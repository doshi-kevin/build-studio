/**
 * MarketplaceBrowser: the searchable, subject-organized template browser rendered inline on
 * a page (not inside a Dialog). Extracted from the former TemplateMarketplace modal.
 *
 * Built-in cards use TemplateCard (live preview + Preview button).
 * "Your templates" cards are click-to-clone with a plain tinted placeholder (no live preview).
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Search, Clock, Loader2, LayoutGrid, Heart, FileText, ChevronRight,
  Code2, Sigma, Atom, FlaskConical, Dna, Upload, FilePlus2, Mic, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  MARKETPLACE_TEMPLATES, SUBJECTS, DEFAULT_STEM_QUESTIONS,
  filterTemplates, matchesQuery,
  type Subject, type MarketplaceTemplate,
} from '@/lib/assignments/studio/marketplace-catalog'
import {
  createNotebookAssignment, cloneStudioAssignment, setTemplateSaved,
  createDocumentAssignment, createFileUploadAssignment,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { TemplateCard } from './TemplateCard'
import type { TemplateHistoryItem } from '@/lib/assignments/studio/template-history'

type Category = 'all' | Subject | 'saved' | 'mine' | 'formats'

const SUBJECT_ICON: Record<Subject, LucideIcon> = {
  cs: Code2, maths: Sigma, physics: Atom, chemistry: FlaskConical, biology: Dna,
}

/** The three from-scratch formats — folded into the marketplace as regular cards. */
type FormatAction = 'file-upload' | 'document' | 'verbal'
const FORMATS: { id: string; title: string; description: string; icon: LucideIcon; action: FormatAction }[] = [
  { id: 'file-upload', title: 'File Upload', description: 'Instructions, the file types students may submit, and an optional written response.', icon: Upload, action: 'file-upload' },
  { id: 'blank-document', title: 'Blank Document', description: 'Start from a blank page and write freely: headings, lists, to-dos, quotes. Press / for blocks.', icon: FilePlus2, action: 'document' },
  { id: 'verbal-assessment', title: 'Verbal Assessment', description: 'An AI asks the student questions aloud; they answer by voice. Recording + transcript saved to grade.', icon: Mic, action: 'verbal' },
]

interface MarketplaceBrowserProps {
  sectionId: string
  myTemplates: TemplateHistoryItem[]
  initialSavedIds?: string[]
}

export function MarketplaceBrowser({ sectionId, myTemplates, initialSavedIds = [] }: MarketplaceBrowserProps) {
  const router = useRouter()
  const [category, setCategory] = useState<Category>('all')
  const [query, setQuery] = useState('')
  const [isPending, startTransition] = useTransition()
  const [, startSaveTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saved, setSaved] = useState<Set<string>>(() => new Set(initialSavedIds))

  function toggleSaved(id: string) {
    const wasSaved = saved.has(id)
    setSaved((prev) => {
      const next = new Set(prev)
      if (wasSaved) next.delete(id)
      else next.add(id)
      return next
    })
    startSaveTransition(async () => {
      const res = await setTemplateSaved(sectionId, id, !wasSaved)
      if ('error' in res) {
        toast.error(res.error)
        setSaved((prev) => {
          const next = new Set(prev)
          if (wasSaved) next.add(id)
          else next.delete(id)
          return next
        })
      }
    })
  }

  const allBuiltins = useMemo(() => filterTemplates(MARKETPLACE_TEMPLATES, { subject: 'all', query }), [query])
  const allMine = useMemo(() => myTemplates.filter((t) => matchesQuery([t.title, t.subtitle], query)), [myTemplates, query])

  const shownBuiltins =
    category === 'all' ? allBuiltins
    : category === 'saved' ? allBuiltins.filter((t) => saved.has(t.id))
    : category === 'mine' ? []
    : allBuiltins.filter((t) => t.subject === category)
  const shownMine =
    category === 'all' || category === 'mine' ? allMine
    : category === 'saved' ? allMine.filter((t) => saved.has(t.id))
    : []
  const shownFormats =
    category === 'all' || category === 'formats'
      ? FORMATS.filter((f) => matchesQuery([f.title, f.description], query))
      : []
  const nothing = shownBuiltins.length === 0 && shownMine.length === 0 && shownFormats.length === 0

  const savedCount = useMemo(() => {
    const known = new Set<string>([...MARKETPLACE_TEMPLATES.map((t) => t.id), ...myTemplates.map((t) => t.id)])
    return [...saved].filter((id) => known.has(id)).length
  }, [saved, myTemplates])

  function startBuiltin(t: MarketplaceTemplate) {
    setBusyId(t.id)
    startTransition(async () => {
      const res = await createNotebookAssignment(
        sectionId, t.id, undefined, undefined,
        t.kind === 'stem' ? DEFAULT_STEM_QUESTIONS : undefined,
      )
      if ('error' in res) {
        toast.error(res.error)
        setBusyId(null)
        return
      }
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
    })
  }

  function startClone(t: TemplateHistoryItem) {
    setBusyId(t.id)
    startTransition(async () => {
      const res = await cloneStudioAssignment(sectionId, t.id)
      if ('error' in res) {
        toast.error(res.error)
        setBusyId(null)
        return
      }
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}`)
    })
  }

  function startFormat(f: (typeof FORMATS)[number]) {
    setBusyId(f.id)
    startTransition(async () => {
      if (f.action === 'verbal') {
        router.push(`/professor/courses/${sectionId}/assignments/new/verbal`)
        return
      }
      const res = f.action === 'document'
        ? await createDocumentAssignment(sectionId)
        : await createFileUploadAssignment(sectionId)
      if ('error' in res) {
        toast.error(res.error)
        setBusyId(null)
        return
      }
      router.push(`/professor/courses/${sectionId}/assignments/${res.assignmentId}/studio`)
    })
  }

  const counts: Record<Category, number> = {
    all: FORMATS.length + MARKETPLACE_TEMPLATES.length + myTemplates.length,
    formats: FORMATS.length,
    saved: savedCount,
    mine: myTemplates.length,
    cs: 0, maths: 0, physics: 0, chemistry: 0, biology: 0,
  }
  for (const t of MARKETPLACE_TEMPLATES) counts[t.subject] += 1

  const renderBuiltin = (t: MarketplaceTemplate) => (
    <TemplateCard
      key={t.id}
      template={t}
      busy={busyId === t.id}
      disabled={isPending}
      saved={saved.has(t.id)}
      onToggleSave={() => toggleSaved(t.id)}
      onUse={() => startBuiltin(t)}
    />
  )

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
      {/* Category rail — horizontal scrollable pills on mobile, sticky vertical sidebar at sm+. */}
      <nav className="w-full shrink-0 flex flex-row flex-nowrap gap-1 overflow-x-auto sm:w-52 sm:flex-col sm:gap-0 sm:space-y-0.5 sm:sticky sm:top-0 sm:max-h-[calc(100dvh-2rem)] sm:self-start sm:overflow-x-hidden sm:overflow-y-auto" aria-label="Template categories">
        <RailItem icon={LayoutGrid} label="All templates" count={counts.all} active={category === 'all'} onClick={() => setCategory('all')} />
        <RailItem icon={FilePlus2} label="Start from scratch" count={counts.formats} active={category === 'formats'} onClick={() => setCategory('formats')} />
        <p className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Subjects</p>
        {SUBJECTS.map((s) => (
          <RailItem key={s.key} icon={SUBJECT_ICON[s.key]} label={s.label} count={counts[s.key]} active={category === s.key} onClick={() => setCategory(s.key)} />
        ))}
        <p className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">You</p>
        <RailItem icon={Heart} label="Saved" count={counts.saved} active={category === 'saved'} onClick={() => setCategory('saved')} />
        {myTemplates.length > 0 && (
          <RailItem icon={Clock} label="Your templates" count={counts.mine} active={category === 'mine'} onClick={() => setCategory('mine')} />
        )}
      </nav>

      {/* Results */}
      <div className="min-w-0 flex-1">
        {/* Search */}
        <div className="relative mb-5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all templates…"
            aria-label="Search templates"
            className="pl-9"
          />
        </div>

        {nothing ? (
          <EmptyState category={category} query={query} onClear={() => setQuery('')} />
        ) : category === 'formats' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shownFormats.map((f) => (
              <FormatCard key={f.id} format={f} busy={busyId === f.id} disabled={isPending} onClick={() => startFormat(f)} />
            ))}
          </div>
        ) : category === 'all' ? (
          <div className="space-y-8">
            {shownFormats.length > 0 && (
              <Section title="Start from scratch" count={shownFormats.length}>
                {shownFormats.map((f) => (
                  <FormatCard key={f.id} format={f} busy={busyId === f.id} disabled={isPending} onClick={() => startFormat(f)} />
                ))}
              </Section>
            )}
            {SUBJECTS.map((s) => {
              const items = shownBuiltins.filter((t) => t.subject === s.key)
              if (items.length === 0) return null
              return (
                <Section key={s.key} title={s.label} count={items.length}>
                  {items.map(renderBuiltin)}
                </Section>
              )
            })}
            {shownMine.length > 0 && (
              <Section title="Your templates" count={shownMine.length}>
                {shownMine.map((t) => (
                  <MineCard
                    key={t.id}
                    template={t}
                    busy={busyId === t.id}
                    disabled={isPending}
                    saved={saved.has(t.id)}
                    onToggleSave={() => toggleSaved(t.id)}
                    onClick={() => startClone(t)}
                  />
                ))}
              </Section>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shownBuiltins.map(renderBuiltin)}
            {shownMine.map((t) => (
              <MineCard
                key={t.id}
                template={t}
                busy={busyId === t.id}
                disabled={isPending}
                saved={saved.has(t.id)}
                onToggleSave={() => toggleSaved(t.id)}
                onClick={() => startClone(t)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({ category, query, onClear }: { category: Category; query: string; onClear: () => void }) {
  const isSaved = category === 'saved' && !query
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        {isSaved ? <Heart className="h-6 w-6" aria-hidden="true" /> : <Search className="h-6 w-6" aria-hidden="true" />}
      </span>
      <div>
        <p className="text-sm font-semibold text-foreground">
          {isSaved ? 'No saved templates yet' : `No templates match${query ? ` "${query}"` : ''}`}
        </p>
        <p className="text-sm text-muted-foreground">
          {isSaved ? 'Click the heart on any template to save it here.' : 'Try another search or a different category.'}
        </p>
      </div>
      {query && (
        <button type="button" onClick={onClear} className="text-sm font-medium text-primary hover:underline">
          Clear search
        </button>
      )}
    </div>
  )
}

function RailItem({ icon: Icon, label, count, active, onClick }: { icon: LucideIcon; label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex w-auto shrink-0 items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left text-sm transition-colors sm:w-full sm:shrink',
        active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      <span className={cn('ml-auto rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums', active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
        {count}
      </span>
    </button>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground/70 tabular-nums">{count}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  )
}

/** Format card: a from-scratch creator (File Upload / Blank Document / Verbal), styled like the
 *  rest of the marketplace grid so it blends in. Whole card creates + navigates. */
function FormatCard({ format, busy, disabled, onClick }: {
  format: (typeof FORMATS)[number]
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const Icon = format.icon
  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!disabled && !busy) onClick()
    }
  }
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-busy={busy}
      aria-disabled={disabled}
      onClick={() => { if (!disabled && !busy) onClick() }}
      onKeyDown={handleKey}
      className={cn(
        'group relative flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-300',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        busy || disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg',
      )}
    >
      <div className="flex items-start justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Icon className="h-5 w-5" aria-hidden="true" />}
        </span>
        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-semibold leading-tight text-foreground">{format.title}</p>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{format.description}</p>
      </div>
    </div>
  )
}

/** Mine card: click-to-clone, no live preview, plain tinted placeholder. */
function MineCard({ template, busy, disabled, saved, onToggleSave, onClick }: {
  template: TemplateHistoryItem
  busy?: boolean
  disabled?: boolean
  saved: boolean
  onToggleSave: () => void
  onClick: () => void
}) {
  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!disabled && !busy) onClick()
    }
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-busy={busy}
      aria-disabled={disabled}
      onClick={() => { if (!disabled && !busy) onClick() }}
      onKeyDown={handleKey}
      className={cn(
        'group relative rounded-2xl border border-border bg-card shadow-sm transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-300',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        busy || disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg',
      )}
    >
      {busy && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-card/70">
          <Loader2 className="h-6 w-6 animate-spin text-foreground" aria-hidden="true" />
        </div>
      )}

      {/* Heart button */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleSave() }}
        onKeyDown={(e) => e.stopPropagation()}
        aria-pressed={saved}
        aria-label={saved ? 'Remove from saved' : 'Save template'}
        className={cn(
          'absolute right-2.5 top-2.5 z-10 flex h-8 w-8 items-center justify-center rounded-full shadow-sm backdrop-blur transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          saved ? 'bg-primary/10 text-primary' : 'bg-card/80 text-muted-foreground hover:text-primary',
        )}
      >
        <Heart className={cn('h-4 w-4', saved && 'fill-current')} aria-hidden="true" />
      </button>

      {/* Plain tinted placeholder (no live preview for mine cards) */}
      <div className="h-28 overflow-hidden rounded-t-2xl border-b border-border bg-muted" aria-hidden="true">
        <div className="flex h-full items-center justify-center">
          <FileText className="h-10 w-10 text-muted-foreground/20" aria-hidden="true" />
        </div>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="gap-1">
            <FileText className="h-3 w-3" aria-hidden="true" />
            {template.subtitle}
          </Badge>
          <Badge variant="outline" className="border-primary/30 text-primary">Yours</Badge>
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-foreground">{template.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Created {new Date(template.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>
    </div>
  )
}
