import { describe, it, expect, afterEach } from 'vitest'
import { getSiteUrl } from '@/lib/site-url'

// getSiteUrl() reads env at call time, so plain assign/delete + restore
// (the suite's convention for env-reading pure fns) is enough — no module reset.
const ORIGINAL = {
  SITE_URL: process.env.SITE_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
}

function setEnv(key: 'SITE_URL' | 'NEXT_PUBLIC_SITE_URL', value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  setEnv('SITE_URL', ORIGINAL.SITE_URL)
  setEnv('NEXT_PUBLIC_SITE_URL', ORIGINAL.NEXT_PUBLIC_SITE_URL)
})

describe('getSiteUrl', () => {
  it('prefers runtime SITE_URL over the build-time NEXT_PUBLIC_SITE_URL', () => {
    // This precedence is the fix: prod bakes an empty/localhost
    // NEXT_PUBLIC_SITE_URL into the image, so the runtime SITE_URL must win.
    setEnv('SITE_URL', 'https://app.scholera-inc.com')
    setEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000')
    expect(getSiteUrl()).toBe('https://app.scholera-inc.com')
  })

  it('falls back to NEXT_PUBLIC_SITE_URL when SITE_URL is unset (local dev)', () => {
    setEnv('SITE_URL', undefined)
    setEnv('NEXT_PUBLIC_SITE_URL', 'https://staging.example.com')
    expect(getSiteUrl()).toBe('https://staging.example.com')
  })

  it('falls back to localhost when neither env var is set', () => {
    setEnv('SITE_URL', undefined)
    setEnv('NEXT_PUBLIC_SITE_URL', undefined)
    expect(getSiteUrl()).toBe('http://localhost:3000')
  })

  it('ignores an empty SITE_URL and uses the next value in the chain', () => {
    // Empty string is falsy, so the || chain must skip it — this is exactly
    // the prod image case (SITE_URL/NEXT_PUBLIC_SITE_URL baked in empty).
    setEnv('SITE_URL', '')
    setEnv('NEXT_PUBLIC_SITE_URL', 'https://fallback.example.com')
    expect(getSiteUrl()).toBe('https://fallback.example.com')
  })
})
