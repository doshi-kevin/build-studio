/**
 * Verbal Assessment config - an AI-led spoken Q&A the PROFESSOR reviews and grades.
 * Modeled as an ipynb-style ORDERED LIST OF CELLS (greeting / question / mcq / ai_followup)
 * so the authoring UI mirrors the notebook studio. Persisted in
 * assignments.settings.verbalAssessment (JSONB, no migration). Pure helpers only; the
 * question-deciding/adaptive brain is Athena's (see ./seam), not here.
 */
import { DEFAULT_VOICE_ID } from '@/lib/ai/elevenlabs/voices'

export type VerbalCellType = 'greeting' | 'question' | 'mcq' | 'ai_followup'
export type AnswerType = 'short' | 'long'

export interface VerbalOption {
  id: string
  text: string
}

export interface VerbalCell {
  id: string
  type: VerbalCellType
  /** Greeting text (supports {name}/{topic}), question prompt, or MCQ stem. */
  prompt: string
  /** question cells: expected answer length. */
  answerType?: AnswerType
  /** question/mcq cells: may Athena ask follow-ups after this (engine is Athena's). */
  allowFollowUps?: boolean
  /** question/mcq cells: storage path of cached TTS audio (fixed text only). */
  audioPath?: string
  /** mcq cells: choices. */
  options?: VerbalOption[]
  /** mcq cells: authoring answer key (NOT used for AI grading). */
  correctOptionId?: string
  /**
   * mcq cells: deterministic follow-up asked aloud based on whether the student picked the
   * correct option (the quiz's "next question depends on the answer", objective path only).
   * Professor-authored, not Athena. Empty branches are skipped; needs correctOptionId set.
   */
  followUps?: { correct?: string; incorrect?: string }
}

export interface VerbalAssessmentConfig {
  version: number
  topic: string
  voiceId: string
  maxFollowUpDepth: number
  timeLimitMinutes: number
  cells: VerbalCell[]
}

export function genId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? uuid.replace(/-/g, '').slice(0, 12) : 'v' + Date.now().toString(36)
}

const DEFAULT_GREETING = "Hey {name}, let's begin the assessment on {topic}."

/** Pre-written intro options the professor can start from (each supports {name}/{topic}). */
export interface GreetingPreset {
  label: string
  text: string
}
export const GREETING_PRESETS: GreetingPreset[] = [
  { label: 'Standard', text: DEFAULT_GREETING },
  { label: 'Warm', text: "Hi {name}, great to have you. When you're ready, we'll talk through {topic} together." },
  { label: 'Concise', text: 'Hi {name}. This is a short spoken check on {topic}. Answer out loud.' },
  { label: 'Encouraging', text: "Hey {name}, no pressure here, just talk me through what you know about {topic}." },
]

export function newVerbalCell(type: VerbalCellType): VerbalCell {
  switch (type) {
    case 'greeting':
      return { id: genId(), type, prompt: DEFAULT_GREETING }
    case 'question':
      return { id: genId(), type, prompt: '', answerType: 'short', allowFollowUps: false }
    case 'mcq':
      return {
        id: genId(),
        type,
        prompt: '',
        allowFollowUps: false,
        options: [
          { id: genId(), text: '' },
          { id: genId(), text: '' },
        ],
      }
    case 'ai_followup':
      return { id: genId(), type, prompt: '' }
  }
}

export function defaultVerbalAssessment(): VerbalAssessmentConfig {
  return {
    version: 2,
    topic: '',
    voiceId: DEFAULT_VOICE_ID,
    maxFollowUpDepth: 2,
    timeLimitMinutes: 10,
    // The flow shown as cells: greet -> a basic-understanding question -> Athena follow-up.
    cells: [
      { id: genId(), type: 'greeting', prompt: DEFAULT_GREETING },
      { id: genId(), type: 'question', prompt: 'In your own words, explain the core idea of this topic.', answerType: 'long', allowFollowUps: true },
      { id: genId(), type: 'ai_followup', prompt: '' },
    ],
  }
}

/** Fill {name}/{topic} placeholders in the greeting. Pure + testable. */
export function renderGreeting(template: string, vars: { name: string; topic: string }): string {
  return template.replace(/\{name\}/g, vars.name).replace(/\{topic\}/g, vars.topic)
}

