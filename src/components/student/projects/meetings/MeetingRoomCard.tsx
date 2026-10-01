/**
 * MeetingRoomCard — the team's reusable Google Meet link.
 *
 * Initial state: a "New Google Meet" button (opens meet.new in the
 * student's own Google) + a field to paste the link back to save it.
 * Saved state: a prominent Join + a subtle Replace (for when a Meet
 * expires). We can't auto-capture the meet.new link (no server /
 * cross-origin), so it's copy → paste once.
 *
 * Presentational: `room`/`loading`/`refetch` come from the tab (the single
 * owner of the realtime subscription) so we don't double-subscribe.
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Video, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { TeamMeetingRoom } from '@/lib/meetings/hooks'
import { setTeamMeetingRoom } from '@/app/(dashboard)/student/courses/[sectionId]/projects/meeting-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface MeetingRoomCardProps {
  teamId: string
  room: TeamMeetingRoom | null
  loading: boolean
  refetch: () => Promise<void>
}

export function MeetingRoomCard({ teamId, room, loading, refetch }: MeetingRoomCardProps) {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const res = await setTeamMeetingRoom(teamId, { meetUrl: trimmed })
      if (res.error) {
        toast.error(res.error)
        return
      }
      await refetch()
      setEditing(false)
      setUrl('')
      toast.success('Meeting link saved')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Loading…</div>
  }

  // Saved state — Join + Replace.
  if (room && !editing) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Team meeting room</p>
            <p className="truncate text-xs text-muted-foreground">{room.meet_url}</p>
          </div>
          <Button size="sm" className="gap-2 shrink-0" asChild>
            <a href={room.meet_url} target="_blank" rel="noopener noreferrer">
              <Video className="h-4 w-4" /> Join
            </a>
          </Button>
        </div>
        <button
          type="button"
          onClick={() => {
            setUrl(room.meet_url)
            setEditing(true)
          }}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" /> Link expired? Replace it
        </button>
      </div>
    )
  }

  // Initial / replace state — create-then-paste.
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-foreground">Set up your team meeting</p>
        <p className="text-xs text-muted-foreground">
          Start a Google Meet, then paste its link so your team can reuse it.
        </p>
      </div>
      <Button variant="outline" size="sm" className="gap-2" asChild>
        <a href="https://meet.new" target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-4 w-4" /> New Google Meet
        </a>
      </Button>
      <div className="flex items-center gap-2">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste the meeting link (https://meet.google.com/…)"
          className="h-9"
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
        <Button size="sm" onClick={save} disabled={saving || !url.trim()} className="gap-2 shrink-0">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </div>
      {editing && room && (
        <button
          type="button"
          onClick={() => {
            setEditing(false)
            setUrl('')
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
