'use client'

import { useState, useEffect } from 'react'
import { Trophy, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getQuizLeaderboard } from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'

interface LeaderboardEntry {
  rank: number
  studentName: string
  score: number
  submittedAt: string
  isCurrentUser: boolean
}

interface QuizLeaderboardProps {
  sectionId: string
  quizId: string
}

export function QuizLeaderboard({ sectionId, quizId }: QuizLeaderboardProps) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const result = await getQuizLeaderboard(sectionId, quizId)
      setEntries(result.data || [])
      setLoading(false)
    }
    load()
  }, [sectionId, quizId])

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </Card>
    )
  }

  if (entries.length === 0) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-3">
          <Trophy className="h-4 w-4 text-warning-muted-foreground" />
          <h3 className="text-sm font-semibold">Leaderboard</h3>
        </div>
        <p className="text-sm text-muted-foreground">No scores yet.</p>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Trophy className="h-4 w-4 text-warning-muted-foreground" />
        <h3 className="text-sm font-semibold">Leaderboard</h3>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={`${entry.rank}-${entry.studentName}`}
            className={`flex items-center gap-3 p-2 rounded-xl ${
              entry.isCurrentUser ? 'bg-primary/5 border border-primary/20' : ''
            }`}
          >
            <span className="w-6 text-center text-sm font-bold tabular-nums text-muted-foreground">
              {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : `#${entry.rank}`}
            </span>
            <span className="text-sm flex-1">
              {entry.studentName}
              {entry.isCurrentUser && (
                <Badge variant="secondary" className="ml-2 text-xs">You</Badge>
              )}
            </span>
            <span className="text-sm font-semibold tabular-nums">{entry.score}%</span>
          </div>
        ))}
      </div>
    </Card>
  )
}
