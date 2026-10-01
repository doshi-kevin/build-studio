/**
 * Professor Quizzes Page — entry point for quiz management.
 * Wrapped in Suspense for useSearchParams() support in child components.
 *
 * `?action=create` (the dashboard's "Create a Quiz" quick action) is resolved
 * entirely here, server-side, before the list ever renders — see the comment
 * below for why this replaced a client-side create-and-navigate.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/quizzes
 */

import { headers } from 'next/headers'
import { verifyEntitled } from '@/lib/entitlements/check'
import { createAdminClient as createEntitlementDb } from '@/lib/supabase/admin'
import { notFound, redirect } from 'next/navigation'
import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { QuizDashboard } from '@/components/professor/quizzes/QuizDashboard'
import { getOrCreateEmptyDraft } from './actions'
import { logger } from '@/lib/logger'

interface QuizzesPageProps {
  params: Promise<{ sectionId: string }>
  searchParams: Promise<{ action?: string }>
}

export default async function QuizzesPage({ params, searchParams }: QuizzesPageProps) {
  const { sectionId } = await params
  const { action } = await searchParams

  /* The institution ceiling. A feature the school has not bought is a dead end,
     not a page whose buttons happen to fail (.claude/rules/dead-ends.md). Runs
     before anything else on this page, including the write-on-GET branch below.
     Existing rows stay readable through their own detail routes and Grades. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await verifyEntitled(createEntitlementDb() as any, sectionId, 'quizzes')

  // Dashboard quick-action deep link. Used to create the draft client-side (in
  // QuizList, via a `?action=create`-triggered effect) and navigate to it. That
  // raced this list's OWN mount-time data fetch (refetch() fires two server
  // actions on every mount) — when one of those resolved after the navigation to
  // the editor had committed, Next's router could snap the URL back to this
  // page, which re-mounted the list and re-fired the create effect, looping.
  // Resolving it here removes the race outright: this page never renders the
  // list for this request, so there's nothing left for a stray action response
  // to revert to.
  //
  // IMPORTANT: this branch WRITES during a GET render, which is only safe
  // because of the two guards below. Never render this URL as a prefetchable
  // `<Link href>` — Next would fire the create with no click at all. The
  // dashboard reaches it via `router.push()` from a <button>, deliberately.
  if (action === 'create') {
    // A write on a GET is CSRF-reachable via top-level navigation (Supabase's
    // auth cookies are SameSite=Lax, which permits it), so require a
    // same-origin navigation. This also stops cross-site link scanners — though
    // those are cookieless anyway, so they'd fail the auth check below regardless.
    //
    // It does NOT stop an internal Next `<Link>` prefetch: that is `same-origin`
    // and passes this guard, firing the create with no click. The no-`<Link>`
    // rule in the block comment above is still the ONLY thing protecting that.
    //
    // `sec-fetch-site` absent → allowed, deliberately: `Sec-Fetch-*` are
    // forbidden header names, so page JS can neither forge nor strip them. An
    // absent header means a non-browser client (no ambient cookie, so not CSRF)
    // or a pre-2020 browser; blocking it would break those for no gain.
    // `none` → allowed: it means no initiating context (address bar, bookmark,
    // session restore). An attacker page navigating top-level is the initiator,
    // so it sends `cross-site`, never `none`.
    const secFetchSite = (await headers()).get('sec-fetch-site')
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      redirect(`/professor/courses/${sectionId}/quizzes`)
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    // Not the professor's section (or it doesn't exist) — a resource-keyed
    // denial, so it "doesn't exist" rather than admitting the section is real.
    const access = user ? await verifySectionAccess(sectionId, user.id) : { ok: false as const }
    if (!access.ok) notFound()

    // Read access isn't write access: `verifySectionAccess` also admits graders,
    // but `getOrCreateEmptyDraft` gates on `canWriteAsStaff` (professor/TA only).
    // Without this check a grader would fail inside the action and land in the
    // error log below, which claims to only ever fire on a real DB fault.
    // They keep read access to the list — just no auto-create.
    if (canWriteAsStaff(access.role)) {
      const draft = await getOrCreateEmptyDraft(sectionId)
      if (draft.data) {
        redirect(`/professor/courses/${sectionId}/quizzes/${draft.data.id}?intent=setup`)
      }
      // Write access is established above, so anything here is a genuine failure
      // (DB hiccup, insert rejected) — fall through to the list so the professor
      // can still create a quiz manually, rather than a dead end.
      logger.error('QuizzesPage.action-create', draft.error, { sectionId })
    }
  }

  return (
    <>
      <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
        <QuizDashboard sectionId={sectionId} />
      </Suspense>
      {/* Nothing registers a surface from the list, so Athena is a course-level brainstorm
          here rather than an editor driver — it can talk about quizzes, not edit one. */}
      <AthenaAskLine />
    </>
  )
}
