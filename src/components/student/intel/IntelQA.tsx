'use client'

import { useState, useMemo } from 'react'
import { Plus, Search, MessageCircleQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import { QuestionCard } from './QuestionCard'
import { AnswerCard } from './AnswerCard'
import { AnswerForm } from './AnswerForm'
import { AskQuestionDialog } from './AskQuestionDialog'
import { deleteContent, toggleAnswerVote } from '@/app/(dashboard)/student/courses/[sectionId]/intel/actions'
import { toast } from 'sonner'

interface QAAnswer {
  id: string
  body: string
  is_anonymous: boolean
  author_id?: string | null
  author_name?: string
  vote_count?: number
  created_at: string
  hasVoted?: boolean
  author?: { name?: string }
}

interface QAQuestion {
  id: string
  title: string
  body?: string
  is_anonymous: boolean
  author_id?: string | null
  answer_count: number
  created_at: string
  author?: { name?: string }
  author_name?: string
  loadedAnswers?: QAAnswer[]
}

interface IntelQAProps {
  questions: QAQuestion[]
  sectionId: string
  userId: string
  isAlumni: boolean
}

export function IntelQA({
  questions,
  sectionId,
  userId,
  isAlumni,
}: IntelQAProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  /* Deleting Intel content is a soft delete, but #733 is direct evidence that its
     consequences are not obvious to the author — a deleted review used to consume
     their one slot for the course permanently. And on mobile the trash sits beside
     the friendly Upvote control. So confirm, the way the professor-side deletes do. */
  const [pendingDelete, setPendingDelete] = useState<
    { table: 'course_questions' | 'course_answers'; id: string; answerCount?: number } | null
  >(null)
  /* Held through the await, not cleared before it: the action plus revalidation will
     cross the 400ms Doherty threshold often enough that closing the dialog first left
     the card sitting there unchanged, which reads as "it didn't work". */
  const [deleting, setDeleting] = useState(false)
  const filteredQuestions = useMemo(() => {
    if (!searchQuery.trim()) return questions
    const q = searchQuery.toLowerCase()
    return questions.filter(
      (question) =>
        question.title.toLowerCase().includes(q) ||
        (question.body && question.body.toLowerCase().includes(q))
    )
  }, [questions, searchQuery])

  const handleVote = async (answerId: string) => {
    const result = await toggleAnswerVote(answerId, sectionId)
    if ('error' in result && result.error) {
      toast.error(result.error)
    }
  }

  /* deleteContent existed and was correct but had no caller anywhere in the app
     (#735), so a student could never remove a question or answer they'd posted —
     the one content type most likely to need it. Mirrors IntelReviews.handleDelete;
     the action re-checks ownership server-side, so the isOwn conditional on the card
     is an affordance, not the boundary. */
  const confirmDelete = async () => {
    if (!pendingDelete) return
    const { table, id } = pendingDelete
    setDeleting(true)
    const result = await deleteContent(table, id, sectionId)
    setDeleting(false)
    setPendingDelete(null)
    if ('error' in result && result.error) toast.error(result.error)
    else toast.success(table === 'course_questions' ? 'Question deleted' : 'Answer deleted')
  }

  return (
    <div className="space-y-4">
      {/* Header: Search + Ask */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search questions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button
          size="sm"
          className="gap-1.5 shrink-0"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          Ask a Question
        </Button>
      </div>

      {/* Questions List */}
      {filteredQuestions.length > 0 ? (
        <AnimatedList className="space-y-4">
          {filteredQuestions.map((question) => {
            return (
              <AnimatedItem key={question.id}>
              <QuestionCard
                question={{
                  ...question,
                  author_name: question.author?.name || question.author_name,
                }}
                sectionId={sectionId}
                userId={userId}
                isAlumni={isAlumni}
                onDelete={() => setPendingDelete({ table: 'course_questions', id: question.id, answerCount: question.answer_count })}
              >
                {/* Answers arrive embedded with the question (#705). */}
                {question.loadedAnswers && question.loadedAnswers.length > 0 && (
                  <div className="space-y-2">
                    {question.loadedAnswers.map((answer) => (
                      <AnswerCard
                        key={answer.id}
                        answer={{
                          ...answer,
                          author_name: answer.author?.name || answer.author_name,
                        }}
                        hasVoted={answer.hasVoted ?? false}
                        onVote={() => handleVote(answer.id)}
                        isOwn={!!answer.author_id && answer.author_id === userId}
                        onDelete={() => setPendingDelete({ table: 'course_answers', id: answer.id })}
                      />
                    ))}
                  </div>
                )}

                {/* Answer Form for alumni */}
                {isAlumni && (
                  <AnswerForm
                    questionId={question.id}
                    sectionId={sectionId}
                    isAlumni={isAlumni}
                  />
                )}

                {/* Non-alumni notice */}
                {!isAlumni && (
                  <p className="text-xs text-muted-foreground py-2">
                    Complete this course to answer questions.
                  </p>
                )}
              </QuestionCard>
              </AnimatedItem>
            )
          })}
        </AnimatedList>
      ) : (
        <EmptyState
          variant={searchQuery ? 'default' : 'teaching'}
          icon={MessageCircleQuestion}
          title={searchQuery ? 'No matching questions' : 'No questions yet'}
          description={
            searchQuery
              ? 'Try a different search term or ask a new question.'
              : 'Be the first to ask a question about this course.'
          }
        />
      )}

      {/* Ask Question Dialog */}
      <AskQuestionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sectionId={sectionId}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => { if (!o && !deleting) setPendingDelete(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete your {pendingDelete?.table === 'course_answers' ? 'answer' : 'question'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/* A question is soft-deleted on its own row, but answers are fetched
                  embedded with their parent — so hiding a question takes every answer
                  under it out of view too. For a question other people answered, that is
                  the one consequence the author would want to know and could not guess.
                  answer_count is already in scope, so saying it is free. */}
              {pendingDelete?.table === 'course_questions' && (pendingDelete.answerCount ?? 0) > 0 ? (
                <>
                  It will be removed from this course&apos;s Q&amp;A for everyone, along with
                  the {pendingDelete.answerCount} answer
                  {pendingDelete.answerCount === 1 ? '' : 's'} other students wrote on it.
                  This can&apos;t be undone.
                </>
              ) : (
                <>
                  It will be removed from this course&apos;s Q&amp;A for everyone, along with any
                  votes it has collected. This can&apos;t be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void confirmDelete() }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
