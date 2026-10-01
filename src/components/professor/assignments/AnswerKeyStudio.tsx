/**
 * AnswerKeyStudio — dedicated page body for creating and reviewing an assignment's
 * answer key for AI grading. Recomposes existing machinery: answer-key upload
 * (uploadRubricSourcePdf), answer-key rubric generation (generateAssignmentRubric),
 * and the approval pipeline (saveAssignmentRubric: reference embedding + aiGrading
 * stamp). The page's own value is the review surface: per-question reference
 * answers and must-have keywords with hygiene warnings, plus a readiness rail.
 *
 * Editing scope here is deliberately the KEY-specific parts (references, keywords).
 * Question structure, points, and criteria descriptions stay in the RubricEditor.
 *
 * Type: Client Component
 */
'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, KeyRound, Loader2, Bot, UploadCloud, X, Check, AlertTriangle, Circle, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  generateAssignmentRubric,
  saveAssignmentRubric,
  saveAssignmentRubricDraft,
  uploadRubricSourcePdf,
} from '@/app/(dashboard)/professor/courses/[sectionId]/assignments/actions'
import { AssignmentModuleTags, type SkillTaggingState } from '@/components/professor/assignments/AssignmentModuleTags'
import { AthenaAskLine } from '@/components/professor/assignments/athena/AthenaAskLine'
import { GenerationProgress } from '@/components/professor/assignments/GenerationProgress'
import { checkKeywords } from '@/lib/assignments/ai-grading/keywords'
import { gradedRubricTotal, type AssignmentRubric, type RubricQuestion, type AssignmentRubricSourceFile } from '@/lib/validations/assignment'

interface Props {
  sectionId: string
  assignmentId: string
  assignmentTitle: string
  initialRubric: AssignmentRubric | null
  initialDraft: AssignmentRubric | null
  answerKeySource: AssignmentRubricSourceFile | null
  /** Parsed key text (server-side, professor-only) for keyword hygiene checks. */
  keyText: string | null
  initialAiStatus: 'ready' | 'failed' | 'none'
  /** True when entered from the assignment studio's "Add files & rubrics" step —
   *  back link and post-save return go there instead of the Rubrics tab. */
  fromStudio?: boolean
}

