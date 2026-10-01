import { describe, it, expect } from 'vitest'
import { parseStudentProfile, studentProfileSchema } from '@/lib/validations/student-profile'

// Guards the URL normalization: students routinely paste a bare domain (no scheme),
// which z.string().url() used to reject — blocking the whole profile save.

describe('studentProfileSchema — link URL normalization', () => {
  it('accepts a bare LinkedIn domain and prepends https://', () => {
    const r = studentProfileSchema.safeParse({ bio: '', linkedinUrl: 'linkedin.com/in/me', githubUrl: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.linkedinUrl).toBe('https://linkedin.com/in/me')
  })

  it('accepts a bare GitHub domain and prepends https://', () => {
    const r = studentProfileSchema.safeParse({ bio: '', linkedinUrl: '', githubUrl: 'github.com/me' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.githubUrl).toBe('https://github.com/me')
  })

  it('leaves an already-qualified https URL unchanged', () => {
    const r = studentProfileSchema.safeParse({ bio: '', linkedinUrl: 'https://linkedin.com/in/me', githubUrl: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.linkedinUrl).toBe('https://linkedin.com/in/me')
  })

  it('allows all-empty links (bio-only save)', () => {
    const r = studentProfileSchema.safeParse({ bio: 'hello', linkedinUrl: '', githubUrl: '' })
    expect(r.success).toBe(true)
  })

  it('still rejects a non-LinkedIn URL in the LinkedIn field', () => {
    const r = studentProfileSchema.safeParse({ bio: '', linkedinUrl: 'example.com', githubUrl: '' })
    expect(r.success).toBe(false)
  })
})

// parseStudentProfile validates on READ, not just on write. profiles.settings is
// PATCH-able straight from the browser with the anon key (table-wide self-update
// policy, trigger pins only role + institution_id, no column grants), so a value
// reaching here may never have seen studentProfileSchema. It is rendered as an
// href in the PROFESSOR's page, so the read path is the real trust boundary.
describe('parseStudentProfile hardening', () => {
  const wrap = (profile: Record<string, unknown>) => ({ profile })

  it('drops a javascript: URL', () => {
    const out = parseStudentProfile(wrap({ linkedinUrl: 'javascript:alert(document.cookie)' }))
    expect(out.linkedinUrl).toBe('')
  })

  it('drops a data: URL', () => {
    const out = parseStudentProfile(wrap({ githubUrl: 'data:text/html,<script>alert(1)</script>' }))
    expect(out.githubUrl).toBe('')
  })

  it('drops an http(s) link pointing somewhere other than the labelled host', () => {
    // A link captioned "LinkedIn", with LinkedIn's icon, aimed at a fake login.
    const out = parseStudentProfile(wrap({ linkedinUrl: 'https://linkedln-verify.example/login' }))
    expect(out.linkedinUrl).toBe('')
  })

  it('is not fooled by the host appearing as a prefix of another domain', () => {
    const out = parseStudentProfile(wrap({ linkedinUrl: 'https://linkedin.com.evil.test/in/me' }))
    expect(out.linkedinUrl).toBe('')
  })

  it('is not fooled by the host appearing as a suffix of another domain', () => {
    const out = parseStudentProfile(wrap({ githubUrl: 'https://notgithub.com/me' }))
    expect(out.githubUrl).toBe('')
  })

  it('keeps a legitimate link, including a www subdomain', () => {
    const out = parseStudentProfile(
      wrap({
        linkedinUrl: 'https://www.linkedin.com/in/someone',
        githubUrl: 'https://github.com/someone',
      }),
    )
    expect(out.linkedinUrl).toBe('https://www.linkedin.com/in/someone')
    expect(out.githubUrl).toBe('https://github.com/someone')
  })

  it('caps an oversized bio instead of rendering it in full', () => {
    const out = parseStudentProfile(wrap({ bio: 'x'.repeat(5000) }))
    expect(out.bio).toHaveLength(300)
  })

  it('blanks one bad field without discarding the others', () => {
    const out = parseStudentProfile(
      wrap({ bio: 'Hi', linkedinUrl: 'javascript:alert(1)', githubUrl: 'https://github.com/me' }),
    )
    expect(out).toEqual({ bio: 'Hi', linkedinUrl: '', githubUrl: 'https://github.com/me' })
  })
})
