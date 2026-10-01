/**
 * StudentTeamDetail — Tabbed workspace for a student team.
 *
 * Shows team info header with an inline metadata strip (members, phases done,
 * submission status, days left). Assignment details open in a right-side Sheet
 * panel so they never push tabs down. Tabs: Team, Discussions (with the
 * canvases previously in "Planning" now living in the sidebar's Resources
 * section), Phases, Submission, and optionally Class Teams.
 *
 * Type: Client Component
 */
'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  Pencil,
  Globe,
  Users,
  Clock,
  CalendarDays,
  FileText,
  Send,
  ListChecks,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  updateTeamSchema,
  type UpdateTeamInput,
  TEAM_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
  PROJECT_VISIBILITY_LABELS,
} from '@/lib/validations/project'
import { updateTeam } from '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
import { MarkdownLatex } from '@/components/shared/MarkdownLatex'
import { StudentTeamTab } from '@/components/student/projects/StudentTeamTab'
import { StudentPhasesTab, type MasterPhaseView } from '@/components/student/projects/StudentPhasesTab'
import { StudentSubmissionTab } from '@/components/student/projects/StudentSubmissionTab'
import { StudentDiscussionsTab } from '@/components/student/projects/StudentDiscussionsTab'
import { ProjectResourcesSection } from '@/components/student/projects/docs/ProjectResourcesSection'

// ── Badge colors ────────────────────────────────────────────────

const teamStatusColors: Record<string, string> = {
  active: 'bg-muted text-foreground',
  completed: 'bg-success-muted text-success-muted-foreground',
  archived: 'bg-warning-muted text-warning-muted-foreground',
}

// ── Props ───────────────────────────────────────────────────────

interface TeamProject {
  id: string
  title: string
  description?: string
  guidelines?: string
  status: string
  visibility?: string
  max_team_size?: number
  due_date?: string | null
  allow_team_workspace?: boolean
}

interface TeamData {
  id: string
  name: string
  description?: string
  planning_doc?: string
  status: string
  created_at?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  submission?: any
}

interface TeamMemberData {
  id: string
  user_id: string
  role: string
  contribution_summary?: string | null
  profile?: { name?: string | null; email?: string | null; avatar_url?: string | null }
}

interface TeamPhaseData {
  id: string
  title: string
  description?: string
  status: string
  start_date?: string | null
  due_date?: string | null
  position?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  phase_items?: any[]
}

interface ClassTeamInfo {
  id: string
  name: string
  status: string
  member_count?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  project_members?: any[]
  created_at?: string
}

interface StudentTeamDetailProps {
  sectionId: string
  project: TeamProject
  team: TeamData
  members: TeamMemberData[]
  phases: TeamPhaseData[]
  userRole: 'owner' | 'member' | 'viewer' | null
  userId: string
  /** All teams for this project (for class teams view) */
  allTeams?: ClassTeamInfo[]
  /** Professor-defined project roadmap (read-only, shown in Phases). */
  masterPhases?: MasterPhaseView[]
}

// ── Component ───────────────────────────────────────────────────

