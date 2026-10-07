// @vitest-environment node
/**
 * The builder's compiler, typecheck, draft gate and check worker. The worker runs for
 * real: the generated source in a worker thread, as production starts it.
 */
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { assertClassicScript, compileView, CompilerFault } from '@/lib/studio/builder/compile'
import { typecheckViews } from '@/lib/studio/builder/typecheck'
import { runDraftChecks } from '@/lib/studio/builder/checks'
import { runWorkerCheck } from '@/lib/studio/builder/check-worker'
import { CheckTimeout } from '@/lib/studio/builder/check-worker-errors'
import { proposeManifest } from '@/lib/studio/builder/manifest-delta'
import type { SampleData } from '@/lib/studio/builder/work'
import { STUDIO_BUNDLE_MAX_BYTES, STUDIO_PURPOSE_TEXT_MAX_BYTES } from '@/lib/studio/limits'
import { scanCode } from '@/lib/studio/validator/scan'
import type { StudioManifest, StudioManifestV2 } from '@/lib/studio/manifest'
import { FLASHCARDS_MANIFEST, inProcessWorkerCheck, PROFESSOR_VIEW, STUDENT_VIEW } from './helpers/builder-fixtures'

const manifest = (m: unknown = FLASHCARDS_MANIFEST): StudioManifestV2 => {
  const r = proposeManifest(JSON.stringify(m), { slug: 'tool-abc12345', current: null, published: null })
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.manifest
}
const views = { 'views/student.tsx': STUDENT_VIEW, 'views/professor.tsx': PROFESSOR_VIEW }
const gate = (
  files: Record<string, string> = views,
  opts: { roster?: string[] | null; m?: StudioManifestV2 | null; published?: StudioManifest | null; sample?: SampleData } = {},
) =>
  runDraftChecks(
    { manifest: opts.m === undefined ? manifest() : opts.m, files, sample: opts.sample },
    { workerCheck: inProcessWorkerCheck, rosterFullNames: opts.roster === undefined ? ['Maria Lopez'] : opts.roster, published: opts.published ?? null, disclosureSources: [] },
  )

