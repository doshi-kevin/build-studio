/**
 * Athena ↔ Quiz Studio adapter: translates the generic authoring ops into the studio's
 * own `WizardQuestion` shape, and serializes the quiz into the generic AuthoringState the
 * panel snapshots each turn.
 *
 * Pure + immutable (mirrors the notebook/verbal adapters), so it's unit-testable and the
 * studio stays thin: the studio calls applyQuizOps inside a functional setState and drops
 * the result into React state.
 *
 * This is the CLIENT write path for kind='quiz'. Nothing here persists — the studio's
 * existing debounced autosave commits, exactly as when the professor edits by hand.
 *
 * Two representations meet here, and the translation is the whole job:
 *   the MODEL speaks clean arrays — tags: string[], acceptedAnswers: string[],
 *   blanks[].acceptedAnswers: string[], choices without ids;
 *   the STUDIO stores comma-joined strings, {value}[] objects, and id-bearing choices,
 *   with fill-in-blank answers living inline in the question text as {{blank:id:a|b}}.
 * Doing it here (like the verbal adapter does for MCQ options) keeps the model's schema
 * simple, which is the single biggest lever on tool-call accuracy.
 */
import { createBlankQuestion, type WizardQuestion } from '@/components/professor/quizzes/wizard/QuestionEditorCard'
import { generateId } from '@/lib/quiz/utils'
import {
  blankPlaceholderText,
  newBlankId,
  parseBlanks,
  segmentFillInBlankText,
  serializeBlankToken,
} from '@/lib/quiz/fill-in-blank'
import type { AuthoringState } from '@/lib/ai/assignment-assistant/schemas'
import type { QuizOp, QuizQuestionFields, QuizSettingsPayload } from '@/lib/ai/assignment-assistant/templates/registry'
import type { QuizItemType } from '@/lib/validations/quiz'

/** Per-question content budget in the <screen> snapshot. The schema caps `content` at
 *  4000; questions are normally a few hundred chars, so this only clips outliers. */
const QUESTION_PREVIEW_MAX = 3800

/** The quiz-wide settings Athena may read and write. Deliberately NOT the full form:
 *  publish state, scheduling, proctoring, the formula sheet and IRT tuning stay the
 *  professor's alone, so they are absent from this type by design. */
export interface QuizAthenaSettings {
  title: string
  description: string
  timeLimitMinutes: number | null
  maxAttempts: number | null
  passThreshold: number
  dueDate: string | null
  shuffleQuestions: boolean
  shuffleAnswers: boolean
  showExplanations: 'after_submission' | 'after_due_date' | 'never'
  negativeMarking: boolean
  negativeMarkingPenalty: number
  adaptiveMode: boolean
  /** Live to students right now. Athena is told so it stops silently renaming / re-settling a
   *  quiz students are already looking at (QA watched it rename a published quiz and switch it
   *  to Adaptive mode uninvited). Without this field the prompt rule cannot fire at all. */
  isPublished?: boolean
}

/** What the studio reports about generation: a run in flight, and/or the last run's
 *  requested-vs-delivered so Athena can explain a shortfall instead of looking confused
 *  at a quiz that came back short. */
export interface QuizGenerationState {
  isGenerating: boolean
  generatedSoFar?: number
  requested?: number
  lastRun?: { requested: number; delivered: number }
}

// ── serialization (studio → Athena) ──────────────────────────────

function renderAnswerKey(q: WizardQuestion): string[] {
  const lines: string[] = []
  switch (q.questionType) {
    case 'multiple_choice': {
      const filled = q.choices.filter((c) => c.text.trim())
      lines.push(...filled.map((c, i) => `  ${i + 1}. ${c.text}${c.isCorrect ? '  ✓' : ''}`))
      if (q.allowMultiple) lines.push('  (multiple answers allowed)')
      if (!filled.length) lines.push('  (no choices yet)')
      break
    }
    case 'true_false':
      lines.push(`  correct answer: ${q.correctAnswer ? 'True' : 'False'}`)
      break
    case 'short_answer': {
      const answers = q.acceptedAnswers.map((a) => a.value).filter((v) => v.trim())
      lines.push(answers.length ? `  accepted: ${answers.join(' | ')}` : '  (no accepted answers yet)')
      if (q.caseSensitive) lines.push('  (case sensitive)')
      break
    }
    case 'fill_in_blank': {
      if (!q.blanks.length) lines.push('  (no blanks yet)')
      q.blanks.forEach((b, i) => {
        lines.push(`  blank ${i + 1}: ${b.acceptedAnswers.trim() || '(no accepted answers yet)'}`)
      })
      break
    }
    case 'explanation':
    case 'walkthrough': {
      const concepts = (q.rubric ?? []).filter((n) => n.concept.trim())
      if (q.questionType === 'walkthrough') {
        lines.push(`  opening: ${q.opening.trim() || '(none yet)'}`, `  tutor turns: ${q.maxTurns}`)
      }
      lines.push(
        concepts.length
          ? `  rubric: ${concepts.map((n) => n.concept).join(' | ')}`
          : '  rubric: NONE YET — every answer scores zero and the quiz cannot be published until this is filled',
      )
      break
    }
  }
  return lines
}

