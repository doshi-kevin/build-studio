/**
 * Let a professor tell the assistant how they want it to work, and have it stick.
 *
 * The professor twin of student-tutor/remember-preference.ts, with one rule the
 * student side does not need. A student talking to the tutor is talking about
 * themselves, so their words are safe to keep. A professor is surrounded by
 * other people, and most of what they say is ABOUT those people: who is
 * struggling, who missed a deadline, who to worry about. None of that may be
 * stored. Writing a student's academic standing into a prompt store that only
 * their professor can see or delete is not ours to do, and the student never
 * agreed to it.
 *
 * So the line here is configuration versus fact. "Always give a 3-column rubric"
 * configures the assistant and is kept. "Sarah is failing" is a fact about a
 * person and is dropped, silently as far as the record goes and out loud to the
 * professor.
 */

import 'server-only'
import { z } from 'zod'
import { tool } from 'ai'
import { logger } from '@/lib/logger'
import { logEvent } from '@/lib/supabase/event-logger'
import { writePreference } from '@/lib/memory/preferences'
import {
  professorSlotSchema,
  preferenceScopeSchema,
  assertStorableProfessorPreferenceWithRoster,
} from '@/lib/validations/memory'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

/** Fallback when the section has no end date recorded. */
export const PROFESSOR_FALLBACK_TTL_DAYS = 150

/** Roster rows read for the name check. Reading fewer than the sections hold
 *  would check only some of the students, so hitting this refuses instead.
 *
 *  Kept equal to PostgREST's `max_rows` in supabase/config.toml. If that cap is
 *  ever lowered, a truncated read would stop being detectable here — change both
 *  together, or move to an exact count. */
const ROSTER_LIMIT = 1000

/** Grace period past the last teaching day, so a preference set during prep
 *  survives marking week rather than lapsing days before it. */
const POST_TERM_GRACE_DAYS = 30

const DAY_MS = 86_400_000

/**
 * When a professor's preference should lapse.
 *
 * Bound to the section's own end date rather than a flat count of days. A
 * professor commonly sets things up weeks before teaching starts, and a flat
 * 120-day clock from that moment expires in the middle of finals. Falls back to
 * a long default when the section has no end date recorded.
 */
export function professorExpiry(sectionEndDate: string | null | undefined): string {
  const end = sectionEndDate ? Date.parse(sectionEndDate) : NaN
  if (!Number.isNaN(end)) {
    const withGrace = end + POST_TERM_GRACE_DAYS * DAY_MS
    // Never shorter than a month from now: a section that already ended should
    // still let its professor set a preference and have it hold for a while.
    const floor = Date.now() + 30 * DAY_MS
    return new Date(Math.max(withGrace, floor)).toISOString()
  }
  return new Date(Date.now() + PROFESSOR_FALLBACK_TTL_DAYS * DAY_MS).toISOString()
}

