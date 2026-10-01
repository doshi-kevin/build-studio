/**
 * authErrorMessage — the auth pages' error copy (#727).
 *
 * Two failure directions, and the passthrough one is the one worth guarding.
 * Mapping too little puts `Failed to fetch` on screen, which is what #727 fixed.
 * Mapping too much is the easier regression to introduce and the more damaging:
 * widen the pattern (or invert the condition) and "Invalid login credentials"
 * becomes "Couldn't reach the server", so a reader with a typo'd password is told
 * their network is down and never tries again.
 *
 * The name is matched first BECAUSE the browser's wording is not stable — Chrome
 * says "Failed to fetch", Safari says "Load failed" — so both halves are exercised
 * independently: a recognised name with unrecognisable text, and recognisable text
 * with no name at all.
 */

import { describe, it, expect } from 'vitest'
import { authErrorMessage } from '@/lib/auth/auth-error-message'

const FRIENDLY = "Couldn't reach the server — check your connection and try again."

describe('authErrorMessage — transport failures', () => {
  /* The name is the stable signal, so it has to win on its own — including when
     the message is something no pattern would recognise. Supabase raises this for
     a WAF-blocked identifier (the response comes back with no CORS header, so the
     fetch throws) as well as for a genuinely offline network. */
  it('maps AuthRetryableFetchError by name, whatever the message says', () => {
    expect(authErrorMessage({ name: 'AuthRetryableFetchError', message: 'kaboom' })).toBe(FRIENDLY)
  })

  it.each([
    ['Chrome', 'Failed to fetch'],
    ['Safari', 'Load failed'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ['React Native', 'Network request failed'],
  ])('maps the %s transport wording when no error name is present', (_browser, message) => {
    expect(authErrorMessage({ message })).toBe(FRIENDLY)
  })

  it('matches the message pattern case-insensitively', () => {
    expect(authErrorMessage({ message: 'FAILED TO FETCH' })).toBe(FRIENDLY)
  })
})

describe('authErrorMessage — everything else passes through', () => {
  /* These are already written for people. Rewriting them would hide the only
     detail the reader can act on. */
  it.each([
    'Invalid login credentials',
    'Email not confirmed',
    'New password should be different from the old password.',
    'Password should be at least 8 characters.',
  ])('leaves %o exactly as Supabase wrote it', (message) => {
    expect(authErrorMessage({ name: 'AuthApiError', message })).toBe(message)
  })

  /* "fetch" appearing in prose must not trip the transport branch — the patterns
     are specific phrases, not the word alone. */
  it('does not treat an unrelated mention of fetch as a transport failure', () => {
    const message = 'Unable to fetch user profile: row not found'
    expect(authErrorMessage({ name: 'AuthApiError', message })).toBe(message)
  })
})
