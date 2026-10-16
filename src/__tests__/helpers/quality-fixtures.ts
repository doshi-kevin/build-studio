/**
 * Fixtures for the generation-quality eval tests: evidence, and judge replies that are
 * valid against it, so each test can break exactly one thing.
 */
import { DIMENSIONS, type DimensionKey, type Level } from '../../../eval/studio-quality/rubric'
import { evidenceCatalog, type Shot } from '../../../eval/studio-quality/evidence'
import type { JudgeInput, JudgeRequest } from '../../../eval/studio-quality/judge'
import type { RenderItem, RenderShot } from '../../../eval/studio-quality/render'

export const PROFESSOR_SRC = Array.from({ length: 40 }, (_, i) => `// professor line ${i + 1}`).join('\n')
export const STUDENT_SRC = Array.from({ length: 20 }, (_, i) => `// student line ${i + 1}`).join('\n')

export const shot = (view: 'professor' | 'student', device: 'desktop' | 'phone', scenario: Shot['scenario'] = 'normal'): Shot => ({
  id: `${view}-${device}-${scenario}`,
  file: `${view}-${device}-${scenario}.jpg`,
  view,
  device,
  width: device === 'desktop' ? 1280 : 390,
  scenario,
  height: 900,
  truncated: false,
  stateShown: scenario === 'normal' ? null : true,
})

export const NORMAL_SHOTS = [shot('professor', 'desktop'), shot('professor', 'phone'), shot('student', 'desktop'), shot('student', 'phone')]

export function judgeInput(mode: JudgeInput['mode'] = 'visual+code'): JudgeInput {
  const shots = mode === 'visual+code' ? NORMAL_SHOTS : []
  const stage2 = [{ checkId: 'runtime.states', status: 'passed', views: { student: 'passed', professor: 'passed' }, findings: [] }]
  return {
    mode,
    request: 'I want to take attendance in my lectures this semester.',
    professorGoal: 'Record each session quickly.',
    studentGoal: 'See their own record.',
    hints: ['sessions or dates'],
    platformCard: 'card',
    manifest: { name: 'Attendance' },
    files: { professor: PROFESSOR_SRC, student: STUDENT_SRC },
    sample: { marks: [] },
    stage2,
    evidence: evidenceCatalog({ files: { professor: PROFESSOR_SRC, student: STUDENT_SRC }, sample: { marks: [] }, shots, stage2 }),
    images: shots.map((s) => ({ id: `shot:${s.id}`, label: s.id, mediaType: 'image/jpeg' as const, bytes: new Uint8Array([1]) })),
  }
}

export function extraction(visual = true) {
  return {
    items: [
      { id: 'e1', role: 'professor', kind: 'action', text: 'Mark a student present', sources: ['views/professor.tsx:12-18'] },
      { id: 'e2', role: 'student', kind: 'data', text: 'Own attendance history', sources: ['views/student.tsx:4'] },
      ...(visual ? [{ id: 'e3', role: 'both', kind: 'layout', text: 'Summary cards above the roster', sources: ['shot:professor-desktop-normal'] }] : []),
    ],
    core: { professor: { present: true, evidence: ['e1'] }, student: { present: true, evidence: ['e2'] } },
  }
}

export function scores(levels: Partial<Record<DimensionKey, Level | null>> = {}, visual = true) {
  return {
    dimensions: Object.fromEntries(
      DIMENSIONS.map((d) => {
        if (d.visualOnly && !visual) return [d.key, { level: null, evidence: [], reasoning: 'No screenshots.' }]
        return [d.key, { level: levels[d.key] ?? 'acceptable', evidence: d.visualOnly ? ['e3'] : ['e1', 'e2'], reasoning: 'Because.' }]
      }),
    ),
    professorAssessment: 'Fine for the professor.',
    studentAssessment: 'Fine for students.',
  }
}

/** A judge reply function: valid evidence, then the given levels for each pass in turn. */
export function validJudge(levelsByPass: Partial<Record<DimensionKey, Level>>[] = [{}], visual = true) {
  let scorePass = 0
  return (request: JudgeRequest) => {
    if (request.stage === 'extract') return extraction(visual)
    const levels = levelsByPass[Math.min(scorePass, levelsByPass.length - 1)]
    scorePass += 1
    return scores(levels, visual)
  }
}

// ── Rendered evidence ──

let y = 0
/** One element read from a rendered screen. */
export function renderItem(kind: RenderItem['kind'], text: string, extra: Partial<RenderItem> = {}): RenderItem {
  y += 10
  return { frame: 'plugin', kind, text, visibility: 'visible', textCut: false, group: null, locator: `plugin:${kind}`, rect: { x: 0, y, w: 100, h: 20 }, ...extra }
}

/** One captured screen's rendered evidence. */
export function renderShot(shot: string, items: RenderItem[], tab: string | null = null): RenderShot {
  const [view, device, scenario] = shot.split('-') as [RenderShot['view'], RenderShot['device'], RenderShot['scenario']]
  return { shot, view, device, scenario, tab, items, truncated: 0 }
}
