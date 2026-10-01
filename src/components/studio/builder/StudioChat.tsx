'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Bot, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { ChatMessage } from './types'

interface StudioChatProps {
  messages: ChatMessage[]
  busy: boolean
  onSend: (text: string) => void
}

export function StudioChat({ messages, busy, onSend }: StudioChatProps) {
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const send = () => {
    const text = draft.trim()
    if (!text || busy) return
    onSend(text)
    setDraft('')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" role="log" aria-label="Conversation with Athena">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="ml-8 rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="mr-4 flex gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1 rounded-2xl bg-muted px-4 py-2.5 text-sm">
                <p>{m.text}</p>
              </div>
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <form
        className="shrink-0 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            aria-label="Describe a change"
            placeholder="Describe what to add or change"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <Button type="submit" size="icon" className="h-10 w-10 shrink-0" disabled={busy || !draft.trim()} aria-label="Send">
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ArrowUp className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </div>
      </form>
    </div>
  )
}
