// Course-wide skill library — the two flows that connect `course_skills` (the
// course's curated concept list) to `skills` (one section's live, scored list).
//
//   publishSectionSkillsToLibrary : section's tracked skills → UP into the library
//   seedSectionSkillsFromLibrary  : empty section pool      → DOWN from the library
//
// The library is a starting point, never an authority: nothing here is scored,
// and seeding only ever touches a section whose pool is completely empty, so a
// professor's curation can't be overwritten by another section's publish. See
// the migration header (20260807200910_course_skill_library.sql) for why this is
// a copy rather than one shared list.
//
// Server-only (takes an admin client) and best-effort throughout: the library is
// a convenience, so a failure here must never break extraction, recompute, or a
// curate action. Same contract as grade-hook.ts — log and return, never throw.

import 'server-only'
import { logger } from '@/lib/logger'
import { canonicalizeName } from './canonical'

// The admin Supabase client is intentionally loosely typed across the codebase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

interface SectionRef {
  courseId: string
  institutionId: string
}

interface LibraryRow {
  id: string
  parent_id: string | null
  name: string
  info: string | null
  position: number
}

interface SectionSkill {
  id: string
  parent_id: string | null
  name: string
  info: string | null
  position: number
  excluded: boolean
  suppressed: boolean
  library_skill_id: string | null
}

/**
 * The course + tenant a section belongs to, or null when the section is
 * course-less (`course_sections.course_id` is nullable) — in which case there is
 * no library to read or write and every entry point below no-ops.
 */
async function resolveSectionCourse(adminDb: AdminDb, sectionId: string): Promise<SectionRef | null> {
  const { data } = await adminDb
    .from('course_sections')
    .select('course_id, institution_id')
    .eq('id', sectionId)
    .maybeSingle()
  if (!data?.course_id || !data?.institution_id) return null
  return { courseId: data.course_id as string, institutionId: data.institution_id as string }
}

async function readLibrary(adminDb: AdminDb, courseId: string): Promise<LibraryRow[]> {
  const { data } = await adminDb
    .from('course_skills')
    .select('id, parent_id, name, info, position')
    .eq('course_id', courseId)
    .order('position', { ascending: true })
  return (data ?? []) as LibraryRow[]
}

/** Canonical name → library row id, for de-dup against what's already there. */
const indexByCanonical = (rows: LibraryRow[]): Map<string, string> =>
  new Map(rows.map((r) => [canonicalizeName(r.name), r.id]))

/**
 * Copy a section's curated skills into its course's library.
 *
 * "Curated" = TRACKED: not excluded (professor dropped it) and not suppressed
 * (AI guessed it, nobody corroborated it). Those two states are exactly the
 * professor saying "not this", so they must not propagate to next semester.
 *
 * Additive and idempotent — it never deletes a library entry, because another
 * section may still be seeded from it. A section skill that already points at a
 * library entry (`library_skill_id`) updates that entry's name instead of
 * minting a duplicate, which is what makes a rename carry across rather than
 * fork.
 */
export async function publishSectionSkillsToLibrary(
  adminDb: AdminDb,
  sectionId: string,
): Promise<{ published: number }> {
  try {
    const ref = await resolveSectionCourse(adminDb, sectionId)
    if (!ref) return { published: 0 }

    const { data: skillRows } = await adminDb
      .from('skills')
      .select('id, parent_id, name, info, position, excluded, suppressed, library_skill_id')
      .eq('section_id', sectionId)
    const skills = (skillRows ?? []) as SectionSkill[]
    const tracked = skills.filter((s) => !s.excluded && !s.suppressed)
    if (!tracked.length) return { published: 0 }

    // Subtopics only ride along if their main survived the tracked filter —
    // otherwise they would land in the library as orphan mains, which is a
    // different concept hierarchy than the professor curated.
    const trackedIds = new Set(tracked.map((s) => s.id))
    const mains = tracked.filter((s) => s.parent_id === null)
    const subs = tracked.filter((s) => s.parent_id !== null && trackedIds.has(s.parent_id))

    let library = await readLibrary(adminDb, ref.courseId)
    let byCanonical = indexByCanonical(library)
    const libraryIds = new Set(library.map((r) => r.id))
    // section skill id → its library entry id, filled level by level so a
    // subtopic can resolve its parent's library id below.
    const linked = new Map<string, string>()
    let published = 0

    /** Resolve one level (mains, then subs) against the library. */
    const syncLevel = async (rows: SectionSkill[], parentOf: (s: SectionSkill) => string | null) => {
      const toInsert: Array<{ skill: SectionSkill; row: Record<string, unknown> }> = []

      for (const s of rows) {
        // Already linked: keep the library entry's name in step with the rename.
        if (s.library_skill_id && libraryIds.has(s.library_skill_id)) {
          linked.set(s.id, s.library_skill_id)
          const entry = library.find((r) => r.id === s.library_skill_id)
          if (entry && entry.name !== s.name) {
            const { error } = await adminDb
              .from('course_skills')
              .update({ name: s.name, updated_at: new Date().toISOString() })
              .eq('id', s.library_skill_id)
            // A rename that collides with another entry in this course hits the
            // canonical unique index. That is not a failure: the two names mean
            // the same concept, so leaving the existing entry alone is correct.
            if (error) {
              logger.debug('publishSectionSkillsToLibrary: rename skipped', {
                source: 'library.publishSectionSkillsToLibrary',
                sectionId,
                skillId: s.id,
              })
            } else {
              entry.name = s.name
            }
          }
          continue
        }

        // Not linked yet: adopt the matching library entry if one exists, else
        // queue an insert.
        const existing = byCanonical.get(canonicalizeName(s.name))
        if (existing) {
          linked.set(s.id, existing)
          continue
        }
        toInsert.push({
          skill: s,
          row: {
            course_id: ref.courseId,
            institution_id: ref.institutionId,
            parent_id: parentOf(s),
            name: s.name,
            info: s.info,
            position: s.position,
          },
        })
      }

      if (!toInsert.length) return

      const { data: inserted, error } = await adminDb
        .from('course_skills')
        .insert(toInsert.map((t) => t.row))
        .select('id, parent_id, name, info, position')
      if (error) {
        // Most likely the canonical unique index firing because another section
        // of this course published the same concept concurrently. Re-read and
        // link to whatever won — the next publish inserts anything still missing.
        logger.debug('publishSectionSkillsToLibrary: insert fell back to re-read', {
          source: 'library.publishSectionSkillsToLibrary',
          sectionId,
          attempted: toInsert.length,
        })
        library = await readLibrary(adminDb, ref.courseId)
        byCanonical = indexByCanonical(library)
        for (const r of library) libraryIds.add(r.id)
        for (const t of toInsert) {
          const id = byCanonical.get(canonicalizeName(t.skill.name))
          if (id) linked.set(t.skill.id, id)
        }
        return
      }

      const rowsBack = (inserted ?? []) as LibraryRow[]
      for (const r of rowsBack) {
        library.push(r)
        libraryIds.add(r.id)
        byCanonical.set(canonicalizeName(r.name), r.id)
      }
      // Match inserts back to their section skill by canonical name — the insert
      // preserves order, but naming the pairing explicitly keeps it correct if a
      // future PostgREST version stops guaranteeing that.
      for (const t of toInsert) {
        const id = byCanonical.get(canonicalizeName(t.skill.name))
        if (id) {
          linked.set(t.skill.id, id)
          published++
        }
      }
    }

    await syncLevel(mains, () => null)
    await syncLevel(subs, (s) => (s.parent_id ? linked.get(s.parent_id) ?? null : null))

    // Write the provenance link back, one UPDATE per distinct library entry —
    // only for section skills that didn't already carry it.
    const toLink = skills.filter((s) => !s.library_skill_id && linked.has(s.id))
    for (const s of toLink) {
      const { error } = await adminDb
        .from('skills')
        .update({ library_skill_id: linked.get(s.id) })
        .eq('id', s.id)
        .eq('section_id', sectionId)
      if (error) logger.error('publishSectionSkillsToLibrary: link-back failed', error, { sectionId, skillId: s.id })
    }

    return { published }
  } catch (error) {
    logger.error('publishSectionSkillsToLibrary: unexpected', error, { sectionId })
    return { published: 0 }
  }
}

