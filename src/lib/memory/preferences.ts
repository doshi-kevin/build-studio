/**
 * Reading and writing stated preferences — the one thing the memory layer
 * actually stores.
 *
 * Writes are service-role only (the table has no INSERT/UPDATE/DELETE policy),
 * so every caller must have authorized the user first. Nothing here re-checks;
 * it takes the ids it is given and trusts the caller did the gate.
 */

import 'server-only'
import { logger } from '@/lib/logger'
import { fence } from '@/lib/ai/prompt-fence'
import {
  assertNotStandingAnswerRequest,
  assertStorablePreference,
  assertStorableProfessorPreferenceWithRoster,
  isProfessorSlot,
  type PreferenceCheck,
  isSameRule,
  isSingleValueSlot,
  stripReason,
  MULTI_VALUE_CAP,
  PREFERENCE_MAX_CHARS,
  type PreferenceSlot,
} from '@/lib/validations/memory'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = any

export interface StoredPreference {
  id: string
  slot: PreferenceSlot
  text: string
  /** null = applies to this person everywhere; set = only in that section. */
  sectionId: string | null
  expiresAt: string | null
  observedAt: string
}

/**
 * The live preferences that apply to a user in one section: their general rows
 * plus that section's rows. Expired rows are excluded here and only here —
 * the visibility pane reads through `listPreferences` and still shows them.
 */
export async function readPreferences(
  db: AdminDb,
  {
    userIds,
    sectionId,
    institutionId,
    slots,
  }: {
    userIds: string[]
    sectionId: string
    institutionId: string
    /** Restrict to one surface's slots. Omitted means every slot, which only the
     *  visibility pane wants — a prompt should always pass its own set, so a
     *  teaching assistant's student rows cannot reach the professor prompt. */
    slots?: readonly string[]
  },
): Promise<Map<string, StoredPreference[]>> {
  const out = new Map<string, StoredPreference[]>(userIds.map((id) => [id, []]))
  if (userIds.length === 0) return out

  try {
    /* `error` is read, not just `data`. Every query in this layer degrades to
       an empty result, which is right for a chat turn and wrong for silence: a
       gateway rejecting the request looked exactly like a student with no
       preferences until a stress run counted the HTTP codes. Throwing here puts
       it in the catch below, which logs it. */
    const { data, error } = await db
      .from('user_memory')
      .select('id, user_id, kind, text, section_id, expires_at, observed_at')
      .in('user_id', userIds)
      // institution_id is filtered explicitly because the admin client bypasses
      // row-level security — RLS is the second lock here, never the first.
      .eq('institution_id', institutionId)
      // Two `.or()` calls are AND-ed by PostgREST, which is what we want:
      // (general OR this section) AND (durable OR not yet expired).
      .or(`section_id.is.null,section_id.eq.${sectionId}`)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order('observed_at', { ascending: false })
    if (error) throw error

    const allowed = slots ? new Set(slots) : null
    for (const r of (data ?? []) as Array<Record<string, string | null>>) {
      if (allowed && !allowed.has(r.kind as string)) continue
      const list = out.get(r.user_id as string)
      if (!list) continue
      list.push({
        id: r.id as string,
        slot: r.kind as PreferenceSlot,
        text: r.text as string,
        sectionId: r.section_id,
        expiresAt: r.expires_at,
        observedAt: r.observed_at as string,
      })
    }
    for (const [userId, list] of out) out.set(userId, applyScopePrecedence(list))
    return out
  } catch (error) {
    logger.error('readPreferences: failed', error, { source: 'memory.readPreferences', sectionId })
    return out
  }
}

/**
 * Where a general and a course-scoped preference occupy the SAME single-value
 * slot, the course-scoped one wins inside that course.
 *
 * Without this both reach the model at once. A simulated term produced exactly
 * that: `[general] keep answers brief` and `[course] long and detailed`, live
 * together, telling the model two opposite things about the same axis. The
 * student had said both, months apart and about different scopes, and each was
 * correct where it was stated.
 *
 * Multi-value slots are left alone: a general constraint and a course constraint
 * are additive by design, and both genuinely apply.
 */
function applyScopePrecedence(list: StoredPreference[]): StoredPreference[] {
  const overriddenSlots = new Set(
    list.filter((p) => p.sectionId !== null && isSingleValueSlot(p.slot)).map((p) => p.slot),
  )
  return list.filter((p) => !(p.sectionId === null && overriddenSlots.has(p.slot)))
}