/** One question rendered for the model: the FULL stem plus its real answer key, so it
 *  never has to edit something it can only half-see. */
function renderQuestion(q: WizardQuestion): string {
  const stem = q.questionType === 'fill_in_blank' ? blankPlaceholderText(q.questionText) : q.questionText
  const meta = [
    q.difficulty,
    `${q.points} ${q.points === 1 ? 'point' : 'points'}`,
    q.bloomsLevel ? `bloom: ${q.bloomsLevel}` : null,
    q.tags.trim() ? `tags: ${q.tags}` : null,
    q.isBonus ? 'bonus' : null,
    q.dbId ? null : '[not yet saved]',
  ]
    .filter(Boolean)
    .join(' · ')

  const lines = [stem.trim() || '(no question text yet)', ...renderAnswerKey(q), `  — ${meta}`]
  if (q.explanation.trim()) lines.push(`  explanation: ${q.explanation}`)

  const out = lines.join('\n')
  return out.length > QUESTION_PREVIEW_MAX ? `${out.slice(0, QUESTION_PREVIEW_MAX)}\n…(truncated)` : out
}

export function serializeQuizForAthena(
  questions: WizardQuestion[],
  settings: QuizAthenaSettings,
  gen: QuizGenerationState,
): AuthoringState {
  // `meta` only accepts scalars, so nulls are omitted rather than sent as null.
  const meta: NonNullable<AuthoringState['meta']> = {
    title: settings.title || '(untitled)',
    questionCount: questions.length,
    totalPoints: questions.reduce((n, q) => n + (q.isBonus ? 0 : q.points), 0),
    // Spelled out rather than omitted like the other nulls: a missing attempts line
    // reads to Athena as "unset", but null here is a real setting — unlimited retakes.
    maxAttempts: settings.maxAttempts ?? 'no limit',
    passThreshold: settings.passThreshold,
    shuffleQuestions: settings.shuffleQuestions,
    shuffleAnswers: settings.shuffleAnswers,
    showExplanations: settings.showExplanations,
    negativeMarking: settings.negativeMarking,
    adaptiveMode: settings.adaptiveMode,
    isGenerating: gen.isGenerating,
    // Spelled out rather than a bare boolean: the prompt's published-subject rule keys off
    // this line, and "PUBLISHED — students can see this now" is unmissable in the <screen>
    // render where `isPublished: true` would read as one more setting.
    status: settings.isPublished ? 'PUBLISHED — students can see this now' : 'draft — not visible to students',
  }
  if (settings.description) meta.description = settings.description
  if (settings.timeLimitMinutes !== null) meta.timeLimitMinutes = settings.timeLimitMinutes
  if (settings.dueDate) meta.dueDate = settings.dueDate
  if (settings.negativeMarking) meta.negativeMarkingPenalty = settings.negativeMarkingPenalty
  if (gen.isGenerating) {
    meta.generatedSoFar = gen.generatedSoFar ?? 0
    meta.requested = gen.requested ?? 0
  }
  // A short last run is the one thing Athena must volunteer: the professor asked for 30
  // and got 22 because the material ran dry, and only she can offer the follow-up.
  if (gen.lastRun && gen.lastRun.delivered < gen.lastRun.requested) {
    meta.lastRunRequested = gen.lastRun.requested
    meta.lastRunDelivered = gen.lastRun.delivered
  }

  return {
    kind: 'quiz',
    meta,
    components: questions.map((q) => ({
      id: q.clientId,
      type: q.questionType,
      content: renderQuestion(q),
    })),
  }
}

// ── ops (Athena → studio) ────────────────────────────────────────

const SKIP_REASONS = {
  noType: 'a new question needs a question type',
  unknownId: 'no question with that id is on screen',
  typeLocked: 'a question that is already saved cannot change type — remove it and add a replacement',
  mcqChoices: 'a multiple-choice question needs at least 2 choices with one marked correct',
  rubric: 'an explanation or walkthrough question needs at least one rubric concept',
  blankMismatch: 'the number of _____ markers must match the number of blanks',
  noBlanks: 'a fill-in-the-blank question needs a _____ marker for each blank',
} as const

