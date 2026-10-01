/**
 * SubquestionCommentThread — the comment conversation for one rubric subquestion.
 *
 * Role-agnostic: the student side and the professor/TA side each bind their own server action
 * via `onPost`. Comment bodies render as PLAIN TEXT (whitespace-pre-wrap), never as HTML — this
 * is the single render point for user-authored text that crosses the student/staff boundary, so
 * it must not become a stored-XSS surface.
 *
 * Type: Client Component
 */
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { SubmissionCommentRow } from '@/lib/validations/assignment'

/** Server-action result shape both role sides return ({ error } | { success }). */
export type CommentPostResult = { error: string } | { success: true }

interface SubquestionCommentThreadProps {
  comments: SubmissionCommentRow[]
  /** When false, the thread is read-only (no composer). */
  canComment: boolean
  onPost: (body: string) => Promise<CommentPostResult>
}

function authorLabel(c: SubmissionCommentRow): string {
  if (c.author?.name) return c.author.name
  return c.author_role === 'staff' ? 'Course staff' : 'Student'
}

export function SubquestionCommentThread({ comments, canComment, onPost }: SubquestionCommentThreadProps) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [isPending, startTransition] = useTransition()

  function submit() {
    const text = body.trim()
    if (!text) return
    startTransition(async () => {
      const result = await onPost(text)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      setBody('')
      router.refresh()
    })
  }

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border bg-muted/40 p-3">
      {comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-xl bg-background p-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">{authorLabel(c)}</span>
                <Badge variant="secondary" className="text-[10px] capitalize">
                  {c.author_role === 'staff' ? 'Instructor' : 'You'}
                </Badge>
                <span className="ml-auto text-[10px] text-muted-foreground" suppressHydrationWarning>
                  {new Date(c.created_at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {canComment && (
        <div className="space-y-2 pt-1">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={5000}
            rows={2}
            placeholder="Add a comment about this question..."
            className="text-sm"
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={isPending || body.trim().length === 0}>
              {isPending ? 'Posting...' : 'Post comment'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
