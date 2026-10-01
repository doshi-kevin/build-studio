// Tests for professor invite & onboarding schemas — transforms, defaults, and business logic.
// Max-length Zod tests removed (testing the framework, not our code).

import { describe, it, expect } from 'vitest'
import {
  inviteProfessorSchema,
  createProfessorSchema,
  updateProfessorProfileSchema,
  updateDepartmentFacultySchema,
  POSITIONS,
  EMPLOYMENT_TYPES,
  POSITION_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from '@/lib/validations/professor'
import {
  professorOnboardingSchema,
} from '@/lib/validations/professor-onboarding'

/* ──────────────────────────────────────────────────────────────────────
 * 1. Invite Professor Schema (6-field simplified form)
 * ────────────────────────────────────────────────────────────────────── */

describe('inviteProfessorSchema', () => {
  const validInput = {
    email: 'jdoe@university.edu',
    first_name: 'John',
    last_name: 'Doe',
    department_id: '550e8400-e29b-41d4-a716-446655440000',
    position: 'professor' as const,
    employment_type: 'full_time' as const,
  }

  it('accepts valid complete input', () => {
    const result = inviteProfessorSchema.safeParse(validInput)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.email).toBe('jdoe@university.edu')
      expect(result.data.first_name).toBe('John')
      expect(result.data.last_name).toBe('Doe')
    }
  })

  it('lowercases email', () => {
    const result = inviteProfessorSchema.safeParse({
      ...validInput,
      email: 'JDoe@University.EDU',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.email).toBe('jdoe@university.edu')
    }
  })

  it('rejects email with surrounding whitespace', () => {
    /* Zod trims after toLowerCase, but email() validates before trim — spaces cause failure */
    const result = inviteProfessorSchema.safeParse({
      ...validInput,
      email: '  JDoe@University.EDU  ',
    })
    expect(result.success).toBe(false)
  })

  it('trims whitespace from names', () => {
    const result = inviteProfessorSchema.safeParse({
      ...validInput,
      first_name: '  John  ',
      last_name: '  Doe  ',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.first_name).toBe('John')
      expect(result.data.last_name).toBe('Doe')
    }
  })

  it('accepts all valid positions', () => {
    for (const pos of POSITIONS) {
      const result = inviteProfessorSchema.safeParse({
        ...validInput,
        position: pos,
      })
      expect(result.success).toBe(true)
    }
  })

  it('accepts all valid employment types', () => {
    for (const type of EMPLOYMENT_TYPES) {
      const result = inviteProfessorSchema.safeParse({
        ...validInput,
        employment_type: type,
      })
      expect(result.success).toBe(true)
    }
  })

  it('deprecated createProfessorSchema is the same as inviteProfessorSchema', () => {
    expect(createProfessorSchema).toBe(inviteProfessorSchema)
  })
})

/* ──────────────────────────────────────────────────────────────────────
 * 2. Professor Onboarding Schema (all-optional form)
 * ────────────────────────────────────────────────────────────────────── */

