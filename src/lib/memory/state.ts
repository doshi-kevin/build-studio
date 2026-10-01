/**
 * The memory layer's read path, and the only entry point anything should use.
 *
 * Returns STRUCTURED DATA and nothing else. No prose, no budget, no XML, and no
 * knowledge of who is asking. A notification sweep branches on these fields, a
 * dashboard renders them, and Athena's own renderer
 * (lib/ai/student-tutor/memory-block.ts) turns them into prompt lines. Baking
 * the prompt shape in here would have forced the sweep to regex prose to decide
 * whether to send an email.
 *
 * Two entry points, one implementation. `getUserState` is one user;
 * `getUserStateBatch` is N users at a fixed set of queries per hundred, because
 * the nudge sweep runs over a whole roster and a per-user loop would be N times
 * the queries. Per hundred rather than flat because the id list travels in the
 * URL and the gateway rejects one that is too long; see USER_ID_CHUNK.
 * Batch callers should still narrow first on something cheap (the re-engagement
 * sweep filters on `profiles.last_login_at`) and only ask memory about the
 * users they have already decided to act on.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import {
  deriveRecentClass,
  deriveUpcoming,
  deriveWeakSkills,
  type DueItem,
  type RecentClass,
  type WeakSkill,
} from './derivers'
import { readPreferences, type StoredPreference } from './preferences'
import { slotsForSurface } from '@/lib/validations/memory'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export interface UserState {
  preferences: StoredPreference[]
  weakSkills: WeakSkill[]
  dueSoon: DueItem[]
  lastClass: RecentClass | null
}

export interface UserStateScope {
  userId: string
  institutionId: string
  sectionId: string
}

const EMPTY: UserState = { preferences: [], weakSkills: [], dueSoon: [], lastClass: null }

/** How many user ids one round of queries may carry.
 *
 *  Set from where the gateway actually breaks, not from a round number: 400
 *  uuids produced a 15,963-character URL and a 414, and the limit is about 8
 *  kilobytes of request line. A hundred uuids is roughly 3,800 characters,
 *  which leaves room for the rest of the query string. */
const USER_ID_CHUNK = 100

/** True when there is nothing worth telling anyone. The common case today: only
 *  a handful of students have any mastery row at all, so every consumer must
 *  handle it as the normal path rather than an edge case. */
export function isEmptyState(state: UserState): boolean {
  return (
    state.preferences.length === 0 &&
    state.weakSkills.length === 0 &&
    state.dueSoon.length === 0 &&
    state.lastClass === null
  )
}

/** Everything memory knows about one user in one course. */
export async function getUserState(db: AdminDb, scope: UserStateScope): Promise<UserState> {
  const byUser = await getUserStateBatch(db, {
    userIds: [scope.userId],
    institutionId: scope.institutionId,
    sectionId: scope.sectionId,
  })
  return byUser.get(scope.userId) ?? { ...EMPTY }
}

/**
 * The same facts for many users at once. Every deriver takes the whole id list
 * and issues a fixed number of queries, so this costs the same for 500 students
 * as for one.
 */