describe('the compiler', () => {
  it('produces the canonical classic-script bundle the runtime runs', () => {
    const r = compileView('views/student.tsx', STUDENT_VIEW)
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
    expect(r.bundle.startsWith("'use strict';\n(function () {\n")).toBe(true)
    expect(r.bundle).toContain('var Button = ScholeraKit.Button;')
    expect(r.bundle).toContain('ScholeraKit.render(ScholeraKit.h(StudentView, null));')
    expect(r.bundle).not.toMatch(/\bimport\b|\bexport\b|require\(/)
    // The validator's own parser sees a plain script with no module syntax.
    const scan = scanCode(r.bundle, Date.now() + 5000)
    expect(scan.ok && scan.findings.filter((f) => f.kind === 'module_syntax' || f.kind === 'jsx')).toEqual([])
  })
  it('binds aliases and keeps type-only imports out of the bundle', () => {
    const r = compileView('views/student.tsx', "import { Button as B, type PluginRecord } from '@scholera/plugin-kit'\ntype R = PluginRecord\nexport default function V() { const r: R | null = null; void r; return <B>Go</B> }\n")
    expect(r.ok && r.bundle).toContain('var B = ScholeraKit.Button;')
    expect(r.ok && r.bundle).not.toContain('PluginRecord')
  })
  it.each([
    ['another package', "import axios from 'axios'\nexport default function V() { return null }"],
    ['a relative file', "import x from './x'\nexport default function V() { return null }"],
    ['a namespace import', "import * as K from '@scholera/plugin-kit'\nexport default function V() { return null }"],
    ['a default import', "import React from 'react'\nexport default function V() { return null }"],
    ['a side-effect import', "import 'react'\nexport default function V() { return null }"],
    ['a name the kit lacks', "import { render } from '@scholera/plugin-kit'\nexport default function V() { return null }"],
    ['a second export', 'export const x = 1\nexport default function V() { return null }'],
    ['a re-export', "export { Button } from '@scholera/plugin-kit'\nexport default function V() { return null }"],
    ['no default export', 'function V() { return null }'],
    ['an anonymous default', 'export default function () { return null }'],
    ['the reserved global', 'export default function V() { return ScholeraKit.render(null) }'],
    ['require', "export default function V() { require('fs'); return null }"],
    ['dynamic import', "export default function V() { void import('x'); return null }"],
    ['a syntax error', 'export default function V( { return null }'],
  ])('refuses %s with a source finding, never a fault', (_name, source) => {
    const r = compileView('views/student.tsx', source)
    expect(r.ok).toBe(false)
  })
  it('refuses a view whose bundle is over the size limit', () => {
    const r = compileView('views/student.tsx', STUDENT_VIEW.replace('export default function', `const BIG = '${'x'.repeat(STUDIO_BUNDLE_MAX_BYTES)}'\nexport default function`))
    expect(!r.ok && r.diagnostics.map((d) => d.code)).toEqual(['builder.size'])
  })
  it.each([
    ['a namespace', 'namespace Helpers { export const n = 1 }\n'],
    ['a declare global block', 'declare global { interface Window { x: number } }\n'],
  ])('refuses %s in an otherwise valid view as builder.export', (_name, block) => {
    const r = compileView('views/student.tsx', STUDENT_VIEW.replace('export default function', `${block}export default function`))
    expect(!r.ok && r.diagnostics.map((d) => [d.code, d.message])).toEqual([['builder.export', 'Namespaces and module declarations are not allowed in a view.']])
  })
  it('the postcondition rejects module syntax as a compiler fault', () => {
    expect(() => assertClassicScript("export const x = 1")).toThrow(CompilerFault)
    expect(() => assertClassicScript("(function(){ require('x') })()")).toThrow(CompilerFault)
    expect(() => assertClassicScript("'use strict';(function(){})()")).not.toThrow()
  })
})

describe('the typecheck', () => {
  it('the golden views typecheck with no diagnostics against the plugin environment alone', () => {
    expect(typecheckViews(views)).toEqual({ diagnostics: [], total: 0 })
  })
  it.each([
    ['window', 'const w = window'],
    ['document', 'const d = document.body'],
    ['fetch', "void fetch('https://example.com')"],
    ['localStorage', "localStorage.setItem('a', 'b')"],
    ['process', 'const e = process.env'],
  ])('%s does not exist', (_name, line) => {
    const r = typecheckViews({ ...views, 'views/student.tsx': STUDENT_VIEW.replace('export default function', `${line}\nexport default function`) })
    expect(r.diagnostics.some((d) => d.message.startsWith('Cannot find name'))).toBe(true)
  })
  it('raw HTML elements and style props fail', () => {
    const r = typecheckViews({ ...views, 'views/student.tsx': STUDENT_VIEW.replace('<Card>', '<div style={{ color: "red" }}>').replace('</Card>', '</div>') })
    expect(r.diagnostics.map((d) => d.code)).toContain('TS2339')
  })
  it('a v2 attendance tool (summary stats, roster, records by student, history table) compiles and typechecks', () => {
    const files = { 'views/professor.tsx': ATTENDANCE_PROFESSOR, 'views/student.tsx': ATTENDANCE_STUDENT }
    expect(typecheckViews(files)).toEqual({ diagnostics: [], total: 0 })
    const r = compileView('views/professor.tsx', ATTENDANCE_PROFESSOR)
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics))
    for (const name of ['RosterTable', 'useRecords', 'useRoster', 'StatCard', 'DataTable', 'today']) expect(r.bundle).toContain(`var ${name} = ScholeraKit.${name};`)
    // Type-only imports bind nothing at run time.
    expect(r.bundle).not.toMatch(/RosterCell|PluginRecord/)
  })
  it('kit v2 props are checked: no style, no className, tones from the set', () => {
    const bad = (jsx: string) => typecheckViews({ 'views/professor.tsx': ATTENDANCE_PROFESSOR, 'views/student.tsx': ATTENDANCE_STUDENT.replace('<Badge tone="success">Present</Badge>', jsx) })
    expect(bad('<Badge tone="success">Present</Badge>').total).toBe(0)
    expect(bad('<Badge tone="green">Present</Badge>').total).toBeGreaterThan(0)
    expect(bad('<Badge className="x">Present</Badge>').total).toBeGreaterThan(0)
    expect(bad('<Card style={{ color: "red" }}>Present</Card>').total).toBeGreaterThan(0)
  })
  it('a lib reference pulls nothing in', () => {
    const r = typecheckViews({ ...views, 'views/student.tsx': `/// <reference lib="dom" />\n/// <reference path="../../node_modules/typescript/lib/lib.dom.d.ts" />\n${STUDENT_VIEW.replace('export default function', 'const w = window\nexport default function')}` })
    expect(r.diagnostics.length).toBeGreaterThan(0)
  })
})

