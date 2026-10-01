/**
 * TeamGradePage — dedicated page for grading one project team against the
 * project's phase-weighted rubric.
 *
 *   1. Overall grading — the submission review + the team-grained rubric items
 *      (one shared entry each). Plus the Release control.
 *   2. Individual grading — one row per member: their live computed total
 *      (Σ earned / Σ resolved weight, "X of Y graded"), the auto-pulled item
 *      statuses, and an entry for each individual manual/level item.
 *
 * Grades are computed server-side (lib/projects/grade.ts); this component only
 * renders them and persists manual/level entries via gradeItemScore.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowLeft, Send, AlertCircle, Github, Video, Link2, ExternalLink,
  FileText, Download, Crown, Shield, Users, Eye, EyeOff, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { MEMBER_ROLE_LABELS } from '@/lib/validations/project'
import { gradeItemScore, setProjectGradesReleased } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'
import type { RubricItem, StudentGrade, ItemResult } from '@/lib/projects/grade'

interface Member {
  id: string
  user_id: string
  role: string
  profile?: { name?: string | null; email?: string | null } | null
}

type ScoreEntry = { earned: number | null; levelId: string | null }

interface TeamGradePageProps {
  sectionId: string
  projectId: string
  projectTitle: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  team: any
  teamId: string
  members: Member[]
  rubric: RubricItem[]
  grades: Record<string, StudentGrade>
  teamScores: Record<string, ScoreEntry>
  studentScores: Record<string, ScoreEntry>
  released: boolean
  canWrite: boolean
}

function getInitials(name: string | null | undefined): string {
  if (!name) return '?'
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Matches lib/projects/grade.ts gradePercent (2 dp) so professor + student see
// the same digits for the same grade.
function percentOf(g: StudentGrade | undefined): number | null {
  if (!g || g.total <= 0) return null
  return Math.round((g.earned / g.total) * 10000) / 100
}

// Contributions are raw floats (72/100 × 10 = 7.199999999999999); round for
// display only — the engine sums unrounded and rounds once per student.
function fmtPts(n: number): number {
  return Math.round(n * 100) / 100
}

const AUTO_TYPES = new Set(['assignment', 'quiz', 'attendance'])

export function TeamGradePage({
  sectionId,
  projectId,
  projectTitle,
  team,
  teamId,
  members,
  rubric,
  grades,
  teamScores,
  studentScores,
  released,
  canWrite,
}: TeamGradePageProps) {
  const router = useRouter()
  const teamPath = `/professor/courses/${sectionId}/projects/${projectId}/teams/${team.id}`
  const submission = team.submission || {}
  const hasSubmission = !!team.submission && submission.status === 'submitted'

  const teamItems = rubric.filter((i) => i.grain === 'team')
  const individualItems = rubric.filter((i) => i.grain === 'individual')
  const projectTotal = rubric.reduce((s, i) => s + (Number(i.weight) || 0), 0)

  const [releasing, startRelease] = useTransition()
  function toggleRelease() {
    startRelease(async () => {
      const res = await setProjectGradesReleased(projectId, sectionId, !released)
      if (res.error) toast.error(res.error)
      else {
        toast.success(released ? 'Grades hidden from students' : 'Grades released to students')
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-8">
      <Link
        href={teamPath}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to {team.name}
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            Grading · {projectTitle}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
            {hasSubmission ? (
              <Badge className="bg-success-muted px-1.5 py-0 text-xs text-success-muted-foreground">
                <Send className="mr-0.5 h-2.5 w-2.5" />
                Submitted
              </Badge>
            ) : (
              <Badge className="bg-warning-muted px-1.5 py-0 text-xs text-warning-muted-foreground">
                <AlertCircle className="mr-0.5 h-2.5 w-2.5" />
                Not submitted
              </Badge>
            )}
            <Badge variant="outline" className="px-1.5 py-0 text-xs tabular-nums">
              Project total {Math.round(projectTotal * 10) / 10} pts
            </Badge>
          </div>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                'gap-1',
                released ? 'border-success/40 text-success-muted-foreground' : 'text-muted-foreground',
              )}
            >
              {released ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {released ? 'Released' : 'Not released'}
            </Badge>
            {released ? (
              <Button size="sm" variant="outline" onClick={toggleRelease} disabled={releasing}>
                {releasing ? 'Saving…' : 'Hide from all teams'}
              </Button>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" disabled={releasing}>
                    {releasing ? 'Saving…' : 'Release to all teams'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Release grades to all teams?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Releasing is project-wide: it publishes every team&apos;s computed grades to their
                      students, not just this team. You can hide them again at any time.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={toggleRelease}>Release to all teams</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
      </div>

      {/* ── Section 1: Overall grading ─────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Overall grading</h2>
          <p className="text-sm text-muted-foreground">
            Team-graded items: one score shared by every member.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          {/* Team items */}
          <div className="space-y-3">
            {teamItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/10 p-6 text-center">
                <p className="text-sm font-medium">No team-graded items</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Set an item&apos;s grain to &quot;team&quot; on the Rubric tab to grade it once for the whole team.
                </p>
              </div>
            ) : (
              teamItems.map((item) => (
                <div key={item.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{item.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{item.weight} pts</span>
                  </div>
                  <ItemEntry
                    item={item}
                    target={{ teamId }}
                    initial={teamScores[item.id]}
                    sectionId={sectionId}
                    projectId={projectId}
                    canWrite={canWrite}
                  />
                </div>
              ))
            )}
          </div>

          {/* Submission review */}
          <div className="rounded-xl border border-border bg-card p-6">
            {!hasSubmission ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <AlertCircle className="mb-3 h-9 w-9 text-muted-foreground/40" />
                <p className="text-sm font-semibold">No submission yet</p>
                <p className="mt-1 text-xs text-muted-foreground">You can still grade the rubric.</p>
              </div>
            ) : (
              <div className="space-y-5">
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                    Submission
                  </p>
                  <h3 className="text-xl font-semibold tracking-tight">{submission.title || team.name}</h3>
                  {submission.tagline && <p className="mt-1 text-sm text-muted-foreground">{submission.tagline}</p>}
                </div>
                {submission.description && (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{submission.description}</p>
                )}
                {(submission.github_url || submission.video_url ||
                  (submission.additional_links && submission.additional_links.length > 0)) && (
                  <div className="space-y-2">
                    {submission.github_url && <SubmissionLink icon={Github} href={submission.github_url} label={submission.github_url} />}
                    {submission.video_url && <SubmissionLink icon={Video} href={submission.video_url} label={submission.video_url} />}
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {submission.additional_links?.map((link: any, i: number) => (
                      <SubmissionLink key={i} icon={Link2} href={link.url} label={link.label || link.url} />
                    ))}
                  </div>
                )}
                {submission.documents && submission.documents.length > 0 && (
                  <div className="space-y-2">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {submission.documents.map((doc: any, i: number) => (
                      <a
                        key={i}
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-muted/50"
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{doc.name}</p>
                          <p className="text-[11px] text-muted-foreground">{formatFileSize(doc.size)}</p>
                        </div>
                        <Download className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </a>
                    ))}
                  </div>
                )}
                {submission.submitted_at && (
                  <>
                    <Separator />
                    <p className="text-[11px] text-muted-foreground/60">
                      {/* timeZone pinned so SSR (UTC) and client (local) agree — avoids React #418. */}
                      Submitted {new Date(submission.submitted_at).toLocaleDateString('en-US', {
                        timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
                      })}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Section 2: Individual grading ──────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Individual grading</h2>
          <p className="text-sm text-muted-foreground">
            Each member&apos;s project total = shared team items + their own. Ungraded items don&apos;t count against them.
          </p>
        </div>

        {members.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/10 p-8 text-center">
            <Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No members on this team</p>
          </div>
        ) : (
          <div className="space-y-3">
            {members.map((m) => (
              <MemberGradeCard
                key={m.id}
                member={m}
                grade={grades[m.user_id]}
                individualItems={individualItems}
                studentScores={studentScores}
                sectionId={sectionId}
                projectId={projectId}
                canWrite={canWrite}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ── One member's card ────────────────────────────────────────────

interface MemberGradeCardProps {
  member: Member
  grade?: StudentGrade
  individualItems: RubricItem[]
  studentScores: Record<string, ScoreEntry>
  sectionId: string
  projectId: string
  canWrite: boolean
}

function MemberGradeCard({ member, grade, individualItems, studentScores, sectionId, projectId, canWrite }: MemberGradeCardProps) {
  const name = member.profile?.name || 'Unknown'
  const RoleIcon = member.role === 'owner' ? Crown : Shield
  const pct = percentOf(grade)
  const byItem = new Map<string, ItemResult>((grade?.items ?? []).map((r) => [r.itemId, r]))
  const autoResults = (grade?.items ?? []).filter((r) => AUTO_TYPES.has(r.itemType) && r.grain === 'individual')

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar className="h-8 w-8">
          <AvatarFallback className="text-xs">{getInitials(name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <Badge className="bg-muted px-1.5 py-0 text-xs text-muted-foreground">
              <RoleIcon className="mr-0.5 h-2.5 w-2.5" />
              {MEMBER_ROLE_LABELS[member.role as keyof typeof MEMBER_ROLE_LABELS] || member.role}
            </Badge>
          </div>
          {member.profile?.email && <p className="truncate text-xs text-muted-foreground">{member.profile.email}</p>}
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">
            {grade ? `${grade.earned}/${grade.total}` : '–'}
            <span className="ml-1 text-xs font-normal text-muted-foreground">pts</span>
          </p>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {pct == null ? 'nothing graded' : `${pct}%`}
            {grade ? ` · ${grade.gradedCount} of ${grade.itemCount} graded` : ''}
          </p>
        </div>
      </div>

      {/* Auto-pulled items (read-only status + contribution) */}
      {autoResults.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-11">
          {autoResults.map((r) => (
            <span
              key={r.itemId}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
                r.graded ? 'bg-success-muted text-success-muted-foreground' : 'bg-warning-muted text-warning-muted-foreground',
              )}
            >
              <span className="font-medium">{r.title}</span>
              <span className="opacity-80">{r.detail}</span>
              {r.graded &&
                (r.weight > 0 ? (
                  <span className="tabular-nums">→ {r.contribution != null ? fmtPts(r.contribution) : r.contribution}/{r.weight}</span>
                ) : (
                  <span className="text-muted-foreground">not weighted</span>
                ))}
            </span>
          ))}
        </div>
      )}

      {/* Individual manual/level items (entry) */}
      {individualItems.filter((i) => !AUTO_TYPES.has(i.itemType)).length > 0 && (
        <div className="mt-3 space-y-2 pl-11">
          {individualItems
            .filter((i) => !AUTO_TYPES.has(i.itemType))
            .map((item) => (
              <div key={item.id} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <span className="text-sm">{item.title}</span>
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">{item.weight} pts</span>
                </div>
                <div className="w-[220px]">
                  <ItemEntry
                    item={item}
                    target={{ studentId: member.user_id }}
                    initial={studentScores[`${item.id}:${member.user_id}`]}
                    sectionId={sectionId}
                    projectId={projectId}
                    canWrite={canWrite}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-sm tabular-nums">
                  {item.weight <= 0 ? (
                    <span className="text-muted-foreground">not weighted</span>
                  ) : byItem.get(item.id)?.contribution != null ? (
                    `${fmtPts(byItem.get(item.id)!.contribution!)}/${item.weight}`
                  ) : (
                    '–'
                  )}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

// ── Entry control for one manual/level item + target ─────────────

interface ItemEntryProps {
  item: RubricItem
  target: { teamId: string } | { studentId: string }
  initial?: ScoreEntry
  sectionId: string
  projectId: string
  canWrite: boolean
}

function ItemEntry({ item, target, initial, sectionId, projectId, canWrite }: ItemEntryProps) {
  const router = useRouter()
  const [earned, setEarned] = useState<string>(initial?.earned != null ? String(initial.earned) : '')
  const [levelId, setLevelId] = useState<string>(initial?.levelId ?? '')
  const [saving, startSave] = useTransition()

  function save(nextLevel?: string) {
    startSave(async () => {
      const base = 'teamId' in target ? { team_id: target.teamId } : { student_id: target.studentId }
      const payload =
        item.scoringMode === 'levels'
          ? { ...base, level_id: (nextLevel ?? levelId) || null }
          : { ...base, earned: earned === '' ? null : Number(earned) }
      const res = await gradeItemScore(item.id, projectId, sectionId, payload)
      if (res.error) toast.error(res.error)
      else {
        toast.success('Saved')
        router.refresh()
      }
    })
  }

  if (item.scoringMode === 'levels') {
    return (
      <Select
        value={levelId}
        disabled={!canWrite || saving}
        onValueChange={(v) => {
          setLevelId(v)
          save(v)
        }}
      >
        <SelectTrigger className="h-9">
          <SelectValue placeholder="Pick a level" />
        </SelectTrigger>
        <SelectContent>
          {item.levels.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.label} ({l.points})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  const dirty = earned !== (initial?.earned != null ? String(initial.earned) : '')
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={0}
        max={item.manualMax ?? undefined}
        disabled={!canWrite}
        value={earned}
        onChange={(e) => setEarned(e.target.value)}
        className="h-9 text-right tabular-nums"
        placeholder="–"
      />
      <span className="shrink-0 text-xs text-muted-foreground">/ {item.manualMax ?? 0}</span>
      {canWrite && (
        <Button
          size="sm"
          variant={dirty ? 'default' : 'outline'}
          className="h-9 shrink-0"
          onClick={() => save()}
          disabled={saving || !dirty}
          aria-label="Save score"
        >
          {saving ? '…' : <Check className="h-4 w-4" />}
        </Button>
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────

function SubmissionLink({ icon: Icon, href, label }: { icon: typeof Github; href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  )
}
