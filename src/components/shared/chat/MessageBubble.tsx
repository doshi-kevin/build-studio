/**
 * Shared MessageBubble — iMessage-style chat bubble used by both project chat
 * and course-level discussions. Own messages sit on the right as an outlined
 * card on the background; others sit left as a filled muted chip. Images
 * open in a large in-page lightbox dialog (no new tab hop).
 */
'use client'

import { useState } from 'react'
import {
  FileText,
  Download,
  Music,
  Film,
  Loader2,
  MoreHorizontal,
  Trash2,
} from 'lucide-react'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { formatFileSize } from '@/lib/supabase/storage'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useChatAttachmentUrl } from '@/lib/chat/signed-urls'
import { ReactionBar, type ReactionSummary } from '@/components/shared/chat/ReactionBar'

export interface MessageAuthor {
  id: string
  name: string | null
  email: string
  avatar_url: string | null
}

export interface ChatMessageData {
  id: string
  channel_id: string
  author_id: string
  content: string
  attachment_url: string | null
  attachment_path: string | null
  attachment_name: string | null
  attachment_size: number | null
  attachment_type: string | null
  created_at: string
  deleted_at?: string | null
  deleted_by_id?: string | null
  author?: MessageAuthor
}

interface MessageBubbleProps {
  message: ChatMessageData
  isOwn: boolean
  showAuthor: boolean
  /** Whether the current viewer can delete this message (author, or staff
   * moderator in a course discussion). When true, a hover "•••" menu
   * exposes Delete. Deletion is soft — the row stays and renders as a
   * "This message was deleted" tombstone for everyone. */
  canDelete?: boolean
  /** Fires when the user confirms delete. Receives the message id. The
   * parent is responsible for calling the appropriate server action and
   * flipping the optimistic `deleted_at` flag. */
  onDelete?: (messageId: string) => void | Promise<void>
  /** Aggregated reactions for this message. */
  reactions?: ReactionSummary[]
  /** Toggle a reaction emoji on this message. */
  onReactionToggle?: (messageId: string, emoji: string) => void
}