/** Everything remembered about one user, expired rows included, for the pane. */
export async function listPreferences(
  db: AdminDb,
  { userId, institutionId }: { userId: string; institutionId: string },
): Promise<StoredPreference[]> {
  try {
    const { data } = await db
      .from('user_memory')
      .select('id, kind, text, section_id, expires_at, observed_at')
      .eq('user_id', userId)
      .eq('institution_id', institutionId)
      .order('observed_at', { ascending: false })

    return ((data ?? []) as Array<Record<string, string | null>>).map((r) => ({
      id: r.id as string,
      slot: r.kind as PreferenceSlot,
      text: r.text as string,
      sectionId: r.section_id,
      expiresAt: r.expires_at,
      observedAt: r.observed_at as string,
    }))
  } catch (error) {
    logger.error('listPreferences: failed', error, { source: 'memory.listPreferences', userId })
    return []
  }
}

export interface WritePreferenceInput {
  userId: string
  institutionId: string
  /** null writes a general preference; a section id scopes it to that course. */
  sectionId: string | null
  slot: PreferenceSlot
  text: string
  /** Only when the user's own words carried a time bound. */
  expiresAt?: string | null
  /** Enrolled students' names, for professor slots. The pattern checks describe
   *  the shape of a sentence about people; this answers the question that decides
   *  the matter, which is whether the text names somebody in this course.
   *
   *  NOT optional for a professor slot, and an empty array is not the same as a
   *  missing one. A caller that simply forgot would otherwise get a silent
   *  `ok: true`, which is the failure this gate was moved here to prevent. Pass
   *  the names, or pass 'unavailable' to have the write refused. */
  rosterNames?: readonly string[] | 'unavailable'
  /** "First Last" pairs from the professor's OTHER sections, matched whole. See
   *  assertStorableProfessorPreferenceWithRoster for why they are not matched a
   *  part at a time. */
  otherSectionFullNames?: readonly string[]
}

export type WriteResult =
  | {
      ok: true
      id: string
      /** Text of a row the cap pushed out to make room, when it pushed one out.
       *
       *  Returned so the caller can TELL the person. The cap exists to keep the
       *  prompt honest, but dropping something they stated without a word is the
       *  same silent data loss the dedup work was done to prevent — a professor
       *  who states a fourth standing rule should not lose their first one and
       *  find out months later. */
      evicted?: string
    }
  | { ok: false; reason: string }

/**
 * Store one preference, applying the slot's cardinality.
 *
 * Single-value slots replace: a partial unique index makes two impossible, so
 * this upserts onto it. Multi-value slots append and then trim the oldest past
 * the cap — blind-upserting them would be data loss, silently erasing "use
 * plain language" the moment a second constraint arrives.
 */
