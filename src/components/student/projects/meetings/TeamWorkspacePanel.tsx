/**
 * TeamWorkspacePanel — the right-hand contextual panel of the team
 * workspace. Segmented control switches between the team's Resources
 * (docs/canvases) and Meeting Notes. Reused in the desktop side column
 * and the mobile Sheet, and it's where future tools (whiteboard, GitHub,
 * scheduler) will slot in as new segments.
 */
'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ProjectResourcesSection } from '@/components/student/projects/docs/ProjectResourcesSection'
import { MeetingsPanel } from './MeetingsPanel'
import type { TeamMeetingRoom } from '@/lib/meetings/hooks'

type PanelTab = 'resources' | 'meetings'

interface TeamWorkspacePanelProps {
  teamId: string
  sectionId: string
  // Room state is owned once by the tab and passed down, so the panel (which
  // is instantiated for both the desktop column and the mobile sheet) never
  // opens its own realtime subscription to the room topic.
  room: TeamMeetingRoom | null
  roomLoading: boolean
  refetchRoom: () => Promise<void>
}

export function TeamWorkspacePanel({
  teamId,
  sectionId,
  room,
  roomLoading,
  refetchRoom,
}: TeamWorkspacePanelProps) {
  const [tab, setTab] = useState<PanelTab>('resources')

  return (
    <div className="flex h-full flex-col min-h-0">
      <div role="tablist" aria-label="Team workspace" className="flex gap-1 border-b border-border p-2 shrink-0">
        {(['resources', 'meetings'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors',
              tab === t
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t === 'resources' ? 'Resources' : 'Meetings'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'resources' ? (
          <ProjectResourcesSection teamId={teamId} sectionId={sectionId} />
        ) : (
          <MeetingsPanel
            teamId={teamId}
            room={room}
            roomLoading={roomLoading}
            refetchRoom={refetchRoom}
          />
        )}
      </div>
    </div>
  )
}