export function MessageBubble({
  message,
  isOwn,
  showAuthor,
  canDelete = false,
  onDelete,
  reactions,
  onReactionToggle,
}: MessageBubbleProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isDeleted = !!message.deleted_at

  const handleConfirmDelete = async () => {
    if (!onDelete || deleting) return
    setDeleting(true)
    try {
      await onDelete(message.id)
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  // Attachments live in the private chat-attachments bucket, so whenever a
  // row carries an `attachment_path` we mint a fresh signed URL per-view and
  // PREFER it over any stored `attachment_url`. Stored URLs are either an
  // optimistic-preview URL (brand-new send, signed URL not minted yet) or a
  // legacy/expired signed URL — preferring the freshly-minted one fixes both
  // older messages whose stored URL has expired and keeps instant preview
  // working (we fall back to the stored URL until the fresh one resolves).
  const needsSignedUrl = !!message.attachment_path
  const signedUrl = useChatAttachmentUrl(needsSignedUrl ? message.attachment_path : null)
  const resolvedAttachmentUrl = signedUrl || message.attachment_url
  // Only show the loading state when there's nothing to display yet — if a
  // stored URL is present (optimistic preview) we render it immediately.
  const attachmentLoading = needsSignedUrl && !signedUrl && !message.attachment_url

  const authorName = message.author?.name || message.author?.email || 'Unknown'
  const initials = authorName.slice(0, 2).toUpperCase()
  const isImage = message.attachment_type?.startsWith('image/')
  const isAudio = message.attachment_type?.startsWith('audio/')
  const isVideo = message.attachment_type?.startsWith('video/')
  const hasAttachment = !!(message.attachment_url || message.attachment_path)
  const timeLabel = format(new Date(message.created_at), 'h:mm a')

  return (
    <div
      className={cn(
        'group flex gap-2 mb-1',
        isOwn ? 'justify-end' : 'justify-start',
        showAuthor && !isOwn ? 'mt-3' : '',
        showAuthor && isOwn ? 'mt-2' : '',
      )}
    >
      {/* Avatar — only for others, only on first message in group */}
      {!isOwn && showAuthor && (
        <div className="shrink-0 mt-0.5 w-7">
          {message.author?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={message.author.avatar_url}
              alt={authorName}
              className="h-7 w-7 rounded-full object-cover"
            />
          ) : (
            <div className="h-7 w-7 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-[10px] font-semibold">
              {initials}
            </div>
          )}
        </div>
      )}

      {/* Spacer for non-first messages from others (align with avatar) */}
      {!isOwn && !showAuthor && <div className="w-7 shrink-0" />}

      {/* Own-message delete trigger — sits to the LEFT of the bubble, so
          it hovers between the bubble column and the right edge of the
          feed. Only visible on hover when the viewer can delete. */}
      {isOwn && canDelete && !isDeleted && (
        <div className="self-center shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-50 transition-opacity">
          <DeleteMenu onSelect={() => setConfirmDelete(true)} />
        </div>
      )}

      {/* Bubble column.
          `items-end`/`items-start` overrode the default align-items: stretch, so the
          message div sized to max-content and a long unbroken run (a pasted block, a
          210-char URL) escaped the column's max-w-[75%] and was clipped unreadably —
          `wrap-break-word` on the text could not help, because the BOX was already wider
          than its container (#680). Alignment moves to `self-*` on the children below, so
          the bubble still hugs its side while the column keeps constraining width. */}
      <div className="max-w-[75%] min-w-0 flex flex-col">
        {/* Author name — only first message in group, others only */}
        {showAuthor && !isOwn && (
          <div className="mb-0.5 px-1">
            <span className="text-xs font-semibold text-foreground">{authorName}</span>
          </div>
        )}

        {isDeleted ? (
          <div
            className={cn(
              'px-3 py-1.5 rounded-2xl text-sm italic text-muted-foreground border border-dashed border-border bg-muted/30 max-w-full',
              isOwn ? 'rounded-br-md self-end' : 'rounded-bl-md self-start',
            )}
          >
            This message was deleted
            <span className="ml-2 text-[10px] align-bottom select-none not-italic">
              {timeLabel}
            </span>
          </div>
        ) : (
          <>
            {/* Attachment — rendered above the text so media reads first */}
            {hasAttachment && (
              <div className={cn(message.content ? 'mb-1' : '', 'w-full flex', isOwn ? 'justify-end' : 'justify-start')}>
                <div>
                  {attachmentLoading || !resolvedAttachmentUrl ? (
                    <div
                      className={cn(
                        'flex items-center gap-2 border rounded-xl px-3 py-2 max-w-xs bg-muted/40 text-muted-foreground',
                      )}
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                      <span className="text-xs truncate">
                        {message.attachment_name || 'Loading attachment…'}
                      </span>
                    </div>
                  ) : isImage ? (
                    <button
                      type="button"
                      onClick={() => setLightboxOpen(true)}
                      className="block rounded-xl overflow-hidden"
                      aria-label={`Preview ${message.attachment_name || 'image'}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={resolvedAttachmentUrl}
                        alt={message.attachment_name || 'Image'}
                        className="max-w-xs max-h-64 rounded-xl object-cover cursor-pointer hover:opacity-90 transition-opacity"
                      />
                    </button>
                  ) : (
                    <AttachmentCard
                      url={resolvedAttachmentUrl}
                      name={message.attachment_name}
                      size={message.attachment_size}
                      isAudio={!!isAudio}
                      isVideo={!!isVideo}
                      isOwn={isOwn}
                    />
                  )}
                  {/* Time below attachment-only messages */}
                  {!message.content && (
                    <div className={cn('mt-0.5 px-1', isOwn ? 'text-right' : 'text-left')}>
                      <span className="text-[10px] text-muted-foreground">{timeLabel}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Text bubble — time inlined bottom-right like WhatsApp.
                Subtle differentiation: own renders as an outlined card on the
                background canvas; others render as a filled muted chip. Both
                stay monochrome and low-contrast. */}
            {message.content && (
              <div
                className={cn(
                  'px-3 py-1.5 rounded-2xl text-sm whitespace-pre-wrap wrap-break-word text-foreground max-w-full',
                  isOwn ? 'self-end' : 'self-start',
                  isOwn
                    ? 'bg-background border border-border rounded-br-md'
                    : 'bg-muted rounded-bl-md',
                )}
              >
                {message.content}
                <span className="ml-2 text-[10px] align-bottom select-none text-muted-foreground">
                  {timeLabel}
                </span>
              </div>
            )}

            {/* Reactions */}
            {onReactionToggle && (
              <div className={cn('px-1', isOwn ? 'flex justify-end' : '')}>
                <ReactionBar
                  reactions={reactions || []}
                  onToggle={(emoji) => onReactionToggle(message.id, emoji)}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Others'-message delete trigger — sits to the RIGHT of the bubble.
          Shown when a staff moderator can clear a peer's message. */}
      {!isOwn && canDelete && !isDeleted && (
        <div className="self-center shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-50 transition-opacity">
          <DeleteMenu onSelect={() => setConfirmDelete(true)} />
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this message?</AlertDialogTitle>
            <AlertDialogDescription>
              The message body and any attachment will be hidden for everyone in
              this conversation. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleConfirmDelete()
              }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Image lightbox — opens on thumbnail click */}
      {!isDeleted && isImage && resolvedAttachmentUrl && (
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent
            className="max-w-[96vw] sm:max-w-[92vw] md:max-w-[88vw] w-[96vw] p-0 bg-background border-border"
            showCloseButton
          >
            <DialogTitle className="sr-only">
              {message.attachment_name || 'Image preview'}
            </DialogTitle>
            <div className="flex items-center justify-center bg-muted/30 p-2 sm:p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolvedAttachmentUrl}
                alt={message.attachment_name || 'Image'}
                className="max-h-[88vh] max-w-full object-contain rounded-lg"
              />
            </div>
            {message.attachment_name && (
              <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-4">
                <span className="text-xs text-muted-foreground truncate">
                  {message.attachment_name}
                </span>
                <a
                  href={resolvedAttachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-foreground hover:underline shrink-0"
                >
                  Open original
                </a>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ── Hover "•••" menu for destructive actions ─────────────────────

function DeleteMenu({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Message actions"
              // 44x44 hit target (Fitts) — outer button is 11×4 = 44px,
              // inner glyph stays visually small via the absolutely
              // positioned inner span, so the bubble layout doesn't shift.
              className="relative h-11 w-11 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Message actions
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            onSelect()
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Attachment card for non-image files ──────────────────────────

function AttachmentCard({
  url,
  name,
  size,
  isAudio,
  isVideo,
  isOwn,
}: {
  url: string
  name: string | null
  size: number | null
  isAudio: boolean
  isVideo: boolean
  isOwn: boolean
}) {
  const Icon = isAudio ? Music : isVideo ? Film : FileText

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex items-center gap-2 border rounded-xl px-3 py-2 max-w-xs transition-colors',
        isOwn
          ? 'bg-foreground/5 border-foreground/10 hover:bg-foreground/10 ml-auto'
          : 'bg-muted/50 hover:bg-muted',
      )}
    >
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate">{name}</p>
        {size && (
          <p className="text-[10px] text-muted-foreground">
            {formatFileSize(size)}
          </p>
        )}
      </div>
      <Download className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    </a>
  )
}
