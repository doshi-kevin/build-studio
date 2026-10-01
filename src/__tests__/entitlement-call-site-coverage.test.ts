/**
 * Entitlement drift tripwire (pattern: ai-call-site-coverage.test.ts).
 *
 * The entitlement gate deliberately does NOT sit on all ~112 write actions
 * across quizzes, assignments and live classroom. It sits on two thin rings,
 * and the other ~90 are covered by construction: every one of them takes the id
 * of a row only a ring-1 action can create. See §4.6 of
 * docs/designs/entitlements/feature-entitlements.md.
 *
 * That argument is only true while the ring lists are complete. This test is
 * what keeps them complete:
 *
 *   1. Every function named below still contains an entitlement check.
 *   2. No NEW root-creating action appeared without being added here.
 *
 * If (2) fails on a new function, decide which ring it belongs to, gate it, and
 * only then add it. Never add an ungated function to the list.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { ENTITLED_FEATURE_KEYS } from '@/lib/entitlements/entitled-features'

const SRC = join(__dirname, '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

/**
 * Ring 1 (root creation) and ring 2 (student participation), as file path to
 * the exported function names that must carry a check.
 */
const GATED: Record<string, string[]> = {
  // Studio: one access function every Studio path goes through (builder, publication,
  // plugin runtime, bridge writes). Losing the entitlement makes Studio read-only there.
  'lib/studio/access.ts': ['studioAccess'],
  // Ring 1 — professor creates the top-level object.
  'app/(dashboard)/professor/courses/[sectionId]/quizzes/actions.ts': [
    'createQuiz',
    'createQuizFull',
    'duplicateQuiz',
    'getOrCreateEmptyDraft', // writes despite the `get` prefix
    'createQuestion', // section-scoped, needs no quiz, so it is a root create
  ],
  'app/(dashboard)/professor/courses/[sectionId]/assignments/actions.ts': [
    'createAssignment',
    'createNotebookAssignment',
    'cloneStudioAssignment',
    'createDocumentAssignment',
    'createFileUploadAssignment',
    'createVerbalAssessment',
  ],
  'app/(dashboard)/professor/courses/[sectionId]/live-classroom/actions.ts': [
    'createRoomDraft',
    'scheduleLiveClass',
  ],
  'app/(dashboard)/professor/courses/[sectionId]/projects/actions.ts': ['createProject'],
  'app/(dashboard)/professor/courses/[sectionId]/discussions/actions.ts': ['createCourseChannel'],
  'app/(dashboard)/professor/courses/[sectionId]/challenges/actions.ts': [
    'createChallenge',
    'createBadge', // section-scoped, needs no challenge
    'createCertificate', // section-scoped, needs no challenge
  ],
  // Ring 2 — student produces new evidence. On the START of work, not the
  // submit, so a revocation boundary never destroys an in-flight attempt.
  'app/(dashboard)/student/courses/[sectionId]/quizzes/actions.ts': [
    'startAttempt',
    'startAdaptiveAttempt',
  ],
  'app/(dashboard)/student/courses/[sectionId]/assignments/actions.ts': ['submitAssignment'],
  'app/(dashboard)/student/courses/[sectionId]/assignments/assessment-actions.ts': [
    'startAssessment',
  ],
  /* Not a root create and not student participation — a THIRD shape the ring
     model missed. Publishing a feature to students promises something the
     student gates would then subtract, so the professor sees "released" and no
     student ever receives it. Found by the customer rehearsal. */
  'app/(dashboard)/professor/courses/[sectionId]/actions.ts': ['toggleCourseFeature'],
  'lib/live-classroom/attendance/actions.ts': ['markAttendance'],
  'lib/live-classroom/interactions/actions.ts': ['submitResponse'],
}

/**
 * Deliberately ungated writes, each with the reason. A reader who wonders why
 * something is missing from GATED should find it here rather than assume an
 * oversight.
 */
const DELIBERATELY_UNGATED: Record<string, string> = {
  createMasterPhase:
    'takes a projectId, so it is covered by construction: createProject is gated and no project means no phase',
  createDeckUploadUrl:
    'takes a roomId, so it is covered by construction: createRoomDraft and scheduleLiveClass are gated and no room means no deck',
  askQuestion:
    'a question is engagement, not scored evidence, and silencing a student during a class that is visibly running buys no correctness',
}

