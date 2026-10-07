/**
 * Step 12A.3: evaluating the evaluator (docs/designs/studio/studio-generation-quality.md).
 *
 *   Contrasts       realistic, deterministic degradations of saved artifacts. Each pair links
 *                   original, degraded and the dimensions that must drop; the judge passes
 *                   when the degraded artifact's median level is at least one lower.
 *   Repeatability   how much the judge's runs on one unchanged artifact disagree, and how many
 *                   runs a stable score needs.
 *   Human pack      a blind scoring pack (no AI output in it) and the comparison with the
 *                   AI's levels once a person has filled in human-scores.json.
 *
 * No builder runs here, and holdout cases are refused unless explicitly allowed.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import { DIMENSIONS, DIMENSION_KEYS, LEVELS, LEVEL_FRACTION, RUBRIC_VERSION, medianLevel, totalScore, type DimensionKey, type Level } from './rubric'
import { artifactHash } from './evaluate'
import type { QualityCase } from './cases'
import type { QualityResult } from './schema'

const rank = (l: Level) => LEVELS.indexOf(l)
const round1 = (x: number) => Math.round(x * 10) / 10

// ── Holdout ──

/** Holdout cases stay sealed until Step 12A.4: calibration refuses them unless told otherwise. */
export function assertNoHoldout(cases: readonly Pick<QualityCase, 'id' | 'set'>[], allowHoldout: boolean): void {
  const sealed = cases.filter((c) => c.set === 'holdout').map((c) => c.id)
  if (sealed.length && !allowHoldout) throw new Error(`Holdout case(s) ${sealed.join(', ')} are sealed until Step 12A.4. Pass --allow-holdout only for the baseline.`)
}

// ── Contrasts ──

export interface ContrastEdit {
  file: 'professor.tsx' | 'student.tsx'
  /** Exact text, or a pattern; either must match exactly once. */
  find: string | RegExp
  replace: string
}

export interface ContrastPair {
  id: string
  kind: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  label: string
  /** The saved artifact folder, relative to the repository. */
  original: string
  /** The original's artifact hash, so a changed folder is refused instead of silently used. */
  originalSha256: string
  /** Must each drop at least one level. */
  targeted: DimensionKey[]
  /** May drop too; recorded, never required. */
  mayAlsoDecline: DimensionKey[]
  change: string
  edits: ContrastEdit[]
}

const removeImport = (name: string): ContrastEdit[] => [
  { file: 'student.tsx', find: new RegExp(`\\n\\s*${name},?(?=\\s*\\n)`), replace: '' },
]

