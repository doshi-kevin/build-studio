// Tests for Skill Mastery reconciliation (src/lib/skills/reconcile.ts).
//
// Two layers:
//  1. canonicalizeName / matchInPool — the pure de-dup primitives. These are
//     the make-or-break piece: the same concept arriving in different casing /
//     punctuation / substring form must collapse to ONE pool entry. Pure, no DB.
//  2. seedMaterialSkills — drives the dedup-merge through a tiny in-memory fake
//     admin client and asserts only genuinely-new concepts get inserted, never
//     re-adding an existing or excluded skill.
//
// recompile + reconcileSectionSkills's full mapping path is integration-shaped
// (many tables) and is left to e2e; the dedup core is the part worth unit-testing.

import { describe, it, expect, vi } from 'vitest'

/* AI kill switch: these tests exercise the AI-ENABLED path — mock the guard
   open so their stubbed DB clients don't trip its fail-closed refusal. The
   DISABLED path for reconcileSectionSkills lives in skill-reconcile-ai-off.test.ts
   (which needs the guard closed, so it cannot share this module-level mock).
   ai-kill-switch.test.ts covers the guard MODULE only — it never imports this
   pipeline. */
vi.mock('@/lib/ai/kill-switch', () => ({
  checkAiFeature: vi.fn(async () => ({ allowed: true })),
  checkAiFeatureBySection: vi.fn(async () => ({ allowed: true })),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
const mockEmbedTextsBatch = vi.fn()
vi.mock('@/lib/pinecone/embed', () => ({
  embedTextsBatch: (...args: unknown[]) => mockEmbedTextsBatch(...args),
}))

import { canonicalizeName, matchInPool, seedMaterialSkills, assignmentSkillMappings, resolveSkillNames, assignmentSkillText, textHash, isAdministrativeConcept, isJunkConcept, isNonConcept, suggestSkillsBySimilarity, ensureSectionSkills, getModuleSkillCandidates } from '@/lib/skills/reconcile'
import { skillNamesMatch } from '@/lib/skills/canonical'

describe('isAdministrativeConcept (assessability backstop)', () => {
  it('flags course administration / structure names (whole-name match)', () => {
    for (const n of ['Course Logistics', 'Logistics', 'Introduction', 'Course Overview', 'References', 'Acknowledgements', 'Grading Policy', 'Q&A', 'Learning Outcomes', 'Course Objectives']) {
      expect(isAdministrativeConcept(n)).toBe(true)
    }
  })
  it('is case/punctuation-insensitive', () => {
    expect(isAdministrativeConcept('  course   logistics!! ')).toBe(true)
    expect(isAdministrativeConcept('REFERENCES')).toBe(true)
  })
  it('keeps real concepts that merely contain an admin word', () => {
    for (const n of ['Machine Learning Prerequisites', 'Backpropagation', 'Laplace Smoothing', 'Attention Mechanism', 'Grading Systems in Distributed Databases']) {
      expect(isAdministrativeConcept(n)).toBe(false)
    }
  })
})

describe('isJunkConcept (non-concept detector — issue #382)', () => {
  it('flags every junk class the issue reported', () => {
    for (const n of [
      'slide:3', 'Test', 'This is a test', 'This is a quiz', 'This is a test quiz',
      'qa-check', 'QA Verify Scoped Quiz', 'Yooooo', 'Can you See this',
      'What is groovy?', 'Do you know groovy?', 'Where would 26 fall in this example?',
      'Lecture 4: Introduction to Multi-Class Classification and KNN',
      'Page 12', 'Q4', 'Week 3 - Overview', '42', '   ',
    ]) {
      expect(isJunkConcept(n), n).toBe(true)
    }
  })
  it('keeps real concepts that superficially resemble junk', () => {
    for (const n of [
      'T-test', 'Hypothesis Testing', 'Unit Testing', 'Test-Driven Development',
      'Question Answering', 'QA systems', 'Backpropagation', 'tokenization',
      'attention', 'Base64', 'Chapter 11 Bankruptcy', 'Laplace smoothing',
    ]) {
      expect(isJunkConcept(n), n).toBe(false)
    }
  })
})

describe('isNonConcept (admin OR junk)', () => {
  it('is true for both admin headings and junk', () => {
    expect(isNonConcept('Course Logistics')).toBe(true)
    expect(isNonConcept('This is a quiz')).toBe(true)
  })
  it('is false for a genuine assessable concept', () => {
    expect(isNonConcept('Gradient Descent')).toBe(false)
  })
})

describe('assignmentSkillText (assemble an assignment\'s own text for extraction)', () => {
  it('joins title, description, guidelines and the grading rubric', () => {
    const text = assignmentSkillText({
      title: 'HW1: N-gram LMs',
      description: 'Build a bigram model.',
      guidelines: 'Use Laplace smoothing.',
      settings: {
        rubric: { questions: [{ label: 'Q1 Perplexity', criteria: [{ description: 'Computes perplexity correctly' }] }] },
      },
    })
    expect(text).toContain('HW1: N-gram LMs')
    expect(text).toContain('Build a bigram model.')
    expect(text).toContain('Use Laplace smoothing.')
    expect(text).toContain('Q1 Perplexity')
    expect(text).toContain('Computes perplexity correctly')
  })

  it('drops empty/absent fields and survives a malformed rubric', () => {
    expect(assignmentSkillText({ title: 'Only a title', description: '', guidelines: null, settings: null })).toBe('Only a title')
    // Malformed rubric (not the expected shape) must not throw — just contribute nothing.
    expect(assignmentSkillText({ title: 'T', settings: { rubric: 'not-an-object' } as never })).toBe('T')
  })
})

describe('textHash (cache key for assignment extraction)', () => {
  it('is deterministic and changes when the text changes', () => {
    expect(textHash('same text')).toBe(textHash('same text'))
    expect(textHash('a')).not.toBe(textHash('b'))
  })
})

describe('resolveSkillNames (AI assignment-skill suggestion → pool)', () => {
  const pool = [
    { id: 'sk-ngram', canonical: canonicalizeName('N-gram Models') },
    { id: 'sk-smooth', canonical: canonicalizeName('Laplace smoothing') },
  ]
  it('matches extracted names to pool skills and collects genuinely-new ones', () => {
    const { matchedIds, newNames } = resolveSkillNames(
      ['n-gram models', 'Laplace Smoothing', 'Beam search', 'beam search'],
      pool,
    )
    expect(matchedIds.sort()).toEqual(['sk-ngram', 'sk-smooth']) // fuzzy/canonical match
    expect(newNames).toEqual(['Beam search']) // de-duped, not in pool
  })
  it('is empty for empty input', () => {
    expect(resolveSkillNames([], pool)).toEqual({ matchedIds: [], newNames: [] })
  })
  it('drops junk/admin names instead of surfacing them as new concepts (issue #382)', () => {
    const { matchedIds, newNames } = resolveSkillNames(
      ['This is a quiz', 'Course Logistics', 'slide:3', 'Beam search'],
      pool,
    )
    expect(matchedIds).toEqual([])
    expect(newNames).toEqual(['Beam search']) // only the genuine concept survives
  })
})

describe('assignmentSkillMappings (module inheritance)', () => {
  const pool = [
    { id: 'sk-ngram', canonical: canonicalizeName('N-gram Models') },
    { id: 'sk-smooth', canonical: canonicalizeName('Laplace smoothing') },
    { id: 'sk-other', canonical: canonicalizeName('Attention') },
  ]
  const topicsByModule = new Map<string, string[]>([
    ['M1', ['N-gram Models', 'Laplace smoothing', 'not-a-skill']],
  ])

  it("inherits a linked module's skills, de-duped, matched to the pool", () => {
    const rows = assignmentSkillMappings([{ id: 'A1', module_id: 'M1' }], topicsByModule, pool)
    expect(rows.map((r) => r.skillId).sort()).toEqual(['sk-ngram', 'sk-smooth'])
    expect(rows.every((r) => r.activityId === 'A1')).toBe(true)
  })

  it('yields nothing for an assignment with no module link', () => {
    expect(assignmentSkillMappings([{ id: 'A2', module_id: null }], topicsByModule, pool)).toEqual([])
  })

  it('yields nothing when the module has no pool-matching topics', () => {
    expect(assignmentSkillMappings([{ id: 'A3', module_id: 'MX' }], topicsByModule, pool)).toEqual([])
  })
})

describe('canonicalizeName', () => {
  it('collapses casing, spaces, and punctuation to one key', () => {
    const key = canonicalizeName('Backpropagation')
    expect(canonicalizeName('back-propagation')).toBe(key)
    expect(canonicalizeName('Back Propagation')).toBe(key)
    expect(canonicalizeName('  BACKPROPAGATION  ')).toBe(key)
  })

  it('drops all non-alphanumerics but keeps digits', () => {
    expect(canonicalizeName('Chapter 3: Limits!')).toBe('chapter3limits')
  })

  it('returns empty for a punctuation-only name', () => {
    expect(canonicalizeName('-- ?? --')).toBe('')
  })
})

describe('matchInPool', () => {
  const pool = [
    { id: 'a', canonical: canonicalizeName('Backpropagation') },
    { id: 'b', canonical: canonicalizeName('Gradient Descent') },
  ]

  it('matches an exact canonical equivalent (different formatting)', () => {
    expect(matchInPool('back-propagation', pool)).toBe('a')
    expect(matchInPool('GRADIENT descent', pool)).toBe('b')
  })

  it('matches via conservative substring containment (both >= 4 chars)', () => {
    // "backprop" ⊂ "backpropagation"
    expect(matchInPool('backprop', pool)).toBe('a')
  })

  /* Overlapping skill names are the case per-question attribution made dangerous.
     While a whole-quiz score went to every skill anyway, resolving one tag to two
     skills cost nothing. Now it splits a student's score onto the wrong topic. */
  describe('overlapping skill names', () => {
    const nested = [
      { id: 'gd', canonical: canonicalizeName('Gradient descent') },
      { id: 'sgd', canonical: canonicalizeName('Stochastic gradient descent') },
    ]

    it('gives a tag to the skill it names exactly, not to the one nested inside it', () => {
      // "stochasticgradientdescent" CONTAINS "gradientdescent", so a substring
      // rule alone would credit both. The exact pass must win.
      expect(matchInPool('Stochastic gradient descent', nested)).toBe('sgd')
      expect(matchInPool('Gradient descent', nested)).toBe('gd')
    })

    it('is stable whichever order an unsorted pool arrives in', () => {
      /* Replaces an earlier version of this test that asserted
         `typeof matchInPool(...) === 'string'` and `hits.length > 0`. Both were
         true by construction — the return type is `string | null` and the hits
         came from the loop's own input — so it could not fail if attribution
         regressed. What actually needs pinning is that an EXACT tag is immune to
         pool order, because the skills query carries no ORDER BY and the engine
         sorts the pool itself before matching. */
      for (const tag of ['Stochastic gradient descent', 'gradient-descent', 'Gradient descent']) {
        expect(matchInPool(tag, nested)).toBe(matchInPool(tag, [...nested].reverse()))
      }
    })

    it('is order-independent for an exact match, whichever way the pool is sorted', () => {
      expect(matchInPool('Gradient descent', [...nested].reverse())).toBe('gd')
      expect(matchInPool('Stochastic gradient descent', [...nested].reverse())).toBe('sgd')
    })

    it('an inexact tag resolves to the MOST SPECIFIC skill once the pool is sorted that way', () => {
      // The engine sorts longest-canonical-first before matching, so an ambiguous
      // tag lands on the narrower concept instead of whichever row Postgres
      // happened to return first.
      const sorted = [...nested].sort((a, b) => b.canonical.length - a.canonical.length || a.id.localeCompare(b.id))
      expect(matchInPool('stochastic gradient descent methods', sorted)).toBe('sgd')
    })
  })

  it('does not substring-match when the candidate is too short (< 4 chars)', () => {
    // "des" canonicalises to 3 chars — must NOT collapse into "gradientdescent".
    expect(matchInPool('des', pool)).toBeNull()
  })

  it('returns null for a genuinely new concept', () => {
    expect(matchInPool('Convolution', pool)).toBeNull()
  })

  it('returns null for a name that canonicalises to empty', () => {
    expect(matchInPool('---', pool)).toBeNull()
  })
})

// skillNamesMatch is the pairwise twin of matchInPool, shared with the roadmap
// node modal so a curated chip name anchors its raw-tagged questions. Assert the
// two behaviours the questionNumbersForSkill tests don't reach directly.
describe('skillNamesMatch', () => {
  it('matches order-independently via canonical equality and conservative ≥4 substring', () => {
    expect(skillNamesMatch('back-propagation', 'Backpropagation')).toBe(true)
    expect(skillNamesMatch('Backpropagation', 'backprop')).toBe(true) // pairwise, either order
    expect(skillNamesMatch('des', 'Gradient Descent')).toBe(false)    // < 4 chars: no substring collapse
  })

  it('never matches when either name canonicalises to empty', () => {
    // Guards against punctuation-only names (both → '') falsely matching each
    // other or a real skill — the branch questionNumbersForSkill short-circuits past.
    expect(skillNamesMatch('---', '???')).toBe(false)
    expect(skillNamesMatch('---', 'Backpropagation')).toBe(false)
  })
})

// ── seedMaterialSkills: dedup-merge against the whole pool ────────────────

interface FakeSkill {
  id: string
  name: string
  parent_id: string | null
  position: number
}

/**
 * Minimal admin-client double for seedMaterialSkills. Resolves the module item
 * to a fixed section/institution, returns `skills` for the pool read, and
 * captures rows passed to skills.insert().
 */
function makeAdmin(skills: FakeSkill[]) {
  const inserted: Array<Record<string, unknown>> = []
  const admin = {
    from(table: string) {
      if (table === 'module_items') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  modules: { section_id: 'sec-1', course_sections: { institution_id: 'inst-1' } },
                },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'skills') {
        return {
          select: () => ({ eq: async () => ({ data: skills, error: null }) }),
          insert: async (rows: Array<Record<string, unknown>>) => {
            inserted.push(...rows)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { admin, inserted }
}

describe('seedMaterialSkills', () => {
  it('inserts only genuinely-new concepts and skips pool duplicates', async () => {
    const { admin, inserted } = makeAdmin([
      { id: 't1', name: 'Backpropagation', parent_id: null, position: 0 },
    ])
    // "back-propagation" dups t1; "Convolution" is new; "convolution" dups the
    // first new one within the same batch.
    const count = await seedMaterialSkills(admin, 'item-1', [
      'back-propagation',
      'Convolution',
      'convolution',
    ])
    expect(count).toBe(1)
    expect(inserted.map((r) => r.name)).toEqual(['Convolution'])
  })

  it('never re-adds an excluded/curated skill already in the pool', async () => {
    // The professor dropped "Recursion" (still in the pool). A material re-upload
    // surfacing it must not re-create it.
    const { admin, inserted } = makeAdmin([
      { id: 't1', name: 'Recursion', parent_id: null, position: 0 },
    ])
    const count = await seedMaterialSkills(admin, 'item-1', ['recursion'])
    expect(count).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('assigns positions after the existing main skills', async () => {
    const { admin, inserted } = makeAdmin([
      { id: 't1', name: 'Intro', parent_id: null, position: 0 },
      { id: 't2', name: 'Setup', parent_id: null, position: 1 },
    ])
    await seedMaterialSkills(admin, 'item-1', ['Loops', 'Arrays'])
    expect(inserted.map((r) => r.position)).toEqual([2, 3])
    // seeded as main skills from AI.
    expect(inserted.every((r) => r.parent_id === null && r.source === 'ai')).toBe(true)
  })

  it('returns 0 for an all-blank name list without touching the DB', async () => {
    const { admin, inserted } = makeAdmin([])
    expect(await seedMaterialSkills(admin, 'item-1', ['', '   '])).toBe(0)
    expect(inserted).toHaveLength(0)
  })
})

// ── suggestSkillsBySimilarity — the fallback tagging tier for hand-written questions ──
// Real cosine math over mocked embedding vectors: 2D unit-ish vectors give exact scores,
// so the bench (0.64) and top-K behavior are asserted without any network.

describe('suggestSkillsBySimilarity', () => {
  it('embeds candidates as "name. context" when context is present, bare name otherwise', async () => {
    mockEmbedTextsBatch.mockReset().mockResolvedValue({
      vectors: [
        [1, 0], // question
        [1, 0], // candidate 1
        [0, 1], // candidate 2
      ],
      tokens: 3,
      estimated: true,
    })
    await suggestSkillsBySimilarity(
      ['What is a DOM node?'],
      [
        { id: 's1', name: 'Node Types', context: 'Kinds of nodes in the DOM tree.' },
        { id: 's2', name: 'Flask Web Framework' },
      ],
      // Attribution is required in production (the kill switch refuses
      // unattributable AI spend) — every real caller passes a sectionId.
      { sectionId: 'sec-1' },
    )
    // The enrichment is the load-bearing behavior: it is what separates on-topic
    // hits from lexical pun matches (Node Types vs neural networks).
    expect(mockEmbedTextsBatch).toHaveBeenCalledWith([
      'What is a DOM node?',
      'Node Types. Kinds of nodes in the DOM tree.',
      'Flask Web Framework',
    ])
  })

  it('keeps at most the top-2 candidates at or above the bench, as {id, name} only', async () => {
    // cos(question, c1)=1.0, c2=0.8, c3=0.6 — c3 falls below the 0.64 bench.
    mockEmbedTextsBatch.mockReset().mockResolvedValue({
      vectors: [
        [1, 0],
        [1, 0],
        [0.8, 0.6],
        [0.6, 0.8],
      ],
      tokens: 4,
      estimated: true,
    })
    const [tags] = await suggestSkillsBySimilarity(
      ['q'],
      [
        { id: 's1', name: 'A', context: 'ctx' },
        { id: 's2', name: 'B' },
        { id: 's3', name: 'C' },
      ],
      { sectionId: 'sec-1' },
    )
    expect(tags).toEqual([
      { id: 's1', name: 'A' }, // context stripped from the output shape
      { id: 's2', name: 'B' },
    ])
  })

  it('returns null (retryable) for every text when embedding fails, never blocking the save', async () => {
    // Vitest 4 gotcha: reset the throwing mock INSIDE the test body, never in beforeEach.
    mockEmbedTextsBatch.mockReset().mockRejectedValue(new Error('embed down'))
    const out = await suggestSkillsBySimilarity(['a', 'b'], [{ id: 's1', name: 'A' }], { sectionId: 'sec-1' })
    // null, not []: [] would persist as a final "no tags" decision; null keeps the
    // question untagged so the next save retries.
    expect(out).toEqual([null, null])
  })
})

// ── ensureSectionSkills: resolve model-emitted skill NAMES into section tags ──────────
// A thenable-returning select().eq() (whole-section pool read), a course_sections
// maybeSingle() for the institution_id, and an insert().select() that captures new rows.
// Reused across both name-resolution helpers.

interface SectionSkill {
  id: string
  name: string
  parent_id: string | null
  position: number
  excluded: boolean
}

function ensureAdmin(skills: SectionSkill[], institutionId: string | null = 'inst-1') {
  const inserted: Array<Record<string, unknown>> = []
  const admin = {
    from(table: string) {
      if (table === 'skills') {
        return {
          select: () => ({
            // pool read: select('...').eq('section_id', id) resolves to {data}
            eq: () => Promise.resolve({ data: skills, error: null }),
          }),
          insert: (rows: Array<Record<string, unknown>>) => ({
            select: () => {
              const created = rows.map((r, i) => ({ id: `new-${i}`, name: r.name as string }))
              inserted.push(...rows)
              return Promise.resolve({ data: created, error: null })
            },
          }),
        }
      }
      if (table === 'course_sections') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: institutionId ? { institution_id: institutionId } : null,
                error: null,
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { admin, inserted }
}

describe('ensureSectionSkills', () => {
  it('drops junk names, drops exact duplicates, resolves pool matches, and mints the rest', async () => {
    const { admin, inserted } = ensureAdmin([
      { id: 't1', name: 'Recursion', parent_id: null, position: 0, excluded: false },
    ])
    // "recursion" matches the pool (resolved to the stored name, not minted);
    // "test" is junk (dropped); the exact-duplicate "Closures" collapses via the Set.
    const out = await ensureSectionSkills(admin, 'sec-1', ['recursion', 'test', 'Closures', 'Closures'])
    expect(inserted.map((r) => r.name)).toEqual(['Closures']) // junk + exact dup gone
    expect(out.get(canonicalizeName('Recursion'))).toEqual({ id: 't1', name: 'Recursion' }) // resolved to the pool's stored name
    expect(out.get(canonicalizeName('Closures'))).toEqual({ id: 'new-0', name: 'Closures' })
  })

  it('drops a name that matches an EXCLUDED skill (professor removed it — never resurrect)', async () => {
    const { admin, inserted } = ensureAdmin([
      { id: 't1', name: 'Recursion', parent_id: null, position: 0, excluded: true },
    ])
    const out = await ensureSectionSkills(admin, 'sec-1', ['recursion'])
    expect(out.size).toBe(0) // not resolved
    expect(inserted).toHaveLength(0) // and not re-created
  })

  it('returns empty (no insert) when every name is junk', async () => {
    const { admin, inserted } = ensureAdmin([])
    const out = await ensureSectionSkills(admin, 'sec-1', ['test', 'quiz', '   '])
    expect(out.size).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('drops names over the 120-char DB limit BEFORE the batch insert, so one bad name cannot reject the whole batch', async () => {
    // skills.name has check (char_length between 1 and 120) while the LLM schema allows
    // 200: an over-long name in the batch used to fail the entire insert and silently
    // drop every tag for that generation.
    const { admin, inserted } = ensureAdmin([])
    const longName = 'A'.repeat(121)
    const out = await ensureSectionSkills(admin, 'sec-1', [longName, 'Closures'])
    expect(inserted.map((r) => r.name)).toEqual(['Closures']) // survivor still minted
    expect(out.size).toBe(1)
    expect(out.get(canonicalizeName('Closures'))).toBeTruthy()
  })

  it('returns empty (no insert) when every name is over-long', async () => {
    const { admin, inserted } = ensureAdmin([])
    const out = await ensureSectionSkills(admin, 'sec-1', ['B'.repeat(121), 'C'.repeat(200)])
    expect(out.size).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('a name at exactly 120 chars still mints', async () => {
    const { admin, inserted } = ensureAdmin([])
    const edge = 'D'.repeat(120)
    const out = await ensureSectionSkills(admin, 'sec-1', [edge])
    expect(inserted.map((r) => r.name)).toEqual([edge])
    expect(out.size).toBe(1)
  })
})

// ── getModuleSkillCandidates: the tagged modules' skill pool, with section fallback ──

function candidateAdmin(opts: {
  skills: Array<{ id: string; name: string; excluded: boolean }>
  itemContents?: Array<{ concepts?: unknown; topics?: unknown }>
  moduleTitles?: string[]
}) {
  const admin = {
    from(table: string) {
      if (table === 'skills') {
        return { select: () => ({ eq: () => Promise.resolve({ data: opts.skills, error: null }) }) }
      }
      if (table === 'module_items') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: (opts.itemContents ?? []).map((content) => ({ content })), error: null }),
          }),
        }
      }
      if (table === 'modules') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: (opts.moduleTitles ?? []).map((title) => ({ title })), error: null }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return admin
}

describe('getModuleSkillCandidates', () => {
  it('returns module-scoped skills with the concept summary as context', async () => {
    const admin = candidateAdmin({
      skills: [
        { id: 's1', name: 'Recursion', excluded: false },
        { id: 's2', name: 'Arrays', excluded: false },
      ],
      itemContents: [{ concepts: [{ name: 'Recursion', summary: 'Functions that call themselves.' }] }],
    })
    const out = await getModuleSkillCandidates(admin, 'sec-1', ['mod-1'])
    expect(out).toEqual([{ id: 's1', name: 'Recursion', context: 'Functions that call themselves.' }])
  })

  it('returns [] when the tagged modules match nothing — never the whole section pool (#553-1)', async () => {
    // The old silent fallback returned the ENTIRE section pool here, which made the
    // required tagging step a no-op and suggested off-domain skills. Empty is honest:
    // the UI says "no linked skills yet" and questions stay retaggable.
    const admin = candidateAdmin({
      skills: [
        { id: 's1', name: 'Recursion', excluded: false },
        { id: 's2', name: 'Arrays', excluded: false },
      ],
      itemContents: [], // no concepts/topics
      moduleTitles: ['Untitled Module'], // no pool match
    })
    const out = await getModuleSkillCandidates(admin, 'sec-1', ['mod-1'])
    expect(out).toEqual([])
  })

  it('excludes excluded skills from the pool entirely (never a candidate, never a fallback)', async () => {
    const admin = candidateAdmin({
      skills: [{ id: 's1', name: 'Recursion', excluded: true }],
      itemContents: [{ concepts: [{ name: 'Recursion', summary: 'x' }] }],
    })
    const out = await getModuleSkillCandidates(admin, 'sec-1', ['mod-1'])
    expect(out).toEqual([]) // only excluded skill in the section → nothing to tag with
  })
})
