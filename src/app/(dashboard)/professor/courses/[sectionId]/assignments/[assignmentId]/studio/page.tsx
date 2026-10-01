/**
 * Notebook Studio — the editor a notebook assignment opens into.
 *
 * Type: Server Component
 * Route: /professor/courses/[sectionId]/assignments/[assignmentId]/studio
 *
 * Reads the notebook from assignments.settings.studio (RLS scopes the read to the
 * professor's section). Edits autosave via the saveStudioNotebook server action.
 */
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { StudioShell } from '@/components/professor/assignments/studio/StudioShell'
import { DocumentStudio } from '@/components/professor/assignments/studio/DocumentStudio'
import { FileUploadStudio } from '@/components/professor/assignments/studio/FileUploadStudio'
import { emptyNotebook, type StudioNotebook } from '@/lib/assignments/studio/notebook-model'
import { parseAccepts, parseRubric, parseRubricDraft, mergeRubricAi, parseAssignmentPdfs, parseAssessment, parseRubricSources } from '@/lib/validations/assignment'
import { loadRubricAi } from '@/lib/assignments/ai-grading/answer-key'
import { parseAssignmentDocument, emptyAssignmentDocument } from '@/lib/validations/studio'
import type { JSONContent } from 'novel'

interface StudioPageProps {
  params: Promise<{ sectionId: string; assignmentId: string }>
  searchParams: Promise<{ step?: string }>
}

interface StoredStudioDoc {
  version: number
  templateId: string | null
  notebook: StudioNotebook
  resources?: { links: { label: string; url: string }[]; moduleTags: string[] }
}

export default async function StudioPage({ params, searchParams }: StudioPageProps) {
  const { sectionId, assignmentId } = await params
  // Deep link into the "Add files & rubrics" step (e.g. returning from the
  // Answer Key Studio). FileUploadStudio starts there already.
  const initialStage = (await searchParams).step === 'files' ? ('files' as const) : undefined
  const supabase = await createClient()

  // RLS ("Professors and TAs can manage section assignments") scopes the read.
  const { data } = await supabase
    .from('assignments')
    .select('id, title, section_id, settings, due_at, points, is_graded, description, status')
    .eq('id', assignmentId)
    .maybeSingle()

  if (!data || data.section_id !== sectionId) notFound()

  const settings = (data.settings ?? {}) as Record<string, unknown>

  // The answer-key AI fields (reference answers, keywords) live off settings in the staff-only
  // assignment_answer_keys row (BLOCKER #1). Merge them back so the rubric editor here shows +
  // re-saves them instead of wiping them on autosave. The section-scoped RLS SELECT policy lets
  // the professor read this row through the same user client. mergeInitialRubrics builds the
  // merged approved rubric + draft the shells seed from.
  const rubricAi = await loadRubricAi(supabase, assignmentId)
  const mergeInitialRubrics = () => ({
    rubric: (() => {
      const r = parseRubric(settings)
      return r ? mergeRubricAi(r, rubricAi.approved) : null
    })(),
    draft: (() => {
      const d = parseRubricDraft(settings)
      return d ? mergeRubricAi(d, rubricAi.draft) : null
    })(),
  })
  const merged = mergeInitialRubrics()

  // "Blank" document assignments use the Notion-style editor, not the cell-based studio.
  if (settings.kind === 'document') {
    const document = parseAssignmentDocument(settings) ?? emptyAssignmentDocument()
    return (
      <DocumentStudio
        sectionId={sectionId}
        assignmentId={assignmentId}
        title={data.title}
        initialDoc={document.doc as unknown as JSONContent}
        initialDueAt={data.due_at}
        initialFileTypes={parseAccepts(settings).fileTypes}
        initialPoints={Number(data.points) || 0}
        initialRubric={merged.rubric}
        initialRubricDraft={merged.draft}
        initialDescription={data.description ?? ''}
        initialPdfs={parseAssignmentPdfs(settings)}
        initialRubricSources={parseRubricSources(settings)}
        initialStatus={data.status}
        initialAssessment={parseAssessment(settings)}
        initialStage={initialStage}
      />
    )
  }

  // File Upload assignments use a 2-stage guided studio (files + rubric, then publish).
  if (settings.kind === 'file-upload') {
    return (
      <FileUploadStudio
        sectionId={sectionId}
        assignmentId={assignmentId}
        title={data.title}
        initialDueAt={data.due_at}
        initialFileTypes={parseAccepts(settings).fileTypes}
        initialPoints={Number(data.points) || 0}
        initialIsGraded={data.is_graded !== false}
        initialRubric={merged.rubric}
        initialRubricDraft={merged.draft}
        initialDescription={data.description ?? ''}
        initialPdfs={parseAssignmentPdfs(settings)}
        initialRubricSources={parseRubricSources(settings)}
        initialStatus={data.status}
        initialAssessment={parseAssessment(settings)}
      />
    )
  }

  const stored = settings.studio as StoredStudioDoc | undefined
  const initialDoc: StoredStudioDoc = stored ?? { version: 1, templateId: null, notebook: emptyNotebook() }

  return (
    <StudioShell
      sectionId={sectionId}
      assignmentId={assignmentId}
      title={data.title}
      initialDoc={initialDoc}
      initialDueAt={data.due_at}
      initialFileTypes={parseAccepts(settings).fileTypes}
      initialPoints={Number(data.points) || 0}
      initialRubric={merged.rubric}
      initialRubricDraft={merged.draft}
      initialDescription={data.description ?? ''}
      initialPdfs={parseAssignmentPdfs(settings)}
      initialRubricSources={parseRubricSources(settings)}
      initialStatus={data.status}
      initialAssessment={parseAssessment(settings)}
      initialStage={initialStage}
    />
  )
}
