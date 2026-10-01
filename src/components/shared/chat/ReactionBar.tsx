// Inline emoji reaction bar for chat messages. Shows aggregated
// reaction pills below a bubble; tapping a pill opens a WhatsApp-
// style reactor list popover (avatar + name) and lets the viewer
// remove their own reaction. The "+" picker still adds new ones.
'use client'

import { useState } from 'react'
import { SmilePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

export const PRESET_EMOJIS = ['👍', '❤️', '👏', '💡', '🔥'] as const

export interface ReactionUser {
  id: string
  name: string | null
  avatar_url: string | null
}

export interface ReactionSummary {
  emoji: string
  count: number
  reacted: boolean
  users: ReactionUser[]
}

interface ReactionBarProps {
  reactions: ReactionSummary[]
  onToggle: (emoji: string) => void
  disabled?: boolean
}

export function ReactionBar({ reactions, onToggle, disabled }: ReactionBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const hasReactions = reactions.some((r) => r.count > 0)

  // Arrow-key movement across the emoji row, for parity with Slack/Linear.
  // Tab/Enter/Space already work — the buttons are real buttons — so this
  // only adds the horizontal traversal a `role="toolbar"` promises.
  function handlePickerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
    )
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (current === -1) return
    e.preventDefault()
    const next =
      e.key === 'ArrowRight'
        ? (current + 1) % buttons.length
        : (current - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div className="flex items-center gap-1 flex-wrap mt-0.5">
      {reactions
        .filter((r) => r.count > 0)
        .map((r) => (
          <ReactorPill
            key={r.emoji}
            reaction={r}
            onRemove={() => onToggle(r.emoji)}
            disabled={disabled}
          />
        ))}

      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  'inline-flex items-center justify-center h-6 w-6 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                  hasReactions
                    ? 'opacity-100'
                    : // A coarse pointer has no hover, so the faded state was
                      // the only affordance a touch user ever saw. Render it
                      // fully on touch instead of half-hiding the entry point.
                      'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100',
                  disabled && 'opacity-50 cursor-not-allowed',
                )}
                aria-label="Add reaction"
              >
                <SmilePlus className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            React
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          role="toolbar"
          aria-label="Add a reaction"
          onKeyDown={handlePickerKeyDown}
          className="w-auto p-1.5 flex gap-1"
        >
          {PRESET_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onToggle(emoji)
                setPickerOpen(false)
              }}
              aria-label={`React with ${emoji}`}
              className="h-8 w-8 flex items-center justify-center rounded-xl hover:bg-muted focus-visible:bg-muted transition-colors text-base"
            >
              {emoji}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ── Per-emoji reactor pill ───────────────────────────────────────
//
// Tapping the pill opens a popover that lists everyone who reacted
// with that emoji. If the viewer is in the list, the bottom of the
// popover offers a "Remove your reaction" affordance — same pattern as
// WhatsApp's reaction sheet.

function ReactorPill({
  reaction,
  onRemove,
  disabled,
}: {
  reaction: ReactionSummary
  onRemove: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] transition-colors border cursor-pointer',
            reaction.reacted
              ? 'bg-foreground/10 border-foreground/20 font-semibold'
              : 'bg-muted/50 border-border hover:bg-muted',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
          aria-label={`${reaction.count} ${reaction.emoji} reaction${reaction.count === 1 ? '' : 's'}`}
        >
          <span className="text-xs">{reaction.emoji}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-56 p-0 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <span className="text-base leading-none">{reaction.emoji}</span>
          <span className="text-xs text-muted-foreground">
            {reaction.count} {reaction.count === 1 ? 'reaction' : 'reactions'}
          </span>
        </div>
        <ul className="max-h-56 overflow-y-auto py-1">
          {reaction.users.map((u) => (
            <li
              key={u.id}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              {/* Avatar (not a raw <img>) so a 404 falls back to initials
                  instead of a broken-image icon, and so the list of 50+
                  reactors loads lazily instead of on first paint. */}
              <Avatar size="sm" className="shrink-0">
                <AvatarImage
                  src={u.avatar_url ?? undefined}
                  alt={u.name || ''}
                  loading="lazy"
                />
                <AvatarFallback className="text-[9px] font-semibold">
                  {(u.name || '·').slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{u.name || 'Unknown'}</span>
            </li>
          ))}
        </ul>
        {reaction.reacted && (
          <button
            type="button"
            onClick={() => {
              onRemove()
              setOpen(false)
            }}
            disabled={disabled}
            className="w-full px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors border-t border-border text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Remove your reaction
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