/** The two AI-graded types the studio refuses to save unless Adaptive is on. */
function isAdaptiveOnly(type: WizardQuestion['questionType']): boolean {
  return type === 'explanation' || type === 'walkthrough'
}

function commaJoin(values: string[] | undefined): string | undefined {
  if (!values) return undefined
  return values.map((v) => v.trim()).filter(Boolean).join(', ')
}

/**
 * Rebuild fill-in-blank text + blanks together. The studio's canonical form keeps the
 * answers INLINE in the text as {{blank:id:a|b}} and derives `blanks` from it (exactly
 * what InlineBlankEditor does), so this converts the model's plain `_____` markers into
 * tokens and then derives the array — the two can never drift apart.
 *
 * Answers come from the model's `blanks` when it sent them, otherwise from the question's
 * EXISTING blanks positionally — so "fix the typo in the sentence" keeps its answer key
 * instead of blanking it.
 */
function buildFillInBlank(
  text: string,
  supplied: QuizQuestionFields['blanks'],
  existing: WizardQuestion['blanks'],
): { questionText: string; blanks: WizardQuestion['blanks'] } | { error: string } {
  // Tokenize raw _____ markers wherever they appear — INCLUDING text that already carries
  // {{blank:…}} tokens, which is the normal shape when Athena adds a blank to an existing
  // question. Guarding this on "no tokens yet" left the new marker raw, so the marker count
  // and the blanks array disagreed and the studio flagged the question unsavable.
  // Rebuilt segment by segment so replacement never reaches inside an existing token
  // (an accepted answer is free to contain underscores of its own).
  const rawMarker = /_{3,}/g
  const segments = segmentFillInBlankText(text)
  const rawMarkerCount = segments
    .filter((seg) => seg.type === 'text')
    .reduce((n, seg) => n + ((seg.value.match(rawMarker) ?? []).length), 0)
  const existingTokenCount = segments.filter((seg) => seg.type === 'blank').length

  if (rawMarkerCount === 0 && existingTokenCount === 0) return { error: SKIP_REASONS.noBlanks }
  // When the model sends blanks explicitly, its count must describe the whole question.
  if (supplied && supplied.length !== rawMarkerCount + existingTokenCount) {
    return { error: SKIP_REASONS.blankMismatch }
  }

  let slot = 0
  const canonical = segments
    .map((seg) => {
      if (seg.type === 'blank') {
        // Keep the existing token, but let an explicit blanks[] re-key its answers.
        const answers = supplied?.[slot]?.acceptedAnswers ?? seg.acceptedAnswers
        slot += 1
        return serializeBlankToken(seg.id, answers)
      }
      return seg.value.replace(rawMarker, () => {
        const answers =
          supplied?.[slot]?.acceptedAnswers ??
          (existing[slot]?.acceptedAnswers ?? '').split(',').map((a) => a.trim()).filter(Boolean)
        slot += 1
        return serializeBlankToken(newBlankId(), answers)
      })
    })
    .join('')

  const parsed = parseBlanks(canonical)
  if (!parsed.length) return { error: SKIP_REASONS.noBlanks }
  return {
    questionText: canonical,
    blanks: parsed.map((b, i) => ({
      id: b.id,
      acceptedAnswers: b.acceptedAnswers.join(', '),
      caseSensitive: supplied?.[i]?.caseSensitive ?? existing[i]?.caseSensitive ?? false,
    })),
  }
}

/** Apply the model's fields onto a question. Returns an error string when the result
 *  would be unusable, so the caller can skip the op instead of half-applying it. */