export const CONTRASTS: readonly ContrastPair[] = [
  {
    id: 'A-queue-no-call',
    kind: 'A',
    label: 'Core action removed',
    original: 'tmp/product-bench2/E-office-hours-queue',
    originalSha256: 'e48eda738585f28a3467928d5b23825f509ad9b41335528dcccd4a83d6a33617',
    targeted: ['workflow_completeness'],
    mayAlsoDecline: ['professor_experience', 'interaction_design'],
    change: 'The professor still sees the queue and its counts, but the status column is a read-only badge: no way to call the next student or mark one done.',
    edits: [
      { file: 'professor.tsx', find: /state: \{\s*kind: "choice",[\s\S]*?\]\s*\}/, replace: 'state: { kind: "badge", text: info.state === "called" ? "Called" : "Waiting", tone: info.state === "called" ? "info" : "warning" }' },
      { file: 'professor.tsx', find: /\n\s*onAction=\{handleAction\}/, replace: '' },
      { file: 'professor.tsx', find: /\n\s*const handleAction = async \([\s\S]*?\n\s*\};\n/, replace: '\n' },
    ],
  },
  {
    id: 'B-attendance-no-history',
    kind: 'B',
    label: 'History and readback removed',
    original: 'tmp/product-bench/G-attendance',
    originalSha256: '0e9748388297bccf7fbf0d0e9cfe4dfec98246e69d535ec36bead2b23798bb24',
    targeted: ['workflow_completeness'],
    mayAlsoDecline: ['student_experience', 'professor_experience', 'information_design'],
    change: 'The professor can only ever see and mark today (the date picker is gone), and the student sees summary counts but no list of past sessions.',
    edits: [
      { file: 'professor.tsx', find: 'const [currentDate, setCurrentDate] = useState(today());', replace: 'const currentDate = today();' },
      { file: 'professor.tsx', find: /<Stack direction="row" justify="between" align="center">\s*<DateField[\s\S]*?\/>/, replace: '<Stack direction="row" justify="end" align="center">' },
      { file: 'professor.tsx', find: /\n\s*DateField,/, replace: '' },
      { file: 'student.tsx', find: /\n\s*<Section>\s*<DataTable[\s\S]*?<\/Section>/, replace: '' },
      { file: 'student.tsx', find: /\n\s*const sortedRecords = useMemo\([\s\S]*?\}, \[records\]\);/, replace: '' },
      { file: 'student.tsx', find: /\n\s*const getTone = [\s\S]*?\n {2}\};/, replace: '' },
      { file: 'student.tsx', find: /\n\s*const getStatusLabel = [\s\S]*?\n {2}\};/, replace: '' },
      { file: 'student.tsx', find: 'Review your attendance history.', replace: 'Your attendance.' },
      ...removeImport('DataTable'),
      ...removeImport('formatDate'),
      ...removeImport('Badge'),
      ...removeImport('Tone'),
    ],
  },
  {
    id: 'C-feedback-phone-row',
    kind: 'C',
    label: 'Phone layout degraded',
    original: 'tmp/product-bench/D-anonymous-feedback',
    originalSha256: '1b7f30d6792936c75933201b6ea7ab61b355901177ab995c11dc28cb05ddb88f',
    targeted: ['responsiveness_accessibility'],
    mayAlsoDecline: ['student_experience', 'visual_quality'],
    change: 'The topic picker, the feedback box and the submit button sit side by side in one row that never wraps: fine on a desktop, crushed on a phone.',
    edits: [{ file: 'student.tsx', find: /<Stack>(\s*\{error && <Alert)/, replace: '<Stack direction="row" wrap={false}>$1' }],
  },
  {
    id: 'D-flashcards-bare-empty',
    kind: 'D',
    label: 'Empty-state guidance removed',
    original: 'tmp/product-bench/C-lecture-flashcards',
    originalSha256: '721ad37c53850a604eb6e9dba860b12daad16361be379ee94717f255d23fd535',
    targeted: ['edge_states'],
    mayAlsoDecline: ['professor_experience', 'student_experience'],
    change: 'Both empty states say only "No data": nothing tells the professor to add cards or the student that cards will come.',
    edits: [
      { file: 'professor.tsx', find: '<Empty title="No cards yet" description="Add cards to help students practice." />', replace: '<Empty title="No data" />' },
      { file: 'student.tsx', find: '<Empty title="No cards yet" description="Your professor hasn\'t added any flashcards yet." />', replace: '<Empty title="No data" />' },
    ],
  },
  {
    id: 'E-readings-no-status',
    kind: 'E',
    label: 'Student status and feedback removed',
    original: 'tmp/product-bench4/B3-reading-tracker',
    originalSha256: '47c4f0136720fd33d4d9d1bfce93e091058b48124ef1d4da3e0163355d4243f7',
    targeted: ['student_experience'],
    mayAlsoDecline: ['workflow_completeness', 'interaction_design', 'information_design'],
    change: 'Students can still mark a reading completed, but nothing shows which they finished: no progress bar, no completed or pending badge, no way to undo.',
    edits: [
      { file: 'student.tsx', find: /\n\s*<Section>\s*<ProgressBar[\s\S]*?<\/Section>/, replace: '' },
      { file: 'student.tsx', find: /\n\s*meta=\{isCompleted[^\n]*/, replace: '' },
      {
        file: 'student.tsx',
        find: /actions=\{\s*isCompleted[\s\S]*?Mark Completed<\/Button>\s*\)\s*\}/,
        replace: 'actions={<Button variant="secondary" onPress={() => completionsQuery.create({ readingId: reading.id, completedAt: today() })}>Mark Completed</Button>}',
      },
      { file: 'student.tsx', find: /\n\s*const completion = completedMap\.get\(reading\.id\);\s*const isCompleted = !!completion;/, replace: '' },
      { file: 'student.tsx', find: /\n\s*const completedCount = completedMap\.size;\s*const totalCount = readings\.length;/, replace: '' },
      { file: 'student.tsx', find: /\n\s*const completedMap = useMemo\([\s\S]*?\}, \[completions\]\);/, replace: '' },
      { file: 'student.tsx', find: /\n\s*const completions = completionsQuery\.records \?\? \[\];/, replace: '' },
      { file: 'student.tsx', find: 'import { useMemo } from "react";\n', replace: '' },
      { file: 'student.tsx', find: ', Badge, ProgressBar,', replace: ',' },
      { file: 'student.tsx', find: 'Track your reading progress.', replace: 'Your readings.' },
    ],
  },
  {
    id: 'F-attendance-raw-history',
    kind: 'F',
    label: 'Information design degraded',
    original: 'tmp/product-bench/G-attendance',
    originalSha256: '0e9748388297bccf7fbf0d0e9cfe4dfec98246e69d535ec36bead2b23798bb24',
    targeted: ['information_design'],
    mayAlsoDecline: ['student_experience'],
    change: 'The student history shows a record id column, raw ISO dates and lower-case status codes, sorted by record id instead of date. Everything still works.',
    edits: [
      { file: 'student.tsx', find: 'return [...records].sort((a, b) => b.data.date.localeCompare(a.data.date));', replace: 'return [...records].sort((a, b) => a.id.localeCompare(b.id));' },
      { file: 'student.tsx', find: /\{ key: "date", header: "Date" \},\s*\{ key: "status", header: "Status" \}/, replace: '{ key: "id", header: "id" },\n            { key: "date", header: "date" },\n            { key: "status", header: "status" }' },
      { file: 'student.tsx', find: 'date: formatDate(record.data.date),', replace: 'id: record.id,\n              date: record.data.date,' },
      { file: 'student.tsx', find: /status: \(\s*<Badge[\s\S]*?<\/Badge>\s*\)/, replace: 'status: record.data.status' },
      { file: 'student.tsx', find: /\n\s*const getTone = [\s\S]*?\n {2}\};/, replace: '' },
      { file: 'student.tsx', find: /\n\s*const getStatusLabel = [\s\S]*?\n {2}\};/, replace: '' },
      ...removeImport('formatDate'),
      ...removeImport('Badge'),
      ...removeImport('Tone'),
    ],
  },
]

