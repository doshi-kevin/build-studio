/**
 * The Stage 2 report endpoint (api/studio/validator/runtime-report) and the local
 * runner's environment. The token, replay and expiry rules themselves are tested on
 * submitRuntimeReport in studio-validator-service.test.ts; here we check the route
 * passes only well-formed requests through and answers every refusal the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/studio/validator/service', () => ({ submitRuntimeReport: vi.fn() }))

const { submitRuntimeReport } = await import('@/lib/studio/validator/service')
const { POST } = await import('@/app/api/studio/validator/runtime-report/route')
const { runnerEnvironment, runnerMode } = await import('@/lib/studio/validator/runtime-runner')

const TOKEN = 'a'.repeat(43)
const ID = crypto.randomUUID()

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost/api/studio/validator/runtime-report', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(submitRuntimeReport).mockResolvedValue({ ok: true, status: 'passed' })
})

describe('the report endpoint', () => {
  it('passes the bearer token, run ID and report to the service', async () => {
    const report = { checks: [] }
    const res = await post({ validationId: ID, report })
    expect(res.status).toBe(200)
    expect(submitRuntimeReport).toHaveBeenCalledWith({ validationId: ID, token: TOKEN, report })
  })

  it.each([
    ['no token', { authorization: '' }],
    ['a token in another scheme', { authorization: `Basic ${TOKEN}` }],
    ['a token with characters a minted token never has', { authorization: `Bearer ${'a'.repeat(30)}"; drop` }],
  ])('refuses %s without calling the service', async (_label, headers) => {
    const res = await post({ validationId: ID, report: {} }, headers)
    expect(res.status).toBe(403)
    expect(submitRuntimeReport).not.toHaveBeenCalled()
  })

  it('refuses a body that isn’t JSON, or is too large, without calling the service', async () => {
    expect((await post({ validationId: ID }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post('{not json')).status).toBe(400)
    expect((await post({ validationId: ID, report: 'x'.repeat(70 * 1024) })).status).toBe(413)
    expect(submitRuntimeReport).not.toHaveBeenCalled()
  })

  it('answers a wrong token and an unknown run identically', async () => {
    vi.mocked(submitRuntimeReport).mockResolvedValueOnce({ ok: false, reason: 'denied' })
    vi.mocked(submitRuntimeReport).mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    const a = await post({ validationId: ID, report: {} })
    const b = await post({ validationId: ID, report: {} })
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()])
    expect(a.status).toBe(403)
  })
})

describe('the local runner', () => {
  it('runs only when asked for, and never in production', () => {
    expect(runnerMode({})).toBe('unavailable')
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'development' })).toBe('local')
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'production' })).toBe('unavailable')
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'container', NODE_ENV: 'development' })).toBe('unavailable')
  })

  it('gets no Scholera secret in its environment', () => {
    const env = runnerEnvironment({
      PATH: '/usr/bin',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      GOOGLE_GENERATIVE_AI_API_KEY: 'gemini',
      PINECONE_API_KEY: 'pinecone',
      DATABASE_URL: 'postgres://x',
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      STUDIO_VALIDATOR_RUNNER: 'local',
    })
    expect(env).toEqual({ PATH: '/usr/bin', NODE_ENV: 'production' })
  })
})
