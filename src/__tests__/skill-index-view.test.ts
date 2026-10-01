// Tests for the skill-index builder: quiz coverage (activity_skills), lecture
// coverage (name-match on content.topics), class mastery, 2-level tree, and the
// orphan-surfacing sort.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { buildSkillIndex, sortSkillIndex } from '@/lib/skills/index-view'
import { DEFAULT_TOPIC_MASTERY_CONFIG } from '@/lib/skills/config'
import type { SkillRow } from '@/lib/validations/skill'

function skill(id: string, name: string, parent_id: string | null = null): SkillRow {
  return {
    id, name, parent_id, section_id: 'sec', institution_id: 'inst', info: null,
    source: 'ai', placement_pinned: false, excluded: false, suppressed: false, library_skill_id: null, position: 0,
    created_at: '', updated_at: '',
  }
}

const skills = [
  skill('S1', 'Language Modeling'),
  skill('S2', 'Laplace smoothing', 'S1'),
  skill('S3', 'Perplexity', 'S1'),
  skill('S4', 'Orphan skill'),
]

const built = buildSkillIndex({
  skills,
  activitySkills: [
    { activity_id: 'Q1', skill_id: 'S2', activity_type: 'quiz' },
    { activity_id: 'Q1', skill_id: 'S3', activity_type: 'quiz' },
    { activity_id: 'Q2', skill_id: 'S2', activity_type: 'quiz' },
    { activity_id: 'E1', skill_id: 'S3', activity_type: 'exam' }, // exams count as quizzes coverage
    { activity_id: 'A1', skill_id: 'S2', activity_type: 'assignment' },
    { activity_id: 'LQ1', skill_id: 'S3', activity_type: 'live_quiz' }, // live quiz is its own dimension
  ],
  quizzes: [{ id: 'Q1', title: 'Quiz 1' }, { id: 'Q2', title: 'Quiz 2' }, { id: 'E1', title: 'Midterm' }],
  assignments: [{ id: 'A1', title: 'HW 1' }],
  liveQuizzes: [{ id: 'LQ1', title: 'In-class check' }],
  lectures: [{ id: 'L1', title: 'Intro lecture', topics: ['Laplace Smoothing', 'N-grams'] }],
  /* Two students on S2, deliberately: mean and median only differ once there is
     more than one score, so a single-row fixture could not tell the two apart and
     would pass whichever the index happened to use. */
  /* THREE students, chosen so mean and median differ: 90/70/60 gives mean 73.3
     and median 70. Two students could not tell the two apart, so a fixture with
     two would pass whichever statistic the index happened to use — which is
     exactly how the drawer shipped the mean while the panel showed the median. */
  mastery: [
    { student_id: 'stu-1', skill_id: 'S2', score: 90 },
    { student_id: 'stu-2', skill_id: 'S2', score: 70 },
    { student_id: 'stu-3', skill_id: 'S2', score: 60 },
  ],
})

