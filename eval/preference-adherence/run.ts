/**
 * The preference-adherence gate — does a remembered preference actually change
 * the answer?
 *
 *   npm run eval:preferences                        # measure, compare to baseline, exit 1 on regression
 *   npm run eval:preferences -- --update-baseline
 *   npm run eval:preferences -- --case=answer_length
 *
 * Why this exists. Storing a preference is easy to verify; OBEYING one is not.
 * The memory prototype found "shorter answers" honoured on one question and
 * ignored on another where it fought the task, and nothing in the test suite
 * would ever have caught that — a unit test can assert the line reached the
 * prompt, not that the model acted on it. So this fires each preference at
 * several questions and checks the output mechanically.
 *
 * It runs the REAL path: the stored preference goes through
 * `renderAthenaMemory` into the same `studentState` slot of `buildAiTutorPrompt`
 * that a live turn uses, on the same model. No LLM judge — every check is a
 * word count or a substring, so the number is deterministic and cheap.
 *
 * Not a Vitest suite, on purpose: it needs a model key, which CI does not have.
 * Roughly 20 Flash calls per run, a fraction of a cent.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateText } from 'ai'
import { google } from '@ai-sdk/google'
import { AI_TUTOR_MODEL } from '@/lib/ai/config'
import { buildAiTutorPrompt } from '@/lib/ai/student-tutor/prompt'
import { renderAthenaMemory } from '@/lib/ai/student-tutor/memory-block'
import type { UserState } from '@/lib/memory/state'
import { CASES, QUESTIONS, type AdherenceCase } from './cases'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, 'baseline.json')

/** A drop bigger than this is a regression rather than model noise. Adherence
 *  is not deterministic, so a single flipped answer out of five must not fail
 *  the gate; a preference that stopped working entirely will fall much further. */
const TOLERANCE = 0.15

interface Baseline {
  recordedAt: string
  model: string
  overall: number
  perCase: Record<string, number>
}

/** One case's memory block, built the way a real turn builds it. */
function promptFor(preference: string): string {
  const state: UserState = {
    preferences: [
      {
        id: 'eval', slot: 'constraint', text: preference,
        sectionId: null, expiresAt: null, observedAt: new Date().toISOString(),
      },
    ],
    weakSkills: [],
    dueSoon: [],
    lastClass: null,
  }
  const block = renderAthenaMemory(state)
  if (!block) throw new Error('renderAthenaMemory returned null for a case with a preference')
  return buildAiTutorPrompt(
    { courseTitle: 'Natural Language Processing', courseCode: 'CS584', sectionCode: 'A', content: '' },
    { studentState: block },
  )
}

async function runCase(c: AdherenceCase): Promise<{ passed: number; lines: string[] }> {
  const system = promptFor(c.preference)
  const lines: string[] = []
  let passed = 0

  const answers = await Promise.all(
    QUESTIONS.map(async (q) => {
      const { text } = await generateText({
        model: google(AI_TUTOR_MODEL),
        system,
        prompt: q,
        temperature: 0.4,
        maxOutputTokens: 700,
        providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
      })
      return { q, text: text.trim() }
    }),
  )

  for (const { q, text } of answers) {
    const ok = c.check(text)
    if (ok) passed += 1
    lines.push(`    ${ok ? 'ok  ' : 'MISS'}  ${c.describe(text)}  ← "${q.slice(0, 44)}…"`)
  }
  return { passed, lines }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flag = (n: string) => args.includes(`--${n}`)
  const only = args.find((a) => a.startsWith('--case='))?.slice(7)
  const cases = only ? CASES.filter((c) => c.id === only) : CASES
  if (cases.length === 0) throw new Error(`no case matching --case=${only}`)

  const perCase: Record<string, number> = {}
  let totalPassed = 0
  let totalRun = 0

  for (const c of cases) {
    const { passed, lines } = await runCase(c)
    const rate = passed / QUESTIONS.length
    perCase[c.id] = rate
    totalPassed += passed
    totalRun += QUESTIONS.length
    console.log(`\n  ${c.id}  [${c.slot}]  ${passed}/${QUESTIONS.length}`)
    console.log(`    "${c.preference}"`)
    for (const l of lines) console.log(l)
  }

  const overall = totalPassed / totalRun
  console.log(`\noverall adherence: ${(overall * 100).toFixed(0)}%  (${totalPassed}/${totalRun})`)

  if (flag('update-baseline')) {
    const next: Baseline = {
      recordedAt: new Date().toISOString(),
      model: AI_TUTOR_MODEL,
      overall,
      perCase,
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
    console.log('baseline updated → eval/preference-adherence/baseline.json (commit it with the change that moved it)')
    return 0
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log('\nno baseline committed yet — run with --update-baseline to record this run')
    return 0
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
  const regressions: string[] = []
  for (const [id, rate] of Object.entries(perCase)) {
    const was = baseline.perCase[id]
    if (was === undefined) continue
    if (rate < was - TOLERANCE) regressions.push(`  ${id}: ${(was * 100).toFixed(0)}% → ${(rate * 100).toFixed(0)}%`)
  }
  if (baseline.model !== AI_TUTOR_MODEL) {
    console.log(`\n(baseline was recorded on ${baseline.model}, this run used ${AI_TUTOR_MODEL} — re-record if the model changed deliberately.)`)
  }
  if (regressions.length > 0) {
    console.error('\nADHERENCE REGRESSED:')
    for (const r of regressions) console.error(r)
    console.error('\nA preference the student stated is no longer changing the answer.')
    console.error('Fix it, or re-run with --update-baseline if the drop is deliberate.')
    return 1
  }
  console.log(`no regression against baseline (${(baseline.overall * 100).toFixed(0)}% overall when recorded)`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
