/**
 * The guards in front of every browser-test server (e2e/serve-guard.mjs): a child gets
 * the OS basics and the named loopback values only, nothing that names production, and
 * the build output and copies are searched for production traces and .env files.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OPTIONAL_SERVER_VARS, childEnv, envFilesIn, isLoopbackUrl, productionTraces, refuseValue } from '../../e2e/serve-guard.mjs'

const PROD = 'abcdefghijklmnopqrst'
const dirs: string[] = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'serve-guard-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('what a child process may receive', () => {
  it('only the OS basics and the named E2E_ values, never the caller’s other variables', () => {
    const { env, problems } = childEnv(
      {
        PATH: '/usr/bin',
        SUPABASE_SERVICE_ROLE_KEY: 'production-service-role',
        PINECONE_API_KEY: 'pinecone',
        E2E_NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        E2E_SUPABASE_SERVICE_ROLE_KEY: 'local-demo-key',
      },
      ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
      PROD,
      { NODE_ENV: 'production' },
    )
    expect(problems).toEqual([])
    expect(env).toEqual({ PATH: '/usr/bin', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'local-demo-key', NODE_ENV: 'production' })
  })

  it.each([
    ['a hosted Supabase URL', 'E2E_NEXT_PUBLIC_SUPABASE_URL', 'https://xyzxyzxyzxyzxyzxyzxy.supabase.co', /hosted Supabase/],
    ['the production ref anywhere', 'E2E_NEXT_PUBLIC_SUPABASE_URL', `http://127.0.0.1:54321/${PROD}`, /production project/],
    ['a non-loopback URL', 'E2E_NEXT_PUBLIC_SUPABASE_URL', 'https://example.com', /not a loopback URL/],
    ['a missing required value', 'E2E_NOTHING', 'x', /is not set/],
  ])('refuses %s', (_label, key, value, why) => {
    const { problems } = childEnv({ [key]: value }, ['NEXT_PUBLIC_SUPABASE_URL'], PROD)
    expect(problems).toEqual([expect.stringMatching(why)])
  })

  it('an optional value is left out when unset and checked when set', () => {
    expect(childEnv({ E2E_A_URL: 'http://localhost:3000' }, ['A_URL'], PROD, {}, ['STUDIO_RUNTIME_ORIGIN']).env).not.toHaveProperty('STUDIO_RUNTIME_ORIGIN')
    expect(childEnv({ E2E_A_URL: 'http://localhost:3000', E2E_STUDIO_RUNTIME_ORIGIN: 'https://plugins.example.com' }, ['A_URL'], PROD, {}, ['STUDIO_RUNTIME_ORIGIN']).problems).toEqual([
      expect.stringMatching(/STUDIO_RUNTIME_ORIGIN is not a loopback URL/),
    ])
  })

  it('the Gemini key reaches the server only when passed as E2E_GOOGLE_GENERATIVE_AI_API_KEY, and nothing else from the caller does', () => {
    const source = { GOOGLE_GENERATIVE_AI_API_KEY: 'ambient', OPENAI_API_KEY: 'openai', E2E_A_URL: 'http://localhost:3000' }
    expect(childEnv(source, ['A_URL'], PROD, {}, OPTIONAL_SERVER_VARS).env).not.toHaveProperty('GOOGLE_GENERATIVE_AI_API_KEY')
    const passed: Record<string, string> = childEnv({ ...source, E2E_GOOGLE_GENERATIVE_AI_API_KEY: 'explicit' }, ['A_URL'], PROD, {}, OPTIONAL_SERVER_VARS).env
    expect(passed.GOOGLE_GENERATIVE_AI_API_KEY).toBe('explicit')
    expect(passed).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('local Stage 2 validation is switched on only by E2E_STUDIO_VALIDATOR_RUNNER', () => {
    const source = { STUDIO_VALIDATOR_RUNNER: 'local', E2E_A_URL: 'http://localhost:3000' }
    expect(childEnv(source, ['A_URL'], PROD, {}, OPTIONAL_SERVER_VARS).env).not.toHaveProperty('STUDIO_VALIDATOR_RUNNER')
    const passed: Record<string, string> = childEnv({ ...source, E2E_STUDIO_VALIDATOR_RUNNER: 'local' }, ['A_URL'], PROD, {}, OPTIONAL_SERVER_VARS).env
    expect(passed.STUDIO_VALIDATOR_RUNNER).toBe('local')
  })

  it('the design-review renderer is switched on only by E2E_STUDIO_BUILDER_RENDERER', () => {
    const source = { STUDIO_BUILDER_RENDERER: 'local', E2E_A_URL: 'http://localhost:3000' }
    expect(childEnv(source, ['A_URL'], PROD, {}, OPTIONAL_SERVER_VARS).env).not.toHaveProperty('STUDIO_BUILDER_RENDERER')
    const passed: Record<string, string> = childEnv({ ...source, E2E_STUDIO_BUILDER_RENDERER: 'local' }, ['A_URL'], PROD, {}, OPTIONAL_SERVER_VARS).env
    expect(passed.STUDIO_BUILDER_RENDERER).toBe('local')
  })

  it('loopback means 127.0.0.1, localhost or ::1 only', () => {
    expect(isLoopbackUrl('http://localhost:3000')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1.example.com')).toBe(false)
    expect(isLoopbackUrl('http://localhost@evil.example')).toBe(false)
    expect(refuseValue('SUPABASE_SERVICE_ROLE_KEY', 'demo', PROD)).toBeNull()
  })
})

describe('what the build and its copies may contain', () => {
  it('finds .env files anywhere but node_modules', () => {
    const d = scratch()
    mkdirSync(join(d, 'a', 'node_modules'), { recursive: true })
    writeFileSync(join(d, 'a', '.env.local'), 'X=1')
    writeFileSync(join(d, 'a', 'node_modules', '.env'), 'X=1')
    writeFileSync(join(d, 'ok.ts'), '')
    expect(envFilesIn(d)).toEqual([join(d, 'a', '.env.local')])
  })

  it('finds the production ref or any hosted Supabase host in build output', () => {
    const d = scratch()
    writeFileSync(join(d, 'clean.js'), 'fetch("http://127.0.0.1:54321")')
    writeFileSync(join(d, 'prod.js'), `const u = "${PROD}"`)
    writeFileSync(join(d, 'hosted.js'), 'const u = "https://zzzzzzzzzzzzzzzzzzzz.supabase.co"')
    expect(productionTraces(d, PROD).sort()).toEqual([join(d, 'hosted.js'), join(d, 'prod.js')].sort())
  })

  it('ignores only the public landing-video prefix; any other production URL still counts', () => {
    const d = scratch()
    writeFileSync(join(d, 'landing.js'), `src:"https://${PROD}.supabase.co/storage/v1/object/public/landing-assets/hero-film.mp4"`)
    writeFileSync(join(d, 'api.js'), `url:"https://${PROD}.supabase.co/rest/v1/"`)
    writeFileSync(join(d, 'other-bucket.js'), `src:"https://${PROD}.supabase.co/storage/v1/object/public/private-ish/x"`)
    expect(productionTraces(d, PROD).sort()).toEqual([join(d, 'api.js'), join(d, 'other-bucket.js')].sort())
  })
})
