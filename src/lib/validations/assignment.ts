/**
 * Assignment validation schemas + shared types — single source of truth for the
 * Assignment Studio (v1: text + file-upload submissions).
 *
 * Used by the professor wizard, the student submission form, and every server
 * action that mutates assignments or submissions. Keep types here; do not
 * duplicate them in components.
 */

import { z } from 'zod'
import type { ProctoringSummary } from '@/lib/validations/proctoring'

// ── File-type kinds a professor can require ──────────────────────
// A "kind" groups related extensions + MIME types under one friendly label.
// Empty selection => text-only assignment (the text box is always optional).

export const FILE_TYPE_KINDS = [
  { kind: 'pdf', label: 'PDF', extensions: ['pdf'], mimes: ['application/pdf'] },
  {
    kind: 'image',
    label: 'Image (JPG, PNG)',
    extensions: ['jpg', 'jpeg', 'png'],
    mimes: ['image/jpeg', 'image/png'],
  },
  {
    kind: 'doc',
    label: 'Word (.doc, .docx)',
    extensions: ['doc', 'docx'],
    mimes: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  {
    kind: 'ppt',
    label: 'PowerPoint (.ppt, .pptx)',
    extensions: ['ppt', 'pptx'],
    mimes: [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  { kind: 'txt', label: 'Text (.txt)', extensions: ['txt'], mimes: ['text/plain'] },
  {
    kind: 'ipynb',
    label: 'Jupyter Notebook (.ipynb)',
    extensions: ['ipynb'],
    mimes: ['application/x-ipynb+json', 'application/json'],
  },
  {
    kind: 'zip',
    label: 'ZIP archive',
    extensions: ['zip'],
    mimes: ['application/zip', 'application/x-zip-compressed'],
  },
] as const

export type FileTypeKind = (typeof FILE_TYPE_KINDS)[number]['kind']

const FILE_TYPE_KIND_VALUES = FILE_TYPE_KINDS.map((k) => k.kind) as [
  FileTypeKind,
  ...FileTypeKind[],
]

/** Max size per uploaded submission file. */
export const MAX_SUBMISSION_FILE_SIZE = 25 * 1024 * 1024 // 25 MB
/** Max number of files a student can attach to one submission. */
export const MAX_SUBMISSION_FILES = 10

// ── helpers over file-type kinds ─────────────────────────────────

export function labelForKind(kind: FileTypeKind): string {
  return FILE_TYPE_KINDS.find((k) => k.kind === kind)?.label ?? kind
}

export function extensionsForKinds(kinds: FileTypeKind[]): string[] {
  return kinds.flatMap((k) => FILE_TYPE_KINDS.find((x) => x.kind === k)?.extensions ?? [])
}

export function mimesForKinds(kinds: FileTypeKind[]): string[] {
  return kinds.flatMap((k) => FILE_TYPE_KINDS.find((x) => x.kind === k)?.mimes ?? [])
}

/** Value for an <input type="file" accept="..."> covering the given kinds. */
export function acceptAttrForKinds(kinds: FileTypeKind[]): string {
  const exts = extensionsForKinds(kinds).map((e) => `.${e}`)
  const mimes = mimesForKinds(kinds)
  return [...exts, ...mimes].join(',')
}

// ── assignment "accepts" config (stored in assignments.settings.accepts) ──

export interface AssignmentAccepts {
  fileTypes: FileTypeKind[]
}

/** Safely read the accepts config off an assignment's settings JSONB. */
export function parseAccepts(settings: unknown): AssignmentAccepts {
  const raw =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).accepts
      : null
  const fileTypesRaw =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).fileTypes : null
  const fileTypes = Array.isArray(fileTypesRaw)
    ? fileTypesRaw.filter((v): v is FileTypeKind =>
        FILE_TYPE_KIND_VALUES.includes(v as FileTypeKind),
      )
    : []
  return { fileTypes }
}

// ── assignment PDF (professor-uploaded brief/rubric source, in settings.pdf) ──

/** Max size for the professor-uploaded assignment PDF. */
export const MAX_ASSIGNMENT_PDF_SIZE = 25 * 1024 * 1024 // 25 MB

// ── cell images (professor-uploaded, embedded in notebook/verbal cells) ──

/** Max size for an uploaded cell image. Kept under the 5MB studioDocSchema doc cap
 *  (only the URL is stored in the doc, but the file itself must stay small too). */
export const MAX_CELL_IMAGE_SIZE = 5 * 1024 * 1024 // 5 MB

/** MIME types accepted for cell-image upload. SVG is excluded on purpose (a public
 *  SVG can execute script on the storage origin); raster only. Mirrors the bucket
 *  allowlist in the assignment-cell-images migration. */
export const CELL_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export interface AssignmentPdf {
  path: string
  name: string
}

/** Upper bound on PDF briefs attached to one assignment. */
export const MAX_ASSIGNMENT_PDFS = 10

/** Max size for an Athena/assignment attachment (pdf / ppt / image). */
export const MAX_ASSIGNMENT_ATTACHMENT_SIZE = 25 * 1024 * 1024 // 25 MB

const ATTACHMENT_DOC_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
}

/** File-picker `accept` string for the attachment upload control. */
export const ASSIGNMENT_ATTACHMENT_ACCEPT = '.pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/*'

export type AttachmentCheck = { ok: true; contentType: string } | { ok: false; error: string }

/**
 * Validate an assignment attachment: a PDF, a PowerPoint (ppt/pptx), or any raster image,
 * up to 25 MB. SVG is rejected on purpose (a script-bearing vector served from the storage
 * origin). Returns the contentType to store the file as. Pure + testable — the upload action
 * calls this before touching storage.
 */
