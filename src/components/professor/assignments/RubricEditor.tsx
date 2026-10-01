/**
 * RubricEditor — professor-side Gradescope-style rubric for an assignment. "Generate rubric"
 * drafts one with AI from the assignment's content (studio notebook cells + answer keys, or the
 * uploaded PDF); the professor then edits questions/subquestions + their criteria/points and
 * saves. The AI only drafts — the saved rubric is whatever the professor approves.
 *
 * Type: Client Component
 */
'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2, Save, AlertCircle, ChevronDown, ChevronRight, Pencil, FileText, NotebookText, UploadCloud, Loader2, KeyRound, X, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  generateAssignmentRubric,
  saveAssignmentRubric,
  saveAssignmentRubricDraft,
  discardAssignmentRubricDraft,
  uploadRubricSourcePdf,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import {
  rubricPointIssues,
  rubricTotalPoints,
  MAX_ASSIGNMENT_PDFS,
  MAX_SKILLS_PER_QUESTION,
  type AssignmentRubric,
  type RubricQuestion,
  type RubricCriterion,
  type RubricSkillTag,
  type AssignmentPdf,
  type AssignmentRubricSourceFile,
  type RubricSource,
} from '@/lib/validations/assignment'
import type { SkillTaggingState } from '@/components/professor/assignments/AssignmentModuleTags'

/** The contexts the AI can draft a rubric from — the assignment's own content and/or PDFs. */
export interface RubricGenerateSources {
  /** The assignment's own content, if any: its notebook or its Notion-style document. */
  content: 'notebook' | 'document' | null
  /** Attached PDF briefs, each usable as a standalone source. */
  pdfs: AssignmentPdf[]
  /** Rubric-only uploaded files — professor-visible only, never surfaced to students. */
  rubricSources: AssignmentRubricSourceFile[]
  /** A persisted answer-key upload (settings.answerKeySource) — drives AI grading references. */
  answerKeySource?: AssignmentRubricSourceFile | null
}

interface RubricEditorProps {
  sectionId: string
  assignmentId: string
  initialRubric: AssignmentRubric | null
  /** An autosaved, not-yet-approved rubric draft (settings.rubricDraft). When present it seeds the
   *  editor (over the saved rubric) so a generated/edited rubric survives navigation until saved. */
  initialRubricDraft?: AssignmentRubric | null
  /** Called whenever the working draft changes (generate / edit / clear). The parent studio holds
   *  this so the draft survives the editor unmounting on step navigation (the seed prop alone is
   *  stale until a full reload). Pass a stable setter. */
  onDraftChange?: (draft: AssignmentRubric | null) => void
  /** What the AI can draft from. When more than one exists the professor picks per generation. */
  generateSources: RubricGenerateSources
  /** Start expanded (e.g. when hosted in a dedicated dialog). Defaults to open only when empty. */
  defaultOpen?: boolean
  /** When false the rubric is always expanded with no collapse toggle (e.g. its own dedicated tab). */
  collapsible?: boolean
  /** Called after a successful save with the saved rubric — lets a host (e.g. the studio dialog)
   *  close itself and update its own live rubric count instead of relying on router.refresh(). */
  onSaved?: (rubric: AssignmentRubric) => void
  /** Module + skill tagging state, lifted from the AssignmentModuleTags field the host renders
   *  above this editor. When present: generation/save require ≥1 tagged module (if the section
   *  has modules) and each question shows editable skill-tag chips drawn from the tagged
   *  modules' skill pool. Absent = tagging UI hidden (legacy hosts). */
  skillTagging?: SkillTaggingState
  /** Seeds the "Total points" the AI draft should sum to (usually the assignment's points).
   *  The professor can change it per generation; empty falls back server-side (#543). */
  defaultTargetPoints?: number
}

