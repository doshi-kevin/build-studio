/**
 * Coverage signals — the DB reads behind the node coverage lifecycle
 * (docs/designs/roadmap-mastery/roadmap-engine.md §13, Part II slice 1).
 *
 * Follows the queries.ts convention: takes a SupabaseClient as its first
 * param, catches its own errors, and returns a safe empty shape on failure —
 * a missing signal must degrade the percentages, never break the page. It also
 * reports WHEN it degraded (`degraded`), because a failed or truncated read
 * derives as "nothing delivered, 0% covered", which is indistinguishable from a
 * quiet course unless the surface is told.
 *
 * Callers must pass an **admin** client, and only after verifying section
 * ownership (professor) or enrolment (student). The quiz tables are
 * RLS-deny-all by design, so a section-scoped client reads zero rows here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'
import type {
  AssignmentActivity,
  CoverageSignals,
  DeckPresentation,
  ModuleRooms,
  QuizActivity,
} from './coverage'

/* `degraded: true` on the empty shape: reaching it means the reads THREW, and an
   all-zero signal set derives as "nothing delivered, 0% covered". Without the
   flag that failure is indistinguishable from a course where genuinely nothing
   has happened yet, and the page states the wrong number confidently. */
const EMPTY: CoverageSignals = {
  enrolledCount: 0,
  skippedModules: [],
  decksByItem: {},
  roomsByModule: {},
  quizzes: {},
  assignments: {},
  degraded: true,
}

/** Row caps on the bounded reads below. Named because hitting one exactly is how
 *  we detect truncation — a course at the limit is reporting partial numbers. */
const LIMITS = {
  modules: 500,
  items: 5000,
  rooms: 1000,
  quizzes: 500,
  assignments: 500,
  decks: 5000,
} as const

type RoomRow = { id: string; status: string | null; module_item_id: string | null }
type DeckRow = {
  room_id: string
  module_item_id: string | null
  max_slide: number | null
  page_count: number | null
}
type CountRow = {
  kind: string
  activity_id: string
  started_students: number
  finished_students: number
}

/** Normalise a room's lifecycle word; anything unknown is treated as not-yet-run. */
function roomStatusOf(raw: string | null): DeckPresentation['roomStatus'] {
  return raw === 'ended' || raw === 'live' ? raw : 'scheduled'
}