/** Returns the source of one exported function, up to the next top-level export. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`)
  if (start === -1) return ''
  const next = source.indexOf('\nexport ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

/**
 * The feature ENTRY pages. A revoked feature must dead-end here rather than
 * render a working page whose Create button fails on click, per
 * `.claude/rules/dead-ends.md`. Found by browser QA, which is exactly the class
 * of gap a unit test does not catch on its own.
 */
const GUARDED_PAGES: string[] = [
  'app/(dashboard)/professor/courses/[sectionId]/quizzes/page.tsx',
  'app/(dashboard)/professor/courses/[sectionId]/assignments/page.tsx',
  'app/(dashboard)/professor/courses/[sectionId]/live-classroom/page.tsx',
  'app/(dashboard)/professor/courses/[sectionId]/projects/page.tsx',
  'app/(dashboard)/professor/courses/[sectionId]/discussions/page.tsx',
  'app/(dashboard)/professor/courses/[sectionId]/challenges/page.tsx',
  // Athena's own course page. It is the one entry page whose gate must also be
  // ORDERED: the entitlement check runs BEFORE the AI kill switch, because not
  // owning the product is permanent and commercial, while the kill switch is a
  // temporary safety state that still earns the friendly disabled panel.
  'app/(dashboard)/professor/courses/[sectionId]/assistant/page.tsx',
  'app/(dashboard)/professor/courses/[sectionId]/studio/page.tsx',
]

/**
 * Athena's API entry points, alongside the course page listed above. This list
 * is NOT hand-maintained any more — an earlier version asserted "both its
 * entry points" and named two. There were five, and the one it missed
 * (/api/assignment-assistant) is the Athena surface professors actually click,
 * so a revoked school got a 403 from one route and a 200 from another seconds
 * apart. The test encoded my wrong assumption and therefore could not catch it.
 *
 * Discovered instead, from the rule that actually holds: a route that gates on
 * an athena-* AI feature is an Athena entry point, and must also check the
 * athena entitlement. A sixth one added tomorrow is caught without an edit here.
 */
function findAthenaRoutes(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(SRC, dir))) {
      const rel = `${dir}/${entry}`
      if (statSync(join(SRC, rel)).isDirectory()) walk(rel)
      else if (entry === 'route.ts' && /'athena-(student|professor)'/.test(read(rel))) found.push(rel)
    }
  }
  walk('app/api')
  return found
}