export function validateAssignmentAttachment(name: string, size: number, type: string): AttachmentCheck {
  if (size <= 0) return { ok: false, error: 'That file looks empty.' }
  if (size > MAX_ASSIGNMENT_ATTACHMENT_SIZE) return { ok: false, error: 'That file is larger than 25 MB.' }
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const t = (type || '').toLowerCase()
  if (t === 'image/svg+xml' || ext === 'svg') return { ok: false, error: 'SVG images are not supported.' }
  // The contentType is ALWAYS derived from the allowlisted EXTENSION, never from the
  // client-supplied MIME. Trusting client MIME let a file named `exploit.html` with a
  // spoofed `image/png` type through the whitelist and be stored with a script-executable
  // extension (stored-XSS on the storage origin). So: unknown/unsafe extension → reject.
  if (ext in ATTACHMENT_DOC_MIME) return { ok: true, contentType: ATTACHMENT_DOC_MIME[ext] }
  if (ext in ATTACHMENT_IMAGE_MIME) return { ok: true, contentType: ATTACHMENT_IMAGE_MIME[ext] }
  return { ok: false, error: 'Upload a PDF, PowerPoint, or image file.' }
}

/** Which content the AI reads when drafting a rubric: the assignment's own content
 *  (notebook/document), one attached PDF brief (by storage path), or a rubric-only
 *  uploaded file stored in settings.rubricSources (never shown to students). */
export type RubricSource =
  | { kind: 'content' }
  | { kind: 'pdf'; path: string }
  | { kind: 'rubric-source'; path: string }
  | { kind: 'answer-key'; path: string }

/** A professor-uploaded file used ONLY for rubric generation. Stored in
 *  settings.rubricSources; never signed or surfaced on the student assignment page. */
export interface AssignmentRubricSourceFile {
  path: string
  name: string
}

/**
 * Read every uploaded PDF brief off settings JSONB. Canonical storage is the
 * `settings.pdfs` array; a legacy single `settings.pdf` is read as a one-item list so
 * assignments created before multi-PDF support keep working.
 */
export function parseAssignmentPdfs(settings: unknown): AssignmentPdf[] {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : null
  if (!s) return []
  const out: AssignmentPdf[] = []
  const push = (raw: unknown) => {
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>
      if (typeof r.path === 'string' && typeof r.name === 'string') out.push({ path: r.path, name: r.name })
    }
  }
  if (Array.isArray(s.pdfs)) s.pdfs.forEach(push)
  else push(s.pdf) // legacy single
  return out
}

/**
 * Read every rubric-only source file off settings JSONB (settings.rubricSources).
 * These are NEVER surfaced to students — they are used solely for AI rubric generation.
 */
export function parseRubricSources(settings: unknown): AssignmentRubricSourceFile[] {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : null
  if (!s || !Array.isArray(s.rubricSources)) return []
  const out: AssignmentRubricSourceFile[] = []
  for (const raw of s.rubricSources) {
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>
      if (typeof r.path === 'string' && typeof r.name === 'string') {
        out.push({ path: r.path, name: r.name })
      }
    }
  }
  return out
}

/** Read the uploaded answer-key source off settings JSONB (settings.answerKeySource). Professor-only.
 *  LEGACY: the source of truth moved to assignment_answer_keys.source_path/source_name (BLOCKER #1);
 *  this remains only as a back-compat fallback for pre-migration assignments whose upload-time
 *  storeAnswerKeyText failed, so the staff pages can still surface the key pointer. New writes never
 *  set settings.answerKeySource. */
export function parseAnswerKeySource(settings: unknown): AssignmentRubricSourceFile | null {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : null
  if (!s) return null
  const raw = s.answerKeySource
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.path === 'string' && typeof r.name === 'string') return { path: r.path, name: r.name }
  }
  return null
}

// ── grading rubric (Gradescope-style, stored in settings.rubric) ──
// AI drafts it from the assignment PDF; the professor reviews/edits. A "question"
// entry can be a whole question or a subquestion (label e.g. "Q1" or "Q2(a)").

export const rubricCriterionSchema = z.object({
  description: z.string().min(1).max(500).describe('What this criterion checks'),
  points: z.number().describe('Points for this criterion (may be negative for a deduction)'),
  // AI-grading fields (professor-authored, seeded from an answer key). NEVER shown to students —
  // strip via stripRubricAiFields before any student-facing surface.
  referenceAnswer: z.string().trim().max(4000).optional(),
  absoluteKeywords: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  /** Alternative CORRECT phrasings of referenceAnswer, embedded as additional positive
   *  vectors. A correct answer worded unlike the key never cosine-matches a single
   *  reference, which is why paraphrase-poor criteria under-award full credit. */
  paraphrases: z.array(z.string().trim().min(1).max(1000)).max(8).optional(),
  /** Plausible WRONG answers, embedded as negative vectors. The decision then becomes
   *  "closer to a positive or to a negative" instead of "above an absolute threshold" —
   *  the only way to separate wrong-but-on-topic answers, which embed as hot as correct ones. */
  distractors: z.array(z.string().trim().min(1).max(1000)).max(6).optional(),
  /** Equivalent surface forms per required keyword ("O(n log n)" ~ "O(n lg n)"). `term`
   *  must appear in absoluteKeywords; any alias counts as satisfying it. */
  keywordAliases: z
    .array(
      z.object({
        term: z.string().trim().min(1).max(80),
        aliases: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
      }),
    )
    .max(12)
    .optional(),
  /** Which tool can actually decide this criterion. 'deterministic' = a literal or parseable
   *  answer settles it; 'similarity' = reference + paraphrases + distractors suffice;
   *  'open' = unbounded correct forms, so never certify from similarity. */
  checkMode: z.enum(['deterministic', 'similarity', 'open']).optional(),
})

