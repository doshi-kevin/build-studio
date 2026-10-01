/**
 * AI kill-switch drift tripwire (pattern: student-feature-gate-coverage.test.ts).
 *
 * Scans src/ for every module that can spend money on an AI provider — the
 * Gemini SDK (@ai-sdk/google), the raw Gemini REST endpoint, ElevenLabs, and
 * Wolfram — and fails if any file is not in the allowlist below. Matching on
 * the module-path / API-host STRING means import aliasing or dynamic import
 * cannot dodge it.
 *
 * If this test fails on a NEW file: gate that file's AI call behind
 * checkAiFeature/checkAiFeatureBySection (src/lib/ai/kill-switch.ts) — or via a
 * caller that is itself gated — pick the right feature key from
 * src/lib/ai/ai-features.ts, and ONLY THEN add the file here with a comment
 * saying where its guard lives. Never allowlist an unguarded call site.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..')

const AI_MARKERS = [
  '@ai-sdk/google', // Gemini via the AI SDK
  '@ai-sdk/openai', // installed but unused — first use must be guarded
  '@ai-sdk/groq', // installed but unused — first use must be guarded
  'groq-sdk', // installed but unused — first use must be guarded
  'generativelanguage.googleapis.com', // Gemini raw REST (embeddings)
  'api.elevenlabs.io', // ElevenLabs TTS/STT/realtime
  'wolframalpha.com', // Wolfram LLM API
]
// Deliberately NOT a marker: @ai-sdk/react — client-side chat UI, no server spend.
// Scope is src/ on purpose: scripts/, supabase/functions/ and infra/ hold no AI
// call sites today; if server AI ever moves there, widen the walk.

/** Every production module allowed to reach an AI provider, with the location
 *  of the kill-switch guard that covers it. */
const ALLOWED: Record<string, string> = {
  // ── Studio validator (guard inside the classifier, before the model call) ──
  'lib/studio/validator/purpose-ai.ts': 'guarded inline (studio-validator)',
  // ── Routes (guard inline in the route, before any model/token spend) ──
  'app/api/chat/route.ts': 'guarded inline (athena-student)',
  'app/api/professor-assistant/route.ts': 'guarded inline (athena-professor)',
  'app/api/assignment-assistant/route.ts': 'guarded inline (athena-professor)',
  'app/api/live-classroom/scribe-token/route.ts': 'guarded inline (live-classroom-ai)',

  // ── Server actions (guard inline in each exported action) ──
  'app/(dashboard)/professor/courses/[sectionId]/assignments/actions.ts':
    'each AI action guarded inline (assignment-ai)',
  'app/(dashboard)/student/courses/[sectionId]/ai-tutor/actions.ts':
    'generateConversationTitle guarded inline (athena-student)',

  // ── Libs reached ONLY from guarded entry points ──
  'lib/ai/llm-client.ts':
    'callers guarded: quiz gen route (quiz-ai), skills/roadmap/LC/projects/announcement actions, primer generate, extraction+jobs workers',
  'lib/ai/quiz-quality.ts': 'runs inside quiz generation (quiz-ai, gated at generate-stream route)',
  'lib/ai/class-insight.ts': 'caller guarded: generateClassInsightSummary (roadmap-skills-ai)',
  'lib/ai/student-insight.ts':
    'callers guarded: generateStudentDossierSummary + regenerate_student_insights job (roadmap-skills-ai)',
  'lib/ai/node-check.ts': 'node_check_pool pipeline gated in jobs worker (roadmap-skills-ai)',
  'lib/ai/athena-core/turn.ts':
    'only caller is /api/chat, guarded inline (athena-student) before any slot or token spend',
  'lib/pinecone/decompose.ts':
    'reached only via pinecone/retrieve -> student-tutor/context -> /api/chat, guarded inline (athena-student)',
  'lib/ai/professor-assistant/persistence.ts':
    'runs inside the two professor Athena routes (athena-professor, gated there)',
  'lib/ai/assignment-assistant/templates/registry.ts':
    'prompt templates only — consumed by the gated assignment-assistant route',
  'lib/assignments/ai-grading/grader.ts': 'callers guarded: suggestGrades + ai-suggest-stream (assignment-ai)',
  'lib/assignments/ai-grading/hybrid-grader.ts': 'same guarded callers as grader.ts (assignment-ai)',
  'lib/assignments/rubric-ai.ts': 'caller guarded: generateAssignmentRubric (assignment-ai)',
  'lib/document-parser/vision.ts': 'extraction worker gated (content-ai)',
  'lib/jobs/pipelines/outcome-alignment/map.ts': 'outcome_alignment gated in jobs worker (athena-professor)',
  'lib/quiz/irt/grader.ts': 'guarded internally — quizAiAllowed() drops to keyword fallback (quiz-ai)',
  'lib/pinecone/embed.ts':
    'callers guarded: chat route RAG (athena-student), references sync (assignment-ai), similarity tagging (roadmap-skills-ai), embed_material job (content-ai)',
  'lib/ai/elevenlabs/tts.ts': 'callers guarded: verbal TTS actions (assignment-ai), primer generate (preclass-ai)',
  'lib/ai/elevenlabs/stt.ts': 'caller guarded: submitVerbalAssessment (assignment-ai, skips STT)',
  'lib/preclass-audio/tts.ts': 'caller guarded: generatePrimer (preclass-ai)',
  'lib/wolfram/client.ts': 'caller guarded: generateWolframSolution (assignment-ai)',
  'lib/wolfram/format.ts': 'pure formatting of Wolfram output — no network call',

  // ── Cost/metering metadata (no model calls — rates, labels, usage parsing) ──
  'lib/costs/providers/elevenlabs.ts': 'cost ingestion only, no AI call',
  'lib/live-classroom/transcription/types.ts': 'types/constants only, no AI call',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

describe('AI call-site coverage (kill-switch drift tripwire)', () => {
  it('every module that reaches an AI provider is in the guarded allowlist', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file)
      const content = readFileSync(file, 'utf8')
      if (AI_MARKERS.some((m) => content.includes(m)) && !(rel in ALLOWED)) {
        offenders.push(rel)
      }
    }
    expect(
      offenders,
      `New AI call site(s) without a kill-switch guard entry:\n  ${offenders.join('\n  ')}\n` +
        'Gate the call (see src/lib/ai/kill-switch.ts) and add the file to ALLOWED with its guard location.',
    ).toEqual([])
  })

  it('every allowlisted module still exists (stale entries rot the map)', () => {
    const files = new Set(walk(SRC).map((f) => relative(SRC, f)))
    const stale = Object.keys(ALLOWED).filter((rel) => !files.has(rel))
    expect(stale, `Remove stale ALLOWED entries: ${stale.join(', ')}`).toEqual([])
  })
})