/** Applies a pair's edits; each must match exactly once, or nothing is written. */
export function applyEdits(files: { professor: string; student: string }, edits: readonly ContrastEdit[]): { professor: string; student: string } {
  const out = { ...files }
  for (const [i, e] of edits.entries()) {
    const key = e.file === 'professor.tsx' ? 'professor' : 'student'
    const text = out[key]
    const count = typeof e.find === 'string' ? text.split(e.find).length - 1 : [...text.matchAll(new RegExp(e.find.source, e.find.flags.includes('g') ? e.find.flags : `${e.find.flags}g`))].length
    if (count !== 1) throw new Error(`Edit ${i + 1} on ${e.file} matched ${count} times, not once: ${String(e.find).slice(0, 80)}`)
    out[key] = typeof e.find === 'string' ? text.replace(e.find, () => e.replace) : text.replace(e.find, e.replace)
  }
  return out
}

const ARTIFACT_FILES = ['manifest.json', 'professor.tsx', 'student.tsx', 'sample.json', 'result.json'] as const

function readArtifactFolder(dir: string) {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n')
  return { manifest: JSON.parse(read('manifest.json')), files: { professor: read('professor.tsx'), student: read('student.tsx') }, sample: JSON.parse(read('sample.json')) }
}

export const contrastLinkSchema = z.strictObject({
  format: z.literal('studio-quality-contrast-v1'),
  id: z.string(),
  kind: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  label: z.string(),
  change: z.string(),
  original: z.strictObject({ source: z.string(), dir: z.string(), artifactSha256: z.string() }),
  degraded: z.strictObject({ dir: z.string(), artifactSha256: z.string() }),
  targeted: z.array(z.enum(DIMENSION_KEYS)).min(1),
  mayAlsoDecline: z.array(z.enum(DIMENSION_KEYS)),
})
export type ContrastLink = z.infer<typeof contrastLinkSchema>

