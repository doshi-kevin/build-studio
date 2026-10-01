/**
 * Roadmap Page — professor view of the course roadmap.
 *
 * Derives roadmap structure from modules + module_items. Node status is DERIVED
 * from what actually happened (Part II §13), never set by hand.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/roadmap
 */

import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { skillQueries } from '@/lib/supabase/queries'
import { buildSkillTree } from '@/lib/skills/tree'
import { resolveSkillMasteryConfig } from '@/lib/skills/config'
import { AutoRoadmapSkeleton } from '@/components/shared/auto-roadmap/AutoRoadmapSkeleton'
import { RoadmapEmptyState } from '@/components/shared/auto-roadmap/RoadmapEmptyState'
import { masteryTier } from '@/lib/skills/mastery'
import { toPrototypeCourse, tierResolver } from '@/lib/roadmap/prototype-adapter'
import { buildConceptRefs } from '@/lib/roadmap/concept-refs'
import { normalizeTopicKey } from '@/lib/roadmap/journey-state'
import { loadRoadmapCoverage } from '@/lib/roadmap/coverage-loader'
import { buildProfessorSignals } from '@/lib/roadmap/roadmap-signals'
import { triageProfessor, FULL_BUDGET } from '@/lib/roadmap/triage'
import { getNodeAssignmentContent, getNodeSessionContent } from '@/lib/roadmap/drawer-actions'
import { readArchivedKeys } from '@/lib/roadmap/archive'
import { RoadmapPrototype } from './RoadmapPrototype'
import { getRoadmapData, getConceptAnalytics, getStudentJourneys, getProfessorAggregates, getStudentNodeCheck, getNodeQuizQuestions } from './actions'
import { getUnconfirmedSkillCount } from '../skills/actions'

interface RoadmapPageProps {
  params: Promise<{ sectionId: string }>
}