describe('the draft gate', () => {
  const golden = manifest()
  it('passes the golden tool', async () => {
    const r = await gate()
    expect(r.passed).toBe(true)
    expect(r.bundles?.student).toContain('ScholeraKit')
    expect(r.summary.static['data.answer_key']).toBe('passed')
  })
  it('fails without a manifest, running nothing else', async () => {
    const r = await gate(views, { m: null })
    expect(r.passed).toBe(false)
    expect(r.findings[0].check_id).toBe('builder.manifest')
  })
  it.each<[string, StudioManifestV2, StudioManifest | null, string]>([
    ['a capability tools can’t use yet', { ...golden, views: { ...golden.views, professor: { ...golden.views.professor, capabilities: ['course.weakSpots'] } } }, null, 'course.weakSpots isn’t available to tools yet'],
    ['a changed published collection', golden, { ...golden, collections: { ...golden.collections, cards: { access: 'shared', fields: { term: 'text' } } } }, 'published collection cards changed'],
    ['a manifest that no longer parses', { ...golden, version: 'one' }, null, 'version: Must be a version like 1.0.0'],
  ])('re-checks the manifest it is given: %s blocks the gate', async (_name, m, published, detail) => {
    const r = await gate(views, { m, published })
    expect(r.passed).toBe(false)
    expect(r.summary.manifest).toBe('failed')
    expect(r.findings.filter((f) => f.check_id === 'builder.manifest').map((f) => f.detail)).toContain(detail)
  })
  it('a capability its view can’t have blocks the gate', async () => {
    // The manifest schema and the gate's own view loop both refuse it, so the finding may come from either.
    const m: StudioManifestV2 = { ...golden, views: { ...golden.views, student: { ...golden.views.student, capabilities: ['course.roster'] } } }
    const r = await gate(views, { m })
    expect(r.passed).toBe(false)
    expect(r.summary.manifest).toBe('failed')
    expect(r.findings.some((f) => f.check_id === 'builder.manifest' && f.detail?.endsWith('course.roster isn’t available in the student view'))).toBe(true)
  })
  it('a capability the registry doesn’t have blocks the gate instead of throwing', async () => {
    const m = { ...golden, views: { ...golden.views, professor: { ...golden.views.professor, capabilities: ['course.gone'] } } } as unknown as StudioManifestV2
    const r = await gate(views, { m })
    expect(r.passed).toBe(false)
    expect(r.summary.manifest).toBe('failed')
    expect(r.findings.filter((f) => f.check_id === 'builder.manifest').map((f) => f.detail)).toContain('course.gone isn’t available to tools yet')
  })
  it.each([
    ['a red-flag word', 'Students practice terms. Also a casino for the class.', 'red_flag_terms', /casino/i],
    ['an oversized description', 'zymurgy '.repeat(STUDIO_PURPOSE_TEXT_MAX_BYTES / 8 + 1), 'purpose_text_too_long', /zymurgy/i],
  ])('%s blocks the gate by reason code and the words are never quoted', async (_name, description, reason, words) => {
    const r = await gate(views, { m: { ...golden, description } })
    expect(r.passed).toBe(false)
    expect(r.summary.purpose_text).toBe('failed')
    expect(r.findings.filter((f) => f.check_id === 'builder.purpose_text').map((f) => f.detail)).toContain(reason)
    expect(JSON.stringify(r.findings)).not.toMatch(words)
  })
  it('sample data written for an earlier manifest blocks the gate until it matches again', async () => {
    const stale = await gate(views, { sample: { cards: [{ data: { term: 'cell', definition: 'the smallest unit of life', hint: 'biology' } }] } })
    expect(stale.passed).toBe(false)
    expect(stale.findings.find((f) => f.check_id === 'builder.sample')?.file).toBe('sample')
    const fixed = await gate(views, { sample: { cards: [{ data: { term: 'cell', definition: 'the smallest unit of life' } }] } })
    expect(fixed.passed).toBe(true)
  })
  it('finds a student’s full name and never quotes it', async () => {
    const r = await gate({ ...views, 'views/student.tsx': STUDENT_VIEW.replace('No cards yet', 'Welcome, Maria Lopez') })
    expect(r.passed).toBe(false)
    const f = r.findings.find((x) => x.check_id === 'builder.roster')!
    expect(f.file).toBe('views/student.tsx')
    expect(JSON.stringify(r.findings)).not.toMatch(/maria|lopez/i)
  })
  it('fails closed when the roster can’t be read', async () => {
    const r = await gate(views, { roster: null })
    expect(r.passed).toBe(false)
    expect(r.summary.roster).toBe('unavailable')
  })
  it('an answer literal in the student view blocks the gate', async () => {
    const r = await gate({ ...views, 'views/student.tsx': STUDENT_VIEW.replace("{ cardId: card.id, known: true }", "{ cardId: card.id, known: true, answer: 'mitochondria' }") })
    expect(r.passed).toBe(false)
    expect(r.findings.some((f) => f.check_id === 'data.answer_key')).toBe(true)
  })
  it('a Bridge method the manifest doesn’t declare blocks the gate', async () => {
    const r = await gate({ ...views, 'views/student.tsx': STUDENT_VIEW.replace("useRequest<PluginRecord<Flashcard>[]>('records.list'", "useRequest<PluginRecord<Flashcard>[]>('course.skills'") })
    expect(r.findings.some((f) => f.check_id === 'code.bridge_usage')).toBe(true)
  })
  it('findings are bounded and ordered required-first', async () => {
    const r = await gate({ ...views, 'views/student.tsx': 'export default function V( {' })
    expect(r.findings.length).toBeLessThanOrEqual(40)
    expect(r.findings[0].required).toBe(true)
  })
})