/** Writes <out>/<id>/{original,degraded}/ and the link between them. Refuses a changed original. */
export function materializeContrast(pair: ContrastPair, root: string, out: string): ContrastLink {
  const source = join(root, pair.original)
  const original = readArtifactFolder(source)
  const originalSha256 = artifactHash(original.manifest, original.files, original.sample)
  if (pair.originalSha256 && pair.originalSha256 !== originalSha256) throw new Error(`${pair.id}: ${pair.original} is not the artifact this contrast was written for (hash ${originalSha256.slice(0, 12)}).`)
  const degradedFiles = applyEdits(original.files, pair.edits)
  const base = join(out, pair.id)
  for (const side of ['original', 'degraded'] as const) {
    const dir = join(base, side)
    mkdirSync(dir, { recursive: true })
    for (const f of ARTIFACT_FILES) if (existsSync(join(source, f))) copyFileSync(join(source, f), join(dir, f))
  }
  writeFileSync(join(base, 'original', 'professor.tsx'), original.files.professor)
  writeFileSync(join(base, 'original', 'student.tsx'), original.files.student)
  writeFileSync(join(base, 'degraded', 'professor.tsx'), degradedFiles.professor)
  writeFileSync(join(base, 'degraded', 'student.tsx'), degradedFiles.student)
  const link: ContrastLink = {
    format: 'studio-quality-contrast-v1',
    id: pair.id,
    kind: pair.kind,
    label: pair.label,
    change: pair.change,
    original: { source: pair.original, dir: join(base, 'original'), artifactSha256: originalSha256 },
    degraded: { dir: join(base, 'degraded'), artifactSha256: artifactHash(original.manifest, degradedFiles, original.sample) },
    targeted: pair.targeted,
    mayAlsoDecline: pair.mayAlsoDecline,
  }
  writeFileSync(join(base, 'contrast.json'), `${JSON.stringify(link, null, 2)}\n`)
  return link
}

export interface ContrastOutcome {
  id: string
  kind: ContrastLink['kind']
  label: string
  passed: boolean
  targeted: { dimension: DimensionKey; original: Level | null; degraded: Level | null; drop: number | null; originalSpread: number; degradedSpread: number; passed: boolean }[]
  collateral: { dimension: DimensionKey; original: Level | null; degraded: Level | null; change: number; expected: boolean }[]
  totals: { original: number | null; degraded: number | null }
  problems: string[]
}

/** Did each targeted dimension drop at least one median level? Never forced: a missing or
 * unjudged side fails the contrast. */
export function scoreContrast(link: ContrastLink, original: QualityResult | null, degraded: QualityResult | null): ContrastOutcome {
  const problems: string[] = []
  if (!original?.evaluation.dimensions) problems.push('the original has no judgement')
  if (!degraded?.evaluation.dimensions) problems.push('the degraded artifact has no judgement')
  if (original && original.build.artifactSha256 !== link.original.artifactSha256) problems.push('the original result is of a different artifact')
  if (degraded && degraded.build.artifactSha256 !== link.degraded.artifactSha256) problems.push('the degraded result is of a different artifact')
  const dim = (r: QualityResult | null, k: DimensionKey) => r?.evaluation.dimensions?.[k] ?? null
  const targeted = link.targeted.map((k) => {
    const o = dim(original, k)?.level ?? null
    const d = dim(degraded, k)?.level ?? null
    const drop = o && d ? rank(o) - rank(d) : null
    return { dimension: k, original: o, degraded: d, drop, originalSpread: dim(original, k)?.spread ?? 0, degradedSpread: dim(degraded, k)?.spread ?? 0, passed: drop !== null && drop >= 1 && problems.length === 0 }
  })
  const collateral = DIMENSION_KEYS.filter((k) => !link.targeted.includes(k)).flatMap((k) => {
    const o = dim(original, k)?.level ?? null
    const d = dim(degraded, k)?.level ?? null
    if (!o || !d || o === d) return []
    return [{ dimension: k, original: o, degraded: d, change: rank(d) - rank(o), expected: link.mayAlsoDecline.includes(k) && rank(d) < rank(o) }]
  })
  return {
    id: link.id,
    kind: link.kind,
    label: link.label,
    passed: problems.length === 0 && targeted.every((t) => t.passed),
    targeted,
    collateral,
    totals: { original: original?.evaluation.dimensions ? totalOf(original) : null, degraded: degraded?.evaluation.dimensions ? totalOf(degraded) : null },
    problems,
  }
}

const totalOf = (r: QualityResult) => totalScore(Object.fromEntries(DIMENSION_KEYS.map((k) => [k, r.evaluation.dimensions![k].level])) as Record<DimensionKey, Level | null>)

// ── Repeatability ──

