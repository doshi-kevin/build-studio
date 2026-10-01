// Quiz list view with search, create, and delete. "Create quiz" navigates
// straight to the editor — every build method (manual, AI, bank, JSON) lives there.

'use client'

import { useState, useEffect, useCallback, useTransition, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Search, ClipboardCheck, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { QuizCard } from './QuizCard'
import { DeleteQuizDialog } from './DeleteQuizDialog'
import {
  getQuizzes,
  deleteQuiz,
  getQuizSubmissionCounts,
  getOrCreateEmptyDraft,
} from '@/app/(dashboard)/professor/courses/[sectionId]/quizzes/actions'
import type { Quiz } from '@/lib/validations/quiz'

interface QuizListProps {
  sectionId: string
}

type StatusFilter = 'all' | 'published' | 'draft'

export function QuizList({ sectionId }: QuizListProps) {
  const router = useRouter()
  const [quizzes, setQuizzes] = useState<Quiz[]>([])
  const [submissionCounts, setSubmissionCounts] = useState<Record<string, { submitted: number; inProgress: number }>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [deletingQuiz, setDeletingQuiz] = useState<Quiz | null>(null)
  const [loading, setLoading] = useState(true)
  /* Whether the viewer is the professor, resolved server-side alongside the list
     (#749). Starts true as the FAIL-SAFE direction: a stale flag should over-show
     controls the server then refuses, never hide a professor's own. (No card renders
     before the first fetch anyway — `loading` gates the list — so this isn't about
     flicker.) */
  const [canWriteProfessor, setCanWriteProfessor] = useState(true)
  /* "Create quiz" is canWriteAsStaff (professor or TA), so a grader was being offered a
     button the action refuses. Same fail-safe default as above. */
  const [canCreate, setCanCreate] = useState(true)
  // startTransition drives background list refetches + delete; its pending flag
  // isn't surfaced (Create has its own isCreating cue below).
  const [, startTransition] = useTransition()
  // Dedicated to "Create quiz" so the button's progress cue doesn't light up
  // during unrelated list refetches (which share `isPending`). The create now
  // runs a server mutation BEFORE navigating, so the CTA must show progress.
  const [isCreating, startCreateTransition] = useTransition()

  // Create (or reuse an empty) draft server-side, then go straight to its
  // editor — no /quizzes/new hop, and the mutation stays on an explicit click
  // (not a GET navigation). The one-shot "just created" intent (open the setup
  // spotlight) rides in sessionStorage, NOT the URL: the editor consumes it on
  // mount, so the address bar is clean from the first paint — no ?new=1 to flash
  // and then strip.
  const handleCreate = useCallback(
    () => {
      startCreateTransition(async () => {
        const res = await getOrCreateEmptyDraft(sectionId)
        if (res.error || !res.data) {
          toast.error(res.error || 'Could not start a new quiz. Please try again.')
          return
        }
        try {
          sessionStorage.setItem(`quiz-intent:${res.data.id}`, 'setup')
        } catch {
          // sessionStorage unavailable (private mode / quota) — the editor just
          // opens without the spotlight; not worth failing the create over.
        }
        router.push(`/professor/courses/${sectionId}/quizzes/${res.data.id}`)
      })
    },
    [sectionId, router],
  )

  // The dashboard's "Create a Quiz" quick action (?action=create) used to be
  // handled here client-side, racing this list's own mount-time refetch() —
  // see the quizzes list page.tsx, which now resolves that deep link
  // server-side (redirect, before this component ever mounts) instead.

  // Re-fetch the list + submission counts. Passed to QuizCard as `onChanged`
  // so mutations (duplicate, publish, unpublish) refresh the list — router.refresh()
  // alone doesn't, because this data is fetched client-side in useState, not via
  // server-component props.
  const refetch = useCallback(() => {
    startTransition(async () => {
      const [result, countsResult] = await Promise.all([
        getQuizzes(sectionId),
        getQuizSubmissionCounts(sectionId),
      ])
      if (result.error) {
        toast.error(result.error)
      }
      if (typeof result.canWriteProfessor === 'boolean') setCanWriteProfessor(result.canWriteProfessor)
      if (typeof result.canCreate === 'boolean') setCanCreate(result.canCreate)
      // Hide brand-new empty drafts — a "Create quiz" click reuses/creates an
      // "Untitled quiz" row up front (so the editor has a real /quizzes/{id}
      // URL). Until it gets a name, description, or a question it's just a
      // placeholder and shouldn't clutter the list; it stays in the DB and is
      // reused on the next click.
      const visible = (result.data || []).filter(
        (q) =>
          !(
            q.status === 'draft' &&
            q.title === 'Untitled quiz' &&
            !q.description?.trim() &&
            q.questionIds.length === 0
          ),
      )
      setQuizzes(visible)
      setSubmissionCounts(countsResult.data || {})
      setLoading(false)
    })
  }, [sectionId])

  useEffect(() => {
    refetch()
  }, [refetch])

  const handleDelete = useCallback(() => {
    if (!deletingQuiz) return
    startTransition(async () => {
      const result = await deleteQuiz(sectionId, deletingQuiz.id)
      if (result.error) {
        toast.error(result.error)
        return
      }
      setQuizzes((prev) => prev.filter((q) => q.id !== deletingQuiz.id))
      toast.success('Quiz deleted')
      setDeletingQuiz(null)
    })
  }, [deletingQuiz, sectionId])

  const publishedCount = useMemo(() => quizzes.filter((q) => q.status === 'published').length, [quizzes])
  const totalSubmissions = useMemo(
    () => Object.values(submissionCounts).reduce((sum, c) => sum + (c?.submitted ?? 0), 0),
    [submissionCounts],
  )

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return quizzes.filter((quiz) => {
      const matchesStatus = statusFilter === 'all' || quiz.status === statusFilter
      const matchesSearch = !q || quiz.title.toLowerCase().includes(q)
      return matchesStatus && matchesSearch
    })
  }, [quizzes, searchQuery, statusFilter])

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex gap-3">
          <Skeleton className="h-9 flex-1 rounded-xl" />
          <Skeleton className="h-9 w-28 rounded-xl" />
        </div>
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-22 w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (quizzes.length === 0) {
    return (
      <EmptyState
        variant="teaching"
        icon={ClipboardCheck}
        title="Build your first quiz"
        description="Write questions yourself, pull from your question bank, or have Athena generate them from your lecture material — then publish to students."
      >
        {/* A grader can't create, so offering the button would be the refused-control
            pattern again — and an EmptyState whose only action is unavailable needs to
            say why rather than just losing its CTA. */}
        {canCreate ? (
          <Button onClick={() => handleCreate()} disabled={isCreating}>
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {isCreating ? 'Creating…' : 'Create quiz'}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            The professor hasn&apos;t added any quizzes to this section yet.
          </p>
        )}
      </EmptyState>
    )
  }

  const summary = [
    `${quizzes.length} quiz${quizzes.length !== 1 ? 'zes' : ''}`,
    `${publishedCount} published`,
    `${totalSubmissions} submission${totalSubmissions !== 1 ? 's' : ''}`,
  ].join('  ·  ')

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search quizzes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <ToggleGroup
          type="single"
          value={statusFilter}
          onValueChange={(v) => v && setStatusFilter(v as StatusFilter)}
          variant="outline"
          size="sm"
          className="shrink-0"
        >
          <ToggleGroupItem value="all" aria-label="All quizzes">All</ToggleGroupItem>
          <ToggleGroupItem value="published" aria-label="Published quizzes">Published</ToggleGroupItem>
          <ToggleGroupItem value="draft" aria-label="Draft quizzes">Drafts</ToggleGroupItem>
        </ToggleGroup>
        {canCreate && (
          <Button onClick={() => handleCreate()} disabled={isCreating} className="shrink-0">
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {isCreating ? 'Creating…' : 'Create quiz'}
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground tabular-nums">{summary}</p>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No quizzes match your filters.
        </p>
      ) : (
        <AnimatedList className="grid gap-3">
          {filtered.map((quiz) => (
            <AnimatedItem key={quiz.id}>
              <QuizCard
                quiz={quiz}
                sectionId={sectionId}
                submissionCount={submissionCounts[quiz.id]?.submitted ?? 0}
                onDelete={() => setDeletingQuiz(quiz)}
                onChanged={refetch}
                canWriteProfessor={canWriteProfessor}
              />
            </AnimatedItem>
          ))}
        </AnimatedList>
      )}

      <DeleteQuizDialog
        open={!!deletingQuiz}
        onOpenChange={(open) => { if (!open) setDeletingQuiz(null) }}
        quizTitle={deletingQuiz?.title ?? ''}
        onConfirm={handleDelete}
      />
    </div>
  )
}
