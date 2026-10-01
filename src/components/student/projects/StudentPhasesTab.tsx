/**
 * StudentPhasesTab — timeline/list view of team phases with checklist items.
 *
 * Displays each phase with title, description, status badge, dates, assigned
 * members, and a checklist of sub-items. Any team member can add/edit/delete/toggle
 * checklist items. Phase progress auto-calculates from item completion.
 * Team owners can add, edit, delete phases, assign members, and generate with AI.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  ListChecks,
  Plus,
  Pencil,
  Trash2,
  Calendar,
  CalendarCheck,
  MapPin,
  Bot,
  Link2,
  FileText,
  UserPlus,
  X,
  Check,
  MessageSquare,
  Loader2 as Loader2Icon,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  createPhaseSchema,
  updatePhaseSchema,
  type CreatePhaseInput,
  type UpdatePhaseInput,
  PHASE_STATUSES,
  PHASE_STATUS_LABELS,
} from '@/lib/validations/project'
import {
  createStudentPhase,
  getLinkableAssignments,
  createPhaseFromAssignment,
  updateStudentPhase,
  deleteStudentPhase,
  togglePhaseStatus,
  updatePhaseAssignees,
  createPhaseItem,
  updatePhaseItem,
  deletePhaseItem,
  togglePhaseItem,
  getPhaseCommentsForStudent,
  getPhaseCommentCounts,
  type PhaseCommentData,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
import { AIGeneratePhasesDialog } from '@/components/student/projects/AIGeneratePhasesDialog'

// ── Badge colors ────────────────────────────────────────────────

const phaseColors: Record<string, string> = {
  not_started: 'bg-muted text-muted-foreground',
  in_progress: 'bg-muted text-foreground',
  completed: 'bg-success-muted text-success-muted-foreground',
  blocked: 'bg-destructive/10 text-destructive',
}

// ── Props ───────────────────────────────────────────────────────

interface PhaseItemData {
  id: string
  title: string
  is_completed: boolean
  position: number
  completed_by?: string | null
  completed_at?: string | null
  created_by: string
}

interface ProjectPhase {
  id: string
  title: string
  description?: string
  status: string
  start_date?: string | null
  due_date?: string | null
  assigned_to?: string[]
  assignment_id?: string | null
  phase_items?: PhaseItemData[]
}

interface ProjectData {
  id: string
  title: string
  status: string
}

interface TeamMember {
  id: string
  user_id: string
  role: string
  profile?: { name?: string | null; email?: string | null; avatar_url?: string | null }
}

export interface MasterPhaseView {
  id: string
  name: string
  startDate: string | null
  endDate: string | null
  items: {
    title: string
    type: string
    href?: string | null
    grade?: { score: number; possible: number | null } | null
  }[]
}

interface StudentPhasesTabProps {
  sectionId: string
  project: ProjectData
  teamId: string
  phases: ProjectPhase[]
  members: TeamMember[]
  userRole: 'owner' | 'member' | 'viewer' | null
  planningDoc: string
  masterPhases?: MasterPhaseView[]
}

// ── Roadmap helpers ─────────────────────────────────────────────

const ROADMAP_ITEM_ICON: Record<string, typeof FileText> = {
  assignment: FileText,
  quiz: ListChecks,
  attendance: CalendarCheck,
  manual: Pencil,
}

function fmtRoadmapDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function fmtRoadmapRange(start: string | null, end: string | null): string {
  if (start && end) return `${fmtRoadmapDay(start)} – ${fmtRoadmapDay(end)}`
  return fmtRoadmapDay((start || end) as string)
}
function roadmapTodayStr(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

// ── Component ───────────────────────────────────────────────────

export function StudentPhasesTab({ sectionId, project, teamId, phases, members, userRole, planningDoc, masterPhases = [] }: StudentPhasesTabProps) {
  const router = useRouter()
  const [createOpen, setCreateOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  // Where a linked-assignment phase should land — same tri-state as
  // insertAnchorId (undefined = append, null = top, id = after that phase).
  const [linkAnchorId, setLinkAnchorId] = useState<string | null | undefined>(undefined)
  // When a user clicks an "Insert phase here" divider, we remember the
  // anchor phase whose position the new phase should land AFTER.
  //   undefined → creating via the top "Add Phase" button (append to end)
  //   null      → insert at position 0 (before all other phases)
  //   string    → insert immediately after that phase id
  const [insertAnchorId, setInsertAnchorId] = useState<string | null | undefined>(undefined)
  const [aiDialogOpen, setAiDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<ProjectPhase | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProjectPhase | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [togglingPhase, setTogglingPhase] = useState<string | null>(null)

  // Phase item state
  const [togglingItem, setTogglingItem] = useState<string | null>(null)
  const [addingItemToPhase, setAddingItemToPhase] = useState<string | null>(null)
  const [newItemTitle, setNewItemTitle] = useState('')
  const [addingItem, setAddingItem] = useState(false)
  const [editingItem, setEditingItem] = useState<{ id: string; phaseId: string; title: string } | null>(null)
  const [editingItemTitle, setEditingItemTitle] = useState('')
  const [savingItemEdit, setSavingItemEdit] = useState(false)
  const [deletingItem, setDeletingItem] = useState<string | null>(null)

  // Comment counts per phase (fetched once on mount)
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    const phaseIds = phases.map((p) => p.id)
    if (phaseIds.length === 0) return
    getPhaseCommentCounts(phaseIds, sectionId).then((result) => {
      if (result.data) setCommentCounts(result.data)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases.length, sectionId])

  const isOwner = userRole === 'owner'
  const isMember = userRole === 'owner' || userRole === 'member'

  // ── Phase handlers ──────────────────────────────────────────

  async function handleDelete() {
    if (!deleteTarget) return

    setIsDeleting(true)
    try {
      const result = await deleteStudentPhase(deleteTarget.id, teamId, sectionId)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success('Phase deleted')
      setDeleteTarget(null)
      router.refresh()
    } catch {
      toast.error('Failed to delete phase')
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleToggleComplete(phase: ProjectPhase) {
    // If phase has checklist items, don't allow manual toggle
    if (phase.phase_items && phase.phase_items.length > 0) {
      toast.info('Phase status is managed by its checklist items')
      return
    }

    const willComplete = phase.status !== 'completed'
    setTogglingPhase(phase.id)
    try {
      const result = await togglePhaseStatus(phase.id, teamId, sectionId, willComplete)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      router.refresh()
    } catch {
      toast.error('Failed to update phase')
    } finally {
      setTogglingPhase(null)
    }
  }

  // ── Phase item handlers ─────────────────────────────────────

  async function handleAddItem(phaseId: string) {
    if (!newItemTitle.trim()) return

    setAddingItem(true)
    try {
      const result = await createPhaseItem(phaseId, teamId, sectionId, { title: newItemTitle.trim() })

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      setNewItemTitle('')
      setAddingItemToPhase(null)
      router.refresh()
    } catch {
      toast.error('Failed to add item')
    } finally {
      setAddingItem(false)
    }
  }

  async function handleToggleItem(itemId: string, phaseId: string, completed: boolean) {
    setTogglingItem(itemId)
    try {
      const result = await togglePhaseItem(itemId, phaseId, teamId, sectionId, completed)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      router.refresh()
    } catch {
      toast.error('Failed to toggle item')
    } finally {
      setTogglingItem(null)
    }
  }

  async function handleSaveItemEdit() {
    if (!editingItem || !editingItemTitle.trim()) return

    setSavingItemEdit(true)
    try {
      const result = await updatePhaseItem(
        editingItem.id,
        editingItem.phaseId,
        teamId,
        sectionId,
        { title: editingItemTitle.trim() },
      )

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      setEditingItem(null)
      setEditingItemTitle('')
      router.refresh()
    } catch {
      toast.error('Failed to update item')
    } finally {
      setSavingItemEdit(false)
    }
  }

  async function handleDeleteItem(itemId: string, phaseId: string) {
    setDeletingItem(itemId)
    try {
      const result = await deletePhaseItem(itemId, phaseId, teamId, sectionId)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      router.refresh()
    } catch {
      toast.error('Failed to delete item')
    } finally {
      setDeletingItem(null)
    }
  }

  // ── Utility functions ───────────────────────────────────────

  function formatDate(date: string | null): string {
    if (!date) return ''
    // Date-only strings (YYYY-MM-DD) parse as UTC midnight, which renders as
    // the previous day in timezones west of UTC. Pin to local midnight so the
    // date shows in the viewer's zone.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(date + 'T00:00:00')
      : new Date(date)
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  function getInitials(name?: string | null): string {
    if (!name) return '?'
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  function getMemberName(userId: string): string {
    const member = members.find(m => m.user_id === userId)
    return member?.profile?.name || member?.profile?.email || 'Unknown'
  }

  /** Get phase progress from checklist items. Returns null if no items. */
  function getPhaseProgress(phase: ProjectPhase): { completed: number; total: number; percent: number } | null {
    const items = phase.phase_items
    if (!items || items.length === 0) return null
    const completed = items.filter(i => i.is_completed).length
    return { completed, total: items.length, percent: Math.round((completed / items.length) * 100) }
  }

  // ── Overall progress ───────────────────────────────────────

  const completedCount = phases.filter((p) => p.status === 'completed').length
  const inProgressCount = phases.filter((p) => p.status === 'in_progress').length
  const blockedCount = phases.filter((p) => p.status === 'blocked').length

  return (
    <div className="space-y-4">
      {/* Read-only roadmap the professor defined for this project. */}
      {masterPhases.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-primary/5 to-transparent">
          <div className="flex items-center gap-2.5 border-b border-border/60 px-5 py-3.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <MapPin className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-none">Project roadmap</p>
              <p className="mt-1 text-xs text-muted-foreground">The path your professor mapped out</p>
            </div>
          </div>

          <ol className="relative space-y-3 px-5 py-4 pl-11">
            {/* connecting rail */}
            <span className="absolute bottom-6 left-[26px] top-6 w-px bg-border" aria-hidden />
            {masterPhases.map((mp, idx) => {
              const today = roadmapTodayStr()
              const current = !!mp.startDate && !!mp.endDate && mp.startDate <= today && today <= mp.endDate
              const done = !!mp.endDate && mp.endDate < today
              return (
                <li key={mp.id} className="relative">
                  {/* node */}
                  <span
                    className={cn(
                      'absolute -left-[26px] top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ring-4 ring-background',
                      current
                        ? 'bg-primary text-primary-foreground'
                        : done
                          ? 'bg-success-muted text-success-muted-foreground'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : idx + 1}
                  </span>
                  <div
                    className={cn(
                      'rounded-xl border bg-card p-3 transition-colors',
                      current ? 'border-primary/40 shadow-sm' : 'border-border',
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{mp.name}</span>
                        {current && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            In progress
                          </span>
                        )}
                      </div>
                      {(mp.startDate || mp.endDate) && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                          <Calendar className="h-3 w-3" />
                          {fmtRoadmapRange(mp.startDate, mp.endDate)}
                        </span>
                      )}
                    </div>
                    {mp.items.length > 0 ? (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {mp.items.map((it, i) => {
                          const Icon = ROADMAP_ITEM_ICON[it.type] ?? FileText
                          const cls = cn(
                            'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 pl-1.5 pr-2.5 text-xs',
                            it.href && 'transition-colors hover:border-primary/40 hover:bg-muted',
                          )
                          const inner = (
                            <>
                              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-background text-muted-foreground">
                                <Icon className="h-3 w-3" />
                              </span>
                              <span className="text-foreground">{it.title}</span>
                              {/* Neutral on purpose: green would read as "good" on any
                                  score, including a failing one. The number speaks. */}
                              {it.grade && (
                                <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-foreground tabular-nums">
                                  {it.grade.score}
                                  {it.grade.possible != null ? `/${it.grade.possible}` : ''}
                                </span>
                              )}
                            </>
                          )
                          return it.href ? (
                            <Link key={i} href={it.href} className={cls}>
                              {inner}
                            </Link>
                          ) : (
                            <span key={i} className={cls}>
                              {inner}
                            </span>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="mt-1.5 text-xs italic text-muted-foreground/60">No items in this phase yet</p>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Project Phases</h2>
          {phases.length > 0 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {completedCount} completed, {inProgressCount} in progress
              {blockedCount > 0 && `, ${blockedCount} blocked`}
            </p>
          )}
        </div>
        {isMember && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAiDialogOpen(true)}
              title="Generate phases with AI from your canvases"
            >
              <Bot className="h-4 w-4 mr-1" />
              Generate with AI
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLinkAnchorId(undefined)
                setLinkOpen(true)
              }}
              title="Create a phase from a published assignment"
            >
              <Link2 className="h-4 w-4 mr-1" />
              Link Assignment
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setInsertAnchorId(undefined)
                setCreateOpen(true)
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Phase
            </Button>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {phases.length > 0 && (
        <div className="h-2 w-full bg-muted rounded-full overflow-hidden flex">
          {completedCount > 0 && (
            <div
              className="h-full bg-success transition duration-200 ease-out"
              style={{ width: `${(completedCount / phases.length) * 100}%` }}
            />
          )}
          {inProgressCount > 0 && (
            <div
              className="h-full bg-foreground/50 transition duration-200 ease-out"
              style={{ width: `${(inProgressCount / phases.length) * 100}%` }}
            />
          )}
          {blockedCount > 0 && (
            <div
              className="h-full bg-destructive transition duration-200 ease-out"
              style={{ width: `${(blockedCount / phases.length) * 100}%` }}
            />
          )}
        </div>
      )}

      {/* Timeline */}
      {phases.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No phases yet"
          description={
            isOwner
              ? 'Break your project into phases to track progress.'
              : 'No phases have been created for this project yet.'
          }
        />
      ) : (
        <div className="relative">
          {phases.map((phase, index) => {
            const isCompleted = phase.status === 'completed'
            const isInProgress = phase.status === 'in_progress'
            const isBlocked = phase.status === 'blocked'
            const isToggling = togglingPhase === phase.id
            const assignedIds = phase.assigned_to || []
            const isLast = index === phases.length - 1
            const color = phaseColors[phase.status] || phaseColors.not_started
            const progress = getPhaseProgress(phase)
            const hasItems = progress !== null

            // Anchor for the divider rendered BEFORE this phase. At index 0
            // there is no preceding phase, so we pass `null` meaning
            // "insert at position 0". For later indices we anchor after
            // the previous phase by id.
            const dividerAnchorId: string | null =
              index === 0 ? null : phases[index - 1].id

            // Timeline dot colors
            const dotBg = isCompleted ? 'bg-success' : isInProgress ? 'bg-foreground/60' : isBlocked ? 'bg-destructive' : 'bg-muted-foreground/40'
            const dotRing = isCompleted ? 'ring-success/25' : isInProgress ? 'ring-foreground/15' : isBlocked ? 'ring-destructive/25' : 'ring-muted-foreground/20'
            const dotText = 'text-background'

            return (
              <div key={phase.id}>
                {/* Insert-here divider — visible only to team members. Sits
                 *  BEFORE each phase. At index 0 it inserts at the very
                 *  top; otherwise it splices in after the previous phase. */}
                {isMember && (
                  <InsertPhaseDivider
                    onNewPhase={() => {
                      setInsertAnchorId(dividerAnchorId)
                      setCreateOpen(true)
                    }}
                    onLinkAssignment={() => {
                      setLinkAnchorId(dividerAnchorId)
                      setLinkOpen(true)
                    }}
                  />
                )}
                <div className="relative flex gap-4">
                {/* Timeline spine */}
                <div className="flex flex-col items-center w-8 shrink-0">
                  {/* Dot */}
                  <div className={cn(
                    'relative z-10 flex items-center justify-center h-8 w-8 rounded-full ring-4 transition-colors',
                    dotBg, dotRing,
                  )}>
                    <span className={cn('text-xs font-bold', dotText)}>{index + 1}</span>
                  </div>
                  {/* Connector line */}
                  {!isLast && (
                    <div className={cn(
                      'w-0.5 flex-1 min-h-[24px]',
                      isCompleted ? 'bg-success/50' : 'bg-border',
                    )} />
                  )}
                </div>

                {/* Phase card + checklist column */}
                <div className="flex-1 mb-4">
                <div className={cn(
                  'border rounded-xl p-4 transition-colors bg-card',
                  isCompleted && 'border-success/30',
                  isInProgress && 'border-border',
                  isBlocked && 'border-destructive/30',
                )}>
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      {isMember && (
                        <div className="pt-0.5 shrink-0">
                          <Checkbox
                            checked={isCompleted}
                            disabled={isToggling || hasItems}
                            onCheckedChange={() => handleToggleComplete(phase)}
                            aria-label={
                              hasItems
                                ? 'Phase status is managed by checklist items'
                                : `Mark "${phase.title}" as ${isCompleted ? 'incomplete' : 'complete'}`
                            }
                            title={hasItems ? 'Status auto-managed by checklist items' : undefined}
                          />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className={cn(
                            'font-semibold text-sm text-foreground',
                            isCompleted && 'line-through',
                          )}>
                            {phase.title}
                          </h3>
                          <Badge className={cn('text-[10px] px-1.5 py-0', color)}>
                            {PHASE_STATUS_LABELS[phase.status as keyof typeof PHASE_STATUS_LABELS] || phase.status}
                          </Badge>
                          {phase.assignment_id && (
                            <Badge className="text-[10px] px-1.5 py-0 gap-0.5 bg-info-muted text-info-muted-foreground">
                              <FileText className="h-3 w-3" />
                              Assignment
                            </Badge>
                          )}
                          {progress && (
                            <span className="text-[10px] text-muted-foreground font-medium">
                              {progress.completed}/{progress.total} items
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {isMember && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => setEditTarget(phase)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-9 w-9 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteTarget(phase)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Description */}
                  {phase.description && (
                    <p className={cn(
                      'text-sm text-foreground/80 mt-2 whitespace-pre-wrap',
                      isMember && 'ml-7',
                    )}>
                      {phase.description}
                    </p>
                  )}

                  {/* Phase item progress bar */}
                  {progress && (
                    <div className={cn('mt-2', isMember && 'ml-7')}>
                      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            'h-full transition duration-200 ease-out rounded-full',
                            progress.percent === 100 ? 'bg-success' : progress.percent > 0 ? 'bg-foreground/50' : 'bg-border',
                          )}
                          style={{ width: `${progress.percent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Dates + Assignees row */}
                  <div className={cn('mt-3 flex flex-col gap-2', isMember && 'ml-7')}>
                    {(phase.start_date || phase.due_date) && (
                      <div className="flex items-center gap-3 text-xs text-foreground/70">
                        {phase.start_date && (
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDate(phase.start_date)}
                          </span>
                        )}
                        {phase.start_date && phase.due_date && (
                          <span className="text-foreground/40">&rarr;</span>
                        )}
                        {phase.due_date && (
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDate(phase.due_date)}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Assigned members */}
                    {(assignedIds.length > 0 || isOwner) && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {assignedIds.map((userId) => {
                          const name = getMemberName(userId)
                          return (
                            <div key={userId} className="flex items-center gap-1 bg-secondary rounded-full pl-0.5 pr-2 py-0.5">
                              <Avatar className="h-5 w-5">
                                <AvatarFallback className="text-[9px] font-medium">{getInitials(name)}</AvatarFallback>
                              </Avatar>
                              <span className="text-[11px] text-foreground/80 font-medium">{name.split(' ')[0]}</span>
                              {isOwner && (
                                <button
                                  className="ml-0.5 text-foreground/50 hover:text-destructive"
                                  onClick={() => {
                                    const updated = assignedIds.filter(id => id !== userId)
                                    updatePhaseAssignees(phase.id, teamId, sectionId, updated)
                                      .then(res => {
                                        if ('error' in res && res.error) toast.error(res.error)
                                        else router.refresh()
                                      })
                                  }}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          )
                        })}
                        {isOwner && (
                          <AssignMemberPopover
                            members={members}
                            assignedIds={assignedIds}
                            onAssign={(userId) => {
                              const updated = [...assignedIds, userId]
                              updatePhaseAssignees(phase.id, teamId, sectionId, updated)
                                .then(res => {
                                  if ('error' in res && res.error) toast.error(res.error)
                                  else router.refresh()
                                })
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Checklist items — below the card, indented */}
                {(hasItems || isMember) && (
                  <div className="mt-2 ml-4 pl-4 border-l-2 border-dashed border-muted-foreground/20">
                    {/* Existing items */}
                    {phase.phase_items && phase.phase_items.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        {phase.phase_items.map(item => {
                          const isItemToggling = togglingItem === item.id
                          const isItemDeleting = deletingItem === item.id
                          const isItemEditing = editingItem?.id === item.id

                          if (isItemEditing) {
                            return (
                              <form
                                key={item.id}
                                className="flex items-center gap-2"
                                onSubmit={(e) => { e.preventDefault(); handleSaveItemEdit() }}
                              >
                                <Input
                                  value={editingItemTitle}
                                  onChange={(e) => setEditingItemTitle(e.target.value)}
                                  className="h-7 text-sm flex-1"
                                  autoFocus
                                  disabled={savingItemEdit}
                                />
                                <Button type="submit" size="sm" className="h-7 w-7 p-0" disabled={savingItemEdit || !editingItemTitle.trim()}>
                                  <Check className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => { setEditingItem(null); setEditingItemTitle('') }}
                                  disabled={savingItemEdit}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </form>
                            )
                          }

                          return (
                            <div key={item.id} className="flex items-center gap-2 group">
                              {isMember ? (
                                <Checkbox
                                  checked={item.is_completed}
                                  disabled={isItemToggling || isItemDeleting}
                                  onCheckedChange={(checked) => handleToggleItem(item.id, phase.id, !!checked)}
                                  className="shrink-0"
                                />
                              ) : (
                                <Checkbox
                                  checked={item.is_completed}
                                  disabled
                                  className="shrink-0"
                                />
                              )}
                              <span className={cn(
                                'text-sm flex-1 min-w-0',
                                item.is_completed && 'line-through text-muted-foreground',
                              )}>
                                {item.title}
                              </span>
                              {isMember && (
                                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
                                  <button
                                    className="p-2 -m-1 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors"
                                    onClick={() => {
                                      setEditingItem({ id: item.id, phaseId: phase.id, title: item.title })
                                      setEditingItemTitle(item.title)
                                    }}
                                    disabled={isItemDeleting}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    className="p-2 -m-1 text-muted-foreground hover:text-destructive rounded-full hover:bg-destructive/10 transition-colors"
                                    onClick={() => handleDeleteItem(item.id, phase.id)}
                                    disabled={isItemDeleting}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Add item inline form */}
                    {isMember && (
                      <div className="mt-1.5">
                        {addingItemToPhase === phase.id ? (
                          <form
                            className="flex items-center gap-2"
                            onSubmit={(e) => { e.preventDefault(); handleAddItem(phase.id) }}
                          >
                            <Input
                              value={newItemTitle}
                              onChange={(e) => setNewItemTitle(e.target.value)}
                              placeholder="Add a checklist item..."
                              className="h-7 text-sm flex-1"
                              autoFocus
                              disabled={addingItem}
                            />
                            <Button type="submit" size="sm" className="h-7" disabled={addingItem || !newItemTitle.trim()}>
                              {addingItem ? '...' : 'Add'}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7"
                              onClick={() => { setAddingItemToPhase(null); setNewItemTitle('') }}
                              disabled={addingItem}
                            >
                              Cancel
                            </Button>
                          </form>
                        ) : (
                          <button
                            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                            onClick={() => { setAddingItemToPhase(phase.id); setNewItemTitle('') }}
                          >
                            <Plus className="h-3 w-3" />
                            Add item
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Professor comments on this phase */}
                <PhaseCommentsInline phaseId={phase.id} sectionId={sectionId} initialCount={commentCounts[phase.id] || 0} />
              </div>
              </div>
              </div>
            )
          })}
          {/* Trailing divider — inserts a new phase AFTER the last existing
           *  phase. Mirrors the dividers between cards for consistency. */}
          {isMember && phases.length > 0 && (
            <InsertPhaseDivider
              onNewPhase={() => {
                setInsertAnchorId(phases[phases.length - 1].id)
                setCreateOpen(true)
              }}
              onLinkAssignment={() => {
                setLinkAnchorId(phases[phases.length - 1].id)
                setLinkOpen(true)
              }}
            />
          )}
        </div>
      )}

      {/* Create Phase Dialog */}
      {isMember && (
        <PhaseFormDialog
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open)
            // Clear the insertion anchor once the dialog closes so the next
            // "Add Phase" click (via the top button) defaults back to append.
            if (!open) setInsertAnchorId(undefined)
          }}
          sectionId={sectionId}
          projectId={project.id}
          teamId={teamId}
          mode="create"
          insertAfterPhaseId={insertAnchorId}
        />
      )}

      {/* Link Assignment Dialog */}
      {isMember && (
        <LinkAssignmentDialog
          open={linkOpen}
          onOpenChange={(open) => {
            setLinkOpen(open)
            if (!open) setLinkAnchorId(undefined)
          }}
          sectionId={sectionId}
          projectId={project.id}
          teamId={teamId}
          insertAfterPhaseId={linkAnchorId}
        />
      )}

      {/* Edit Phase Dialog */}
      {editTarget && (
        <PhaseFormDialog
          open={!!editTarget}
          onOpenChange={(open) => !open && setEditTarget(null)}
          sectionId={sectionId}
          projectId={project.id}
          teamId={teamId}
          mode="edit"
          phase={editTarget}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Phase</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the phase{' '}
              <strong>&quot;{deleteTarget?.title}&quot;</strong>? This action cannot be undone.
              {deleteTarget?.phase_items && deleteTarget.phase_items.length > 0 && (
                <> All {deleteTarget.phase_items.length} checklist item(s) will also be deleted.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
            variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* AI Generate Phases Dialog — always mounted for team members.
       *  The dialog itself handles the case where the team has neither
       *  canvases nor a legacy planning_doc. */}
      {isMember && (
        <AIGeneratePhasesDialog
          open={aiDialogOpen}
          onOpenChange={setAiDialogOpen}
          sectionId={sectionId}
          projectId={project.id}
          teamId={teamId}
          planningDoc={planningDoc}
        />
      )}
    </div>
  )
}

// ── Link Assignment Dialog ──────────────────────────────────────
//
// Lets a team member turn a published assignment into a new phase. The
// assignment's title/description/due date are copied once into the phase
// (see createPhaseFromAssignment); the phase is editable afterward. The
// list is lazy-loaded when the dialog opens so it costs nothing at rest.

interface LinkableAssignment {
  id: string
  title: string
  due_at: string | null
  points: number
}

interface LinkAssignmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  projectId: string
  teamId: string
  insertAfterPhaseId?: string | null
}

function LinkAssignmentDialog({ open, onOpenChange, sectionId, projectId, teamId, insertAfterPhaseId }: LinkAssignmentDialogProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [assignments, setAssignments] = useState<LinkableAssignment[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    if (!open) return
    setSelectedId(null)
    setLoading(true)
    getLinkableAssignments(sectionId)
      .then((result) => {
        if (result.data) setAssignments(result.data as LinkableAssignment[])
        else if (result.error) toast.error(result.error)
      })
      .finally(() => setLoading(false))
  }, [open, sectionId])

  async function handleLink() {
    if (!selectedId) return
    setLinking(true)
    try {
      const result = await createPhaseFromAssignment(teamId, projectId, sectionId, selectedId, insertAfterPhaseId)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Assignment linked as a phase')
      onOpenChange(false)
      router.refresh()
    } catch {
      toast.error('Failed to link assignment')
    } finally {
      setLinking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Link an assignment</DialogTitle>
          <DialogDescription>
            Create a phase from a published assignment. Its details are copied in once — you can edit the phase afterward.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2Icon className="h-5 w-5 animate-spin" />
          </div>
        ) : assignments.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No published assignments"
            description="There are no published assignments in this course to link yet."
          />
        ) : (
          <div className="max-h-[320px] overflow-y-auto -mx-1 px-1 space-y-1.5">
            {assignments.map((a) => {
              const selected = selectedId === a.id
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedId(a.id)}
                  className={cn(
                    'w-full text-left rounded-xl border p-3 transition duration-150',
                    selected ? 'border-primary bg-accent' : 'border-border hover:bg-muted',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{a.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {a.due_at
                          ? `Due ${new Date(a.due_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                          : 'No due date'}
                        {' · '}
                        {a.points} pts
                      </p>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={linking}>
            Cancel
          </Button>
          <Button onClick={handleLink} disabled={!selectedId || linking}>
            {linking ? 'Linking...' : 'Link Assignment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Insert-between-phases divider ───────────────────────────────
//
// A slim but always-visible affordance between phase cards (and above the
// first / below the last). Chip is persistently shown with a dashed border
// so it reads as a "placeholder slot" at rest; on hover/focus it fills in
// and the hairline rule darkens. Clicking or activating opens the create
// dialog anchored at that position.

function InsertPhaseDivider({
  onNewPhase,
  onLinkAssignment,
}: {
  onNewPhase: () => void
  onLinkAssignment: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="group/divider relative h-9 my-1 flex items-center">
      {/* Click target — full width so the whole strip is hit-friendly. It
          triggers a small menu offering a blank phase or one built from a
          published assignment, both inserted at this position. */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="absolute inset-0 w-full outline-none cursor-pointer"
            aria-label="Insert a phase here"
          >
            <span className="sr-only">Insert a phase here</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-52 p-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onNewPhase()
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring transition duration-150"
          >
            <Plus className="h-4 w-4 text-muted-foreground" />
            Blank phase
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onLinkAssignment()
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring transition duration-150"
          >
            <Link2 className="h-4 w-4 text-muted-foreground" />
            From assignment
          </button>
        </PopoverContent>
      </Popover>

      {/* Hairline rule — visible at rest, darker on hover/focus. */}
      <div
        className="absolute left-10 right-0 h-px bg-border opacity-70 group-hover/divider:opacity-100 group-focus-within/divider:opacity-100 transition-opacity pointer-events-none"
      />

      {/* Centered chip — always visible; fills in on hover/focus. */}
      <div
        className={cn(
          'relative mx-auto flex items-center gap-1.5 rounded-full border border-dashed border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm transition duration-200 ease-out pointer-events-none',
          'group-hover/divider:border-solid group-hover/divider:border-foreground/60 group-hover/divider:text-foreground group-hover/divider:shadow-md',
          'group-focus-within/divider:border-solid group-focus-within/divider:border-foreground/60 group-focus-within/divider:text-foreground group-focus-within/divider:ring-2 group-focus-within/divider:ring-foreground/40',
        )}
      >
        <Plus className="h-3.5 w-3.5" />
        Insert phase here
      </div>
    </div>
  )
}

// ── Assign Member Popover ────────────────────────────────────────

interface AssignMemberPopoverProps {
  members: TeamMember[]
  assignedIds: string[]
  onAssign: (userId: string) => void
}

function AssignMemberPopover({ members, assignedIds, onAssign }: AssignMemberPopoverProps) {
  const [open, setOpen] = useState(false)
  const unassigned = members.filter(m => !assignedIds.includes(m.user_id))

  if (unassigned.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-dashed rounded-full px-2 py-0.5 transition-colors">
          <UserPlus className="h-3 w-3" />
          Assign
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        {unassigned.map(member => (
          <button
            key={member.user_id}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-muted transition-colors"
            onClick={() => {
              onAssign(member.user_id)
              setOpen(false)
            }}
          >
            <Avatar className="h-5 w-5">
              <AvatarFallback className="text-[9px]">
                {(member.profile?.name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">{member.profile?.name || member.profile?.email || 'Unknown'}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

// ── Phase Form Dialog (Create / Edit) ───────────────────────────

interface PhaseFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  projectId: string
  teamId: string
  mode: 'create' | 'edit'
  phase?: ProjectPhase
  /**
   * Only meaningful in create mode:
   *   undefined → append to end (the default "Add Phase" flow)
   *   null      → insert at position 0 (before all other phases)
   *   string    → insert immediately after the phase with this id
   */
  insertAfterPhaseId?: string | null
}

function PhaseFormDialog({
  open,
  onOpenChange,
  sectionId,
  projectId,
  teamId,
  mode,
  phase,
  insertAfterPhaseId,
}: PhaseFormDialogProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const isCreate = mode === 'create'

  const form = useForm<CreatePhaseInput>({
    resolver: zodResolver(isCreate ? createPhaseSchema : updatePhaseSchema),
    defaultValues: {
      title: phase?.title || '',
      description: phase?.description || '',
      status: (phase?.status as CreatePhaseInput['status']) || 'not_started',
      start_date: phase?.start_date || '',
      due_date: phase?.due_date || '',
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  const onSubmit = async (data: CreatePhaseInput) => {
    setIsSubmitting(true)
    try {
      const result = isCreate
        ? await createStudentPhase(teamId, projectId, sectionId, data, insertAfterPhaseId)
        : await updateStudentPhase(phase!.id, teamId, sectionId, data as UpdatePhaseInput)

      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }

      toast.success(isCreate ? 'Phase created' : 'Phase updated')
      form.reset()
      onOpenChange(false)
      router.refresh()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    // Label shifts slightly based on WHERE the new phase will land, so the
    // user knows whether this creates a phase at the top, between two
    // existing phases, or at the end of the list.
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {isCreate
              ? insertAfterPhaseId === undefined
                ? 'Add Phase'
                : insertAfterPhaseId === null
                  ? 'Insert Phase at Top'
                  : 'Insert Phase'
              : 'Edit Phase'}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? insertAfterPhaseId === undefined
                ? 'Create a new phase to organize your project timeline.'
                : insertAfterPhaseId === null
                  ? 'This phase will become the first in your timeline.'
                  : 'This phase will be inserted between two existing phases.'
              : 'Update the phase details and status.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phase Title *</FormLabel>
                  <FormControl>
                    <Input placeholder="Research & Planning" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Describe this phase..."
                      className="resize-none"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PHASE_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {PHASE_STATUS_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="start_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} value={field.value || ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="due_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} value={field.value || ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? (isCreate ? 'Creating...' : 'Saving...')
                  : (isCreate ? 'Create Phase' : 'Save Changes')}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ── Inline Professor Comments on a Phase ───────────────────────

function PhaseCommentsInline({ phaseId, sectionId, initialCount = 0 }: { phaseId: string; sectionId: string; initialCount?: number }) {
  const [expanded, setExpanded] = useState(false)
  const [comments, setComments] = useState<PhaseCommentData[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  function handleToggle() {
    if (!expanded && !loaded) {
      setLoading(true)
      getPhaseCommentsForStudent(phaseId, sectionId).then((result) => {
        if (result.data) setComments(result.data)
        setLoading(false)
        setLoaded(true)
      })
    }
    setExpanded(!expanded)
  }

  function getInitials(name: string | null | undefined): string {
    if (!name) return '?'
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
  }

  const displayCount = loaded ? comments.length : initialCount

  // Hide if we know there are no comments (either from pre-fetched count or after loading)
  if (displayCount === 0 && !expanded) return null

  return (
    <div className="mt-2 ml-4">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <MessageSquare className="h-3 w-3" />
        <span>
          {displayCount} instructor comment{displayCount !== 1 ? 's' : ''}
        </span>
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {loading ? (
            <div className="flex items-center gap-2 py-2">
              <Loader2Icon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Loading...</span>
            </div>
          ) : comments.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 py-1">
              No instructor comments on this phase yet.
            </p>
          ) : (
            comments.map((c) => (
              <div key={c.id} className="flex gap-2 border-l-2 border-foreground/20 pl-3 py-1">
                <Avatar className="h-5 w-5 shrink-0 mt-0.5">
                  <AvatarFallback className="text-[9px]">
                    {getInitials(c.author?.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium">{c.author?.name || 'Instructor'}</span>
                    <span className="text-[10px] text-muted-foreground/50">
                      {new Date(c.created_at).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric',
                      })}
                    </span>
                  </div>
                  <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">
                    {c.content}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