/**
 * Fill an EMPTY section pool from its course's library, so a new offering starts
 * from last semester's curated list instead of a blank page.
 *
 * The emptiness check is the whole safety story: the moment a section has any
 * skill row — AI-extracted, hand-added, even excluded — this is a no-op. That
 * makes it safe to call from reconcile on every run without it ever fighting the
 * professor or resurrecting something they deleted.
 *
 * Seeded rows are `source: 'professor'` (they ARE professor-curated, just from a
 * prior section) and tracked from birth: the concepts already survived curation
 * once, so re-suppressing them would ask the professor to confirm the same list
 * twice. `library_skill_id` records where each came from.
 */
export async function seedSectionSkillsFromLibrary(
  adminDb: AdminDb,
  sectionId: string,
): Promise<{ seeded: number }> {
  try {
    const ref = await resolveSectionCourse(adminDb, sectionId)
    if (!ref) return { seeded: 0 }

    // head+count: existence only — never pull the pool just to test it.
    const { count } = await adminDb
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .eq('section_id', sectionId)
    if ((count ?? 0) > 0) return { seeded: 0 }

    const library = await readLibrary(adminDb, ref.courseId)
    if (!library.length) return { seeded: 0 }

    const base = (r: LibraryRow) => ({
      section_id: sectionId,
      institution_id: ref.institutionId,
      name: r.name,
      info: r.info,
      source: 'professor',
      excluded: false,
      suppressed: false,
      position: r.position,
      library_skill_id: r.id,
    })

    // Mains first, so subtopics have a parent id to point at.
    const mains = library.filter((r) => r.parent_id === null)
    const { data: insertedMains, error: mainErr } = await adminDb
      .from('skills')
      .insert(mains.map((r) => ({ ...base(r), parent_id: null })))
      .select('id, library_skill_id')
    if (mainErr) {
      logger.error('seedSectionSkillsFromLibrary: main insert failed', mainErr, { sectionId })
      return { seeded: 0 }
    }
    const sectionIdByLibraryId = new Map(
      ((insertedMains ?? []) as Array<{ id: string; library_skill_id: string }>).map((r) => [r.library_skill_id, r.id]),
    )
    let seeded = sectionIdByLibraryId.size

    const subs = library.filter((r) => r.parent_id && sectionIdByLibraryId.has(r.parent_id))
    if (subs.length) {
      const { data: insertedSubs, error: subErr } = await adminDb
        .from('skills')
        .insert(subs.map((r) => ({ ...base(r), parent_id: sectionIdByLibraryId.get(r.parent_id!) })))
        .select('id')
      if (subErr) logger.error('seedSectionSkillsFromLibrary: subtopic insert failed', subErr, { sectionId })
      else seeded += ((insertedSubs ?? []) as unknown[]).length
    }

    logger.info('Seeded section skills from course library', {
      source: 'library.seedSectionSkillsFromLibrary',
      sectionId,
      courseId: ref.courseId,
      seeded,
    })
    return { seeded }
  } catch (error) {
    logger.error('seedSectionSkillsFromLibrary: unexpected', error, { sectionId })
    return { seeded: 0 }
  }
}