describe('entitlement gate coverage', () => {
  it('EVERY product in the registry is actually enforced somewhere', () => {
    // The first build shipped a registry of seven with only three enforced, so
    // revoking one of the other four hid it from the nav and stopped nothing.
    // This is the assertion that makes that state impossible to reach again.
    //
    // The key must appear as an ARGUMENT to a guard call, on the same line.
    // Matching the key and the word "entitlement" anywhere in the same FILE is
    // not enough, and was not merely loose but already vacuous: four of the
    // seven products are also Postgres table names, so `.from('quizzes')` in a
    // file that gates something else supplied both halves. Concretely,
    // projects/actions.ts holds `itemType === 'assignment' ? 'assignments' :
    // 'quizzes'` alongside its own `checkEntitlementBySection(…, 'projects')`,
    // which marked BOTH quizzes and assignments enforced on its own. Every
    // entitlement check for those two could be deleted repo-wide and the
    // file-level version of this test still passed.
    const GUARD = /checkEntitlementBySection|checkEntitlement|verifyEntitled/
    const sources = [...Object.keys(GATED), ...GUARDED_PAGES, ...findAthenaRoutes()].map(read)
    const gatesKey = (src: string, key: string) =>
      src.split('\n').some((line) => GUARD.test(line) && line.includes(`'${key}'`))
    const unenforced = ENTITLED_FEATURE_KEYS.filter(
      (key) => !sources.some((src) => gatesKey(src, key)),
    )
    expect(unenforced).toEqual([])
  })

  it('each feature entry page dead-ends when the school has not bought it', () => {
    // Match the CALL, not the mention. `includes('verifyEntitled')` was
    // satisfied by the import line alone, so deleting the guard from a page
    // and leaving the dangling import kept this green — verified by mutation.
    const missing = GUARDED_PAGES.filter((f) => !read(f).includes('verifyEntitled('))
    expect(missing).toEqual([])
  })

  it('EVERY Athena entry route checks entitlement as well as the kill switch', () => {
    // Two different questions: "is AI safe to run" and "did this school buy
    // Athena". Both must be asked, and never through one shared call.
    const routes = findAthenaRoutes()
    // If this drops to nothing the discovery broke and the test is asserting air.
    expect(routes.length).toBeGreaterThanOrEqual(5)
    const ungated = routes.filter((r) => !read(r).includes('checkEntitlement'))
    expect(ungated).toEqual([])
  })

  it('BOTH course sidebars filter on entitlement, not just the professor one', () => {
    // The student sidebar was missed on the first pass and browser QA caught it:
    // a nav entry for a feature the school does not have looks available and
    // dead-ends on click. Both layouts must resolve entitlements.
    const missing = [
      'app/(dashboard)/professor/courses/[sectionId]/layout.tsx',
      'app/(dashboard)/student/courses/[sectionId]/layout.tsx',
    ].filter((f) => !read(f).includes('resolveAllEntitlementsBySection'))
    expect(missing).toEqual([])
  })

  it('the student page gate carries the institution ceiling', () => {
    // One edit here covers the 16 student pages that already call it, which is
    // why it must not be removed in favour of per-page checks.
    const gate = read('lib/validations/features.ts')
    expect(gate).toContain('verifyEntitled')
    expect(gate).toContain('isEntitledFeatureKey')
  })

  it('every ring-1 and ring-2 action still carries a check', () => {
    const missing: string[] = []
    for (const [file, fns] of Object.entries(GATED)) {
      const source = read(file)
      for (const fn of fns) {
        const body = functionBody(source, fn)
        if (!body) {
          missing.push(`${file}: ${fn} not found (renamed or removed?)`)
          continue
        }
        if (!body.includes('checkEntitlement')) {
          missing.push(`${file}: ${fn} has no entitlement check`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('no new root-creating action appeared without a gate', () => {
    // A `create*` export in one of the three product action files is almost
    // always a new root object. Catching it here is the point: the
    // covered-by-construction argument in §4.6 collapses the moment a new
    // creator lands ungated.
    //
    // `create` alone is too narrow a net, and GATED itself is the proof: four of
    // its ring-1 entries — duplicateQuiz, getOrCreateEmptyDraft,
    // cloneStudioAssignment, scheduleLiveClass — make a root object under a
    // different verb, so a NEW sibling of any of them would land ungated and
    // this test would say nothing. Those four verbs are in the net now. The
    // remaining write verbs in these files (publish*, generate*, start*, add*)
    // are deliberately left out: every one of them today takes the id of a row a
    // gated action had to create, so netting them would only grow
    // DELIBERATELY_UNGATED without catching anything.
    const ROOT_VERBS = /export async function ((?:create|duplicate|clone|getOrCreate|schedule)[A-Z]\w*)\(/g
    const ungated: string[] = []
    for (const [file, fns] of Object.entries(GATED)) {
      if (!file.includes('/professor/')) continue
      const source = read(file)
      const creators = [...source.matchAll(ROOT_VERBS)].map((m) => m[1])
      for (const fn of creators) {
        if (fns.includes(fn)) continue
        if (fn in DELIBERATELY_UNGATED) continue
        if (functionBody(source, fn).includes('checkEntitlement')) continue
        ungated.push(`${file}: ${fn}`)
      }
    }
    expect(ungated).toEqual([])
  })

  it('the gate is never applied to a read', () => {
    // An entitlement check on a read would break §4.5: a school that loses a
    // feature keeps its history, visible and read-only. Reads named get* must
    // stay clean, with getOrCreateEmptyDraft the documented exception.
    const leaks: string[] = []
    for (const file of Object.keys(GATED)) {
      const source = read(file)
      const getters = [...source.matchAll(/export async function (get[A-Z]\w*)\(/g)].map(
        (m) => m[1],
      )
      for (const fn of getters) {
        if (fn === 'getOrCreateEmptyDraft') continue // writes, gated on purpose
        if (functionBody(source, fn).includes('checkEntitlement')) leaks.push(`${file}: ${fn}`)
      }
    }
    expect(leaks).toEqual([])
  })
})
