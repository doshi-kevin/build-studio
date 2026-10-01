/**
 * JoinMeetingButton — action-bar shortcut. When the team has a saved room
 * link it's a one-click Join; otherwise it opens meet.new and nudges the
 * student to paste the link in the Meetings panel to save it.
 *
 * Presentational: the room is owned/subscribed once by the tab and passed
 * in, so we don't open a second realtime subscription to the same topic.
 */
'use client'

import { toast } from 'sonner'
import { Video } from 'lucide-react'
import type { TeamMeetingRoom } from '@/lib/meetings/hooks'
import { Button } from '@/components/ui/button'

export function JoinMeetingButton({ room }: { room: TeamMeetingRoom | null }) {
  if (room) {
    return (
      <Button size="sm" className="gap-2" asChild>
        <a href={room.meet_url} target="_blank" rel="noopener noreferrer">
          <Video className="h-4 w-4" /> Join meeting
        </a>
      </Button>
    )
  }

  return (
    <Button
      size="sm"
      className="gap-2"
      onClick={() => {
        window.open('https://meet.new', '_blank', 'noopener,noreferrer')
        toast.info('Meet opened — paste its link in Meetings to save it for the team')
      }}
    >
      <Video className="h-4 w-4" /> New meeting
    </Button>
  )
}
