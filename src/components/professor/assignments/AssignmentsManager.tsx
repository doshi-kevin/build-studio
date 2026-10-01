/**
 * AssignmentsManager: professor's assignment list for a section.
 * Hosts the create wizard and per-assignment publish/delete actions.
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FileText, Trash2, Clock, Paperclip, CalendarClock, Plus, Search, LayoutGrid, AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/ui/empty-state'
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
import { parseAccepts, labelForKind, type AssignmentRow } from '@/lib/validations/assignment'
import { deleteAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { LocalDateTime } from '@/components/shared/LocalDateTime'

interface AssignmentsManagerProps {
  sectionId: string
  assignments: AssignmentRow[]
  /**
   * Whether the viewer may delete. Gated on the SAME predicate the action uses
   * (canWriteAsProfessor), because an enabled control that the server refuses is
   * the other half of #749 — a TA was shown Delete on every assignment and only
   * found out it wasn't theirs by clicking it.
   */
  canDelete: boolean
  /** Assignment ids that have at least one activity_skills row. Undefined while
   *  unknown, which renders no marks at all rather than marking everything. */
  mappedAssignmentIds?: string[]
}

function acceptsLabel(settings: AssignmentRow['settings']): string {
  const { fileTypes } = parseAccepts(settings)
  if (fileTypes.length === 0) return 'Text response'
  return `${fileTypes.map(labelForKind).join(', ')} + text`
}

const STATUS_STYLES: Record<string, string> = {
  published: 'bg-primary/10 text-primary border-primary/20',
  scheduled: 'bg-secondary text-secondary-foreground border-border',
  draft: 'bg-muted text-muted-foreground border-border',
  closed: 'bg-secondary text-secondary-foreground border-border',
  archived: 'bg-muted text-muted-foreground border-border',
}

type StatusFilter = 'all' | 'published' | 'scheduled' | 'draft'

