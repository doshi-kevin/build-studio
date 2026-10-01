/**
 * Professor Notification Preferences page.
 *
 * Server component: loads the professor's saved preferences from
 * profiles.settings.notifications and hands them to the shared client panel. Auth is
 * enforced by middleware; this defends against a missing user defensively.
 *
 * The professor layout also admits institution_admin and course_assistant into the
 * professor area, but this page is professor-only: its save action
 * (updateProfessorNotificationPreferences) accepts only role === 'professor', so a
 * non-professor would land on a panel whose Save always fails. We 404 them instead —
 * matching the disabled "Notifications" header link and the absent /admin/preferences route.
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
import { forgetMemory, updateProfessorNotificationPreferences } from './actions'

const PROFESSOR_KINDS = OPTIONAL_NOTIFICATION_KINDS.filter((k) => k.role === 'professor')
// 'Coursework' must be here so the one professor-facing Coursework kind (quiz_ai_ready) actually
// renders a toggle — PROFESSOR_KINDS is already role-filtered, so no student kinds leak in.
const PROFESSOR_GROUPS = ['Coursework', 'Roster & staff', 'Submissions'] as const

export default async function ProfessorNotificationPreferencesPage() {
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

  if (profile?.role !== 'professor') notFound()

  const prefs = parseNotificationPreferences(profile?.settings)

  // What Athena has remembered about how this professor works. Course-scoped
  // rows show the course's name rather than a uuid, which matters more here than
  // on the student side: a professor's preferences default to one course, so
  // "where does this apply" is the first question they will ask.
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
    courseLabel: r.sectionId ? (courseLabels.get(r.sectionId) ?? 'This course') : null,
    expiresAt: r.expiresAt,
  }))

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Preferences</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose what Scholera notifies you about, and when your daily digest arrives.
        </p>
      </div>
      <NotificationPreferencesPanel
        initialPrefs={prefs}
        kinds={PROFESSOR_KINDS}
        groups={PROFESSOR_GROUPS}
        saveAction={updateProfessorNotificationPreferences}
        mustHaveNote="Critical alerts — office-hours bookings and decisions on your staff requests — always come through, so you never miss something important."
      />

      <div id="memory" className="scroll-mt-20 space-y-3 pt-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">What Athena remembers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When you tell Athena how you want your announcements, quizzes or grading handled, it
            keeps that for next time. It will not remember anything about an individual student, and
            says so when you ask it to. Remove anything you would rather it forgot.
          </p>
        </div>
        <MemoryPanel
          items={memoryItems}
          forgetAction={forgetMemory}
          emptyDescription="Tell Athena how you want your announcements, quizzes or grading handled, and it will work that way next time. Anything it picks up shows here, and you can remove it."
        />
      </div>
    </div>
  )
}
