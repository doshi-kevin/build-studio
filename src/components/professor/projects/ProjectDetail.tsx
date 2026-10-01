/**
 * ProjectDetail — Tabbed detail view for a single project assignment.
 *
 * Organizer-style header: status badges plus a pulse strip (teams, students
 * on teams, discussion volume, days left), then tabbed content for Overview,
 * Phases (drag-and-drop board), and Teams.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PageHeader } from '@/components/professor/PageHeader'
import { ProjectOverviewTab } from './ProjectOverviewTab'
import { ProjectTeamsTab } from './ProjectTeamsTab'
import { ProjectPhasesTab, type BoardPhase, type PhaseCard } from './ProjectPhasesTab'
import { ProjectRubricTab } from './ProjectRubricTab'
import type { RubricItem } from '@/lib/projects/grade'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import {
  useAthenaSurface,
  type FillResult,
} from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import type { AssignmentFillTool, AssignmentScreen } from '@/lib/ai/assignment-assistant/schemas'
import {
  applyProjectOps,
  serializeProjectForAthena,
  type ProjectBoardState,
  type ProposalAction,
} from '@/lib/projects/athena-project-adapter'
import type { ProjectOp } from '@/lib/ai/assignment-assistant/templates/registry'
import { AthenaProjectProposal } from './AthenaProjectProposal'

const statusColors: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-muted text-foreground',
  completed: 'bg-success-muted text-success-muted-foreground border-success/30',
  archived: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
}

const visibilityColors: Record<string, string> = {
  private: 'bg-muted text-muted-foreground',
  course: 'bg-muted text-muted-foreground',
  public: 'bg-success-muted text-success-muted-foreground border-success/30',
}

export interface ProjectPulse {
  teams: number
  studentsOnTeams: number
  enrolled: number
  postsThisWeek: number
}

interface ProjectDetailProps {
  sectionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  project: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  teams: any[]
  pulse: ProjectPulse
  boardPhases: BoardPhase[]
  boardLibrary: PhaseCard[]
  rubricItems: RubricItem[]
  phaseList: { id: string; name: string }[]
  canWrite: boolean
  /** Any score saved against this project — Athena refuses to restructure once true. */
  anyScored: boolean
  gradesReleased: boolean
}

function daysLeft(dueDate: string | null): number | null {
  if (!dueDate) return null
  const diff = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000)
  return isNaN(diff) ? null : diff
}

function PulseStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 text-xl font-bold tabular-nums">
        {value}
        {hint && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{hint}</span>}
      </p>
    </div>
  )
}