export async function writePreference(db: AdminDb, input: WritePreferenceInput): Promise<WriteResult> {
  /* Cut the justification before anything else looks at the text. The rule is
     store the accommodation, never the reason, and a reason is usually attached
     by a causal word rather than by a keyword we happened to list. Doing this
     first also means the category check below runs on what will ACTUALLY be
     stored, so a preference is only refused when the sensitive part survives
     the cut. */
  /* Bound the input before any regex sees it. Twice the stored maximum leaves
     room for a reason that will be cut away, and makes the cost of every pattern
     below constant no matter what arrives. Measured, the patterns are linear and
     400k characters ran in under a millisecond, so this is cheap insurance
     rather than a fix for a live problem. */
  const clamped = input.text.slice(0, PREFERENCE_MAX_CHARS * 2)
  const accommodation = stripReason(clamped)
  /* The gate runs on the POST-strip string, and it runs HERE rather than only in
     the calling tool. Both matter.
     Checking the raw text and then storing a rewritten one checks a string that
     is not the string we keep. stripReason chooses which half of "X so Y" to
     keep by shape, and for "Aisha prefers bullet points so use them" it keeps the
     head — so a sentence that passed the check as written would have been stored
     as a fact about a named student, which is strictly worse than storing the
     original. The professor gate exists to stop exactly that.
     And writePreference is the shared choke point. A gate that lives only in one
     tool is a gate the next caller forgets. */
  let check: PreferenceCheck
  if (isProfessorSlot(input.slot)) {
    if (input.rosterNames === undefined || input.rosterNames === 'unavailable') {
      return {
        ok: false,
        reason: 'could not verify this does not name a student, so it was not saved',
      }
    }
    check = assertStorableProfessorPreferenceWithRoster(
      accommodation,
      input.rosterNames,
      input.otherSectionFullNames ?? [],
    )
  } else {
    check = assertStorablePreference(accommodation)
    /* Student slots only. The same words are ordinary from a professor, and
       this is the surface where a stored answer-only rule would re-apply itself
       to every graded turn. */
    if (check.ok) check = assertNotStandingAnswerRequest(accommodation)
  }
  if (!check.ok) {
    // The refused TEXT is never logged — logging it would defeat the point of
    // refusing to store it. Only the category reaches the log.
    logger.info('writePreference: refused', {
      source: 'memory.writePreference',
      slot: input.slot,
      reason: check.reason,
      /* Watch this number, not this line. The chat model strips the reason
         before calling the tool almost every time, so these server refusals are
         normally rare. A rise means the model got worse at it, probably after a
         version change, and students are quietly losing preferences. Nothing
         else would tell you: each student just experiences Athena forgetting. */
      metric: 'memory_sanitization_drift_canary',
    })
    return { ok: false, reason: check.reason ?? 'not storable' }
  }

  // Fenced at WRITE time, so no row can exist in a form the model could read as
  // markup. Doing it on read would leave the raw text one missed call away.
  const text = fence(accommodation, PREFERENCE_MAX_CHARS)
  const row = {
    user_id: input.userId,
    institution_id: input.institutionId,
    section_id: input.sectionId,
    kind: input.slot,
    text,
    value: {},
    source: 'stated',
    observed_at: new Date().toISOString(),
    expires_at: input.expiresAt ?? null,
    updated_at: new Date().toISOString(),
  }

  try {
    /* Single-value slots REPLACE, so clear the slot first. This cannot be one
       upsert: the partial index that enforces one-row-per-slot is not inferable
       by `ON CONFLICT (cols)` (Postgres needs the predicate repeated, which
       supabase-js cannot express), so aiming at it fails with "no unique or
       exclusion constraint matching the ON CONFLICT specification". Both writes
       are scoped to one user's own slot, and the only way to interleave them is
       two simultaneous turns in the same chat, where the partial index still
       holds the invariant and the loser gets a clean failure. */
    if (isSingleValueSlot(input.slot)) {
      const clear = db
        .from('user_memory')
        .delete()
        .eq('user_id', input.userId)
        .eq('institution_id', input.institutionId)
        .eq('kind', input.slot)
        .neq('text', text)
      await (input.sectionId === null ? clear.is('section_id', null) : clear.eq('section_id', input.sectionId))
    }

    // Every write targets the non-partial dedup index, so re-stating the same
    // line is an update rather than a duplicate row or an error.
    const { data, error } = await db
      .from('user_memory')
      .upsert(row, { onConflict: 'user_id,section_id,kind,text' })
      .select('id')
      .single()
    if (error) throw error

    const evicted = isSingleValueSlot(input.slot)
      ? undefined
      : await collapseSameRule(db, input, text)
    return { ok: true, id: data.id as string, ...(evicted ? { evicted } : {}) }
  } catch (error) {
    /* The error object is deliberately NOT passed to the logger.
       The logger extracts `details` from a Supabase error, and on a unique
       violation against user_memory_dedup (which includes `text`) that field
       holds the preference itself. So this catch block would write the exact
       string the refusal path above is careful never to log, and it would go to
       the observability stack, which usually has wider access than the database.
       Taking text too sensitive to store and broadcasting it to Sentry is worse
       than not storing it.
       Code and message are safe and are enough to debug with. If you need the
       text to diagnose something, reproduce it locally. */
    const e = error as { code?: string; message?: string } | null
    logger.error('writePreference: failed', null, {
      source: 'memory.writePreference',
      slot: input.slot,
      userId: input.userId,
      code: e?.code ?? 'unknown',
      // Postgres puts the offending row in `details`, never in `message`.
      message: e?.message ?? '',
    })
    return { ok: false, reason: 'could not save' }
  }
}

