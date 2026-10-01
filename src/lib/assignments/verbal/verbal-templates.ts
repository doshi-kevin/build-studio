/**
 * Verbal Assessment presets: starting layouts the professor picks when creating an assessment,
 * mirroring the notebook studio's templates. Each `build()` returns a fresh
 * VerbalAssessmentConfig (ordered cells) the professor then edits freely. Pure + server-safe
 * (no React) so the create server action can build one. Prompts are placeholders to replace.
 */
import { DEFAULT_VOICE_ID } from '@/lib/ai/elevenlabs/voices'
import { genId, type VerbalAssessmentConfig, type VerbalCell } from './config'

const greeting = (prompt: string): VerbalCell => ({ id: genId(), type: 'greeting', prompt })
const question = (prompt: string, answerType: 'short' | 'long' = 'long', allowFollowUps = false): VerbalCell =>
  ({ id: genId(), type: 'question', prompt, answerType, allowFollowUps })
const mcq = (prompt: string, options: string[], allowFollowUps = false): VerbalCell =>
  ({ id: genId(), type: 'mcq', prompt, allowFollowUps, options: options.map((text) => ({ id: genId(), text })) })
const aiFollowUp = (): VerbalCell => ({ id: genId(), type: 'ai_followup', prompt: '' })

function cfg(over: Partial<VerbalAssessmentConfig> & { cells: VerbalCell[] }): VerbalAssessmentConfig {
  return { version: 2, topic: '', voiceId: DEFAULT_VOICE_ID, maxFollowUpDepth: 2, timeLimitMinutes: 10, ...over }
}

/** Depth: one topic drilled hard. MCQ first, then questions that push understanding. */
function buildDeepDive(): VerbalAssessmentConfig {
  return cfg({
    maxFollowUpDepth: 3,
    timeLimitMinutes: 12,
    cells: [
      greeting("Hey {name}, let's go deep on {topic}."),
      mcq('Replace this with one focused multiple-choice question on the core concept.', ['Option A', 'Option B', 'Option C', 'Option D'], true),
      question('Why are the other options wrong?', 'long', true),
      question('What if we changed a key assumption or input? How would your answer change?', 'long', true),
      question('Describe an edge case where this breaks down, and how you would handle it.', 'long', true),
      aiFollowUp(),
    ],
  })
}

/** Breadth: many topics under one umbrella, one or two questions each. Tests coverage. */
function buildBroadSweep(): VerbalAssessmentConfig {
  return cfg({
    maxFollowUpDepth: 1,
    timeLimitMinutes: 12,
    cells: [
      greeting("Hi {name}, let's cover the breadth of {topic}."),
      question('Topic 1: ask a short question about the first subtopic.', 'short'),
      question('Topic 2: ask a short question about the second subtopic.', 'short'),
      question('Topic 3: ask a short question about the third subtopic.', 'short'),
      question('Topic 4: ask a short question about the fourth subtopic.', 'short'),
    ],
  })
}

/** Blank: a greeting and one empty question to build from. */
function buildBlank(): VerbalAssessmentConfig {
  return cfg({
    cells: [
      greeting("Hey {name}, let's begin the assessment on {topic}."),
      question('', 'long'),
    ],
  })
}

export interface VerbalTemplate {
  id: string
  title: string
  description: string
  build: () => VerbalAssessmentConfig
}

export const VERBAL_TEMPLATES: VerbalTemplate[] = [
  {
    id: 'deep-dive',
    title: 'Depth (Deep Dive)',
    description: 'One topic, drilled hard. Start with an MCQ, then push: why the other options are wrong, what if we change X, the edge cases. Tests whether they truly understand one thing.',
    build: buildDeepDive,
  },
  {
    id: 'broad-sweep',
    title: 'Breadth (Broad Sweep)',
    description: 'Many topics under one umbrella, one or two questions each. Cover the whole unit. Tests coverage: did they study everything, or just some of it.',
    build: buildBroadSweep,
  },
  {
    id: 'blank',
    title: 'Blank',
    description: 'A greeting and one empty question. Build the assessment yourself.',
    build: buildBlank,
  },
]

export function getVerbalTemplate(id: string): VerbalTemplate | undefined {
  return VERBAL_TEMPLATES.find((t) => t.id === id)
}
