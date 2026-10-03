/**
 * Step 9: the pure course-material rules. What the model may see of a retrieved unit
 * (labels, excerpts, caps, redaction), which modules a focus means, and the disclosure
 * guard that keeps text students can't see yet out of plugin code.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  capBytes,
  capSearch,
  cleanQuery,
  disclosureNote,
  excerptEntry,
  fitSearches,
  labelFor,
  provenanceEntries,
  resolveFocus,
  toShown,
  withSources,
  type CourseUnitRow,
  type FocusModule,
  type RenderedSearch,
} from '@/lib/studio/builder/course-material'
import { findCopies, words, type GuardSource } from '@/lib/studio/builder/disclosure'
import { runDraftChecks } from '@/lib/studio/builder/checks'
import { initialWork } from '@/lib/studio/builder/work'
import {
  STUDIO_BUILDER_TOOL_RESULT_MAX_BYTES,
  STUDIO_COURSE_BLOCK_MAX_BYTES,
  STUDIO_COURSE_EXCERPT_MAX_BYTES,
  STUDIO_COURSE_LABEL_MAX_CHARS,
  STUDIO_COURSE_RESULTS_MAX,
} from '@/lib/studio/limits'
import type { StudioManifestV2 } from '@/lib/studio/manifest'
import { FLASHCARDS_MANIFEST as RAW_MANIFEST, PROFESSOR_VIEW, STUDENT_VIEW, inProcessWorkerCheck } from './helpers/builder-fixtures'

// The fixture manifest has every field the guard and the gate read; typed as the stamped shape.
const FLASHCARDS_MANIFEST = RAW_MANIFEST as unknown as StudioManifestV2

const bytes = (s: string) => new TextEncoder().encode(s).length
const ITEM = 'a1b2c3d4-1111-4111-8111-00000000000a'
const row = (over: Partial<CourseUnitRow> = {}): CourseUnitRow => ({
  unitKey: `p:${ITEM}:12`,
  sourceKind: 'item',
  moduleTitle: 'Week 6',
  weekNumber: 6,
  itemType: 'lecture',
  page: 12,
  title: 'Attention',
  heading: null,
  disclosure: 'released',
  opensAt: null,
  excerpt: 'Scaled dot-product attention divides by the square root of the key dimension.',
  ...over,
})

describe('the search words', () => {
  it('drops time and structure words, which go through focus', () => {
    expect(cleanQuery("this week's lecture on transformers")).toBe('on transformers')
    expect(cleanQuery('Next week lectures: attention')).toBe(': attention')
    expect(cleanQuery('this week')).toBe('')
  })
})

describe('focus', () => {
  const now = Date.parse('2026-10-04T12:00:00Z') // a Sunday
  const day = 86_400_000
  const mod = (id: string, over: Partial<FocusModule> = {}): FocusModule => ({ id, weekNumber: null, unlockDate: null, isPublished: true, ...over })

  it('this_week is every published module opening within 7 days either side, including tomorrow’s', () => {
    const modules = [
      mod('w5', { weekNumber: 5, unlockDate: new Date(now - 6 * day).toISOString() }),
      mod('w6a', { weekNumber: 6, unlockDate: new Date(now + 1 * day).toISOString() }),
      mod('w6b', { weekNumber: 6, unlockDate: new Date(now + 1 * day).toISOString() }),
      mod('w7', { weekNumber: 7, unlockDate: new Date(now + 8 * day).toISOString() }),
      mod('draft', { weekNumber: 6, unlockDate: new Date(now + 1 * day).toISOString(), isPublished: false }),
    ]
    expect(resolveFocus('this_week', modules, null, now).sort()).toEqual(['w5', 'w6a', 'w6b'])
    expect(resolveFocus('next_week', modules, null, now)).toEqual(['w7'])
  })

  it('falls back to counting weeks from the start date only when the course sets no dates', () => {
    const modules = [mod('a', { weekNumber: 3 }), mod('b', { weekNumber: 4 })]
    const start = new Date(now - 15 * day).toISOString().slice(0, 10)
    expect(resolveFocus('this_week', modules, start, now)).toEqual(['a'])
    expect(resolveFocus('next_week', modules, start, now)).toEqual(['b'])
    // No start date, or before term: no guess.
    expect(resolveFocus('this_week', modules, null, now)).toEqual([])
    expect(resolveFocus('this_week', modules, new Date(now + 3 * day).toISOString().slice(0, 10), now)).toEqual([])
  })

  it('dates set but none in the window means no focus, never a guess', () => {
    expect(resolveFocus('this_week', [mod('far', { unlockDate: new Date(now + 40 * day).toISOString() })], '2026-09-01', now)).toEqual([])
  })

  it('week:N is every module with that week number', () => {
    expect(resolveFocus('week:6', [mod('a', { weekNumber: 6 }), mod('b', { weekNumber: 6 }), mod('c', { weekNumber: 7 })], null, now)).toEqual(['a', 'b'])
    expect(resolveFocus(null, [mod('a', { weekNumber: 6 })], null, now)).toEqual([])
  })
})

describe('labels', () => {
  it('names the source by week, title, kind and page, and never by id', () => {
    const label = labelFor(row(), [])
    expect(label).toBe('Week 6: Attention (lecture), page 12')
    expect(label).not.toContain(ITEM)
    expect(labelFor(row({ itemType: 'reference', page: 0 }), [])).toBe('Week 6: Attention (reading)')
    expect(labelFor(row({ sourceKind: 'assignment', title: 'Problem set 3', weekNumber: null }), [])).toBe('Problem set 3 (assignment)')
    expect(labelFor(row({ sourceKind: 'syllabus', title: 'Week 6: Attention' }), [])).toBe('Syllabus: Week 6: Attention')
    // A title that already names its week isn't prefixed twice; another week number still is.
    expect(labelFor(row({ sourceKind: 'module', title: 'Week 6: Attention' }), [])).toBe('Week 6: Attention (module)')
    expect(labelFor(row({ sourceKind: 'module', title: 'Week 60 review' }), [])).toBe('Week 6: Week 60 review (module)')
  })

  it('redacts a student’s name from a title, strips markup and caps the length', () => {
    expect(labelFor(row({ title: 'Feedback for Smith, Alice <b>x</b>' }), ['Alice Smith'])).toBe('Week 6: Feedback for [student] b x /b (lecture), page 12')
    expect(labelFor(row({ title: 'x'.repeat(300) }), []).length).toBeLessThanOrEqual(STUDIO_COURSE_LABEL_MAX_CHARS)
  })
})

describe('excerpts', () => {
  it('redacts names (in either order, any case), removes control and bidi characters and caps bytes', () => {
    const shown = toShown(row({ excerpt: 'Ask ALICE SMITH or Smith, Alice.‮gnimmargorp\u0007 ' + 'é'.repeat(2000) }), ['Alice Smith'])
    expect(shown.text).toContain('Ask [student] or [student].')
    expect(shown.text).not.toMatch(/[‮\u0007]/)
    expect(bytes(shown.text)).toBeLessThanOrEqual(STUDIO_COURSE_EXCERPT_MAX_BYTES)
    expect(capBytes('abc', 10)).toBe('abc')
  })

  it('finds a name split by an invisible character, written with a curly apostrophe or a ligature', () => {
    const roster = ["Liam O'Brien", 'Fiona Flynn', 'Alice Smith']
    const shown = toShown(row({ excerpt: 'Ask Alice​Smith then Alice\u0001Smith then Liam O’Brien and ﬁona ﬂynn.' }), roster)
    expect(shown.text).toBe('Ask [student] then [student] then [student] and [student].')
    expect(toShown(row({ excerpt: 'Alice Smith, Alice Smith' }), roster).text).not.toMatch(/alice|smith/i)
    expect(labelFor(row({ title: 'Notes by Alice⁠Smith' }), roster)).toBe('Week 6: Notes by [student] (lecture), page 12')
  })

  it('finds a name with an invisible character inside a word (soft hyphen, zero-width, private use, variation selector)', () => {
    const roster = ['Alice Smith', 'Christopher Lee']
    const inside = [
      `Chris${String.fromCodePoint(0xad)}topher Lee`,
      `Al${String.fromCodePoint(0x200b)}ice Smith`,
      `Al${String.fromCodePoint(0xe000)}ice Smith`,
      `Ali${String.fromCodePoint(0xfe0f)}ce Smith`,
    ]
    for (const name of inside) expect(toShown(row({ excerpt: `Ask ${name} today` }), roster).text).toBe('Ask [student] today')
  })

  it('cuts by bytes between whole characters, never inside an emoji', () => {
    const cut = capBytes(`ab${String.fromCodePoint(0x1f600).repeat(10)}`, 12)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(12)
    const lone = [...cut].some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff)
    expect(lone).toBe(false)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('says in words whether students can see it, and when it opens', () => {
    expect(disclosureNote({ disclosure: 'released', opensAt: null })).toBe('visible to students')
    expect(disclosureNote({ disclosure: 'scheduled', opensAt: '2026-10-09T12:00:00Z' })).toBe('not visible to students yet, opens Oct 9')
    expect(disclosureNote({ disclosure: 'scheduled', opensAt: null })).toBe('not visible to students yet')
  })

  it('a search keeps at most 6 results within its byte cap, and lists the scheduled keys', () => {
    const many = Array.from({ length: 10 }, (_, i) => row({ unitKey: `p:${ITEM}:${i + 1}`, page: i + 1, disclosure: i % 2 ? 'scheduled' : 'released' }))
    const small = capSearch(many, [])
    expect(small.shown).toHaveLength(STUDIO_COURSE_RESULTS_MAX)
    expect(small.scheduled).toEqual(small.keys.filter((_, i) => i % 2 === 1))
    const big = capSearch(many.map((r) => ({ ...r, excerpt: 'w '.repeat(2000) })), [])
    const total = big.shown.reduce((n, e, i) => n + bytes(excerptEntry(e, i + 1)), 0)
    // Excerpts are capped first, so the result count binds before the per-search byte cap.
    expect(total).toBeLessThanOrEqual(STUDIO_BUILDER_TOOL_RESULT_MAX_BYTES)
  })

  it('the prompt block drops the oldest whole search first, then the oldest search’s lowest results', () => {
    const search = (q: string, n: number): RenderedSearch => ({
      query: q,
      focus: null,
      shown: Array.from({ length: n }, (_, i) => toShown(row({ unitKey: `p:${ITEM}:${i + 1}`, excerpt: 'x '.repeat(500) }), [])),
    })
    const fitted = fitSearches([search('first', 6), search('second', 6), search('third', 6)])
    expect(fitted.searches.map((s) => s.query)).toEqual(['third'])
    expect(fitted.dropped).toBe(2)
    const one = fitSearches([search('only', 6)], 2000)
    expect(one.searches[0].shown.length).toBeLessThan(6)
    expect(fitSearches([search('a', 1), search('b', 1)], STUDIO_COURSE_BLOCK_MAX_BYTES).searches).toHaveLength(2)
  })
})

describe('provenance', () => {
  const SEC = 'a1b2c3d4-1111-4111-8111-000000000003'
  it('a run’s scheduled keys join the project’s, stamped with the run’s section, without duplicates', () => {
    expect(provenanceEntries([{ k: 'm:a', s: SEC }], ['m:a', 'm:b'], SEC)).toEqual([{ k: 'm:a', s: SEC }, { k: 'm:b', s: SEC }])
    expect(provenanceEntries([{ k: 'm:a', s: SEC }], ['m:b'], null)).toEqual([{ k: 'm:a', s: SEC }])
    expect(withSources(['a', 'b'], ['b', 'c'], 2)).toEqual(['b', 'c'])
  })
})

describe('the disclosure guard', () => {
  const lecture = 'The transformer replaces recurrence with self attention so every token attends to every other token in a single step of computation'
  const source = (over: Partial<GuardSource> = {}): GuardSource => ({ key: `p:${ITEM}:3`, label: 'Week 7: Transformers (lecture), page 3', disclosure: 'scheduled', opensAt: null, text: lecture, ...over })
  const view = (body: string) => `import { Screen, Text } from '@scholera/plugin-kit'\nexport default function V() {\n  return <Screen>${body}</Screen>\n}\n`
  const work = (student: string, manifest = FLASHCARDS_MANIFEST) => ({ manifest, files: { 'views/student.tsx': student, 'views/professor.tsx': PROFESSOR_VIEW } })

  it('fails a verbatim copy split across JSX text and string literals', () => {
    const split = view(`<Text>The transformer replaces recurrence with {'self attention'} so every token</Text><Text>{"attends to every other token"}</Text>`)
    expect(findCopies(work(split), [source()]).copies).toEqual([{ key: source().key, label: source().label, file: 'views/student.tsx' }])
  })

  it('passes a paraphrase, and ignores material students can already see', () => {
    const paraphrase = view('<Text>Instead of stepping through a sequence, each word looks at all the others at once.</Text>')
    expect(findCopies(work(paraphrase), [source()]).copies).toEqual([])
    const copy = view(`<Text>${lecture}</Text>`)
    expect(findCopies(work(copy), [source({ disclosure: 'released' })]).copies).toEqual([])
  })

  it('fails a copy of material hidden after the model saw it', () => {
    expect(findCopies(work(view(`<Text>${lecture}</Text>`)), [source({ disclosure: 'withheld' })]).copies).toHaveLength(1)
  })

  it('a single shared run of six words is a near match, not a failure', () => {
    const one = view('<Text>Remember that each token attends to every other.</Text>')
    const r = findCopies(work(one), [source()])
    expect(r.copies).toEqual([])
    expect(r.near.map((n) => n.key)).toEqual([source().key])
  })

  it('matches a short unit whole, and leaves units under four words alone', () => {
    const short = source({ text: 'Due Friday: derive softmax gradient' })
    expect(findCopies(work(view('<Text>Due Friday: derive softmax gradient!</Text>')), [short]).copies).toHaveLength(1)
    expect(findCopies(work(view('<Text>Read chapter 3</Text>')), [source({ text: 'Read chapter 3' })]).copies).toEqual([])
  })

  it('checks the manifest’s own words too', () => {
    const m = { ...FLASHCARDS_MANIFEST, description: lecture }
    expect(findCopies(work(STUDENT_VIEW, m), [source()]).copies[0].file).toBe('manifest')
  })

  it('compares NFKC, case-folded words', () => {
    expect(words('ＴＨＥ Transformer—“replaces”')).toEqual(['the', 'transformer', 'replaces'])
  })

  it('in the draft gate, a copy blocks with the source’s label only, and an unreadable source list fails closed', async () => {
    const files = { 'views/student.tsx': view(`<Text>${lecture}</Text>`).replace("import { Screen, Text }", "import { Screen, Text }"), 'views/professor.tsx': PROFESSOR_VIEW }
    const copied = await runDraftChecks({ manifest: FLASHCARDS_MANIFEST, files }, { workerCheck: inProcessWorkerCheck, rosterFullNames: [], published: null, disclosureSources: [source()] })
    const finding = copied.findings.find((f) => f.check_id === 'builder.disclosure')!
    expect(copied.passed).toBe(false)
    expect(copied.summary.disclosure).toBe('failed')
    expect(finding.detail).toBe(source().label)
    expect(JSON.stringify(copied.findings)).not.toContain('recurrence')
    const unread = await runDraftChecks({ manifest: FLASHCARDS_MANIFEST, files: { 'views/student.tsx': STUDENT_VIEW, 'views/professor.tsx': PROFESSOR_VIEW } }, { workerCheck: inProcessWorkerCheck, rosterFullNames: [], published: null, disclosureSources: null })
    expect(unread.passed).toBe(false)
    expect(unread.summary.disclosure).toBe('unavailable')
    const clean = await runDraftChecks({ manifest: FLASHCARDS_MANIFEST, files: { 'views/student.tsx': STUDENT_VIEW, 'views/professor.tsx': PROFESSOR_VIEW } }, { workerCheck: inProcessWorkerCheck, rosterFullNames: [], published: null, disclosureSources: [source()] })
    expect(clean.summary.disclosure).toBe('passed')
  })

  it('an initial working copy carries no course material', () => {
    expect(initialWork(null).material).toEqual({ searches: [], sources: [], attempts: 0, unavailable: false })
  })
})

describe('the eligibility function’s allowlist (tripwire over the migration)', () => {
  // Comments stripped: they name the excluded columns on purpose.
  const sql = readFileSync('supabase/migrations/20261003003000_studio_course_context.sql', 'utf8').replace(/--[^\n]*/g, '')
  const body = (fn: string) => {
    const start = sql.indexOf(`create or replace function public.${fn}(`)
    expect(start, fn).toBeGreaterThanOrEqual(0)
    const open = sql.indexOf('as $$', start)
    return sql.slice(open, sql.indexOf('$$;', open + 5))
  }
  const named = (text: string) => [...new Set([...text.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]))].sort()

  it('studio_course_units reads only sections, modules, items and assignments, and no excluded column', () => {
    const units = body('studio_course_units')
    expect(named(units)).toEqual(['assignments', 'course_sections', 'module_items', 'modules'])
    expect(units).not.toMatch(/instructor_note|rubric|reference_materials|answer_key|assignment_designs|\ba\.settings\b/)
  })

  it('search, re-read and the guard’s read go through studio_course_units, never a table', () => {
    expect(named(body('studio_course_search'))).toEqual(['studio_course_tsquery', 'studio_course_units'])
    expect(named(body('studio_course_excerpts'))).toEqual(['studio_course_tsquery', 'studio_course_units'])
    expect(named(body('studio_course_sources'))).toEqual(['studio_course_units'])
  })
})
