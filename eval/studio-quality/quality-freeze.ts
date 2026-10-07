/**
 * The rubric and judge prompt the Step 12A.4 baseline is measured with, frozen at the end of
 * Step 12A.3. A fingerprint covers the exact content (every level's wording, the fractions,
 * the rendered prompts), so changing the content without bumping its version fails a test,
 * and a baseline can only be compared with results judged under the same pair.
 */
import { createHash } from 'node:crypto'
import { DIMENSIONS, LEVEL_FRACTION, RUBRIC_VERSION } from './rubric'
import { extractPrompt, JUDGE_PROMPT_VERSION, judgeSystem, scorePrompt, type JudgeInput } from './judge'
import type { Extraction } from './schema'

export const QUALITY_FROZEN = {
  rubricVersion: 'studio-generation-quality-v1',
  rubricSha256: '4ea17162ae25725d5faaac6aa3d92c922e3946d7caf8f4ff0795c3247f13b0db',
  // v4 (12A.3): the judge reads what each screen actually renders, and the source can no
  // longer prove something is on screen. v2 credited a "+1 Point" button no screen showed;
  // a prompt-only fix (v3, never frozen) didn't change that. v5: every evidence source has an
  // anchor item a level can cite, and phone screens get a measured cramped-layout check.
  judgePromptVersion: 'sgq-judge-v5',
  judgePromptSha256: 'dd05017b577cfb5804858a1f43ae1a04df74abea4bce75d778a985d1d7152d13',
} as const

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export const rubricFingerprint = () => sha256(JSON.stringify({ version: RUBRIC_VERSION, fractions: LEVEL_FRACTION, dimensions: DIMENSIONS }))

const FIXED_INPUT: JudgeInput = {
  mode: 'visual+code',
  request: 'request',
  professorGoal: 'professor goal',
  studentGoal: 'student goal',
  hints: ['hint'],
  platformCard: 'card',
  manifest: {},
  files: { professor: 'p', student: 's' },
  sample: null,
  stage2: null,
  evidence: [{ id: 'views/professor.tsx', kind: 'source', label: 'professor', file: null, lines: 1 }],
  images: [],
  // So the fingerprint covers the instructions given only alongside rendered evidence.
  render: { text: 'rendered', items: [], checks: [] },
}
const FIXED_EXTRACTION: Extraction = {
  items: [{ id: 'e1', role: 'professor', kind: 'data', text: 'x', sources: ['views/professor.tsx'] }],
  core: { professor: { present: true, evidence: ['e1'] }, student: { present: false, evidence: [] } },
}

/** The judge's instructions as sent, rendered on fixed input. */
export const judgePromptFingerprint = () =>
  sha256(
    JSON.stringify({
      version: JUDGE_PROMPT_VERSION,
      system: [judgeSystem('visual+code'), judgeSystem('code-only')],
      extract: extractPrompt(FIXED_INPUT, 'fingerprint', null),
      score: scorePrompt(FIXED_INPUT, FIXED_EXTRACTION, 'fingerprint', null),
    }),
  )

/** Every way the rubric or judge prompt differs from the frozen pair; empty when unchanged. */
export function qualityFreezeDrift(): string[] {
  const drift: string[] = []
  if (RUBRIC_VERSION !== QUALITY_FROZEN.rubricVersion) drift.push(`rubric version ${RUBRIC_VERSION}, frozen ${QUALITY_FROZEN.rubricVersion}`)
  else if (rubricFingerprint() !== QUALITY_FROZEN.rubricSha256) drift.push(`the rubric changed without a new version (still ${RUBRIC_VERSION})`)
  if (JUDGE_PROMPT_VERSION !== QUALITY_FROZEN.judgePromptVersion) drift.push(`judge prompt version ${JUDGE_PROMPT_VERSION}, frozen ${QUALITY_FROZEN.judgePromptVersion}`)
  else if (judgePromptFingerprint() !== QUALITY_FROZEN.judgePromptSha256) drift.push(`the judge prompt changed without a new version (still ${JUDGE_PROMPT_VERSION})`)
  return drift
}
