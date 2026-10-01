/**
 * TeamDiscussions — read-only view of a team's chat for the professor.
 *
 * Channel list on the left, transcript in the middle, per-member
 * participation (last 14 days) on the right. The professor cannot post,
 * react, or delete here — feedback goes through phase comments. Mention
 * chips are rendered inert (no hover previews): the interactive chips in
 * the student MessageBubble call member-scoped actions that would fail
 * for a professor.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Eye, Hash, Loader2, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { SystemMessageLine } from '@/components/student/projects/chat/SystemMessageLine'
import { getTeamChannelMessages } from '@/app/(dashboard)/professor/courses/[sectionId]/projects/actions'

// ── Types ────────────────────────────────────────────────────────

export interface DiscussionChannel {
  id: string
  name: string
  lastActivity: string | null
}

export interface DiscussionMember {
  userId: string
  name: string
  posts14d: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatMessage = any

interface TeamDiscussionsProps {
  sectionId: string
  projectId: string
  teamId: string
  channels: DiscussionChannel[]
  initialChannelId: string | null
  initialMessages: ChatMessage[]
  members: DiscussionMember[]
  phaseTitles: Record<string, string>
  docTitles: Record<string, string>
}

// ── Content rendering (inert mention styling) ────────────────────
//
// Same token rules as the student MessageBubble (an @ after whitespace,
// longest entity title first, bare and "Title (xxxx)" disambiguation
// forms, single-word fallback for user mentions) — but entities render
// as plain styled chips instead of interactive preview components.

function renderContent(
  content: string,
  mentionedPhaseIds: string[],
  mentionedDocIds: string[],
  phaseTitles: Record<string, string>,
  docTitles: Record<string, string>,
): React.ReactNode {
  if (!content) return null

  const candidates = [
    ...mentionedPhaseIds
      .filter((id) => !!phaseTitles[id])
      .flatMap((id) => [`${phaseTitles[id]} (${id.slice(0, 4)})`, phaseTitles[id]]),
    ...mentionedDocIds
      .filter((id) => !!docTitles[id])
      .flatMap((id) => [`${docTitles[id]} (${id.slice(0, 4)})`, docTitles[id]]),
  ].sort((a, b) => b.length - a.length)

  const parts: React.ReactNode[] = []
  let i = 0
  let key = 0
  let plainStart = 0

  const flushPlain = (until: number) => {
    if (until > plainStart) parts.push(content.slice(plainStart, until))
  }

  while (i < content.length) {
    const prev = i === 0 ? ' ' : content[i - 1]
    if (content[i] === '@' && /\s/.test(prev)) {
      const remainder = content.slice(i + 1)
      const entity = candidates.find((display) => {
        if (!remainder.startsWith(display)) return false
        const next = remainder[display.length]
        return next === undefined || /[\s.,!?;:]/.test(next)
      })
      if (entity) {
        flushPlain(i)
        parts.push(
          <span
            key={`e-${key++}`}
            className="rounded-xl bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground whitespace-nowrap"
          >
            @{entity}
          </span>,
        )
        i += 1 + entity.length
        plainStart = i
        continue
      }
      const userMatch = /^@[^\s,.!?;:]+/.exec(content.slice(i))
      if (userMatch) {
        flushPlain(i)
        parts.push(
          <span key={`m-${key++}`} className="font-semibold text-foreground">
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

// ── Helpers ──────────────────────────────────────────────────────

function initials(name: string): string {
  return (
    name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?'
  )
}

function relTime(iso: string | null): string {
  if (!iso) return 'quiet'
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function timeLabel(iso: string): string {
  // timeZone pinned so SSR (UTC) and client (local) render the same text — avoids React #418.
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// ── Component ────────────────────────────────────────────────────

export function TeamDiscussions({
  sectionId,
  projectId,
  teamId,
  channels,
  initialChannelId,
  initialMessages,
  members,
  phaseTitles,
  docTitles,
}: TeamDiscussionsProps) {
  const [activeChannelId, setActiveChannelId] = useState(initialChannelId)
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [loading, setLoading] = useState(false)

  async function switchChannel(channelId: string) {
    if (channelId === activeChannelId || loading) return
    setActiveChannelId(channelId)
    setLoading(true)
    try {
      const result = await getTeamChannelMessages(channelId, teamId, projectId, sectionId)
      if (result.error || !result.data) {
        toast.error(result.error || 'Failed to load messages')
        return
      }
      setMessages(result.data)
    } finally {
      setLoading(false)
    }
  }

  const maxPosts = Math.max(1, ...members.map((m) => m.posts14d))

  if (channels.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
        <p className="text-sm font-medium">No team chat yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          This team hasn&apos;t opened their workspace chat. Once they start posting, their
          channels and activity show up here.
        </p>
      </div>
    )
  }

  return (
    <div className="grid overflow-hidden rounded-2xl border border-border bg-card lg:grid-cols-[200px_1fr_240px]">
      {/* Channels */}
      <div className="border-b border-border bg-secondary py-3 lg:border-r lg:border-b-0">
        <p className="px-4 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Channels
        </p>
        {channels.map((channel) => (
          <button
            key={channel.id}
            onClick={() => switchChannel(channel.id)}
            className={cn(
              'flex w-full items-center gap-1.5 px-4 py-1.5 text-sm transition-colors',
              channel.id === activeChannelId
                ? 'bg-accent font-semibold text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Hash className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{channel.name}</span>
            <span className="ml-auto text-xs tabular-nums opacity-70">
              {relTime(channel.lastActivity)}
            </span>
          </button>
        ))}
      </div>

      {/* Transcript */}
      <div className="flex min-h-80 flex-col">
        <div className="flex max-h-[32rem] flex-1 flex-col gap-3 overflow-y-auto p-4">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <p className="flex-1 content-center text-center text-sm text-muted-foreground">
              Nothing posted in this channel yet.
            </p>
          ) : (
            messages.map((message) => {
              if (message.kind === 'system') {
                return <SystemMessageLine key={message.id} message={message} />
              }
              const name = message.author?.name || 'Unknown'
              return (
                <div key={message.id} className="flex gap-2.5">
                  <Avatar className="mt-0.5 h-7 w-7 shrink-0">
                    <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {timeLabel(message.created_at)}
                      </span>
                    </p>
                    {message.deleted_at ? (
                      <p className="text-sm text-muted-foreground/60 italic">Message deleted</p>
                    ) : (
                      <p className="text-sm break-words whitespace-pre-wrap">
                        {renderContent(
                          message.content,
                          message.mentioned_phase_ids || [],
                          message.mentioned_doc_ids || [],
                          phaseTitles,
                          docTitles,
                        )}
                        {message.attachment_name && (
                          <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                            <Paperclip className="h-3 w-3" />
                            {message.attachment_name}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <Eye className="h-3.5 w-3.5" />
          Read-only: you are viewing as instructor. The team is not notified, and posting happens
          only in their workspace.
        </div>
      </div>

      {/* Participation */}
      <div className="border-t border-border p-4 lg:border-t-0 lg:border-l">
        <p className="pb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Participation, 14 days
        </p>
        <div className="space-y-3">
          {members.map((member) => (
            <div key={member.userId}>
              <div className="flex items-center gap-2">
                <Avatar className="h-6 w-6 shrink-0">
                  <AvatarFallback className="text-xs">{initials(member.name)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{member.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {member.posts14d} {member.posts14d === 1 ? 'post' : 'posts'}
                </span>
              </div>
              <div className="mt-1 ml-8 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round((member.posts14d / maxPosts) * 100)}%` }}
                />
              </div>
              {member.posts14d === 0 && (
                <Badge
                  variant="secondary"
                  className="mt-1 ml-8 bg-warning-muted text-xs text-warning-muted-foreground"
                >
                  No posts yet
                </Badge>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
