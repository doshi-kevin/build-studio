'use client'

import {
  GraduationCap,
  TrendingUp,
  TrendingDown,
  Minus,
  CalendarClock,
  Clock,
  AlertTriangle,
  UserRound,
  Search,
  Award,
  FolderKanban,
} from 'lucide-react'

/** Client-safe mirror of StudentPerformance (server type lives in a server-only module). */
interface StudentPerf {
  resolution: 'found' | 'not_found' | 'ambiguous'
  attemptedName: string
  suggestions?: string[]
  matches?: string[]
  student?: string
  note?: string
  finalGrade?: { letter: string | null; score: number | null }
  projects?: { avgPct: number | null; graded: number; items: { title: string; score: number }[] }
  overall?: {
    avgPct: number | null
    classAvgPct: number | null
    standing: 'above_average' | 'about_average' | 'below_average' | null
    completion: string
    quizzesTaken: number
    expectedQuizzes: number
    belowPass: number
    atRisk: boolean
    atRiskReason: string | null
  }
  behavior?: { lateSubmissions: number; daysSinceLastActivity: number | null }
  trend?: {
    trajectory: 'improving' | 'declining' | 'steady' | 'insufficient_data'
    recentAvg: number | null
    previousAvg: number | null
  }
  topics?: { strengths: string[]; weaknesses: { tag: string; score: number }[] }
  recentQuizzes?: {
    title: string
    status: 'submitted_on_time' | 'submitted_late' | 'missing'
    score: number | null
    passed: boolean | null
  }[]
  olderQuizCount?: number
}

/** Score color: green ≥80, amber ≥60, red <60 (matches the gradebook scale). */
function scoreClass(pct: number): string {
  if (pct >= 80) return 'text-success-muted-foreground'
  if (pct >= 60) return 'text-warning-muted-foreground'
  return 'text-destructive-muted-foreground'
}

function Stat({ icon: Icon, value, label }: { icon: typeof UserRound; value: string | number; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground tabular-nums">{value}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

function Header({ icon: Icon, title }: { icon: typeof UserRound; title: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
      <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary/10">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <span className="truncate text-sm font-semibold text-foreground">{title}</span>
    </div>
  )
}

export function StudentPerformanceCard({ output }: { output: StudentPerf }) {
  if (!output || typeof output !== 'object') return null

  // Resolution: name didn't match exactly one enrolled student.
  if (output.resolution === 'not_found') {
    return (
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <Header icon={Search} title={`No match for "${output.attemptedName}"`} />
        <div className="px-4 py-3 text-sm text-muted-foreground">
          {output.suggestions && output.suggestions.length > 0 ? (
            <>Did you mean one of these? Ask again with the exact name: {output.suggestions.join(', ')}.</>
          ) : (
            <>No enrolled student matched that name — double-check the spelling and ask again.</>
          )}
        </div>
      </div>
    )
  }
  if (output.resolution === 'ambiguous') {
    return (
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <Header icon={Search} title={`Multiple students match "${output.attemptedName}"`} />
        <div className="px-4 py-3 text-sm text-muted-foreground">
          Did you mean: {(output.matches || []).join(', ')}?
        </div>
      </div>
    )
  }

  const o = output.overall
  const b = output.behavior
  const t = output.trend
  const TrendIcon = t?.trajectory === 'improving' ? TrendingUp : t?.trajectory === 'declining' ? TrendingDown : Minus
  const standingLabel =
    o?.standing === 'above_average'
      ? 'above class avg'
      : o?.standing === 'below_average'
        ? 'below class avg'
        : o?.standing === 'about_average'
          ? 'about class avg'
          : 'class average'

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <Header icon={GraduationCap} title={output.student || 'Student'} />

      {output.note && <div className="px-4 py-3 text-sm text-muted-foreground">{output.note}</div>}

      {o && (
        <div className="grid grid-cols-2 gap-2 p-4">
          {output.finalGrade && (output.finalGrade.letter || output.finalGrade.score != null) && (
            <Stat
              icon={Award}
              value={
                output.finalGrade.letter
                  ? `${output.finalGrade.letter}${output.finalGrade.score != null ? ` (${output.finalGrade.score}%)` : ''}`
                  : `${output.finalGrade.score}%`
              }
              label="final course grade"
            />
          )}
          <Stat
            icon={GraduationCap}
            value={o.avgPct != null ? `${o.avgPct}%` : '—'}
            label={o.classAvgPct != null ? `quiz avg · ${standingLabel} (${o.classAvgPct}%)` : 'quiz average'}
          />
          {output.projects && output.projects.avgPct != null && (
            <Stat icon={FolderKanban} value={`${output.projects.avgPct}%`} label={`project avg (${output.projects.graded} graded)`} />
          )}
          <Stat icon={UserRound} value={o.completion} label="quizzes completed" />
          {t && t.trajectory !== 'insufficient_data' && (
            <Stat
              icon={TrendIcon}
              value={t.trajectory}
              label={t.recentAvg != null && t.previousAvg != null ? `${t.previousAvg}% → ${t.recentAvg}%` : 'recent trend'}
            />
          )}
          {b && (
            <Stat
              icon={Clock}
              value={b.daysSinceLastActivity != null ? `${b.daysSinceLastActivity}d` : '—'}
              label="since last activity"
            />
          )}
          {b && b.lateSubmissions > 0 && (
            <Stat icon={CalendarClock} value={b.lateSubmissions} label="late submissions" />
          )}
        </div>
      )}

      {o?.atRisk && (
        <div className="flex items-center gap-1.5 border-t border-border bg-destructive-muted/30 px-4 py-2.5 text-xs font-medium text-destructive-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          At-risk{o.atRiskReason ? ` — ${o.atRiskReason}` : ''}
        </div>
      )}

      {output.topics && (output.topics.strengths.length > 0 || output.topics.weaknesses.length > 0) && (
        <div className="border-t border-border px-4 py-3">
          {output.topics.strengths.length > 0 && (
            <p className="text-sm text-foreground">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Strong: </span>
              {output.topics.strengths.join(', ')}
            </p>
          )}
          {output.topics.weaknesses.length > 0 && (
            <p className="mt-1 text-sm text-foreground">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Needs work: </span>
              {output.topics.weaknesses.map((w) => `${w.tag} (${w.score}%)`).join(', ')}
            </p>
          )}
        </div>
      )}

      {output.projects && output.projects.items.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Projects</p>
          <div className="flex flex-col gap-1.5">
            {output.projects.items.map((p, i) => (
              <div key={`${p.title}-${i}`} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{p.title}</span>
                <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${scoreClass(p.score)}`}>
                  {p.score}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {output.recentQuizzes && output.recentQuizzes.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent quizzes{output.olderQuizCount ? ` (+${output.olderQuizCount} earlier)` : ''}
          </p>
          <div className="flex flex-col gap-1.5">
            {output.recentQuizzes.map((q, i) => (
              <div key={`${q.title}-${i}`} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{q.title}</span>
                {q.status === 'missing' ? (
                  <span className="shrink-0 text-xs font-medium text-destructive-muted-foreground">not taken</span>
                ) : (
                  <>
                    {q.status === 'submitted_late' && (
                      <span className="shrink-0 text-xs text-warning-muted-foreground">late</span>
                    )}
                    <span className={`w-12 shrink-0 text-right font-semibold tabular-nums ${scoreClass(q.score ?? 0)}`}>
                      {q.score}%
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