export function RubricEditor({
  sectionId,
  assignmentId,
  initialRubric,
  initialRubricDraft,
  onDraftChange,
  generateSources,
  defaultOpen,
  collapsible = true,
  onSaved,
  skillTagging,
  defaultTargetPoints,
}: RubricEditorProps) {
  const router = useRouter()
  // Seed from the pending draft first (so a generated/edited rubric that wasn't yet saved is
  // restored), then the approved rubric.
  const [questions, setQuestions] = useState<RubricQuestion[]>(
    initialRubricDraft?.questions ?? initialRubric?.questions ?? [],
  )
  const [generating, startGen] = useTransition()
  const [saving, startSave] = useTransition()
  // Which source the AI is drafting from, named in the in-panel loading state.
  const [generatingFrom, setGeneratingFrom] = useState<string | null>(null)
  // Professor-set max score the AI draft should sum to (#543); empty means "assignment default".
  const [targetPoints, setTargetPoints] = useState<number | ''>(defaultTargetPoints ?? '')
  // Simulated progress for the drafting wait: the server action reports no real progress, so this
  // eases toward (never reaches) 92% to show liveness without falsely claiming completion.
  const [genProgress, setGenProgress] = useState(0)
  useEffect(() => {
    if (!generating) return
    const id = setInterval(() => {
      setGenProgress((p) => p + (92 - p) * 0.02)
    }, 300)
    return () => clearInterval(id)
  }, [generating])

  // Collapse to a summary once a rubric exists; expand when empty or when a pending draft awaits
  // review. Declared before the adoption block below, which calls setOpen during render.
  const [open, setOpen] = useState(defaultOpen ?? (!initialRubric || !!initialRubricDraft))

  // "Unsaved draft" is DERIVED, not a flag: the rubric differs from the last-approved one. This
  // avoids stale toggles — a pending autosave firing after Save can't re-show the chip, and a draft
  // that's identical to the saved rubric never reads as unsaved.
  const [approvedJson, setApprovedJson] = useState(() => JSON.stringify(initialRubric?.questions ?? []))
  const currentJson = useMemo(() => JSON.stringify(questions), [questions])
  const hasDraft = questions.length > 0 && currentJson !== approvedJson

  // Adopt a rubric that arrived from OUTSIDE while this editor was already mounted — i.e. Athena
  // writing one through the studio's onRubricSaved channel. Without it the editor ignores the new
  // prop and the professor's next Save clobbers Athena's rubric. Guarded on `dirty` so an incoming
  // rubric never yanks away in-progress typing. (Adjust-state-during-render on prop change — STATE
  // not refs, since reading a ref during render lints.)
  const [adopted, setAdopted] = useState(initialRubric)
  const [dirty, setDirty] = useState(false)
  if (initialRubric !== adopted) {
    setAdopted(initialRubric)
    if (!dirty) {
      setQuestions(initialRubric?.questions ?? [])
      // An adopted rubric is the newly-saved baseline — it must not read as an unsaved draft.
      setApprovedJson(JSON.stringify(initialRubric?.questions ?? []))
      setOpen(defaultOpen ?? !initialRubric)
    }
  }

  // Every local mutation goes through edit() so an externally-saved rubric arriving mid-edit can't
  // yank away in-progress typing (flips `dirty`). The assignment total is DERIVED from the rubric
  // (rubricPointIssues, below), so there is no separate points budget to thread through here.
  const edit = (next: React.SetStateAction<RubricQuestion[]>) => {
    setDirty(true)
    setQuestions(next)
  }

  // Serialize draft-autosave against approval. `saveAssignmentRubricDraft` and `saveAssignmentRubric`
  // both read-modify-write the whole `settings` blob, so a draft write that's already in flight when
  // the professor clicks Save could otherwise commit *after* the approval and clobber the saved rubric
  // (reinstating rubricDraft, dropping rubric). We track the in-flight draft write and stop issuing new
  // ones during approval; Save awaits any in-flight draft write before writing, so approval lands last.
  const pendingDraftWrite = useRef<Promise<unknown> | null>(null)
  const blockAutosave = useRef(false)

  const persistDraft = useCallback((qs: RubricQuestion[]) => {
    if (blockAutosave.current) return
    const p = saveAssignmentRubricDraft(sectionId, assignmentId, { questions: qs })
    pendingDraftWrite.current = p
    void p.finally(() => { if (pendingDraftWrite.current === p) pendingDraftWrite.current = null })
  }, [sectionId, assignmentId])

  // Autosave the working rubric to settings.rubricDraft (debounced) so it survives step navigation
  // and leaving a draft assignment — until the professor approves it with "Save rubric". Only when
  // it actually differs from the approved rubric; the effect re-runs (and its cleanup cancels the
  // pending timer) the instant it matches again, so Save can't be undone by a late autosave.
  const skipFirstAutosave = useRef(true)
  useEffect(() => {
    if (skipFirstAutosave.current) {
      skipFirstAutosave.current = false
      return
    }
    if (!hasDraft) {
      onDraftChange?.(null)
      return
    }
    // Push the draft up to the parent synchronously so it survives this editor unmounting on step /
    // tab navigation (the seed prop is stale until a full reload); debounce only the server write.
    onDraftChange?.({ questions })
    const t = setTimeout(() => persistDraft(questions), 1000)
    return () => clearTimeout(t)
  }, [questions, hasDraft, onDraftChange, persistDraft])

  // Flush an unsaved draft to the server on unmount: the debounced effect's cleanup above only
  // clears the timer, so switching tab/step inside the 1s window would otherwise drop the write
  // (the parent's in-memory draft masks the loss until a full reload). Refs carry the latest
  // state into the unmount-only cleanup; persistDraft itself no-ops while blockAutosave is set.
  const latestQuestionsRef = useRef(questions)
  const hasDraftRef = useRef(hasDraft)
  const persistDraftRef = useRef(persistDraft)
  useEffect(() => {
    latestQuestionsRef.current = questions
    hasDraftRef.current = hasDraft
    persistDraftRef.current = persistDraft
  })
  useEffect(() => {
    return () => {
      if (hasDraftRef.current) persistDraftRef.current(latestQuestionsRef.current)
    }
  }, [])
  // Rubric-only source PDFs are client-managed once mounted: uploaded straight from
  // the "Draft from" menu and persisted server-side. Seed from the server's list.
  const [rubricSources, setRubricSources] = useState<AssignmentRubricSourceFile[]>(generateSources.rubricSources)
  const [answerKeySource, setAnswerKeySource] = useState<AssignmentRubricSourceFile | null>(generateSources.answerKeySource ?? null)
  const [uploading, setUploading] = useState(false)
  const rubricSourceRef = useRef<HTMLInputElement>(null)
  const answerKeyRef = useRef<HTMLInputElement>(null)

  const issues = useMemo(() => rubricPointIssues(questions), [questions])
  // The rubric defines the assignment total (sum of all criteria; 100 when it has no points).
  const derivedTotal = useMemo(() => rubricTotalPoints(questions), [questions])

  // One entry per place the AI can read from: the assignment content first, then each PDF, then
  // rubric-only uploads, then any persisted answer key (which regenerates references + keywords).
  const sourceOptions = useMemo<{ label: string; icon: 'content' | 'pdf' | 'key'; source: RubricSource }[]>(() => {
    const opts: { label: string; icon: 'content' | 'pdf' | 'key'; source: RubricSource }[] = []
    if (generateSources.content) {
      opts.push({
        label: generateSources.content === 'notebook' ? 'Notebook' : 'Document',
        icon: 'content',
        source: { kind: 'content' },
      })
    }
    generateSources.pdfs.forEach((p) =>
      opts.push({ label: p.name, icon: 'pdf', source: { kind: 'pdf', path: p.path } }),
    )
    rubricSources.forEach((f) =>
      opts.push({ label: f.name, icon: 'pdf', source: { kind: 'rubric-source', path: f.path } }),
    )
    if (answerKeySource) {
      opts.push({ label: `Answer key: ${answerKeySource.name}`, icon: 'key', source: { kind: 'answer-key', path: answerKeySource.path } })
    }
    return opts
  }, [generateSources.content, generateSources.pdfs, rubricSources, answerKeySource])

  // Module tagging is compulsory before generation/save whenever the section has modules —
  // the tagged modules are the source of every skill tag. Mirrors the server-side gate.
  function modulesMissing(): boolean {
    if (!skillTagging || skillTagging.loading) return false
    if (skillTagging.required && skillTagging.moduleIds.length === 0) {
      toast.error('Tag at least one module above first: skills are suggested from the tagged modules.')
      return true
    }
    return false
  }

  // Generate is destructive to the working rubric (every question, criterion and skill
  // chip is replaced), so a non-empty editor asks first (#553-4). The pending request is
  // stashed while the AlertDialog below is open; confirming runs doGenerate.
  const [pendingGenerate, setPendingGenerate] = useState<{ source: RubricSource; label: string } | null>(null)

  function generate(source: RubricSource, sourceLabel: string) {
    if (modulesMissing()) return
    if (questions.length > 0) {
      setPendingGenerate({ source, label: sourceLabel })
      return
    }
    doGenerate(source, sourceLabel)
  }

  function doGenerate(source: RubricSource, sourceLabel: string) {
    setGeneratingFrom(sourceLabel)
    setGenProgress(0) // reset here (not in the effect) so a re-generate starts the bar over
    startGen(async () => {
      const res = await generateAssignmentRubric(
        sectionId,
        assignmentId,
        source,
        targetPoints === '' ? undefined : targetPoints,
      )
      if ('error' in res) toast.error(res.error)
      else {
        blockAutosave.current = false // new AI content — allow autosave again after any prior approval
        edit(res.rubric.questions)
        // Persist the draft immediately (not just via the debounced autosave) so navigating or
        // leaving right after generating can't lose it before the debounce fires.
        persistDraft(res.rubric.questions)
        toast.success('Rubric drafted, review, tweak, then save')
      }
    })
  }

  // "Draft from > Upload a file / answer key": upload a rubric-only PDF (professor-visible only,
  // never surfaced to students), then draft straight from it. An answer key additionally seeds
  // per-criterion reference answers + keywords for AI grading.
  async function onUploadPicked(e: React.ChangeEvent<HTMLInputElement>, isAnswerKey: boolean) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const fd = new FormData()
    fd.append('pdf', file)
    if (isAnswerKey) fd.append('answerKey', '1')
    setUploading(true)
    const res = await uploadRubricSourcePdf(sectionId, assignmentId, fd)
    setUploading(false)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    setRubricSources(res.rubricSources)
    /* Uploaded, but not usable as an answer key (#627) — say so instead of logging it. */
    if ('warning' in res && res.warning) toast.warning(res.warning)
    if ('answerKeySource' in res && res.answerKeySource) setAnswerKeySource(res.answerKeySource)
    const added = res.rubricSources[res.rubricSources.length - 1]
    if (added) generate(isAnswerKey ? { kind: 'answer-key', path: added.path } : { kind: 'rubric-source', path: added.path }, added.name)
  }

  function save() {
    if (issues.hasError) {
      toast.error('Fix the point totals before saving.')
      return
    }
    if (modulesMissing()) return
    // Stop issuing new draft writes for the duration of approval.
    blockAutosave.current = true
    startSave(async () => {
      // Let any in-flight draft write finish FIRST so the approval write lands last (closes the
      // race where a late autosave would reinstate rubricDraft and drop the approved rubric).
      if (pendingDraftWrite.current) {
        try { await pendingDraftWrite.current } catch { /* draft write failed; approval still wins */ }
      }
      const res = await saveAssignmentRubric(sectionId, assignmentId, { questions })
      if ('error' in res) {
        toast.error(res.error)
        blockAutosave.current = false // approval failed — let autosave resume
        return
      }
      // The rubric always saves; AI-grading references are best-effort. Surface a soft warning if
      // they could not be indexed so the professor knows AI grading won't have references yet.
      if ('warning' in res && res.warning) {
        /* The answer-key blob did not persist (#627). Same "saved but degraded" shape as
           the indexing warning below, and reported the same way. */
        toast.warning(res.warning)
      } else if ('aiGrading' in res && res.aiGrading?.status === 'failed') {
        toast.warning('Rubric saved, but AI grading references could not be indexed. Try saving again.')
      } else {
        toast.success('Rubric saved')
      }
      // Approved: adopt the rubric AS SAVED — the server may have attached similarity-suggested
      // skill tags to untagged questions (manual-rubric path) — so it's no longer a draft (this
      // also cancels any pending autosave via the effect re-run) and the parent draft is dropped.
      const saved = res.rubric.questions
      setQuestions(saved)
      setDirty(false)
      setApprovedJson(JSON.stringify(saved))
      onDraftChange?.(null)
      setOpen(false) // collapse back to the summary
      onSaved?.(res.rubric)
      router.refresh()
      blockAutosave.current = false // future edits may autosave again
    })
  }

  // Throw away the working draft and show the approved rubric again — the way back after
  // a Generate (or edit session) the professor doesn't want to keep (#553-4). Autosave is
  // frozen for the duration and any in-flight draft write is awaited first, so a queued
  // debounce can't re-persist the content being discarded.
  const [discarding, setDiscarding] = useState(false)
  async function discardDraft() {
    setDiscarding(true)
    blockAutosave.current = true
    try {
      if (pendingDraftWrite.current) {
        try { await pendingDraftWrite.current } catch { /* the removal below wins regardless */ }
      }
      const res = await discardAssignmentRubricDraft(sectionId, assignmentId)
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      const approved = JSON.parse(approvedJson) as RubricQuestion[]
      setQuestions(approved)
      setDirty(false)
      onDraftChange?.(null)
      toast.success(approved.length > 0 ? 'Draft discarded, showing the saved rubric' : 'Draft discarded')
    } finally {
      setDiscarding(false)
      blockAutosave.current = false
    }
  }

  const patchQuestion = (qi: number, patch: Partial<RubricQuestion>) =>
    edit((qs) => qs.map((q, i) => (i === qi ? { ...q, ...patch } : q)))
  const patchCriterion = (qi: number, ci: number, patch: Partial<RubricCriterion>) =>
    edit((qs) =>
      qs.map((q, i) =>
        i === qi ? { ...q, criteria: q.criteria.map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : q,
      ),
    )
  const addQuestion = () =>
    // No skills key: marks the question as hand-added, so save gives it similarity tags.
    edit((qs) => [...qs, { label: '', points: 0, criteria: [] }])
  // Skill tags: q.skills may be undefined on older persisted drafts, so always coalesce.
  const addSkill = (qi: number, tag: RubricSkillTag) =>
    edit((qs) =>
      qs.map((q, i) =>
        i === qi && (q.skills ?? []).length < MAX_SKILLS_PER_QUESTION
          ? { ...q, skills: [...(q.skills ?? []).filter((s) => s.id !== tag.id), tag] }
          : q,
      ),
    )
  const removeSkill = (qi: number, skillId: string) =>
    edit((qs) =>
      qs.map((q, i) => (i === qi ? { ...q, skills: (q.skills ?? []).filter((s) => s.id !== skillId) } : q)),
    )
  const removeQuestion = (qi: number) => edit((qs) => qs.filter((_, i) => i !== qi))
  const addCriterion = (qi: number) =>
    edit((qs) =>
      qs.map((q, i) => (i === qi ? { ...q, criteria: [...q.criteria, { description: '', points: 0 }] } : q)),
    )
  const removeCriterion = (qi: number, ci: number) =>
    edit((qs) =>
      qs.map((q, i) => (i === qi ? { ...q, criteria: q.criteria.filter((_, j) => j !== ci) } : q)),
    )

  // When not collapsible the rubric is always expanded (its own tab) — no chevron / Edit toggle.
  const bodyOpen = collapsible ? open : true

  // Module tagging is a precondition: while the section has modules and none is tagged,
  // the whole editor stays out of focus (visible but inert) until a module is tagged above.
  const tagLocked =
    !!skillTagging && !skillTagging.loading && skillTagging.required && skillTagging.moduleIds.length === 0
  // While the tagging state is still loading, the editor is inert too (no banner, no
  // dimming): an untagged assignment must never flash an interactive editor for the
  // ~1s before the lock can be computed (#553). Tagged assignments just can't type
  // for that beat, which is invisible in practice.
  const tagPending = !!skillTagging && skillTagging.loading

  const headerInner = (
    <>
      {collapsible &&
        (open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        ))}
      <span className="text-sm font-semibold text-foreground">Grading rubric</span>
      {questions.length > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {questions.length} {questions.length === 1 ? 'question' : 'questions'} · {derivedTotal} pts total
        </span>
      )}
      {hasDraft && (
        <span className="rounded-full bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning-muted-foreground">
          Unsaved draft
        </span>
      )}
      {/* Keeps the draft-in-progress visible when the panel is collapsed mid-generation; the open
          panel already shows the in-panel status, so this would only duplicate it. */}
      {generating && !bodyOpen && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Drafting…
        </span>
      )}
    </>
  )

  return (
    <>
      {tagLocked && (
        <p className="text-xs font-medium text-warning-muted-foreground">
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() =>
              document.getElementById('assignment-module-tags')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          >
            Tag at least one module above
          </button>{' '}
          to unlock the rubric editor.
        </p>
      )}
    {/* inert (not pointer-events-none) so the locked editor is unreachable by keyboard too. */}
    <div
      className={`space-y-4 rounded-2xl border border-border bg-card p-4${tagLocked ? ' opacity-40' : ''}`}
      inert={tagLocked || tagPending || undefined}
    >
      {/* flex-wrap keeps the Generate button on-screen at phone widths (#539): the summary and
          chips wrap under the title, and the button drops to its own line instead of clipping. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {collapsible ? (
          <button type="button" onClick={() => setOpen((v) => !v)} className="flex flex-wrap items-center gap-2 text-left">
            {headerInner}
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">{headerInner}</div>
        )}
        {bodyOpen ? (
          <div className="flex items-center gap-2">
          {/* The way back from an unwanted draft: drops settings.rubricDraft and shows the
              approved rubric again. Without it a stray Generate was irreversible (#553-4). */}
          {hasDraft && (
            <Button type="button" variant="outline" size="sm" onClick={discardDraft} disabled={discarding || generating || uploading}>
              {discarding ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              Discard draft
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={generating || uploading}>
                {/* main's condition (spins while GENERATING too, PR #544) + this
                    branch's icon (no AI stars, pilot #30). */}
                {uploading || generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                {uploading ? 'Uploading…' : generating ? 'Generating…' : 'Generate rubric'}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {/* Target total for the AI draft (#543). stopPropagation keeps clicks/typing in the
                  input from triggering the menu's item selection or typeahead. */}
              <div className="flex items-center justify-between gap-2 px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                <label htmlFor="rubric-target-points" className="text-xs text-muted-foreground">
                  Total points
                </label>
                <Input
                  id="rubric-target-points"
                  type="number"
                  min={1}
                  max={1000}
                  value={targetPoints === '' ? '' : String(targetPoints)}
                  onChange={(e) => {
                    // Store what's typed; clamp on blur so the bounds don't fight mid-typing.
                    const parsed = parseInt(e.target.value)
                    setTargetPoints(Number.isNaN(parsed) ? '' : parsed)
                  }}
                  onBlur={() => setTargetPoints((p) => (p === '' ? '' : Math.max(1, Math.min(1000, p))))}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="h-7 w-20 tabular-nums"
                />
              </div>
              <DropdownMenuSeparator />
              {sourceOptions.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Draft from…
                  </DropdownMenuLabel>
                  {sourceOptions.map((o, i) => (
                    <DropdownMenuItem key={i} onSelect={() => generate(o.source, o.label)} className="gap-2">
                      {o.icon === 'content' ? (
                        <NotebookText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : o.icon === 'key' ? (
                        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{o.label}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              {/* Upload a rubric-only PDF (professor-visible only) and draft straight from it. */}
              <DropdownMenuItem
                onSelect={() => setTimeout(() => rubricSourceRef.current?.click(), 0)}
                disabled={rubricSources.length >= MAX_ASSIGNMENT_PDFS}
                className="gap-2"
              >
                <UploadCloud className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">Upload a file</span>
              </DropdownMenuItem>
              {/* Upload a detailed answer key — also seeds per-criterion reference answers for AI grading. */}
              <DropdownMenuItem
                onSelect={() => setTimeout(() => answerKeyRef.current?.click(), 0)}
                disabled={rubricSources.length >= MAX_ASSIGNMENT_PDFS}
                className="gap-2"
              >
                <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">Upload a detailed answer key (enables AI grading)</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </div>

      <input ref={rubricSourceRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => onUploadPicked(e, false)} />
      <input ref={answerKeyRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => onUploadPicked(e, true)} />

      {/* Generating over a non-empty editor replaces reviewed work — confirm first (#553-4).
          Mirrors the publish-empty confirmation in PublishPanel. */}
      <AlertDialog open={pendingGenerate !== null} onOpenChange={(o) => !o && setPendingGenerate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the current rubric?</AlertDialogTitle>
            <AlertDialogDescription>
              Generating replaces every question, criterion and skill tag in the editor with a new
              AI draft. Your saved rubric is kept until you click Save rubric, and you can get back
              to it with Discard draft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
            variant="destructive"
              onClick={() => {
                const pg = pendingGenerate
                setPendingGenerate(null)
                if (pg) doGenerate(pg.source, pg.label)
              }}
            >
              Replace and generate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* While the AI drafts, the editable list would be clobbered by the result anyway, so the
          whole body becomes a loading state: a status line plus skeleton question cards. */}
      {bodyOpen && generating && (
        <div className="space-y-3" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>
              Drafting a rubric from <span className="font-medium text-foreground">{generatingFrom ?? 'the selected source'}</span>. This can take a minute for longer documents.
            </span>
          </p>
          <Progress value={genProgress} className="h-1.5" aria-label="Rubric drafting progress" />
          {/* Match the outgoing rubric's card count (bounded) so a regenerate doesn't collapse the
              panel height, then snap back when the result lands. */}
          {Array.from({ length: Math.min(4, Math.max(2, questions.length)) }, (_, i) => (
            <div key={i} className="space-y-2 rounded-xl border border-border p-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-9 flex-1" />
                <Skeleton className="h-9 w-20" />
              </div>
              <div className="space-y-1.5 pl-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      )}

      {bodyOpen && !generating && (
        <>

      <div className="space-y-3">
        {questions.map((q, qi) => (
          <div key={qi} className="space-y-2 rounded-xl border border-border p-3">
            {/* Below sm the label takes the full row and points/delete wrap under it, so labels
                stay readable on a phone instead of truncating to a few characters (#539). */}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={q.label}
                onChange={(e) => patchQuestion(qi, { label: e.target.value })}
                placeholder="Q1 or Q2(a)"
                className="basis-full font-medium sm:basis-0 sm:flex-1"
              />
              <Input
                type="number"
                min={0}
                value={String(q.points)}
                onChange={(e) => patchQuestion(qi, { points: Number(e.target.value) })}
                className="w-20 tabular-nums"
                aria-label="Question points"
              />
              <span className="text-xs text-muted-foreground">pts</span>
              <Button type="button" variant="ghost" size="icon" onClick={() => removeQuestion(qi)} aria-label="Remove question">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2 pl-3">
              {q.criteria.map((c, ci) => {
                const aiOpen = c.referenceAnswer !== undefined || c.absoluteKeywords !== undefined
                return (
                <div key={ci} className="space-y-1.5 rounded-xl border border-border p-2">
                  {/* flex-wrap + basis-full: the description gets its own line at phone widths (#539). */}
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={c.description}
                      onChange={(e) => patchCriterion(qi, ci, { description: e.target.value })}
                      placeholder="What earns these points"
                      className="basis-full sm:basis-0 sm:flex-1"
                    />
                    <Input
                      type="number"
                      value={String(c.points)}
                      onChange={(e) => patchCriterion(qi, ci, { points: Number(e.target.value) })}
                      className="w-20 tabular-nums"
                      aria-label="Criterion points"
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeCriterion(qi, ci)} aria-label="Remove criterion">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {/* AI-grading fields — shown once a reference answer is present (or the professor
                      opts in). Empty string -> drop the field on change so the unsaved chip clears. */}
                  {aiOpen ? (
                    <div className="space-y-1.5 pt-1">
                      <Textarea
                        value={c.referenceAnswer ?? ''}
                        onChange={(e) => patchCriterion(qi, ci, { referenceAnswer: e.target.value || undefined })}
                        placeholder="Reference answer — what a full-credit answer contains"
                        rows={2}
                        className="text-xs"
                      />
                      <Input
                        value={(c.absoluteKeywords ?? []).join(', ')}
                        onChange={(e) => {
                          const kws = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                          patchCriterion(qi, ci, { absoluteKeywords: kws.length ? kws : undefined })
                        }}
                        placeholder="Must-have terms, comma-separated"
                        className="text-xs"
                        aria-label="Must-have terms"
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => patchCriterion(qi, ci, { referenceAnswer: '' })}
                    >
                      + Add reference answer for AI grading
                    </button>
                  )}
                </div>
                )
              })}
              <Button type="button" variant="ghost" size="sm" onClick={() => addCriterion(qi)}>
                <Plus className="h-3.5 w-3.5" />
                Add criterion
              </Button>
            </div>
            {/* Skill tags — per QUESTION, never per criterion. Options come from the tagged
                modules' skill pool; AI generation pre-fills them, manual saves get
                similarity-suggested ones, and the professor can always edit here. */}
            {skillTagging && !skillTagging.loading && (skillTagging.skillOptions.length > 0 || (q.skills ?? []).length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5 pl-3">
                <span className="text-xs font-medium text-muted-foreground">Skills</span>
                {(q.skills ?? []).map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                  >
                    {s.name}
                    <button
                      type="button"
                      onClick={() => removeSkill(qi, s.id)}
                      aria-label={`Remove skill ${s.name}`}
                      className="-m-0.5 rounded-full p-0.5 transition-colors hover:bg-primary/20"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {/* Cap mirrors the save schema: without it a 6th chip fails the whole save
                    with an unrelated "check the points and labels" error. */}
                {(q.skills ?? []).length < MAX_SKILLS_PER_QUESTION &&
                  skillTagging.skillOptions.some((s) => !(q.skills ?? []).some((t) => t.id === s.id)) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs">
                        <Plus className="h-3 w-3" />
                        Add skill
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-64 w-64 overflow-y-auto">
                      {skillTagging.skillOptions
                        .filter((s) => !(q.skills ?? []).some((t) => t.id === s.id))
                        .map((s) => (
                          <DropdownMenuItem key={s.id} onSelect={() => addSkill(qi, s)} className="text-xs">
                            <span className="truncate">{s.name}</span>
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )}
            {issues.perQuestion[qi] && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {issues.perQuestion[qi]}
              </p>
            )}
            {issues.perQuestionWarning[qi] && (
              <p className="flex items-center gap-1.5 text-xs text-warning-muted-foreground">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {issues.perQuestionWarning[qi]}
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Hand-written questions get skill suggestions from your tagged modules when you save. Remove any that don&apos;t fit.
      </p>
      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" size="sm" onClick={addQuestion}>
          <Plus className="h-4 w-4" />
          Add question
        </Button>
        {questions.length > 0 && (
          <Button type="button" size="sm" onClick={save} disabled={saving || issues.hasError}>
            <Save className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save rubric'}
          </Button>
        )}
      </div>
        </>
      )}
    </div>
    </>
  )
}