/** Hard cap on skill tags per rubric question (schema, save merge, and editor UI). */
export const MAX_SKILLS_PER_QUESTION = 5

/** The skills table's DB check is char_length(name) between 1 and 120 (migration
 *  20260624194443) — every boundary that mints or stores skill names must respect it,
 *  or one over-long name rejects a whole batch insert (see ensureSectionSkills). */
export const MAX_SKILL_NAME_LENGTH = 120

// Skill tags live on the QUESTION, never on individual criteria. The id references the
// section's `skills` table; the name is denormalized for display (ids stay authoritative
// for scoring). Tags always come from the assignment's tagged modules' skill pool.
// Name max matches the DB check: every stored tag name is denormalized from a skills row
// (already ≤120), so no legitimate rubric fails this on re-save.
export const rubricSkillTagSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(MAX_SKILL_NAME_LENGTH),
})

export const rubricQuestionSchema = z.object({
  label: z.string().min(1).max(120).describe('Question or subquestion label, e.g. "Q1" or "Q2(a)"'),
  points: z.number().nonnegative().describe('Total points for this question'),
  criteria: z.array(rubricCriterionSchema).default([]),
  /** When explicitly false, this question is excluded from AI grading and the grade denominator.
   *  Absent or true means graded. Use .optional() so jsonb diffs stay clean (no false→default bloat). */
  graded: z.boolean().optional(),
  // Optional (not defaulted) so pre-existing rubrics and constructors stay valid as-is.
  skills: z.array(rubricSkillTagSchema).max(MAX_SKILLS_PER_QUESTION).optional(),
  /** Partial-credit branches quoted from the key ("2 pts total if bound given is O(n log n)").
   *  NOT criteria: they say how to score, and minting a criterion from one invents something
   *  to grade. Kept so the professor sees them and generation has somewhere to put them.
   *  Professor-only — reveals the classic wrong answer. */
  scoringRules: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
  /** What the key explicitly says NOT to penalize ("No penalty for not mentioning the
   *  disconnected case"). Recording it here is what stops generation turning an instruction
   *  to ignore something into a criterion students lose points for. */
  antiCriteria: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
})

export const assignmentRubricSchema = z.object({
  questions: z.array(rubricQuestionSchema).default([]),
})

// Lenient variant for autosaved *drafts* (a mid-edit rubric may have blank labels/descriptions or
// be over budget — we still want to persist it so nothing is lost). The strict schema above is the
// approval gate applied when the professor clicks "Save rubric".
export const rubricCriterionDraftSchema = z.object({
  description: z.string().max(500),
  points: z.number(),
  // FLAG 5: the draft schema STRIPS unknown keys, so the AI-grading fields must be listed here too
  // or autosave would silently erase reference answers mid-edit. Lenient bounds (draft, not approval).
  referenceAnswer: z.string().max(4000).optional(),
  absoluteKeywords: z.array(z.string().max(80)).max(12).optional(),
  paraphrases: z.array(z.string().max(1000)).max(8).optional(),
  distractors: z.array(z.string().max(1000)).max(6).optional(),
  keywordAliases: z
    .array(z.object({ term: z.string().max(80), aliases: z.array(z.string().max(80)).max(8).default([]) }))
    .max(12)
    .optional(),
  checkMode: z.enum(['deterministic', 'similarity', 'open']).optional(),
})
export const rubricQuestionDraftSchema = z.object({
  label: z.string().max(120),
  points: z.number(),
  criteria: z.array(rubricCriterionDraftSchema).default([]),
  // FLAG: draft schema must include graded AND skills or autosave silently strips them mid-edit.
  graded: z.boolean().optional(),
  skills: z.array(rubricSkillTagSchema).max(MAX_SKILLS_PER_QUESTION).optional(),
  scoringRules: z.array(z.string().max(500)).max(10).optional(),
  antiCriteria: z.array(z.string().max(500)).max(10).optional(),
})
export const assignmentRubricDraftSchema = z.object({
  questions: z.array(rubricQuestionDraftSchema).default([]),
})

export type RubricCriterion = z.infer<typeof rubricCriterionSchema>
export type RubricSkillTag = z.infer<typeof rubricSkillTagSchema>
export type RubricQuestion = z.infer<typeof rubricQuestionSchema>
export type AssignmentRubric = z.infer<typeof assignmentRubricSchema>

// ── Per-question graded helpers ───────────────────────────────────

/** True when a rubric question is included in AI grading + the grade denominator.
 *  Absent or true = graded; only explicit false excludes. */
export function isRubricQuestionGraded(q: Pick<RubricQuestion, 'graded'>): boolean {
  return q.graded !== false
}

/**
 * Sum of `q.points` over graded questions, rounded to 2 decimal places.
 * Returns null when there are no questions, or the graded sum is not finite / not positive.
 * Callers fall back to assignment.points when null. This is what saveAssignmentRubric
 * writes back to assignments.points (the rubric DEFINES the total).
 */
export function gradedRubricTotal(rubric: Pick<AssignmentRubric, 'questions'>): number | null {
  if (rubric.questions.length === 0) return null
  const sum = rubric.questions.reduce(
    (s, q) => (isRubricQuestionGraded(q) ? s + (q.points || 0) : s),
    0,
  )
  const rounded = Math.round(sum * 100) / 100
  return Number.isFinite(rounded) && rounded > 0 ? rounded : null
}