export function AssignmentsManager({ sectionId, assignments, canDelete, mappedAssignmentIds }: AssignmentsManagerProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return assignments.filter((a) => {
      // "All" shows only live assignments (published + scheduled); drafts live solely under Drafts.
      const matchesStatus =
        statusFilter === 'all' ? a.status !== 'draft' : a.status === statusFilter
      const matchesSearch = !q || a.title.toLowerCase().includes(q)
      return matchesStatus && matchesSearch
    })
  }, [assignments, searchQuery, statusFilter])

  /**
   * Where a draft re-opens. Notebook and Verbal drafts return to the SAME editor they were
   * created in (resolved from settings.kind, with a fallback to the stored config); plain
   * file/text assignments have no studio editor and use the detail page + edit wizard.
   */
  function editorHref(a: AssignmentRow): string | null {
    const s = (a.settings ?? {}) as Record<string, unknown>
    if (s.kind === 'notebook' || s.studio) return `/professor/courses/${sectionId}/assignments/${a.id}/studio`
    if (s.kind === 'verbal' || s.verbalAssessment) return `/professor/courses/${sectionId}/assignments/${a.id}/verbal`
    return null
  }

  /**
   * Where the title link goes. Drafts/scheduled studio assignments open the editor (still
   * authoring); once published they open the detail page (Assignment details + Grading), with
   * the editor reachable from there. Plain assignments always open the detail page.
   */
  function primaryHref(a: AssignmentRow): string {
    const detail = `/professor/courses/${sectionId}/assignments/${a.id}`
    const editor = editorHref(a)
    if (editor && (a.status === 'draft' || a.status === 'scheduled')) return editor
    return detail
  }

  function confirmDelete() {
    if (!deleting) return
    startTransition(async () => {
      const result = await deleteAssignment(sectionId, deleting.id)
      if ('error' in result) toast.error(result.error)
      else {
        toast.success('Assignment deleted')
        setDeleting(null)
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">
            Assignments
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {assignments.length > 0 && (
            <>
              <Button asChild variant="outline" className="shrink-0">
                <Link
                  href={`/professor/courses/${sectionId}/assignments/new/marketplace`}
                  aria-label="Browse templates"
                >
                  <LayoutGrid className="h-4 w-4" />
                  <span className="hidden sm:inline">Browse templates</span>
                </Link>
              </Button>
              <Button asChild className="shrink-0">
                <Link
                  href={`/professor/courses/${sectionId}/assignments/new`}
                  aria-label="New assignment"
                >
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">New assignment</span>
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>

      {assignments.length === 0 ? (
        <EmptyState
          variant="teaching"
          icon={FileText}
          title="Create your first assignment"
          description="Decide what students submit: a PDF, an image, other files, or just a written response, and review it all in one place."
        >
          <Button asChild>
            <Link href={`/professor/courses/${sectionId}/assignments/new`}>
              <Plus className="h-4 w-4" />
              New assignment
            </Link>
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search assignments..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <ToggleGroup
              type="single"
              value={statusFilter}
              onValueChange={(v) => v && setStatusFilter(v as StatusFilter)}
              variant="outline"
              size="sm"
              className="w-full justify-start overflow-x-auto sm:w-auto sm:shrink-0"
            >
              <ToggleGroupItem value="all" aria-label="All assignments">All</ToggleGroupItem>
              <ToggleGroupItem value="published" aria-label="Published assignments">Published</ToggleGroupItem>
              <ToggleGroupItem value="scheduled" aria-label="Scheduled assignments">Scheduled</ToggleGroupItem>
              <ToggleGroupItem value="draft" aria-label="Draft assignments">Drafts</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {filtered.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              No assignments match your filters.
            </p>
          ) : (
        <ul className="space-y-3">
          {filtered.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md sm:gap-4"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                <FileText className="h-5 w-5 text-muted-foreground" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={primaryHref(a)}
                    className="min-w-0 truncate font-medium text-foreground hover:underline"
                  >
                    {a.title}
                  </Link>

                  <div className="flex shrink-0 items-center gap-1">
                    <Badge
                      variant="outline"
                      className={`capitalize ${STATUS_STYLES[a.status] ?? ''}`}
                    >
                      {a.status}
                    </Badge>

                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="-mr-1 h-8 w-8 text-muted-foreground hover:text-destructive"
                        disabled={isPending}
                        onClick={() => setDeleting({ id: a.id, title: a.title })}
                        aria-label={`Delete ${a.title}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {a.due_at ? <LocalDateTime iso={a.due_at} mode="date" prefix="Due" /> : 'No due date'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Paperclip className="h-3.5 w-3.5" />
                    {acceptsLabel(a.settings)}
                  </span>
                  <span className="tabular-nums">{a.is_graded ? `${a.points} pts` : 'Ungraded'}</span>
                  {/* Graded but feeding no skill. Mastery moves only for activities
                      mapped in activity_skills, so this one is invisible to the
                      roadmap however well students do on it. Tagging a module is the
                      fix, which is why the copy points there. */}
                  {mappedAssignmentIds && !mappedAssignmentIds.includes(a.id) && (
                    <span
                      className="inline-flex items-center gap-1 text-warning-muted-foreground"
                      title="This assignment isn't mapped to any skill, so it doesn't count toward Topic Mastery. Open it and tag a module to connect it."
                    >
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      No skills mapped
                    </span>
                  )}
                  {a.status === 'scheduled' && a.scheduled_publish_at && (
                    <span className="inline-flex items-center gap-1" suppressHydrationWarning>
                      <CalendarClock className="h-3.5 w-3.5" />
                      Publishes {new Date(a.scheduled_publish_at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
          )}
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleting?.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the assignment and every student submission for it. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                confirmDelete()
              }}
              disabled={isPending}
              className="bg-destructive hover:bg-destructive/90 focus:ring-destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  )
}
