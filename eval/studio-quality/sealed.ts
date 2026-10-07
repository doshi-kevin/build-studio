/**
 * The judge guidance of the sealed Tier 2 holdouts (D02, D05, D06). `cases.ts` keeps only
 * what running them needs; their goals, hints and review notes live in a local file that
 * git ignores, so nobody tuning Step 12 reads them by accident. Only the Step 12A.4
 * baseline (--allow-holdout) loads it, and a missing or incomplete file stops the run:
 * judging a sealed case without its guidance would quietly score it on less.
 */
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { QualityCase } from './cases'

export const SEALED_FORMAT = 'studio-quality-sealed-holdouts-v1'
export const DEFAULT_SEALED_SPEC = 'docs/designs/studio/sealed/studio-quality-tier2-holdouts.json'

const text = z.string().min(1)
const sealedSpecSchema = z.strictObject({
  format: z.literal(SEALED_FORMAT),
  cases: z.record(
    z.string(),
    z.strictObject({
      professorGoal: text,
      studentGoal: text,
      hints: z.array(text).min(1),
      guidance: z.strictObject({
        constraints: z.array(text).min(1),
        shallow: text,
        strong: text,
        capabilities: z.array(text),
        mustNotAssume: z.array(text),
      }),
    }),
  ),
})
export type SealedSpec = z.infer<typeof sealedSpecSchema>

export function parseSealedSpec(raw: unknown, cases: readonly QualityCase[]): SealedSpec {
  const spec = sealedSpecSchema.parse(raw)
  const want = cases.filter((c) => c.sealed).map((c) => c.id).sort()
  const have = Object.keys(spec.cases).sort()
  if (want.join() !== have.join()) throw new Error(`The sealed file covers ${have.join(', ') || 'nothing'}, but the sealed cases are ${want.join(', ')}.`)
  return spec
}

export function loadSealedSpec(path: string, cases: readonly QualityCase[]): SealedSpec {
  if (!existsSync(path)) throw new Error(`The sealed Tier 2 holdout guidance isn’t at ${path}. Judging ${cases.filter((c) => c.sealed).map((c) => c.id).join(', ')} needs it.`)
  return parseSealedSpec(JSON.parse(readFileSync(path, 'utf8')), cases)
}

/** The case list with each sealed case's goals, hints and guidance filled in. */
export function withSealedGuidance(cases: readonly QualityCase[], spec: SealedSpec): QualityCase[] {
  return cases.map((c) => (c.sealed ? { ...c, ...spec.cases[c.id] } : c))
}