/**
 * Sum of every criterion's points, falling back to 100 when the rubric carries no points at
 * all (grades-qa lineage: display-oriented total for the editor summary / publish panel).
 * NOTE (merge 2026-08-03): this counts CRITERIA and ignores the graded flag, while
 * gradedRubricTotal counts graded QUESTION points and is what saveAssignmentRubric persists.
 * Display surfaces use this; the persisted total uses gradedRubricTotal. Reconcile at PR time.
 */
export const DEFAULT_ASSIGNMENT_POINTS = 100
export function rubricTotalPoints(
  questions: Pick<RubricQuestion, 'criteria'>[],
): number {
  const sum = questions.reduce(
    (s, q) => s + q.criteria.reduce((cs, c) => cs + (c.points || 0), 0),
    0,
  )
  return sum > 0 ? Math.round(sum * 100) / 100 : DEFAULT_ASSIGNMENT_POINTS
}

/**
 * Sum of ticked criterion points, skipping criteria on excluded (graded===false) questions.
 * Accepts either a Set<string> or string[] of selected keys in "<qIdx>:<cIdx>" form.
 * Shared by the grader UI and score displays.
 */
export function computeRubricSelectionTotal(
  rubric: AssignmentRubric,
  selectedKeys: Set<string> | string[],
): number {
  const keySet = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys)
  let total = 0
  for (let qIdx = 0; qIdx < rubric.questions.length; qIdx++) {
    const q = rubric.questions[qIdx]
    if (!isRubricQuestionGraded(q)) continue
    for (let cIdx = 0; cIdx < q.criteria.length; cIdx++) {
      if (keySet.has(`${qIdx}:${cIdx}`)) {
        total += q.criteria[cIdx].points || 0
      }
    }
  }
  return Math.round(total * 100) / 100
}

/**
 * The modules an assignment is tagged with (settings.skillModules) — the source pool for
 * per-question skill tags; the FIRST entry doubles as the roadmap placement. Tagging is
 * compulsory (≥1) for rubric generation/save and publish whenever the section has modules.
 */
export function parseSkillModules(settings: unknown): string[] {
  const s = settings as { skillModules?: unknown } | null
  if (!s || !Array.isArray(s.skillModules)) return []
  return s.skillModules.filter((m): m is string => typeof m === 'string' && !!m.trim())
}

/**
 * Whether the assignment has EVER been through module tagging: the key exists as an array
 * (possibly empty). Distinguishes an explicit untag (`skillModules: []`, which must stick)
 * from a legacy assignment that never had the key (which may back-fill its tagged module
 * from its roadmap placement). See resolveTaggedModules.
 */
export function hasSkillModulesKey(settings: unknown): boolean {
  const s = settings as { skillModules?: unknown } | null
  return !!s && Array.isArray(s.skillModules)
}

/**
 * Point-budget issues in a rubric, for inline professor-facing feedback (merge union of the
 * ai-grading and grades-qa lineages):
 *  - `perQuestion[i]` (ERROR, blocks save): question i's criteria sum EXCEEDS its declared points.
 *  - `perQuestionWarning[i]` (WARNING, non-blocking): criteria sum is UNDER the declared points —
 *    the extra declared points are not grabbable. Advisory only; a partial rubric is legitimate.
 *  - Excluded (graded===false) questions are skipped entirely: no error, no warning, counted in
 *    `excludedCount`, and left out of `gradedSum`.
 * The overall "over the assignment's budget" check is gone on both lineages — the rubric now
 * SETS the assignment points. `questionSum` (all questions) is kept for display parity.
 */
export function rubricPointIssues(
  questions: Pick<RubricQuestion, 'points' | 'criteria' | 'graded'>[],
): {
  overall: string | null
  perQuestion: (string | null)[]
  perQuestionWarning: (string | null)[]
  gradedSum: number
  excludedCount: number
  questionSum: number
  hasError: boolean
} {
  let gradedSum = 0
  let excludedCount = 0
  const questionSum = Math.round(questions.reduce((s, q) => s + (q.points || 0), 0) * 100) / 100
  const perQuestion = questions.map((q) => {
    if (!isRubricQuestionGraded(q)) {
      excludedCount++
      return null
    }
    gradedSum += q.points || 0
    // Round the criteria sum before comparing (E1 float precision): raw 0.1+0.2 = 0.30000000000000004
    // would falsely exceed a declared 0.3 and block the save.
    const critSum = Math.round(q.criteria.reduce((s, c) => s + (c.points || 0), 0) * 100) / 100
    return critSum > q.points
      ? `Criteria add up to ${critSum} pts, over this question's ${q.points}.`
      : null
  })
  const perQuestionWarning = questions.map((q, i) => {
    if (perQuestion[i] || !isRubricQuestionGraded(q)) return null // errors win; excluded skip
    const critSum = Math.round(q.criteria.reduce((s, c) => s + (c.points || 0), 0) * 100) / 100
    return q.points > 0 && critSum < q.points
      ? `Criteria add up to ${critSum} pts, under this question's ${q.points}, so only ${critSum} is grabbable.`
      : null
  })
  gradedSum = Math.round(gradedSum * 100) / 100
  const hasError = perQuestion.some(Boolean)
  return { overall: null, perQuestion, perQuestionWarning, gradedSum, excludedCount, questionSum, hasError }
}

/**
 * Grades stay hidden from students until the professor publishes them. Absent flag = not yet
 * published (hidden) — grading is private by default; the professor releases explicitly.
 */
