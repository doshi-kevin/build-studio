/**
 * StudentDiscussionsTab — the project team's workspace ("Team HQ").
 *
 * Layout: a workspace action bar (member presence + Start Meeting) above
 * a three-region body — channels + teammates rail (left), chat (center),
 * and a contextual Resources | Meeting Notes panel (right, a Sheet on
 * mobile). Bootstraps the default #general channel on mount and loads the
 * current user profile for message display.
 */
'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2, MessageSquare, PanelRight, Hash } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { useTeamChannels, type AuthorProfile } from '@/lib/chat/hooks'
import { useTeamMeetingRoom } from '@/lib/meetings/hooks'
import { ensureDefaultChannel } from '@/app/(dashboard)/student/courses/[sectionId]/projects/chat-actions'
import { ChannelSidebar } from '@/components/student/projects/chat/ChannelSidebar'
import { ChatArea } from '@/components/student/projects/chat/ChatArea'
import { JoinMeetingButton } from '@/components/student/projects/meetings/JoinMeetingButton'
import { TeamWorkspacePanel } from '@/components/student/projects/meetings/TeamWorkspacePanel'
import { PeoplePanel } from '@/components/shared/chat/PeoplePanel'
import { DmView } from '@/components/shared/chat/DmView'
import { Avatar, AvatarImage, AvatarFallback, AvatarGroup } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  listTeamPeople,
  openOrCreateDm,
  type PersonOption,
} from '@/app/(dashboard)/dms/actions'

interface StudentDiscussionsTabProps {
  sectionId: string
  teamId: string
  userId: string
}

type ActiveView =
  | { kind: 'channel'; channelId: string }
  | { kind: 'dm'; channelId: string; other: PersonOption }

function initials(name: string | null, email: string): string {
  const base = name?.trim() || email
  return base.slice(0, 2).toUpperCase()
}

