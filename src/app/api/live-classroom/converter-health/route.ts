// Diagnostic: is the Live Classroom PPTX→PDF converter reachable?
//
// Lets the team confirm "is the converter alive?" from a browser without the
// GCP console. Gated to professors/admins (returns only converter health, no
// tenant data). Returns 200 when enabled + healthy, 503 otherwise so it's easy
// to eyeball / curl in an uptime check.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkConverterHealth } from '@/lib/live-classroom/deck-converter'

export const runtime = 'nodejs'

const ALLOWED_ROLES = new Set(['professor', 'institution_admin', 'super_admin'])

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile?.role || !ALLOWED_ROLES.has(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const health = await checkConverterHealth()
  return NextResponse.json(health, { status: health.enabled && health.ok ? 200 : 503 })
}