export function areGradesPublished(settings: unknown): boolean {
  const s = (settings ?? {}) as Record<string, unknown>
  return s.gradesPublished === true
}

/** Read a saved rubric off settings JSONB, or null if none/invalid. */
export function parseRubric(settings: unknown): AssignmentRubric | null {
  const raw =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).rubric
      : null
  const parsed = assignmentRubricSchema.safeParse(raw)
  return parsed.success && parsed.data.questions.length > 0 ? parsed.data : null
}

/**
 * Strip AI-grading fields from a rubric so they NEVER reach a student-facing surface. Returns a
 * new rubric with each criterion reduced to {description, points} only. (FLAG 1: answer-key leak.)
 */
export function stripRubricAiFields(rubric: AssignmentRubric): AssignmentRubric {
  // ALLOWLIST at both levels, never a spread. Question-level AI fields (scoringRules names the
  // classic wrong answer, antiCriteria names what is not graded) leak through `...q`, so new
  // fields must be opted IN here. A field missing from a student view is a bug; a field leaking
  // out of this function is an answer-key disclosure.
  return {
    questions: rubric.questions.map((q) => ({
      label: q.label,
      points: q.points,
      ...(q.graded === false ? { graded: false as const } : {}),
      ...(q.skills ? { skills: q.skills } : {}),
      criteria: q.criteria.map(({ description, points }) => ({ description, points })),
    })),
  }
}

// ── Answer-key split/merge (BLOCKER #1: move AI fields off the student-readable row) ──
// The AI-grading fields are the answer key. They must NOT live in assignments.settings.rubric,
// which the student RLS SELECT policy exposes as a full row (Postgres can't mask JSONB sub-keys).
// splitRubricAi peels them into a separate blob stored in the staff-only assignment_answer_keys
// table; mergeRubricAi reconstructs the full rubric for staff editors + the grader. Alignment is
// by index: criterion fields keyed "<qIdx>:<cIdx>", question fields keyed "<qIdx>".

/** Per-criterion AI fields (the reference answer + matching aids). */
export type RubricCriterionAi = Pick<
  RubricCriterion,
  'referenceAnswer' | 'absoluteKeywords' | 'paraphrases' | 'distractors' | 'keywordAliases' | 'checkMode'
>
/** Per-question AI fields (partial-credit + do-not-penalize notes). */
export type RubricQuestionAi = Pick<RubricQuestion, 'scoringRules' | 'antiCriteria'>

/** The answer-key blob stored in assignment_answer_keys.rubric_ai, aligned to the rubric by index. */
export interface RubricAi {
  /** Criterion AI fields keyed "<qIdx>:<cIdx>". */
  criteria: Record<string, RubricCriterionAi>
  /** Question AI fields keyed "<qIdx>". */
  questions: Record<string, RubricQuestionAi>
}

/** Keys that make up a criterion's AI payload — the allowlist splitRubricAi peels off. */
const CRITERION_AI_KEYS = [
  'referenceAnswer',
  'absoluteKeywords',
  'paraphrases',
  'distractors',
  'keywordAliases',
  'checkMode',
] as const
/** Keys that make up a question's AI payload. */
const QUESTION_AI_KEYS = ['scoringRules', 'antiCriteria'] as const

/** Copy only the given keys that are actually present (skip undefined) into a fresh object. */
function pickPresent<T extends object, K extends keyof T>(src: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = src[k]
  }
  return out
}

/**
 * Split a full (AI-bearing) rubric into the PUBLIC rubric that is safe to store in
 * settings.rubric (label/description/points/graded/skills only) and the answer-key
 * blob (every AI field) that goes to assignment_answer_keys.rubric_ai. The public
 * rubric here is exactly what stripRubricAiFields would produce; the AI blob is what
 * it drops. Pure — no I/O.
 */
export function splitRubricAi(fullRubric: AssignmentRubric): {
  publicRubric: AssignmentRubric
  rubricAi: RubricAi
} {
  const rubricAi: RubricAi = { criteria: {}, questions: {} }
  fullRubric.questions.forEach((q, qIdx) => {
    const qAi = pickPresent(q, QUESTION_AI_KEYS)
    if (Object.keys(qAi).length > 0) rubricAi.questions[String(qIdx)] = qAi
    q.criteria.forEach((c, cIdx) => {
      const cAi = pickPresent(c, CRITERION_AI_KEYS)
      if (Object.keys(cAi).length > 0) rubricAi.criteria[`${qIdx}:${cIdx}`] = cAi
    })
  })
  return { publicRubric: stripRubricAiFields(fullRubric), rubricAi }
}

/**
 * Reconstruct the full rubric by grafting the answer-key AI fields (from
 * assignment_answer_keys.rubric_ai) back onto the public rubric read from
 * settings.rubric. Staff editors + the grader call this before use; student surfaces
 * never do (they only ever see the public rubric). Tolerant of a missing/empty blob
 * (returns the public rubric untouched). Pure — no I/O.
 */
export function mergeRubricAi(
  publicRubric: AssignmentRubric,
  rubricAi: RubricAi | null | undefined,
): AssignmentRubric {
  if (!rubricAi) return publicRubric
  const criteria = rubricAi.criteria ?? {}
  const questions = rubricAi.questions ?? {}
  return {
    questions: publicRubric.questions.map((q, qIdx) => ({
      ...q,
      ...(questions[String(qIdx)] ?? {}),
      criteria: q.criteria.map((c, cIdx) => ({ ...c, ...(criteria[`${qIdx}:${cIdx}`] ?? {}) })),
    })),
  }
}

