import { describe, it, expect } from 'vitest'
import { resolvePublishState } from '@/lib/assignments/submissions'

const NOW = new Date('2026-06-19T12:00:00.000Z').getTime()
const FUTURE = '2026-06-20T09:00:00.000Z'
const PAST = '2026-06-18T09:00:00.000Z'

describe('resolvePublishState', () => {
  it('a future schedule wins → scheduled + normalized ISO timestamp', () => {
    expect(resolvePublishState(FUTURE, false, NOW)).toEqual({
      status: 'scheduled',
      scheduledPublishAt: new Date(FUTURE).toISOString(),
    })
    // schedule beats publish-now intent too
    expect(resolvePublishState(FUTURE, true, NOW).status).toBe('scheduled')
  })

  it('a past schedule is ignored → falls back to publish-now or draft', () => {
    expect(resolvePublishState(PAST, true, NOW)).toEqual({ status: 'published', scheduledPublishAt: null })
    expect(resolvePublishState(PAST, false, NOW)).toEqual({ status: 'draft', scheduledPublishAt: null })
  })

  it('no schedule → publish flag decides', () => {
    expect(resolvePublishState(null, true, NOW)).toEqual({ status: 'published', scheduledPublishAt: null })
    expect(resolvePublishState(undefined, false, NOW)).toEqual({ status: 'draft', scheduledPublishAt: null })
  })

  it('an invalid schedule string is ignored (no crash, falls back)', () => {
    expect(resolvePublishState('not-a-date', true, NOW)).toEqual({ status: 'published', scheduledPublishAt: null })
  })
})