function applyFields(base: WizardQuestion, f: QuizQuestionFields): WizardQuestion | { error: string } {
  const next: WizardQuestion = { ...base }

  if (f.difficulty !== undefined) next.difficulty = f.difficulty
  if (f.bloomsLevel !== undefined) next.bloomsLevel = f.bloomsLevel
  if (f.points !== undefined) next.points = f.points
  if (f.explanation !== undefined) next.explanation = f.explanation
  if (f.isBonus !== undefined) next.isBonus = f.isBonus
  const tags = commaJoin(f.tags)
  if (tags !== undefined) next.tags = tags

  if (f.choices !== undefined) {
    next.choices = f.choices.map((c) => ({ id: generateId(), text: c.text, isCorrect: c.isCorrect }))
  }
  if (f.allowMultiple !== undefined) next.allowMultiple = f.allowMultiple
  if (f.correctAnswer !== undefined) next.correctAnswer = f.correctAnswer
  if (f.acceptedAnswers !== undefined) next.acceptedAnswers = f.acceptedAnswers.map((value) => ({ value }))
  if (f.caseSensitive !== undefined) next.caseSensitive = f.caseSensitive
  if (f.rubric !== undefined) next.rubric = f.rubric.map((n) => ({ concept: n.concept, match: n.match }))
  if (f.opening !== undefined) next.opening = f.opening
  if (f.maxTurns !== undefined) next.maxTurns = f.maxTurns

  if (next.questionType === 'fill_in_blank') {
    // Rebuild whenever either side moves — the text and the blanks are one unit here.
    if (f.questionText !== undefined || f.blanks !== undefined) {
      const built = buildFillInBlank(f.questionText ?? next.questionText, f.blanks, base.blanks)
      if ('error' in built) return built
      next.questionText = built.questionText
      next.blanks = built.blanks
    }
  } else if (f.questionText !== undefined) {
    next.questionText = f.questionText
  }

  // Type-specific minimums. These mirror wizardQuestionInlineError so Athena can never
  // hand the professor a question the studio will refuse to save.
  if (next.questionType === 'multiple_choice') {
    const filled = next.choices.filter((c) => c.text.trim())
    if (filled.length < 2 || !filled.some((c) => c.isCorrect)) return { error: SKIP_REASONS.mcqChoices }
  }
  if (next.questionType === 'explanation' || next.questionType === 'walkthrough') {
    if (!(next.rubric ?? []).some((n) => n.concept.trim())) return { error: SKIP_REASONS.rubric }
  }

  return next
}

function indexOf(questions: WizardQuestion[], id: string | undefined): number {
  if (!id) return -1
  return questions.findIndex((q) => q.clientId === id || q.dbId === id)
}

export interface ApplyQuizOpsResult {
  questions: WizardQuestion[]
  summary: string
  changed: number
  /** The last question inserted or updated, so the studio can select it. */
  touchedId: string | null
}

/**
 * Apply a batch of question ops. Ops carry optional fields (the schema is flat for
 * Gemini reliability), so each is validated here: one that lacks what it needs, targets
 * a missing question, or would produce an unsavable question is SKIPPED and NOT counted
 * — and the reason lands in `summary`, so the model can correct itself next turn instead
 * of being told "nothing changed" with no explanation.
 */
