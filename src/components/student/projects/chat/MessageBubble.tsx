/**
 * MessageBubble — Chat bubble with iMessage-style layout.
 *
 * Own messages: right-aligned, primary-colored bubble, no avatar.
 * Others' messages: left-aligned, muted bubble, avatar + name on first in group.
 * Timestamps show exact time (e.g. "2:34 PM") on every message.
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
import type { ChatMessage } from '@/lib/chat/hooks'
import { SystemMessageLine } from '@/components/student/projects/chat/SystemMessageLine'
import { PhaseMentionChip } from '@/components/student/projects/chat/PhaseMentionChip'
import { DocMentionChip } from '@/components/student/projects/chat/DocMentionChip'
import { useChatAttachmentUrl } from '@/lib/chat/signed-urls'
import { ReactionBar, type ReactionSummary } from '@/components/shared/chat/ReactionBar'
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

interface MessageBubbleProps {
  message: ChatMessage
  isOwn: boolean
  showAuthor: boolean
  // Current viewer's user id, so we can emphasize messages where the
  // viewer was @-mentioned.
  currentUserId?: string
  // Section id is needed by the @phase and @doc chips' hover-card lookups.
  sectionId?: string
  // Map of phase id → title for the team. Used to identify which
  // `@token` substrings in the body refer to a phase mention.
  phaseTitles?: Record<string, string>
  // Same shape for docs — used to identify @doc substrings in the body.
  docTitles?: Record<string, string>
  // When true, the viewer (author or team lead) can soft-delete this
  // message. Triggers the hover "•••" menu next to the bubble.
  canDelete?: boolean
  // Fires after the user confirms delete. Receives the message id —
  // parent calls the server action and flips the optimistic flag.
  onDelete?: (messageId: string) => void | Promise<void>
  reactions?: ReactionSummary[]
  onReactionToggle?: (messageId: string, emoji: string) => void
}

// Renders the message body with inline @mention pills.
//
// Matches `@token` only when `@` sits at the start of the string or
// after whitespace — keeps email addresses (`foo@bar.com`) plain. For
// each candidate, we first try to match the longest leading phase or
// doc title (interleaved and sorted by display length DESC, so
// multi-word titles like "Research Plan" stay intact); failing that
// we fall back to a single word-token user pill so user mentions
// don't lose their highlight.
type EntityKind = 'phase' | 'doc'
interface EntityCandidate {
  kind: EntityKind
  id: string
  display: string
}

function renderContentWithMentions(
  content: string,
  isSelfMention: boolean,
  mentionedPhaseIds: string[],
  mentionedDocIds: string[],
  phaseTitles: Record<string, string>,
  docTitles: Record<string, string>,
  sectionId?: string,
): React.ReactNode {
  if (!content) return null

  // Build the list of entity candidates we should look for in this
  // message. For each mentioned entity we register two display forms:
  // the bare title, and the disambiguation form `Title (xxxx)` that
  // ChatInput inserts when two titles collide. Sorted by display
  // length DESC across BOTH kinds so longer forms win ("Plan (a1b2)"
  // beats "Plan", and "Sprint One Plan" beats "Sprint One") regardless
  // of whether it's a phase or a doc.
  const entityCandidates: EntityCandidate[] = [
    ...mentionedPhaseIds
      .filter((id) => !!phaseTitles[id])
      .flatMap<EntityCandidate>((id) => {
        const title = phaseTitles[id]
        return [
          { kind: 'phase', id, display: `${title} (${id.slice(0, 4)})` },
          { kind: 'phase', id, display: title },
        ]
      }),
    ...mentionedDocIds
      .filter((id) => !!docTitles[id])
      .flatMap<EntityCandidate>((id) => {
        const title = docTitles[id]
        return [
          { kind: 'doc', id, display: `${title} (${id.slice(0, 4)})` },
          { kind: 'doc', id, display: title },
        ]
      }),
  ].sort((a, b) => b.display.length - a.display.length)

  const parts: React.ReactNode[] = []
  let i = 0
  let key = 0
  let plainStart = 0

  const flushPlain = (until: number) => {
    if (until > plainStart) {
      parts.push(content.slice(plainStart, until))
    }
  }

  while (i < content.length) {
    const ch = content[i]
    const prev = i === 0 ? ' ' : content[i - 1]
    if (ch === '@' && (i === 0 || /\s/.test(prev))) {
      // Try to match an entity (phase or doc) display string first.
      const remainder = content.slice(i + 1)
      let matchedEntity: EntityCandidate | null = null
      for (const cand of entityCandidates) {
        if (remainder.startsWith(cand.display)) {
          // Boundary check: must be followed by EOL/space/punct so we
          // don't slice in the middle of a longer word.
          const nextChar = remainder[cand.display.length]
          if (
            nextChar === undefined ||
            /\s/.test(nextChar) ||
            /[.,!?;:]/.test(nextChar)
          ) {
            matchedEntity = cand
            break
          }
        }
      }

      if (matchedEntity) {
        flushPlain(i)
        if (matchedEntity.kind === 'phase') {
          parts.push(
            <PhaseMentionChip
              key={`p-${key++}`}
              phaseId={matchedEntity.id}
              label={`@${matchedEntity.display}`}
              sectionId={sectionId ?? ''}
            />,
          )
        } else {
          parts.push(
            <DocMentionChip
              key={`d-${key++}`}
              docId={matchedEntity.id}
              label={`@${matchedEntity.display}`}
              sectionId={sectionId ?? ''}
            />,
          )
        }
        i += 1 + matchedEntity.display.length
        plainStart = i
        continue
      }

      // Fall back to a single-word user mention pill.
      const userMatch = /^@[^\s,.!?;:]+/.exec(content.slice(i))
      if (userMatch) {
        flushPlain(i)
        // Mentions are just bold text — no pill background. Self-mentions
        // get slightly heavier weight so they still pop in a busy feed.
        const pillClass = isSelfMention
          ? 'font-bold text-foreground'
          : 'font-semibold text-foreground'
        parts.push(
          <span key={`m-${key++}`} className={pillClass}>
            {userMatch[0]}
          </span>,
        )
        i += userMatch[0].length
        plainStart = i
        continue
      }
    }
    i++
  }
  flushPlain(content.length)
  return parts
}

export function MessageBubble({
  message,
  isOwn,
  showAuthor,
  currentUserId,
  sectionId,
  phaseTitles,
  docTitles,
  canDelete = false,
  onDelete,
  reactions,
  onReactionToggle,
}: MessageBubbleProps) {
  // New uploads go to the private chat-attachments bucket and carry a
  // path only — the signed URL is minted per-view. Legacy messages
  // stored a public URL directly, so we fall back to that if present.
  const needsSignedUrl = !message.attachment_url && !!message.attachment_path
  const signedUrl = useChatAttachmentUrl(needsSignedUrl ? message.attachment_path : null)
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

  // Short-circuit for inline system messages — centered text line, no bubble.
  if (message.kind === 'system') {
    return <SystemMessageLine message={message} />
  }

  const authorName = message.author?.name || message.author?.email || 'Unknown'
  const initials = authorName.slice(0, 2).toUpperCase()
  const isImage = message.attachment_type?.startsWith('image/')
  const isAudio = message.attachment_type?.startsWith('audio/')
  const isVideo = message.attachment_type?.startsWith('video/')
  const resolvedAttachmentUrl = message.attachment_url || signedUrl
  const hasAttachment = !!(message.attachment_url || message.attachment_path)
  const attachmentLoading = needsSignedUrl && !signedUrl
  const isSelfMention =
    !!currentUserId && (message.mentioned_user_ids ?? []).includes(currentUserId)

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

      {/* Own-message delete trigger — to the LEFT of the bubble column. */}
      {isOwn && canDelete && !isDeleted && (
        <div className="self-center shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-50 transition-opacity">
          <TeamDeleteMenu onSelect={() => setConfirmDelete(true)} />
        </div>
      )}

      {/* Bubble */}
      <div className={cn('max-w-[68%] min-w-0 flex flex-col', isOwn ? 'items-end' : 'items-start')}>
        {/* Author name (first in group only) */}
        {showAuthor && !isOwn && (
          <div className="mb-0.5 px-1">
            <span className="text-xs font-semibold text-foreground">{authorName}</span>
          </div>
        )}

        {isDeleted ? (
          <div
            className={cn(
              'px-3 py-1.5 rounded-2xl text-sm italic text-muted-foreground border border-dashed border-border bg-muted/30',
              isOwn ? 'rounded-br-md' : 'rounded-bl-md',
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
                  {!message.content && (
                    <div className={cn('mt-0.5 px-1', isOwn ? 'text-right' : 'text-left')}>
                      <span className="text-[10px] text-muted-foreground">{timeLabel}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Text bubble — time is inlined at the bottom-right like WhatsApp.
                Subtle differentiation: own messages render as an outlined card
                on the background canvas; others render as a filled muted chip.
                Both stay monochrome and low-contrast. */}
            {message.content && (
              <div
                className={cn(
                  'px-3 py-1.5 rounded-2xl text-sm whitespace-pre-wrap wrap-break-word text-foreground',
                  isOwn
                    ? 'bg-background border border-border rounded-br-md'
                    : 'bg-muted rounded-bl-md',
                )}
              >
                {renderContentWithMentions(
                  message.content,
                  isSelfMention,
                  message.mentioned_phase_ids ?? [],
                  message.mentioned_doc_ids ?? [],
                  phaseTitles ?? {},
                  docTitles ?? {},
                  sectionId,
                )}
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

      {/* Others'-message delete trigger — to the RIGHT of the bubble.
          Surfaced for team leads moderating a teammate's post. */}
      {!isOwn && canDelete && !isDeleted && (
        <div className="self-center shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-50 transition-opacity">
          <TeamDeleteMenu onSelect={() => setConfirmDelete(true)} />
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this message?</AlertDialogTitle>
            <AlertDialogDescription>
              The message body and any attachment will be hidden for everyone in
              this channel. This can&apos;t be undone.
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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
                className="max-h-[88vh] max-w-full object-contain rounded-xl"
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

function TeamDeleteMenu({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Message actions"
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
