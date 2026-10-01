/**
 * Answer Key Studio: dedicated page for creating and reviewing an assignment's
 * answer key for AI grading. Entered from the "Create answer key for grading"
 * button on the assignment's Rubrics tab.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/[assignmentId]/answer-key
 */

import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { verifySectionAccess, canWriteAsStaff } from '@/lib/auth/section-access'
import { assignmentQueries } from '@/lib/supabase/queries'
import { AnswerKeyStudio } from '@/components/professor/assignments/AnswerKeyStudio'
import { loadAnswerKeyText, loadAnswerKeySource, loadRubricAi } from '@/lib/assignments/ai-grading/answer-key'
import {
  parseRubric,
  parseRubricDraft,
  mergeRubricAi,
  parseAnswerKeySource,
  parseAiGradingState,
} from '@/lib/validations/assignment'

interface PageProps {
  params: Promise<{ sectionId: string; assignmentId: string }>
  searchParams: Promise<{ from?: string }>
}

export default async function AnswerKeyPage({ params, searchParams }: PageProps) {
  const { sectionId, assignmentId } = await params
  const { from } = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const access = user ? await verifySectionAccess(sectionId, user.id) : { ok: false as const }
  if (!access.ok || !canWriteAsStaff(access.role)) notFound()

  const assignment = await assignmentQueries.getAssignment(access.adminDb, assignmentId)
  if (!assignment || assignment.section_id !== sectionId) notFound()

  // Staff-only reads: the key text (powers client-side keyword hygiene checks), the answer-key
  // pointer, and the answer-key AI fields (rubric_ai) — all off the staff-only row now, never
  // settings (BLOCKER #1). The editor gets the MERGED rubric so the professor sees + edits the
  // reference answers.
  const [keyText, answerKeySourceRow, rubricAi] = await Promise.all([
    loadAnswerKeyText(access.adminDb, { id: assignmentId, institutionId: assignment.institution_id, sectionId }),
    loadAnswerKeySource(access.adminDb, assignmentId),
    loadRubricAi(access.adminDb, assignmentId),
  ])
  // Fall back to the legacy settings pointer only for pre-migration rows missing a source_path.
  const answerKeySource = answerKeySourceRow ?? parseAnswerKeySource(assignment.settings)
  const publicRubric = parseRubric(assignment.settings)
  const publicDraft = parseRubricDraft(assignment.settings)

  return (
    <AnswerKeyStudio
      sectionId={sectionId}
      assignmentId={assignmentId}
      assignmentTitle={assignment.title}
      initialRubric={publicRubric ? mergeRubricAi(publicRubric, rubricAi.approved) : null}
      initialDraft={publicDraft ? mergeRubricAi(publicDraft, rubricAi.draft) : null}
      answerKeySource={answerKeySource}
      keyText={keyText}
      initialAiStatus={parseAiGradingState(assignment.settings).status}
      fromStudio={from === 'studio'}
    />
  )
}