export interface Repeatability {
  artifacts: number
  runsPerArtifact: number[]
  totalSpread: { artifact: string; totals: number[]; range: number }[]
  /** Over every assessed dimension of every artifact: how far apart its runs were. */
  dimensionAgreement: { judgements: number; allAgree: number; oneApart: number; moreApart: number }
  /** How often one run alone gives the same level as the median of all runs. */
  singleRunVsMedian: { exact: number; withinOne: number; of: number }
  /** How often the median of three runs gives the same level as the median of all runs (artifacts with 5+ runs). */
  medianOf3VsAll: { exact: number; of: number }
  /** Totals: how far one run, and a median of three, land from the all-run median total. */
  totalError: { singleRunMeanAbs: number | null; medianOf3MeanAbs: number | null }
  recommendedPasses: 1 | 3 | 5
  reason: string
}

function combinations<T>(xs: readonly T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (xs.length < k) return []
  const [head, ...tail] = xs
  return [...combinations(tail, k - 1).map((c) => [head, ...c]), ...combinations(tail, k)]
}

const medianTotal = (levels: (Level | null)[][]): number | null => {
  // levels[run][dimensionIndex]
  const med = DIMENSION_KEYS.map((_, d) => medianLevel(levels.map((run) => run[d]).filter((l): l is Level => l !== null)))
  return totalScore(Object.fromEntries(DIMENSION_KEYS.map((k, d) => [k, med[d]])) as Record<DimensionKey, Level | null>)
}

/**
 * The decision rule, written down before the data: one run is enough when it matches the
 * all-run median level at least 90% of the time and is within one level 99% of the time;
 * otherwise three runs are enough when their median matches the all-run median at least
 * 90% of the time; otherwise five.
 */
export function analyseRepeatability(results: readonly QualityResult[]): Repeatability {
  const judged = results.filter((r) => r.evaluation.dimensions && r.evaluation.passesSucceeded >= 2)
  let judgements = 0
  let allAgree = 0
  let oneApart = 0
  let moreApart = 0
  const single = { exact: 0, withinOne: 0, of: 0 }
  const m3 = { exact: 0, of: 0 }
  const singleTotalErrors: number[] = []
  const m3TotalErrors: number[] = []
  const totalSpread: Repeatability['totalSpread'] = []
  for (const r of judged) {
    const dims = r.evaluation.dimensions!
    const runs = r.evaluation.passesSucceeded
    const runLevels: (Level | null)[][] = Array.from({ length: runs }, (_, i) => DIMENSION_KEYS.map((k) => dims[k].passLevels[i] ?? null))
    const allTotal = medianTotal(runLevels)
    for (const k of DIMENSION_KEYS) {
      if (!dims[k].assessed) continue
      const levels = dims[k].passLevels.filter((l): l is Level => l !== null)
      const med = medianLevel(levels)!
      judgements += 1
      const spread = Math.max(...levels.map(rank)) - Math.min(...levels.map(rank))
      if (spread === 0) allAgree += 1
      else if (spread === 1) oneApart += 1
      else moreApart += 1
      for (const l of levels) {
        single.of += 1
        if (l === med) single.exact += 1
        if (Math.abs(rank(l) - rank(med)) <= 1) single.withinOne += 1
      }
      if (levels.length >= 5) {
        for (const trio of combinations(levels, 3)) {
          m3.of += 1
          if (medianLevel(trio) === med) m3.exact += 1
        }
      }
    }
    const totals = r.evaluation.passTotals.filter((t): t is number => t !== null)
    totalSpread.push({ artifact: `${r.case.id}#${r.build.artifactSha256.slice(0, 8)}`, totals, range: totals.length ? round1(Math.max(...totals) - Math.min(...totals)) : 0 })
    if (allTotal !== null) {
      for (const t of totals) singleTotalErrors.push(Math.abs(t - allTotal))
      if (runs >= 5) for (const trio of combinations(runLevels, 3)) {
        const t = medianTotal(trio)
        if (t !== null) m3TotalErrors.push(Math.abs(t - allTotal))
      }
    }
  }
  const pct = (a: number, b: number) => (b ? a / b : 0)
  const meanAbs = (xs: number[]) => (xs.length ? round1(xs.reduce((s, x) => s + x, 0) / xs.length) : null)
  let recommendedPasses: 1 | 3 | 5
  let reason: string
  if (pct(single.exact, single.of) >= 0.9 && pct(single.withinOne, single.of) >= 0.99) {
    recommendedPasses = 1
    reason = `one run matches the all-run median level ${(100 * pct(single.exact, single.of)).toFixed(0)}% of the time and is within one level ${(100 * pct(single.withinOne, single.of)).toFixed(1)}% of the time`
  } else if (m3.of > 0 && pct(m3.exact, m3.of) >= 0.9) {
    recommendedPasses = 3
    reason = `one run matches only ${(100 * pct(single.exact, single.of)).toFixed(0)}% of the time; a median of three matches ${(100 * pct(m3.exact, m3.of)).toFixed(0)}%`
  } else if (m3.of === 0) {
    recommendedPasses = 3
    reason = `one run matches only ${(100 * pct(single.exact, single.of)).toFixed(0)}% of the time; no artifact had five runs, so three is kept unmeasured against more`
  } else {
    recommendedPasses = 5
    reason = `a median of three matches the all-run median only ${(100 * pct(m3.exact, m3.of)).toFixed(0)}% of the time`
  }
  return {
    artifacts: judged.length,
    runsPerArtifact: judged.map((r) => r.evaluation.passesSucceeded),
    totalSpread,
    dimensionAgreement: { judgements, allAgree, oneApart, moreApart },
    singleRunVsMedian: single,
    medianOf3VsAll: m3,
    totalError: { singleRunMeanAbs: meanAbs(singleTotalErrors), medianOf3MeanAbs: meanAbs(m3TotalErrors) },
    recommendedPasses,
    reason,
  }
}

