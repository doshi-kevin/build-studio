import { describe, it, expect } from 'vitest'
import {
  COURSE_FEATURES,
  DEFAULT_ENABLED_FEATURES,
  ADDITIONAL_FEATURES,
  PROFESSOR_SIDEBAR_FEATURES,
  orderFeatures,
  studentSidebarFeatures,
} from '@/lib/course-features'

describe('DEFAULT_ENABLED_FEATURES', () => {
  it('includes athena (the feature we ship on by default)', () => {
    expect(DEFAULT_ENABLED_FEATURES).toContain('athena')
  })

  it('contains exactly the keys of features flagged enabledByDefault', () => {
    const flagged = COURSE_FEATURES.filter((f) => f.enabledByDefault).map((f) => f.key)
    expect(DEFAULT_ENABLED_FEATURES).toEqual(flagged)
  })

  it('never seeds a basic or professor-only feature (only additional features)', () => {
    // Guards the multi-tenant contract: newly created sections must not be
    // auto-seeded with basics (always-on anyway) or professor-only pages.
    const additionalKeys = new Set(ADDITIONAL_FEATURES.map((f) => f.key))
    for (const key of DEFAULT_ENABLED_FEATURES) {
      expect(additionalKeys.has(key)).toBe(true)
    }
  })

  it('has no duplicate keys', () => {
    expect(new Set(DEFAULT_ENABLED_FEATURES).size).toBe(DEFAULT_ENABLED_FEATURES.length)
  })
})

describe('PROFESSOR_SIDEBAR_FEATURES', () => {
  it('excludes features with no professor page', () => {
    // studentOnly pages (AI Tutor, Course Intel) and inlineOnly toggles (Class
    // Primers) would 404 or land on the wrong page from the professor sidebar.
    for (const feature of PROFESSOR_SIDEBAR_FEATURES) {
      expect(feature.studentOnly).toBeFalsy()
      expect(feature.inlineOnly).toBeFalsy()
    }
  })

  it('includes the features that used to be buried behind Manage Features', () => {
    const keys = PROFESSOR_SIDEBAR_FEATURES.map((f) => f.key)
    expect(keys).toEqual(
      expect.arrayContaining(['quizzes', 'projects', 'discussions', 'challenges', 'settings'])
    )
  })
})

describe('orderFeatures', () => {
  const byKey = (keys: string[]) => keys.map((k) => COURSE_FEATURES.find((f) => f.key === k)!)

  it('leaves registry order untouched when no order is saved', () => {
    const input = byKey(['modules', 'quizzes', 'settings'])
    expect(orderFeatures(input, []).map((f) => f.key)).toEqual(['modules', 'quizzes', 'settings'])
  })

  it('sorts listed keys into the saved sequence', () => {
    const input = byKey(['modules', 'quizzes', 'settings'])
    const result = orderFeatures(input, ['settings', 'modules', 'quizzes'])
    expect(result.map((f) => f.key)).toEqual(['settings', 'modules', 'quizzes'])
  })

  it('appends features missing from the saved order instead of dropping them', () => {
    // This is why order is a hint rather than the visible set: a feature added
    // to the registry after the professor last dragged must still show up.
    const input = byKey(['modules', 'quizzes', 'challenges'])
    const result = orderFeatures(input, ['quizzes', 'modules'])
    expect(result.map((f) => f.key)).toEqual(['quizzes', 'modules', 'challenges'])
  })

  it('keeps unlisted features in registry order relative to each other', () => {
    const input = byKey(['modules', 'announcements', 'grades', 'settings'])
    const result = orderFeatures(input, ['settings'])
    expect(result.map((f) => f.key)).toEqual(['settings', 'modules', 'announcements', 'grades'])
  })

  it('ignores stale keys for features that are no longer present', () => {
    const input = byKey(['modules', 'quizzes'])
    const result = orderFeatures(input, ['removed-feature', 'quizzes', 'modules'])
    expect(result.map((f) => f.key)).toEqual(['quizzes', 'modules'])
  })

  it('does not mutate the input array', () => {
    const input = byKey(['modules', 'quizzes'])
    orderFeatures(input, ['quizzes', 'modules'])
    expect(input.map((f) => f.key)).toEqual(['modules', 'quizzes'])
  })

  it('ranks a duplicated key by its FIRST occurrence, not its last', () => {
    // studentSidebarFeatures prefixes the basics onto enabledFeatures, which on
    // legacy sections already contains them — so duplicates are normal input.
    // Last-wins would hand the basics their stale dragged rank. See the
    // regression test in studentSidebarFeatures below.
    const input = byKey(['modules', 'announcements', 'quizzes'])
    const result = orderFeatures(input, ['modules', 'announcements', 'quizzes', 'modules'])
    expect(result.map((f) => f.key)).toEqual(['modules', 'announcements', 'quizzes'])
  })
})