export default async function RoadmapPage({ params }: RoadmapPageProps) {
  const { sectionId } = await params
  const supabase = await createClient()

  // The viewing user is this section's professor (getRoadmapData verifies
  // ownership) — their name becomes the sticky-note byline in the new design.
  const { data: { user } } = await supabase.auth.getUser()

  // Topic-mastery SETUP data (curate hierarchy + scoring config) is surfaced
  // via a modal on this page — RLS scopes all reads to the section's prof/TA.
  const [result, concepts, topicRows, hasMaterials, sectionRes, unconfirmed, profileRes] = await Promise.all([
    getRoadmapData(sectionId),
    getConceptAnalytics(sectionId),
    skillQueries.listSectionSkills(supabase, sectionId),
    skillQueries.sectionHasMaterials(supabase, sectionId),
    supabase.from('course_sections').select('settings').eq('id', sectionId).maybeSingle(),
    getUnconfirmedSkillCount(sectionId),
    user ? supabase.from('profiles').select('name').eq('id', user.id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const professorName = (profileRes.data?.name as string | undefined) ?? ''

  /* An ownership denial is not a failure. Checked BEFORE the throw: the course
     layout admits an active TA/grader, but this roadmap is owner-only, so a TA
     reaches here legitimately — and "Couldn't load the roadmap · Try again"
     both lies about what happened and offers a retry that can never succeed.
     404 is also what keeps the denial from confirming the section exists. */
  if (result.denied) {
    logger.warn('RoadmapPage: Not the section owner', { sectionId })
    notFound()
  }

  // A failed query and a missing roadmap are different outcomes: 404 tells the
  // professor "this doesn't exist", which is a lie when the fetch simply broke.
  // Throwing routes it to roadmap/error.tsx, which offers "Try again" with the
  // course rail intact.
  if (result.error) {
    logger.error('RoadmapPage: Failed to load roadmap', result.error, { sectionId })
    throw new Error('Failed to load roadmap')
  }

  if (!result.data) {
    logger.warn('RoadmapPage: Roadmap not found', { sectionId })
    notFound()
  }

  /* Nodes the professor has taken off the map (settings.roadmapArchived). They
     leave the map and wait in the Archive tray, placement untouched, so putting
     one back returns it to exactly the week and column it left. */
  const archivedKeys = readArchivedKeys(sectionRes.data?.settings)

  const topicSetup = {
    initialTree: buildSkillTree(topicRows),
    config: resolveSkillMasteryConfig(sectionRes.data?.settings),
    hasMaterials,
  }

  // Preload student journeys only when the section has graded activity, so the
  // default "class struggle" heat paints immediately without a client fetch (and
  // we skip the load entirely on never-graded courses).
  const hasActivity = (concepts.data?.masteryRows?.length ?? 0) > 0
  const journeysRes = hasActivity ? await getStudentJourneys(sectionId) : null

  // Skill chips are coloured by the class-mastery tier of each topic (score →
  // weak/shaky/strong/none); the kicker reads "WEEK N" when the module has a
  // week, else "MODULE".
  const scoreByName = new Map<string, number | null>()
  if (concepts.data) {
    for (const main of concepts.data.view.ordered) {
      scoreByName.set(main.name.trim().toLowerCase(), main.classScore)
      for (const sub of main.subtopics) scoreByName.set(sub.name.trim().toLowerCase(), sub.classScore)
    }
  }
  // Node coverage (Part II §13): statuses derived from what actually happened —
  // the class that ran, the deck that was advanced, the assessment that closed —
  // instead of a hand-ticked status. `pct` becomes the honest delivery
  // percentage; null coverage leaves the map as-is.
  const coverage = user ? await loadRoadmapCoverage(sectionId, user.id, 'professor', result.data) : null
  const { course, moduleDividers, unplaced, quizUploads, classroomUploads, todayIndex } = toPrototypeCourse(result.data, {
    tierOf: tierResolver(scoreByName, masteryTier),
    coverage: coverage ?? undefined,
    audience: 'prof',
  })
  // Aligned to `course` (which excludes the off-map upload modules), so the
  // kicker/title never drift out of index with the rendered module cards.
  const moduleTitles = course.map((m) => m.title)
  const moduleWeeks = course.map((m) => m.weekNumber ?? null)

  // Nothing to draw yet. The roadmap derives itself from modules, so with none
  // there is no map to author on — point at Modules instead of rendering an empty
  // grid captioned "0% of the course complete", which reads as broken rather than
  // as not-started. Tested against the RENDERED course: a section holding only
  // the hidden upload buckets has weeks but no module band.
  if (course.length === 0) {
    return (
      <RoadmapEmptyState
        audience="prof"
        title="Your roadmap draws itself"
        body="It builds from your modules and the materials in them — add a module and it appears here, with a quiz or assignment sitting under the module you place it in."
        ctaHref={`/professor/courses/${sectionId}/modules`}
        ctaLabel="Go to Modules"
      />
    )
  }

  // Per-skill cross-refs for the node modal's right rail. "Assessed by" comes
  // from the section's concept analytics (keyed by topic id, so it is flattened
  // to names here); "taught in" is derived from the roadmap nodes themselves.
  const assessedByName: Record<string, string[]> = {}
  for (const t of concepts.data?.topics ?? []) {
    assessedByName[normalizeTopicKey(t.name)] = (concepts.data?.sources[t.id] ?? []).map((src) => src.title)
  }
  const conceptRefs = buildConceptRefs(result.data, assessedByName)

  // Triage engine: rank the class-aggregate + action-queue signals into the few
  // annotations/emphasis worth showing (replaces the demo set). RLS scopes the
  // deadline/submission reads to this professor's section.
  const aggregates = await getProfessorAggregates(sectionId)
  const profSignals = await buildProfessorSignals(supabase, sectionId, {
    course,
    roadmapData: result.data,
    coverage,
    extrasCold: aggregates.data?.extrasCold,
    journeys: journeysRes?.data ?? null,
    concepts: concepts.data ?? null,
    itemQuality: aggregates.data?.itemQuality,
    bookingRecent: aggregates.data?.bookingRecent,
    masteryTrend: aggregates.data?.masteryTrend,
    noOpens: aggregates.data?.noOpens,
    openSpike: aggregates.data?.openSpike,
    reDownloads: aggregates.data?.reDownloads,
    revisits: aggregates.data?.revisits,
    clickThroughs: aggregates.data?.clickThroughs,
    quizActivity: aggregates.data?.quizActivity,
    spokenClaims: aggregates.data?.spokenClaims,
    deliveryDepth: aggregates.data?.deliveryDepth,
  })
  // Two detail levels, both pure/cheap: "everything" (default) + curated "focused".
  const { annotations, emphasis } = triageProfessor(course, profSignals, FULL_BUDGET)
  const focused = triageProfessor(course, profSignals)

  return (
    <Suspense fallback={<AutoRoadmapSkeleton audience="prof" />}>
      <RoadmapPrototype
        audience="prof"
        course={course}
        moduleDividers={moduleDividers}
        unplaced={unplaced}
        todayIndex={todayIndex}
        archivedKeys={archivedKeys}
        quizUploads={quizUploads}
        classroomUploads={classroomUploads}
        moduleTitles={moduleTitles}
        moduleWeeks={moduleWeeks}
        professorName={professorName}
        annotations={annotations}
        emphasis={emphasis}
        annotationsFocused={focused.annotations}
        emphasisFocused={focused.emphasis}
        onLoadStudentNodeCheck={getStudentNodeCheck.bind(null, sectionId)}
        onLoadQuizQuestions={getNodeQuizQuestions.bind(null, sectionId)}
        onLoadAssignmentContent={getNodeAssignmentContent.bind(null, sectionId)}
        onLoadSessionContent={getNodeSessionContent.bind(null, sectionId)}
        sectionId={sectionId}
        initialJourneys={journeysRes?.data ?? null}
        concepts={concepts.data ?? null}
        topicSetup={topicSetup}
        unconfirmedTopicCount={unconfirmed.count}
        roadmapData={result.data}
        conceptRefs={conceptRefs}
        coverageDegraded={!!coverage?.degraded}
      />
    </Suspense>
  )
}
