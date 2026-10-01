/**
 * FileUploadStudio — the guided studio for File Upload assignments.
 *
 * A 2-stage flow (Add files and rubrics, then Publish) that reuses the same shared
 * components as DocumentStudio: StudioHeader, StudioStepNav, SupportingFilesStep,
 * and PublishPanel. There is no document/editor stage.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { renameAssignment, deleteAssignment } from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { StudioStepNav, type SaveState } from './shared/StudioChrome'
import { StudioHeader } from './shared/StudioHeader'
import { SupportingFilesStep } from './shared/SupportingFilesStep'
import { SaveAssignmentDialog } from './shared/SaveAssignmentDialog'
import { useExitGuard } from './shared/useExitGuard'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { PublishPanel } from './PublishPanel'
import type { FileTypeKind, AssignmentRubric, AssignmentPdf, AssessmentConfig, AssignmentRubricSourceFile } from '@/lib/validations/assignment'

type Stage = 'files' | 'publish'
const STAGE_ORDER: Stage[] = ['files', 'publish']

interface Props {
  sectionId: string
  assignmentId: string
  title: string
  initialDueAt?: string | null
  initialFileTypes?: FileTypeKind[]
  initialPoints?: number
  initialIsGraded?: boolean
  initialRubric?: AssignmentRubric | null
  initialRubricDraft?: AssignmentRubric | null
  initialDescription?: string
  initialPdfs?: AssignmentPdf[]
  initialRubricSources?: AssignmentRubricSourceFile[]
  initialStatus?: string
  initialAssessment?: AssessmentConfig
}

export function FileUploadStudio({
  sectionId, assignmentId, title: initialTitle,
  initialDueAt, initialFileTypes, initialPoints = 100, initialIsGraded = true,
  initialRubric = null, initialRubricDraft = null, initialDescription = '', initialPdfs = [], initialRubricSources = [],
  initialStatus, initialAssessment,
}: Props) {
  const router = useRouter()
  const isPublished = initialStatus === 'published'
  const STAGES = ['Add files & rubrics', isPublished ? 'Publish changes' : 'Publish'] as readonly string[]
  // Back, Save, Publish, and Discard all return to the assignments list (a detail URL would 404
  // after a discard deletes the assignment).
  const backUrl = `/professor/courses/${sectionId}/assignments`

  const [title, setTitle] = useState(initialTitle)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [stage, setStage] = useState<Stage>('files')
  const [exitGuardOpen, setExitGuardOpen] = useState(false)
  const [rubric, setRubric] = useState<AssignmentRubric | null>(initialRubric)
  // Working rubric draft, lifted here so it survives the files step unmounting between steps.
  const [rubricDraft, setRubricDraft] = useState<AssignmentRubric | null>(initialRubricDraft)

  const stageIndex = STAGE_ORDER.indexOf(stage)

  function nextStep() {
    if (stageIndex < STAGE_ORDER.length - 1) setStage(STAGE_ORDER[stageIndex + 1])
  }

  function prevStep() {
    if (stageIndex > 0) setStage(STAGE_ORDER[stageIndex - 1])
  }

  // Exit guard: prompt before leaving a draft (published assignments never nag).
  useExitGuard({
    active: !isPublished,
    onRequestExit: () => setExitGuardOpen(true),
  })

  async function handleSave(savedTitle: string) {
    const next = savedTitle.trim()
    if (!next) return
    setExitGuardOpen(false)
    if (next !== title) {
      setSaveState('saving')
      const renamed = await renameAssignment(sectionId, assignmentId, next)
      if ('error' in renamed) {
        setSaveState('error')
        toast.error(renamed.error)
        return
      }
      setTitle(next)
      setSaveState('saved')
    }
    router.push(backUrl)
  }

  // Discard: permanently delete the draft, then navigate away.
  async function handleDiscard() {
    setExitGuardOpen(false)
    // Check the result before navigating: a failed delete used to land the professor back on the
    // list with the draft still there and no explanation, reading as a silent success.
    const res = await deleteAssignment(sectionId, assignmentId)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    toast.success('Draft deleted.')
    router.push(backUrl)
  }

  function saveTitle() {
    const next = title.trim()
    if (!next || next === initialTitle) return
    renameAssignment(sectionId, assignmentId, next)
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <StudioHeader
        backUrl={backUrl}
        backLabel="Back to assignments"
        title={title}
        initialTitle={initialTitle}
        onTitleChange={setTitle}
        onCommitTitle={saveTitle}
        saveState={saveState}
        untitledLabel="Untitled assignment"
        onRequestExit={!isPublished ? () => setExitGuardOpen(true) : undefined}
        center={
          <StudioStepNav
            steps={STAGES}
            active={stageIndex}
            onPrev={prevStep}
            onNext={nextStep}
            hideNext={stage === 'publish'}
          />
        }
      >
        {/* Athena's ask line — the entry to the shared dock. */}
        <AthenaAskLine />
      </StudioHeader>

      <div className="relative flex min-h-0 flex-1">
        {stage === 'publish' ? (
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {/* No contentEmpty prop here, deliberately: a file-upload assignment's content IS the
                student's upload, and it already can't publish without an accepted file type.
                Instructions/PDFs live in SupportingFilesStep's own state, so deriving emptiness
                from the initial props would warn falsely for anything typed this session. */}
            <PublishPanel
              sectionId={sectionId}
              published={isPublished}
              assignmentId={assignmentId}
              defaultTitle={title}
              onNameSaved={setTitle}
              defaultDueAt={initialDueAt}
              defaultFileTypes={initialFileTypes}
              defaultAssessment={initialAssessment}
              defaultPoints={initialPoints}
              defaultIsGraded={initialIsGraded}
              requireFileTypes
            />
          </div>
        ) : (
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <SupportingFilesStep
              sectionId={sectionId}
              assignmentId={assignmentId}
              contentKind={null}
              initialDescription={initialDescription}
              initialPdfs={initialPdfs}
              initialRubricSources={initialRubricSources}
              initialRubric={rubric}
              initialRubricDraft={rubricDraft}
              onRubricDraftChange={setRubricDraft}
              initialPoints={initialPoints}
              onRubricSaved={setRubric}
            />
          </div>
        )}
      </div>

      <SaveAssignmentDialog
        open={exitGuardOpen}
        onOpenChange={setExitGuardOpen}
        defaultTitle={title}
        onSave={handleSave}
        onDiscard={!isPublished ? handleDiscard : undefined}
        saving={saveState === 'saving'}
      />
    </div>
  )
}
