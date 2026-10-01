/**
 * StudentProjectList — grid of project assignments visible to a student.
 *
 * Shows assignment cards with title, status, team count, due date, and
 * a three-dot quick action menu (Create Team / Join Team / View My Team).
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  FolderKanban,
  Search,
  Users,
  CalendarDays,
  UsersRound,
  Plus,
  UserPlus,
  MoreHorizontal,
  Eye,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { PROJECT_STATUS_LABELS } from '@/lib/validations/project'
import { CreateTeamDialog } from '@/components/student/projects/CreateTeamDialog'

// ── Status styles ────────────────────────────────────────────────

const statusStyles: Record<string, { dot: string; text: string }> = {
  draft:     { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  active:    { dot: 'bg-foreground/60',       text: 'text-muted-foreground' },
  completed: { dot: 'bg-success',             text: 'text-success-muted-foreground' },
  archived:  { dot: 'bg-warning',             text: 'text-warning-muted-foreground' },
}

// ── Props ───────────────────────────────────────────────────────

interface ProjectListItem {
  id: string
  title?: string
  description?: string
  status: string
  max_team_size?: number
  due_date?: string | null
  project_teams?: unknown[]
}

interface StudentProjectListProps {
  sectionId: string
  projects: ProjectListItem[]
  userId: string
  /** Map of projectId -> teamId for projects where student has a team */
  userTeams: Record<string, string>
}

// ── Component ───────────────────────────────────────────────────

export function StudentProjectList(props: StudentProjectListProps) {
  const { sectionId, projects, userTeams } = props
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [createTeamTarget, setCreateTeamTarget] = useState<{ id: string; title: string } | null>(null)

  const filtered = useMemo(() => {
    if (!search.trim()) return projects
    const q = search.toLowerCase()
    return projects.filter((p) => p.title?.toLowerCase().includes(q))
  }, [projects, search])

  // Count how many projects the student has joined
  const joinedCount = Object.keys(userTeams).length
  const pendingCount = projects.length - joinedCount

  const summary = [
    `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`,
    `${joinedCount} joined`,
    `${pendingCount} pending`,
  ].join('  ·  ')

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <PageHeader
        title="Projects"
        description={projects.length > 0 ? summary : 'View project assignments and manage your team.'}
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

      {/* Project Grid */}
      {filtered.length === 0 ? (
        projects.length === 0 ? (
          <EmptyState
            variant="teaching"
            icon={FolderKanban}
            title="No project assignments yet"
            description="When your professor assigns a team project, it will appear here. You'll be able to form a team, plan your work, and submit it."
          />
        ) : (
          <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No projects match your search.
          </p>
        )
      ) : (
        <AnimatedList className="grid gap-3 md:grid-cols-2">
          {filtered.map((project) => {
            const teamCount = project.project_teams?.length ?? 0
            const style = statusStyles[project.status] || statusStyles.draft
            const hasTeam = !!userTeams[project.id]
            const maxTeams = project.max_team_size || 5

            return (
              <AnimatedItem key={project.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(`/student/courses/${sectionId}/projects/${project.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      router.push(`/student/courses/${sectionId}/projects/${project.id}`)
                    }
                  }}
                  className="group bg-card border border-border rounded-xl p-5 cursor-pointer hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {/* Top row */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0 flex-1">
                      {/* wrap-anywhere, NOT break-words (#699 part 6). Measured: with
                          `break-words` deployed an 88-char unbroken title still pushed the grid to
                          964px inside a 286px container, title unbroken on one line.

                          `overflow-wrap: break-word` only breaks a word inside a line box that
                          ALREADY has a definite width. It does not lower min-content, so the card
                          is a grid item in an auto track, the track sizes to the item's
                          min-content, and the item never receives the narrow width that would
                          trigger a break. `min-w-0` permits shrinking; it does not lower
                          min-content either, which is why having both changed nothing.

                          `overflow-wrap: anywhere` DOES lower min-content, which is the whole
                          difference. Preferred over `break-all`, which would chop ordinary
                          multi-word titles mid-word too. */}
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
                        <button
                          aria-label={`Actions for ${project.title}`}
                          className="h-9 w-9 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            router.push(`/student/courses/${sectionId}/projects/${project.id}`)
                          }}
                        >
                          <Eye className="h-3.5 w-3.5 mr-2" />
                          View Project
                        </DropdownMenuItem>
                        {hasTeam ? (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              router.push(`/student/courses/${sectionId}/projects/${project.id}`)
                            }}
                          >
                            <UsersRound className="h-3.5 w-3.5 mr-2" />
                            View My Team
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                setCreateTeamTarget({ id: project.id, title: project.title || 'Project' })
                              }}
                            >
                              <Plus className="h-3.5 w-3.5 mr-2" />
                              Create Team
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                router.push(`/student/courses/${sectionId}/projects/${project.id}`)
                              }}
                            >
                              <UserPlus className="h-3.5 w-3.5 mr-2" />
                              Join a Team
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Stats row */}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3 mb-4">
                    <span className="flex items-center gap-1 tabular-nums">
                      <UsersRound className="h-3 w-3" />
                      {teamCount} {teamCount === 1 ? 'team' : 'teams'}
                    </span>
                    <span className="flex items-center gap-1 tabular-nums">
                      <Users className="h-3 w-3" />
                      Max {maxTeams}
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
                  <div className="flex items-center justify-between pt-3 border-t border-border">
                    <div className={cn('inline-flex items-center gap-1.5 text-xs font-medium', style.text)}>
                      <div className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
                      {PROJECT_STATUS_LABELS[project.status as keyof typeof PROJECT_STATUS_LABELS] || project.status}
                    </div>
                    {hasTeam && (
                      <span className="text-xs font-medium text-success-muted-foreground">
                        Joined
                      </span>
                    )}
                  </div>
                </div>
              </AnimatedItem>
            )
          })}
        </AnimatedList>
      )}

      {/* Create Team Dialog */}
      {createTeamTarget && (
        <CreateTeamDialog
          open={!!createTeamTarget}
          onOpenChange={(open) => { if (!open) setCreateTeamTarget(null) }}
          sectionId={sectionId}
          projectId={createTeamTarget.id}
        />
      )}
    </div>
  )
}