describe('releasable features (DraftFeatureBanner scope)', () => {
  // The banner offers "Release to students" on exactly the features that have a
  // student side to release. Mirrors RELEASABLE_BY_SEGMENT in the component.
  const releasable = COURSE_FEATURES.filter(
    (f) => f.category === 'additional' && !f.studentOnly && !f.inlineOnly
  )

  it('covers every shared feature a professor can build in', () => {
    expect(releasable.map((f) => f.key).sort()).toEqual([
      'assignments', 'challenges', 'discussions', 'live-classroom',
      'projects', 'quizzes', 'roadmap',
    ])
  })

  it('never offers to release something with no student side', () => {
    for (const f of releasable) {
      expect(f.professorOnly).toBeFalsy()
      expect(f.studentOnly).toBeFalsy()
      expect(f.category).not.toBe('basic') // basics are always visible
    }
  })

  it('maps each releasable feature to a unique route segment', () => {
    // A collision would make the banner claim the wrong feature is unreleased.
    const segments = releasable.map((f) => f.route.replace('/', ''))
    expect(new Set(segments).size).toBe(segments.length)
    expect(segments).not.toContain('')
  })
})

describe('studentSidebarFeatures', () => {
  it('shows basics first, then published features in the order they were toggled on', () => {
    // Registry order is quizzes-before-projects; enabledFeatures says otherwise.
    // enabledFeatures must win — that is the order these students see today.
    const result = studentSidebarFeatures(['projects', 'quizzes'], [])
    expect(result.map((f) => f.key)).toEqual([
      'modules', 'announcements', 'grades', 'projects', 'quizzes',
    ])
  })

  it('does not demote basics on sections carrying legacy drag residue', () => {
    /* Regression. The OLD reorderCourseFeatures wrote the whole professor
     * sidebar — basics included — into enabledFeatures, so dragged sections
     * have basic keys embedded mid-array. Real prod row (section 8a2ac745).
     * With last-wins ranking this returned modules, ROADMAP, announcements,
     * grades, quizzes — shuffling the student nav on upgrade. */
    const legacy = [
      'modules', 'roadmap', 'announcements', 'grades', 'quizzes',
      'projects', 'discussions', 'athena', 'pre-class-audio',
      'assignments', 'settings', 'live-classroom', 'challenges',
    ]
    const result = studentSidebarFeatures(legacy, []).map((f) => f.key)
    // The three basics must still lead, exactly as they did before this change.
    expect(result.slice(0, 3)).toEqual(['modules', 'announcements', 'grades'])
    // roadmap sits at enabledFeatures index 1 — ahead of the other extras, but
    // it must NOT be hoisted above the basics.
    expect(result[3]).toBe('roadmap')
    expect(result.indexOf('roadmap')).toBeGreaterThan(result.indexOf('grades'))
  })

  it('never exposes professor-only or inline-only features to students', () => {
    // 'settings' rides along in legacy enabledFeatures; primers have no page.
    const result = studentSidebarFeatures(
      ['settings', 'enrollment', 'staff', 'pre-class-audio', 'quizzes'], []
    ).map((f) => f.key)
    expect(result).not.toContain('settings')
    expect(result).not.toContain('enrollment')
    expect(result).not.toContain('staff')
    expect(result).not.toContain('pre-class-audio')
    expect(result).toContain('quizzes')
  })

  it('lets a saved sidebarOrder override the legacy fallback', () => {
    const result = studentSidebarFeatures(['quizzes'], ['quizzes', 'grades', 'modules', 'announcements'])
    expect(result.map((f) => f.key)).toEqual(['quizzes', 'grades', 'modules', 'announcements'])
  })
})
