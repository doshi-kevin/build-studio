/**
 * ProjectPhasesTab — the professor's drag-and-drop phases board (the "arena").
 *
 * Phases are columns; the section's assignments and quizzes are cards that
 * drag between a library tray and the phases. Every drop saves immediately
 * via server actions (live edits, no draft state). Placement is a tag — an
 * item's own dates never change; a due date outside the phase window only
 * shows a warning.
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  Plus,
  MoreHorizontal,
  CalendarRange,
  Trash2,
  TriangleAlert,
  FileText,
  ListChecks,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  createMasterPhase,
  updateMasterPhase,
  deleteMasterPhase,
  reorderMasterPhases,
  placePhaseItem,
  removePhaseItem,
} from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'

// ── Types ────────────────────────────────────────────────────────

export interface PhaseCard {
  /** project_phase_items.id — undefined while the card sits in the library */
  rowId?: string
  type: 'assignment' | 'quiz'
  itemId: string
  title: string
  status: string
  points: number | null
  due: string | null
}

export interface BoardPhase {
  id: string
  name: string
  startDate: string | null
  endDate: string | null
  items: PhaseCard[]
}

interface ProjectPhasesTabProps {
  sectionId: string
  projectId: string
  initialPhases: BoardPhase[]
  initialLibrary: PhaseCard[]
  /** Read-only roles (e.g. grader) see the board but can't drag, add, or edit. */
  canWrite: boolean
}

const LIBRARY_ID = 'library'

function cardKey(card: PhaseCard) {
  return `card_${card.type}_${card.itemId}`
}

function fmtDate(iso: string | null) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Timeline strip ───────────────────────────────────────────────

