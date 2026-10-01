/**
 * SystemMessageLine — renders WhatsApp-style inline system messages
 * (centered, muted, no avatar/bubble/timestamp) for lifecycle events
 * in team chat.
 *
 * Resolves actor + assignee names from `system_payload.actor_id` /
 * `assignee_id` / `member_id` via a lightweight profile cache on the
 * browser client. Falls back to "Someone" while a profile is loading.
 */
'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ChatMessage, SystemEvent, SystemPayload } from '@/lib/chat/hooks'

interface SystemMessageLineProps {
  message: ChatMessage
}

// Module-level cache so multiple system messages referencing the same
// profile make at most one round-trip per session.
const profileNameCache = new Map<string, string>()

async function fetchName(userId: string): Promise<string> {
  if (profileNameCache.has(userId)) return profileNameCache.get(userId) as string
  const supabase = createClient()
  const { data } = await supabase
    .from('profiles')
    .select('name, email')
    .eq('id', userId)
    .maybeSingle()
  const name =
    (data?.name as string | null) || (data?.email as string | null) || 'Someone'
  profileNameCache.set(userId, name)
  return name
}

function statusLabel(status: string | undefined): string {
  if (!status) return 'a new state'
  // "not_started" → "Not started", "in_progress" → "In progress"
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function renderCopy(
  event: SystemEvent,
  payload: SystemPayload,
  actorName: string,
  assigneeName: string,
): React.ReactNode {
  switch (event) {
    case 'phase_assigned':
      return (
        <>
          <strong className="font-medium text-foreground">{actorName}</strong>
          {' assigned a phase to '}
          <strong className="font-medium text-foreground">{assigneeName}</strong>
        </>
      )
    case 'phase_status_changed':
      return (
        <>
          <strong className="font-medium text-foreground">{actorName}</strong>
          {' moved a phase to '}
          <strong className="font-medium text-foreground">
            {statusLabel(payload.new_status)}
          </strong>
        </>
      )
    case 'doc_created':
      return (
        <>
          <strong className="font-medium text-foreground">{actorName}</strong>
          {' created a new doc'}
        </>
      )
    case 'member_joined':
      return (
        <>
          <strong className="font-medium text-foreground">{actorName}</strong>
          {' joined the team'}
        </>
      )
    default:
      return <>An update occurred</>
  }
}

export function SystemMessageLine({ message }: SystemMessageLineProps) {
  const payload = (message.system_payload ?? {}) as SystemPayload
  const event = message.system_event as SystemEvent | null
  // `member_joined` uses `member_id` as the "actor" for display — fall
  // back to it when `actor_id` is absent so cached profiles render
  // immediately instead of flashing "Someone" for a frame.
  const initialActorId = payload.actor_id ?? payload.member_id
  const [actorName, setActorName] = useState<string>(
    initialActorId ? profileNameCache.get(initialActorId) ?? 'Someone' : 'Someone',
  )
  const [assigneeName, setAssigneeName] = useState<string>(
    payload.assignee_id ? profileNameCache.get(payload.assignee_id) ?? 'a teammate' : 'a teammate',
  )

  useEffect(() => {
    let cancelled = false
    // member_joined uses `member_id` as the "actor" for copy purposes.
    const actorId = payload.actor_id ?? payload.member_id
    if (actorId) {
      fetchName(actorId).then((n) => {
        if (!cancelled) setActorName(n)
      })
    }
    if (payload.assignee_id) {
      fetchName(payload.assignee_id).then((n) => {
        if (!cancelled) setAssigneeName(n)
      })
    }
    return () => {
      cancelled = true
    }
  }, [payload.actor_id, payload.assignee_id, payload.member_id])

  if (!event) return null

  return (
    <div className="flex justify-center my-2 px-4">
      <p className="text-xs text-muted-foreground text-center max-w-[80%] leading-relaxed">
        {renderCopy(event, payload, actorName, assigneeName)}
      </p>
    </div>
  )
}
