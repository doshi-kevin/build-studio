/**
 * The Stage 2 report endpoint (api/studio/validator/runtime-report) and the local
 * runner's environment. The binding, replay and expiry rules themselves are tested on
 * submitRuntimeReport in studio-validator-service.test.ts; here we check the route is
 * closed outside local runner mode, passes only well-formed requests through, and
 * answers every refusal the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  vi.stubEnv('STUDIO_VALIDATOR_RUNNER', 'local')
  vi.mocked(submitRuntimeReport).mockResolvedValue({ ok: true, status: 'passed' })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the report endpoint', () => {
  it('passes the bearer token and the whole envelope to the service', async () => {
    const envelope = { binding: { validationId: ID }, report: { checks: [] } }
    const res = await post(envelope)
    expect(res.status).toBe(200)
    expect(submitRuntimeReport).toHaveBeenCalledWith({ token: TOKEN, envelope })
  })

  it.each([
    ['the cloud runner', { STUDIO_VALIDATOR_RUNNER: 'cloud' }],
    ['no runner', { STUDIO_VALIDATOR_RUNNER: '' }],
    ['a deployed production server asked for the local runner', { STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' }],
  ])('is closed (404) with %s, without calling the service', async (_label, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const res = await post({ binding: { validationId: ID }, report: {} })
    expect(res.status).toBe(404)
    expect(submitRuntimeReport).not.toHaveBeenCalled()
  })

  it.each([
    ['no token', { authorization: '' }],
    ['a token in another scheme', { authorization: `Basic ${TOKEN}` }],
    ['a token with characters a minted token never has', { authorization: `Bearer ${'a'.repeat(30)}"; drop` }],
  ])('refuses %s without calling the service', async (_label, headers) => {
    const res = await post({ binding: { validationId: ID }, report: {} }, headers)
    expect(res.status).toBe(403)
    expect(submitRuntimeReport).not.toHaveBeenCalled()
  })

  it('refuses a body that isn’t JSON, or is too large, without calling the service', async () => {
    expect((await post({ binding: { validationId: ID } }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post('{not json')).status).toBe(400)
    expect((await post({ binding: { validationId: ID }, report: 'x'.repeat(70 * 1024) })).status).toBe(413)
    expect(submitRuntimeReport).not.toHaveBeenCalled()
  })

  it('answers a wrong token and an unknown run identically', async () => {
    vi.mocked(submitRuntimeReport).mockResolvedValueOnce({ ok: false, reason: 'denied' })
    vi.mocked(submitRuntimeReport).mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    const a = await post({ binding: { validationId: ID }, report: {} })
    const b = await post({ binding: { validationId: ID }, report: {} })
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()])
    expect(a.status).toBe(403)
  })
})

describe('the local runner', () => {
  it('runs only when asked for, and never in production', () => {
    expect(runnerMode({})).toBe('unavailable')
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'development' })).toBe('local')
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'production' })).toBe('unavailable')
    // A deployed server talks to a hosted database: local mode stays refused there, whatever it is told.
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' })).toBe('unavailable')
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'not a url' })).toBe('unavailable')
    // The guarded local server: a production build on a loopback database.
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'local', NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })).toBe('local')
    expect(runnerMode({ STUDIO_VALIDATOR_RUNNER: 'container', NODE_ENV: 'development' })).toBe('unavailable')
  })

  it('the cloud runner needs every one of its settings; missing any, no runner is used', () => {
    const cloud = {
      STUDIO_VALIDATOR_RUNNER: 'cloud', NODE_ENV: 'production', STUDIO_VALIDATOR_GCP_PROJECT: 'p', STUDIO_VALIDATOR_REGION: 'r',
      STUDIO_VALIDATOR_JOB: 'j', STUDIO_VALIDATOR_BUCKET: 'b', STUDIO_VALIDATOR_RUNNER_DIGEST: `sha256:${'a'.repeat(64)}`,
    }
    expect(runnerMode(cloud)).toBe('cloud')
    for (const key of Object.keys(cloud).filter((k) => k.startsWith('STUDIO_VALIDATOR_') && k !== 'STUDIO_VALIDATOR_RUNNER')) {
      expect(runnerMode({ ...cloud, [key]: '' }), key).toBe('unavailable')
    }
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
