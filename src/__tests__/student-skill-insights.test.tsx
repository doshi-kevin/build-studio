// The student's "Your Skills" card on the grades page.
//
// Three things here fail silently rather than loudly, which is why they are
// pinned:
//
//  1. The list is capped at 15. It used to be sorted most-answered-first and is
//     now sorted by score, so slicing the wrong order can drop a student's
//     WORST skill off the end and it never appears under "Needs Improvement" —
//     the one thing the card exists to show them.
//  2. Strengths and weak spots are derived from mastery tiers, not from a local
//     80/50 rule. A skill at 55 must not read as a strength here while the
//     roadmap calls it weak.
//  3. Two empty-ish states arrive as the same empty array. "Your instructor
//     tracks skills, nothing is marked yet" promises something is coming. "This
//     course tracks nothing" is an instructor configuration gap the student can
//     do nothing about, so it renders nothing at all rather than a permanent
//     dashed box on their default tab.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StudentSkillInsights } from '@/components/student/grades/StudentSkillInsights'
import type { StudentSkillScore } from '@/lib/skills/aggregate'

const skill = (name: string, score: number | null): StudentSkillScore => ({
  skillId: `id-${name}`,
  name,
  classScore: score, // on this type it is the STUDENT's own score, despite the name
  subtopics: [],
  coverage: 1,
})

describe('StudentSkillInsights', () => {
  it('keeps the weakest skill visible when there are more than fifteen', () => {
    /* 20 skills, all comfortably strong except one at 12 sitting at position 18
       in course order. Slicing course order would cut it; the student would be
       told they have no weak spots while holding a 12. */
    const skills: StudentSkillScore[] = []
    for (let i = 0; i < 20; i++) skills.push(skill(`Skill ${i}`, i === 17 ? 12 : 85))

    render(<StudentSkillInsights data={{ skills, trackedCount: 20 }} />)

    /* Twice: once as a "Needs Improvement" badge and once as its own bar row.
       Zero would mean the slice dropped it. */
    expect(screen.getAllByText('Skill 17')).toHaveLength(2)
    expect(screen.getByText('Needs Improvement')).toBeInTheDocument()
  })

  it('bands strengths and weak spots on the shared mastery tiers', () => {
    // 55 is weak under MASTERY_THRESHOLDS (shaky starts at 60) — under the old
    // local 80/50 rule it would have been neither, and shown as unremarkable.
    render(
      <StudentSkillInsights
        data={{ skills: [skill('Recursion', 88), skill('Pointers', 55), skill('Loops', 70)], trackedCount: 3 }}
      />,
    )

    expect(screen.getByText('Strengths')).toBeInTheDocument()
    expect(screen.getByText('Needs Improvement')).toBeInTheDocument()
    // 70 is "shaky": neither a strength nor a weak spot, so it appears once (its
    // own bar row) rather than twice.
    expect(screen.getAllByText('Loops')).toHaveLength(1)
  })

  it('promises scores are coming when the course tracks skills but nothing is marked', () => {
    render(<StudentSkillInsights data={{ skills: [], trackedCount: 4 }} />)
    expect(screen.getByText('No skill scores yet')).toBeInTheDocument()
  })

  it('renders nothing when the course tracks no skills at all', () => {
    // An instructor configuration gap, on the student's default tab. Saying so
    // is noise they cannot act on.
    const { container } = render(<StudentSkillInsights data={{ skills: [], trackedCount: 0 }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says skills, not topics, because the roadmap calls them skills', () => {
    // The professor drilldown promises the student sees the same number on their
    // roadmap. Two words for one object breaks that promise.
    render(<StudentSkillInsights data={{ skills: [skill('Recursion', 88)], trackedCount: 1 }} />)
    expect(screen.getByText('Your Skills')).toBeInTheDocument()
    expect(screen.queryByText(/topic/i)).toBeNull()
  })
})