/** Safely coerce an unknown JSONB value (assignment_answer_keys.rubric_ai) into a RubricAi.
 *  The DB default is `[]` and legacy rows have no criteria/questions maps, so anything that
 *  is not a well-formed object degrades to empty (merge then becomes a no-op). */
export function parseRubricAi(raw: unknown): RubricAi {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { criteria: {}, questions: {} }
  const r = raw as Record<string, unknown>
  const asMap = (v: unknown): Record<string, Record<string, unknown>> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Record<string, unknown>>) : {}
  return { criteria: asMap(r.criteria) as RubricAi['criteria'], questions: asMap(r.questions) as RubricAi['questions'] }
}

/** True when at least one criterion on a GRADED question has a non-empty referenceAnswer.
 *  Excluded (graded===false) questions are skipped — their vectors are pruned and never used. */
export function rubricHasReferences(rubric: AssignmentRubric | null): boolean {
  if (!rubric) return false
  return rubric.questions.some(
    (q) => isRubricQuestionGraded(q) && q.criteria.some((c) => !!c.referenceAnswer?.trim()),
  )
}

/** State of the AI-grading reference index for an assignment (settings.aiGrading). */
export interface AiGradingState {
  status: 'ready' | 'failed' | 'none'
  refCount: number
  embeddedAt?: string
}

/** Safely read the AI-grading state off settings JSONB; absent/invalid => {status:'none', refCount:0}. */
export function parseAiGradingState(settings: unknown): AiGradingState {
  const raw =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).aiGrading
      : null
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (
      (r.status === 'ready' || r.status === 'failed' || r.status === 'none') &&
      typeof r.refCount === 'number'
    ) {
      return {
        status: r.status,
        refCount: r.refCount,
        embeddedAt: typeof r.embeddedAt === 'string' ? r.embeddedAt : undefined,
      }
    }
  }
  return { status: 'none', refCount: 0 }
}

/**
 * Read the autosaved, not-yet-approved rubric draft off settings.rubricDraft (lenient parse, since
 * a mid-edit draft may have blanks/over-budget points). Returned as AssignmentRubric so the editor
 * can seed from it; the approval save re-validates strictly.
 */
export function parseRubricDraft(settings: unknown): AssignmentRubric | null {
  const raw =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).rubricDraft
      : null
  const parsed = assignmentRubricDraftSchema.safeParse(raw)
  return parsed.success && parsed.data.questions.length > 0 ? (parsed.data as AssignmentRubric) : null
}

// ── assessment mode config (stored in assignments.settings.assessment) ──
// Turns an assignment into a timed, proctored "exam". The three proctoring flags map
// to the three separable pieces of the reused quiz proctoring engine:
//   activity  → keyboard / clipboard / tab-switch capture (one bundled listener set)
//   fullscreen→ fullscreen enforcement
//   video     → webcam face / phone detection
// All timing is server-anchored off assignment_submissions.assessment_started_at.

/** Default handout window (minutes) the student gets to upload after work time ends. */
export const DEFAULT_ASSESSMENT_UPLOAD_MINUTES = 3
/** Default work window (minutes) when a professor first enables assessment mode. */
export const DEFAULT_ASSESSMENT_WORK_MINUTES = 60

export const assessmentProctoringSchema = z.object({
  activity: z.boolean().default(true),
  fullscreen: z.boolean().default(true),
  video: z.boolean().default(false),
})
export type AssessmentProctoring = z.infer<typeof assessmentProctoringSchema>

export const assessmentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // null = untimed work phase (students aren't limited; they finish when ready).
  workMinutes: z.number().int().min(1).max(480).nullable().default(DEFAULT_ASSESSMENT_WORK_MINUTES),
  uploadMinutes: z.number().int().min(1).max(60).default(DEFAULT_ASSESSMENT_UPLOAD_MINUTES),
  proctoring: assessmentProctoringSchema.default({ activity: true, fullscreen: true, video: false }),
})
export type AssessmentConfig = z.infer<typeof assessmentConfigSchema>

/** Safely read the assessment config off an assignment's settings JSONB.
 *  Absent/invalid => a disabled default (assessment off), never throws. */
export function parseAssessment(settings: unknown): AssessmentConfig {
  const raw =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>).assessment
      : null
  const parsed = assessmentConfigSchema.safeParse(raw ?? {})
  return parsed.success
    ? parsed.data
    : {
        enabled: false,
        workMinutes: DEFAULT_ASSESSMENT_WORK_MINUTES,
        uploadMinutes: DEFAULT_ASSESSMENT_UPLOAD_MINUTES,
        proctoring: { activity: true, fullscreen: true, video: false },
      }
}

// ── submission file metadata (stored in assignment_submissions.files) ──

export interface SubmissionFile {
  path: string
  name: string
  size: number
  type: string
}

// ── Zod schemas ──────────────────────────────────────────────────

export const createAssignmentSchema = z.object({
  title: z.string().trim().min(1, 'Give your assignment a title').max(200),
  instructions: z.string().trim().max(20000).optional().default(''),
  dueAt: z.string().trim().min(1).nullable().optional(),
  points: z.coerce.number().min(0).max(1000).default(100),
  fileTypes: z.array(z.enum(FILE_TYPE_KIND_VALUES)).default([]),
  /** false ⇒ ungraded: no points/score, no auto-zero, excluded from the gradebook. */
  isGraded: z.boolean().default(true),
  /** When set (ISO), the assignment is created as `scheduled` and auto-publishes then. */
  scheduleAt: z.string().trim().min(1).nullable().optional(),
})
export type CreateAssignmentInput = z.input<typeof createAssignmentSchema>

