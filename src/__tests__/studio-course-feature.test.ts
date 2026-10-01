import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COURSE_FEATURES,
  PROFESSOR_SIDEBAR_FEATURES,
  courseAssistantCanSee,
  studentSidebarFeatures,
} from '@/lib/course-features'

const feature = (key: string) => COURSE_FEATURES.find((f) => f.key === key)!

describe('Studio course feature', () => {
  it('shows in the professor course sidebar', () => {
    expect(PROFESSOR_SIDEBAR_FEATURES.map((f) => f.key)).toContain('studio')
  })

  it('never reaches the student sidebar, even if its key ends up in enabledFeatures', () => {
    const keys = studentSidebarFeatures(['studio'], ['studio']).map((f) => f.key)
    expect(keys).not.toContain('studio')
  })

  it('shows to course assistants without the professor publishing it', () => {
    expect(courseAssistantCanSee(feature('studio'), [])).toBe(true)
  })

  it('keeps other professor tools hidden from course assistants', () => {
    for (const key of ['enrollment', 'staff', 'settings']) {
      expect(courseAssistantCanSee(feature(key), [key]), key).toBe(false)
    }
  })

  it('still hides unpublished student-facing features from course assistants', () => {
    expect(courseAssistantCanSee(feature('quizzes'), [])).toBe(false)
    expect(courseAssistantCanSee(feature('quizzes'), ['quizzes'])).toBe(true)
  })

  it('has a page that checks section access itself', () => {
    const page = join(process.cwd(), 'src/app/(dashboard)/professor/courses/[sectionId]/studio/page.tsx')
    expect(existsSync(page)).toBe(true)
    expect(readFileSync(page, 'utf8')).toContain('verifySectionAccess(')
  })
})
