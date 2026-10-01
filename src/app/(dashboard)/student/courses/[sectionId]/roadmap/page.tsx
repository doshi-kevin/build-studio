/**
 * Student Roadmap Page — the student's view of the course roadmap.
 *
 * Derives roadmap from modules + module_items. Coverage is derived, and the only
 * state the student owns is their own check-offs / node checks.
 *
 * Type: Server Component
 * Route: /student/courses/[sectionId]/roadmap
 */

import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { logger } from '@/lib/logger'
import { AutoRoadmapSkeleton } from '@/components/shared/auto-roadmap/AutoRoadmapSkeleton'
import { RoadmapEmptyState } from '@/components/shared/auto-roadmap/RoadmapEmptyState'
import { masteryTier } from '@/lib/skills/mastery'
import { toPrototypeCourse, tierResolver } from '@/lib/roadmap/prototype-adapter'
import { buildConceptRefs } from '@/lib/roadmap/concept-refs'
import { loadRoadmapCoverage } from '@/lib/roadmap/coverage-loader'
import { createClient } from '@/lib/supabase/server'
import { buildStudentSignals } from '@/lib/roadmap/roadmap-signals'
import { triageStudent, FULL_BUDGET } from '@/lib/roadmap/triage'
import { getNodeAssignmentContent, getNodeSessionContent } from '@/lib/roadmap/drawer-actions'
import { readArchivedKeys, stripArchived } from '@/lib/roadmap/archive'
import { RoadmapPrototype } from '@/app/(dashboard)/professor/courses/[sectionId]/roadmap/RoadmapPrototype'
import { getRoadmapData, getMyConceptScores, getStudentActivity, getStudentAggregates, setMyNodeCheckedOff, getMyNodeCheck, getMyBakingNodes, submitMyNodeCheck, getNodeQuizQuestions, getMyRoadmapArtifacts, saveMyArtifactState, setMyArtifactArchived, deleteMyArtifact } from './actions'
import { verifyFeatureEnabled } from '@/lib/validations/features'

interface StudentRoadmapPageProps {
  params: Promise<{ sectionId: string }>
}

/**
 * Nothing to draw: the course has no module the student is shown.
 *
 * The exit is course home, deliberately — not Modules (this state exists BECAUSE
 * there are no modules, so it would chain into that page's own empty state) and
 * not quizzes or assignments (both are professor-toggleable features, so a hard
 * link can point at something switched off).
 */
function EmptyRoadmap({ sectionId }: { sectionId: string }) {
  return (
    <RoadmapEmptyState
      audience="stu"
      title="No roadmap yet"
      body="Your instructor hasn’t set up modules for this course yet — the map draws itself as soon as they do."
      ctaHref={`/student/courses/${sectionId}`}
      ctaLabel="Back to course"
    />
  )
}

