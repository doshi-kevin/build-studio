// Professor gradebook hub with tabs: Gradebook, Projects, Class Analytics, At-Risk Students.
// Gradebook tab shows the spreadsheet-style student x quiz table with clickable headers.
// At-Risk tab surfaces students flagged for poor performance or missing quizzes.
'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Search, ClipboardCheck, ArrowUp, ArrowDown, Pencil,
  FolderKanban, BarChart3, ExternalLink, AlertTriangle, FileText, Star, MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SetGradeDialog } from './SetGradeDialog'
import { ClassAnalyticsDashboard } from '@/components/professor/analytics/ClassAnalyticsDashboard'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import type {
  GradebookData,
  GradebookStudent,
  QuizScore,
  ClassAnalytics,
  ProjectGradebookEntry,
  AssignmentGradebookData,
  AssignmentCell,
} from '@/app/(dashboard)/professor/courses/[sectionId]/grades/actions'

const GRADE_COLORS: Record<string, string> = {
  'A+': 'text-success-muted-foreground',
  A: 'text-success-muted-foreground',
  'A-': 'text-success-muted-foreground',
  'B+': 'text-success-muted-foreground',
  B: 'text-success-muted-foreground',
  'B-': 'text-success-muted-foreground',
  'C+': 'text-warning-muted-foreground',
  C: 'text-warning-muted-foreground',
  'C-': 'text-warning-muted-foreground',
  'D+': 'text-destructive',
  D: 'text-destructive',
  'D-': 'text-destructive',
  F: 'text-destructive',
}