describe('the check worker', () => {
  it('runs the committed worker source in a real thread', async () => {
    const r = await runWorkerCheck(views as Record<'views/student.tsx' | 'views/professor.tsx', string>)
    expect(r.compiler).toBe(`studio-tsx-v1+ts${ts.version}`)
    expect(r.compile['views/student.tsx'].ok).toBe(true)
    expect(r.typecheck.total).toBe(0)
  })
  it('is stopped at its time limit, and the next check gets a fresh worker', async () => {
    await expect(runWorkerCheck(views as never, 1)).rejects.toBeInstanceOf(CheckTimeout)
    const r = await runWorkerCheck(views as never)
    expect(r.compile['views/professor.tsx'].ok).toBe(true)
  })
  it('the committed worker source is the current build of its entry', async () => {
    const { bundleCheckWorker, generatedModule } = (await import('../../scripts/studio/build-check-worker.mjs')) as {
      bundleCheckWorker: () => Promise<string>
      generatedModule: (s: string) => string
    }
    const committed = readFileSync('src/lib/studio/builder/check-worker.generated.ts', 'utf8').replace(/\r\n/g, '\n')
    expect(committed).toBe(generatedModule(await bundleCheckWorker()))
  })
})

const ATTENDANCE_PROFESSOR = `import { useMemo, useState } from 'react'
import {
  Screen, Section, Grid, StatCard, RosterTable, DataTable, Badge, Button, Alert, SegmentedControl,
  Loading, Empty, ErrorState, useRecords, useRoster, today, formatDate,
  type PluginRecord, type RosterCell, type Tone,
} from '@scholera/plugin-kit'

type Mark = { day: string; status: string }
const OPTIONS: { value: string; label: string; tone: Tone }[] = [
  { value: 'present', label: 'Present', tone: 'success' },
  { value: 'late', label: 'Late', tone: 'warning' },
  { value: 'absent', label: 'Absent', tone: 'danger' },
]

export default function ProfessorView() {
  const roster = useRoster()
  const marks = useRecords<Mark>('marks')
  const [day] = useState(today())
  const [view, setView] = useState('today')
  const [failed, setFailed] = useState(false)
  const todays = useMemo(() => {
    const m = new Map<string, PluginRecord<Mark>>()
    marks.records.forEach((r) => { if (r.data.day === day && r.student) m.set(r.student, r) })
    return m
  }, [marks.records, day])
  const present = roster.students.filter((s) => todays.get(s)?.data.status === 'present').length

  if (roster.status === 'loading' || marks.status === 'loading') return <Screen title="Attendance"><Loading /></Screen>
  if (roster.status === 'error' || marks.status === 'error') return <Screen title="Attendance"><ErrorState onRetry={() => { roster.retry(); marks.retry() }} /></Screen>
  if (roster.students.length === 0) return <Screen title="Attendance"><Empty title="No students yet" description="Students appear here once they enrol." /></Screen>

  const mark = (student: string, status: string) => {
    const existing = todays.get(student)
    const done = existing ? marks.update(existing, { day, status }) : marks.create({ day, status }, student)
    void done.then((ok) => setFailed(!ok))
  }
  const markAll = () => {
    const changes = roster.students.filter((s) => !todays.has(s)).map((s) => ({ op: 'create' as const, data: { day, status: 'present' }, student: s }))
    void marks.saveMany(changes).then((ok) => setFailed(!ok))
  }
  const cell = (student: string): Record<string, RosterCell> => ({
    status: { kind: 'choice', value: todays.get(student)?.data.status ?? null, options: OPTIONS },
  })
  const days = Array.from(new Set(marks.records.map((r) => r.data.day))).sort().reverse()

  return (
    <Screen title="Attendance" description={formatDate(day, 'long')} width="wide" actions={<Button onPress={markAll}>Mark everyone present</Button>}>
      {failed ? <Alert tone="danger" title="Some marks weren't saved">Try that again.</Alert> : null}
      <Grid columns={3}>
        <StatCard label="Present today" value={present} hint={'of ' + roster.students.length + ' students'} tone="success" />
        <StatCard label="Not marked" value={roster.students.length - todays.size} />
        <StatCard label="Sessions" value={days.length} />
      </Grid>
      <SegmentedControl label="Show" value={view} onChange={setView} options={[{ value: 'today', label: 'Today' }, { value: 'history', label: 'History' }]} />
      {view === 'today' ? (
        <Section title="Today">
          <RosterTable label="Attendance today" students={roster.students} columns={[{ key: 'status', header: 'Status' }]} cells={cell} onAction={(s, _column, value) => mark(s, value)} />
        </Section>
      ) : (
        <Section title="History">
          <DataTable
            label="Sessions"
            columns={[{ key: 'day', header: 'Day' }, { key: 'present', header: 'Present', align: 'end' }, { key: 'rate', header: 'Rate' }]}
            rows={days.map((d) => {
              const n = marks.records.filter((r) => r.data.day === d && r.data.status === 'present').length
              return { key: d, cells: { day: formatDate(d), present: n, rate: <Badge tone={n === roster.students.length ? 'success' : 'neutral'}>{Math.round((n / roster.students.length) * 100) + '%'}</Badge> } }
            })}
            emptyText="No sessions yet."
          />
        </Section>
      )}
    </Screen>
  )
}
`

const ATTENDANCE_STUDENT = `import { Screen, List, ListItem, Badge, Loading, Empty, ErrorState, useRecords, formatDate } from '@scholera/plugin-kit'

type Mark = { day: string; status: string }

export default function StudentView() {
  const marks = useRecords<Mark>('marks')
  if (marks.status === 'loading') return <Screen title="My attendance"><Loading /></Screen>
  if (marks.status === 'error') return <Screen title="My attendance"><ErrorState onRetry={marks.retry} /></Screen>
  if (marks.records.length === 0) return <Screen title="My attendance"><Empty title="Nothing recorded yet" /></Screen>
  return (
    <Screen title="My attendance">
      <List label="Sessions">
        {marks.records.map((r) => (
          <ListItem key={r.id} title={formatDate(r.data.day, 'long')} meta={r.data.status === 'present' ? <Badge tone="success">Present</Badge> : <Badge tone="warning">{r.data.status}</Badge>} />
        ))}
      </List>
    </Screen>
  )
}
`
