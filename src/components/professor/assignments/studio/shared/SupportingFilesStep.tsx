/**
 * SupportingFilesStep — the shared "Add files & rubrics" stage for the assignment studios.
 *
 * Written instructions (saved to the assignment description on blur), optional PDF briefs (one or
 * many), and the grading rubric. All persist through vetted server actions; nothing here is graded.
 * Extracted from StudioShell so the notebook studio and the document studio present the identical
 * middle step.
 *
 * Type: Client Component
 */
'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { UploadCloud, FileText, Loader2, X, KeyRound } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  saveAssignmentInstructions,
  uploadAssignmentPdf,
  removeAssignmentPdf,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { RubricEditor } from '@/components/professor/assignments/RubricEditor'
import { AssignmentModuleTags, type SkillTaggingState } from '@/components/professor/assignments/AssignmentModuleTags'
import { useAthenaDock } from '@/components/professor/assignments/athena/AssignmentAthenaDock'
import {
  MAX_ASSIGNMENT_PDFS,
  type AssignmentRubric,
  type AssignmentPdf,
  type AssignmentRubricSourceFile,
} from '@/lib/validations/assignment'

export function SupportingFilesStep({
  sectionId, assignmentId, contentKind, initialDescription, initialPdfs, initialRubricSources, initialRubric, initialRubricDraft, onRubricDraftChange, onRubricSaved, initialPoints,
}: {
  sectionId: string
  assignmentId: string
  /** The assignment's own content type — offered as a rubric-generation source alongside PDFs. null = no content source (e.g. file-upload assignments). */
  contentKind: 'notebook' | 'document' | null
  initialDescription: string
  initialPdfs: AssignmentPdf[]
  /** Rubric-only uploaded files — never shown to students. */
  initialRubricSources: AssignmentRubricSourceFile[]
  initialRubric: AssignmentRubric | null
  /** Autosaved, not-yet-approved rubric draft — seeds the editor so it survives navigation. */
  initialRubricDraft?: AssignmentRubric | null
  /** Lifts working-draft changes to the parent studio so they survive step navigation (this step
   *  unmounts between steps). */
  onRubricDraftChange?: (draft: AssignmentRubric | null) => void
  initialPoints: number
  onRubricSaved: (rubric: AssignmentRubric) => void
}) {
  const { entitled: athenaEntitled } = useAthenaDock()
  const [description, setDescription] = useState(initialDescription)
  const [savedDescription, setSavedDescription] = useState(initialDescription)
  const [pdfs, setPdfs] = useState<AssignmentPdf[]>(initialPdfs)
  const [savingDesc, setSavingDesc] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  // Module + skill tagging state, lifted from the AssignmentModuleTags field so the
  // rubric editor can gate generation/save and offer per-question skill options.
  const [skillTagging, setSkillTagging] = useState<SkillTaggingState>({
    loading: true,
    required: false,
    moduleIds: [],
    skillOptions: [],
  })

  async function persistInstructions() {
    if (description === savedDescription) return
    setSavingDesc(true)
    const res = await saveAssignmentInstructions(sectionId, assignmentId, description)
    setSavingDesc(false)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    setSavedDescription(description)
  }

  async function onPdfPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const fd = new FormData()
    fd.append('pdf', file)
    setUploading(true)
    const res = await uploadAssignmentPdf(sectionId, assignmentId, fd)
    setUploading(false)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    setPdfs(res.pdfs)
    toast.success('PDF uploaded')
  }

  async function removePdf(path: string) {
    setRemoving(path)
    const res = await removeAssignmentPdf(sectionId, assignmentId, path)
    setRemoving(null)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    setPdfs(res.pdfs)
    toast.success('PDF removed')
  }

  const dirty = description !== savedDescription

  return (
    <main className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-background p-4">
      {/* pb-24 below md lets the last card scroll clear of the floating Ask Athena pill (#539). */}
      <div className="mx-auto max-w-2xl space-y-6 pt-6 pb-24 md:pb-6">
        <div>
          <h2 className="font-[family-name:var(--font-instrument-serif)] text-2xl tracking-tight text-foreground">
            Add files &amp; rubrics
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Give students written instructions and, optionally, one or more PDF briefs, and set the grading rubric. All show alongside the assignment.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="assignment-instructions" className="text-sm font-medium text-foreground">Instructions</label>
            <span className="text-xs text-muted-foreground">
              {savingDesc ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
            </span>
          </div>
          <Textarea
            id="assignment-instructions"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={persistInstructions}
            placeholder="What should students do? Outline the task, expectations, and how they'll be graded."
            className="min-h-40"
            maxLength={20000}
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            PDF briefs <span className="font-normal text-muted-foreground">(optional)</span>
          </p>

          {pdfs.length > 0 && (
            <ul className="space-y-2">
              {pdfs.map((p) => (
                <li key={p.path} className="flex items-center gap-3 rounded-2xl border border-border p-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <FileText className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{p.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removePdf(p.path)}
                    disabled={removing === p.path}
                    aria-label={`Remove ${p.name}`}
                  >
                    {removing === p.path ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {pdfs.length < MAX_ASSIGNMENT_PDFS && (
            <button
              type="button"
              onClick={() => pdfRef.current?.click()}
              disabled={uploading}
              className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/30 disabled:opacity-60"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <UploadCloud className="h-5 w-5" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{pdfs.length ? 'Add another PDF' : 'Upload a PDF'}</span>
                <span className="block text-xs text-muted-foreground">PDF up to 25 MB</span>
              </span>
            </button>
          )}
          <input ref={pdfRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onPdfPicked} />
        </div>

        {/* Module tagging sits right above the rubric: compulsory, and the source of every
            skill tag on the rubric's questions. */}
        <AssignmentModuleTags sectionId={sectionId} assignmentId={assignmentId} onStateChange={setSkillTagging} />

        {/* One loud entry to the Answer Key Studio: professors don't dig through dropdowns,
            and the button states the outcome. */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">AI grading</p>
            <p className="text-xs text-muted-foreground">
              Upload your solutions once and get draft grades for every submission.
            </p>
          </div>
          <Button asChild size="sm">
            <Link href={`/professor/courses/${sectionId}/assignments/${assignmentId}/answer-key?from=studio`}>
              <KeyRound className="h-4 w-4" />
              Answer key for grading
            </Link>
          </Button>
        </div>

        <div className="space-y-2">
          <RubricEditor
            sectionId={sectionId}
            assignmentId={assignmentId}
            initialRubric={initialRubric}
            initialRubricDraft={initialRubricDraft}
            onDraftChange={onRubricDraftChange}
            generateSources={{ content: contentKind, pdfs, rubricSources: initialRubricSources }}
            onSaved={onRubricSaved}
            skillTagging={skillTagging}
            defaultTargetPoints={initialPoints}
          />
          <p className="px-1 text-xs text-muted-foreground">
            A fallback grading rubric. Draft one with Generate rubric{athenaEntitled ? ' (or ask Athena)' : ''}, then edit and save. It&apos;s always here if you skip per-cell points.
          </p>
        </div>
      </div>
    </main>
  )
}