/** Read everything the coverage derivation needs beyond AutoRoadmapData. */
export async function getCoverageSignals(
  db: SupabaseClient,
  sectionId: string,
): Promise<CoverageSignals> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any

    /* Every read here is best-effort by design, but a swallowed failure or a
       truncated page turns into a LOWER percentage rather than an error — so
       record both and hand the caller a `degraded` flag it can surface. */
    let degraded = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const check = (res: any, what: string, limit?: number): void => {
      if (res?.error) {
        degraded = true
        logger.error(`getCoverageSignals: ${what} read failed`, res.error, { sectionId })
        return
      }
      if (limit != null && Array.isArray(res?.data) && res.data.length >= limit) {
        degraded = true
        logger.warn(`getCoverageSignals: ${what} hit its row cap — coverage is partial`, {
          sectionId, what, limit,
        })
      }
    }

    // Modules first: their ids scope the item lookup below, and their
    // coverage_state is the skip flag.
    /* Every read on this path is ordered + bounded. Unordered selects stop at
       PostgREST's 1000 rows without saying so, and these feed per-module
       coverage — a dropped item silently reads as "not covered". */
    const modulesRes = await anyDb
      .from('modules')
      .select('id, coverage_state')
      .eq('section_id', sectionId)
      .order('position', { ascending: true })
      .limit(LIMITS.modules)
    check(modulesRes, 'modules', LIMITS.modules)
    const modules = (modulesRes.data ?? []) as { id: string; coverage_state: string | null }[]
    const moduleIds = modules.map((m) => m.id)

    const [itemsRes, enrolledRes, roomsRes, quizRes, assignmentRes, countsRes] =
      await Promise.all([
        moduleIds.length
          ? anyDb.from('module_items').select('id, module_id').in('module_id', moduleIds).order('id', { ascending: true }).limit(LIMITS.items)
          : Promise.resolve({ data: [] }),
        anyDb
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .eq('section_id', sectionId)
          .in('status', ON_ROSTER_STATUSES),
        anyDb.from('lc_rooms').select('id, status, module_item_id').eq('section_id', sectionId).order('created_at', { ascending: false }).limit(LIMITS.rooms),
        anyDb.from('quizzes').select('id, status, due_date').eq('section_id', sectionId).order('created_at', { ascending: true }).limit(LIMITS.quizzes),
        anyDb.from('assignments').select('id, status').eq('section_id', sectionId).order('created_at', { ascending: true }).limit(LIMITS.assignments),
        // Distinct-student counts, aggregated in Postgres (see the migration).
        anyDb.rpc('roadmap_assessment_counts', { p_section_id: sectionId }),
      ])

    check(itemsRes, 'moduleItems', LIMITS.items)
    check(enrolledRes, 'enrollments')
    check(roomsRes, 'rooms', LIMITS.rooms)
    check(quizRes, 'quizzes', LIMITS.quizzes)
    check(assignmentRes, 'assignments', LIMITS.assignments)
    check(countsRes, 'assessmentCounts')

    const itemModule = new Map(
      ((itemsRes.data ?? []) as { id: string; module_id: string }[]).map((i) => [i.id, i.module_id]),
    )
    const rooms = (roomsRes.data ?? []) as RoomRow[]
    const roomStatusById = new Map(rooms.map((r) => [r.id, roomStatusOf(r.status)]))

    // Decks are only reachable through their room, so this second round trip
    // waits on the rooms query above.
    const roomIds = rooms.map((r) => r.id)
    let decks: DeckRow[] = []
    if (roomIds.length) {
      const decksRes = await anyDb
        .from('lc_decks')
        .select('room_id, module_item_id, max_slide, page_count')
        .in('room_id', roomIds)
        .order('room_id', { ascending: true })
        .limit(LIMITS.decks)
      check(decksRes, 'decks', LIMITS.decks)
      decks = (decksRes.data ?? []) as DeckRow[]
    }

    // module_items.id → every presentation of it, across all rooms.
    const decksByItem: Record<string, DeckPresentation[]> = {}
    for (const d of decks) {
      if (!d.module_item_id) continue
      ;(decksByItem[d.module_item_id] ??= []).push({
        maxSlide: d.max_slide ?? 0,
        pageCount: d.page_count,
        roomStatus: roomStatusById.get(d.room_id) ?? 'scheduled',
      })
    }

    // A room covers a module if the room is pinned to one of its items, or if
    // it presented a deck sourced from one — a class that showed this week's
    // deck taught this week, however the room was linked.
    const roomsByModule: Record<string, ModuleRooms> = {}
    const markModule = (moduleId: string, status: DeckPresentation['roomStatus']) => {
      const cur = (roomsByModule[moduleId] ??= { hasEndedClass: false })
      if (status === 'ended') cur.hasEndedClass = true
    }
    for (const r of rooms) {
      const status = roomStatusOf(r.status)
      if (status === 'scheduled') continue
      const viaRoom = r.module_item_id ? itemModule.get(r.module_item_id) : undefined
      if (viaRoom) markModule(viaRoom, status)
    }
    for (const d of decks) {
      if (!d.module_item_id) continue
      const status = roomStatusById.get(d.room_id) ?? 'scheduled'
      if (status === 'scheduled') continue
      const moduleId = itemModule.get(d.module_item_id)
      if (moduleId) markModule(moduleId, status)
    }

    const started = new Map<string, number>()
    const finished = new Map<string, number>()
    for (const c of (countsRes.data ?? []) as CountRow[]) {
      started.set(c.activity_id, c.started_students)
      finished.set(c.activity_id, c.finished_students)
    }

    const quizzes: Record<string, QuizActivity> = {}
    for (const q of (quizRes.data ?? []) as { id: string; status: string | null; due_date: string | null }[]) {
      quizzes[q.id] = {
        status: q.status,
        dueDate: q.due_date,
        attemptCount: started.get(q.id) ?? 0,
        submittedCount: finished.get(q.id) ?? 0,
      }
    }

    const assignments: Record<string, AssignmentActivity> = {}
    for (const a of (assignmentRes.data ?? []) as { id: string; status: string | null }[]) {
      assignments[a.id] = {
        status: a.status,
        submissionCount: started.get(a.id) ?? 0,
        gradedCount: finished.get(a.id) ?? 0,
      }
    }

    return {
      enrolledCount: enrolledRes.count ?? 0,
      skippedModules: modules.filter((m) => m.coverage_state === 'skipped').map((m) => m.id),
      decksByItem,
      roomsByModule,
      quizzes,
      assignments,
      degraded: degraded || undefined,
    }
  } catch (error) {
    logger.error('getCoverageSignals', error, { sectionId })
    return EMPTY
  }
}