describe('buildSkillIndex', () => {
  it('maps quiz + exam coverage from activity_skills (de-duped)', () => {
    const s2 = built.flat.find((n) => n.id === 'S2')!
    expect(s2.coverage.quizzes.map((q) => q.id).sort()).toEqual(['Q1', 'Q2'])
    const s3 = built.flat.find((n) => n.id === 'S3')!
    expect(s3.coverage.quizzes.map((q) => q.id).sort()).toEqual(['E1', 'Q1']) // exam folds in
  })

  it('maps assignment coverage from activity_skills', () => {
    expect(built.flat.find((n) => n.id === 'S2')!.coverage.assignments.map((a) => a.id)).toEqual(['A1'])
    expect(built.flat.find((n) => n.id === 'S3')!.coverage.assignments).toEqual([])
  })

  it('maps live-quiz coverage from activity_skills (its own dimension)', () => {
    const s3 = built.flat.find((n) => n.id === 'S3')!
    expect(s3.coverage.live.map((l) => l.id)).toEqual(['LQ1'])
    expect(built.flat.find((n) => n.id === 'S2')!.coverage.live).toEqual([])
  })

  it('maps lecture coverage by case-insensitive name match on content.topics', () => {
    const s2 = built.flat.find((n) => n.id === 'S2')!
    expect(s2.coverage.lectures.map((l) => l.id)).toEqual(['L1']) // "Laplace Smoothing" ~ "Laplace smoothing"
    expect(built.flat.find((n) => n.id === 'S3')!.coverage.lectures).toEqual([])
  })

  it('computes class-average mastery', () => {
    // Median of 90/70/60, which is the shipped default metric. It was 80 while
    // this file computed its own mean over two students.
    expect(built.flat.find((n) => n.id === 'S2')!.masteryPct).toBe(70)
    expect(built.flat.find((n) => n.id === 'S3')!.masteryPct).toBeNull()
  })

  it('builds a 2-level tree', () => {
    expect(built.tree.map((n) => n.id).sort()).toEqual(['S1', 'S4'])
    expect(built.tree.find((n) => n.id === 'S1')!.children.map((c) => c.id).sort()).toEqual(['S2', 'S3'])
  })

  it('sort "least-covered" puts the genuinely uncovered orphan first', () => {
    const sorted = sortSkillIndex(built.flat, 'least-covered')
    // S4 is now the ONLY zero-coverage skill. Before categories rolled their
    // children's coverage up, parent S1 also read as zero and tied with S4 at the
    // front — which is the bug: "Language Modeling has no coverage" was never true,
    // it just had no activity tagged on the category row itself. A real orphan and a
    // category with three covered children looked identical in the one view whose
    // whole job is surfacing gaps.
    expect(sorted[0].id).toBe('S4')
    expect(sorted[0].coverageCount).toBe(0)
    // ...and S1, which unions everything its children carry, now sorts last.
    expect(sorted[sorted.length - 1].id).toBe('S1')
    expect(sorted[sorted.length - 1].coverageCount).toBeGreaterThan(0)
  })

  it('rolls child coverage up into the category, de-duped across siblings', () => {
    const s1 = built.flat.find((n) => n.id === 'S1')!
    // Q1 is tagged on BOTH S2 and S3, so a naive concat would double-count it.
    expect(s1.coverage.quizzes.map((q) => q.id).sort()).toEqual(['E1', 'Q1', 'Q2'])
    expect(s1.coverage.assignments.map((a) => a.id)).toEqual(['A1'])   // from S2 only
    expect(s1.coverage.live.map((l) => l.id)).toEqual(['LQ1'])         // from S3 only
    expect(s1.coverage.lectures.map((l) => l.id)).toEqual(['L1'])      // from S2 only
    expect(s1.coverageCount).toBe(6)
  })

  it('leaves leaf skills untouched by the roll-up', () => {
    // The roll-up must not leak a sibling's coverage sideways into a leaf.
    const s3 = built.flat.find((n) => n.id === 'S3')!
    expect(s3.coverage.assignments).toEqual([]) // A1 belongs to S2, not S3
    expect(s3.coverageCount).toBe(3)            // E1 + Q1 + LQ1
    expect(built.flat.find((n) => n.id === 'S4')!.coverageCount).toBe(0)
  })
})

// ── Roll-up is post-order, so depth beyond two levels still accumulates ──

