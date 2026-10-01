// Shared auth/lookup helpers for student-callable live classroom server
// actions (interactions, attendance, lecture summary). Plain server-side
// module — NOT 'use server' — so these never become client-invocable
// endpoints; each action file composes them behind its own checks.

import { createClient } from '@/lib/supabase/server'

export async function getAuthUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadRoom(adminDb: any, roomId: string) {
  const { data, error } = await adminDb
    .from('lc_rooms')
    .select('id, section_id, prof_id, status, setup_completed')
    .eq('id', roomId)
    .single()
  /* No join code here on purpose. It lives on lc_room_codes, which students have no policy
     for; a field on the room would put it one query away from the people it gates (#82). */
  return error ? null : data as {
    id: string
    section_id: string
    prof_id: string
    status: string
    setup_completed: boolean
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function isEnrolled(adminDb: any, sectionId: string, userId: string): Promise<boolean> {
  const { data } = await adminDb
    .from('enrollments')
    .select('id')
    .eq('section_id', sectionId)
    .eq('student_id', userId)
    .in('status', ['enrolled', 'completed'])
    .maybeSingle()
  return !!data
}
