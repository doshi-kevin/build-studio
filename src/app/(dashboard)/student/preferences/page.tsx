/**
 * Student Notification Preferences page (Scholera Pulse Part 4).
 *
 * Server component: loads the current student's saved preferences from
 * profiles.settings.notifications and hands them to the shared client panel. Auth is
 * enforced by middleware; this defends against a missing user defensively.
 *
 * The student layout also admits institution_admin into the student area, but this page
 * is student-only: its save action (updateNotificationPreferences) accepts only
 * role === 'student', so a non-student would land on a panel whose Save always fails.
 * We 404 them instead — matching the disabled "Notifications" header link for admins.
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  parseNotificationPreferences,
  OPTIONAL_NOTIFICATION_KINDS,
} from '@/lib/validations/notification-preferences'
import { NotificationPreferencesPanel } from '@/components/notifications/NotificationPreferencesPanel'
import { MemoryPanel, type MemoryItem } from '@/components/preferences/MemoryPanel'
import { listPreferences } from '@/lib/memory/preferences'
import { resolveJoin } from '@/lib/supabase/resolve-join'
import { forgetMemory, updateNotificationPreferences } from './actions'

// Kinds without an explicit role are student-facing.
const STUDENT_KINDS = OPTIONAL_NOTIFICATION_KINDS.filter((k) => (k.role ?? 'student') === 'student')
const STUDENT_GROUPS = ['Coursework', 'Announcements & teams', 'Achievements & reminders'] as const

export default async function NotificationPreferencesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: profile } = await adminDb
    .from('profiles')
    .select('settings, role, institution_id')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'student') notFound()

  const prefs = parseNotificationPreferences(profile?.settings)

  // What Athena has remembered. Course-scoped rows are shown with the course's
  // name rather than a uuid, so "this applies where" is answerable at a glance.
  const remembered = await listPreferences(adminDb, {
    userId: user.id,
    institutionId: profile.institution_id,
  })
  const sectionIds = [...new Set(remembered.map((r) => r.sectionId).filter((id): id is string => !!id))]
  const courseLabels = new Map<string, string>()
  if (sectionIds.length > 0) {
    const { data: sections } = await adminDb
      .from('course_sections')
      .select('id, section_code, course:courses(code, title)')
      .in('id', sectionIds)
    for (const s of (sections ?? []) as Array<Record<string, unknown>>) {
      const course = resolveJoin(s.course) as { code?: string; title?: string } | null
      courseLabels.set(s.id as string, course?.code || course?.title || 'This course')
    }
  }
  const memoryItems: MemoryItem[] = remembered.map((r) => ({
    id: r.id,
    text: r.text,
    courseLabel: r.sectionId ? (courseLabels.get(r.sectionId) ?? 'A course') : null,
    expiresAt: r.expiresAt,
  }))

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 pb-32 lg:pb-16">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Preferences</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What Scholera tells you about, and what Athena remembers about you.
        </p>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose what Scholera notifies you about, and when your daily digest arrives.
        </p>
      </div>
      <NotificationPreferencesPanel
        initialPrefs={prefs}
        kinds={STUDENT_KINDS}
        groups={STUDENT_GROUPS}
        saveAction={updateNotificationPreferences}
        /* Deadline reminders were removed from the promise (#695). `deadline_approaching`
           exists in the type union with ZERO producers — notification-preferences.ts even
           carries a comment explaining why it was dropped from MUST_HAVE_TYPES — but this
           copy still guaranteed it. Telling students a reminder "always comes through" when
           nothing emits it is worse than not offering it: they rely on it and miss the
           deadline. Whether to actually build the reminders is a separate feature call. */
        mustHaveNote="Critical alerts, including resubmission requests, enrollment decisions, and office-hours changes, always come through so you never miss something important."
      />

      <div id="memory" className="scroll-mt-20 space-y-3 pt-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">What Athena remembers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When you tell Athena how you like things explained, it keeps that for next time. Remove
            anything you would rather it forgot.
          </p>
        </div>
        <MemoryPanel items={memoryItems} forgetAction={forgetMemory} />
      </div>
    </div>
  )
}