/** Publish settings collected from the studio's Publish dialog (deadline + file types
 *  + optional timed/proctored assessment config + graded flag).
 *  NOTE: points is intentionally NOT here — the rubric is the single source of the total
 *  (saveAssignmentRubric derives + writes assignments.points). Accepting points on the publish
 *  path let a stale/crafted client overwrite the derived value; the publish write no longer
 *  touches points at all. */
export const publishSettingsSchema = z.object({
  dueAt: z.string().trim().min(1).nullable().optional(),
  fileTypes: z.array(z.enum(FILE_TYPE_KIND_VALUES)).default([]),
  scheduleAt: z.string().trim().min(1).nullable().optional(),
  assessment: assessmentConfigSchema.optional(),
  /** false = ungraded (excluded from the gradebook). */
  isGraded: z.boolean().optional(),
  /** Picker-mode roadmap placement (verbal assessments): the module chosen in the Publish
   *  step. Tagged (skillModules) assignments ignore this — the server places under the
   *  first tagged module, resolved fresh at publish time. */
  pickerModuleId: z.string().uuid().nullable().optional(),
})
export type PublishSettingsInput = z.input<typeof publishSettingsSchema>

export const updateAssignmentSchema = createAssignmentSchema.partial().extend({
  assignmentId: z.string().uuid(),
})

/** Edit just the due date + total points from the assignment detail header. */
export const updateAssignmentMetaSchema = z.object({
  dueAt: z.string().trim().min(1).nullable().optional(),
  points: z.coerce.number().min(0).max(1000),
})
export type UpdateAssignmentMetaInput = z.input<typeof updateAssignmentMetaSchema>

/** Save just the assignment instructions (the "supporting files" step in the studio). */
export const assignmentInstructionsSchema = z.object({
  description: z.string().max(20000),
})

export const submitAssignmentTextSchema = z.object({
  text: z.string().max(50000).optional().default(''),
})

/** Per-rubric-question inline comments from the professor. Shape: { "<questionIndex>": "text" }.
 *  Keys must be numeric strings 0-199; values are trimmed and empty values are stripped before save. */
const rubricCommentsSchema = z
  .record(z.string().regex(/^\d{1,3}$/), z.string().max(5000))
  .optional()

/** Ceiling on an assignment's total points — mirrors the bound on `assignments.points`.
 *  A rubric's derived total is checked against this so an over-budget rubric is reported as
 *  the validation problem it is, rather than failing downstream as a generic save error. */
export const MAX_ASSIGNMENT_POINTS = 1000

/** Ceiling on grader feedback. Enforced in three places that must not drift: the schema
 *  below, the textarea's maxLength, and Athena's fill (which writes state directly and so
 *  bypasses the textarea entirely). */
export const MAX_GRADE_FEEDBACK_LENGTH = 10_000

/**
 * Shown when another grader saved this submission while the current one had it open.
 *
 * The copy deliberately does NOT just say "reload": the grader may have typed thousands of
 * characters of feedback, and reloading discards it. An error whose recommended fix destroys
 * the user's work is worse than the error. It tells them to rescue the work first.
 */
export const GRADE_CONFLICT_MESSAGE =
  'Someone else graded this submission while you had it open. ' +
  'Copy your feedback somewhere safe before reloading — reloading shows their grade and discards yours.'

export const gradeSubmissionSchema = z.object({
  submissionId: z.string().uuid(),
  /** The submission's `updated_at` as the grader's page saw it. Optional so an older client
   *  keeps working, but without it the save cannot be checked for a concurrent grade. */
  expectedUpdatedAt: z.string().optional(),
  score: z.coerce.number().min(0).max(1000),
  feedback: z.string().max(MAX_GRADE_FEEDBACK_LENGTH).optional().default(''),
  /** Ticked rubric criterion keys ("<qIdx>:<cIdx>"); the score is their points summed. */
  rubricScores: z.array(z.string().max(40)).max(500).optional(),
  /** Per-question inline comments from the professor. */
  rubricComments: rubricCommentsSchema,
  /** `updated_at` of the AI suggestion the grader reviewed, when one was shown. Gates the
   *  criterion-level correction capture (calibration flywheel): if the live suggestion was
   *  re-drafted since the page rendered, capture is skipped rather than diffing decisions
   *  against a draft the professor never saw. Never affects the grade save itself. */
  suggestionUpdatedAt: z.string().optional(),
})
export type GradeSubmissionInput = z.input<typeof gradeSubmissionSchema>

/** Grading a student by id (used when there is no submission row yet). Same score/feedback rules
 *  as gradeSubmissionSchema, minus submissionId. */
export const gradeStudentInputSchema = z.object({
  score: z.coerce.number().min(0).max(1000),
  feedback: z.string().max(MAX_GRADE_FEEDBACK_LENGTH).optional().default(''),
  rubricScores: z.array(z.string().max(40)).max(500).optional(),
  /** Per-question inline comments from the professor. */
  rubricComments: rubricCommentsSchema,
})

/** Validates the window parameter for reopenSubmission / requestChanges.
 *  Accepts either { hours } (1–720) or { until } (ISO, must be future, max 30 days out).
 *  Default 24h when omitted so existing callers are unaffected. */
export const reopenWindowSchema = z
  .union([
    z.object({ hours: z.number().int().min(1).max(720) }),
    z.object({
      until: z
        .string()
        .datetime({ offset: true })
        .refine((v) => new Date(v).getTime() > Date.now(), { message: 'Reopen window must be in the future.' })
        .refine(
          (v) => new Date(v).getTime() - Date.now() <= 30 * 24 * 60 * 60 * 1000,
          { message: 'Reopen window cannot exceed 30 days.' },
        ),
    }),
  ])
  .optional()

