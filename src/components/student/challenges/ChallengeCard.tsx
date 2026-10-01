/**
 * ChallengeCard — Student challenge list item.
 *
 * Shows title, type, difficulty, points, due date, and claim status.
 *
 * Type: Client Component
 */
'use client'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Trophy, CalendarDays } from 'lucide-react'
import {
  CHALLENGE_TYPE_LABELS,
  CHALLENGE_DIFFICULTY_LABELS,
  CLAIM_STATUS_LABELS,
  type ChallengeType,
  type ChallengeDifficulty,
  type ClaimStatus,
} from '@/lib/validations/challenge'

const difficultyColors: Record<string, string> = {
  easy: 'bg-success-muted text-success-muted-foreground border-success/30',
  medium: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  hard: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  expert: 'bg-destructive-muted text-destructive border-destructive/30',
}

const claimStatusColors: Record<string, string> = {
  claimed: 'bg-muted text-foreground border-transparent',
  submitted: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  approved: 'bg-success-muted text-success-muted-foreground border-success/30',
  rejected: 'bg-destructive-muted text-destructive border-destructive/30',
  withdrawn: 'bg-muted text-muted-foreground border-transparent',
}

interface ChallengeBadge {
  icon: string
  name: string
}

interface ChallengeClaim {
  status: string
}

interface Challenge {
  id: string
  title: string
  type: string
  difficulty: string
  points: number
  due_at?: string | null
  badge?: ChallengeBadge | null
  challenge_claims?: ChallengeClaim[]
}

interface ChallengeCardProps {
  challenge: Challenge
  myClaim?: ChallengeClaim
  /** Skills this challenge builds (Slice A) — rendered as chips. */
  skills?: { id: string; name: string }[]
  isSelected?: boolean
  onClick?: () => void
}

export function ChallengeCard({ challenge, myClaim, skills = [], isSelected, onClick }: ChallengeCardProps) {
  const dueDate = challenge.due_at
      /* UTC, not the viewer's zone (#703 part 4). A challenge due date is entered as a
         bare `type="date"` value and stored into a timestamptz, so `2020-01-01` lands as
         midnight UTC. Rendered in local time that reads "Dec 31, 2019" for anyone west of
         UTC — the professor's own date, shown back to them a day early. due_at is
         display-only for challenges, so reading it in UTC shows the date that was typed
         without touching a single stored row. */
    ? new Date(challenge.due_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: 'UTC',
      })
    : null

  const totalClaimed = (challenge.challenge_claims || []).length
  const approvedCount = (challenge.challenge_claims || []).filter((c) => c.status === 'approved').length

  return (
    <div
      // Athena scrolls to this when she proposes a challenge (§14, C14).
      data-challenge-id={challenge.id}
      className={cn(
        'bg-card border border-border rounded-xl p-4 cursor-pointer transition duration-200 ease-out hover:border-ring/40 hover:shadow-sm',
        isSelected && 'border-primary/40 ring-1 ring-primary/20',
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold truncate">{challenge.title}</h3>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {CHALLENGE_TYPE_LABELS[challenge.type as ChallengeType] || challenge.type}
            </Badge>
            <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', difficultyColors[challenge.difficulty])}>
              {CHALLENGE_DIFFICULTY_LABELS[challenge.difficulty as ChallengeDifficulty] || challenge.difficulty}
            </Badge>
            {myClaim && (
              <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', claimStatusColors[myClaim.status])}>
                {CLAIM_STATUS_LABELS[myClaim.status as ClaimStatus] || myClaim.status}
              </Badge>
            )}
          </div>
          {skills.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {skills.map((s) => (
                <Badge key={s.id} variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                  {s.name}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <Trophy className="h-3.5 w-3.5" />
            {challenge.points}
          </div>
          {challenge.badge && (
            <span className="text-xs">{challenge.badge.icon}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
        {dueDate && (
          <span className="flex items-center gap-1">
            <CalendarDays className="h-3 w-3" />
            {dueDate}
          </span>
        )}
        <span className="tabular-nums">{totalClaimed} claimed</span>
        {approvedCount > 0 && (
          <span className="text-success-muted-foreground tabular-nums">{approvedCount} solved</span>
        )}
      </div>
    </div>
  )
}
