// The student's mastery per curated skill, with strengths and weak spots called
// out. This is the same number their roadmap shows; it used to be raw quiz-tag
// accuracy, which disagreed with it.
//
// Says "skills", not "topics". The roadmap calls these skills in every visible
// string, and the professor drilldown promises the student sees the same number
// there — a student who reads "topics" here has no way to know it is the same
// thing. Keep the two surfaces on one word.
'use client'

import { Target, TrendingUp, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { EmptyState } from '@/components/ui/empty-state'
import { masteryTier } from '@/lib/skills/mastery'
import type { StudentSkillPerformance } from '@/app/(dashboard)/student/courses/[sectionId]/grades/actions'

interface StudentSkillInsightsProps {
  data: StudentSkillPerformance
}

// Cap the list so it stays scannable — matches the professor side's top-15.
// There is no MIN_SAMPLE any more: it existed to stop a single correct answer
// reading as a "strength", and the mastery engine handles that structurally
// (a cold start is seeded and the first event is slew-capped), so a filter here
// would just hide real evidence.
const TOP_N = 15

export function StudentSkillInsights({ data }: StudentSkillInsightsProps) {
  /* Weakest first BEFORE slicing. aggregateStudentMastery returns course order,
     so slicing it directly could drop a student's worst skill off the end and
     it would never appear under Needs Improvement. The professor side slices an
     already-ranked list; this makes the two behave the same. */
  const rankedSkills = [...data.skills]
    .sort((a, b) => (a.classScore ?? 101) - (b.classScore ?? 101))
    .slice(0, TOP_N)
  const strengths = rankedSkills.filter((s) => masteryTier(s.classScore) === 'strong').map((s) => s.name)
  const weaknesses = rankedSkills.filter((s) => masteryTier(s.classScore) === 'weak').map((s) => s.name)

  /* Two distinct empty states. Returning null for both meant a student whose
     course tracks nothing saw the same blank space as one who simply has not
     been marked yet, and neither knew which. */
  if (rankedSkills.length === 0) {
    /* Nothing at all when the course tracks no skills. That is an instructor
       configuration gap the student can do nothing about, and this is their
       default tab, so a permanent dashed box saying so is noise. The other
       branch stays, because "scores appear once your work is marked" tells the
       student something is coming. */
    if (data.trackedCount === 0) return null
    return (
      <EmptyState
        variant="teaching"
        icon={Target}
        title="No skill scores yet"
        description="Your instructor tracks skills for this course. Scores appear here once your graded work is marked."
      />
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Target className="h-4 w-4" />
          Your Skills
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Strengths */}
        {strengths.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 text-success-muted-foreground" />
              Strengths
            </p>
            <div className="flex flex-wrap gap-1.5">
              {strengths.map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  /* whitespace-normal + min-w-0: Badge is nowrap and shrink-0 by
                     default, so a name like "Review of Linear and Non-Linear Data
                     Structures" ran off a 390px screen with every ancestor
                     overflow-visible, unreachable rather than merely clipped. */
                  className="bg-success-muted text-success-muted-foreground border-success/30 min-w-0 whitespace-normal text-left"
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Weaknesses */}
        {weaknesses.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              Needs Improvement
            </p>
            <div className="flex flex-wrap gap-1.5">
              {weaknesses.map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="bg-destructive-muted text-destructive border-destructive/30 min-w-0 whitespace-normal text-left"
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Skill bars. No correct/total fraction: a mastery score weights by
            points, decays with recency and folds in work that has no "items",
            so a count beside it would not reconcile. */}
        <div className="space-y-3">
          {rankedSkills.map((skill) => {
            const pct = Math.round(skill.classScore ?? 0)
            const tier = masteryTier(skill.classScore)
            return (
              <div key={skill.skillId} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium truncate">{skill.name}</span>
                  <span className={cn(
                    'text-xs font-semibold tabular-nums',
                    tier === 'strong' ? 'text-success-muted-foreground'
                      : tier === 'shaky' ? 'text-warning-muted-foreground'
                        : 'text-destructive',
                  )}>
                    {pct}%
                  </span>
                </div>
                <Progress
                  value={pct}
                  className={cn(
                    'h-2',
                    tier === 'strong' ? '[&>div]:bg-success'
                      : tier === 'shaky' ? '[&>div]:bg-warning'
                        : '[&>div]:bg-destructive',
                  )}
                />
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
