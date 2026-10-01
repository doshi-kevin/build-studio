'use client'

import { useState, useEffect, useCallback, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardCheck, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { PageHeader } from '@/components/professor/PageHeader'
import { StudentQuizCard } from './StudentQuizCard'
import {
  getPublishedQuizzes,
  getMyAttempts,
  startAttempt,
} from '@/app/(dashboard)/student/courses/[sectionId]/quizzes/actions'
import type { Quiz, QuizAttempt } from '@/lib/validations/quiz'
import { enterFullscreen } from '@/lib/quiz/fullscreen'
import { isPastDue } from '@/lib/quiz/utils'

interface StudentQuizListProps {
  sectionId: string
}

type QuizFilter = 'all' | 'available' | 'in_progress' | 'completed'

function getQuizFilterState(quiz: Quiz, attempts: QuizAttempt[]): Exclude<QuizFilter, 'all'> | 'missed' {
  if (attempts.some((a) => a.status === 'in_progress')) return 'in_progress'
  if (attempts.some((a) => a.status === 'submitted')) return 'completed'
  // Matches StudentQuizCard's getQuizState(): an unattempted quiz past its due
  // date can no longer be started (the server rejects it), so it isn't
  // "available" — it only shows under the All tab, same as a missed assignment
  // isn't filed under a working-toward-it bucket either. Same isPastDue call as
  // the card, so the Available tab and the card badge cannot disagree (#311).
  if (isPastDue(quiz.dueDate)) return 'missed'
  return 'available'
}

export function StudentQuizList({ sectionId }: StudentQuizListProps) {
  const router = useRouter()
  const [quizzes, setQuizzes] = useState<Quiz[]>([])
  const [attemptsMap, setAttemptsMap] = useState<Record<string, QuizAttempt[]>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<QuizFilter>('all')
  const [loaded, setLoaded] = useState(false)
  const [, startTransition] = useTransition()

  useEffect(() => {
    async function load() {
      try {
        const quizResult = await getPublishedQuizzes(sectionId)
        if (quizResult.error) {
          toast.error(quizResult.error)
        }
        const allQuizzes: Quiz[] = quizResult.data || []
        setQuizzes(allQuizzes)

        const map: Record<string, QuizAttempt[]> = {}
        const attemptResults = await Promise.all(
          allQuizzes.map((quiz) => getMyAttempts(sectionId, quiz.id)),
        )
        for (let i = 0; i < allQuizzes.length; i++) {
          map[allQuizzes[i].id] = attemptResults[i].data || []
        }
        setAttemptsMap(map)
      } catch {
        toast.error('Failed to load quizzes. Please refresh the page.')
      } finally {
        setLoaded(true)
      }
    }
    load()
  }, [sectionId])

  const handleStart = useCallback(
    (quiz: Quiz) => {
      // Enter fullscreen straight from this click gesture (browsers only allow
      // it from a gesture). It persists across the SPA navigation into the
      // player, so the quiz opens fullscreen with no extra prompt.
      enterFullscreen().catch(() => {})
      // Adaptive (CCAT) quizzes use the server-driven single-item player which
      // creates/resumes the attempt itself — route straight to it.
      if (quiz.adaptiveMode) {
        router.push(`/student/courses/${sectionId}/quizzes/${quiz.id}/adaptive`)
        return
      }
      // Route to detail page for proctored quizzes so the acknowledgment dialog shows
      if (quiz.proctoringEnabled) {
        router.push(`/student/courses/${sectionId}/quizzes/${quiz.id}`)
        return
      }
      startTransition(async () => {
        const result = await startAttempt(sectionId, quiz.id)
        if (result.error) {
          toast.error(result.error)
          return
        }
        if (result.data) {
          router.push(
            `/student/courses/${sectionId}/quizzes/${quiz.id}/attempt/${result.data.id}`,
          )
        }
      })
    },
    [sectionId, router],
  )

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return quizzes.filter((quiz) => {
      const matchesSearch = !q || quiz.title.toLowerCase().includes(q)
      const matchesFilter =
        filter === 'all' || getQuizFilterState(quiz, attemptsMap[quiz.id] ?? []) === filter
      return matchesSearch && matchesFilter
    })
  }, [quizzes, attemptsMap, searchQuery, filter])

  const description = 'Take quizzes assigned by your instructor.'

  if (!loaded) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40 rounded-xl" />
          <Skeleton className="h-4 w-64 rounded-full" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-9 flex-1 rounded-xl" />
          <Skeleton className="h-9 w-44 rounded-xl" />
        </div>
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[104px] w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (quizzes.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Quizzes" description={description} />
        <EmptyState
          variant="teaching"
          icon={ClipboardCheck}
          title="No quizzes available yet"
          description="Your instructor hasn't published any quizzes for this course. New quizzes will show up here as soon as they're assigned."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Quizzes" description={description} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search quizzes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v as QuizFilter)}
          variant="outline"
          size="sm"
          className="shrink-0"
        >
          <ToggleGroupItem value="all" aria-label="All quizzes">All</ToggleGroupItem>
          <ToggleGroupItem value="available" aria-label="Available quizzes">Available</ToggleGroupItem>
          <ToggleGroupItem value="in_progress" aria-label="In-progress quizzes">In Progress</ToggleGroupItem>
          <ToggleGroupItem value="completed" aria-label="Completed quizzes">Completed</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No quizzes match your filters.
        </p>
      ) : (
        <AnimatedList className="grid gap-3">
          {filtered.map((quiz) => (
            <AnimatedItem key={quiz.id}>
              <StudentQuizCard
                quiz={quiz}
                attempts={attemptsMap[quiz.id] ?? []}
                onStart={() => handleStart(quiz)}
                onResume={(attemptId) => {
                  // Enter fullscreen from the click gesture (persists across nav).
                  enterFullscreen().catch(() => {})
                  /* Adaptive FIRST, mirroring handleStart's precedence above. Resume had no
                     adaptive branch at all, so an in-progress adaptive attempt routed to the
                     LINEAR /attempt/<id> player, which refuses it and bounces back to this
                     list telling the student to open it from the quiz list to start. That
                     instruction is a loop: this list is where they just clicked, and it shows
                     Resume, not Start. So a student part-way through an adaptive quiz could not
                     get back in at all.

                     The /adaptive route creates or resumes the attempt itself, which is why it
                     takes no attemptId. Order matters: an adaptive AND proctored quiz has to go
                     here, not to the detail page, which is what handleStart already does. */
                  if (quiz.adaptiveMode) {
                    router.push(`/student/courses/${sectionId}/quizzes/${quiz.id}/adaptive`)
                  } else if (quiz.proctoringEnabled) {
                    router.push(`/student/courses/${sectionId}/quizzes/${quiz.id}`)
                  } else {
                    router.push(
                      `/student/courses/${sectionId}/quizzes/${quiz.id}/attempt/${attemptId}`,
                    )
                  }
                }}
                onViewResults={(attemptId) =>
                  router.push(
                    `/student/courses/${sectionId}/quizzes/${quiz.id}/results/${attemptId}`,
                  )
                }
              />
            </AnimatedItem>
          ))}
        </AnimatedList>
      )}
    </div>
  )
}