export function rememberWorkflow({
  adminDb,
  sectionId,
  userId,
  institutionId,
  sectionEndDate,
}: {
  adminDb: AdminDb
  sectionId: string
  userId: string
  institutionId: string
  sectionEndDate: string | null
}) {
  return tool({
    description:
      'Remember how THIS professor wants YOU to work, so future conversations already know. ' +
      'Store instructions about your own output: the tone for announcements, the shape of a quiz, ' +
      'how strictly to grade, formats they always want ("always give a 3-column rubric", ' +
      '"multiple choice only", "never suggest group work", "British spelling"). ' +
      'NEVER store facts. Anything about a student, a group of students, the class\'s performance, ' +
      'who is struggling, who missed something, or what happened in a session is NOT a preference and ' +
      'must NOT be saved — that is another person\'s record, the professor is not the only one it belongs ' +
      'to, and it would sit in every future prompt where the student can neither see nor remove it. ' +
      'If they mention a student while stating a preference, keep only the working instruction and drop ' +
      'the person entirely. Do not store grades, scores, names, or contact details of anyone. ' +
      'Call this when they tell you how they want something done, not for a one-off instruction about ' +
      'the current draft ("make this one shorter"), and not for something you inferred rather than heard. ' +
      'Saving is silent and instant: afterwards say in one short clause what you saved, then carry on with ' +
      'their request. If it comes back with `replaced`, that is a preference the cap pushed out to make room: tell them which one stopped applying, so nothing they said disappears without their knowing. ' +
      'If the tool comes back with saved:false, say plainly that you did NOT save it and give ' +
      'the reason. When it also returns nameFound, that is the exact word that matched a student on the roster: ' +
      'name it and offer the same preference with that word removed, so they are not left guessing. ' +
      'the reason it returned. Never imply you remembered something you did not — a professor who thinks a ' +
      'preference is stored will rely on it.  Mention that they can change it on their Preferences page only the FIRST time you ' +
      'save in a conversation.',
    inputSchema: z.object({
      slot: professorSlotSchema.describe(
        'announcement_style = drafting announcements. quiz_style = writing quizzes. ' +
          'grading_style = grading and feedback. workflow = anything else about how they like to ' +
          'work, including a standing rule; it holds several at once rather than replacing.',
      ),
      preference: z
        .string()
        .describe(
          'The instruction, in the professor\'s own words, rewritten as a short direction to yourself. ' +
            '"Always include a worked example in quizzes." Never name a person and never describe anyone.',
        ),
      scope: preferenceScopeSchema.describe(
        'course = this course only, which is the RIGHT DEFAULT: a professor runs an intro course and a ' +
          'graduate seminar differently, and a preference from one is usually wrong in the other. ' +
          'general = only when they say it applies to all their courses.',
      ),
    }),
    execute: async ({ slot, preference, scope }) => {
      /* Pull this section's roster names so the check can be exact rather than a
         guess. The capitalisation heuristic misses a lowercase or unusual name,
         and dictation produces lowercase constantly. A name that is actually on
         the roster is not a heuristic question. One query, and writes are rare. */
      /* Which sections the roster has to cover depends on where the row can
         reach. A course-scoped preference is only ever read inside this section,
         so this section's roster is the whole population. A general one reaches
         every course this professor teaches, and a student in one of those other
         sections is not on this roster — so checking only this one would leave
         the control narrower than the write. */
      const scopedSections: string[] = [sectionId]
      const rosterNames: string[] = []
      const otherSectionFullNames: string[] = []
      try {
        /* Always, not just for a general-scope write.
           The earlier version checked only this section when the scope was
           'course', on the reasoning that a course row is read only here. That
           reasoning is about where the row is READ; the harm happens when it is
           WRITTEN. A professor talking in one course names a student from
           another all the time, and checking one roster left that student
           unprotected. It also meant a section with 30 students had LESS name
           protection than a section with none, because the old fallback only ran
           on an empty roster. One extra query, on a path that runs rarely. */
        {
          const { data: sections, error: sectionsError } = await adminDb
            .from('course_sections')
            .select('id')
            .eq('professor_id', userId)
            .limit(ROSTER_LIMIT)
          if (sectionsError) throw sectionsError
          if (!Array.isArray(sections)) throw new Error('section lookup returned no usable rows')
          for (const row of sections as Array<{ id: string }>) {
            if (row.id && !scopedSections.includes(row.id)) scopedSections.push(row.id)
          }
          if (sections.length >= ROSTER_LIMIT) throw new Error('section list larger than the checked limit')

          /* professor_id is only one of the two ways into a section. Somebody
             staffed through section_staff teaches there too, and a general row
             is read in every section they can reach, so leaving those out would
             check a smaller population than the write can touch. */
          const { data: staffed, error: staffedError } = await adminDb
            .from('section_staff')
            .select('section_id')
            .eq('staff_id', userId)
            .eq('status', 'active')
            .limit(ROSTER_LIMIT)
          if (staffedError) throw staffedError
          if (!Array.isArray(staffed)) throw new Error('staff lookup returned no usable rows')
          for (const row of staffed as Array<{ section_id: string }>) {
            if (row.section_id && !scopedSections.includes(row.section_id)) {
              scopedSections.push(row.section_id)
            }
          }
          if (staffed.length >= ROSTER_LIMIT) throw new Error('staff list larger than the checked limit')
        }

        const { data, error } = await adminDb
          .from('enrollments')
          .select('section_id, student:profiles(first_name, last_name)')
          .in('section_id', scopedSections)
          .limit(ROSTER_LIMIT)

        /* supabase-js RESOLVES with { data: null, error } for a server-side
           failure and only REJECTS on a transport error, so a try/catch alone
           does not make this fail closed. Without this branch a schema-cache
           blip during a migration would leave rosterNames empty, silently
           turning the name check off at exactly the moment nobody is watching. */
        if (error) throw error
        if (!Array.isArray(data)) throw new Error('roster lookup returned no usable rows')
        if (data.length >= ROSTER_LIMIT) throw new Error('roster larger than the checked limit')

        for (const row of data as Array<Record<string, unknown>>) {
          const p = Array.isArray(row.student) ? row.student[0] : row.student
          const rec = p as { first_name?: string; last_name?: string } | null
          /* A row whose profile join came back empty means the roster we hold is
             not the roster that exists. Partial coverage is worse than none,
             because a non-empty list also skips the no-roster fallback. */
          if (!rec || (!rec.first_name && !rec.last_name)) {
            throw new Error('an enrolment row returned no name')
          }
          if (row.section_id === sectionId) {
            // Where the professor is working: either part of the name is enough.
            if (rec.first_name) rosterNames.push(rec.first_name)
            if (rec.last_name) rosterNames.push(rec.last_name)
          } else {
            // Another course: both parts together, so a common first name does
            // not block an ordinary word everywhere the professor writes.
            const full = `${rec.first_name ?? ''} ${rec.last_name ?? ''}`.trim()
            if (full.includes(' ')) {
              otherSectionFullNames.push(full)
            } else if (full) {
              /* Only one name on record, so there is no full name to match. Treat
                 it like a current-section name rather than dropping the student
                 from the check altogether. */
              rosterNames.push(full)
            }
          }
        }
      } catch (error) {
        /* Fail CLOSED on the roster read. If we cannot tell whether this names a
           student, we do not store it. A professor can rephrase; a student whose
           record we kept cannot undo it. */
        logger.error('rememberWorkflow: roster read failed, refusing the write', error, {
          source: 'professorAssistant.rememberWorkflow',
          sectionId,
          scope,
        })
        return {
          saved: false,
          reason: 'could not verify this does not name a student, so it was not saved',
        }
      }

      const check = assertStorableProfessorPreferenceWithRoster(
        preference,
        rosterNames,
        otherSectionFullNames,
      )
      if (!check.ok) {
        // The refused text is never logged; only the category reaches the log.
        logger.info('rememberWorkflow: refused', {
          source: 'professorAssistant.rememberWorkflow',
          slot,
          reason: check.reason,
        })
        return {
          saved: false,
          reason: check.reason,
          // Given back to the model so it can offer the professor a rephrasing
          // that drops the name, rather than guessing which word tripped it.
          ...(check.matchedName ? { nameFound: check.matchedName } : {}),
        }
      }

      const result = await writePreference(adminDb, {
        userId,
        institutionId,
        sectionId: scope === 'general' ? null : sectionId,
        slot,
        text: preference,
        rosterNames,
        otherSectionFullNames,
        expiresAt: professorExpiry(sectionEndDate),
      })

      if (!result.ok) return { saved: false, reason: result.reason }

      /* The deletion of professor memory was logged and the creation was not,
         so after a row was removed there was no record it had ever existed.
         That is the wrong way round: "did we ever store a student's name?" is
         the question an audit would actually need to answer. Metadata only,
         never the text. */
      await logEvent({
        userId,
        sectionId,
        eventType: 'memory.preference_saved',
        eventCategory: 'professor',
        metadata: { slot, scope, sectionsChecked: scopedSections.length },
      })

      return {
        saved: true,
        summary: scope === 'general' ? 'saved for all your courses' : 'saved for this course',
        /* A standing rule only holds three at a time, so a fourth pushes the
           oldest out. Handed back so it can be said out loud: losing something
           they stated, without being told, is the failure this whole slot design
           exists to avoid. */
        ...(result.evicted ? { replaced: result.evicted } : {}),
      }
    },
  })
}
