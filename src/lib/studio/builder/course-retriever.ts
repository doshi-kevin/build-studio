/**
 * The builder's course retriever (Step 9). V1 is Postgres full-text search over the
 * professor's existing extracted material; Pinecone can be a second implementation of the
 * same interface later, with no change to the tool or the prompt.
 *
 * Scope is never an argument the model can reach. A BuilderRetrievalScope is made only from
 * a run row, and the harness calls the retriever only after its gate re-checked that run's
 * professor, section, project and switches this turn (builderActor). The SQL functions
 * filter institution and section again themselves.
 */
import 'server-only'
import { canWriteAsProfessor, verifySectionAccess } from '@/lib/auth/section-access'
import * as db from '../db'
import { STUDIO_COURSE_RESULTS_MAX } from '../limits'
import {
  capSearch,
  focusQuery,
  labelFor,
  resolveFocus,
  toShown,
  type MaterialFocus,
  type MaterialSearch,
  type MaterialSourceEntry,
  type RenderedSearch,
  type ShownExcerpt,
} from './course-material'
import type { GuardSource } from './disclosure'

declare const scopeBrand: unique symbol
/** The run's own institution, section and owner. Only `retrievalScope` makes one. */
export interface BuilderRetrievalScope {
  readonly institutionId: string
  readonly sectionId: string
  readonly ownerId: string
  readonly [scopeBrand]: true
}

/** A scope for a gated run. Null when the run has no section: there is no course to read. */
export function retrievalScope(run: { institutionId: string; sectionId: string | null; ownerId: string }): BuilderRetrievalScope | null {
  if (!run.sectionId) return null
  return { institutionId: run.institutionId, sectionId: run.sectionId, ownerId: run.ownerId } as BuilderRetrievalScope
}

export type SearchOutcome =
  /** `query` is set when the search ran on other words than the model's (the focused modules' titles). */
  | { ok: true; shown: ShownExcerpt[]; keys: string[]; scheduled: string[]; withheld: number; query?: string }
  | { ok: false }

export interface CourseRetriever {
  search(scope: BuilderRetrievalScope, query: string, focus: MaterialFocus | null): Promise<SearchOutcome>
  /** Each search's keys re-read for this turn. Null when the material couldn't be read. */
  rehydrate(scope: BuilderRetrievalScope, searches: readonly MaterialSearch[]): Promise<RenderedSearch[] | null>
}

export const postgresRetriever: CourseRetriever = {
  async search(scope, query, focus) {
    // Names are redacted from every excerpt and label; without the roster, nothing is shown.
    const roster = await db.loadOwnerRosterFullNames(scope.ownerId)
    if (roster === null) return { ok: false }
    // A focus that can't be resolved only loses its boost.
    const weeks = focus ? await db.loadSectionFocus(scope.institutionId, scope.sectionId) : null
    const focusIds = weeks ? resolveFocus(focus, weeks.modules, weeks.startDate, Date.now()) : []
    const found = await db.courseSearch(scope.institutionId, scope.sectionId, query, focusIds, STUDIO_COURSE_RESULTS_MAX)
    if (!found) return { ok: false }
    // "Flashcards for this week" names no topic, so the model's words can miss: the week's own titles name it.
    const fallback = found.rows.length === 0 && weeks ? focusQuery(weeks.modules, focusIds, roster) : ''
    if (fallback && fallback !== query) {
      const again = await db.courseSearch(scope.institutionId, scope.sectionId, fallback, focusIds, STUDIO_COURSE_RESULTS_MAX)
      if (again && again.rows.length > 0) return { ok: true, ...capSearch(again.rows, roster), withheld: again.withheld, query: fallback }
    }
    return { ok: true, ...capSearch(found.rows, roster), withheld: found.withheld }
  },

  async rehydrate(scope, searches) {
    if (searches.length === 0) return []
    const roster = await db.loadOwnerRosterFullNames(scope.ownerId)
    if (roster === null) return null
    const rendered: RenderedSearch[] = []
    for (const s of searches) {
      const rows = await db.courseExcerpts(scope.institutionId, scope.sectionId, s.query, s.keys)
      if (rows === null) return null
      const byKey = new Map(rows.map((r) => [r.unitKey, r]))
      // The search's own rank order; a key that no longer comes back is gone.
      const shown = s.keys.flatMap((k) => (byKey.has(k) ? [toShown(byKey.get(k)!, roster)] : []))
      rendered.push({ query: s.query, focus: s.focus, shown })
    }
    return rendered
  },
}

/**
 * The copy guard's sources: the current text and disclosure class of each provenance entry,
 * read against the section it was built in. Entries from another institution can't exist
 * (the project's own row holds them), and the SQL pins the institution again. A key that no
 * longer resolves is skipped: there is no text left to compare. Null when any read failed.
 */
export async function loadGuardSources(
  institutionId: string,
  entries: readonly MaterialSourceEntry[],
  roster: readonly string[],
  ownerId: string,
): Promise<GuardSource[] | null> {
  if (entries.length === 0) return []
  const bySection = new Map<string, string[]>()
  for (const e of entries) bySection.set(e.s, [...(bySection.get(e.s) ?? []), e.k])
  const out: GuardSource[] = []
  for (const [sectionId, keys] of bySection) {
    // The guard still compares text from a section the owner no longer teaches, so a copy
    // fails closed, but names it generically: that section's titles never reach the model.
    const [rows, access] = await Promise.all([db.courseSources(institutionId, sectionId, [...new Set(keys)]), verifySectionAccess(sectionId, ownerId)])
    if (rows === null) return null
    const teaches = access.ok && canWriteAsProfessor(access.role)
    for (const r of rows) {
      out.push({
        key: r.unitKey,
        label: teaches
          ? labelFor({ ...r, heading: null, excerpt: '', disclosure: r.disclosure === 'withheld' ? 'scheduled' : r.disclosure }, roster)
          : 'course material from a section you no longer teach',
        disclosure: r.disclosure,
        opensAt: r.opensAt,
        text: r.body,
      })
    }
  }
  return out
}
