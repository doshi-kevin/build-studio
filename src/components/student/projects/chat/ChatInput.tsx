/**
 * ChatInput — Text input bar with file attachment, emoji picker, and
 * @mention autocomplete.
 *
 * Supports Enter to send, Shift+Enter for newline, file uploads, emoji
 * insertion at cursor position, and a floating MentionPicker that
 * appears while the user is typing an @name token. Resolved mentions
 * travel alongside the text as UUIDs (scanned on send against the
 * member list we've inserted from) so the server can fan out
 * notifications.
 */
'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import { Send, Paperclip, X, Loader2, FileText, ImageIcon, Smile } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  uploadChatAttachment,
  MAX_CHAT_ATTACHMENT_SIZE,
  CHAT_ACCEPTED_TYPES,
} from '@/lib/supabase/chat-storage'
import { formatFileSize } from '@/lib/supabase/storage'
import {
  listTeamDocsForMention,
  listTeamMembersForMention,
  listTeamPhasesForMention,
  type TeamDocOption,
  type TeamMemberOption,
  type TeamPhaseOption,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'
import { MentionPicker, type MentionCandidate } from '@/components/student/projects/chat/MentionPicker'
import type { EmojiClickData } from 'emoji-picker-react'

// Dynamic import to avoid SSR issues and keep bundle lean
const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })

interface ChatInputProps {
  onSend: (
    content: string,
    attachment?: {
      url: string
      path: string
      name: string
      size: number
      type: string
    },
    mentionedUserIds?: string[],
    mentionedPhaseIds?: string[],
    mentionedDocIds?: string[],
    /** Resolve `false` to signal a REJECTED send — the composer keeps the text and the
     *  resolved mentions so the user can retry (see handleSend). */
  ) => Promise<void | boolean>
  sending: boolean
  teamId: string
  sectionId: string
  channelId: string
}

interface PendingAttachment {
  url: string
  path: string
  name: string
  size: number
  type: string
}

interface MentionState {
  // Position in `text` where the active `@` sits (index of the @ char)
  anchor: number
  // The raw query the user has typed after the @ (without the @)
  query: string
}

