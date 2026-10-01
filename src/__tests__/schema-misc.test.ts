// Tests for miscellaneous validation schemas — custom refinements, transforms, discriminated unions,
// business-critical enum sets, regex patterns, non-obvious defaults, and custom functions only.
// Trivial Zod built-in tests (min/max/email/url/uuid/required/optional/happy-path) have been removed.

import { describe, it, expect } from 'vitest'

import { aboutContentV2Schema, parseAboutContent } from '@/lib/validations/course-about'
import {
  createReviewSchema,
  createTipSchema,
} from '@/lib/validations/intel'
import {
  inviteProfessorSchema,
} from '@/lib/validations/professor'
import { createProgramSchema } from '@/lib/validations/program'
import {
  proctoringEventSchema,
} from '@/lib/validations/proctoring'
import { professorOnboardingSchema } from '@/lib/validations/professor-onboarding'
import {
  submitFeedbackSchema,
} from '@/lib/validations/feedback'
import { studentProfileSchema } from '@/lib/validations/student-profile'
import {
  createDiscussionChannelSchema,
  sendDiscussionMessageSchema,
} from '@/lib/validations/discussion'
import { sendMessageSchema } from '@/lib/validations/project-chat'

// ── course-about ─────────────────────────────────────────────────────────────

describe('aboutContentV2Schema', () => {
  const parse = (data: unknown) => aboutContentV2Schema.safeParse(data)

  it('rejects wrong version number', () => {
    expect(parse({ version: 1, blocks: [] }).success).toBe(false)
  })

  it('rejects unknown block type', () => {
    expect(parse({ version: 2, blocks: [{ id: 'b1', type: 'unknown', data: {} }] }).success).toBe(false)
  })

  it('strips legacy theme and hero overlayOpacity keys (removed customization) instead of rejecting stored content', () => {
    const result = parse({
      version: 2,
      theme: { accentColor: '#FF0000' },
      blocks: [{
        id: 'b1',
        type: 'hero',
        data: { bannerSrc: '', bannerAlt: '', title: 'CS101', subtitle: '', instructor: '', semester: '', credits: '', introVideoUrl: '', ctaText: '', ctaUrl: '', overlayOpacity: 50 },
      }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect('theme' in result.data).toBe(false)
      expect('overlayOpacity' in result.data.blocks[0].data).toBe(false)
      expect((result.data.blocks[0] as { data: { title: string } }).data.title).toBe('CS101')
    }
  })

  it('defaults blocks to empty array when missing', () => {
    const result = parse({ version: 2 })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.blocks).toEqual([])
  })

  it('accepts a contact block with all fields populated', () => {
    const result = parse({
      version: 2,
      blocks: [{
        id: 'c-1',
        type: 'contact',
        data: {
          name: 'Pat Wong', title: 'Professor', email: 'p@x.edu',
          officeLocation: 'Babbio 304', officeHours: 'Tue 2-4 PM',
          zoomUrl: 'https://zoom.us/j/123', responseTime: '24h',
        },
      }],
    })
    expect(result.success).toBe(true)
  })

  it('applies defaults to a contact block with empty data', () => {
    const result = parse({ version: 2, blocks: [{ id: 'c-1', type: 'contact', data: {} }] })
    expect(result.success).toBe(true)
    if (result.success) {
      const block = result.data.blocks[0]
      // Discriminated union: must narrow via type to access contact-specific fields.
      if (block.type === 'contact') {
        expect(block.data.name).toBe('')
        expect(block.data.email).toBe('')
        expect(block.data.responseTime).toBe('')
      } else {
        throw new Error('expected contact block')
      }
    }
  })

  it('round-trips tba flag on learning-outcomes (true/false/undefined all accepted)', () => {
    for (const tba of [true, false, undefined]) {
      const result = parse({
        version: 2,
        blocks: [{
          id: 'o-1', type: 'learning-outcomes',
          data: { title: 'Outcomes', outcomes: [], ...(tba !== undefined ? { tba } : {}) },
        }],
      })
      expect(result.success).toBe(true)
      if (result.success) {
        const block = result.data.blocks[0]
        if (block.type === 'learning-outcomes') {
          expect(block.data.tba).toBe(tba)
        }
      }
    }
  })

  it('round-trips tba flag on syllabus block', () => {
    const result = parse({
      version: 2,
      blocks: [{
        id: 's-1', type: 'syllabus',
        data: { title: 'Schedule', weeks: [], tba: true },
      }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const block = result.data.blocks[0]
      if (block.type === 'syllabus') expect(block.data.tba).toBe(true)
    }
  })

  it('preserves bannerPath on hero and srcPath on image (storage cleanup keys)', () => {
    const result = parse({
      version: 2,
      blocks: [
        {
          id: 'h-1', type: 'hero',
          data: {
            bannerSrc: 'https://x.co/b.jpg', bannerPath: 'sec-1/banner.jpg',
            bannerAlt: '', title: '', subtitle: '', instructor: '', semester: '',
            credits: '', introVideoUrl: '', ctaText: '', ctaUrl: '',
          },
        },
        {
          id: 'i-1', type: 'image',
          data: { src: 'https://x.co/i.jpg', srcPath: 'sec-1/img.jpg', alt: '', caption: '', alignment: 'center' },
        },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      const hero = result.data.blocks[0]
      const image = result.data.blocks[1]
      if (hero.type === 'hero') expect(hero.data.bannerPath).toBe('sec-1/banner.jpg')
      if (image.type === 'image') expect(image.data.srcPath).toBe('sec-1/img.jpg')
    }
  })
})

// ── parseAboutContent (3-format adapter) ────────────────────────────────────
// parseAboutContent is the ONLY entry point both student and professor pages use
// to read about content from JSONB. It silently falls back to EMPTY_ABOUT on any
// invalid shape, so a regression here would render a blank page with no error.

describe('parseAboutContent', () => {
  it('returns EMPTY_ABOUT when settings is null/undefined/non-object', () => {
    expect(parseAboutContent(null).blocks).toEqual([])
    expect(parseAboutContent(undefined).blocks).toEqual([])
    expect(parseAboutContent('garbage').blocks).toEqual([])
    expect(parseAboutContent(42).blocks).toEqual([])
  })

  it('returns EMPTY_ABOUT when settings has no .about key', () => {
    expect(parseAboutContent({ other: 'thing' }).blocks).toEqual([])
  })

  it('returns EMPTY_ABOUT when v2 .about fails schema validation', () => {
    // Unknown block type → schema rejects → fall back rather than crash.
    const result = parseAboutContent({ about: { version: 2, blocks: [{ id: 'b', type: 'bogus', data: {} }] } })
    expect(result).toEqual({ version: 2, blocks: [] })
  })

  it('passes through valid v2 content untouched (contact + tba round-trip)', () => {
    const v2 = {
      version: 2 as const,
      blocks: [
        { id: 'h', type: 'hero' as const, data: { bannerSrc: '', bannerAlt: '', title: 'CS101', subtitle: '', instructor: '', semester: '', credits: '', introVideoUrl: '', ctaText: '', ctaUrl: '' } },
        { id: 'o', type: 'learning-outcomes' as const, data: { title: 'Outcomes', outcomes: [], tba: true } },
        { id: 's', type: 'syllabus' as const, data: { title: 'Schedule', weeks: [], tba: false } },
        { id: 'c', type: 'contact' as const, data: { name: 'Pat', title: '', email: '', officeLocation: '', officeHours: '', zoomUrl: '', responseTime: '' } },
      ],
    }
    const result = parseAboutContent({ about: v2 })
    expect(result.blocks).toHaveLength(4)
    expect(result.blocks.find((b) => b.type === 'contact')).toBeDefined()
    const o = result.blocks.find((b) => b.type === 'learning-outcomes')
    const s = result.blocks.find((b) => b.type === 'syllabus')
    if (o && o.type === 'learning-outcomes') expect(o.data.tba).toBe(true)
    if (s && s.type === 'syllabus') expect(s.data.tba).toBe(false)
  })

  it('migrates v1 Tiptap doc into a single text block', () => {
    const v1Doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'About this course' }] }],
    }
    const result = parseAboutContent({ about: v1Doc })
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].type).toBe('text')
  })

  it('returns EMPTY_ABOUT when v1 doc has no content', () => {
    expect(parseAboutContent({ about: { type: 'doc', content: [] } }).blocks).toEqual([])
  })

  it('migrates legacy structured format (description + outcomes + syllabus)', () => {
    const legacy = {
      description: 'Line one\nLine two',
      learning_outcomes: ['Understand X', 'Apply Y'],
      syllabus: [{ week: 1, topic: 'Intro', description: 'Welcome' }],
    }
    const result = parseAboutContent({ about: legacy })
    expect(result.blocks.length).toBeGreaterThanOrEqual(3)
    expect(result.blocks.some((b) => b.type === 'text')).toBe(true)
    expect(result.blocks.some((b) => b.type === 'learning-outcomes')).toBe(true)
    expect(result.blocks.some((b) => b.type === 'syllabus')).toBe(true)
  })

  it('returns EMPTY_ABOUT when legacy data has no recognised fields', () => {
    expect(parseAboutContent({ about: { totally: 'unknown' } }).blocks).toEqual([])
  })
})

