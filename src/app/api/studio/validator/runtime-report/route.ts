// Where a Stage 2 runner reports back (docs/reference/studio-plugin-validator.md,
// "Stage 2"). Server to server: the runner holds no session and no Scholera secret, only
// the one token minted for its run, sent as a bearer token. submitRuntimeReport checks
// it against the run's stored hash in constant time, accepts it once, while the run is
// open and unexpired, and decides the verdict itself from the reported measurements.
// Every refusal is the same generic answer.
import { submitRuntimeReport } from '@/lib/studio/validator/service'
import { readBodyCapped } from '@/lib/studio/bridge/read-body'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const MAX_REPORT_BYTES = 64 * 1024
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS })
const refused = () => answer(403, { ok: false })

export async function POST(request: Request) {
  try {
    const auth = request.headers.get('authorization') ?? ''
    const token = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(auth)?.[1]
    if (!token) return refused()
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return answer(415, { ok: false })

    const body = await readBodyCapped(request, MAX_REPORT_BYTES)
    if (!body.ok) return answer(413, { ok: false })
    let parsed: unknown
    try {
      parsed = JSON.parse(body.text)
    } catch {
      return answer(400, { ok: false })
    }
    const envelope = parsed as { validationId?: unknown; report?: unknown }
    if (typeof envelope?.validationId !== 'string') return answer(400, { ok: false })

    const result = await submitRuntimeReport({ validationId: envelope.validationId, token, report: envelope.report })
    if (!result.ok) return result.reason === 'invalid' ? answer(400, { ok: false }) : refused()
    return answer(200, { ok: true, status: result.status })
  } catch (error) {
    logger.error('studio/validator.runtimeReport.POST', error instanceof Error ? error.name : 'unknown')
    return answer(500, { ok: false })
  }
}
