/**
 * Team Meeting Hub realtime hooks — reusable room link, meetings list,
 * and group availability. Mirrors the project-chat hooks pattern: initial
 * fetch + useRealtimeSubscription, with a `refetch` exposed for callers
 * that just mutated (so they don't wait on the realtime echo).
 *
 * These tables aren't in the generated Database types yet, so we cast the
 * client to the bare SupabaseClient (not `any`) to call .from() without a
 * risky full types.ts regen against the shared local DB.
 */
'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRealtimeSubscription } from '@/lib/supabase/realtime'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload, SupabaseClient } from '@supabase/supabase-js'

function db(): SupabaseClient {
  return createClient() as unknown as SupabaseClient
}

// ── Reusable room link ───────────────────────────────────────────

export interface TeamMeetingRoom {
  team_id: string
  meet_url: string
  updated_by: string | null
  updated_at: string
}

async function fetchRoom(teamId: string): Promise<TeamMeetingRoom | null> {
  const { data } = await db()
    .from('team_meeting_rooms')
    .select('*')
    .eq('team_id', teamId)
    .maybeSingle()
  return (data as unknown as TeamMeetingRoom | null) ?? null
}

export function useTeamMeetingRoom(teamId: string) {
  const [room, setRoom] = useState<TeamMeetingRoom | null>(null)
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    const r = await fetchRoom(teamId)
    setRoom(r)
    setLoading(false)
  }, [teamId])

  useEffect(() => {
    let active = true
    fetchRoom(teamId).then((r) => {
      if (!active) return
      setRoom(r)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [teamId])

  useRealtimeSubscription(
    { table: 'team_meeting_rooms', filter: `team_id=eq.${teamId}` },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'DELETE') setRoom(null)
      else setRoom(payload.new as unknown as TeamMeetingRoom)
    }, []),
  )

  return { room, loading, refetch }
}

// ── Meetings (sessions) ──────────────────────────────────────────

export interface TeamMeeting {
  id: string
  team_id: string
  title: string
  scheduled_start: string | null
  meet_url: string | null
  notes_url: string | null
  notes_label: string | null
  created_by: string
  created_at: string
}

async function fetchMeetings(teamId: string): Promise<TeamMeeting[]> {
  const { data } = await db()
    .from('team_meetings')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })
    .limit(100)
  return (data as unknown as TeamMeeting[]) ?? []
}

export function useTeamMeetings(teamId: string) {
  const [meetings, setMeetings] = useState<TeamMeeting[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    setMeetings(await fetchMeetings(teamId))
    setLoading(false)
  }, [teamId])

  useEffect(() => {
    let active = true
    fetchMeetings(teamId).then((rows) => {
      if (!active) return
      setMeetings(rows)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [teamId])

  useRealtimeSubscription(
    { table: 'team_meetings', filter: `team_id=eq.${teamId}` },
    useCallback((payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      if (payload.eventType === 'INSERT') {
        const row = payload.new as unknown as TeamMeeting
        setMeetings((prev) => (prev.some((m) => m.id === row.id) ? prev : [row, ...prev]))
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new as unknown as TeamMeeting
        setMeetings((prev) => prev.map((m) => (m.id === row.id ? { ...m, ...row } : m)))
      } else if (payload.eventType === 'DELETE') {
        const del = payload.old as Partial<TeamMeeting>
        setMeetings((prev) => prev.filter((m) => m.id !== del.id))
      }
    }, []),
  )

  return { meetings, loading, refetch }
}

// ── Availability (all members' slots for overlap) ────────────────

export interface AvailabilitySlot {
  id: string
  team_id: string
  user_id: string
  slot_start: string
}

async function fetchAvailability(teamId: string): Promise<AvailabilitySlot[]> {
  const { data } = await db()
    .from('team_availability')
    .select('id, team_id, user_id, slot_start')
    .eq('team_id', teamId)
    .limit(2000)
  return (data as unknown as AvailabilitySlot[]) ?? []
}

export function useTeamAvailability(teamId: string) {
  const [slots, setSlots] = useState<AvailabilitySlot[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    setSlots(await fetchAvailability(teamId))
    setLoading(false)
  }, [teamId])

  useEffect(() => {
    let active = true
    fetchAvailability(teamId).then((rows) => {
      if (!active) return
      setSlots(rows)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [teamId])

  // Any member's change re-pulls the set (bulk replace makes per-row diffing moot).
  useRealtimeSubscription(
    { table: 'team_availability', filter: `team_id=eq.${teamId}` },
    useCallback(() => {
      fetchAvailability(teamId).then(setSlots)
    }, [teamId]),
  )

  return { slots, loading, refetch }
}