/**
 * Keep a multi-value slot honest, then apply the cap.
 *
 * Two jobs, and the split between them changed after a stress run. Outright
 * deletion now happens ONLY for a row that says the same thing in the same
 * words, ignoring case, spacing and trailing punctuation. Anything softer than
 * that deleted real accommodations: `isSameRule` scores "define any idioms you
 * use" against "define any acronyms you use" at 0.50 and took the idioms row
 * away, while scoring two genuine rephrasings of the bullet-point rule at 0.25
 * and keeping both. There is no threshold that gets those two right at once,
 * because the words that separate them are synonyms in one pair and different
 * things in the other, and nothing lexical can tell which.
 *
 * `isSameRule` still earns its place: it decides WHICH row the cap evicts. When
 * a fourth statement arrives something has to go regardless, so choosing the
 * phrasing a newer row already restates, rather than whatever happens to be
 * oldest, loses nothing. The student said "do not use bullet points" in week 2
 * and "please avoid bullet lists" in week 11; the week-2 row is the right one to
 * drop, and "never suggest studying on Saturdays" from week 3 is not.
 */
async function collapseSameRule(
  db: AdminDb,
  input: WritePreferenceInput,
  justWritten: string,
): Promise<string | undefined> {
  const rows = await slotRows(db, input)
  const target = normalisedRule(justWritten)

  const remaining: Array<{ id: string; text: string }> = []
  const doomed: string[] = []
  for (const row of rows) {
    if (row.text !== justWritten && normalisedRule(row.text) === target) doomed.push(row.id)
    else remaining.push(row)
  }

  // Over the cap, oldest-first, preferring a phrasing something newer restates.
  let evicted: string | undefined
  while (remaining.length > MULTI_VALUE_CAP) {
    const victim = pickEviction(remaining)
    remaining.splice(remaining.indexOf(victim), 1)
    doomed.push(victim.id)
    evicted ??= victim.text
  }

  if (doomed.length > 0) {
    // Deleted in the order the slot holds them, newest first, so the delete is
    // deterministic rather than in whatever order the cap happened to pick.
    doomed.sort((a, b) => rows.findIndex((r) => r.id === a) - rows.findIndex((r) => r.id === b))
    await db
      .from('user_memory')
      .delete()
      .in('id', doomed)
      // Scoped by owner as well as id. The ids come from slotRows, which already
      // filters correctly, but this is the admin client with RLS bypassed and
      // deletePreference sets the standard for the file.
      .eq('user_id', input.userId)
      .eq('institution_id', input.institutionId)
  }
  return evicted
}

/** Two statements of one rule in the same words. Case, spacing and a trailing
 *  full stop are not a second preference. */
function normalisedRule(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Which row leaves when the slot is full.
 *
 * Oldest first, except that a row a newer row already restates goes ahead of
 * it: dropping "do not use bullet points" while "please avoid bullet lists"
 * stays costs the student nothing, and dropping their Saturday rule instead
 * costs them the thing they gave a reason for.
 *
 * `rows` arrives newest first.
 */
function pickEviction(rows: Array<{ id: string; text: string }>): { id: string; text: string } {
  for (let older = rows.length - 1; older >= 1; older -= 1) {
    for (let newer = older - 1; newer >= 0; newer -= 1) {
      if (isSameRule(rows[older].text, rows[newer].text)) return rows[older]
    }
  }
  return rows[rows.length - 1]
}

/** This user's rows in one slot and scope, newest first. */
async function slotRows(
  db: AdminDb,
  input: WritePreferenceInput,
): Promise<Array<{ id: string; text: string }>> {
  const base = db
    .from('user_memory')
    .select('id, text')
    .eq('user_id', input.userId)
    .eq('institution_id', input.institutionId)
    .eq('kind', input.slot)
  const scoped = input.sectionId === null ? base.is('section_id', null) : base.eq('section_id', input.sectionId)
  const { data } = await scoped.order('observed_at', { ascending: false })
  return (data ?? []) as Array<{ id: string; text: string }>
}

/**
 * Forget one remembered item. Scoped by user id as well as row id so a stolen
 * or guessed id cannot delete someone else's row even if the caller's own
 * ownership check were wrong.
 */
export async function deletePreference(
  db: AdminDb,
  { id, userId }: { id: string; userId: string },
): Promise<boolean> {
  try {
    const { error } = await db.from('user_memory').delete().eq('id', id).eq('user_id', userId)
    if (error) throw error
    return true
  } catch (error) {
    logger.error('deletePreference: failed', error, { source: 'memory.deletePreference', userId })
    return false
  }
}