export function AnswerKeyStudio({
  sectionId,
  assignmentId,
  assignmentTitle,
  initialRubric,
  initialDraft,
  answerKeySource,
  keyText,
  initialAiStatus,
  fromStudio = false,
}: Props) {
  const router = useRouter()
  // Where "back" and a successful save land: the studio's "Add files & rubrics"
  // step when we came from there, else the assignment's Rubrics tab.
  const backHref = fromStudio
    ? `/professor/courses/${sectionId}/assignments/${assignmentId}/studio?step=files`
    : `/professor/courses/${sectionId}/assignments/${assignmentId}?tab=rubrics`
  const [questions, setQuestions] = useState<RubricQuestion[]>(
    initialDraft?.questions ?? initialRubric?.questions ?? [],
  )
  const [skillTagging, setSkillTagging] = useState<SkillTaggingState>({
    loading: true,
    required: false,
    moduleIds: [],
    skillOptions: [],
  })
  const [aiStatus, setAiStatus] = useState<'ready' | 'failed' | 'none'>(initialAiStatus)
  const [dirty, setDirty] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [generating, startGen] = useTransition()
  const [saving, startSave] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)
  const [keySource, setKeySource] = useState(answerKeySource)

  const tagLocked = !skillTagging.loading && skillTagging.required && skillTagging.moduleIds.length === 0

  // ── Keyword hygiene: a must-have term the key itself never states is a false cap. ──
  const keywordWarnings = useMemo(() => {
    const warnings = new Map<string, string[]>() // "qi:ci" → missing keywords
    if (!keyText) return warnings
    questions.forEach((q, qi) =>
      q.criteria.forEach((c, ci) => {
        const missing = checkKeywords(c.absoluteKeywords, keyText)?.missing ?? []
        if (missing.length > 0) warnings.set(`${qi}:${ci}`, missing)
      }),
    )
    return warnings
  }, [questions, keyText])
  const warningCount = [...keywordWarnings.values()].reduce((s, m) => s + m.length, 0)

  const refCount = questions.reduce(
    (s, q) => s + q.criteria.filter((c) => c.referenceAnswer?.trim()).length,
    0,
  )
  const critCount = questions.reduce((s, q) => s + q.criteria.length, 0)
  const gradedTotal = questions.length > 0 ? gradedRubricTotal({ questions }) : null

  const edit = (next: RubricQuestion[]) => {
    setQuestions(next)
    setDirty(true)
    setAiStatus('none') // edits invalidate the last embed until re-saved
  }

  const patchCriterion = (
    qi: number,
    ci: number,
    patch: { description?: string; points?: number; referenceAnswer?: string; absoluteKeywords?: string[] },
  ) =>
    edit(
      questions.map((q, i) =>
        i === qi
          ? { ...q, criteria: q.criteria.map((c, j) => (j === ci ? { ...c, ...patch } : c)) }
          : q,
      ),
    )

  const patchQuestion = (qi: number, patch: { label?: string; points?: number }) =>
    edit(questions.map((q, i) => (i === qi ? { ...q, ...patch } : q)))

  const addQuestion = () =>
    edit([
      ...questions,
      // No skills key: marks the question as hand-added, so save gives it similarity tags.
      { label: `Q${questions.length + 1}`, points: 0, criteria: [{ description: '', points: 0, referenceAnswer: '', absoluteKeywords: [] }] },
    ])

  const removeQuestion = (qi: number) => edit(questions.filter((_, i) => i !== qi))

  const addCriterion = (qi: number) =>
    edit(
      questions.map((q, i) =>
        i === qi
          ? { ...q, criteria: [...q.criteria, { description: '', points: 0, referenceAnswer: '', absoluteKeywords: [] }] }
          : q,
      ),
    )

  const removeCriterion = (qi: number, ci: number) =>
    edit(questions.map((q, i) => (i === qi ? { ...q, criteria: q.criteria.filter((_, j) => j !== ci) } : q)))

  async function onUploadPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    const fd = new FormData()
    fd.set('pdf', file)
    fd.set('answerKey', '1')
    const res = await uploadRubricSourcePdf(sectionId, assignmentId, fd)
    setUploading(false)
    if ('error' in res) {
      toast.error(res.error)
      return
    }
    /* The file uploaded but the staff-only answer-key row did not, so the AI grader has
       nothing to read (#627). Warn rather than claim success — this used to be a log line. */
    if (res.warning) toast.warning(res.warning)
    if (res.answerKeySource) {
      setKeySource(res.answerKeySource)
      if (!res.warning) toast.success('Answer key uploaded. Generating the rubric from it now.')
      generateFrom(res.answerKeySource.path)
      router.refresh() // re-parse key text server-side for hygiene checks
    }
  }

  function generateFrom(path: string) {
    startGen(async () => {
      const res = await generateAssignmentRubric(sectionId, assignmentId, { kind: 'answer-key', path })
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      setQuestions(res.rubric.questions)
      setDirty(true)
      setAiStatus('none')
      toast.success('Drafted from your key: review the references, then save.')
    })
  }

  function save(draftOnly: boolean) {
    if (tagLocked) {
      toast.error('Tag at least one module first: skills are suggested from the tagged modules.')
      return
    }
    startSave(async () => {
      if (draftOnly) {
        const res = await saveAssignmentRubricDraft(sectionId, assignmentId, { questions })
        if ('error' in res) toast.error(res.error)
        else toast.success('Draft saved')
        return
      }
      const res = await saveAssignmentRubric(sectionId, assignmentId, { questions })
      if ('error' in res) {
        toast.error(res.error)
        return
      }
      setQuestions(res.rubric.questions)
      setDirty(false)
      /* Saved, but the answer-key blob the AI grader depends on did not persist (#627). */
      if (res.warning) toast.warning(res.warning)
      const status = res.aiGrading?.status ?? 'none'
      setAiStatus(status)
      if (status === 'failed') {
        // Stay put: the professor needs to see the state and retry the save.
        toast.warning('Saved, but reference indexing failed. Try saving again.')
        router.refresh()
        return
      }
      toast.success(status === 'ready' ? 'Saved. AI grading is ready for this assignment.' : 'Saved.')
      router.push(backHref)
    })
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6 pb-24">
      {/* Athena stays reachable while authoring the key (fixed bottom-centre pill;
          pb-24 reserves its lane so the last card never scrolls underneath it). */}
      <AthenaAskLine />
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {assignmentTitle}
          </Link>
          <span className="h-5 w-px shrink-0 bg-border" />
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <KeyRound className="h-4 w-4 text-primary" />
            Answer key
          </span>
          {dirty && (
            <span className="rounded-full bg-warning-muted px-2 py-0.5 text-xs font-medium text-warning-muted-foreground">
              Unsaved changes
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">Nothing locks until you save</span>
          <Button size="sm" variant="outline" disabled={saving || questions.length === 0} onClick={() => save(true)}>
            Save draft
          </Button>
          <Button size="sm" loading={saving} disabled={questions.length === 0} onClick={() => save(false)}>
            {!saving && <Check className="h-4 w-4" />}
            Save &amp; enable AI grading
          </Button>
        </div>
      </div>

      {/* ── Module tagging gate (same compulsory field as the rubric tab) ── */}
      <AssignmentModuleTags sectionId={sectionId} assignmentId={assignmentId} onStateChange={setSkillTagging} />

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        {/* ── Main column ──────────────────────────────────────── */}
        <div className={`space-y-4 ${tagLocked ? 'pointer-events-none select-none opacity-40' : ''}`} aria-disabled={tagLocked}>
          {/* Source */}
          <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-foreground">Your answer key</h2>
              <span className="text-xs text-muted-foreground">The AI grades against this, so make it the detailed solutions.</span>
            </div>
            {keySource ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{keySource.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {keyText ? `Parsed, ${keyText.length.toLocaleString()} characters` : 'Uploaded'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" loading={uploading} disabled={generating} onClick={() => fileRef.current?.click()}>
                    {!uploading && <UploadCloud className="h-4 w-4" />}
                    Replace
                  </Button>
                  <Button size="sm" variant="outline" loading={generating} disabled={uploading} onClick={() => generateFrom(keySource.path)}>
                    {!generating && <Bot className="h-4 w-4" />}
                    Re-draft from key
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center transition-colors hover:bg-muted/40"
              >
                {uploading ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /> : <UploadCloud className="h-6 w-6 text-muted-foreground" />}
                <span className="text-sm font-medium text-foreground">Upload your solutions PDF</span>
                <span className="text-xs text-muted-foreground">One AI pass drafts the rubric, reference answers, and must-have terms from it.</span>
              </button>
            )}
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onUploadPicked} />
          </section>

          {/* Drafting loader — same treatment as the rubric editor. */}
          <GenerationProgress
            active={generating}
            skeletonCount={questions.length}
            message={
              <>
                Drafting the rubric from <span className="font-medium text-foreground">your answer key</span>. This can take a minute for longer documents.
              </>
            }
            aria-label="Answer key rubric drafting progress"
          />

          {/* Review */}
          {questions.length > 0 && !generating && (
            <section className="space-y-3">
              <div className="flex items-baseline justify-between gap-3 px-1">
                <h2 className="text-sm font-semibold text-foreground">Review per question</h2>
                <span className="text-xs text-muted-foreground">
                  Everything here is editable: questions, criteria, references, and must-have terms.
                </span>
              </div>
              <p className="px-1 text-xs text-muted-foreground">
                Each question is tagged with skills from your tagged modules when the rubric is drafted or saved.
              </p>
              {questions.map((q, qi) => (
                <div key={qi} className="overflow-hidden rounded-2xl border border-border bg-card">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
                    <Input
                      value={q.label}
                      onChange={(e) => patchQuestion(qi, { label: e.target.value })}
                      placeholder="Q1 or Q2(a)"
                      className="h-8 max-w-40 font-semibold"
                      aria-label="Question label"
                    />
                    <Input
                      type="number"
                      min={0}
                      value={String(q.points)}
                      onChange={(e) => patchQuestion(qi, { points: Number(e.target.value) })}
                      className="h-8 w-20 tabular-nums"
                      aria-label="Question points"
                    />
                    <span className="text-xs text-muted-foreground">pts</span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {q.criteria.length} {q.criteria.length === 1 ? 'criterion' : 'criteria'}
                    </span>
                    <Button variant="ghost" size="icon" aria-label={`Remove question ${q.label}`} onClick={() => removeQuestion(qi)}>
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                  {(q.skills ?? []).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 border-b border-dashed border-border px-4 py-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Skills</span>
                      {(q.skills ?? []).map((s) => (
                        <span key={s.id} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          {s.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {q.criteria.map((c, ci) => {
                    const missing = keywordWarnings.get(`${qi}:${ci}`) ?? []
                    return (
                      <div key={ci} className="border-b border-border px-4 py-3 last:border-b-0">
                        <div className="flex items-center gap-2">
                          <Input
                            value={c.description}
                            onChange={(e) => patchCriterion(qi, ci, { description: e.target.value })}
                            placeholder="What earns this credit, e.g. States the tight bound O(n)"
                            className="h-8 text-sm"
                            aria-label="Criterion description"
                          />
                          <Input
                            type="number"
                            min={0}
                            value={String(c.points)}
                            onChange={(e) => patchCriterion(qi, ci, { points: Number(e.target.value) })}
                            className="h-8 w-16 shrink-0 tabular-nums"
                            aria-label="Criterion points"
                          />
                          <span className="shrink-0 text-xs text-muted-foreground">pts</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0"
                            aria-label="Remove criterion"
                            onClick={() => removeCriterion(qi, ci)}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                        <div className="mt-2">
                          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reference answer</p>
                          <Textarea
                            value={c.referenceAnswer ?? ''}
                            onChange={(e) => patchCriterion(qi, ci, { referenceAnswer: e.target.value })}
                            placeholder="The slice of your key that satisfies this criterion"
                            className="min-h-16 text-sm"
                          />
                        </div>
                        <KeywordEditor
                          keywords={c.absoluteKeywords ?? []}
                          missingInKey={missing}
                          onChange={(kws) => patchCriterion(qi, ci, { absoluteKeywords: kws })}
                        />
                        {missing.length > 0 && (
                          <p className="mt-1.5 text-xs text-warning-muted-foreground">
                            {missing.map((m) => `"${m}"`).join(', ')} {missing.length === 1 ? 'does' : 'do'} not appear in
                            your key. Students answering correctly could lose this point: reword or remove.
                          </p>
                        )}
                      </div>
                    )
                  })}
                  <div className="px-4 py-2.5">
                    <Button variant="ghost" size="sm" onClick={() => addCriterion(qi)}>
                      <Plus className="h-4 w-4" />
                      Add criterion
                    </Button>
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addQuestion}>
                <Plus className="h-4 w-4" />
                Add question
              </Button>
            </section>
          )}
        </div>

        {/* ── Readiness rail ───────────────────────────────────── */}
        <aside className="space-y-3 lg:sticky lg:top-6 lg:self-start">
          <div className="space-y-1.5 rounded-2xl border border-border bg-card p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Readiness</h3>
            <ReadyRow ok={!!keySource} label={keySource ? `Key ${keyText ? 'parsed' : 'uploaded'}` : 'Upload your answer key'} />
            <ReadyRow
              ok={questions.length > 0}
              label={
                questions.length > 0
                  ? `Rubric drafted: ${questions.length} questions, ${gradedTotal ?? 0} pts`
                  : 'Draft the rubric from your key'
              }
            />
            <ReadyRow
              ok={critCount > 0 && refCount === critCount}
              warn={critCount > 0 && refCount > 0 && refCount < critCount}
              label={critCount === 0 ? 'References per criterion' : `References: ${refCount}/${critCount} criteria`}
            />
            <ReadyRow ok={warningCount === 0 && critCount > 0} warn={warningCount > 0} label={warningCount > 0 ? `${warningCount} keyword ${warningCount === 1 ? 'warning' : 'warnings'}` : 'Keywords match your key'} />
            <ReadyRow
              ok={aiStatus === 'ready'}
              warn={aiStatus === 'failed'}
              label={aiStatus === 'ready' ? 'References embedded' : aiStatus === 'failed' ? 'Reference indexing failed, save again' : 'References embed on save'}
            />
            <div
              className={`mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold ${
                aiStatus === 'ready' ? 'bg-success-muted text-success-muted-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              <Circle className={`h-2 w-2 ${aiStatus === 'ready' ? 'fill-current' : ''}`} />
              {aiStatus === 'ready' ? 'AI grading ready' : 'AI grading ready after save'}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">How grading uses this</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Each submission is graded against these references with your full key as context. Lines a student earns
              stay clean, lines they lose get a short reason, and anything uncertain is flagged for you to grade by hand.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Visibility</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">Students can never see this page or its contents.</span>{' '}
              References, must-have terms, and the key file stay professor-only, before and after grading.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

/** Chip editor for a criterion's must-have terms, with key-hygiene highlighting. */
function KeywordEditor({
  keywords,
  missingInKey,
  onChange,
}: {
  keywords: string[]
  missingInKey: string[]
  onChange: (next: string[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')
  const commit = () => {
    const v = value.trim()
    setValue('')
    setAdding(false)
    if (v && !keywords.includes(v)) onChange([...keywords, v])
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Must-have terms</span>
      {keywords.map((kw) => (
        <span
          key={kw}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs ${
            missingInKey.includes(kw)
              ? 'border-warning/30 bg-warning-muted text-warning-muted-foreground'
              : 'border-border bg-card text-foreground'
          }`}
        >
          {missingInKey.includes(kw) && <AlertTriangle className="h-3 w-3" />}
          {kw}
          <button type="button" aria-label={`Remove term ${kw}`} onClick={() => onChange(keywords.filter((k) => k !== kw))}>
            <X className="h-3 w-3 opacity-60 transition-opacity hover:opacity-100" />
          </button>
        </span>
      ))}
      {adding ? (
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setValue('')
              setAdding(false)
            }
          }}
          className="h-6 w-36 text-xs"
          aria-label="New must-have term"
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          + term
        </button>
      )}
    </div>
  )
}

function ReadyRow({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="w-4 shrink-0 text-center">
        {ok ? (
          <Check className="inline h-3.5 w-3.5 text-success-muted-foreground" />
        ) : warn ? (
          <AlertTriangle className="inline h-3.5 w-3.5 text-warning-muted-foreground" />
        ) : (
          <Circle className="inline h-2 w-2 text-muted-foreground/50" />
        )}
      </span>
      <span className={ok ? 'text-foreground' : warn ? 'text-warning-muted-foreground' : 'text-muted-foreground'}>{label}</span>
    </div>
  )
}