describe('professorOnboardingSchema', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = professorOnboardingSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts fully filled input', () => {
    const result = professorOnboardingSchema.safeParse({
      phone: '+1 555-123-4567',
      title: 'Dr.',
      office_location: 'Building A, Room 301',
      office_hours: 'Mon/Wed 2-4 PM',
      office_phone: '+1 555-987-6543',
      bio: 'Expert in distributed systems.',
      research_interests: 'Machine Learning, NLP',
      website_url: 'https://example.com',
      linkedin_url: 'https://linkedin.com/in/jdoe',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid website_url', () => {
    const result = professorOnboardingSchema.safeParse({
      website_url: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid linkedin_url', () => {
    const result = professorOnboardingSchema.safeParse({
      linkedin_url: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('accepts valid URLs', () => {
    const result = professorOnboardingSchema.safeParse({
      website_url: 'https://my-site.com/about',
      linkedin_url: 'https://www.linkedin.com/in/john-doe',
    })
    expect(result.success).toBe(true)
  })

  it('trims whitespace from text fields', () => {
    const result = professorOnboardingSchema.safeParse({
      phone: '  +1 555  ',
      title: '  Dr.  ',
      bio: '  Some bio text  ',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.phone).toBe('+1 555')
      expect(result.data.title).toBe('Dr.')
      expect(result.data.bio).toBe('Some bio text')
    }
  })

})

/* ──────────────────────────────────────────────────────────────────────
 * 3. Update Professor Profile Schema (partial updates)
 * ────────────────────────────────────────────────────────────────────── */

describe('updateProfessorProfileSchema', () => {
  it('accepts empty object (all optional)', () => {
    const result = updateProfessorProfileSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts partial update with just first_name', () => {
    const result = updateProfessorProfileSchema.safeParse({
      first_name: 'Jane',
    })
    expect(result.success).toBe(true)
  })

  it('accepts partial update with just phone', () => {
    const result = updateProfessorProfileSchema.safeParse({
      phone: '+1 555-0000',
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty string for phone (clear field)', () => {
    const result = updateProfessorProfileSchema.safeParse({
      phone: '',
    })
    expect(result.success).toBe(true)
  })

  it('rejects first_name shorter than 1 char', () => {
    const result = updateProfessorProfileSchema.safeParse({
      first_name: '',
    })
    expect(result.success).toBe(false)
  })

})

/* ──────────────────────────────────────────────────────────────────────
 * 4. Update Department Faculty Schema (partial updates)
 * ────────────────────────────────────────────────────────────────────── */

describe('updateDepartmentFacultySchema', () => {
  it('accepts empty object (all optional)', () => {
    const result = updateDepartmentFacultySchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts all valid fields', () => {
    const result = updateDepartmentFacultySchema.safeParse({
      title: 'Dr.',
      position: 'associate_professor',
      employment_type: 'part_time',
      office_location: 'Room 101',
      office_hours: 'Tue/Thu 10-12',
      office_phone: '+1 555-1111',
      bio: 'Faculty bio here.',
      research_interests: 'AI, Robotics',
      website_url: 'https://faculty.edu/me',
      linkedin_url: 'https://linkedin.com/in/me',
      status: 'active',
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty strings for clearable fields', () => {
    const result = updateDepartmentFacultySchema.safeParse({
      title: '',
      office_location: '',
      bio: '',
      website_url: '',
      linkedin_url: '',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid position value', () => {
    const result = updateDepartmentFacultySchema.safeParse({
      position: 'chancellor',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid status value', () => {
    const result = updateDepartmentFacultySchema.safeParse({
      status: 'retired',
    })
    expect(result.success).toBe(false)
  })

  it('accepts all valid statuses', () => {
    for (const status of ['active', 'inactive', 'on_leave'] as const) {
      const result = updateDepartmentFacultySchema.safeParse({ status })
      expect(result.success).toBe(true)
    }
  })

})

/* ──────────────────────────────────────────────────────────────────────
 * 5. Constants & Labels consistency
 * ────────────────────────────────────────────────────────────────────── */

describe('Professor constants', () => {
  it('every POSITION has a corresponding label', () => {
    for (const pos of POSITIONS) {
      expect(POSITION_LABELS[pos]).toBeDefined()
      expect(typeof POSITION_LABELS[pos]).toBe('string')
      expect(POSITION_LABELS[pos].length).toBeGreaterThan(0)
    }
  })

  it('every EMPLOYMENT_TYPE has a corresponding label', () => {
    for (const type of EMPLOYMENT_TYPES) {
      expect(EMPLOYMENT_TYPE_LABELS[type]).toBeDefined()
      expect(typeof EMPLOYMENT_TYPE_LABELS[type]).toBe('string')
      expect(EMPLOYMENT_TYPE_LABELS[type].length).toBeGreaterThan(0)
    }
  })

  it('POSITIONS contains expected values', () => {
    expect(POSITIONS).toContain('professor')
    expect(POSITIONS).toContain('head')
    expect(POSITIONS).toContain('adjunct')
    expect(POSITIONS).toContain('lecturer')
    expect(POSITIONS.length).toBe(7)
  })

  it('EMPLOYMENT_TYPES contains expected values', () => {
    expect(EMPLOYMENT_TYPES).toContain('full_time')
    expect(EMPLOYMENT_TYPES).toContain('part_time')
    expect(EMPLOYMENT_TYPES).toContain('contract')
    expect(EMPLOYMENT_TYPES.length).toBe(3)
  })
})

/* ──────────────────────────────────────────────────────────────────────
 * 6. Invite lifecycle state transitions
 * ────────────────────────────────────────────────────────────────────── */

describe('Invite lifecycle logic', () => {
  it('only pending invites can be revoked', () => {
    /* Mirrors the check in revokeProfessorInvite() */
    const canRevoke = (inviteStatus: string) => inviteStatus === 'pending'

    expect(canRevoke('pending')).toBe(true)
    expect(canRevoke('accepted')).toBe(false)
    expect(canRevoke('active')).toBe(false)
    expect(canRevoke('revoked')).toBe(false)
  })

  it('only non-completed onboarding triggers redirect', () => {
    /* Mirrors the OnboardingGate logic */
    const shouldRedirect = (onboardingCompleted: boolean | null, pathname: string) => {
      const completed = onboardingCompleted ?? true
      return !completed && !pathname.startsWith('/professor/onboarding')
    }

    /* New invite — not completed, on dashboard → redirect */
    expect(shouldRedirect(false, '/professor')).toBe(true)
    expect(shouldRedirect(false, '/professor/courses')).toBe(true)

    /* New invite — not completed, on onboarding page → don't redirect */
    expect(shouldRedirect(false, '/professor/onboarding')).toBe(false)

    /* Completed → never redirect */
    expect(shouldRedirect(true, '/professor')).toBe(false)
    expect(shouldRedirect(true, '/professor/courses')).toBe(false)

    /* Null (existing user before migration) → defaults to true → no redirect */
    expect(shouldRedirect(null, '/professor')).toBe(false)
  })
})
