// Student grade categories view — shows grades organized by category
// (Quizzes, Assignments, Projects) with tabs. All three show real data;
// assignment scores are only present once the professor has published them
// (the server action strips unpublished scores before they reach the client).
'use client'

import { ClipboardCheck, FolderKanban, FileText, Star, MessageSquare } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import { StudentQuizScoresTable } from './StudentQuizScoresTable'
import { StudentSkillInsights } from './StudentSkillInsights'
import type { StudentQuizScore, StudentProjectGrade, StudentAssignmentGrade } from '@/app/(dashboard)/student/courses/[sectionId]/grades/actions'
import type { StudentSkillPerformance } from '@/app/(dashboard)/student/courses/[sectionId]/grades/actions'

interface StudentGradeCategoriesProps {
  quizScores: StudentQuizScore[]
  sectionId: string
  topicData?: StudentSkillPerformance | null
  projectGrades?: StudentProjectGrade[]
  assignmentGrades?: StudentAssignmentGrade[]
  /**
   * Products the institution no longer has. Their tabs come off, and inside a
   * tab that remains, unattempted work for a revoked product stops counting as
   * outstanding — a student cannot sit a quiz their school no longer has, so
   * listing it as due is an obligation they cannot discharge.
   */
  unentitledFeatures?: string[]
}

