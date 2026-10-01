/**
 * MeetingsPanel — the team's meeting coordination surface: the reusable
 * room link, plus a log of meetings each with an optional notes link the
 * student pastes (their Fathom share URL or a Google Doc). We store only
 * URLs — never recordings or transcripts.
 */
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Video, FileText, ExternalLink, Plus, Trash2, Loader2 } from 'lucide-react'
import { useTeamMeetings, type TeamMeeting, type TeamMeetingRoom } from '@/lib/meetings/hooks'
import {
  logTeamMeeting,
  attachMeetingNotes,
  deleteTeamMeeting,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/meeting-actions'
import { MeetingRoomCard } from './MeetingRoomCard'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

function formatWhen(m: TeamMeeting): string {
  const iso = m.scheduled_start ?? m.created_at
  const d = new Date(iso)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${m.scheduled_start ? 'Scheduled ' : ''}${date} · ${time}`
}

interface MeetingsPanelProps {
  teamId: string
  room: TeamMeetingRoom | null
  roomLoading: boolean
  refetchRoom: () => Promise<void>
}

export function MeetingsPanel({ teamId, room, roomLoading, refetchRoom }: MeetingsPanelProps) {
  const { meetings, loading, refetch } = useTeamMeetings(teamId)

  const [logOpen, setLogOpen] = useState(false)
  const [logTitle, setLogTitle] = useState('')
  const [logWhen, setLogWhen] = useState('')
  const [logSaving, setLogSaving] = useState(false)

  const [attachFor, setAttachFor] = useState<string | null>(null)
  const [notesUrl, setNotesUrl] = useState('')
  const [notesLabel, setNotesLabel] = useState('')
  const [attachSaving, setAttachSaving] = useState(false)

  const submitLog = async () => {
    if (!logTitle.trim()) return
    setLogSaving(true)
    try {
      const scheduledStart = logWhen ? new Date(logWhen).toISOString() : undefined
      const res = await logTeamMeeting(teamId, { title: logTitle.trim(), scheduledStart })
      if (res.error) {
        toast.error(res.error)
        return
      }
      await refetch()
      setLogOpen(false)
      setLogTitle('')
      setLogWhen('')
      toast.success('Meeting added')
    } finally {
      setLogSaving(false)
    }
  }

  const submitAttach = async () => {
    if (!attachFor || !notesUrl.trim()) return
    setAttachSaving(true)
    try {
      const res = await attachMeetingNotes(attachFor, {
        notesUrl: notesUrl.trim(),
        notesLabel: notesLabel.trim() || undefined,
      })
      if (res.error) {
        toast.error(res.error)
        return
      }
      await refetch()
      setAttachFor(null)
      setNotesUrl('')
      setNotesLabel('')
      toast.success('Notes link added')
    } finally {
      setAttachSaving(false)
    }
  }

  const remove = async (id: string) => {
    const res = await deleteTeamMeeting(id)
    if (res.error) toast.error(res.error)
    else await refetch()
  }

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="shrink-0 space-y-3 p-3">
        <MeetingRoomCard teamId={teamId} room={room} loading={roomLoading} refetch={refetchRoom} />
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground">Meetings</h4>
          <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={() => setLogOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Log meeting
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-3 pb-3">
        {loading ? (
          <p className="p-2 text-sm text-muted-foreground">Loading…</p>
        ) : meetings.length === 0 ? (
          <EmptyState
            icon={Video}
            title="No meetings yet"
            description="Log a meeting and paste its notes link (record with Fathom — free forever — and paste the share link) so your team can revisit."
          />
        ) : (
          <ul className="space-y-2">
            {meetings.map((m) => (
              <li key={m.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{m.title}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{formatWhen(m)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(m.id)}
                    aria-label="Delete meeting"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {m.meet_url && (
                    <Button size="sm" variant="secondary" className="h-7 gap-1.5" asChild>
                      <a href={m.meet_url} target="_blank" rel="noopener noreferrer">
                        <Video className="h-3.5 w-3.5" /> Join
                      </a>
                    </Button>
                  )}
                  {m.notes_url ? (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5" asChild>
                      <a href={m.notes_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" /> {m.notes_label || 'Notes'}
                      </a>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5"
                      onClick={() => setAttachFor(m.id)}
                    >
                      <FileText className="h-3.5 w-3.5" /> Add notes
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      {/* Log meeting dialog */}
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log a meeting</DialogTitle>
            <DialogDescription>
              Add a meeting your team held or scheduled. Attach a notes link afterward.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="log-title">Title</Label>
              <Input
                id="log-title"
                value={logTitle}
                onChange={(e) => setLogTitle(e.target.value)}
                placeholder="e.g. Kickoff sync"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="log-when">When (optional — set to get a reminder)</Label>
              <Input
                id="log-when"
                type="datetime-local"
                value={logWhen}
                onChange={(e) => setLogWhen(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLogOpen(false)} disabled={logSaving}>
              Cancel
            </Button>
            <Button onClick={submitLog} disabled={logSaving || !logTitle.trim()} className="gap-2">
              {logSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Attach notes dialog */}
      <Dialog open={!!attachFor} onOpenChange={(o) => !o && setAttachFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach a notes link</DialogTitle>
            <DialogDescription>
              Paste your Fathom share link or a Google Doc so teammates can revisit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="notes-url">Link</Label>
              <Input
                id="notes-url"
                value={notesUrl}
                onChange={(e) => setNotesUrl(e.target.value)}
                placeholder="https://fathom.video/share/…"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes-label">Label (optional)</Label>
              <Input
                id="notes-label"
                value={notesLabel}
                onChange={(e) => setNotesLabel(e.target.value)}
                placeholder="e.g. Fathom recap"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAttachFor(null)} disabled={attachSaving}>
              Cancel
            </Button>
            <Button onClick={submitAttach} disabled={attachSaving || !notesUrl.trim()} className="gap-2">
              {attachSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
