// Tests for the Slack feedback notifier (src/lib/slack.ts). Verifies that
// postFeedbackToSlack builds the correct Block Kit payload, no-ops when the
// webhook env var is unset, and swallows fetch failures so that feedback
// submission UX is never degraded by a Slack outage.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildFeedbackBlocks, postFeedbackToSlack, summarizeUserAgent } from '@/lib/slack'
import type { FeedbackSlackPayload } from '@/lib/slack'

const mockAdminFromMaybeSingle = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockAdminFromMaybeSingle,
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const samplePageContext = {
  pagePath: '/student/courses/abc/quizzes',
  pageTitle: 'Quizzes — Intro to NLP',
  role: 'student',
  sectionId: 'abc',
  featureName: 'quizzes',
  browser:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  timestamp: '2026-05-05T14:00:00.000Z',
}

const samplePayload: FeedbackSlackPayload = {
  feedbackId: 'fb-123',
  userId: 'user-1',
  userRole: 'student',
  rating: 2,
  category: 'bug',
  message: 'Something broke',
  pageUrl: '/student/courses/abc/quizzes',
  pageContext: samplePageContext,
  createdAt: '2026-05-05T14:00:00.000Z',
}

beforeEach(() => {
  mockAdminFromMaybeSingle.mockReset()
  vi.unstubAllGlobals()
  delete process.env.SLACK_FEEDBACK_WEBHOOK_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── buildFeedbackBlocks (pure function) ──────────────────────

describe('buildFeedbackBlocks', () => {
  const user = { displayName: 'Jane Doe', email: 'jane@example.edu' }

  it('emits header / context / section / fields / context / actions blocks for bugs', () => {
    const blocks = buildFeedbackBlocks(samplePayload, user, 'https://app.scholera-inc.com')
    expect(blocks).toHaveLength(6)
    expect(blocks[0].type).toBe('header')
    expect(blocks[1].type).toBe('context')
    expect(blocks[2].type).toBe('section')
    // Bug-specific fields block
    expect(blocks[3].type).toBe('section')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(Array.isArray((blocks[3] as any).fields)).toBe(true)
    expect(blocks[4].type).toBe('context')
    expect(blocks[5].type).toBe('actions')
  })

  it('omits the diagnostics fields block for non-bug categories', () => {
    const blocks = buildFeedbackBlocks(
      { ...samplePayload, category: 'general' },
      user,
      'https://app.scholera-inc.com',
    )
    expect(blocks).toHaveLength(5)
    // No fields block — section is followed directly by context + actions
    expect(blocks[3].type).toBe('context')
    expect(blocks[4].type).toBe('actions')
  })

  it('renders bug diagnostics: page title, feature, section id, browser/OS', () => {
    const blocks = buildFeedbackBlocks(samplePayload, user, 'https://app.scholera-inc.com')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fieldsText = JSON.stringify((blocks[3] as any).fields)
    expect(fieldsText).toContain('Quizzes — Intro to NLP')
    expect(fieldsText).toContain('quizzes')
    expect(fieldsText).toContain('abc')
    expect(fieldsText).toContain('Chrome 132 on macOS')
  })

  it('includes a button linking to /admin/feedback', () => {
    const blocks = buildFeedbackBlocks(samplePayload, user, 'https://app.scholera-inc.com')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions = blocks[blocks.length - 1] as any
    expect(actions.type).toBe('actions')
    expect(actions.elements[0].type).toBe('button')
    expect(actions.elements[0].url).toBe('https://app.scholera-inc.com/admin/feedback')
  })

  it('includes display name, email, role, category label and feedback id', () => {
    const blocks = buildFeedbackBlocks(samplePayload, user, 'https://app.scholera-inc.com')
    const flat = JSON.stringify(blocks)
    expect(flat).toContain('Jane Doe')
    expect(flat).toContain('jane@example.edu')
    expect(flat).toContain('student')
    expect(flat).toContain('Bug Report')
    expect(flat).toContain('fb-123')
  })

  it('renders an absolute URL by joining siteUrl with relative pageUrl', () => {
    const blocks = buildFeedbackBlocks(samplePayload, user, 'https://app.scholera-inc.com/')
    const flat = JSON.stringify(blocks)
    expect(flat).toContain('https://app.scholera-inc.com/student/courses/abc/quizzes')
  })

  it('substitutes a placeholder when message is null', () => {
    const blocks = buildFeedbackBlocks(
      { ...samplePayload, message: null },
      user,
      'https://app.scholera-inc.com',
    )
    const flat = JSON.stringify(blocks)
    expect(flat).toContain('no message provided')
  })

  it('truncates messages longer than the Slack section limit', () => {
    const longMessage = 'a'.repeat(5000)
    const blocks = buildFeedbackBlocks(
      { ...samplePayload, message: longMessage },
      user,
      'https://app.scholera-inc.com',
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sectionText: string = (blocks[2] as any).text.text
    expect(sectionText.length).toBeLessThan(3000)
    expect(sectionText.endsWith('…')).toBe(true)
  })
})

// ── postFeedbackToSlack ──────────────────────────────────────

describe('postFeedbackToSlack', () => {
  it('returns false and never calls fetch when SLACK_FEEDBACK_WEBHOOK_URL is unset', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await postFeedbackToSlack(samplePayload)

    expect(result).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs Block Kit payload (wrapped in attachments) to the configured webhook on success', async () => {
    process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/services/AAA/BBB/CCC'
    mockAdminFromMaybeSingle.mockResolvedValue({
      data: { email: 'jane@example.edu', name: 'Jane Doe', first_name: null, last_name: null },
      error: null,
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const result = await postFeedbackToSlack(samplePayload)

    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://hooks.slack.com/services/AAA/BBB/CCC')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body)
    expect(typeof body.text).toBe('string')
    expect(Array.isArray(body.attachments)).toBe(true)
    expect(body.attachments).toHaveLength(1)
    // Bug category gets the red sidebar.
    expect(body.attachments[0].color).toBe('#dc2626')
    expect(Array.isArray(body.attachments[0].blocks)).toBe(true)
    expect(JSON.stringify(body.attachments[0].blocks)).toContain('Jane Doe')
  })

  it('uses a different sidebar color for non-bug categories', async () => {
    process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/services/X/Y/Z'
    mockAdminFromMaybeSingle.mockResolvedValue({
      data: { email: 'jane@example.edu', name: 'Jane Doe', first_name: null, last_name: null },
      error: null,
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await postFeedbackToSlack({ ...samplePayload, category: 'general' })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.attachments[0].color).toBe('#6b7280')
  })

  it('returns false and does not throw when fetch rejects', async () => {
    process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/services/X/Y/Z'
    mockAdminFromMaybeSingle.mockResolvedValue({
      data: { email: 'jane@example.edu', name: 'Jane Doe', first_name: null, last_name: null },
      error: null,
    })
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await postFeedbackToSlack(samplePayload)
    expect(result).toBe(false)
  })

  it('returns false on non-2xx response without throwing', async () => {
    process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/services/X/Y/Z'
    mockAdminFromMaybeSingle.mockResolvedValue({
      data: { email: 'jane@example.edu', name: 'Jane Doe', first_name: null, last_name: null },
      error: null,
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await postFeedbackToSlack(samplePayload)
    expect(result).toBe(false)
  })

  it('falls back to "Unknown User" when the profile lookup yields nothing', async () => {
    process.env.SLACK_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/services/X/Y/Z'
    mockAdminFromMaybeSingle.mockResolvedValue({ data: null, error: null })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await postFeedbackToSlack(samplePayload)

    const init = fetchMock.mock.calls[0][1]
    const body = JSON.parse(init.body)
    expect(JSON.stringify(body.attachments[0].blocks)).toContain('Unknown User')
  })
})

// ── summarizeUserAgent ───────────────────────────────────────

describe('summarizeUserAgent', () => {
  it('extracts Chrome on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
    expect(summarizeUserAgent(ua)).toBe('Chrome 132 on macOS 10.15')
  })

  it('extracts Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
    expect(summarizeUserAgent(ua)).toBe('Firefox 131 on Linux')
  })

  it('extracts Safari on iOS', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    expect(summarizeUserAgent(ua)).toBe('Safari 17 on iOS 17.4')
  })

  it('returns "Unknown" for empty input', () => {
    expect(summarizeUserAgent('')).toBe('Unknown')
    expect(summarizeUserAgent(null)).toBe('Unknown')
    expect(summarizeUserAgent(undefined)).toBe('Unknown')
  })
})
