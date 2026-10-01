/**
 * What a Stage 2 runner reports, and how the server turns it into results. The runner
 * (validator-runtime/, in an isolated container in production) never decides a verdict:
 * it reports measurements per check and view, and the server requires every runtime
 * check for both views. A missing check is an error, never a pass.
 */
import { z } from 'zod'
import { STUDIO_VALIDATOR_FINDINGS_PER_CHECK, STUDIO_VALIDATOR_QUOTE_MAX_CHARS } from '../limits'
import { RUNTIME_CHECK_IDS, type RuntimeCheckId } from './ruleset'

const text = (max: number) => z.string().max(max).transform((s) => s.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ''))

const finding = z.strictObject({ detail: text(STUDIO_VALIDATOR_QUOTE_MAX_CHARS) })

export const runtimeReportSchema = z.strictObject({
  runner: z.strictObject({ name: text(40), version: text(20) }),
  browser: text(120),
  checks: z
    .array(
      z.strictObject({
        id: z.enum(RUNTIME_CHECK_IDS as [RuntimeCheckId, ...RuntimeCheckId[]]),
        view: z.enum(['student', 'professor']),
        status: z.enum(['passed', 'failed', 'error']),
        findings: z.array(finding).max(STUDIO_VALIDATOR_FINDINGS_PER_CHECK),
      }),
    )
    .max(RUNTIME_CHECK_IDS.length * 2),
})

export type RuntimeReport = z.infer<typeof runtimeReportSchema>

export interface RuntimeCheckResult {
  checkId: RuntimeCheckId
  status: 'passed' | 'failed' | 'error'
  views: Record<'student' | 'professor', 'passed' | 'failed' | 'error' | 'missing'>
  findings: { view: string; detail: string }[]
}

/** One result per runtime check, across both views. */
export function summarizeRuntimeReport(report: RuntimeReport): RuntimeCheckResult[] {
  return RUNTIME_CHECK_IDS.map((checkId) => {
    const views = { student: 'missing', professor: 'missing' } as RuntimeCheckResult['views']
    const findings: RuntimeCheckResult['findings'] = []
    for (const c of report.checks.filter((c) => c.id === checkId)) {
      views[c.view] = c.status
      for (const f of c.findings) findings.push({ view: c.view, detail: f.detail })
    }
    const all = Object.values(views)
    const status = all.includes('failed') ? 'failed' : all.some((v) => v === 'error' || v === 'missing') ? 'error' : 'passed'
    return { checkId, status, views, findings: findings.slice(0, STUDIO_VALIDATOR_FINDINGS_PER_CHECK) }
  })
}