export function StudentGradeCategories({ quizScores, sectionId, topicData, projectGrades = [], assignmentGrades = [], unentitledFeatures = [] }: StudentGradeCategoriesProps) {
  const hasQuizzes = !unentitledFeatures.includes('quizzes')
  const hasAssignments = !unentitledFeatures.includes('assignments')
  const hasProjects = !unentitledFeatures.includes('projects')

  /* When quizzes are gone, keep what the student ACTUALLY did and drop what
     they now never can. This is the §4.5 line in practice: history survives,
     pending obligations do not. */
  const visibleQuizScores = hasQuizzes ? quizScores : quizScores.filter((s) => s.score != null)

  const attemptedQuizzes = visibleQuizScores.filter((s) => s.score != null)
  const releasedAssignments = assignmentGrades.filter((a) => a.score != null)

  const firstTab =
    hasQuizzes || visibleQuizScores.length > 0
      ? 'quizzes'
      : hasAssignments
        ? 'assignments'
        : 'projects'

  /* A revoked product keeps its tab only while the student has history in it,
     so past scores stay reachable (§4.5) without the tab lingering empty. */
  const showQuizzes = hasQuizzes || visibleQuizScores.length > 0
  const showProjects = hasProjects || projectGrades.length > 0

  return (
    <Tabs defaultValue={firstTab}>
      {/* Scroll the tab row on narrow screens instead of clipping a tab. */}
      <div className="overflow-x-auto">
      <TabsList>
        {showQuizzes && (
          <TabsTrigger value="quizzes" className="gap-1.5">
            <ClipboardCheck className="h-3.5 w-3.5" />
            Quizzes
            {visibleQuizScores.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
                {attemptedQuizzes.length}/{visibleQuizScores.length}
              </Badge>
            )}
          </TabsTrigger>
        )}
        {hasAssignments && (
          <TabsTrigger value="assignments" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Assignments
            {releasedAssignments.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
                {releasedAssignments.length}
              </Badge>
            )}
          </TabsTrigger>
        )}
        {showProjects && (
          <TabsTrigger value="projects" className="gap-1.5">
            <FolderKanban className="h-3.5 w-3.5" />
            Projects
            {projectGrades.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
                {projectGrades.length}
              </Badge>
            )}
          </TabsTrigger>
        )}
      </TabsList>
      </div>

      {/* Quizzes Tab */}
      <TabsContent value="quizzes" className="mt-4 space-y-6">
        <StudentQuizScoresTable scores={visibleQuizScores} sectionId={sectionId} />
        {/* Render whenever the action returned, not only when it returned rows —
            the component now distinguishes "no topics tracked" from "nothing
            scored yet", and both are worth saying. */}
        {topicData && (
          <StudentSkillInsights data={topicData} />
        )}
      </TabsContent>

      {/* Assignments Tab */}
      <TabsContent value="assignments" className="mt-4">
        {assignmentGrades.length === 0 ? (
          <EmptyState
            variant="teaching"
            icon={FileText}
            title="No graded assignments yet"
            description="Your assignment grades will appear here once your professor releases them."
          />
        ) : (
          <div className="space-y-3">
            {assignmentGrades.map((ag) => {
              const graded = ag.score != null
              const pct = graded && ag.points ? (ag.score! / ag.points) * 100 : null
              const scoreColor = pct == null
                ? 'text-muted-foreground'
                : pct >= 80
                  ? 'text-success-muted-foreground'
                  : pct >= 60
                    ? 'text-warning-muted-foreground'
                    : 'text-destructive'
              const statusLabel = graded
                ? null
                : ag.status === 'returned'
                  ? 'Changes requested'
                  : ag.status === 'submitted' || ag.status === 'graded'
                    ? 'Submitted — awaiting grade'
                    : 'Not submitted'

              return (
                <Card key={ag.assignmentId}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-medium">{ag.title}</h3>

                        {graded && ag.feedback && (
                          <div className="mt-2 flex items-start gap-2">
                            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {ag.feedback}
                            </p>
                          </div>
                        )}

                        {graded && ag.gradedAt && (
                          <p className="text-[10px] text-muted-foreground/60 mt-1.5">
                            {/* timeZone pinned so SSR (UTC) and client (local) agree — avoids React #418 */}
                            Graded {new Date(ag.gradedAt).toLocaleDateString('en-US', {
                              timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
                            })}
                          </p>
                        )}
                      </div>

                      {graded ? (
                        <div className="flex items-baseline gap-1.5 shrink-0">
                          <Star className="h-4 w-4 self-center text-muted-foreground" />
                          <span className={cn(
                            'text-2xl font-semibold tracking-tight tabular-nums',
                            scoreColor,
                          )}>
                            {ag.score}
                          </span>
                          <span className="text-sm text-muted-foreground">/{ag.points ?? '—'}</span>
                        </div>
                      ) : (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          {statusLabel}
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </TabsContent>

      {/* Projects Tab */}
      <TabsContent value="projects" className="mt-4">
        {projectGrades.length === 0 ? (
          <EmptyState
            variant="teaching"
            icon={FolderKanban}
            title="No project grades yet"
            description="Your project grades will appear here once your professor releases them."
          />
        ) : (
          <div className="space-y-3">
            {projectGrades.map((pg) => {
              const scoreColor = pg.score >= 80
                ? 'text-success-muted-foreground'
                : pg.score >= 60
                  ? 'text-warning-muted-foreground'
                  : 'text-destructive'

              return (
                <Card key={pg.projectId}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-medium">{pg.projectTitle}</h3>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {pg.teamName}
                          </Badge>
                        </div>

                        {pg.feedback && (
                          <div className="mt-2 flex items-start gap-2">
                            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {pg.feedback}
                            </p>
                          </div>
                        )}

                        {pg.gradedAt && (
                          <p className="text-[10px] text-muted-foreground/60 mt-1.5">
                            {/* timeZone pinned so SSR (UTC) and client (local) agree — avoids React #418 hydration mismatch */}
                            Graded {new Date(pg.gradedAt).toLocaleDateString('en-US', {
                              timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
                            })}
                          </p>
                        )}
                      </div>

                      <div className="flex items-baseline gap-1.5 shrink-0">
                        <Star className="h-4 w-4 self-center text-muted-foreground" />
                        <span className={cn(
                          'text-2xl font-semibold tracking-tight tabular-nums',
                          scoreColor,
                        )}>
                          {pg.score}
                        </span>
                        <span className="text-sm text-muted-foreground">/100</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