export default async function StudentRoadmapPage({ params }: StudentRoadmapPageProps) {
  const { sectionId } = await params

  /* Guard the PAGE, not just the layout: segments render in parallel, so a layout
     denial does not stop this component executing and streaming its payload.
     Also re-verifies session + enrollment. */
  await verifyFeatureEnabled(sectionId, 'roadmap')

  const [result, scoresRes, artifactsRes] = await Promise.all([
    getRoadmapData(sectionId),
    getMyConceptScores(sectionId),
    // Athena's margin notes for this student. A failed read costs the lane,
    // never the page — the map is the primary surface here.
    getMyRoadmapArtifacts(sectionId),
  ])

  /* An authorization denial is not a failure: "Try again" can never fix it, and
     saying more than "not found" would confirm the section exists. The course
     layout 404s a non-enrolled student before this renders, so this is
     defence-in-depth — but the two checks have diverged before. */
  if (result.denied) {
    logger.warn('StudentRoadmapPage: Not enrolled', { sectionId })
    notFound()
  }

  // A failed query is not a missing page — 404 would tell the student the course
  // roadmap doesn't exist when the fetch merely broke. Throwing routes it to
  // roadmap/error.tsx, which offers "Try again" with the course rail intact.
  if (result.error) {
    logger.error('StudentRoadmapPage: Failed to load roadmap', result.error, { sectionId })
    throw new Error('Failed to load roadmap')
  }

  /* No error and no payload shouldn't happen (assembleRoadmapData always returns
     a value), so this is type-narrowing plus an alarm — NOT the empty state.
     Telling the student "your instructor hasn't set up modules" here would be
     asserting something the page can't know. Matches the professor twin. */
  if (!result.data) {
    logger.warn('StudentRoadmapPage: Roadmap not found', { sectionId })
    notFound()
  }

  // Student flavour: skill chips are coloured by the student's OWN mastery tiers
  // (never class aggregates), annotations use the student wording set, and the
  // professor-only off-map bench stays hidden — the audience comes from the
  // authenticated role, not a toggle.
  const scoreByName = new Map<string, number | null>()
  for (const [key, c] of Object.entries(scoresRes.data?.concepts ?? {})) scoreByName.set(key, c.score)
  // Node coverage (Part II §13). Class-wide delivery — "how much of this course
  // has actually been taught" — which is also the ceiling on the student's own
  // coverage (§11 decision 10). Only derived statuses cross into the client; the
  // counts they came from stay inside loadRoadmapCoverage.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const coverage = user ? await loadRoadmapCoverage(sectionId, user.id, 'student', result.data) : null
  /* Nodes the professor archived (settings.roadmapArchived). Off the map means
     off BOTH maps — a card the professor has put away is not still assigned.
     Stripped HERE, on the server, not by the canvas: RoadmapPrototype is a client
     component, so a course filtered in the browser still ships every archived
     card — titles, hrefs and signed file URLs — to the student who was not meant
     to see them any more. A failed settings read is logged and treated as "none
     archived": the map is the primary surface and must still draw. */
  const { data: sectionRow, error: sectionErr } = await supabase
    .from('course_sections').select('settings').eq('id', sectionId).maybeSingle()
  if (sectionErr) logger.warn('StudentRoadmapPage: settings read failed — archived nodes will render', { sectionId })
  const archivedKeys = readArchivedKeys(sectionRow?.settings)
  const archivedSet = new Set(archivedKeys)
  const { course: fullCourse, moduleDividers, todayIndex } = toPrototypeCourse(result.data, {
    tierOf: tierResolver(scoreByName, masteryTier),
    coverage: coverage ?? undefined,
    audience: 'stu',
  })
  const course = stripArchived(fullCourse, archivedSet)
  const moduleTitles = course.map((m) => m.title)
  const moduleWeeks = course.map((m) => m.weekNumber ?? null)

  // The student's own overall mastery — the same direct skill-score roll-up
  // the professor's roster reads, so the two roles always agree.
  const myMasteryPct = scoresRes.data?.masteryPct ?? null

  // Nothing to draw. Tested against the RENDERED course, not the payload: a
  // section can carry resources the student is never shown here (an unplaced
  // quiz has no module band to sit in), and counting those suppressed this
  // state in favour of a bare grid captioned "0% of the course".
  if (course.length === 0) return <EmptyRoadmap sectionId={sectionId} />

  // Cross-refs for the node modal. The student's own concept map is already
  // keyed by normalised name, so "assessed by" only needs flattening to titles.
  const assessedByName: Record<string, string[]> = {}
  for (const [name, c] of Object.entries(scoresRes.data?.concepts ?? {})) {
    assessedByName[name] = c.assessedBy.map((a) => a.title)
  }
  /* Scoped to what the student can actually see: `course` has the archived nodes
     stripped, so a cross-reference can't name a card that has left their map. */
  const onMapTitles = new Set(course.flatMap((m) => [
    ...m.materials.map((r) => r.t), ...m.quizzes.map((r) => r.t), ...m.assignments.map((r) => r.t),
  ]))
  const conceptRefs = buildConceptRefs(result.data, assessedByName, onMapTitles)

  // Triage engine (student voice): self + next-step signals only. The activity
  // read runs in an enrollment-verified admin action (getStudentActivity) — quiz
  // tables are RLS-deny-all — and returns only the student's own completion + due
  // dates, never scores. buildStudentSignals is then pure.
  const [activityRes, aggregatesRes] = await Promise.all([getStudentActivity(sectionId), getStudentAggregates(sectionId)])
  /* The canvas's own complete/in-progress/not-started tally is class-wide
     delivery, identical for every student in the section — the professor's
     view of it is correct as-is. This is the one number on the page that's
     actually personal, built from data getStudentActivity already reads (this
     student's own quiz-attempt + assignment-submission status), without
     touching the shared delivery engine those canvas numbers come from. */
  const gradedTotal = (activityRes.data?.assignments.length ?? 0) + (activityRes.data?.quizzes.length ?? 0)
  const gradedDone =
    (activityRes.data?.assignments.filter((a) => a.mySubmission && a.mySubmission !== 'draft').length ?? 0) +
    (activityRes.data?.quizzes.filter((q) => q.completed).length ?? 0)
  // One source for both Athena study affordances: the canvas note (S19, via the
  // triage engine) and the node modal's per-skill link. There is no AI-Tutor
  // page any more — consumers append `?athena-topic=<topic>`, which the
  // AthenaShell in the course layout turns into an opened, pre-filled palette.
  const aiTutorHref = scoresRes.data?.aiTutorEnabled ? `/student/courses/${sectionId}/roadmap` : undefined
  const stuSignals = buildStudentSignals(
    activityRes.data ?? { assignments: [], quizzes: [] },
    { course, roadmapData: result.data, concepts: scoresRes.data ?? null, coverage, aiTutorHref },
    aggregatesRes.data ?? { noImprovement: [], slowWrong: [], absenceGap: [] },
  )
  // Two detail levels, both pure/cheap: "everything" (default) + curated "focused".
  const { annotations, emphasis } = triageStudent(course, stuSignals, FULL_BUDGET)
  const focused = triageStudent(course, stuSignals)

  return (
    <div className="flex h-full w-full flex-col">
      {/* Normal flow, not an overlay: .rmproto below runs isolation:isolate with
          z-index left at auto (roadmap-prototype.css) specifically so nothing
          outside it can paint above the canvas's own layers (drawers, an open
          node card at z-95, a hovered node at z-1000) — any sibling here with a
          positive z-index would sit on top of ALL of that instead, including an
          open modal. A shrink-0 flow element above the flex-1 canvas avoids the
          whole stacking question, at the cost of a few px of canvas height. */}
      {gradedTotal > 0 && (
        <p className="mb-2 shrink-0 text-xs text-muted-foreground">
          {gradedDone} of {gradedTotal} graded items submitted
        </p>
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<AutoRoadmapSkeleton audience="stu" />}>
          <RoadmapPrototype
            audience="stu"
            course={course}
            moduleDividers={moduleDividers}
            unplaced={[]}
            todayIndex={todayIndex}
            quizUploads={[]}
            classroomUploads={[]}
            moduleTitles={moduleTitles}
            moduleWeeks={moduleWeeks}
            annotations={annotations}
            emphasis={emphasis}
            annotationsFocused={focused.annotations}
            emphasisFocused={focused.emphasis}
            /* Weak/shaky skills offer the AI Tutor, prefilled — only when the
               section actually has the feature on. */
            aiTutorHref={aiTutorHref}
            conceptRefs={conceptRefs}
            coverageDegraded={!!coverage?.degraded}
            myMasteryPct={myMasteryPct}
            onSelfCheck={setMyNodeCheckedOff.bind(null, sectionId)}
            onLoadNodeCheck={getMyNodeCheck.bind(null, sectionId)}
            onPollBaking={getMyBakingNodes.bind(null, sectionId)}
            onSubmitNodeCheck={submitMyNodeCheck.bind(null, sectionId)}
            onLoadQuizQuestions={getNodeQuizQuestions.bind(null, sectionId)}
            onLoadAssignmentContent={getNodeAssignmentContent.bind(null, sectionId)}
            onLoadSessionContent={getNodeSessionContent.bind(null, sectionId)}
            /* Athena's margin notes — her lane on the right edge of the map. */
            athenaArtifacts={artifactsRes.data ?? []}
            onSaveArtifactState={saveMyArtifactState.bind(null, sectionId)}
            onArchiveArtifact={setMyArtifactArchived.bind(null, sectionId)}
            onDeleteArtifact={deleteMyArtifact.bind(null, sectionId)}
          />
        </Suspense>
      </div>
    </div>
  )
}
