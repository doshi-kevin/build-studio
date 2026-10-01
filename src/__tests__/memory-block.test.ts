/**
 * What actually reaches the model: the near-synonym collapse, and the rendered
 * block.
 *
 * The collapse cases here are taken verbatim from real production rows. Before
 * it existed, the top three lines of a real student's prompt were "One-Hot
 * Encoding (11%), Softmax Function (11%), multi-class classification (11%)" —
 * one quiz, five skill tags, reported as five separate findings.
 */

import { describe, it, expect, vi } from 'vitest'
import { dedupeFindings } from '@/lib/memory/derivers'
import { renderAthenaMemory } from '@/lib/ai/student-tutor/memory-block'
import type { UserState } from '@/lib/memory/state'

vi.mock('server-only', () => ({}))

const finding = (skill: string, score: number, activities: string[]) => ({
  skill,
  score,
  completedActivities: activities.length,
  evidenceKey: `${score}|${[...activities].sort().join(',')}`,
})

describe('dedupeFindings', () => {
  it('collapses skills measured by identical evidence into one', () => {
    // The real BST cluster: four names, same score, same four activities.
    const kept = dedupeFindings([
      finding('avl trees', 30, ['a', 'b', 'c', 'd']),
      finding('balanced bst', 30, ['a', 'b', 'c', 'd']),
      finding('tree rotations', 30, ['a', 'b', 'c', 'd']),
      finding('Binary Search Trees and Balanced Tree Structures', 30, ['a', 'b', 'c', 'd']),
    ])
    expect(kept).toHaveLength(1)
    // The most descriptive name survives, not whichever sorted first.
    expect(kept[0].skill).toBe('Binary Search Trees and Balanced Tree Structures')
  })

  it('collapses near-synonyms that share a significant word', () => {
    // The real softmax cluster: different evidence sets, obviously one topic.
    const kept = dedupeFindings([
      finding('softmax classifier', 24, ['a', 'b']),
      finding('Softmax Function', 30, ['a', 'b', 'c']),
      finding('softmax', 28, ['d', 'e']),
    ])
    expect(kept).toHaveLength(1)
    // Weakest-first ordering means the one worth raising is the survivor.
    expect(kept[0].score).toBe(24)
  })

  it('keeps genuinely different topics apart', () => {
    const kept = dedupeFindings([
      finding('cross-entropy', 20, ['a', 'b']),
      finding('Dependency Parsing', 26, ['c', 'd']),
      finding('Skip-gram and GloVe', 34, ['e', 'f']),
    ])
    expect(kept.map((k) => k.skill)).toEqual(['cross-entropy', 'Dependency Parsing', 'Skip-gram and GloVe'])
  })

  it('does not merge on a generic word alone', () => {
    // "Techniques" is a stopword, so these must stay separate topics.
    const kept = dedupeFindings([
      finding('Regularization Techniques', 16, ['a', 'b']),
      finding('Sampling Techniques', 22, ['c', 'd']),
    ])
    expect(kept).toHaveLength(2)
  })
})

describe('renderAthenaMemory', () => {
  const empty: UserState = { preferences: [], weakSkills: [], dueSoon: [], lastClass: null }

  it('returns null when there is nothing to say', () => {
    // Null, not an empty block: a heading with nothing under it reads to the
    // model as "we know nothing about them" and invites it to say so. This is
    // also the common case — most students have no memory yet.
    expect(renderAthenaMemory(empty)).toBeNull()
  })

  it('says nothing about attendance when the student was present', () => {
    const block = renderAthenaMemory({
      ...empty,
      lastClass: { endedAt: new Date().toISOString(), attended: true, hasRecap: true },
    })
    // Turning up is not actionable, and it would spend a line.
    expect(block).toBeNull()
  })

  it('raises a missed class, with the recap when there is one', () => {
    const block = renderAthenaMemory({
      ...empty,
      lastClass: {
        endedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        attended: false,
        hasRecap: true,
      },
    })
    expect(block).toContain('Missed the live class 2 days ago')
    expect(block).toContain('A recap is available')
  })

  it('carries the evidence count so a thin finding reads as thin', () => {
    const block = renderAthenaMemory({
      ...empty,
      weakSkills: [{ skill: 'cross-entropy', score: 20, completedActivities: 1 }],
    })
    expect(block).toContain('cross-entropy, 20% across 1 graded activity.')
  })

  it('caps each category so one cannot crowd out the others', () => {
    const block = renderAthenaMemory({
      preferences: Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`, slot: 'constraint' as const, text: `pref ${i}`,
        sectionId: null, expiresAt: null, observedAt: '2026-09-01',
      })),
      weakSkills: Array.from({ length: 8 }, (_, i) => ({
        skill: `skill ${i}`, score: i, completedActivities: 3,
      })),
      dueSoon: Array.from({ length: 8 }, (_, i) => ({
        title: `item ${i}`, kind: 'quiz' as const,
        dueAt: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
      })),
      lastClass: null,
    })
    const lines = (block ?? '').split('\n').filter((l) => /^\s{4}\S/.test(l))
    expect(lines).toHaveLength(3 + 3 + 2)
  })

  it('expresses a deadline as a distance, not a date', () => {
    const block = renderAthenaMemory({
      ...empty,
      dueSoon: [{
        title: 'Quiz 4', kind: 'quiz',
        dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      }],
    })
    expect(block).toContain('Quiz 4 (quiz) is due in 3 days.')
  })
})

describe('which preferences reach the prompt', () => {
  /* Only three fit, and `readPreferences` hands them over newest first. Taking
     the first three is therefore taking the three most RECENT, and what a person
     says earliest is usually the accommodation. Measured on a simulated term:
     three ordinary style notes from week 10 pushed a week-1 colour-blindness
     constraint out of the prompt entirely, while it sat in the table looking
     perfectly stored. */
  const state = (preferences: UserState['preferences']): UserState => ({
    preferences,
    weakSkills: [],
    dueSoon: [],
    lastClass: null,
  })

  const pref = (id: string, slot: string, text: string, observedAt: string) => ({
    id,
    slot: slot as UserState['preferences'][number]['slot'],
    text,
    sectionId: null,
    expiresAt: null,
    observedAt,
  })

  it('keeps an accommodation stated first over three casual notes stated later', () => {
    const block = renderAthenaMemory(
      state([
        pref('d', 'constraint', 'put the summary at the end', '2026-09-01T00:00:00Z'),
        pref('c', 'tone', 'no small talk', '2026-08-20T00:00:00Z'),
        pref('b', 'answer_length', 'keep it short', '2026-08-10T00:00:00Z'),
        pref('a', 'constraint', 'I use a screen reader, describe any diagram in words', '2026-06-01T00:00:00Z'),
      ]),
    )
    expect(block).toContain('screen reader')
  })

  it('still prefers the newer of two accommodations', () => {
    const block = renderAthenaMemory(
      state([
        pref('new', 'constraint', 'describe any chart in words', '2026-09-01T00:00:00Z'),
        pref('a', 'constraint', 'number the steps', '2026-08-01T00:00:00Z'),
        pref('b', 'constraint', 'no nested lists', '2026-07-01T00:00:00Z'),
        pref('old', 'constraint', 'bold the key term', '2026-06-01T00:00:00Z'),
      ]),
    )
    expect(block).toContain('describe any chart in words')
    expect(block).not.toContain('bold the key term')
  })
})