export async function getUserStateBatch(
  db: AdminDb,
  { userIds, institutionId, sectionId }: { userIds: string[]; institutionId: string; sectionId: string },
): Promise<Map<string, UserState>> {
  const unique = [...new Set(userIds)]
  const out = new Map<string, UserState>(unique.map((id) => [id, { ...EMPTY }]))
  if (unique.length === 0) return out

  /* Every query below sends its id list in the URL, and the gateway rejects a
     URL past about 8 kilobytes. Measured on a 400-student section: the reads of
     user_memory, skill_mastery and lc_attendance all came back 414 URI Too
     Long, every deriver caught its own error and returned empty, and the batch
     succeeded with nothing in it. The nudge sweep, which is the only caller
     that passes a whole roster, therefore saw no preferences, no weak skills
     and no attendance for anybody — silently.

     Splitting the list here rather than inside each deriver keeps the chat path
     byte-for-byte unchanged (one user is one chunk) and leaves every deriver's
     logic alone. The cost is no longer one fixed set of queries: it is one set
     per chunk, which for a 400-student roster is four. */
  if (unique.length > USER_ID_CHUNK) {
    const chunks: string[][] = []
    for (let i = 0; i < unique.length; i += USER_ID_CHUNK) {
      chunks.push(unique.slice(i, i + USER_ID_CHUNK))
    }
    const parts = await Promise.all(
      chunks.map((userIds) => getUserStateBatch(db, { userIds, institutionId, sectionId })),
    )
    for (const part of parts) for (const [userId, state] of part) out.set(userId, state)
    return out
  }

  const args = { userIds: unique, sectionId }
  const [preferences, weakSkills, dueSoon, lastClass, enrolled] = await Promise.all([
    // Student slots only, so a teaching assistant's professor rows never reach
    // the tutor prompt.
    readPreferences(db, { ...args, institutionId, slots: slotsForSurface('student') }),
    deriveWeakSkills(db, args),
    deriveUpcoming(db, args),
    deriveRecentClass(db, args),
    currentlyEnrolled(db, sectionId, unique),
  ])

  for (const userId of unique) {
    out.set(userId, {
      preferences: preferences.get(userId) ?? [],
      weakSkills: weakSkills.get(userId) ?? [],
      /* What is due is the one thing here that is a fact about the SECTION
         rather than about the person, so `deriveUpcoming` hands the same list to
         every id it is given. That is wrong for an id that is not in the course.
         A student who dropped in week 6 stays in a sweep's id list until
         somebody prunes it, and without this gate they keep being told about
         deadlines in a course they left. Everything else in the state is derived
         from the person's own rows and cannot cross this way. */
      dueSoon: enrolled === null || enrolled.has(userId) ? dueSoon.get(userId) ?? [] : [],
      lastClass: lastClass.get(userId) ?? null,
    })
  }
  return out
}

/** Which of these users are actually in the section. `null` when the lookup
 *  failed, which means "do not filter" rather than "nobody is enrolled": losing
 *  the roster must not silently blank every student's deadlines.
 *
 *  Bounded by the ids being asked about, not by the section alone. PostgREST
 *  caps a result at 1000 rows and reports that as a success, so a section-wide
 *  read would quietly drop every student past the first thousand out of the set
 *  and take their deadlines with them. Asking only about this chunk keeps the
 *  result at a hundred rows, which is all the check reads anyway. */
async function currentlyEnrolled(
  db: AdminDb,
  sectionId: string,
  userIds: string[],
): Promise<Set<string> | null> {
  try {
    const { data, error } = await db
      .from('enrollments')
      .select('student_id')
      .eq('section_id', sectionId)
      .in('student_id', userIds)
      .in('status', ['enrolled', 'completed'])
    if (error) throw error
    return new Set(((data ?? []) as Array<{ student_id: string }>).map((r) => r.student_id))
  } catch (error) {
    logger.error('currentlyEnrolled: failed', error, { source: 'memory.currentlyEnrolled', sectionId })
    return null
  }
}

/** What memory knows about a PROFESSOR in one section.
 *
 *  Preferences only, and that is not a gap. The student derivers answer "what is
 *  this person struggling with and what is due", which they compute from the
 *  user's OWN submissions — questions with no meaning for the person teaching
 *  the course. The context a professor needs about their class (roster size,
 *  modules, recent announcements) is already loaded by loadAssistantContext, so
 *  duplicating it here would create a second, staler copy of it. */
export async function getProfessorState(
  db: AdminDb,
  { userId, institutionId, sectionId }: UserStateScope,
): Promise<{ preferences: StoredPreference[] }> {
  const byUser = await readPreferences(db, {
    userIds: [userId],
    institutionId,
    sectionId,
    slots: slotsForSurface('professor'),
  })
  return { preferences: byUser.get(userId) ?? [] }
}
