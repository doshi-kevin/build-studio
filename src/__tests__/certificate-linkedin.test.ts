import { describe, it, expect } from 'vitest'
import { buildLinkedInAddToProfileUrl } from '@/lib/certificates/linkedin'
import { createCertificateSchema } from '@/lib/validations/certificate'
import { CHALLENGE_DIFFICULTY_STAKE } from '@/lib/validations/challenge'
import { DEFAULT_TOPIC_MASTERY_CONFIG } from '@/lib/skills/config'

describe('buildLinkedInAddToProfileUrl', () => {
  const base = {
    name: 'Data Analysis Master',
    organizationName: 'Rutgers University',
    certUrl: 'https://app.scholera.com/c/abc123',
    certId: 'abc123',
    issuedAt: '2026-07-17T00:00:00.000Z',
  }

  it('builds the Add-to-Profile deep link with all fields prefilled', () => {
    const url = new URL(buildLinkedInAddToProfileUrl(base))
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/profile/add')
    const p = url.searchParams
    expect(p.get('startTask')).toBe('CERTIFICATION_NAME')
    expect(p.get('name')).toBe('Data Analysis Master')
    expect(p.get('organizationName')).toBe('Rutgers University')
    expect(p.get('certUrl')).toBe('https://app.scholera.com/c/abc123')
    expect(p.get('certId')).toBe('abc123')
    // July 2026 (UTC)
    expect(p.get('issueYear')).toBe('2026')
    expect(p.get('issueMonth')).toBe('7')
  })

  it('omits issue date params when the date is unparseable', () => {
    const p = new URL(buildLinkedInAddToProfileUrl({ ...base, issuedAt: 'not-a-date' })).searchParams
    expect(p.get('issueYear')).toBeNull()
    expect(p.get('issueMonth')).toBeNull()
    // core fields still present
    expect(p.get('name')).toBe('Data Analysis Master')
  })
})

describe('createCertificateSchema', () => {
  it('requires at least one challenge', () => {
    const r = createCertificateSchema.safeParse({ title: 'X', challenge_ids: [] })
    expect(r.success).toBe(false)
  })

  it('accepts a valid certificate definition', () => {
    const r = createCertificateSchema.safeParse({
      title: 'Milestone',
      description: 'desc',
      challenge_ids: ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
    })
    expect(r.success).toBe(true)
  })

  it('defaults description to an empty string when omitted', () => {
    const r = createCertificateSchema.safeParse({
      title: 'X',
      challenge_ids: ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'],
    })
    expect(r.success && r.data.description).toBe('')
  })
})

describe('CHALLENGE_DIFFICULTY_STAKE', () => {
  it('increases monotonically with difficulty', () => {
    const { easy, medium, hard, expert } = CHALLENGE_DIFFICULTY_STAKE
    expect(easy).toBeLessThan(medium)
    expect(medium).toBeLessThan(hard)
    expect(hard).toBeLessThan(expert)
  })

  it('never exceeds a single quiz’s stake weight (so a challenge can’t overwrite assessments)', () => {
    const max = Math.max(...Object.values(CHALLENGE_DIFFICULTY_STAKE))
    expect(max).toBeLessThanOrEqual(DEFAULT_TOPIC_MASTERY_CONFIG.stakeMultipliers.quiz)
  })
})
