// Tests for escapeHtml: the markup-injection guard for values (student names,
// professor-authored reasons/feedback, course labels) interpolated into raw email
// HTML by the transactional-email helpers. XSS is a security invariant here, so the
// escaping — and the order it runs in — is load-bearing.
import { describe, it, expect, vi } from 'vitest'

// email.ts imports the Resend SDK and the logger at module load; stub both so
// importing the pure helper has no side effects (mirrors events-emit.test.ts style).
vi.mock('resend', () => ({ Resend: class { emails = { send: vi.fn() } } }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { escapeHtml } from '@/lib/email'

describe('escapeHtml', () => {
  it('neutralizes a script-tag injection', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })

  it('escapes all five special characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })

  it('escapes the ampersand first so entities are not double-escaped', () => {
    // If '&' ran after '<'/'>', the '&' in the emitted &lt;/&gt; would itself be
    // re-escaped into &amp;lt;/&amp;gt;. Running '&' first keeps them single-escaped.
    expect(escapeHtml('Ben & Jerry <co>')).toBe('Ben &amp; Jerry &lt;co&gt;')
  })

  it('leaves an already-safe string untouched', () => {
    expect(escapeHtml('CS 546 — Web Programming')).toBe('CS 546 — Web Programming')
  })
})
