// Fullscreen chat-history rail (dock v2, prototype variant 01).
//
// Collapsed by default to a 52px strip showing only "New chat" — past threads are
// a recovery path, not the point of the screen. There is no expand button: the
// whole collapsed strip is the affordance (the ew-resize cursor says so), and it
// tucks itself away again as soon as the student goes back to the conversation.
//
// This is the docked header's retired ThreadPicker, re-homed: fullscreen has the
// room to show titles, so the dropdown was redundant there.

'use client'

import { useEffect, useRef, useState } from 'react'
import { History, SquarePen, Trash2 } from 'lucide-react'
import type { ConversationSummary } from '@/lib/ai/conversation-utils'

export function AthenaHistoryRail({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const railRef = useRef<HTMLElement>(null)

  // Back to the chat ⇒ the rail tucks itself away. Pointer-down (not click) so it
  // is already collapsing by the time the student's click lands in the composer.
  useEffect(() => {
    if (!expanded) return
    const onDown = (e: PointerEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setExpanded(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [expanded])

  return (
    <aside
      ref={railRef}
      aria-label="Chat history"
      title={expanded ? undefined : 'Open chat history'}
      onClick={() => setExpanded(true)}
      className={`flex shrink-0 flex-col overflow-hidden border-r border-border/60 bg-card/50 backdrop-blur-md transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        expanded ? 'w-60' : 'w-13 cursor-ew-resize'
      }`}
    >
      <div className={`flex p-2 ${expanded ? 'items-center' : 'flex-col'}`}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onNew()
            setExpanded(false)
          }}
          title="New chat"
          aria-label="New chat"
          className={`flex items-center gap-2 rounded-2xl px-2.5 py-2 text-sm font-medium transition-colors hover:bg-accent ${
            expanded ? 'flex-1' : 'justify-center px-2'
          }`}
        >
          <SquarePen className="h-4 w-4 shrink-0" aria-hidden />
          {expanded && <span className="whitespace-nowrap">New chat</span>}
        </button>
        {/* The container's onClick is the pointer affordance, but an <aside> can't
            take keyboard focus — so a keyboard or screen-reader student had no way
            to open the history and recover a past thread. This focusable button is
            that path; it's only needed while collapsed (expanded, the thread list
            is already reachable). */}
        {!expanded && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(true)
            }}
            title="Open chat history"
            aria-label="Open chat history"
            className="mt-1 flex items-center justify-center rounded-2xl px-2 py-2 text-muted-foreground transition-colors hover:bg-accent"
          >
            <History className="h-4 w-4 shrink-0" aria-hidden />
          </button>
        )}
      </div>

      {expanded && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recents
          </p>
          {conversations.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">Nothing yet — ask her something.</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`group/thread flex items-center gap-1 rounded-2xl pr-1 ${
                  c.id === activeId ? 'bg-accent' : 'hover:bg-accent'
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(c.id)
                    setExpanded(false)
                  }}
                  className={`min-w-0 flex-1 truncate rounded-2xl px-2.5 py-1.5 text-left text-[13px] ${
                    c.id === activeId ? 'font-semibold' : ''
                  }`}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(c.id)
                  }}
                  aria-label={`Delete "${c.title}"`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/thread:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  )
}
