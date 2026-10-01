/**
 * ProjectList — searchable grid of project assignments for a course section.
 * Each card shows title, status, visibility, team count, and due date.
 * Includes a context menu with edit and delete options.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { FolderKanban, Plus, Search, UsersRound, CalendarDays, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CreateProjectDialog } from './CreateProjectDialog'
import { DeleteProjectDialog } from './DeleteProjectDialog'

const STATUS_STYLES: Record<string, { dot: string; text: string }> = {
  draft:     { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  active:    { dot: 'bg-foreground/60',       text: 'text-muted-foreground' },
  completed: { dot: 'bg-success',             text: 'text-success-muted-foreground' },
  archived:  { dot: 'bg-warning',             text: 'text-warning-muted-foreground' },
}

const VISIBILITY_STYLES: Record<string, { text: string; label: string }> = {
  private: { text: 'text-muted-foreground', label: 'Private' },
  course:  { text: 'text-muted-foreground', label: 'Course' },
  public:  { text: 'text-success-muted-foreground',          label: 'Public' },
}

interface ProjectListProps {
  sectionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projects: any[]
  enrolledCount: number
}

export function ProjectList({ sectionId, projects, enrolledCount }: ProjectListProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)

  const filtered = projects.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase())
  )

  const summary = `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}  ·  ${enrolledCount} enrolled ${enrolledCount === 1 ? 'student' : 'students'}`

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <PageHeader
        title="Projects"
        description={projects.length > 0 ? summary : 'Assign team-based projects and track student submissions.'}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New Project
          </Button>
        }
      />

      {/* Search — hidden in the empty state */}
      {projects.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
      )}

      {/* Grid */}
      {projects.length === 0 ? (
        <EmptyState
          variant="teaching"
          icon={FolderKanban}
          title="Create your first project"
          description="Set up a team-based assignment. Students form teams, build their work, and submit it here for you to review and grade."
        >
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New Project
          </Button>
        </EmptyState>
      ) : filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No projects match your search.
        </p>
      ) : (
        <AnimatedList className="grid gap-3 md:grid-cols-2">
          {filtered.map((project) => {
            const teamCount = project.project_teams?.length ?? 0
            const statusStyle = STATUS_STYLES[project.status] || STATUS_STYLES.draft
            const visibilityStyle = VISIBILITY_STYLES[project.visibility] || VISIBILITY_STYLES.private

            return (
              <AnimatedItem key={project.id}>
                <div
                  onClick={() => router.push(`/professor/courses/${sectionId}/projects/${project.id}`)}
                  className="group bg-card border border-border rounded-xl p-5 cursor-pointer hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out"
                >
                  {/* Top */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold leading-snug line-clamp-2 wrap-anywhere group-hover:text-primary transition-colors">
                        {project.title}
                      </h3>
                      {project.description && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                          {project.description}
                        </p>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <button className="h-9 w-9 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            router.push(`/professor/courses/${sectionId}/projects/${project.id}`)
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteTarget({ id: project.id, title: project.title })
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3 mb-4">
                    <span className="flex items-center gap-1 tabular-nums">
                      <UsersRound className="h-3 w-3" />
                      {teamCount} {teamCount === 1 ? 'team' : 'teams'}
                    </span>
                    {project.due_date && (() => {
                      // due_date is a DATE (no time). Anchor both sides to UTC midnight so the
                      // calendar day is compared/shown as stored, not shifted back by local tz.
                      const todayUtc = new Date(new Date().toISOString().slice(0, 10)).getTime()
                      const daysLeft = Math.ceil((new Date(project.due_date).getTime() - todayUtc) / (1000 * 60 * 60 * 24))
                      const urgencyColor = daysLeft < 0 ? 'text-destructive' : daysLeft <= 3 ? 'text-warning-muted-foreground' : 'text-muted-foreground'
                      const label = daysLeft < 0 ? 'Past due' : `Due ${new Date(project.due_date).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}`
                      return (
                        <span className={cn('flex items-center gap-1 font-medium tabular-nums', urgencyColor)}>
                          <CalendarDays className="h-3 w-3" />
                          {label}
                        </span>
                      )
                    })()}
                  </div>

                  {/* Footer */}
                  <div className="flex items-center gap-3 pt-3 border-t border-border">
                    <div className={cn('inline-flex items-center gap-1.5 text-xs font-medium capitalize', statusStyle.text)}>
                      <div className={cn('h-1.5 w-1.5 rounded-full', statusStyle.dot)} />
                      {project.status}
                    </div>
                    <span className="text-muted-foreground/40">·</span>
                    <span className={cn('text-xs font-medium capitalize', visibilityStyle.text)}>
                      {visibilityStyle.label}
                    </span>
                  </div>
                </div>
              </AnimatedItem>
            )
          })}
        </AnimatedList>
      )}

      {/* Keyed on the open flag so each open gets a FRESH form (#699 part 3). The dialog
          stays mounted and only calls form.reset() on SUCCESS, so cancelling and reopening
          showed the previous input — the same unkeyed-reused-dialog pattern already fixed
          in modules (#582) and the warehouse Move dialog (#594). Remounting is the
          cheapest correct fix here: nothing in it is expensive to construct. */}
      <CreateProjectDialog
        key={createOpen ? 'open' : 'closed'}
        open={createOpen}
        onOpenChange={setCreateOpen}
        sectionId={sectionId}
      />

      {deleteTarget && (
        <DeleteProjectDialog
          open={!!deleteTarget}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
          sectionId={sectionId}
          projectId={deleteTarget.id}
          projectTitle={deleteTarget.title}
        />
      )}
    </div>
  )
}
