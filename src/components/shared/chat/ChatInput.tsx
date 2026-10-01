/**
 * Shared ChatInput — Text input bar with file attachment for sending messages.
 * Used by both project chat and course-level discussions.
 *
 * Accepts an onUpload callback so the parent controls which storage path to use.
 */
'use client'

import { useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { Send, Paperclip, X, Loader2, FileText, ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { formatFileSize } from '@/lib/supabase/storage'
import { MAX_CHAT_ATTACHMENT_SIZE, CHAT_ACCEPTED_TYPES } from '@/lib/supabase/chat-storage'

export interface ChatAttachment {
  url: string
  path: string
  name: string
  size: number
  type: string
}

export interface ChatUploadFn {
  (file: File): Promise<{ data: { url: string; path: string; fileName: string; fileSize: number; mimeType: string } | null; error: string | null }>
}

interface ChatInputProps {
  /** Resolve `false` to signal a REJECTED send — the composer then keeps the text so the
   *  user can retry or copy it. Anything else (including void) is treated as success. */
  onSend: (content: string, attachment?: ChatAttachment) => Promise<void | boolean>
  onUpload: ChatUploadFn
  sending: boolean
  disabled?: boolean
}

export function ChatInput({ onSend, onUpload, sending, disabled }: ChatInputProps) {
  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
      const result = await onUpload(file)
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
  }, [onUpload])

  const handleSend = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && !attachment) return

    /* Clear only on SUCCESS. The composer used to empty unconditionally, which was
       survivable while a rejected send left its optimistic bubble on screen — the text was
       at least still visible there. Now that the bubble is correctly rolled back
       (#677/#681), clearing anyway would destroy the message outright: a student who typed
       5,000 characters would have them gone from both places with nothing to retry.
       `onSend` resolving false means "rejected, keep what they typed". */
    const ok = await onSend(trimmed, attachment || undefined)
    if (ok === false) return

    setText('')
    setAttachment(null)
    textareaRef.current?.focus()
  }, [text, attachment, onSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!sending && !uploading && !disabled) handleSend()
    }
  }

  const removeAttachment = () => setAttachment(null)

  const isImage = attachment?.type?.startsWith('image/')

  return (
    <div className="border-t px-3 py-2 shrink-0">
      {/* Attachment preview */}
      {attachment && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-muted/50 rounded-md">
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
          disabled={uploading || sending || disabled}
        >
          <Paperclip className="h-4 w-4" />
        </Button>

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          className="min-h-[36px] max-h-32 resize-none text-sm py-2"
          rows={1}
          disabled={sending || disabled}
        />

        <Button
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={handleSend}
          disabled={sending || uploading || disabled || (!text.trim() && !attachment)}
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