export function applyQuizOps(
  questions: WizardQuestion[],
  ops: QuizOp[],
  opts: { adaptiveMode?: boolean } = {},
): ApplyQuizOpsResult {
  let next = questions
  let touchedId: string | null = null
  const counts = { inserted: 0, updated: 0, removed: 0, reordered: 0 }
  const skipped: string[] = []
  // An explanation/walkthrough item cannot be SAVED while Adaptive is off — the studio
  // blocks publishing it. Athena is allowed to add one (the professor may be about to turn
  // Adaptive on), but staying silent left them holding an unpublishable quiz with no hint
  // why. So the summary says it, which both shows in the chip and reaches the model.
  let needsAdaptive = false

  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        const type = op.question?.questionType
        if (!type) {
          skipped.push(SKIP_REASONS.noType)
          break
        }
        const built = applyFields(createBlankQuestion(type as QuizItemType), op.question ?? {})
        if ('error' in built) {
          skipped.push(built.error)
          break
        }
        const at = indexOf(next, op.afterId)
        next = at === -1 ? [...next, built] : [...next.slice(0, at + 1), built, ...next.slice(at + 1)]
        touchedId = built.clientId
        counts.inserted++
        if (isAdaptiveOnly(built.questionType) && opts.adaptiveMode === false) needsAdaptive = true
        break
      }
      case 'update': {
        const at = indexOf(next, op.id)
        if (at === -1) {
          skipped.push(SKIP_REASONS.unknownId)
          break
        }
        const target = next[at]
        const fields = op.question ?? {}
        // The studio disables the type selector once a question is persisted; Athena
        // must not be able to do what the professor cannot.
        if (fields.questionType && fields.questionType !== target.questionType && target.dbId) {
          skipped.push(SKIP_REASONS.typeLocked)
          break
        }
        const retyped = fields.questionType && fields.questionType !== target.questionType
        const base = retyped
          ? { ...createBlankQuestion(fields.questionType as QuizItemType), clientId: target.clientId }
          : target
        const built = applyFields(base, fields)
        if ('error' in built) {
          skipped.push(built.error)
          break
        }
        next = [...next.slice(0, at), built, ...next.slice(at + 1)]
        touchedId = built.clientId
        counts.updated++
        if (isAdaptiveOnly(built.questionType) && opts.adaptiveMode === false) needsAdaptive = true
        break
      }
      case 'remove': {
        const at = indexOf(next, op.id)
        if (at === -1) {
          skipped.push(SKIP_REASONS.unknownId)
          break
        }
        next = [...next.slice(0, at), ...next.slice(at + 1)]
        counts.removed++
        break
      }
      case 'reorder': {
        const from = indexOf(next, op.id)
        if (from === -1) {
          skipped.push(SKIP_REASONS.unknownId)
          break
        }
        const rest = [...next.slice(0, from), ...next.slice(from + 1)]
        const anchor = indexOf(rest, op.afterId)
        const to = op.afterId ? (anchor === -1 ? rest.length : anchor + 1) : 0
        next = [...rest.slice(0, to), next[from], ...rest.slice(to)]
        counts.reordered++
        break
      }
    }
  }

  const parts: string[] = []
  const plural = (n: number) => (n > 1 ? 'questions' : 'question')
  if (counts.inserted) parts.push(`added ${counts.inserted} ${plural(counts.inserted)}`)
  if (counts.updated) parts.push(`edited ${counts.updated} ${plural(counts.updated)}`)
  if (counts.removed) parts.push(`removed ${counts.removed} ${plural(counts.removed)}`)
  if (counts.reordered) parts.push(`reordered ${counts.reordered} ${plural(counts.reordered)}`)

  const changed = counts.inserted + counts.updated + counts.removed + counts.reordered
  if (needsAdaptive && changed > 0) {
    parts.push('Adaptive mode must be turned on before it can be saved')
  }
  const done = parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : ''
  // De-duplicated so five identical skips read as one sentence, not five.
  const why = [...new Set(skipped)].join('; ')
  const summary = done
    ? why
      ? `${done} · skipped ${skipped.length}: ${why}`
      : done
    : why
      ? `Nothing changed — ${why}`
      : 'Nothing to change'

  return { questions: next, summary, changed, touchedId }
}

// ── settings ─────────────────────────────────────────────────────

const SETTING_LABELS: Record<keyof QuizSettingsPayload, string> = {
  title: 'title',
  description: 'description',
  timeLimitMinutes: 'time limit',
  maxAttempts: 'attempts',
  passThreshold: 'pass mark',
  dueDate: 'due date',
  shuffleQuestions: 'question shuffling',
  shuffleAnswers: 'answer shuffling',
  showExplanations: 'when explanations show',
  negativeMarking: 'negative marking',
  negativeMarkingPenalty: 'negative-marking penalty',
  adaptiveMode: 'Adaptive mode',
}

/** The settings the studio stores as nullable. The model sends 0 / '' instead of null
 *  (a nullable field would render as the `anyOf` union Gemini mishandles), so the
 *  "cleared" sentinel is translated back here. For maxAttempts, cleared = no limit. */
const CLEARABLE = ['timeLimitMinutes', 'dueDate', 'maxAttempts'] as const

export interface ApplyQuizSettingsResult {
  values: QuizAthenaSettings
  summary: string
  changed: number
}

/**
 * Apply whitelisted quiz settings. Anything outside QuizAthenaSettings is ignored by
 * construction — the payload schema doesn't carry publish state, scheduling, proctoring
 * or IRT tuning, and this only ever writes keys it knows.
 */
export function applyQuizSettings(
  values: QuizAthenaSettings,
  payload: QuizSettingsPayload,
): ApplyQuizSettingsResult {
  const next: QuizAthenaSettings = { ...values }
  const changedLabels: string[] = []

  for (const key of Object.keys(SETTING_LABELS) as (keyof QuizSettingsPayload)[]) {
    const incoming = payload[key]
    if (incoming === undefined) continue
    // 0 / '' mean "clear it" for the nullable settings.
    const value =
      (CLEARABLE as readonly string[]).includes(key) && (incoming === 0 || incoming === '') ? null : incoming
    if (next[key] === value) continue
    // Each key's type is pinned by both schemas; the assignment is narrowed per-key by
    // the shared field names, so one write covers all twelve.
    Object.assign(next, { [key]: value })
    changedLabels.push(SETTING_LABELS[key])
  }

  const summary = changedLabels.length
    ? `Set ${changedLabels.join(', ')}`
    : 'Those settings were already set that way'
  return { values: next, summary, changed: changedLabels.length }
}
