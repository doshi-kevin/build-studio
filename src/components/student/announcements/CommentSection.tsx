/**
 * CommentSection — comment thread for an announcement.
 *
 * Displays comments with author info and relative timestamps.
 * Text input for posting new comments. Delete button for own comments.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useTransition } from 'react'
import { MessageSquare, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  createComment,
  deleteComment,
  getAnnouncementComments,
} from '@/app/(dashboard)/student/courses/[sectionId]/announcements/actions'

interface Comment {
  id: string
  content: string
  created_at: string
  author_id: string
  author: { id: string; name: string | null; email: string } | null
}

interface CommentSectionProps {
  announcementId: string
  sectionId: string
  currentUserId: string
}

export function CommentSection({ announcementId, sectionId, currentUserId }: CommentSectionProps) {
  const [comments, setComments] = useState<Comment[]>([])
  const [newComment, setNewComment] = useState('')
  const [isPosting, startPostTransition] = useTransition()
  const [isDeleting, startDeleteTransition] = useTransition()

  useEffect(() => {
    getAnnouncementComments(announcementId, sectionId).then((result) => {
      if (result.data) setComments(result.data as Comment[])
    })
  }, [announcementId, sectionId])

  const handlePost = () => {
    const content = newComment.trim()
    if (!content) return

    setNewComment('')
    startPostTransition(async () => {
      const result = await createComment(announcementId, sectionId, content)
      if (result.error) {
        toast.error(result.error)
        setNewComment(content) // Restore on error
        return
      }
      // Refetch to get the new comment with author info
      const fresh = await getAnnouncementComments(announcementId, sectionId)
      if (fresh.data) setComments(fresh.data as Comment[])
    })
  }

  const handleDelete = (commentId: string) => {
    startDeleteTransition(async () => {
      const result = await deleteComment(commentId, announcementId, sectionId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      setComments((prev) => prev.filter((c) => c.id !== commentId))
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <MessageSquare className="h-4 w-4" />
        Comments ({comments.length})
      </div>

      {/* Comment list */}
      {comments.length > 0 && (
        <div className="space-y-3">
          {comments.map((comment) => (
            <div key={comment.id} className="flex gap-3 group">
              {/* Avatar placeholder */}
              <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
                {(comment.author?.name || comment.author?.email || '?')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {comment.author?.name || comment.author?.email || 'Unknown'}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })}
                  </span>
                  {comment.author_id === currentUserId && (
                    /* Always visible on touch, hover-revealed from sm: up (#669). It was
                       `opacity-0 group-hover:opacity-100`, and a touch device has no
                       hover — so on a phone a student could not delete their own comment
                       at all. focus-visible keeps it reachable by keyboard on desktop,
                       where the hover treatment is retained. */
                    <button
                      onClick={() => handleDelete(comment.id)}
                      disabled={isDeleting}
                      className="p-0.5 rounded-xl text-muted-foreground hover:text-destructive transition-opacity opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                      title="Delete comment"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <p className="text-sm text-foreground mt-0.5">{comment.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New comment input */}
      <div className="flex gap-2">
        <Input
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Write a comment..."
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handlePost()
            }
          }}
          maxLength={2000}
        />
        <Button
          size="sm"
          onClick={handlePost}
          disabled={isPosting || !newComment.trim()}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