function scoreColorClass(score: number | null): string {
  if (score == null) return 'text-muted-foreground'
  if (score >= 80) return 'text-success-muted-foreground'
  if (score >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive'
}

function scoreBgClass(score: number | null): string {
  if (score == null) return 'bg-muted/40'
  if (score >= 80) return 'bg-success-muted/60'
  if (score >= 60) return 'bg-warning-muted/60'
  return 'bg-destructive-muted/60'
}

type SortField = 'name' | 'average' | `quiz:${string}`
type SortDir = 'asc' | 'desc'
type FilterMode = 'all' | 'submitted_all' | 'missing'

interface GradebookTableProps {
  data: GradebookData
  sectionId: string
  analytics?: ClassAnalytics | null
  projectGrades?: ProjectGradebookEntry[]
  assignmentGrades?: AssignmentGradebookData | null
  /** Which tab to open on — e.g. the dashboard's grading to-do links straight into Assignments. */
  initialTab?: 'gradebook' | 'assignments' | 'projects' | 'analytics' | 'atrisk'
  /**
   * Products the INSTITUTION has not bought. Grades itself is never entitled,
   * but three of its tabs are views of products that are, and an empty state
   * saying "publish quizzes to see scores here" is nonsense at a school with no
   * quizzes. Analytics and At-Risk are Lenses and always stay.
   */
  unentitledFeatures?: string[]
}

export function GradebookTable({
  data,
  sectionId,
  analytics,
  projectGrades = [],
  assignmentGrades = null,
  initialTab = 'gradebook',
  unentitledFeatures = [],
}: GradebookTableProps) {
  const { students, quizzes, scores, classStats } = data

  const hasQuizzes = !unentitledFeatures.includes('quizzes')
  const hasAssignments = !unentitledFeatures.includes('assignments')
  const hasProjects = !unentitledFeatures.includes('projects')
  /* The default tab may be one the school does not have, either from the
     `initialTab` prop or from our own default. Fall through to the first tab
     that exists rather than opening on a tab with no trigger. */
  const firstAvailable = hasQuizzes
    ? 'gradebook'
    : hasAssignments
      ? 'assignments'
      : hasProjects
        ? 'projects'
        : 'analytics'
  const entitledTab =
    (initialTab === 'gradebook' && !hasQuizzes) ||
    (initialTab === 'assignments' && !hasAssignments) ||
    (initialTab === 'projects' && !hasProjects)
      ? firstAvailable
      : initialTab

  const [search, setSearch] = useState('')
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filter, setFilter] = useState<FilterMode>('all')
  const [gradeDialog, setGradeDialog] = useState<{
    open: boolean
    student: GradebookStudent | null
  }>({ open: false, student: null })

  // Compute student averages
  const studentAverages = useMemo(() => {
    const avgs: Record<string, number | null> = {}
    for (const s of students) {
      const studentScores = quizzes
        .map((q) => scores[s.id]?.[q.id]?.score)
        .filter((v): v is number => v != null)
      avgs[s.id] =
        studentScores.length > 0
          ? parseFloat((studentScores.reduce((a, b) => a + b, 0) / studentScores.length).toFixed(1))
          : null
    }
    return avgs
  }, [students, quizzes, scores])

  // Compute per-quiz class averages
  const quizAverages = useMemo(() => {
    const avgs: Record<string, number | null> = {}
    for (const q of quizzes) {
      const qScores = students
        .map((s) => scores[s.id]?.[q.id]?.score)
        .filter((v): v is number => v != null)
      avgs[q.id] =
        qScores.length > 0
          ? parseFloat((qScores.reduce((a, b) => a + b, 0) / qScores.length).toFixed(1))
          : null
    }
    return avgs
  }, [students, quizzes, scores])

  // Filter + sort students
  const filteredStudents = useMemo(() => {
    let list = [...students]

    if (search) {
      const q = search.toLowerCase()
      list = list.filter(
        (s) => s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q)
      )
    }

    if (filter === 'submitted_all') {
      list = list.filter((s) =>
        quizzes.every((q) => scores[s.id]?.[q.id]?.score != null)
      )
    } else if (filter === 'missing') {
      list = list.filter((s) =>
        quizzes.some((q) => !scores[s.id]?.[q.id])
      )
    }

    list.sort((a, b) => {
      let cmp = 0
      if (sortField === 'name') {
        cmp = a.name.localeCompare(b.name)
      } else if (sortField === 'average') {
        const aAvg = studentAverages[a.id] ?? -1
        const bAvg = studentAverages[b.id] ?? -1
        cmp = aAvg - bAvg
      } else if (sortField.startsWith('quiz:')) {
        const quizId = sortField.slice(5)
        const aScore = scores[a.id]?.[quizId]?.score ?? -1
        const bScore = scores[b.id]?.[quizId]?.score ?? -1
        cmp = aScore - bScore
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return list
  }, [students, search, filter, sortField, sortDir, quizzes, scores, studentAverages])

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  function renderSortIcon(field: SortField) {
    if (sortField !== field) return null
    return sortDir === 'asc' ? (
      <ArrowUp className="h-3 w-3 inline ml-0.5" />
    ) : (
      <ArrowDown className="h-3 w-3 inline ml-0.5" />
    )
  }

  function getScoreDisplay(studentScore: QuizScore | undefined) {
    if (!studentScore || studentScore.score == null) {
      return <span className="text-xs text-muted-foreground">—</span>
    }
    return (
      <span className={cn('text-sm font-medium tabular-nums', scoreColorClass(studentScore.score))}>
        {studentScore.score}%
      </span>
    )
  }

  // Assignment cell: show the score once graded, otherwise the submission state so a
  // blank isn't mistaken for "unsubmitted" vs "submitted, pending grade".
  function getAssignmentCellDisplay(cell: AssignmentCell | undefined, points: number | null) {
    if (!cell || cell.status === 'not_started') {
      // Lighter than a graded cell so a true blank reads as emptier (vs graded-null).
      return <span className="text-xs text-muted-foreground/40">—</span>
    }
    if (cell.status === 'graded') {
      if (cell.score == null) return <span className="text-xs text-muted-foreground">—</span>
      // Colour by percentage when the assignment has points; stay neutral otherwise
      // (a raw score isn't a percentage, so scoreColorClass would mis-read it).
      const colorClass = points ? scoreColorClass((cell.score / points) * 100) : 'text-foreground'
      return (
        <span className={cn('text-sm font-medium tabular-nums', colorClass)}>
          {cell.score}
          <span className="text-muted-foreground">/{points ?? '—'}</span>
        </span>
      )
    }
    if (cell.status === 'returned') {
      return <span className="text-[10px] font-medium text-warning-muted-foreground">Changes req.</span>
    }
    // submitted — pending grade
    return <span className="text-[10px] text-muted-foreground">Submitted</span>
  }

  return (
    <TooltipProvider>
    <div className="space-y-6">
      {/* Category Tabs */}
      <Tabs defaultValue={entitledTab}>
        {/* Scroll the tab row on narrow screens instead of clipping a tab / scrolling the page. */}
        <div className="overflow-x-auto">
        <TabsList>
          {hasQuizzes && (
            <TabsTrigger value="gradebook" className="gap-1.5">
              <ClipboardCheck className="h-3.5 w-3.5" />
              Gradebook
              {quizzes.length > 0 && (
                <span className="ml-1 text-[10px] font-mono opacity-60">{quizzes.length}</span>
              )}
            </TabsTrigger>
          )}
          {hasAssignments && (
            <TabsTrigger value="assignments" className="gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Assignments
              {assignmentGrades && assignmentGrades.assignments.length > 0 && (
                <span className="ml-1 text-[10px] font-mono opacity-60">{assignmentGrades.assignments.length}</span>
              )}
            </TabsTrigger>
          )}
          {hasProjects && (
            <TabsTrigger value="projects" className="gap-1.5">
              <FolderKanban className="h-3.5 w-3.5" />
              Projects
              {projectGrades.length > 0 && (
                <span className="ml-1 text-[10px] font-mono opacity-60">{projectGrades.length}</span>
              )}
            </TabsTrigger>
          )}
          <TabsTrigger value="analytics" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />
            Class Analytics
          </TabsTrigger>
          <TabsTrigger value="atrisk" className="gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            At-Risk
            {analytics?.atRiskStudents && analytics.atRiskStudents.length > 0 && (
              <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0 h-4">
                {analytics.atRiskStudents.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        </div>

        {/* ── Quizzes Gradebook Tab ─────────────────────────────── */}
        <TabsContent value="gradebook" className="space-y-4 mt-4">
          {quizzes.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-12 text-center">
              <ClipboardCheck className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No published quizzes</p>
              <p className="text-xs text-muted-foreground mt-1">
                Publish quizzes to see student scores here.
              </p>
            </div>
          ) : (
            <>
              {/* Search + filter bar */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search students..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Select value={filter} onValueChange={(v) => setFilter(v as FilterMode)}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Students</SelectItem>
                    <SelectItem value="submitted_all">Submitted All</SelectItem>
                    <SelectItem value="missing">Missing Quizzes</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Quiz gradebook table */}
              <div className="border border-border rounded-xl overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead
                        className="sticky left-0 bg-background z-10 min-w-[180px] cursor-pointer select-none"
                        onClick={() => toggleSort('name')}
                      >
                        Student {renderSortIcon('name')}
                      </TableHead>
                      {quizzes.map((q, qi) => (
                        <TableHead
                          key={q.id}
                          className="text-center min-w-[80px] cursor-pointer select-none"
                          onClick={() => toggleSort(`quiz:${q.id}`)}
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Link
                                href={`/professor/courses/${sectionId}/quizzes/${q.id}/insights`}
                                className="text-xs font-medium hover:underline underline-offset-2"
                                onClick={(e) => e.stopPropagation()}
                              >
                                Q{qi + 1}
                              </Link>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[250px]">
                              <p className="font-medium">{q.title}</p>
                              <p className="text-[10px] opacity-70 mt-0.5">Click to view quiz analytics</p>
                              {q.dueDate && (
                                <p className="text-[10px] opacity-70 mt-0.5">
                                  Due: {new Date(q.dueDate).toLocaleDateString()}
                                </p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                          {renderSortIcon(`quiz:${q.id}`)}
                        </TableHead>
                      ))}
                      <TableHead
                        className="text-center min-w-[90px] cursor-pointer select-none"
                        onClick={() => toggleSort('average')}
                      >
                        Average {renderSortIcon('average')}
                      </TableHead>
                      <TableHead className="text-center min-w-[120px]">Final Grade</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredStudents.map((student) => (
                      <TableRow key={student.id}>
                        <TableCell className="sticky left-0 bg-background z-10">
                          <Link
                            href={`/professor/courses/${sectionId}/grades/student/${student.id}`}
                            className="block group"
                          >
                            <p className="text-sm font-medium group-hover:underline flex items-center gap-1">
                              {student.name}
                              <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                            </p>
                            <p className="text-xs text-muted-foreground">{student.email}</p>
                          </Link>
                        </TableCell>
                        {quizzes.map((q) => {
                          const entry = scores[student.id]?.[q.id]
                          return (
                            <TableCell
                              key={q.id}
                              className={cn('text-center', scoreBgClass(entry?.score ?? null))}
                            >
                              {getScoreDisplay(entry)}
                            </TableCell>
                          )
                        })}
                        <TableCell className="text-center">
                          <span
                            className={cn(
                              'text-sm font-semibold tabular-nums',
                              scoreColorClass(studentAverages[student.id])
                            )}
                          >
                            {studentAverages[student.id] != null
                              ? `${studentAverages[student.id]}%`
                              : '—'}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                className="inline-flex items-center gap-1.5 hover:bg-muted px-2 py-1 rounded transition-colors cursor-pointer group"
                                onClick={() => setGradeDialog({ open: true, student })}
                              >
                                {student.finalGrade ? (
                                  <span
                                    className={cn(
                                      'text-sm font-bold',
                                      GRADE_COLORS[student.finalGrade] || 'text-muted-foreground'
                                    )}
                                  >
                                    {student.finalGrade}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                                {student.finalScore != null && (
                                  <span className="text-xs text-muted-foreground ml-0.5">
                                    {student.finalScore}%
                                  </span>
                                )}
                                <Pencil className="h-3 w-3 text-muted-foreground/60 group-hover:text-foreground transition-colors" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              <p className="text-xs">Click to edit grade</p>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                    {/* Class average row */}
                    {filteredStudents.length > 0 && (
                      <TableRow className="bg-muted/30 font-medium">
                        <TableCell className="sticky left-0 bg-muted/30 z-10 text-sm">
                          Class Average
                        </TableCell>
                        {quizzes.map((q) => (
                          <TableCell key={q.id} className="text-center">
                            <span className={cn('text-sm tabular-nums', scoreColorClass(quizAverages[q.id]))}>
                              {quizAverages[q.id] != null ? `${quizAverages[q.id]}%` : '—'}
                            </span>
                          </TableCell>
                        ))}
                        <TableCell className="text-center">
                          <span className={cn('text-sm', scoreColorClass(classStats.classAverage))}>
                            {classStats.classAverage != null ? `${classStats.classAverage}%` : '—'}
                          </span>
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                {filteredStudents.length === 0 && (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    No students match your search or filter.
                  </div>
                )}
              </div>
            </>
          )}
        </TabsContent>

        {/* ── Assignments Tab ──────────────────────────────────── */}
        <TabsContent value="assignments" className="space-y-4 mt-4">
          {!assignmentGrades || assignmentGrades.assignments.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-12 text-center">
              <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No graded assignments</p>
              <p className="text-xs text-muted-foreground mt-1">
                Publish a graded assignment to see student scores here.
              </p>
            </div>
          ) : (
            <div className="border border-border rounded-xl overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background z-10 min-w-[180px]">Student</TableHead>
                    {assignmentGrades.assignments.map((a, ai) => (
                      <TableHead key={a.assignmentId} className="text-center min-w-[90px]">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link
                              href={`/professor/courses/${sectionId}/assignments/${a.assignmentId}`}
                              className="text-xs font-medium hover:underline underline-offset-2"
                            >
                              A{ai + 1}
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[250px]">
                            <p className="font-medium">{a.title}</p>
                            <p className="text-[10px] opacity-70 mt-0.5">{a.points ?? '—'} pts</p>
                            {!a.released && (
                              <p className="text-[10px] opacity-70 mt-0.5">Grades not published to students yet</p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignmentGrades.students.map((student) => (
                    <TableRow key={student.id}>
                      <TableCell className="sticky left-0 bg-background z-10">
                        <Link
                          href={`/professor/courses/${sectionId}/grades/student/${student.id}`}
                          className="block group"
                        >
                          <p className="text-sm font-medium group-hover:underline flex items-center gap-1">
                            {student.name}
                            <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </p>
                          <p className="text-xs text-muted-foreground">{student.email}</p>
                        </Link>
                      </TableCell>
                      {assignmentGrades.assignments.map((a) => (
                        <TableCell key={a.assignmentId} className="text-center">
                          {getAssignmentCellDisplay(assignmentGrades.scores[student.id]?.[a.assignmentId], a.points)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ── Projects Tab ─────────────────────────────────────── */}
        <TabsContent value="projects" className="space-y-4 mt-4">
          {projectGrades.length === 0 ? (
            <div className="rounded-xl border border-border bg-card py-12 text-center">
              <FolderKanban className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No projects yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Create a project and grade its teams to see scores here.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {projectGrades.map((proj) => {
                const gradedCount = proj.teams.filter((t) => t.score != null).length
                return (
                  <div key={proj.projectId} className="rounded-2xl border border-border bg-card p-5">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <h3 className="text-sm font-medium">{proj.projectTitle}</h3>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {gradedCount}/{proj.teams.length} teams graded
                      </span>
                    </div>
                    {proj.teams.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No teams have formed yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {proj.teams.map((team) => (
                          <div
                            key={team.teamId}
                            className="flex items-start justify-between gap-4 rounded-xl border border-border bg-muted/20 px-4 py-3"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{team.teamName}</p>
                              {team.feedback && (
                                <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground line-clamp-2">
                                  <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                  {team.feedback}
                                </p>
                              )}
                            </div>
                            {team.score != null ? (
                              <div className="flex items-baseline gap-1 shrink-0">
                                <Star className="h-3.5 w-3.5 self-center text-muted-foreground" />
                                <span className={cn('text-lg font-semibold tabular-nums', scoreColorClass(team.score))}>
                                  {team.score}
                                </span>
                                <span className="text-xs text-muted-foreground">/100</span>
                              </div>
                            ) : (
                              <Badge variant="secondary" className="text-[10px] shrink-0">Not graded</Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Class Analytics Tab ──────────────────────────────── */}
        <TabsContent value="analytics" className="mt-4">
          {analytics ? (
            <ClassAnalyticsDashboard analytics={analytics} sectionId={sectionId} />
          ) : (
            /* `analytics` is null only when the action failed. The old copy said
               "publish quizzes and wait for submissions", which is advice for an
               empty course and useless for a broken read — the professor changes
               nothing and the page stays broken. The empty-course cases live
               inside the dashboard, each with their own state. */
            <EmptyState
              variant="teaching"
              icon={BarChart3}
              title="Couldn't load class analytics"
              description="The numbers didn't come back. This is usually temporary, so reload the page in a moment."
            />
          )}
        </TabsContent>

        {/* ── At-Risk Students Tab ───────────────────────────── */}
        <TabsContent value="atrisk" className="mt-4">
          {analytics?.atRiskStudents && analytics.atRiskStudents.length > 0 ? (
            <div className="space-y-3">
              {/* Describes the rule the engine actually applies. The old
                  sentence named the quiz-only rule that slice 3 deleted, and on
                  an assignments-heavy section the list underneath it flatly
                  contradicted it. */}
              <p className="text-sm text-muted-foreground">
                Ranked by concern, from graded work, missing submissions and skill mastery.
                Scores are compared to each item&rsquo;s own class result, so a hard
                quiz counts against the quiz rather than the student.
              </p>
              {analytics.atRiskStudents.map((student) => (
                <Link
                  key={student.studentId}
                  href={`/professor/courses/${sectionId}/grades/student/${student.studentId}`}
                  className="block"
                >
                  <div className="flex items-center gap-4 p-5 rounded-2xl border border-border bg-card hover:-translate-y-0.5 hover:shadow-md transition duration-200 ease-out cursor-pointer">
                    <div className="w-10 h-10 rounded-full border-[1.5px] border-destructive bg-destructive/5 flex items-center justify-center text-sm font-semibold text-destructive shrink-0">
                      {student.studentName.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{student.studentName}</p>
                      <p className="text-xs text-muted-foreground truncate">{student.studentEmail}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {student.averagePct != null && (
                        <div className="text-right">
                          <p className={cn(
                            'text-sm font-semibold tabular-nums',
                            student.averagePct >= 70 ? 'text-success-muted-foreground'
                              : student.averagePct >= 50 ? 'text-warning-muted-foreground'
                                : 'text-destructive',
                          )}>
                            {student.averagePct}%
                          </p>
                          <p className="text-[10px] text-muted-foreground">avg score</p>
                        </div>
                      )}
                      {student.belowCount > 0 && (
                        <Badge variant="secondary" className="text-[10px] bg-destructive-muted text-destructive-muted-foreground">
                          {student.belowCount} below threshold
                        </Badge>
                      )}
                      {student.missingCount > 0 && (
                        <Badge variant="secondary" className="text-[10px] bg-warning-muted text-warning-muted-foreground">
                          {student.missingCount} missing
                        </Badge>
                      )}
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : analytics?.riskHasEnoughSignal ? (
            <div className="rounded-xl border border-border bg-card py-12 text-center">
              <AlertTriangle className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No students flagged</p>
              <p className="text-xs text-muted-foreground mt-1">
                Based on graded work, missing submissions and skill mastery so far.
              </p>
            </div>
          ) : (
            /* Not the same sentence. An empty list with nothing to judge on used
               to read "All students are performing within acceptable thresholds",
               which asserts safety from zero evidence — a course in week one, or
               one that runs only assignments, got that screen. */
            <div className="rounded-xl border border-border bg-card py-12 text-center">
              <AlertTriangle className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">Not enough signal yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Flagging needs at least two closed items: graded, or past due by three days.
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Set grade dialog */}
      {gradeDialog.student && (
        <SetGradeDialog
          open={gradeDialog.open}
          onOpenChange={(open) => setGradeDialog((prev) => ({ ...prev, open }))}
          sectionId={sectionId}
          studentId={gradeDialog.student.id}
          studentName={gradeDialog.student.name}
          currentGrade={gradeDialog.student.finalGrade}
          currentScore={gradeDialog.student.finalScore}
        />
      )}
    </div>
    </TooltipProvider>
  )
}
