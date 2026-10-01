/**
 * ChallengeCard — Professor challenge list item.
 *
 * Displays title, type badge, difficulty, points, claim stats, and visibility.
 *
 * Type: Client Component
 */
'use client'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Trophy, Users, Clock, CheckCircle2 } from 'lucide-react'
import {
  CHALLENGE_TYPE_LABELS,
  CHALLENGE_DIFFICULTY_LABELS,
  CHALLENGE_VISIBILITY_LABELS,
  type ChallengeType,
  type ChallengeDifficulty,
  type ChallengeVisibility,
} from '@/lib/validations/challenge'

const difficultyColors: Record<string, string> = {
  easy: 'bg-success-muted text-success-muted-foreground border-success/30',
  medium: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  hard: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
  expert: 'bg-destructive-muted text-destructive-muted-foreground border-destructive/30',
}

const visibilityColors: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground border-transparent',
  published: 'bg-success-muted text-success-muted-foreground border-success/30',
  archived: 'bg-warning-muted text-warning-muted-foreground border-warning/30',
}

interface ChallengeClaim {
  id: string
  status: string
}

interface ChallengeData {
  id: string
  title: string
  type: string
  difficulty: string
  visibility: string
  points: number
  challenge_claims?: ChallengeClaim[]
}

interface ChallengeCardProps {
  challenge: ChallengeData
  /** Skills this challenge builds (Slice A) — rendered as chips. */
  skills?: { id: string; name: string }[]
  isSelected?: boolean
  onClick?: () => void
}

export function ChallengeCard({ challenge, skills = [], isSelected, onClick }: ChallengeCardProps) {
  const claims = challenge.challenge_claims || []
  const submittedCount = claims.filter((c) => c.status === 'submitted').length
  const approvedCount = claims.filter((c) => c.status === 'approved').length

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group w-full text-left bg-card border border-border rounded-xl p-4 transition duration-200 ease-out',
        isSelected
          ? 'border-ring shadow-sm ring-1 ring-ring/30'
          : 'hover:border-ring/40 hover:shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              'text-sm font-semibold truncate transition-colors',
              !isSelected && 'group-hover:text-primary',
            )}
          >
            {challenge.title}
          </h3>
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {CHALLENGE_TYPE_LABELS[challenge.type as ChallengeType] || challenge.type}
            </Badge>
            <Badge className={cn('text-[10px] px-1.5 py-0', difficultyColors[challenge.difficulty])}>
              {CHALLENGE_DIFFICULTY_LABELS[challenge.difficulty as ChallengeDifficulty] || challenge.difficulty}
            </Badge>
            <Badge className={cn('text-[10px] px-1.5 py-0', visibilityColors[challenge.visibility])}>
              {CHALLENGE_VISIBILITY_LABELS[challenge.visibility as ChallengeVisibility] || challenge.visibility}
            </Badge>
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
        <div className="flex items-center gap-1 text-sm font-semibold text-foreground shrink-0 tabular-nums">
          <Trophy className="h-3.5 w-3.5 text-muted-foreground" />
          {challenge.points}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground tabular-nums">
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          {claims.length} claimed
        </span>
        {submittedCount > 0 && (
          <span className="flex items-center gap-1 text-warning-muted-foreground">
            <Clock className="h-3 w-3" />
            {submittedCount} to review
          </span>
        )}
        {approvedCount > 0 && (
          <span className="flex items-center gap-1 text-success-muted-foreground">
            <CheckCircle2 className="h-3 w-3" />
            {approvedCount} approved
          </span>
        )}
      </div>
    </button>
  )
}
