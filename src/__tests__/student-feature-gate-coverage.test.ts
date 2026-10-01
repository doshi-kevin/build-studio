/**
 * Every student course route for a TOGGLEABLE feature must gate itself.
 *
 * `enabledFeatures` is the professor's release switch. Turning a feature off removed it
 * from the student's nav, but the page still rendered on a direct URL — the nav is not an
 * access control. The page (not the layout) has to call `verifyFeatureEnabled`, because
 * layout and page segments render in PARALLEL: a layout denial does not stop the page
 * executing and streaming its payload. Same class as the roster-PII leak in PR #555.
 *
 * The realistic regression is a NEW route being added under a gated feature without the
 * guard, which no existing test would notice. So this walks the filesystem rather than
 * checking a hardcoded list.
 *
 * Deliberately asymmetric: `basic` features (modules, announcements, grades) are shown to
 * students unconditionally — `studentSidebarFeatures` lists them regardless of
 * `enabledFeatures` — so gating them would 404 students out of core pages. They are
 * asserted to stay UNgated, so a well-meaning "finish the job" change gets caught too.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { COURSE_FEATURES } from '@/lib/course-features'

const STUDENT_COURSE_DIR = join(
  process.cwd(),
  'src',
  'app',
  '(dashboard)',
  'student',
  'courses',
  '[sectionId]',
)

/** Route folder name → feature key. They match 1:1 today. */
const featureByKey = new Map(COURSE_FEATURES.map((f) => [f.key, f]))

function pagesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...pagesUnder(full))
    else if (entry === 'page.tsx') out.push(full)
  }
  return out
}

/** Top-level route folders that correspond to a known feature. */
const routeFolders = readdirSync(STUDENT_COURSE_DIR).filter(
  (e) => statSync(join(STUDENT_COURSE_DIR, e)).isDirectory() && featureByKey.has(e),
)

describe('student course feature gating', () => {
  it('finds the student course routes (guards against a silently empty sweep)', () => {
    expect(routeFolders.length).toBeGreaterThan(5)
  })

  for (const folder of routeFolders) {
    const feature = featureByKey.get(folder)!
    const pages = pagesUnder(join(STUDENT_COURSE_DIR, folder))

    if (feature.category === 'basic') {
      it(`leaves the basic feature "${folder}" ungated`, () => {
        for (const p of pages) {
          expect(
            readFileSync(p, 'utf8').includes('verifyFeatureEnabled'),
            `${p} gates a BASIC feature — students would lose access to a core page`,
          ).toBe(false)
        }
      })
      continue
    }

    it(`gates every page under the toggleable feature "${folder}"`, () => {
      /* Some feature folders hold only server actions — `ai-tutor` is the dock, which has
         no page of its own (its API routes do their own enabledFeatures check). Nothing to
         gate, and nothing to assert beyond that. */
      if (pages.length === 0) return
      for (const p of pages) {
        const src = readFileSync(p, 'utf8')
        /* The adaptive quiz player was deliberately wired out for IP reasons and its
           route is meant to stay unreachable — it is not a live student surface. */
        if (p.includes(join('quizzes', '[quizId]', 'adaptive'))) continue
        /* Matches the call with or without a trailing options argument. The
           options form is how a HISTORY route (a submitted attempt, a returned
           grade) waives the institution ceiling while keeping the professor's
           per-section toggle — see verifyFeatureEnabled. What this test cares
           about is that the section gate is present at all, which both forms
           satisfy; requiring the bare two-argument call would fail a page that
           is in fact gated. */
        const gated = new RegExp(
          `verifyFeatureEnabled\\(sectionId, '${feature.key}'\\s*[,)]`,
        ).test(src)
        expect(
          gated,
          `${p} does not call verifyFeatureEnabled(sectionId, '${feature.key}') — a student can reach it by direct URL with the feature turned off`,
        ).toBe(true)
      }
    })
  }
})
