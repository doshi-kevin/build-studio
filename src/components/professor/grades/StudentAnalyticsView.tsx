// Unified student analytics page — shows quiz scores, proctoring
// summaries, and topic performance in a single consolidated view.
// Replaces the need to navigate between Grades, Insights, and Proctoring.

'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  Clock,
  ClipboardCheck,
  ShieldAlert,
  Eye,
  Copy,
  Scissors,
  MonitorOff,
  Smartphone,
  Users,
  Camera,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  ExternalLink,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import SnapshotGallery from '@/components/professor/quizzes/SnapshotGallery'
import { masteryTier } from '@/lib/skills/mastery'
import type { StudentAnalyticsData } from '@/app/(dashboard)/professor/courses/[sectionId]/grades/actions'

function scoreColor(score: number | null): string {
  if (score == null) return 'text-muted-foreground'
  if (score >= 80) return 'text-success-muted-foreground'
  if (score >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive'
}

function formatTime(seconds: number | null): string {
  if (!seconds) return '-'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

interface StudentAnalyticsViewProps {
  data: StudentAnalyticsData
  sectionId: string
}

export function StudentAnalyticsView({ data, sectionId }: StudentAnalyticsViewProps) {
  const { student, attempts, skillMastery, trackedSkillCount, masteryUnavailable, snapshots, quizCount, classAverage } = data
  /* A null score means "not assessed yet", never zero. Rendering it as a 0% bar
     would read as the student having failed the skill.
     Weakest first, because the list below is capped at 15. aggregateStudentMastery
     returns course order, so slicing it directly showed an arbitrary 15 — for a
     student with 30 scored skills the professor could see an 80% and miss eight
     skills in the teens that the student's own page lists. Same rule the student
     side uses, so the two pick the same skills as well as the same numbers. */
  const scoredSkills = skillMastery
    .filter((s) => s.classScore != null)
    .sort((a, b) => (a.classScore as number) - (b.classScore as number))

  // Compute student average
  const submittedAttempts = attempts.filter((a) => a.status === 'submitted' && a.score != null)
  const studentAverage = submittedAttempts.length > 0
    ? Math.round(submittedAttempts.reduce((sum, a) => sum + (a.score ?? 0), 0) / submittedAttempts.length)
    : null

  // Best attempt per quiz (for overview)
  const bestByQuiz = (() => {
    const map = new Map<string, typeof attempts[0]>()
    for (const a of submittedAttempts) {
      const existing = map.get(a.quizId)
      if (!existing || (a.score ?? 0) > (existing.score ?? 0)) {
        map.set(a.quizId, a)
      }
    }
    return Array.from(map.values())
  })()

  // Aggregate proctoring stats across all attempts
  const proctoringAgg = (() => {
    const agg = {
      totalKeystrokes: 0,
      copyCount: 0,
      pasteCount: 0,
      cutCount: 0,
      tabSwitchCount: 0,
      multipleFaceCount: 0,
      phoneDetectedCount: 0,
      snapshotCount: 0,
      webcamDenied: false,
      suspiciousFlags: new Set<string>(),
      proctoredAttempts: 0,
    }

    for (const a of submittedAttempts) {
      if (!a.proctoringSummary) continue
      agg.proctoredAttempts++
      const s = a.proctoringSummary
      agg.totalKeystrokes += s.totalKeystrokes || 0
      agg.copyCount += s.copyCount || 0
      agg.pasteCount += s.pasteCount || 0
      agg.cutCount += s.cutCount || 0
      agg.tabSwitchCount += s.tabSwitchCount || 0
      agg.multipleFaceCount += s.multipleFaceCount || 0
      agg.phoneDetectedCount += s.phoneDetectedCount || 0
      agg.snapshotCount += s.snapshotCount || 0
      if (s.webcamDenied) agg.webcamDenied = true
      for (const f of (s.suspiciousFlags || [])) agg.suspiciousFlags.add(f)
    }

    return agg
  })()

  const quizzesCompleted = bestByQuiz.length
  const quizzesMissing = quizCount - quizzesCompleted

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link href={`/professor/courses/${sectionId}/grades`} className="hover:text-foreground transition-colors">
          Grades
        </Link>
        <span className="opacity-40">/</span>
        <span className="text-foreground font-medium">{student.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {student.name}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{student.email}</p>
          {/* This page is everything about the student INSIDE this section. The
              profile is the other half: their other courses, and when the two of
              you are both free. */}
          <Link
            href={`/professor/students/${student.id}`}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          >
            Profile and availability
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
        {student.finalGrade && (
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">Final Grade</p>
            <p className="text-3xl font-semibold tabular-nums mt-1">{student.finalGrade}</p>
          </div>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">Average Score</p>
          <p className={`text-3xl font-semibold tabular-nums mt-1 ${scoreColor(studentAverage)}`}>
            {studentAverage != null ? `${studentAverage}%` : '-'}
          </p>
          {classAverage != null && studentAverage != null && (
            <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
              {studentAverage >= classAverage ? (
                <TrendingUp className="h-3 w-3 text-success-muted-foreground" />
              ) : (
                <TrendingDown className="h-3 w-3 text-destructive" />
              )}
              Class avg: {classAverage}%
            </p>
          )}
        </Card>

        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">Quizzes</p>
          <p className="text-3xl font-semibold tabular-nums mt-1">
            {quizzesCompleted}/{quizCount}
          </p>
          {quizzesMissing > 0 && (
            <p className="text-[10px] text-destructive mt-1">{quizzesMissing} missing</p>
          )}
        </Card>

        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">Total Attempts</p>
          <p className="text-3xl font-semibold tabular-nums mt-1">{submittedAttempts.length}</p>
        </Card>

        <Card className="p-5">
          <p className="text-[11px] uppercase tracking-[0.15em] font-semibold text-muted-foreground">Avg Time</p>
          <p className="text-3xl font-semibold tabular-nums mt-1">
            {submittedAttempts.length > 0
              ? formatTime(Math.round(
                  submittedAttempts.reduce((sum, a) => sum + (a.timeSpentSeconds ?? 0), 0) / submittedAttempts.length
                ))
              : '-'}
          </p>
        </Card>
      </div>

      {/* Quiz Performance Table */}
      <Card className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Quiz Performance</h2>
        </div>

        {bestByQuiz.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No submitted quizzes yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Quiz</TableHead>
                <TableHead className="text-xs text-right">Score</TableHead>
                <TableHead className="text-xs text-right">Points</TableHead>
                <TableHead className="text-xs text-right">Time</TableHead>
                <TableHead className="text-xs text-center">Proctoring</TableHead>
                <TableHead className="text-xs text-right">Submitted</TableHead>
                <TableHead className="text-xs w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bestByQuiz.map((a) => (
                <TableRow key={a.attemptId}>
                  <TableCell className="text-sm font-medium">{a.quizTitle}</TableCell>
                  <TableCell className={`text-sm text-right font-semibold ${scoreColor(a.score)}`}>
                    {a.score != null ? `${a.score}%` : '-'}
                  </TableCell>
                  <TableCell className="text-sm text-right text-muted-foreground">
                    {a.earnedPoints != null && a.totalPoints != null ? `${a.earnedPoints}/${a.totalPoints}` : '-'}
                  </TableCell>
                  <TableCell className="text-sm text-right text-muted-foreground">
                    {formatTime(a.timeSpentSeconds)}
                  </TableCell>
                  <TableCell className="text-center">
                    {a.proctoringSummary ? (
                      <ProctoringBadges summary={a.proctoringSummary} />
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-right text-muted-foreground">
                    {a.submittedAt ? new Date(a.submittedAt).toLocaleDateString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    }) : '-'}
                  </TableCell>
                  <TableCell>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            href={`/professor/courses/${sectionId}/quizzes/${a.quizId}/submissions/${a.attemptId}`}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>View full submission detail</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Proctoring Overview (aggregated) */}
      {proctoringAgg.proctoredAttempts > 0 && (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Proctoring Summary</h2>
            <Badge variant="secondary" className="text-[10px]">
              {proctoringAgg.proctoredAttempts} proctored attempt{proctoringAgg.proctoredAttempts !== 1 ? 's' : ''}
            </Badge>
          </div>

          {proctoringAgg.suspiciousFlags.size > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {[...proctoringAgg.suspiciousFlags].map((flag) => (
                <Badge key={flag} variant="destructive" className="text-[10px] gap-1">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {flag.replace(/_/g, ' ')}
                </Badge>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <ProctoringStatCard icon={<Clock className="h-3.5 w-3.5" />} label="Keystrokes" value={proctoringAgg.totalKeystrokes} />
            <ProctoringStatCard icon={<Copy className="h-3.5 w-3.5" />} label="Copy" value={proctoringAgg.copyCount} warn={proctoringAgg.copyCount > 0} />
            <ProctoringStatCard icon={<Scissors className="h-3.5 w-3.5" />} label="Cut" value={proctoringAgg.cutCount} warn={proctoringAgg.cutCount > 0} />
            <ProctoringStatCard icon={<MonitorOff className="h-3.5 w-3.5" />} label="Tab Switches" value={proctoringAgg.tabSwitchCount} warn={proctoringAgg.tabSwitchCount > 3} />
            <ProctoringStatCard icon={<Users className="h-3.5 w-3.5" />} label="Multi-Face" value={proctoringAgg.multipleFaceCount} warn={proctoringAgg.multipleFaceCount > 0} />
            <ProctoringStatCard icon={<Smartphone className="h-3.5 w-3.5" />} label="Phone" value={proctoringAgg.phoneDetectedCount} warn={proctoringAgg.phoneDetectedCount > 0} />
            <ProctoringStatCard icon={<Camera className="h-3.5 w-3.5" />} label="Snapshots" value={proctoringAgg.snapshotCount} />
          </div>

          {proctoringAgg.webcamDenied && (
            <div className="flex items-center gap-2 mt-3 text-xs text-warning-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              Student denied webcam access in one or more attempts.
            </div>
          )}
        </Card>
      )}

      {/* Proctoring Snapshots (violation images) */}
      {snapshots.length > 0 && (
        <SnapshotGallery
          snapshots={snapshots}
          attemptStartedAt={submittedAttempts[0]?.startedAt || new Date().toISOString()}
        />
      )}

      {/* Skill mastery. The old correct/total fraction is deliberately gone: a
          mastery score is not a count of items. It weights by points, decays with
          recency, caps per-event movement, and folds in assignments and live
          quizzes that have no "items" at all — so printing 12/15 beside 68%
          invites the reader to compute 80% and conclude one of them is broken.
          The subtitle names the source instead. */}
      {scoredSkills.length === 0 ? (
        /* Not a blank space. A student with nothing assessed and a course that
           tracks nothing look identical otherwise, and they need different
           next steps from the professor. */
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Skill mastery</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {masteryUnavailable
              ? "The scores didn't come back. This is usually temporary, so reload the page in a moment."
              : trackedSkillCount === 0
                ? 'This course does not track skills yet, so there is nothing to score against.'
                : 'Nothing has been graded for this student against the course\u2019s tracked skills yet.'}
          </p>
          {/* Same exit the class-level empty state offers, and for the same
              reason — but never on a failed read, which would send them to
              recreate skills that already exist. */}
          {!masteryUnavailable && trackedSkillCount === 0 && (
            <Button asChild variant="outline" size="sm" className="mt-3 w-fit">
              <Link href={`/professor/courses/${sectionId}/modules`}>Go to Modules</Link>
            </Button>
          )}
        </Card>
      ) : (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Skill mastery</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            The same number this student sees on their roadmap.
          </p>

          <div className="space-y-2">
            {scoredSkills.slice(0, 15).map((skill) => {
              const pct = Math.round(skill.classScore ?? 0)
              const tier = masteryTier(skill.classScore)
              return (
                <div key={skill.skillId} className="flex items-center gap-3">
                  {/* title, because w-32 truncate at text-xs cuts most curated
                      skill names and several in production collide on the same
                      visible prefix. Hover is not available on touch, but a
                      truncated name with no way to read it is worse. */}
                  <span title={skill.name} className="text-xs text-muted-foreground w-32 truncate shrink-0">{skill.name}</span>
                  <div className="flex-1 h-2 bg-muted/30 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-[width,background-color] ${
                        tier === 'strong' ? 'bg-success' : tier === 'shaky' ? 'bg-warning' : 'bg-destructive'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className={`text-xs font-semibold w-10 text-right ${
                    tier === 'strong' ? 'text-success-muted-foreground' : tier === 'shaky' ? 'text-warning-muted-foreground' : 'text-destructive'
                  }`}>
                    {pct}%
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* All Attempts (including retries) */}
      {attempts.length > bestByQuiz.length && (
        <>
          <Separator />
          <Card className="p-5">
            <h2 className="text-sm font-semibold mb-4">All Attempts (including retries)</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Quiz</TableHead>
                  <TableHead className="text-xs text-right">Score</TableHead>
                  <TableHead className="text-xs text-right">Time</TableHead>
                  <TableHead className="text-xs text-center">Status</TableHead>
                  <TableHead className="text-xs text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempts.map((a) => (
                  <TableRow key={a.attemptId}>
                    <TableCell className="text-sm">{a.quizTitle}</TableCell>
                    <TableCell className={`text-sm text-right font-semibold ${scoreColor(a.score)}`}>
                      {a.score != null ? `${a.score}%` : '-'}
                    </TableCell>
                    <TableCell className="text-sm text-right text-muted-foreground">
                      {formatTime(a.timeSpentSeconds)}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant={a.status === 'submitted' ? 'default' : 'secondary'} className="text-[10px]">
                        {a.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-right text-muted-foreground">
                      {a.submittedAt ? new Date(a.submittedAt).toLocaleDateString(undefined, {
                        month: 'short', day: 'numeric',
                      }) : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}

// ── Sub-Components ───────────────────────────────────────────────

function ProctoringBadges({ summary }: { summary: NonNullable<StudentAnalyticsData['attempts'][0]['proctoringSummary']> }) {
  const flags: string[] = []
  if (summary.tabSwitchCount > 3) flags.push(`${summary.tabSwitchCount} tabs`)
  if (summary.copyCount > 0) flags.push(`${summary.copyCount} copy`)
  if (summary.multipleFaceCount > 0) flags.push(`${summary.multipleFaceCount} faces`)
  if (summary.phoneDetectedCount > 0) flags.push(`${summary.phoneDetectedCount} phone`)

  if (flags.length === 0) {
    return <Badge variant="secondary" className="text-[10px]">Clean</Badge>
  }

  return (
    <div className="flex flex-wrap gap-1 justify-center">
      {flags.map((f) => (
        <Badge key={f} variant="destructive" className="text-[10px] px-1.5 py-0">{f}</Badge>
      ))}
    </div>
  )
}

function ProctoringStatCard({
  icon,
  label,
  value,
  warn,
}: {
  icon: React.ReactNode
  label: string
  value: number
  warn?: boolean
}) {
  return (
    <div className={`p-3 rounded-xl border ${warn ? 'border-warning/30 bg-warning-muted/50' : 'border-border bg-muted/10'}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={warn ? 'text-warning-muted-foreground' : 'text-muted-foreground'}>{icon}</span>
        <span className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">{label}</span>
      </div>
      <p className={`text-xl font-semibold tabular-nums ${warn ? 'text-warning-muted-foreground' : ''}`}>
        {value}
      </p>
    </div>
  )
}