/** Audio can be cached only for fixed-text cells (questions / MCQ stems). */
export function canCacheAudio(cell: VerbalCell): boolean {
  return (cell.type === 'question' || cell.type === 'mcq') && cell.prompt.trim().length > 0
}

/**
 * After an MCQ, pick the deterministic follow-up branch to ask. Returns null when there is no
 * follow-up: not an MCQ, no answer key set (nothing to branch on), or the matching branch prompt
 * is empty/whitespace. Pure + testable; the student runner uses it to inject the spoken follow-up
 * and the resulting `branch` is what the narrate action resolves text from (server-side).
 */
export function pickFollowUp(
  cell: Pick<VerbalCell, 'type' | 'correctOptionId' | 'followUps'>,
  selectedOptionId: string | null,
): { branch: 'correct' | 'incorrect'; prompt: string } | null {
  if (cell.type !== 'mcq' || !cell.correctOptionId) return null
  const branch = selectedOptionId === cell.correctOptionId ? 'correct' : 'incorrect'
  const prompt = cell.followUps?.[branch]?.trim()
  return prompt ? { branch, prompt } : null
}

/** Minimal answer shape resolveVerbalAnswers needs (a superset of the stored VerbalAnswer). */
export interface ResolvableAnswer {
  cellId: string
  type: VerbalCellType
  prompt: string
  selectedOptionId?: string
}

/**
 * Re-derive each submitted answer's prompt + type from the SERVER-stored cells, keyed by cellId,
 * so the client-submitted prompt is never trusted (it is later rendered as markdown to the
 * professor, so a forged prompt would be a stored-XSS vector). MCQ-branch follow-ups (cellId
 * `${mcqId}__fu`) resolve from the base MCQ's authored branch via pickFollowUp, using the student's
 * own recorded option pick; anything unresolvable gets an empty prompt. Pure + testable; the
 * submit action calls this before persisting. Other answer fields (transcript, etc.) pass through.
 */
export function resolveVerbalAnswers<T extends ResolvableAnswer>(cells: VerbalCell[], submitted: T[]): T[] {
  const cellById = new Map(cells.map((c) => [c.id, c] as const))
  return submitted.map((a) => {
    const cell = cellById.get(a.cellId)
    if (cell) return { ...a, type: cell.type, prompt: cell.prompt }
    if (a.cellId.endsWith('__fu')) {
      const base = cellById.get(a.cellId.slice(0, -'__fu'.length))
      if (base) {
        const baseAnswer = submitted.find((x) => x.cellId === base.id)
        const fu = pickFollowUp(base, baseAnswer?.selectedOptionId ?? null)
        // A follow-up is a spoken answer, not an MCQ; set type server-side too so no field stays
        // client-controlled.
        return { ...a, type: 'question', prompt: fu?.prompt ?? '' }
      }
    }
    return { ...a, prompt: '' }
  })
}

/**
 * Make a prompt safe to NARRATE: math/LaTeX, chemistry, code and images are unintelligible as
 * speech, so strip them and substitute a short spoken cue ("Below is a formula on screen,
 * answer the following question regarding it."). Pure + testable; the on-screen prompt still
 * renders the real formula via the markdown renderer.
 */
export function spokenPrompt(raw: string): string {
  const hasMath = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\ce\{|\\\[|\\\(|\\frac|\\sqrt|\\sum|\\int|\\begin\{/.test(raw)
  const hasCode = /```[\s\S]*?```|`[^`]+`/.test(raw)
  const hasImage = /!\[[^\]]*\]\([^)]+\)/.test(raw)
  const text = raw
    .replace(/\$\$[\s\S]+?\$\$/g, ' ')
    .replace(/\$[^$\n]+\$/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (hasMath || hasCode || hasImage) {
    const noun = hasMath ? 'a formula' : hasCode ? 'a code snippet' : 'an image'
    if (text.length < 8) return `Below is ${noun} on screen. Answer the following question regarding it.`
    return `${text}. Refer to ${noun} shown on screen.`
  }
  return text
}