// ── intel ────────────────────────────────────────────────────────────────────

describe('createReviewSchema', () => {
  const parse = (data: unknown) => createReviewSchema.safeParse(data)
  const valid = {
    rating_overall: 4,
    rating_difficulty: 3,
    rating_workload: 3,
    rating_teaching: 5,
    rating_grading_fairness: 4,
  }

  it('rejects invalid grade_received', () => {
    expect(parse({ ...valid, grade_received: 'Z' }).success).toBe(false)
  })
})

describe('createTipSchema', () => {
  const parse = (data: unknown) => createTipSchema.safeParse(data)

  it('defaults category to general', () => {
    const result = parse({ content: 'Study hard.' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.category).toBe('general')
  })
})

// ── professor-onboarding ─────────────────────────────────────────────────────
// Password fields used to live on this schema but were removed once the
// SetPasswordDialog (gated by app_metadata.requires_password_set) became the
// sole password-set surface — by the time the wizard loads, the password is
// already set. The remaining schema is profile fields, all optional.

describe('professorOnboardingSchema', () => {
  const parse = (data: unknown) => professorOnboardingSchema.safeParse(data)

  it('accepts an empty object (every field is optional)', () => {
    expect(parse({}).success).toBe(true)
  })

  it('rejects an invalid website URL', () => {
    expect(parse({ website_url: 'not a url' }).success).toBe(false)
  })

  it('accepts a fully populated profile', () => {
    const result = parse({
      phone: '+1 555-1234',
      title: 'Associate Professor',
      office_location: 'Babbio 304',
      office_hours: 'Tue/Thu 2–4 PM',
      bio: 'Researcher in NLP.',
      research_interests: 'NLP, ML',
      website_url: 'https://example.com',
      linkedin_url: 'https://linkedin.com/in/x',
    })
    expect(result.success).toBe(true)
  })
})

// ── feedback ─────────────────────────────────────────────────────────────────

describe('submitFeedbackSchema', () => {
  const parse = (data: unknown) => submitFeedbackSchema.safeParse(data)
  const pageCtx = {
    pagePath: '/student/courses',
    pageTitle: 'My Courses',
    role: 'student',
    browser: 'Chrome',
    timestamp: new Date().toISOString(),
  }

  it('rejects invalid rating (4 is not allowed)', () => {
    expect(parse({ rating: 4, category: 'ux', page_url: '/dashboard', page_context: pageCtx }).success).toBe(false)
  })
})

// ── student-profile ──────────────────────────────────────────────────────────

describe('studentProfileSchema', () => {
  const parse = (data: unknown) => studentProfileSchema.safeParse(data)

  it('rejects non-LinkedIn URL in linkedinUrl', () => {
    expect(parse({ linkedinUrl: 'https://twitter.com/janedoe' }).success).toBe(false)
  })

  it('rejects non-GitHub URL in githubUrl', () => {
    expect(parse({ githubUrl: 'https://gitlab.com/janedoe' }).success).toBe(false)
  })
})

// ── discussion ───────────────────────────────────────────────────────────────

describe('createDiscussionChannelSchema', () => {
  const parse = (data: unknown) => createDiscussionChannelSchema.safeParse(data)

  it('transforms name to kebab-case lowercase', () => {
    const result = parse({ name: 'My Channel' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.name).toBe('my-channel')
  })
})

describe('sendDiscussionMessageSchema', () => {
  const parse = (data: unknown) => sendDiscussionMessageSchema.safeParse(data)

  it('accepts message with attachment and empty content', () => {
    expect(parse({ content: '', attachment_url: 'https://example.com/file.pdf' }).success).toBe(true)
  })

  it('rejects empty content without attachment', () => {
    expect(parse({ content: '' }).success).toBe(false)
  })
})

// ── project-chat ─────────────────────────────────────────────────────────────

describe('sendMessageSchema (project-chat)', () => {
  const parse = (data: unknown) => sendMessageSchema.safeParse(data)

  it('rejects empty content without attachment', () => {
    expect(parse({ content: '' }).success).toBe(false)
  })

  it('accepts an attachment-only message with only a path (no signed url)', () => {
    // Client persists only attachment_path (the signed url expires); an
    // attachment-only message must validate on the path alone.
    expect(
      parse({ content: '', attachment_path: 'teams/t1/c1/123.png' }).success,
    ).toBe(true)
  })
})

// ── program ──────────────────────────────────────────────────────────────────

describe('createProgramSchema', () => {
  const parse = (data: unknown) => createProgramSchema.safeParse(data)
  const valid = {
    name: 'BS Computer Science',
    code: 'BSCS',
    degree_type: 'bachelor',
    department_id: '550e8400-e29b-41d4-a716-446655440000',
  }

  it('uppercases code', () => {
    const result = parse({ ...valid, code: 'bscs' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.code).toBe('BSCS')
  })

  it('rejects code with special chars', () => {
    expect(parse({ ...valid, code: 'BS CS!' }).success).toBe(false)
  })

  it('defaults status to active', () => {
    const result = parse(valid)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBe('active')
  })
})

// ── proctoring ───────────────────────────────────────────────────────────────

describe('proctoringEventSchema', () => {
  const parse = (data: unknown) => proctoringEventSchema.safeParse(data)

  it('rejects mod bitmask above 15', () => {
    expect(parse({ t: 100, type: 'kd', mod: 16 }).success).toBe(false)
  })

  it('rejects unknown event type', () => {
    expect(parse({ t: 100, type: 'zz' }).success).toBe(false)
  })
})

// ── professor ────────────────────────────────────────────────────────────────

describe('inviteProfessorSchema', () => {
  const parse = (data: unknown) => inviteProfessorSchema.safeParse(data)
  const valid = {
    email: 'prof@university.edu',
    first_name: 'Jane',
    last_name: 'Doe',
    department_id: '550e8400-e29b-41d4-a716-446655440000',
    position: 'professor',
    employment_type: 'full_time',
  }

  it('lowercases email', () => {
    const result = parse({ ...valid, email: 'PROF@UNIVERSITY.EDU' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.email).toBe('prof@university.edu')
  })
})
