/**
 * Dashboard Layout — shared wrapper for all authenticated/protected pages.
 *
 * This layout wraps every page inside the (dashboard) route group and:
 * 1. Fetches the authenticated user from Supabase (validates JWT server-side)
 * 2. Fetches the user's profile from the profiles table (role, name, avatar)
 * 3. Renders the DashboardHeader with user info and logout dropdown
 * 4. Renders child pages in a centered content area
 *
 * IMPORTANT: This layout does NOT redirect unauthenticated users.
 * All auth redirects are handled by middleware.ts to prevent redirect loops.
 * If no user is found here, we render gracefully with null profile.
 *
 * Type: Server Component (async, fetches data server-side)
 * Tables: profiles (read)
 */

import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { DashboardHeader } from '@/components/dashboard/DashboardHeader'
import { Sidebar } from '@/components/dashboard/Sidebar'
// import { FeedbackWidget } from '@/components/shared/FeedbackWidget'
import { SetPasswordDialog } from '@/components/shared/SetPasswordDialog'
import { RecoveryLinkHandoff } from '@/components/shared/RecoveryLinkHandoff'
import { SuspendedSignOutButton } from '@/components/dashboard/SuspendedSignOutButton'
import { RealtimeAuthMount } from '@/lib/supabase/realtime-auth'
import { CalendarColorsInit } from '@/components/student/calendar/CalendarColorsInit'
import { Toaster } from '@/components/ui/sonner'
import { MotionProvider } from '@/components/shared/MotionProvider'
import { RouteProgress } from '@/components/dashboard/RouteProgress'
import { logger } from '@/lib/logger'
import type { Profile } from '@/lib/supabase/types'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError) {
    logger.error('DashboardLayout: Auth check failed', authError)
  }

  // Auth redirect is handled by middleware — no redirect here to avoid loops
  if (!user && !authError) {
    logger.warn('DashboardLayout: No user session (middleware should have redirected)')
  }

  logger.debug('DashboardLayout: Rendering', { userId: user?.id ?? null })

  let profile: Profile | null = null
  let institutionName: string | null = null
  if (user) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (error && error.code !== 'PGRST116') {
      logger.error('DashboardLayout: Profile fetch failed', error, { userId: user.id })
    }
    profile = data as Profile | null

    if (profile) {
      logger.debug('DashboardLayout: Profile loaded', { userId: user.id, role: profile.role })

      /* Fetch institution name for the header (rendered on every page).
       * Skipped for super_admin since they're platform-tier and the platform
       * surface shouldn't pin to a single tenant's branding. */
      if (profile.institution_id && profile.role !== 'super_admin') {
        const { data: instRow } = await supabase
          .from('institutions')
          .select('name')
          .eq('id', profile.institution_id)
          .maybeSingle()
        institutionName = (instRow as { name?: string } | null)?.name ?? null
      }
    } else {
      logger.warn('DashboardLayout: No profile found for authenticated user', { userId: user.id })
    }
  }

  /* Tenant suspension gate. The status is synced into auth.users.app_metadata
   * by the institutions UPDATE trigger, so we read it from the JWT to avoid a
   * DB round-trip on every page render. The DB is the source of truth, but a
   * stale JWT is fine here because:
   *   • setInstitutionStatus('suspended') calls auth.admin.signOut('global'),
   *     forcing a refresh.
   *   • verifyInstitutionAdmin re-checks status from the DB on every server
   *     action, catching anything that slips past the JWT.
   * super_admin bypasses (they manage tenants and may not be in any institution). */
  let institutionSuspended = false
  if (user && profile && profile.role !== 'super_admin') {
    const status = (user.app_metadata as { institution_status?: string } | undefined)?.institution_status
    if (status === 'suspended') {
      institutionSuspended = true
      logger.warn('DashboardLayout: Institution suspended (from JWT), blocking access', {
        userId: user.id,
        institutionId: profile.institution_id,
      })
    }
  }

  if (institutionSuspended) {
    return (
      <div className="h-dvh flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-5">
          <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase">
            Account Suspended
          </p>
          <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
            Access paused
          </h1>
          <p className="text-[15px] text-muted-foreground">
            Your institution&apos;s account is currently suspended. Please reach out to your
            institution administrator or contact Scholera support to restore access.
          </p>
          <p className="text-xs text-muted-foreground/70">
            <a href="mailto:support@scholera-inc.com" className="underline hover:text-foreground">
              support@scholera-inc.com
            </a>
          </p>
          <div className="pt-2">
            <SuspendedSignOutButton />
          </div>
        </div>
        <Toaster richColors position="top-right" />
      </div>
    )
  }

  return (
    <MotionProvider>
    <div className="h-dvh flex flex-col overflow-hidden bg-background">
      {/* Reads searchParams, so it needs its own boundary — without one it
          opts every page in this group into dynamic rendering. */}
      <Suspense fallback={null}>
        <RouteProgress />
      </Suspense>
      <DashboardHeader profile={profile} institutionName={institutionName} />
      <div className="flex flex-1 min-h-0">
        <Sidebar role={profile?.role || 'student'} />
        {/* This padding is mirrored arithmetically by `FRAME_H` in
            AthenaShell.tsx — the full-bleed frames cancel it with a negative
            margin and add it back to their height, so changing `p-4 lg:p-8`
            (or its breakpoint) means changing that constant in the same commit.
            Get it wrong and the frame outgrows this scroller, which then
            carries Athena's dock off the bottom of the screen. */}
        <main className="flex-1 min-w-0 p-4 lg:p-8 overflow-y-auto overflow-x-hidden">
          {children}
        </main>
      </div>
      {/* Overlays — use portals, won't be clipped by overflow-hidden */}
      <Suspense fallback={null}>
        <SetPasswordDialog />
      </Suspense>
      {/* Catches a recovery/invite link that middleware RULE 2 bounced here with its
          tokens still in the hash (#728). Mounted on the LAYOUT because the bounce
          lands on /dashboard, which then server-redirects admins on to /admin — all
          inside this group, so one mount covers every landing spot. */}
      <RecoveryLinkHandoff currentEmail={user?.email ?? null} currentUserId={user?.id ?? null} />
      {/* Feedback widget temporarily hidden — re-enable by uncommenting. */}
      {/* {profile && <FeedbackWidget userRole={profile.role} />} */}
      <Toaster richColors position="top-right" />
      {/* Pushes the Supabase JWT into the realtime client so private
          channels (Live Classroom Broadcast) authorize correctly. */}
      <RealtimeAuthMount />
      {/* Applies the student's saved calendar category colors on load. */}
      <CalendarColorsInit />
    </div>
    </MotionProvider>
  )
}