// Escape a string so it can be safely embedded in a RegExp.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function ChatInput({ onSend, sending, teamId, sectionId, channelId }: ChatInputProps) {
  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)

  // ── Mention state ───────────────────────────────────────────────
  // Members, phases, and docs loaded lazily the first time the user types `@`.
  const [members, setMembers] = useState<TeamMemberOption[]>([])
  const [phases, setPhases] = useState<TeamPhaseOption[]>([])
  const [docs, setDocs] = useState<TeamDocOption[]>([])
  const [mentionDataLoaded, setMentionDataLoaded] = useState(false)
  const [mention, setMention] = useState<MentionState | null>(null)
  const [mentionHighlight, setMentionHighlight] = useState(0)
  // Lists of mentions inserted this session, keyed by the exact
  // `display` string that was written into the text. We use lists
  // (not maps) so that if two distinct candidates collide on display
  // we can still enumerate them — collisions are also disambiguated
  // at insert time below.
  const insertedUserMentionsRef = useRef<Array<{ display: string; userId: string }>>([])
  const insertedPhaseMentionsRef = useRef<Array<{ display: string; phaseId: string }>>([])
  const insertedDocMentionsRef = useRef<Array<{ display: string; docId: string }>>([])

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmoji) return
    const handler = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmoji(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showEmoji])

  // Lazy-load mention candidates (team members + phases + docs) the
  // first time the user opens the picker. All fetched in parallel.
  const ensureMentionDataLoaded = useCallback(async () => {
    if (mentionDataLoaded) return
    const [membersRes, phasesRes, docsRes] = await Promise.all([
      listTeamMembersForMention(teamId, sectionId),
      listTeamPhasesForMention(teamId, sectionId),
      listTeamDocsForMention(teamId, sectionId),
    ])
    // Non-fatal — picker just shows whatever loaded successfully.
    if (!membersRes.error) setMembers(membersRes.data ?? [])
    if (!phasesRes.error) setPhases(phasesRes.data ?? [])
    if (!docsRes.error) setDocs(docsRes.data ?? [])
    setMentionDataLoaded(true)
  }, [mentionDataLoaded, teamId, sectionId])

  // Preload mention candidates on mount so the picker is ready the very first
  // time the user types `@` — otherwise the first token renders no picker
  // until the lazy fetch resolves.
  useEffect(() => {
    void ensureMentionDataLoaded()
  }, [ensureMentionDataLoaded])

  // Scan around the caret to determine whether we're inside an @token.
  const updateMentionState = useCallback((value: string, caret: number) => {
    // Walk backward from the caret to find the nearest `@` that's
    // either at the start of the string or preceded by whitespace.
    let i = caret - 1
    while (i >= 0) {
      const ch = value[i]
      if (ch === '@') {
        const prev = i === 0 ? ' ' : value[i - 1]
        if (/\s/.test(prev) || i === 0) {
          const query = value.slice(i + 1, caret)
          // Abandon if the token already spans multiple words (user
          // finished typing) or contains a newline.
          if (/\s/.test(query)) return null
          return { anchor: i, query }
        }
        return null
      }
      // Any whitespace between @ and caret also breaks the token.
      if (/\s/.test(ch)) return null
      i--
    }
    return null
  }, [])

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setText(value)
      const caret = e.target.selectionStart ?? value.length
      const next = updateMentionState(value, caret)
      if (next) {
        if (!mentionDataLoaded) void ensureMentionDataLoaded()
        setMention(next)
        setMentionHighlight(0)
      } else {
        setMention(null)
      }
    },
    [updateMentionState, ensureMentionDataLoaded, mentionDataLoaded],
  )

  // Keep the mention picker in sync when the caret moves without the
  // text changing — mouse-click into a different spot, arrow-key
  // navigation, Home/End. Without this, the picker stays open even
  // after the caret leaves the active `@token`.
  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const caret = ta.selectionStart ?? ta.value.length
      const next = updateMentionState(ta.value, caret)
      if (next) {
        if (!mentionDataLoaded) void ensureMentionDataLoaded()
        setMention(next)
        // Only reset highlight when entering a *different* @token.
        setMentionHighlight((prev) => (mention && mention.anchor === next.anchor ? prev : 0))
      } else if (mention) {
        setMention(null)
      }
    },
    [updateMentionState, ensureMentionDataLoaded, mentionDataLoaded, mention],
  )

  // Insert a chosen candidate (user, phase, or doc) at the mention anchor.
  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      if (!mention) return

      let display: string
      if (candidate.kind === 'user') {
        const baseDisplay = candidate.user.name || candidate.user.email
        // Disambiguate on collision: if a different user was already
        // inserted with the same display (two "Alex"es in one team),
        // fall back to the email. This keeps the scan-on-send regex
        // able to map text back to the right UUID.
        const collides = insertedUserMentionsRef.current.some(
          (m) => m.display === baseDisplay && m.userId !== candidate.user.id,
        )
        display = collides ? candidate.user.email : baseDisplay
        insertedUserMentionsRef.current.push({ display, userId: candidate.user.id })
      } else if (candidate.kind === 'phase') {
        const baseDisplay = candidate.phase.title
        // Phase titles can collide too — disambiguate by appending a
        // short id suffix so the regex still maps back deterministically.
        const collides = insertedPhaseMentionsRef.current.some(
          (m) => m.display === baseDisplay && m.phaseId !== candidate.phase.id,
        )
        display = collides
          ? `${baseDisplay} (${candidate.phase.id.slice(0, 4)})`
          : baseDisplay
        insertedPhaseMentionsRef.current.push({ display, phaseId: candidate.phase.id })
      } else {
        const baseDisplay = candidate.doc.title
        // Same disambiguation rules as phases — two docs can share a
        // title ("Untitled" is especially likely), so fall back to the
        // short id suffix.
        const collides = insertedDocMentionsRef.current.some(
          (m) => m.display === baseDisplay && m.docId !== candidate.doc.id,
        )
        display = collides
          ? `${baseDisplay} (${candidate.doc.id.slice(0, 4)})`
          : baseDisplay
        insertedDocMentionsRef.current.push({ display, docId: candidate.doc.id })
      }

      const before = text.slice(0, mention.anchor)
      const after = text.slice(mention.anchor + 1 + mention.query.length)
      const insertText = `@${display} `
      const newValue = before + insertText + after
      const newCaret = before.length + insertText.length

      setText(newValue)
      setMention(null)
      // Restore caret after React updates the textarea value
      setTimeout(() => {
        const ta = textareaRef.current
        if (ta) {
          ta.selectionStart = newCaret
          ta.selectionEnd = newCaret
          ta.focus()
        }
      }, 0)
    },
    [mention, text],
  )

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > MAX_CHAT_ATTACHMENT_SIZE) {
      toast.error('File is too large (max 25 MB)')
      /* Clear the input on the REJECT path too (#699 part 5). Returning early skips the
         `finally` below that normally resets it, so the input kept the rejected filename.
         Re-picking the SAME file then changed nothing, the browser fired no `change` event,
         and the student's second attempt vanished with no toast and no request at all: they
         were told the file was too big, tried again, and got total silence. Precedent:
         HeroBlockEditor.tsx:85. */
      e.target.value = ''
      return
    }

    setUploading(true)
    try {
      const result = await uploadChatAttachment(file, teamId, channelId)
      if (result.error) {
        toast.error(result.error)
      } else if (result.data) {
        setAttachment({
          url: result.data.url,
          path: result.data.path,
          name: result.data.fileName,
          size: result.data.fileSize,
          type: result.data.mimeType,
        })
      }
    } catch {
      toast.error('Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [teamId, channelId])

  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && !attachment) return

    // Resolve mentions by scanning the final text for each entry we
    // inserted this session. User-deleted mentions naturally drop out
    // because the substring no longer appears. For each unique
    // `@display` substring in the text we pick the MOST RECENT insert
    // that used that display — rewinds of "delete then re-insert" keep
    // resolving correctly.
    const resolveIds = <T extends { display: string }>(
      list: T[],
      idOf: (entry: T) => string,
    ): string[] => {
      const ids: string[] = []
      const seenDisplays = new Set<string>()
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i]
        if (seenDisplays.has(entry.display)) continue
        seenDisplays.add(entry.display)
        // Match `@display` when preceded by start-of-string or whitespace
        // AND followed by end-of-string, whitespace, or punctuation.
        const pattern = new RegExp(
          `(^|\\s)@${escapeRegex(entry.display)}(?=$|[\\s\\p{P}])`,
          'u',
        )
        const id = idOf(entry)
        if (pattern.test(trimmed) && !ids.includes(id)) {
          ids.push(id)
        }
      }
      return ids
    }

    const mentionedUserIds = resolveIds(insertedUserMentionsRef.current, (e) => e.userId)
    const mentionedPhaseIds = resolveIds(insertedPhaseMentionsRef.current, (e) => e.phaseId)
    const mentionedDocIds = resolveIds(insertedDocMentionsRef.current, (e) => e.docId)

    /* Clear only on SUCCESS. Rolling back the optimistic bubble (#677/#681) without this
       would destroy the message: gone from the thread AND from the composer, with nothing
       to retry. The resolved mentions are kept too, so a retry still carries them. */
    const ok = await onSend(
      trimmed,
      attachment || undefined,
      mentionedUserIds,
      mentionedPhaseIds,
      mentionedDocIds,
    )
    if (ok === false) return

    setText('')
    setAttachment(null)
    insertedUserMentionsRef.current = []
    insertedPhaseMentionsRef.current = []
    insertedDocMentionsRef.current = []
    textareaRef.current?.focus()
  }, [text, attachment, onSend])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the mention picker is open, trap navigation keys.
    if (mention) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionHighlight((h) => h + 1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionHighlight((h) => Math.max(0, h - 1))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // Pick the highlighted candidate (if any). We mirror
        // MentionPicker's filter+order so we identify the same target.
        const q = mention.query.trim().toLowerCase()
        const matchedUsers = (q
          ? members.filter(
              (m) =>
                (m.name || '').toLowerCase().includes(q) ||
                m.email.toLowerCase().includes(q),
            )
          : members
        ).slice(0, 6)
        const matchedPhases = (q
          ? phases.filter((p) => p.title.toLowerCase().includes(q))
          : phases
        ).slice(0, 6)
        const matchedDocs = (q
          ? docs.filter((d) => d.title.toLowerCase().includes(q))
          : docs
        ).slice(0, 6)
        const flat: MentionCandidate[] = [
          ...matchedUsers.map<MentionCandidate>((u) => ({ kind: 'user', user: u })),
          ...matchedPhases.map<MentionCandidate>((p) => ({ kind: 'phase', phase: p })),
          ...matchedDocs.map<MentionCandidate>((d) => ({ kind: 'doc', doc: d })),
        ]
        if (flat.length > 0) {
          const target = flat[Math.min(mentionHighlight, flat.length - 1)]
          if (target) {
            e.preventDefault()
            insertMention(target)
            return
          }
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!sending && !uploading) handleSend()
    }
  }

  const handleEmojiClick = useCallback((emojiData: EmojiClickData) => {
    const emoji = emojiData.emoji
    const textarea = textareaRef.current

    if (textarea) {
      const start = textarea.selectionStart ?? text.length
      const end = textarea.selectionEnd ?? text.length
      const newText = text.slice(0, start) + emoji + text.slice(end)
      setText(newText)
      // Restore cursor after emoji
      setTimeout(() => {
        textarea.selectionStart = start + emoji.length
        textarea.selectionEnd = start + emoji.length
        textarea.focus()
      }, 0)
    } else {
      setText((prev) => prev + emoji)
    }

    setShowEmoji(false)
  }, [text])

  const removeAttachment = () => setAttachment(null)
  const isImage = attachment?.type?.startsWith('image/')

  return (
    <div className="border-t px-3 py-2 shrink-0 relative">
      {/* Mention picker (anchored to textarea) */}
      {mention && mentionDataLoaded && (
        <MentionPicker
          members={members}
          phases={phases}
          docs={docs}
          query={mention.query}
          highlightIndex={mentionHighlight}
          onSelect={insertMention}
          onHighlightChange={setMentionHighlight}
        />
      )}

      {/* Emoji picker popup */}
      {showEmoji && (
        <div
          ref={emojiPickerRef}
          className="absolute bottom-full right-0 mb-1 z-50"
        >
          <EmojiPicker
            onEmojiClick={handleEmojiClick}
            height={380}
            width={320}
            previewConfig={{ showPreview: false }}
            searchDisabled={false}
          />
        </div>
      )}

      {/* Attachment preview */}
      {attachment && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-muted/50 rounded-xl">
          {isImage ? (
            <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">{attachment.name}</p>
            <p className="text-[10px] text-muted-foreground">{formatFileSize(attachment.size)}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={removeAttachment}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Upload progress */}
      {uploading && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="text-xs">Uploading...</span>
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={CHAT_ACCEPTED_TYPES}
          onChange={handleFileSelect}
          className="hidden"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || sending}
        >
          <Paperclip className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => setShowEmoji((v) => !v)}
          disabled={sending}
          aria-label="Insert emoji"
        >
          <Smile className="h-4 w-4" />
        </Button>

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          placeholder="Type a message... (type @ to mention people, phases, or docs)"
          className="min-h-[36px] max-h-32 resize-none text-sm py-2"
          rows={1}
          disabled={sending}
        />

        <Button
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={handleSend}
          disabled={sending || uploading || (!text.trim() && !attachment)}
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  )
}