// ── Human calibration ──

export const HUMAN_FORMAT = 'studio-quality-human-scores-v1'

export const humanScoresSchema = z.strictObject({
  format: z.literal(HUMAN_FORMAT),
  rubricVersion: z.literal(RUBRIC_VERSION),
  scorer: z.string(),
  scoredAt: z.string(),
  items: z.record(
    z.string().regex(/^H[0-9]{2}$/),
    z.strictObject({
      dimensions: z.strictObject(Object.fromEntries(DIMENSION_KEYS.map((k) => [k, z.enum(LEVELS).nullable()])) as Record<DimensionKey, z.ZodNullable<z.ZodEnum<{ none: 'none'; weak: 'weak'; acceptable: 'acceptable'; excellent: 'excellent' }>>>),
      notes: z.string(),
    }),
  ),
})
export type HumanScores = z.infer<typeof humanScoresSchema>

/** The sealed key, kept outside the pack: which artifact each anonymous item is. */
export const packKeySchema = z.strictObject({
  format: z.literal('studio-quality-pack-key-v1'),
  items: z.record(z.string().regex(/^H[0-9]{2}$/), z.strictObject({ resultDir: z.string(), artifactSha256: z.string() })),
})
export type PackKey = z.infer<typeof packKeySchema>

export function humanTemplate(ids: string[]): HumanScores {
  return {
    format: HUMAN_FORMAT,
    rubricVersion: RUBRIC_VERSION,
    scorer: '',
    scoredAt: '',
    items: Object.fromEntries(ids.map((id) => [id, { dimensions: Object.fromEntries(DIMENSION_KEYS.map((k) => [k, null])) as Record<DimensionKey, null>, notes: '' }])),
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const SHOT_ORDER = ['professor-desktop-normal', 'professor-phone-normal', 'student-desktop-normal', 'student-phone-normal', 'professor-desktop-empty', 'student-desktop-empty', 'professor-desktop-failing', 'student-desktop-failing', 'professor-desktop-slow', 'student-desktop-slow']

function rubricHtml(): string {
  return DIMENSIONS.map(
    (d) =>
      `<section><h3>${escapeHtml(d.title)} (${d.points} points)</h3><p>${escapeHtml(d.question)}</p><ul>${LEVELS.map((l) => `<li><b>${l}</b> (${Math.round(LEVEL_FRACTION[l] * 100)}%): ${escapeHtml(d.levels[l])}</li>`).join('')}</ul><p><i>Evidence:</i> ${escapeHtml(d.evidence)}</p><p><i>Don’t reward:</i> ${escapeHtml(d.mustNotReward)}</p></section>`,
  ).join('\n')
}

const PAGE_STYLE = '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1200px;margin:24px auto;padding:0 16px;color:#1a1a1a}img{max-width:100%;border:1px solid #ccc;margin:6px 0}pre{background:#f5f5f5;padding:12px;overflow:auto;font-size:12px}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}h1,h2,h3{line-height:1.25}</style>'

/**
 * A blind pack for one person to score. Each item gets only what a professor would see and
 * the code: the request, screenshots and both views' source. No AI level, total, reasoning,
 * evidence, builder plan or summary, and nothing saying which items were degraded on purpose.
 */
export function writeHumanPack(items: { id: string; result: QualityResult; resultDir: string }[], packDir: string, keyPath: string): void {
  mkdirSync(packDir, { recursive: true })
  mkdirSync(dirname(keyPath), { recursive: true })
  // Real paths, so a link inside the pack that points out of it, or a different letter case, can't hide the key in it.
  const keyFromPack = relative(realpathSync.native(packDir), realpathSync.native(dirname(keyPath)))
  if (keyFromPack === '' || (!keyFromPack.startsWith('..') && !isAbsolute(keyFromPack))) throw new Error('The key must live outside the pack, where the scorer won’t open it.')
  const key: PackKey = { format: 'studio-quality-pack-key-v1', items: {} }
  for (const { id, result, resultDir } of items) {
    const dir = join(packDir, id)
    mkdirSync(dir, { recursive: true })
    const evidenceDir = join(resultDir, 'evidence')
    const shots = existsSync(evidenceDir) ? SHOT_ORDER.filter((s) => existsSync(join(evidenceDir, `${s}.jpg`))) : []
    for (const s of shots) copyFileSync(join(evidenceDir, `${s}.jpg`), join(dir, `${s}.jpg`))
    const files = readSourceFor(resultDir)
    writeFileSync(join(dir, 'professor.tsx'), files.professor)
    writeFileSync(join(dir, 'student.tsx'), files.student)
    const label = (s: string) => s.replace(/-/g, ' ')
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>${id}</title>${PAGE_STYLE}<h1>${id}</h1><h2>The professor asked</h2><blockquote>${escapeHtml(result.case.prompt).replace(/\n/g, '<br>')}</blockquote><h2>Screenshots</h2><p>Each view on invented sample data and an invented class. "empty" is with no data, "failing" is when every request fails, "slow" is while loading.</p><div class="shots">${shots.map((s) => `<figure><figcaption>${label(s)}</figcaption><a href="${s}.jpg"><img src="${s}.jpg" alt="${label(s)}"></a></figure>`).join('')}</div><h2>Source</h2><p>If you need to check what a control does: <a href="professor.tsx">professor.tsx</a>, <a href="student.tsx">student.tsx</a>.</p><p><a href="../index.html">All items and the rubric</a></p>`,
    )
    key.items[id] = { resultDir, artifactSha256: result.build.artifactSha256 }
  }
  writeFileSync(
    join(packDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Blind scoring pack</title>${PAGE_STYLE}<h1>Blind scoring pack, ${RUBRIC_VERSION}</h1><p>Score each item on its own. For every dimension pick one level: none, weak, acceptable or excellent. Write your levels into human-scores.json next to this page, under the item's id. Judge the tool a professor and students would get, against what the professor asked for. Studio plugins can't use AI, the network, email or other Scholera data, and students can never read each other's records, so don't mark a tool down for what the platform can't do.</p><ul>${items.map((i) => `<li><a href="${i.id}/index.html">${i.id}</a></li>`).join('')}</ul><h2>Rubric</h2>${rubricHtml()}`,
  )
  writeFileSync(join(packDir, 'human-scores.json'), `${JSON.stringify(humanTemplate(items.map((i) => i.id)), null, 2)}\n`)
  writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`)
}

/** Both views' source for a result folder: an evaluation folder keeps none, so read the artifact it came from. */
function readSourceFor(resultDir: string): { professor: string; student: string } {
  for (const dir of [resultDir, join(resultDir, 'source')]) {
    if (existsSync(join(dir, 'professor.tsx')) && existsSync(join(dir, 'student.tsx'))) {
      return { professor: readFileSync(join(dir, 'professor.tsx'), 'utf8'), student: readFileSync(join(dir, 'student.tsx'), 'utf8') }
    }
  }
  throw new Error(`${resultDir}: no professor.tsx and student.tsx to put in the pack.`)
}

export interface HumanComparison {
  status: 'AWAITING HUMAN CALIBRATION' | 'ACCEPTED' | 'NOT ACCEPTED'
  missing: string[]
  judgements: number
  exact: number
  withinOne: number
  perDimensionBias: Record<DimensionKey, number | null>
  artifacts: { id: string; ai: number | null; human: number | null; difference: number | null }[]
  totalsWithin10: { count: number; of: number }
  /** Pairs a person ranks at least 25 points apart, and whether the AI ranks them the same way. */
  ordering: { pairs: number; preserved: number }
  checks: { name: string; passed: boolean; detail: string }[]
}

/** The AI's median levels against a person's, with the acceptance targets of Step 12A.3. */
export function compareWithHuman(human: HumanScores, key: PackKey, resultsById: Record<string, QualityResult>): HumanComparison {
  const ids = Object.keys(key.items).sort()
  const missing = ids.filter((id) => !human.items[id] || DIMENSION_KEYS.some((k) => human.items[id].dimensions[k] === null))
  const empty: HumanComparison = {
    status: 'AWAITING HUMAN CALIBRATION',
    missing,
    judgements: 0,
    exact: 0,
    withinOne: 0,
    perDimensionBias: Object.fromEntries(DIMENSION_KEYS.map((k) => [k, null])) as Record<DimensionKey, null>,
    artifacts: [],
    totalsWithin10: { count: 0, of: 0 },
    ordering: { pairs: 0, preserved: 0 },
    checks: [],
  }
  if (missing.length) return empty
  let judgements = 0
  let exact = 0
  let withinOne = 0
  const bias: Record<string, number[]> = {}
  const artifacts: HumanComparison['artifacts'] = []
  for (const id of ids) {
    const r = resultsById[id]
    const dims = r?.evaluation.dimensions
    if (!r || !dims) throw new Error(`${id}: no AI judgement to compare with.`)
    if (r.build.artifactSha256 !== key.items[id].artifactSha256) throw new Error(`${id}: the result is not of the artifact in the pack.`)
    const humanLevels = human.items[id].dimensions as Record<DimensionKey, Level>
    for (const d of DIMENSIONS) {
      const ai = dims[d.key].level
      if (!ai) continue
      judgements += 1
      const diff = rank(ai) - rank(humanLevels[d.key])
      if (diff === 0) exact += 1
      if (Math.abs(diff) <= 1) withinOne += 1
      ;(bias[d.key] ??= []).push(diff)
    }
    const aiTotal = totalOf(r)
    const humanTotal = totalScore(humanLevels)
    artifacts.push({ id, ai: aiTotal, human: humanTotal, difference: aiTotal !== null && humanTotal !== null ? round1(aiTotal - humanTotal) : null })
  }
  const perDimensionBias = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, bias[k]?.length ? round1(bias[k].reduce((a, b) => a + b, 0) / bias[k].length) : null])) as Record<DimensionKey, number | null>
  const within10 = artifacts.filter((a) => a.difference !== null && Math.abs(a.difference) <= 10).length
  let pairs = 0
  let preserved = 0
  for (let i = 0; i < artifacts.length; i++) {
    for (let j = i + 1; j < artifacts.length; j++) {
      const [a, b] = [artifacts[i], artifacts[j]]
      if (a.human === null || b.human === null || a.ai === null || b.ai === null || Math.abs(a.human - b.human) < 25) continue
      pairs += 1
      if (Math.sign(a.ai - b.ai) === Math.sign(a.human - b.human)) preserved += 1
    }
  }
  const major: DimensionKey[] = ['problem_understanding', 'workflow_completeness', 'professor_experience', 'student_experience']
  const checks = [
    { name: 'at least 80% of dimension levels within one level', passed: judgements > 0 && withinOne / judgements >= 0.8, detail: `${withinOne} of ${judgements}` },
    { name: 'totals within 10 points for a strong majority (at least 75%) of artifacts', passed: artifacts.length > 0 && within10 / artifacts.length >= 0.75, detail: `${within10} of ${artifacts.length}` },
    { name: 'no systematic bias over one level on a major dimension', passed: major.every((k) => Math.abs(perDimensionBias[k] ?? 0) <= 1), detail: major.map((k) => `${k} ${perDimensionBias[k]}`).join(', ') },
    { name: 'obvious weak/strong ordering preserved', passed: preserved === pairs, detail: `${preserved} of ${pairs} pairs at least 25 points apart` },
  ]
  return {
    status: checks.every((c) => c.passed) ? 'ACCEPTED' : 'NOT ACCEPTED',
    missing: [],
    judgements,
    exact,
    withinOne,
    perDimensionBias,
    artifacts,
    totalsWithin10: { count: within10, of: artifacts.length },
    ordering: { pairs, preserved },
    checks,
  }
}

/** Every result.json under a folder, keyed by its folder. */
export function readResultsUnder(root: string, parse: (raw: unknown) => QualityResult | null): Map<string, QualityResult> {
  const out = new Map<string, QualityResult>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.name === 'result.json') {
        const r = parse(JSON.parse(readFileSync(path, 'utf8')))
        if (r) out.set(dir, r)
      }
    }
  }
  walk(root)
  return out
}

