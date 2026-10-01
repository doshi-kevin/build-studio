// The Manage Features checkbox means three different things depending on the row,
// and the rule has three consumers (the optimistic reducer, the server call, the
// confirmation toast). Getting 'restore' wrong is the expensive one: it would
// publish a feature to students on the single click that was meant only to put it
// back in the professor's own sidebar.
import { describe, it, expect } from 'vitest'
import { classifyFeatureToggle } from '@/lib/course-features'

const normal = { key: 'quizzes' }
const profOnly = { key: 'settings', professorOnly: true }

describe('classifyFeatureToggle', () => {
  it('treats a professor-only tool as sidebar presence, never publishing', () => {
    expect(classifyFeatureToggle(profOnly, [])).toBe('sidebar')
    // still 'sidebar' when hidden — a professor tool has no student side at all,
    // so it must not fall through to the restore/publish branches
    expect(classifyFeatureToggle(profOnly, ['settings'])).toBe('sidebar')
  })

  it('restores a hidden row to draft rather than publishing it', () => {
    expect(classifyFeatureToggle(normal, ['quizzes'])).toBe('restore')
  })

  it('publishes a visible row', () => {
    expect(classifyFeatureToggle(normal, [])).toBe('publish')
    expect(classifyFeatureToggle(normal, ['discussions'])).toBe('publish')
  })

  it('flips restore→publish once the row is no longer hidden', () => {
    // the two-click sequence: restore, then publish. The second click must read
    // the UPDATED hidden set, or it restores a second time and never publishes.
    const afterRestore: string[] = []
    expect(classifyFeatureToggle(normal, ['quizzes'])).toBe('restore')
    expect(classifyFeatureToggle(normal, afterRestore)).toBe('publish')
  })
})