export type ReopenWindow = z.infer<typeof reopenWindowSchema>

/** Resolve a ReopenWindow into an ISO expiry string. Returns 24h from now when omitted. */
export function resolveReopenUntil(window: ReopenWindow, nowMs: number = Date.now()): string {
  if (!window) return new Date(nowMs + 24 * 60 * 60 * 1000).toISOString()
  if ('hours' in window) return new Date(nowMs + window.hours * 60 * 60 * 1000).toISOString()
  return window.until
}

// ── regrade requests + per-subquestion comments ──────────────────
// The client sends subquestion INDEXES only, never labels — labels are re-snapshotted
// server-side from the assignment's own rubric (a forged label would render in the
// professor UI, so it must never originate from the client).

export const requestRegradeSchema = z.object({
  questionIndexes: z.array(z.number().int().min(0).max(199)).max(50).default([]),
  reason: z.string().trim().min(1, 'Explain what you would like re-checked.').max(5000),
})
export type RequestRegradeInput = z.input<typeof requestRegradeSchema>

export const submissionCommentSchema = z.object({
  questionIndex: z.number().int().min(0).max(199),
  body: z.string().trim().min(1, 'Write a comment before posting.').max(5000),
})
export type SubmissionCommentInput = z.input<typeof submissionCommentSchema>

/** A targeted subquestion on a regrade request: its rubric index plus a label snapshot. */
export interface RegradeQuestionRef {
  index: number
  label: string
}

/**
 * Validate the subquestions a student targets against the assignment's OWN rubric and
 * re-snapshot each label server-side (client labels are ignored — see note above).
 *  - rubric === null (no rubric): valid only with an empty selection (reason-only appeal).
 *  - rubric present: require ≥1 index, dedupe, reject any out-of-range index.
 */
export function validateRegradeQuestions(
  rubric: AssignmentRubric | null,
  indexes: number[],
): { ok: true; questions: RegradeQuestionRef[] } | { ok: false; error: string } {
  if (!rubric) {
    if (indexes.length > 0) {
      return { ok: false, error: 'This assignment has no rubric to target — send a reason instead.' }
    }
    return { ok: true, questions: [] }
  }
  if (indexes.length === 0) {
    return { ok: false, error: 'Select at least one question to have re-checked.' }
  }
  const unique = [...new Set(indexes)].sort((a, b) => a - b)
  const questions: RegradeQuestionRef[] = []
  for (const index of unique) {
    const q = rubric.questions[index]
    if (!q) return { ok: false, error: 'One of the selected questions no longer exists.' }
    questions.push({ index, label: q.label || `Question ${index + 1}` })
  }
  return { ok: true, questions }
}

// ── row shapes (subset of DB columns the UI reads) ───────────────

export type AssignmentStatus = 'draft' | 'scheduled' | 'published' | 'closed' | 'archived'
export type SubmissionStatus = 'draft' | 'submitted' | 'graded' | 'returned'

export interface AssignmentRow {
  id: string
  section_id: string
  title: string
  description: string
  status: AssignmentStatus
  points: number
  due_at: string | null
  settings: { accepts?: AssignmentAccepts } & Record<string, unknown>
  created_at: string
  is_graded: boolean
  scheduled_publish_at: string | null
}

export interface SubmissionRow {
  id: string
  assignment_id: string
  student_id: string
  status: SubmissionStatus
  text_content: string | null
  files: SubmissionFile[]
  /** Verbal-assessment per-cell answers (transcripts + MCQ picks); [] for other kinds. */
  answers?: VerbalSubmissionAnswer[]
  score: number | null
  feedback: string
  submitted_at: string | null
  graded_at: string | null
  /** Concurrency token. The grader sends this back as `expectedUpdatedAt` so a save can be
   *  refused when someone else graded the row in the meantime. */
  updated_at?: string | null
  rubric_scores?: string[]
  /** True when the grade was saved while a rubric existed (even with zero criteria ticked);
   *  false = manual score field or a grade that predates the rubric. */
  graded_with_rubric?: boolean
  /** Per-rubric-question inline comments from the professor. Shape: { "<qIdx>": "text" }. */
  rubric_comments?: Record<string, string> | null
  /** Assessment proctoring summary (advisory); null/absent for non-assessment submissions. */
  proctoring_summary?: ProctoringSummary | null
  /** Professor-granted late-submission window end time, or null. */
  resubmit_until?: string | null
  /** Timestamp when the student requested a late submission (null = not requested). */
  late_request_at?: string | null
}

export type RegradeStatus = 'open' | 'resolved' | 'withdrawn'

export interface RegradeRequestRow {
  id: string
  submission_id: string
  questions: RegradeQuestionRef[]
  reason: string
  status: RegradeStatus
  old_score: number | null
  new_score: number | null
  resolution_note: string
  resolved_at: string | null
  created_at: string
}

export interface SubmissionCommentRow {
  id: string
  submission_id: string
  question_index: number
  question_label: string
  author_id: string
  author_role: 'student' | 'staff'
  body: string
  created_at: string
  /** Joined author profile (name for display); optional depending on the query. */
  author?: { name: string | null } | null
}

export interface VerbalSubmissionAnswer {
  cellId: string
  type: 'greeting' | 'question' | 'mcq' | 'ai_followup'
  prompt: string
  transcript: string
  selectedOptionId?: string
  selectedOptionText?: string
  /** Seconds from the start of the recording where this question began. */
  videoOffset?: number
}