describe('buildSkillIndex coverage roll-up at depth', () => {
  it('carries a grandchild’s coverage all the way to the grandparent', () => {
    // A grandparent can only pick this up if each node is rolled AFTER its own
    // children — a pre-order pass would read G2 while it was still empty and
    // leave the grandparent showing zero coverage.
    const deep = buildSkillIndex({
      skills: [
        skill('G1', 'Grandparent'),
        skill('G2', 'Parent', 'G1'),
        skill('G3', 'Leaf', 'G2'),
      ],
      activitySkills: [{ activity_id: 'Q9', skill_id: 'G3', activity_type: 'quiz' }],
      quizzes: [{ id: 'Q9', title: 'Deep quiz' }],
      assignments: [],
      liveQuizzes: [],
      lectures: [],
      mastery: [],
    })
    const byId = (id: string) => deep.flat.find((n) => n.id === id)!
    expect(byId('G3').coverage.quizzes.map((q) => q.id)).toEqual(['Q9'])
    expect(byId('G2').coverage.quizzes.map((q) => q.id)).toEqual(['Q9'])
    expect(byId('G1').coverage.quizzes.map((q) => q.id)).toEqual(['Q9'])
    expect(byId('G1').coverageCount).toBe(1) // counted once, not once per level
  })
})

// ── The roadmap stylesheet must parse ──────────────────────────

describe('roadmap-prototype.css', () => {
  it('has balanced braces, so a bad edit fails here instead of at build time', () => {
    /* A real incident: relocating an @media block left its closing brace behind.
       That is a CssSyntaxError which breaks the whole roadmap route, and NOTHING
       in the pre-commit gates caught it — lint, typecheck and the test suite do
       not parse CSS, so it reached a pull request and a human found it by opening
       the page. This is the cheapest durable guard: an unbalanced brace in a
       2000-line stylesheet is always a mistake. */
    const css = readFileSync(
      join(__dirname, '../app/(dashboard)/professor/courses/[sectionId]/roadmap/roadmap-prototype.css'),
      'utf8',
    )
    let depth = 0
    let line = 1
    let orphanAt: number | null = null
    for (const ch of css) {
      if (ch === '\n') line++
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth < 0 && orphanAt === null) orphanAt = line
      }
    }
    expect(orphanAt, `unmatched closing brace at line ${orphanAt}`).toBeNull()
    expect(depth, `${depth} block(s) left unclosed at end of file`).toBe(0)
  })
})

// ── The class number must be the section's, not this file's own ─

describe('buildSkillIndex honours the section class metric', () => {
  const skills = [
    { id: 'S1', section_id: 'sec', institution_id: 'inst', parent_id: null, name: 'Main', info: null, source: 'professor', position: 0, created_at: '', updated_at: '', placement_pinned: false, excluded: false, suppressed: false, library_skill_id: null },
  ] as unknown as Parameters<typeof buildSkillIndex>[0]['skills']

  // 90 / 70 / 60 → mean 73.3, median 70. Distinguishable on purpose.
  const mastery = [
    { student_id: 'a', skill_id: 'S1', score: 90 },
    { student_id: 'b', skill_id: 'S1', score: 70 },
    { student_id: 'c', skill_id: 'S1', score: 60 },
  ]
  const base = { skills, activitySkills: [], quizzes: [], assignments: [], liveQuizzes: [], lectures: [], mastery }

  const pctFor = (classMetric: 'median' | 'mean') =>
    buildSkillIndex({ ...base, config: { ...DEFAULT_TOPIC_MASTERY_CONFIG, classMetric } })
      .flat.find((n) => n.id === 'S1')!.masteryPct

  it('reports the median when the section says median', () => {
    expect(pctFor('median')).toBe(70)
  })

  it('reports the mean when the section says mean', () => {
    /* The regression this pins: the index used to hardcode `sum / n`, so BOTH
       branches returned 73 and the drawer contradicted the concept panel — which
       reads the same section's config — on 11 of 13 skills in a real section. */
    expect(pctFor('mean')).toBe(73)
  })

  it('defaults to the shipped default when no config is passed', () => {
    expect(buildSkillIndex(base).flat.find((n) => n.id === 'S1')!.masteryPct)
      .toBe(pctFor(DEFAULT_TOPIC_MASTERY_CONFIG.classMetric as 'median'))
  })
})
