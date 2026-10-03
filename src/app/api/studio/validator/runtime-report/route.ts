// Where the LOCAL Stage 2 runner can report back (docs/reference/studio-plugin-validator.md,
// "Reporting from a runner"). In every deployed environment the runner mode is not local,
// so this route answers 404 and nothing reaches the verdict through it: the production
// runner's report is collected by the dispatcher from a write-once object instead
// (cloud-runner.ts). In local mode the caller holds no session and no Scholera secret,
// only the run's nonce as a bearer token; the envelope's binding is checked against the run.
// Every refusal is the same generic answer.
import { submitRuntimeReport } from '@/lib/studio/validator/service'
import { runnerMode } from '@/lib/studio/validator/runtime-runner'
import { readBodyCapped } from '@/lib/studio/bridge/read-body'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const MAX_REPORT_BYTES = 64 * 1024
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS })
const refused = () => answer(403, { ok: false })

export async function POST(request: Request) {
  // Closed unless this server runs the local runner (never in production).
  if (runnerMode() !== 'local') return answer(404, { ok: false })
  try {
    const auth = request.headers.get('authorization') ?? ''
    const token = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(auth)?.[1]
    if (!token) return refused()
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return answer(415, { ok: false })

    const body = await readBodyCapped(request, MAX_REPORT_BYTES)
    if (!body.ok) return answer(413, { ok: false })
    let envelope: unknown
    try {
      envelope = JSON.parse(body.text)
    } catch {
      return answer(400, { ok: false })
    }

    const result = await submitRuntimeReport({ token, envelope })
    if (!result.ok) return result.reason === 'invalid' ? answer(400, { ok: false }) : refused()
    return answer(200, { ok: true, status: result.status })
  } catch (error) {
    logger.error('studio/validator.runtimeReport.POST', error instanceof Error ? error.name : 'unknown')
    return answer(500, { ok: false })
  }
}