function PhaseTimeline({ phases }: { phases: BoardPhase[] }) {
  const dated = phases.filter((p) => p.startDate && p.endDate)
  if (dated.length === 0) return null

  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className="space-y-1.5">
      <div className="flex h-8 gap-1.5">
        {dated.map((p) => {
          const days = Math.max(
            1,
            (new Date(p.endDate!).getTime() - new Date(p.startDate!).getTime()) / 86400000,
          )
          const done = p.endDate! < today
          const current = !done && p.startDate! <= today
          return (
            <div
              key={p.id}
              style={{ flexGrow: days }}
              className={cn(
                'flex min-w-0 basis-8 items-center justify-center overflow-hidden rounded-xl px-2 text-xs font-medium whitespace-nowrap',
                done && 'bg-success-muted text-success-muted-foreground',
                current && 'bg-primary text-primary-foreground shadow-sm',
                !done && !current && 'border border-dashed border-border bg-secondary text-muted-foreground',
              )}
            >
              {done ? `✓ ${p.name}` : p.name}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Timeline follows the phase dates below. Phases without dates are not shown on it.
      </p>
    </div>
  )
}

// ── Item card ────────────────────────────────────────────────────

function ItemCardBody({
  card,
  phase,
  overlay,
}: {
  card: PhaseCard
  phase?: BoardPhase
  overlay?: boolean
}) {
  const due = fmtDate(card.due)
  const outsideWindow =
    !!card.due &&
    !!phase?.endDate &&
    (card.due.slice(0, 10) > phase.endDate || (!!phase.startDate && card.due.slice(0, 10) < phase.startDate))

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 shadow-sm',
        overlay && 'rotate-1 scale-105 shadow-lg ring-1 ring-primary',
      )}
    >
      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      {card.type === 'quiz' ? (
        <ListChecks className="h-4 w-4 shrink-0 text-accent-foreground" />
      ) : (
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{card.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {card.type === 'assignment' && card.points != null ? `${card.points} pts` : 'Quiz'}
          {due ? ` · due ${due}` : ''}
        </p>
      </div>
      {outsideWindow && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <TriangleAlert className="h-4 w-4 shrink-0 text-warning" />
            </TooltipTrigger>
            <TooltipContent>
              Due date falls outside this phase&apos;s window. Placing it here doesn&apos;t change the due date.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Badge
        variant="secondary"
        className={cn(
          'shrink-0 text-xs capitalize',
          card.type === 'quiz' && 'bg-accent text-accent-foreground',
          card.status === 'draft' && 'bg-muted text-muted-foreground',
        )}
      >
        {card.status === 'draft' ? 'Draft' : card.type === 'quiz' ? 'Quiz' : 'Assignment'}
      </Badge>
    </div>
  )
}

function SortableItemCard({ card, phase }: { card: PhaseCard; phase?: BoardPhase }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cardKey(card),
    data: { kind: 'card' },
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('cursor-grab touch-none active:cursor-grabbing', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <ItemCardBody card={card} phase={phase} />
    </div>
  )
}

// ── Phase column ─────────────────────────────────────────────────

function PhaseColumn({
  phase,
  sectionId,
  projectId,
  canWrite,
  onRename,
  onDatesSaved,
  onDeleted,
}: {
  phase: BoardPhase
  sectionId: string
  projectId: string
  canWrite: boolean
  onRename: (id: string, name: string) => void
  onDatesSaved: (id: string, start: string | null, end: string | null) => void
  onDeleted: (id: string) => void
}) {
  const router = useRouter()
  const [name, setName] = useState(phase.name)
  const [datesOpen, setDatesOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [start, setStart] = useState(phase.startDate ?? '')
  const [end, setEnd] = useState(phase.endDate ?? '')
  const [saving, setSaving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `col_${phase.id}`, data: { kind: 'column' } })

  async function commitName() {
    const next = name.trim()
    if (!next || next === phase.name) {
      setName(phase.name)
      return
    }
    onRename(phase.id, next)
    const result = await updateMasterPhase(phase.id, projectId, sectionId, { name: next })
    if (result.error) {
      toast.error(result.error)
      onRename(phase.id, phase.name)
      setName(phase.name)
    }
  }

  async function saveDates() {
    setSaving(true)
    try {
      const result = await updateMasterPhase(phase.id, projectId, sectionId, {
        start_date: start || null,
        end_date: end || null,
      })
      if (result.error) {
        toast.error(result.error)
        return
      }
      onDatesSaved(phase.id, start || null, end || null)
      setDatesOpen(false)
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    const result = await deleteMasterPhase(phase.id, projectId, sectionId)
    if (result.error) {
      toast.error(result.error)
      return
    }
    onDeleted(phase.id)
    toast.success('Phase deleted. Its items are back in the library')
    router.refresh()
  }

  const dateLabel =
    phase.startDate && phase.endDate
      ? `${fmtDate(phase.startDate)} – ${fmtDate(phase.endDate)}`
      : 'No dates yet'

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex w-64 shrink-0 flex-col rounded-2xl border border-border bg-secondary',
        isDragging && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-1">
        {canWrite && (
          <button
            ref={setActivatorNodeRef}
            className="cursor-grab touch-none rounded-xl p-0.5 text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing"
            aria-label={`Reorder phase ${phase.name}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <Input
          ref={nameRef}
          value={name}
          readOnly={!canWrite}
          onChange={(e) => setName(e.target.value)}
          onBlur={canWrite ? commitName : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setName(phase.name)
              e.currentTarget.blur()
            }
          }}
          className="h-7 border-transparent bg-transparent px-1.5 text-sm font-semibold shadow-none focus-visible:bg-card"
          aria-label="Phase name"
        />
        {canWrite && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Phase options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => nameRef.current?.focus()}>Rename</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDatesOpen(true)}>
                <CalendarRange className="h-4 w-4" /> Edit dates
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" /> Delete phase
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <p className="px-4 pb-2 text-xs tracking-wide text-muted-foreground uppercase">{dateLabel}</p>

      <SortableContext
        items={phase.items.map(cardKey)}
        strategy={verticalListSortingStrategy}
      >
        <DroppableColumnBody phase={phase} />
      </SortableContext>

      <Dialog open={datesOpen} onOpenChange={setDatesOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Phase dates</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`start-${phase.id}`}>Starts</Label>
              <Input
                id={`start-${phase.id}`}
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`end-${phase.id}`}>Ends</Label>
              <Input
                id={`end-${phase.id}`}
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDatesOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveDates} disabled={saving}>
              {saving ? 'Saving…' : 'Save dates'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{phase.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its assignments and quizzes go back to the library. Nothing is deleted except the
              phase itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete phase</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The droppable body of a column — a separate component so the empty state can drop too. */
function DroppableColumnBody({ phase }: { phase: BoardPhase }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `body_${phase.id}`,
    data: { kind: 'column-body', phaseId: phase.id },
  })
  return (
    <div
      ref={setNodeRef}
      className={cn('flex min-h-20 flex-col gap-2 rounded-b-2xl p-2.5 pt-1', isOver && 'bg-accent')}
    >
      {phase.items.map((card) => (
        <SortableItemCard key={cardKey(card)} card={card} phase={phase} />
      ))}
      {phase.items.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          Drop assignments or quizzes here
        </div>
      )}
    </div>
  )
}

// ── The board ────────────────────────────────────────────────────

export function ProjectPhasesTab({
  sectionId,
  projectId,
  initialPhases,
  initialLibrary,
  canWrite,
}: ProjectPhasesTabProps) {
  const router = useRouter()
  const [phases, setPhases] = useState<BoardPhase[]>(initialPhases)
  const [library, setLibrary] = useState<PhaseCard[]>(initialLibrary)
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'assignment' | 'quiz'>('all')
  const [activeCard, setActiveCard] = useState<PhaseCard | null>(null)
  const [creatingPhase, setCreatingPhase] = useState(false)
  const [newPhaseName, setNewPhaseName] = useState('')

  const activeSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // A read-only role gets no sensors, so cards and columns can't be dragged.
  const readOnlySensors = useSensors()
  const sensors = canWrite ? activeSensors : readOnlySensors

  const visibleLibrary = useMemo(
    () =>
      library.filter(
        (c) =>
          (libraryFilter === 'all' || c.type === libraryFilter) &&
          (c.status === 'draft' || c.status === 'published'),
      ),
    [library, libraryFilter],
  )

  /** Which container currently holds a card key — 'library' or a phase id. */
  function containerOf(key: string): string | null {
    if (library.some((c) => cardKey(c) === key)) return LIBRARY_ID
    const phase = phases.find((p) => p.items.some((c) => cardKey(c) === key))
    return phase?.id ?? null
  }

  function findCard(key: string): PhaseCard | null {
    return (
      library.find((c) => cardKey(c) === key) ??
      phases.flatMap((p) => p.items).find((c) => cardKey(c) === key) ??
      null
    )
  }

  /** Resolve a droppable/sortable id to its container. */
  function containerForOver(overId: string): string | null {
    if (overId === LIBRARY_ID) return LIBRARY_ID
    if (overId.startsWith('body_')) return overId.slice(5)
    if (overId.startsWith('col_')) return overId.slice(4)
    if (overId.startsWith('card_')) return containerOf(overId)
    return null
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id)
    if (id.startsWith('card_')) setActiveCard(findCard(id))
  }

  function handleDragOver(event: DragOverEvent) {
    const activeId = String(event.active.id)
    if (!activeId.startsWith('card_') || !event.over) return
    const overId = String(event.over.id)
    const from = containerOf(activeId)
    const to = containerForOver(overId)
    if (!from || !to || from === to) return

    // Move the card between containers in local state; the drop index is
    // settled in handleDragEnd.
    const card = findCard(activeId)
    if (!card) return
    if (from === LIBRARY_ID) {
      setLibrary((prev) => prev.filter((c) => cardKey(c) !== activeId))
    } else {
      setPhases((prev) =>
        prev.map((p) =>
          p.id === from ? { ...p, items: p.items.filter((c) => cardKey(c) !== activeId) } : p,
        ),
      )
    }
    if (to === LIBRARY_ID) {
      setLibrary((prev) => [card, ...prev])
    } else {
      setPhases((prev) =>
        prev.map((p) => (p.id === to ? { ...p, items: [...p.items, card] } : p)),
      )
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null
    setActiveCard(null)

    // Column reorder
    if (activeId.startsWith('col_')) {
      if (!overId || !overId.startsWith('col_') || activeId === overId) return
      const fromIndex = phases.findIndex((p) => `col_${p.id}` === activeId)
      const toIndex = phases.findIndex((p) => `col_${p.id}` === overId)
      if (fromIndex < 0 || toIndex < 0) return
      const next = arrayMove(phases, fromIndex, toIndex)
      setPhases(next)
      const result = await reorderMasterPhases(projectId, sectionId, next.map((p) => p.id))
      if (result.error) {
        toast.error(result.error)
        router.refresh()
      }
      return
    }

    if (!activeId.startsWith('card_') || !overId) return
    const card = findCard(activeId)
    const to = containerForOver(overId)
    if (!card || !to) return

    if (to === LIBRARY_ID) {
      // Unassign (no-op when the card was never placed)
      if (!card.rowId) return
      const rowId = card.rowId
      setLibrary((prev) =>
        prev.map((c) => (cardKey(c) === activeId ? { ...c, rowId: undefined } : c)),
      )
      const result = await removePhaseItem(rowId, projectId, sectionId)
      if (result.error) {
        toast.error(result.error)
        router.refresh()
      }
      return
    }

    // Place into a phase at the dropped index
    setPhases((prev) =>
      prev.map((p) => {
        if (p.id !== to) return p
        const withoutCard = p.items.filter((c) => cardKey(c) !== activeId)
        let index = withoutCard.length
        if (overId.startsWith('card_') && overId !== activeId) {
          const overIndex = withoutCard.findIndex((c) => cardKey(c) === overId)
          if (overIndex >= 0) index = overIndex
        }
        withoutCard.splice(index, 0, card)
        return { ...p, items: withoutCard }
      }),
    )
    const targetPhase = phases.find((p) => p.id === to)
    let position = targetPhase ? targetPhase.items.filter((c) => cardKey(c) !== activeId).length : 0
    if (overId.startsWith('card_') && overId !== activeId && targetPhase) {
      const idx = targetPhase.items
        .filter((c) => cardKey(c) !== activeId)
        .findIndex((c) => cardKey(c) === overId)
      if (idx >= 0) position = idx
    }
    const result = await placePhaseItem(to, projectId, sectionId, {
      item_type: card.type,
      item_id: card.itemId,
      position,
    })
    if (result.error) {
      toast.error(result.error)
      router.refresh()
      return
    }
    if (result.data) {
      const rowId = result.data.id
      setPhases((prev) =>
        prev.map((p) => ({
          ...p,
          items: p.items.map((c) => (cardKey(c) === activeId ? { ...c, rowId } : c)),
        })),
      )
    }
  }

  async function commitNewPhase() {
    const name = newPhaseName.trim()
    setCreatingPhase(false)
    setNewPhaseName('')
    if (!name) return
    const result = await createMasterPhase(projectId, sectionId, { name })
    if (result.error || !result.data) {
      toast.error(result.error || 'Failed to create phase')
      return
    }
    setPhases((prev) => [
      ...prev,
      { id: result.data!.id, name, startDate: null, endDate: null, items: [] },
    ])
  }

  return (
    <div className="space-y-5">
      <PhaseTimeline phases={phases} />

      <DndContext
        id="phases-board"
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="overflow-x-auto pb-1">
          <div className="flex items-start gap-3.5">
            <SortableContext
              items={phases.map((p) => `col_${p.id}`)}
              strategy={horizontalListSortingStrategy}
            >
              {phases.map((phase) => (
                <PhaseColumn
                  key={phase.id}
                  phase={phase}
                  sectionId={sectionId}
                  projectId={projectId}
                  canWrite={canWrite}
                  onRename={(id, name) =>
                    setPhases((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)))
                  }
                  onDatesSaved={(id, startDate, endDate) =>
                    setPhases((prev) =>
                      prev.map((p) => (p.id === id ? { ...p, startDate, endDate } : p)),
                    )
                  }
                  onDeleted={(id) => setPhases((prev) => prev.filter((p) => p.id !== id))}
                />
              ))}
            </SortableContext>

            {canWrite && (creatingPhase ? (
              <div className="w-52 shrink-0 rounded-2xl border border-border bg-secondary p-3">
                <Input
                  autoFocus
                  value={newPhaseName}
                  onChange={(e) => setNewPhaseName(e.target.value)}
                  onBlur={commitNewPhase}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') {
                      setNewPhaseName('')
                      setCreatingPhase(false)
                    }
                  }}
                  placeholder="Phase name"
                  className="h-8 text-sm"
                  aria-label="New phase name"
                />
              </div>
            ) : (
              <button
                onClick={() => setCreatingPhase(true)}
                className="w-52 shrink-0 rounded-2xl border border-dashed border-border px-4 py-6 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
              >
                <Plus className="mr-1 inline h-4 w-4" />
                New phase
                <span className="mt-0.5 block text-xs font-normal">just a name, fill it later</span>
              </button>
            ))}
          </div>
        </div>

        {/* Library tray */}
        <div className="rounded-2xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-3 px-4 pt-3.5 pb-2">
            <h3 className="text-sm font-semibold">Library</h3>
            <p className="flex-1 text-xs text-muted-foreground">
              Everything in this section not yet on a phase. Drag up to place, drag a card down
              here to unassign.
            </p>
            <div className="flex gap-1 rounded-xl bg-muted p-0.5">
              {(['all', 'assignment', 'quiz'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setLibraryFilter(f)}
                  className={cn(
                    'rounded-xl px-3 py-1 text-xs font-medium transition-colors',
                    libraryFilter === f
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f === 'all' ? 'All' : f === 'assignment' ? 'Assignments' : 'Quizzes'}
                </button>
              ))}
            </div>
          </div>
          <SortableContext
            items={visibleLibrary.map(cardKey)}
            strategy={verticalListSortingStrategy}
          >
            <LibraryTray cards={visibleLibrary} />
          </SortableContext>
          {canWrite && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
              <Button asChild size="sm">
                <Link href={`/professor/courses/${sectionId}/assignments/new`}>
                  <Plus className="h-4 w-4" /> New assignment
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/professor/courses/${sectionId}/quizzes`}>
                  <Plus className="h-4 w-4" /> New quiz
                </Link>
              </Button>
              <p className="text-xs text-muted-foreground">
                Created items appear here, drag them onto a phase when ready.
              </p>
            </div>
          )}
        </div>

        <DragOverlay>{activeCard ? <ItemCardBody card={activeCard} overlay /> : null}</DragOverlay>
      </DndContext>
    </div>
  )
}

function LibraryTray({ cards }: { cards: PhaseCard[] }) {
  const { setNodeRef, isOver } = useDroppable({
    id: LIBRARY_ID,
    data: { kind: 'library' },
  })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'grid min-h-16 grid-cols-1 gap-2 px-4 pb-3 sm:grid-cols-2 lg:grid-cols-3',
        isOver && 'rounded-xl bg-accent',
      )}
    >
      {cards.map((card) => (
        <SortableItemCard key={cardKey(card)} card={card} />
      ))}
      {cards.length === 0 && (
        <p className="col-span-full py-3 text-center text-xs text-muted-foreground">
          Everything is placed on the board. New assignments and quizzes you create will show up
          here.
        </p>
      )}
    </div>
  )
}