export function StudentDiscussionsTab({
  sectionId,
  teamId,
  userId,
}: StudentDiscussionsTabProps) {
  const { channels, loading: channelsLoading, refetch: refetchChannels } = useTeamChannels(teamId)
  // Single owner of the meeting-room subscription; passed to the action-bar
  // button + the workspace panel(s) so no duplicate realtime topic is opened.
  const { room, loading: roomLoading, refetch: refetchRoom } = useTeamMeetingRoom(teamId)
  const [view, setView] = useState<ActiveView | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [userProfile, setUserProfile] = useState<AuthorProfile | null>(null)
  const [profileError, setProfileError] = useState(false)

  const [people, setPeople] = useState<PersonOption[]>([])
  const [peopleLoading, setPeopleLoading] = useState(true)
  const [openingDm, setOpeningDm] = useState(false)

  const [channelsSheetOpen, setChannelsSheetOpen] = useState(false)

  const activeChannelId = view?.kind === 'channel' ? view.channelId : null
  const activeDmOtherId = view?.kind === 'dm' ? view.other.id : null

  // Fetch current user's profile for message display.
  useEffect(() => {
    let active = true
    const supabase = createClient()
    supabase
      .from('profiles')
      .select('id, name, email, avatar_url')
      .eq('id', userId)
      .single()
      .then(({ data, error }) => {
        if (!active) return
        if (data) setUserProfile(data as unknown as AuthorProfile)
        else {
          setProfileError(true)
          logger.error('StudentDiscussionsTab.loadProfile', error, { userId })
        }
      })
    return () => {
      active = false
    }
  }, [userId])

  // Ensure default channel exists on mount, then re-fetch so the new
  // #general shows immediately without waiting on a realtime echo.
  useEffect(() => {
    const init = async () => {
      await ensureDefaultChannel(teamId, sectionId)
      await refetchChannels()
      setInitializing(false)
    }
    init()
  }, [teamId, sectionId, refetchChannels])

  // Load teammates for the People panel + presence.
  useEffect(() => {
    let cancelled = false
    setPeopleLoading(true)
    listTeamPeople(teamId).then((res) => {
      if (cancelled) return
      if (res.data) setPeople(res.data)
      setPeopleLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [teamId])

  // Auto-select first channel once loaded (channel mode only).
  useEffect(() => {
    if (!channelsLoading && channels.length > 0 && !view) {
      const defaultCh = channels.find((c) => c.is_default)
      setView({ kind: 'channel', channelId: defaultCh?.id || channels[0].id })
    }
  }, [channels, channelsLoading, view])

  // If the currently-selected channel gets deleted, fall back to first.
  useEffect(() => {
    if (
      view?.kind === 'channel' &&
      channels.length > 0 &&
      !channels.some((c) => c.id === view.channelId)
    ) {
      setView({ kind: 'channel', channelId: channels[0].id })
    }
  }, [channels, view])

  const handleSelectChannel = useCallback((channelId: string) => {
    setView({ kind: 'channel', channelId })
  }, [])

  const handlePersonSelect = useCallback(
    async (otherUserId: string) => {
      if (openingDm) return
      const other = people.find((p) => p.id === otherUserId)
      if (!other) return
      setOpeningDm(true)
      try {
        const result = await openOrCreateDm(otherUserId)
        if (result.error || !result.data) {
          toast.error(result.error || 'Could not open DM')
          return
        }
        setView({ kind: 'dm', channelId: result.data.channelId, other })
      } finally {
        setOpeningDm(false)
      }
    },
    [people, openingDm],
  )

  if (profileError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
        <p className="text-sm">Couldn&apos;t load your workspace. Refresh the page to try again.</p>
      </div>
    )
  }

  if (initializing || channelsLoading || !userProfile) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (channels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <MessageSquare className="h-10 w-10 mb-3" />
        <p className="text-sm">No channels yet. Setting up...</p>
      </div>
    )
  }

  const activeChannel = channels.find((c) => c.id === activeChannelId) || null
  const shownPeople = people.slice(0, 4)
  const extraPeople = people.length - shownPeople.length
  const memberCount = people.length + 1

  // Channels + teammates rail, reused in the desktop column and the mobile
  // Channels sheet. onNavigate lets the mobile sheet close after a selection.
  const renderChannelRail = (onNavigate?: () => void) => (
    <ChannelSidebar
      channels={channels}
      activeChannelId={activeChannelId}
      onSelectChannel={(id) => {
        handleSelectChannel(id)
        onNavigate?.()
      }}
      teamId={teamId}
      sectionId={sectionId}
      footerSlot={
        <PeoplePanel
          people={people}
          loading={peopleLoading}
          activeUserId={activeDmOtherId}
          onSelect={(id) => {
            handlePersonSelect(id)
            onNavigate?.()
          }}
          label="Teammates"
          emptyText="No teammates yet."
        />
      }
    />
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Workspace action bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <AvatarGroup>
            <Avatar className="h-7 w-7">
              <AvatarImage src={userProfile.avatar_url ?? undefined} alt={userProfile.name ?? ''} />
              <AvatarFallback className="text-xs">
                {initials(userProfile.name, userProfile.email)}
              </AvatarFallback>
            </Avatar>
            {shownPeople.map((p) => (
              <Avatar key={p.id} className="h-7 w-7">
                <AvatarImage src={p.avatar_url ?? undefined} alt={p.name ?? ''} />
                <AvatarFallback className="text-xs">{initials(p.name, p.email)}</AvatarFallback>
              </Avatar>
            ))}
          </AvatarGroup>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {memberCount} member{memberCount === 1 ? '' : 's'}
            {extraPeople > 0 ? ` · +${extraPeople} more` : ''}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <JoinMeetingButton room={room} />
          {/* Mobile: channels + teammates as a left Sheet (left rail is hidden <lg) */}
          <Sheet open={channelsSheetOpen} onOpenChange={setChannelsSheetOpen}>
            <SheetTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5 lg:hidden">
                <Hash className="h-4 w-4" /> Channels
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetHeader className="border-b border-border">
                <SheetTitle>Channels</SheetTitle>
              </SheetHeader>
              <div className="flex h-[calc(100dvh-64px)] flex-col">
                {renderChannelRail(() => setChannelsSheetOpen(false))}
              </div>
            </SheetContent>
          </Sheet>
          {/* Mobile: open the Resources / Meeting Notes panel as a Sheet */}
          <Sheet>
            <SheetTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5 lg:hidden">
                <PanelRight className="h-4 w-4" /> Workspace
              </Button>
            </SheetTrigger>
            <SheetContent className="w-full p-0 sm:max-w-md">
              <SheetHeader className="border-b border-border">
                <SheetTitle>Team workspace</SheetTitle>
              </SheetHeader>
              <div className="h-[calc(100dvh-64px)]">
                <TeamWorkspacePanel
                  teamId={teamId}
                  sectionId={sectionId}
                  room={room}
                  roomLoading={roomLoading}
                  refetchRoom={refetchRoom}
                />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* Body: channels + people | chat | workspace panel */}
      <div className="border border-border rounded-xl overflow-hidden flex h-[calc(100dvh-260px)] min-h-[420px]">
        {/* Left rail: Channels + People (hidden on mobile → Channels sheet) */}
        <div className="hidden lg:flex w-56 border-r bg-muted/30 flex-col shrink-0 min-h-0">
          {renderChannelRail()}
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {view?.kind === 'dm' ? (
            <DmView
              channelId={view.channelId}
              userId={userId}
              userProfile={userProfile}
              otherUser={view.other}
            />
          ) : activeChannel ? (
            <ChatArea
              channel={activeChannel}
              sectionId={sectionId}
              teamId={teamId}
              userId={userId}
              userProfile={userProfile}
            />
          ) : (
            <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm">
              Select a channel or teammate to start chatting
            </div>
          )}
        </div>

        {/* Right workspace panel (desktop) */}
        <div className="hidden lg:flex w-72 border-l bg-muted/20 flex-col shrink-0 min-h-0">
          <TeamWorkspacePanel
                  teamId={teamId}
                  sectionId={sectionId}
                  room={room}
                  roomLoading={roomLoading}
                  refetchRoom={refetchRoom}
                />
        </div>
      </div>
    </div>
  )
}
