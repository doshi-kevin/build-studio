/**
 * ProjectTeamsTab — List of student teams under a project assignment.
 *
 * Shows team cards with name, status, member count, phase progress, and grade.
 * Each card opens the team's full workspace page (discussions, phases,
 * members); grading happens via a full submission review panel with
 * side-by-side grading form.
 *
 * Type: Client Component
 */
'use client'

import Link from 'next/link'
import {
  UsersRound,
  Users,
  Eye,
  CheckCircle2,
  Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { TEAM_STATUS_LABELS } from '@/lib/validations/project'

const teamStatusColors: Record<string, string> = {
  active: 'bg-muted text-foreground',
  completed: 'bg-success-muted text-success-muted-foreground',
  archived: 'bg-warning-muted text-warning-muted-foreground',
}

interface SubmissionDocument {
  name: string
  url: string
  size: number
  uploaded_at: string
}

interface SubmissionData {
  title?: string
  tagline?: string
  description?: string
  inspiration?: string
  what_it_does?: string
  how_we_built_it?: string
  challenges?: string
  accomplishments?: string
  what_we_learned?: string
  whats_next?: string
  built_with?: string[]
  github_url?: string
  video_url?: string
  additional_links?: { label: string; url: string }[]
  documents?: SubmissionDocument[]
  status?: 'draft' | 'submitted'
  submitted_at?: string
}

interface TeamMemberProfile {
  name?: string
  avatar_url?: string
}

interface TeamMember {
  id: string
  user_id: string
  role: string
  profile?: TeamMemberProfile
}

interface ProjectTeam {
  id: string
  name: string
  status: string
  description?: string
  member_count?: number
  project_members?: TeamMember[]
  phase_count?: number
  completed_phases?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  submission?: SubmissionData | any
  members?: unknown[]
  phases?: unknown[]
  project_phases?: unknown[]
}

interface ProjectConfig {
  id: string
  max_team_size?: number
}

interface ProjectTeamsTabProps {
  sectionId: string
  project: ProjectConfig
  teams: ProjectTeam[]
}

export function ProjectTeamsTab({ sectionId, project, teams }: ProjectTeamsTabProps) {
  // Aggregate submission stats
  const submittedCount = teams.filter((t) => (t.submission as SubmissionData)?.status === 'submitted').length
  const draftCount = teams.filter((t) => {
    const s = t.submission as SubmissionData | null
    return s && s.status === 'draft'
  }).length
  const notStartedCount = teams.length - submittedCount - draftCount

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Student Teams</h2>
          <p className="text-sm text-muted-foreground">
            {teams.length} team{teams.length !== 1 ? 's' : ''} formed
          </p>
        </div>
      </div>

      {/* Submission progress summary */}
      {teams.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-3xl font-semibold tabular-nums text-success-muted-foreground">
              {submittedCount}
            </p>
            <p className="text-xs font-medium text-muted-foreground mt-1">
              Submitted
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-3xl font-semibold tabular-nums text-warning-muted-foreground">
              {draftCount}
            </p>
            <p className="text-xs font-medium text-muted-foreground mt-1">
              Draft
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-3xl font-semibold tabular-nums text-muted-foreground">
              {notStartedCount}
            </p>
            <p className="text-xs font-medium text-muted-foreground mt-1">
              Not Started
            </p>
          </div>
        </div>
      )}

      {teams.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No teams yet"
          description="Students have not formed any teams for this project yet."
        />
      ) : (
        <AnimatedList className="grid gap-3">
          {teams.map((team) => {
            const statusColor = teamStatusColors[team.status] || teamStatusColors.active
            const memberCount = team.member_count ?? team.project_members?.length ?? 0
            const phaseCount = team.phase_count ?? 0
            const completedPhases = team.completed_phases ?? 0
            const submission = team.submission as SubmissionData | null
            const hasSubmission = submission?.status === 'submitted'

            return (
              <AnimatedItem key={team.id}>
                <div className="bg-card border border-border rounded-xl p-4 hover:border-ring/40 hover:shadow-sm transition duration-200 ease-out">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-sm">{team.name}</h3>
                        <Badge className={cn('text-[10px] px-1.5 py-0', statusColor)}>
                          {TEAM_STATUS_LABELS[team.status as keyof typeof TEAM_STATUS_LABELS] || team.status}
                        </Badge>
                        {hasSubmission ? (
                          <Badge className="text-[10px] px-1.5 py-0 bg-success-muted text-success-muted-foreground">
                            <Send className="h-2.5 w-2.5 mr-0.5" />
                            Submitted
                          </Badge>
                        ) : submission?.status === 'draft' ? (
                          <Badge className="text-[10px] px-1.5 py-0 bg-warning-muted text-warning-muted-foreground">
                            Draft
                          </Badge>
                        ) : (
                          <Badge className="text-[10px] px-1.5 py-0 bg-muted text-muted-foreground">
                            Not Started
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
                        <span className="flex items-center gap-1 tabular-nums">
                          <Users className="h-3 w-3" />
                          {memberCount}/{project.max_team_size || 5} members
                        </span>
                        {phaseCount > 0 && (
                          <span className="flex items-center gap-1 tabular-nums">
                            <CheckCircle2 className="h-3 w-3" />
                            {completedPhases}/{phaseCount} phases
                          </span>
                        )}
                      </div>

                      {team.description && (
                        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
                          {team.description}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs gap-1"
                      >
                        <Link href={`/professor/courses/${sectionId}/projects/${project.id}/teams/${team.id}`}>
                          <Eye className="h-3.5 w-3.5" />
                          Open
                        </Link>
                      </Button>
                    </div>
                  </div>
                </div>
              </AnimatedItem>
            )
          })}
        </AnimatedList>
      )}
    </div>
  )
}