export function ProjectDetail({
  sectionId,
  project,
  teams,
  pulse,
  boardPhases,
  boardLibrary,
  rubricItems,
  phaseList,
  canWrite,
  anyScored,
  gradesReleased,
}: ProjectDetailProps) {
  const remaining = daysLeft(project.due_date)
  const router = useRouter()
  const [proposal, setProposal] = useState<{ id: string; actions: ProposalAction[] } | null>(null)
  const proposalRef = useRef(proposal)

  const [tab, setTab] = useState('overview')

  /* Discard is one click and the proposal may represent several turns of work that
     cost real AI calls, so make it recoverable rather than gating it behind a
     confirmation — a dialog here would train the reflex click this card exists to
     prevent. */
  const handleDiscardProposal = useCallback(() => {
    const discarded = proposalRef.current
    setProposal(null)
    if (!discarded) return
    toast('Proposal discarded', {
      action: { label: 'Undo', onClick: () => setProposal(discarded) },
    })
  }, [])

  const board: ProjectBoardState = {
    projectId: project.id,
    title: project.title ?? '',
    description: project.description ?? '',
    guidelines: project.guidelines ?? '',
    dueDate: project.due_date ?? null,
    phases: boardPhases.map((ph) => ({
      id: ph.id,
      name: ph.name,
      startDate: ph.startDate,
      endDate: ph.endDate,
      items: rubricItems
        .filter((it) => it.phaseId === ph.id)
        .map((it) => ({
          id: it.id,
          itemType: it.itemType as 'assignment' | 'quiz' | 'manual' | 'attendance',
          title: it.title,
          weight: Number(it.weight) || 0,
          grain: it.grain as 'team' | 'individual',
          scoringMode: it.scoringMode as 'numeric' | 'levels',
        })),
    })),
    anyScored,
    gradesReleased,
  }

  /* The dock calls getScreen/onFill through stable wrappers, so they must read the
     LATEST board without being effect deps — otherwise every board change would
     re-register the surface. Assigned in an effect (not during render) for the same
     reason AssignmentAthenaDock assigns its own callback ref that way. */
  const boardRef = useRef<ProjectBoardState>(board)
  useEffect(() => {
    boardRef.current = board
    proposalRef.current = proposal
  })

  const getScreen = useCallback(
    (): AssignmentScreen => ({ authoring: serializeProjectForAthena(boardRef.current) }),
    [],
  )

  /* Athena does NOT write the board. apply_edits becomes a staged proposal the
     professor reads and applies; `applied: false` tells the model plainly when a
     batch was entirely refused, so it does not claim it changed something. */
  const onFill = useCallback((tool: AssignmentFillTool, payload: unknown): FillResult => {
    if (tool !== 'apply_edits') {
      return { summary: 'That tool does not apply to a project.', applied: false }
    }
    const ops = (payload as { ops?: ProjectOp[] } | null)?.ops
    if (!Array.isArray(ops) || ops.length === 0) {
      return { summary: 'Nothing to propose.', applied: false }
    }
    /* Athena routinely proposes the timeline in one turn and the rubric rows in the
       next. Those phases are staged, not saved, so without handing the still-pending
       proposal back in, every follow-up row referenced a phase that exists nowhere and
       was dropped. Merge instead: keep the earlier actions and append this turn's. */
    const prev = proposalRef.current
    const res = applyProjectOps(boardRef.current, ops, prev ? { actions: prev.actions } : undefined)
    if (res.changed === 0) return { summary: res.summary, applied: false }
    const merged = prev ? [...prev.actions, ...res.proposal.actions] : res.proposal.actions
    const id = prev?.id ?? crypto.randomUUID()
    setProposal({ id, actions: merged })
    return {
      summary: res.summary,
      applied: true,
      // Undo removes only what THIS turn added, so an earlier reviewed proposal survives.
      undo: () => setProposal(prev),
    }
  }, [])

  useAthenaSurface({
    active: canWrite,
    surface: 'authoring',
    kind: 'project',
    // The project id rides the assignmentId slot, the same overload the Quiz
    // Studio uses; the server re-binds it to the verified section.
    assignmentId: project.id,
    getScreen,
    onFill,
  })

  return (
    <div className="space-y-6 pb-24 md:pb-0">
      {/* Back link */}
      <Link
        href={`/professor/courses/${sectionId}/projects`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Projects
      </Link>

      {/* Header */}
      <PageHeader
        title={project.title}
        description={project.description || undefined}
        actions={
          <>
            <Badge
              variant="secondary"
              className={cn('capitalize', statusColors[project.status] || '')}
            >
              {project.status}
            </Badge>
            <Badge
              variant="secondary"
              className={cn('capitalize', visibilityColors[project.visibility] || '')}
            >
              {project.visibility}
            </Badge>
          </>
        }
      />

      {/* Organizer pulse strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PulseStat label="Teams" value={String(pulse.teams)} />
        <PulseStat
          label="Students on teams"
          value={String(pulse.studentsOnTeams)}
          hint={pulse.enrolled > 0 ? `of ${pulse.enrolled} enrolled` : undefined}
        />
        <PulseStat label="Posts this week" value={String(pulse.postsThisWeek)} />
        <PulseStat
          label="Time left"
          value={remaining == null ? '–' : remaining >= 0 ? String(remaining) : '0'}
          hint={
            remaining == null
              ? 'no due date'
              : remaining >= 0
                ? remaining === 1
                  ? 'day to due date'
                  : 'days to due date'
                : 'past due'
          }
        />
      </div>

      {proposal && (
        <AthenaProjectProposal
          sectionId={sectionId}
          projectId={project.id}
          proposalId={proposal.id}
          actions={proposal.actions}
          existingPhases={boardPhases.map((ph) => ({ id: ph.id, name: ph.name }))}
          existingRows={rubricItems.map((it) => ({
            id: it.id,
            title: it.title,
            weight: Number(it.weight) || 0,
            phaseId: it.phaseId,
          }))}
          onDiscard={handleDiscardProposal}
          onApplied={() => {
            setProposal(null)
            // Land on the board that just changed. Applying from the Overview tab
            // otherwise ends on an unchanged screen plus a toast, which is a poor
            // payoff for the one moment the whole flow builds to.
            setTab('phases')
            router.refresh()
          }}
        />
      )}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="phases">Phases ({boardPhases.length})</TabsTrigger>
          <TabsTrigger value="teams">Teams ({teams.length})</TabsTrigger>
          <TabsTrigger value="rubrics">Rubric ({rubricItems.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <ProjectOverviewTab sectionId={sectionId} project={project} />
        </TabsContent>

        <TabsContent value="phases" className="mt-6">
          <ProjectPhasesTab
            sectionId={sectionId}
            projectId={project.id}
            initialPhases={boardPhases}
            initialLibrary={boardLibrary}
            canWrite={canWrite}
          />
        </TabsContent>

        <TabsContent value="teams" className="mt-6">
          <ProjectTeamsTab
            sectionId={sectionId}
            project={project}
            teams={teams}
          />
        </TabsContent>

        <TabsContent value="rubrics" className="mt-6">
          <ProjectRubricTab
            sectionId={sectionId}
            projectId={project.id}
            items={rubricItems}
            phases={phaseList}
            canWrite={canWrite}
          />
        </TabsContent>
      </Tabs>

      {/* The dock's trigger. Only for roles that can actually apply a proposal —
          a grader would be offered a bar whose every result they cannot land. */}
      {canWrite && <AthenaAskLine />}
    </div>
  )
}
