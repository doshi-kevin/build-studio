/**
 * DashboardHeader — top navigation bar shown on every authenticated page.
 *
 * Rendered by the dashboard layout (src/app/(dashboard)/layout.tsx) and receives
 * the user's profile as a prop. Displays:
 * - The Scholera brand name (left side)
 * - A color-coded role badge (red = admin, blue = professor, green = student)
 * - An avatar dropdown with user info, settings placeholders, and logout
 *
 * Logout calls the signOut server action which ends the Supabase session
 * and redirects to /login. The button shows "Logging out..." while pending.
 *
 * Type: Client Component (needs useState for logout loading state)
 * Props: profile (Profile | null) — null when profile hasn't loaded yet
 */
'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Menu, Bell } from 'lucide-react'
import { BrandMark } from '@/components/shared/BrandMark'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { SidebarMobile } from '@/components/dashboard/SidebarMobile'
import { NotificationBell } from '@/components/dashboard/NotificationBell'
import { PreferencesDialog } from '@/components/dashboard/PreferencesDialog'
import { signOut } from '@/app/(dashboard)/dashboard/actions'
import { logger } from '@/lib/logger'
import type { Profile } from '@/lib/supabase/types'

interface DashboardHeaderProps {
  profile: Profile | null
  institutionName?: string | null
}

export function DashboardHeader({ profile, institutionName }: DashboardHeaderProps) {
  const router = useRouter()
  /** Tracks whether the logout server action is in flight */
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  /** Controls the mobile sidebar sheet open/close state */
  const [sidebarOpen, setSidebarOpen] = useState(false)
  /** Controls the Preferences dialog open/close state */
  const [prefsOpen, setPrefsOpen] = useState(false)
  /** Hydration guard — defer Radix dropdowns to client to avoid useId() SSR mismatch */
  const [mounted, setMounted] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true) }, [])

  const profileHref = profile?.role === 'student' ? '/student/profile' : null
  /* The /preferences PAGE per role. It used to be notifications-only and was
     labelled "Notifications", while the per-browser course-rail dialog held the
     name "Preferences" (#394). That mislabelling became load-bearing once Athena
     started telling students "you can change it in your preferences": they
     clicked the item named Preferences and got a rail toggle. The page owns the
     name now; the dialog is called what it actually does. */
  const preferencesHref =
    profile?.role === 'student'
      ? '/student/preferences'
      : profile?.role === 'professor'
        ? '/professor/preferences'
        : null
  /* Display only holds the course-rail open-mode switch, which is meaningless
     for a role that has no course rail — so the group has content only for the
     roles that also have a Profile or Preferences page. */
  const hasSettings = !!profileHref || !!preferencesHref

  /**
   * Calls the signOut server action to end the Supabase session.
   * The server action always redirects to /login (even on error),
   * so setIsLoggingOut(false) only runs if the action throws before redirecting.
   */
  const handleLogout = async () => {
    setIsLoggingOut(true)
    try {
      logger.info('DashboardHeader.handleLogout: Initiating sign out', { email: profile?.email })
      await signOut()
    } catch (error) {
      // Next.js redirect() throws a NEXT_REDIRECT error — re-throw so Next.js handles it
      if (error instanceof Error && error.message?.includes('NEXT_REDIRECT')) {
        throw error
      }
      logger.error('DashboardHeader.handleLogout', error, { email: profile?.email })
      setIsLoggingOut(false)
    }
  }

  /**
   * Derive avatar initials from the user's name or email.
   * "John Doe" → "JD", "john@example.com" → "J", no profile → "U"
   */
  const initials = (profile?.name || profile?.email || 'U')
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase()

  /** Monochrome role badge label */
  const roleLabel = profile?.role === 'institution_admin' ? 'Admin' : profile?.role || 'User'

  return (
    <>
    <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="px-5 py-3 flex justify-between items-center">
        <div className="flex items-center gap-3">
          {/* Hamburger menu — visible only on mobile, opens the sidebar sheet */}
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden h-8 w-8"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
          {/* Brand + institution name (placeholder for future logo). Hidden when
              there's no tenant context (e.g., super_admin platform views). */}
          <div className="flex items-center gap-2">
            <BrandMark className="h-7 w-7" />
            <span className="font-[family-name:var(--font-instrument-serif)] text-[20px] tracking-tight">Schol<em className="italic">era</em></span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Identity cluster — institution (tenant) + role, anchored by the avatar.
              Tenant reads as quiet session-context metadata, always visible. */}
          {institutionName && (
            <>
              <span
                className="hidden md:inline-block max-w-[160px] truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60"
                title={institutionName}
              >
                {institutionName}
              </span>
              <span className="hidden md:block h-4 w-px bg-border" aria-hidden />
            </>
          )}
          {/* Role badge */}
          <div className="flex items-center">
            <span className="text-[11px] font-semibold px-3 py-1 rounded-full border border-border bg-muted/50 text-muted-foreground uppercase tracking-wider">
              {roleLabel}
            </span>
          </div>

          {/* Radix dropdowns deferred to client-only to avoid useId() SSR mismatch */}
          {mounted ? (
            <>
              {profile?.id && <NotificationBell userId={profile.id} />}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="relative h-8 w-8 rounded-full p-0">
                    <Avatar className="h-8 w-8">
                      {profile?.avatar_url && <AvatarImage src={profile.avatar_url} alt={profile.name || 'User'} />}
                      <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">{profile?.name || profile?.email}</p>
                    <p className="text-xs leading-none text-muted-foreground">{profile?.email}</p>
                  </DropdownMenuLabel>
                  {/* Only roles that actually HAVE these destinations get an entry —
                      a permanently-disabled row is a dead end that reads as broken
                      rather than as absent. Display is course-rail-only, so it
                      goes with them: an admin never sees a course rail, which would
                      leave the "Settings" heading over one control that does nothing
                      for them. Gate the whole group, not just its members. */}
                  {hasSettings && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs text-muted-foreground">Settings</DropdownMenuLabel>
                      {profileHref && (
                        <DropdownMenuItem onClick={() => router.push(profileHref)}>
                          Profile
                        </DropdownMenuItem>
                      )}
                      {preferencesHref && (
                        <DropdownMenuItem onClick={() => router.push(preferencesHref)}>
                          Preferences
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => setPrefsOpen(true)}>Display</DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleLogout} disabled={isLoggingOut} className="text-destructive">
                    {isLoggingOut ? 'Logging out...' : 'Logout'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              {/* SSR placeholders — same visual layout, no Radix wrappers */}
              <Button variant="ghost" size="icon" className="relative">
                <Bell className="h-5 w-5" />
                <span className="sr-only">Notifications</span>
              </Button>
              <Button variant="ghost" className="relative h-8 w-8 rounded-full p-0">
                <Avatar className="h-8 w-8">
                  {profile?.avatar_url && <AvatarImage src={profile.avatar_url} alt={profile.name || 'User'} />}
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
    {/* Mobile sidebar — rendered outside header to avoid z-index issues */}
    {mounted && (
      <SidebarMobile
        role={profile?.role || 'student'}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
      />
    )}
    {mounted && <PreferencesDialog open={prefsOpen} onOpenChange={setPrefsOpen} />}
    </>
  )
}