export function StudentTeamDetail({
  sectionId,
  project,
  team,
  members,
  phases,
  userRole,
  userId,
  allTeams = [],
  masterPhases = [],
}: StudentTeamDetailProps) {
  const statusColor = teamStatusColors[team.status] || teamStatusColors.active

  // Compute stats for inline display (moved out of Overview tab)
  const completedPhases = phases.filter((p) => p.status === 'completed').length
  const totalPhases = phases.length

  // The team chat workspace (Discussions tab) only exists for group projects
  // with chat enabled. Planning canvases normally live in that tab's sidebar,
  // so when it's hidden (individual projects, or chat turned off) we surface
  // the canvases in a standalone "Planning" tab instead — otherwise there'd be
  // no way to create a planning doc, which AI Phase Generation reads from.
  const showDiscussions =
    (project.max_team_size ?? 1) > 1 && (project.allow_team_workspace ?? true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const submission = team.submission as any
  const submissionStatus = submission?.status === 'submitted'
    ? 'Submitted'
    : submission?.status === 'draft'
      ? 'Draft'
      : 'Not Started'
  const daysUntilDue = useMemo(() => {
    if (!project.due_date) return null
    const now = new Date()
    return Math.ceil((new Date(project.due_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  }, [project.due_date])

  return (
    <div className="space-y-4">
      {/* Merged project + team header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0">
          {/* Project title (primary) */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {project.title}
            </h1>
            <Badge className={cn('text-[11px] px-2.5 py-0.5 rounded-full',
              project.status === 'active' ? 'bg-muted text-foreground' :
              project.status === 'completed' ? 'bg-success-muted text-success-muted-foreground' :
              'bg-warning-muted text-warning-muted-foreground'
            )}>
              {PROJECT_STATUS_LABELS[project.status as keyof typeof PROJECT_STATUS_LABELS] || project.status}
            </Badge>
          </div>
          {/* Team name (secondary) */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[13px] text-muted-foreground">Team:</span>
            <span className="text-[13px] font-semibold text-foreground">{team.name}</span>
            <Badge className={cn('text-[10px] px-1.5 py-0', statusColor)}>
              {TEAM_STATUS_LABELS[team.status as keyof typeof TEAM_STATUS_LABELS] || team.status}
            </Badge>
          </div>
          {/* Team description — visible to everyone */}
          {team.description && (
            <p className="text-[13px] text-muted-foreground leading-relaxed mt-1.5 max-w-2xl">
              {team.description}
            </p>
          )}
          {/* Inline team metadata */}
          <div className="flex items-center gap-3 mt-1.5 text-sm text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {members.length}/{project.max_team_size || 5} members
            </span>
            {team.created_at && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Created {new Date(team.created_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </span>
              </>
            )}
            {totalPhases > 0 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="flex items-center gap-1.5">
                  <ListChecks className="h-3.5 w-3.5" />
                  {completedPhases}/{totalPhases} phases done
                </span>
              </>
            )}
            <span className="text-muted-foreground/30">·</span>
            <span className="text-xs font-medium text-muted-foreground">Submission:</span>
            {submissionStatus === 'Submitted' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-success-muted text-success-muted-foreground">
                <Send className="h-3 w-3" /> Submitted
              </span>
            ) : submissionStatus === 'Draft' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-warning-muted text-warning-muted-foreground">
                <FileText className="h-3 w-3" /> Draft saved
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-muted-foreground">
                Not started
              </span>
            )}
            {daysUntilDue !== null && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className={cn(
                  'flex items-center gap-1.5 tabular-nums',
                  daysUntilDue <= 0 ? 'text-destructive' : daysUntilDue <= 7 ? 'text-warning-muted-foreground' : '',
                )}>
                  <CalendarDays className="h-3.5 w-3.5" />
                  {daysUntilDue <= 0 ? 'Overdue' : `${daysUntilDue} days left`}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <AssignmentDetailsSheet project={project} />
          {userRole === 'owner' && <TeamEditButton sectionId={sectionId} team={team} />}
        </div>
      </div>

      {/* Tabs — scroll with the page (not sticky). Border-b separates the
        * tab row from the content below. `relative` anchors the mobile
        * scroll-fade indicator. */}
      <Tabs defaultValue="team" className="space-y-4">
        <div className="relative -mx-6 px-6 py-2 border-b border-border/60">
          <TabsList className="w-full overflow-x-auto overflow-y-hidden justify-start">
            <TabsTrigger value="team">Team</TabsTrigger>
            {showDiscussions ? (
              <TabsTrigger value="discussions">Discussions</TabsTrigger>
            ) : (
              <TabsTrigger value="planning">Planning</TabsTrigger>
            )}
            <TabsTrigger value="phases">Phases</TabsTrigger>
            <TabsTrigger value="submission">Submission</TabsTrigger>
            {allTeams.length > 1 && (
              <TabsTrigger value="class-teams">Class Teams</TabsTrigger>
            )}
          </TabsList>
          {/* Mobile scroll fade indicator */}
          <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-background to-transparent pointer-events-none sm:hidden" />
        </div>

        <TabsContent value="team">
          <StudentTeamTab
            sectionId={sectionId}
            project={project}
            teamId={team.id}
            teamDescription={team.description}
            members={members}
            userRole={userRole}
            userId={userId}
          />
        </TabsContent>

        {showDiscussions ? (
          <TabsContent value="discussions" forceMount className="data-[state=inactive]:hidden">
            <StudentDiscussionsTab
              sectionId={sectionId}
              teamId={team.id}
              userId={userId}
            />
          </TabsContent>
        ) : (
          <TabsContent value="planning">
            <div className="max-w-2xl mx-auto">
              <div className="rounded-xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden">
                <ProjectResourcesSection
                  teamId={team.id}
                  sectionId={sectionId}
                  title="Planning Canvases"
                />
              </div>
            </div>
          </TabsContent>
        )}


        <TabsContent value="phases">
          <StudentPhasesTab
            sectionId={sectionId}
            project={project}
            teamId={team.id}
            phases={phases}
            members={members}
            userRole={userRole}
            planningDoc={team.planning_doc || ''}
            masterPhases={masterPhases}
          />
        </TabsContent>


        <TabsContent value="submission">
          <StudentSubmissionTab
            sectionId={sectionId}
            projectId={project.id}
            teamId={team.id}
            members={members}
            userRole={userRole}
            existingSubmission={team.submission || null}
            dueDate={project.due_date}
          />
        </TabsContent>

        {allTeams.length > 1 && (
          <TabsContent value="class-teams">
            <ClassTeamsView
              currentTeamId={team.id}
              allTeams={allTeams}
              maxTeamSize={project.max_team_size || 5}
            />
          </TabsContent>
        )}

      </Tabs>
    </div>
  )
}

// ── Team Edit Button — opens a dialog for owner to rename/describe their team ──

interface TeamEditButtonProps {
  sectionId: string
  team: TeamData
}

function TeamEditButton({ sectionId, team }: TeamEditButtonProps) {
  const [open, setOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const router = useRouter()

  const form = useForm<UpdateTeamInput>({
    resolver: zodResolver(updateTeamSchema) as Resolver<UpdateTeamInput>,
    defaultValues: {
      name: team.name || '',
      description: team.description || '',
    },
  })

  const onSubmit = async (data: UpdateTeamInput) => {
    setIsSubmitting(true)
    try {
      const result = await updateTeam(team.id, sectionId, data)
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Team updated')
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Unable to update team. Try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
        <Pencil className="h-3.5 w-3.5" />
        Edit Team Info
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-xl space-y-4">
            <h3 className="text-base font-semibold">Edit Team Info</h3>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Team Name *</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
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
                      <FormControl><Textarea rows={3} className="resize-none" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end gap-3 pt-1">
                  <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </form>
            </Form>
          </div>
        </div>
      )}
    </>
  )
}

// ── Assignment Details — slide-over sheet (no layout shift) ────

function AssignmentDetailsSheet({ project }: { project: TeamProject }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Info className="h-3.5 w-3.5" />
          Project Brief
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[360px] sm:w-[440px] overflow-y-auto">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-base pr-6">{project.title}</SheetTitle>
        </SheetHeader>

        <div className="px-4 pb-8 space-y-6">
          {/* Meta row */}
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {project.due_date && (
              <div>
                <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-0.5 flex items-center gap-1">
                  <CalendarDays className="h-3 w-3" /> Due Date
                </p>
                <p className="text-sm">
                  {new Date(project.due_date).toLocaleDateString('en-US', {
                    month: 'long', day: 'numeric', year: 'numeric',
                  })}
                </p>
              </div>
            )}
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-0.5 flex items-center gap-1">
                <Globe className="h-3 w-3" /> Visibility
              </p>
              <p className="text-sm">
                {PROJECT_VISIBILITY_LABELS[project.visibility as keyof typeof PROJECT_VISIBILITY_LABELS] || project.visibility}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-0.5">Max Team Size</p>
              <p className="text-sm">{project.max_team_size || 5}</p>
            </div>
          </div>

          {project.description && (
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">Description</p>
              <MarkdownLatex content={project.description} className="text-sm text-foreground/80" />
            </div>
          )}

          {project.guidelines && (
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5 flex items-center gap-1">
                <FileText className="h-3 w-3" /> Guidelines
              </p>
              <MarkdownLatex content={project.guidelines} className="text-sm text-foreground/80" />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── Class Teams View ────────────────────────────────────────────

interface ClassTeamsViewProps {
  currentTeamId: string
  allTeams: ClassTeamInfo[]
  maxTeamSize: number
}

function ClassTeamsView({ currentTeamId, allTeams, maxTeamSize }: ClassTeamsViewProps) {
  const otherTeams = allTeams.filter((t) => t.id !== currentTeamId)

  if (otherTeams.length === 0) {
    return (
      <div className="py-16 flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <Users className="w-6 h-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-semibold text-foreground">
          No other teams yet
        </h3>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-[280px]">
          Your team is the only one so far. Other teams will appear here as classmates create them.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">Class Teams</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {otherTeams.length} other team{otherTeams.length !== 1 ? 's' : ''} in this project
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {otherTeams.map((t) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const teamMembers = (t.project_members || []) as any[]
          const memberCount = t.member_count ?? teamMembers.length ?? 0

          return (
            <div
              key={t.id}
              className="rounded-xl border border-border bg-card p-5 transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm"
            >
              {/* Team header */}
              <div className="flex items-start gap-3.5 mb-4">
                <div className="w-11 h-11 rounded-xl bg-muted/40 border border-border flex items-center justify-center shrink-0">
                  <span className="text-base font-bold text-foreground">{t.name.charAt(0).toUpperCase()}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-[15px] font-semibold text-foreground truncate">{t.name}</h4>
                  <p className="text-[12px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
                    <Users className="h-3 w-3" />
                    {memberCount} of {maxTeamSize} members
                  </p>
                </div>
              </div>

              {/* Member list */}
              {teamMembers.length > 0 && (
                <div className="space-y-2">
                  {teamMembers.map((m, i) => {
                    const profile = m.profile || {}
                    const name = profile.name || 'Member'
                    return (
                      <div key={m.id || i} className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-muted/50 border border-border flex items-center justify-center shrink-0">
                          {profile.avatar_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={profile.avatar_url} alt={name} className="w-full h-full rounded-full object-cover" />
                          ) : (
                            <span className="text-[10px] font-semibold text-foreground">{name.charAt(0).toUpperCase()}</span>
                          )}
                        </div>
                        <span className="text-[13px] text-foreground truncate">{name}</span>
                        {m.role === 'owner' && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 rounded-full font-medium ml-auto shrink-0">
                            Owner
                          </Badge>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Created date */}
              {t.created_at && (
                <p className="text-[11px] text-muted-foreground/60 mt-4 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Created {new Date(t.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
