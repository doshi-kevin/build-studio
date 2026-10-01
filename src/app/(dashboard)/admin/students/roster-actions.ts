/**
 * Roster Import Server Actions — the admin bulk "paste a list, get a roster" flow.
 * Design: docs/designs/platform/admin-roster-import.md
 *
 * Two actions sharing one resolver:
 * - previewRosterImport(text): parse + resolve + classify every row. NO writes.
 * - commitRosterChunk(text):   the same resolution re-run server-side (the preview
 *   is informational — nothing client-computed is trusted), then the writes.
 *
 * The CLIENT splits a big paste into chunks of ROSTER_CHUNK_SIZE rows and calls
 * commitRosterChunk once per chunk, sequentially. Auth-account creation is a
 * heavyweight call (~200ms each); one 200-row server action would time out and
 * strand half-committed work. Chunks finish in seconds, and because every write
 * is idempotent (upsert-shaped enrollment writes, account lookup before create),
 * a failed/retried chunk never duplicates anything.
 *
 * Security: verifyInstitutionAdmin on every call; every resolution query filters
 * by the VERIFIED session institution_id — a course code or email can only ever
 * match the admin's own tenant. Assume any input is attacker-supplied.
 */
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyInstitutionAdmin } from '@/lib/auth/admin-context'
import { provisionStudentAccount } from '@/lib/admin/provision-student'
import { sendStudentCredentials } from '@/lib/email'
import { emitEvent } from '@/lib/events/emit'
import { logEvent } from '@/lib/supabase/event-logger'
import { logger } from '@/lib/logger'
import { ON_ROSTER_STATUSES } from '@/lib/validations/enrollment'
import { parseInstitutionSettings, selfUnenrollPolicySchema } from '@/lib/validations/institution-settings'
import { staleWriteError } from '@/lib/supabase/stale-write'
import {
  parseRosterText,
  type ParsedRosterRow,
  type RosterRowResult,
} from '@/lib/validations/roster-import'

/* Generous cap on the raw paste; the row cap in parseRosterText is the real limit. */
const rosterTextSchema = z.string().max(100_000, 'Pasted text is too large')

export interface RosterImportSummary {
  enroll: number
  createAndEnroll: number
  reenroll: number
  alreadyEnrolled: number
  errors: number
  duplicatesDropped: number
}

export interface CreatedAccount {
  email: string
  name: string
  /** Temp password — returned once to the authenticated admin for the credentials CSV. */
  password: string
  emailSent: boolean
}

/* ────────────────────────────────────────────────────────────────────────────
 * Resolution — shared by preview and commit
 * ──────────────────────────────────────────────────────────────────────────── */

interface ResolvedRow {
  row: ParsedRosterRow
  error?: string
  /** Existing student profile in this tenant (null = account must be created) */
  studentId?: string
  needsAccount?: boolean
  /** Split name for account creation (only set when needsAccount) */
  firstName?: string
  lastName?: string
  sectionId?: string
  /** "CS-101 — Intro to CS (Section A)" for messages/notifications */
  sectionLabel?: string
  courseLabel?: string
  existingEnrollment?: { id: string; status: string } | null
  warning?: string
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/)
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRoster(adminDb: any, institutionId: string, rows: ParsedRosterRow[]): Promise<ResolvedRow[]> {
  if (rows.length === 0) return []

  const emails = Array.from(new Set(rows.map((r) => r.email)))

  /* One batched read per entity kind — no per-row queries (data-access.md). All
     three are institution-scoped: nothing outside the admin's tenant can match. */
  const [profilesRes, coursesRes] = await Promise.all([
    adminDb
      .from('profiles')
      .select('id, email, role, name')
      .eq('institution_id', institutionId)
      .in('email', emails),
    adminDb
      .from('courses')
      .select('id, code, title, department:departments(id, name)')
      .eq('institution_id', institutionId)
      .limit(2000),
  ])

  if (profilesRes.error || coursesRes.error) {
    logger.error('resolveRoster: lookup failed', profilesRes.error || coursesRes.error, { institutionId })
    return rows.map((row) => ({ row, error: 'Could not look up students and courses. Try again.' }))
  }

  const profileByEmail = new Map<string, { id: string; role: string; name: string | null }>()
  for (const p of profilesRes.data ?? []) profileByEmail.set(p.email as string, p)

  /* courses.code is unique per DEPARTMENT, so one code can match several courses. */
  const coursesByCode = new Map<string, Array<{ id: string; code: string; title: string; department: { name: string } | null }>>()
  for (const c of coursesRes.data ?? []) {
    const dept = Array.isArray(c.department) ? c.department[0] : c.department
    const key = (c.code as string).toUpperCase()
    const list = coursesByCode.get(key) ?? []
    list.push({ id: c.id, code: c.code, title: c.title, department: dept ?? null })
    coursesByCode.set(key, list)
  }

  const matchedCourseIds = Array.from(
    new Set(
      rows.flatMap((r) => (coursesByCode.get(r.courseCode.toUpperCase()) ?? []).map((c) => c.id))
    )
  )

  const sectionsByCourse = new Map<string, Array<{ id: string; section_code: string; semester: string; year: number; max_students: number | null }>>()
  if (matchedCourseIds.length > 0) {
    const { data: sections, error } = await adminDb
      .from('course_sections')
      .select('id, course_id, section_code, semester, year, max_students')
      .eq('institution_id', institutionId)
      .eq('status', 'active')
      .in('course_id', matchedCourseIds)
      .limit(1000)
    if (error) {
      logger.error('resolveRoster: sections lookup failed', error, { institutionId })
      return rows.map((row) => ({ row, error: 'Could not look up course sections. Try again.' }))
    }
    for (const s of sections ?? []) {
      const list = sectionsByCourse.get(s.course_id as string) ?? []
      list.push(s)
      sectionsByCourse.set(s.course_id as string, list)
    }
  }

  /* First pass: match every row to a student + section (or an error). */
  const resolved: ResolvedRow[] = rows.map((row) => {
    const courses = coursesByCode.get(row.courseCode.toUpperCase()) ?? []
    if (courses.length === 0) {
      return { row, error: `Course "${row.courseCode}" not found` }
    }
    if (courses.length > 1) {
      const depts = courses.map((c) => c.department?.name ?? 'unknown department').join(', ')
      return { row, error: `Course code "${row.courseCode}" exists in more than one department (${depts}) — these rows need the admin single-add flow` }
    }
    const course = courses[0]
    const courseLabel = `${course.code} — ${course.title}`

    const sections = sectionsByCourse.get(course.id) ?? []
    let section: (typeof sections)[number] | undefined
    if (row.sectionCode) {
      section = sections.find((s) => s.section_code.toUpperCase() === row.sectionCode!.toUpperCase())
      if (!section) {
        const available = sections.map((s) => s.section_code).join(', ') || 'none'
        return { row, error: `Section "${row.sectionCode}" not found for ${course.code} (active sections: ${available})` }
      }
    } else if (sections.length === 0) {
      return { row, error: `${course.code} has no active section` }
    } else if (sections.length > 1) {
      const codes = sections.map((s) => s.section_code).join(', ')
      return { row, error: `${course.code} has ${sections.length} active sections (${codes}) — pick one as ${course.code}/${sections[0].section_code}` }
    } else {
      section = sections[0]
    }

    const profile = profileByEmail.get(row.email)
    if (profile && profile.role !== 'student') {
      return { row, error: `${row.email} belongs to a staff account — only students can be enrolled` }
    }

    const base: ResolvedRow = {
      row,
      sectionId: section.id,
      sectionLabel: `${courseLabel} (Section ${section.section_code})`,
      courseLabel,
    }
    if (profile) return { ...base, studentId: profile.id }

    /* New account: a name is required. Any row for this email may carry it. */
    const nameRow = rows.find((r) => r.email === row.email && r.name)
    if (!nameRow?.name) {
      return { row, error: `A new account for ${row.email} needs a name — use "Name, email, course"` }
    }
    return { ...base, needsAccount: true, ...splitName(nameRow.name) }
  })

  /* Second pass: existing enrollments for the (student, section) pairs. */
  const studentIds = Array.from(new Set(resolved.filter((r) => r.studentId).map((r) => r.studentId!)))
  const sectionIds = Array.from(new Set(resolved.filter((r) => r.sectionId && !r.error).map((r) => r.sectionId!)))
  const enrollmentByPair = new Map<string, { id: string; status: string }>()
  if (studentIds.length > 0 && sectionIds.length > 0) {
    const { data: enrollments, error } = await adminDb
      .from('enrollments')
      .select('id, student_id, section_id, status')
      .in('student_id', studentIds)
      .in('section_id', sectionIds)
      .limit(5000)
    if (error) {
      logger.error('resolveRoster: enrollments lookup failed', error, { institutionId })
    } else {
      for (const e of enrollments ?? []) {
        enrollmentByPair.set(`${e.student_id}|${e.section_id}`, { id: e.id, status: e.status })
      }
    }
  }
  for (const r of resolved) {
    if (r.studentId && r.sectionId && !r.error) {
      r.existingEnrollment = enrollmentByPair.get(`${r.studentId}|${r.sectionId}`) ?? null
    }
  }

  /* Third pass: capacity warnings (informational — the admin is the authority). */
  if (sectionIds.length > 0) {
    const counts = await Promise.all(
      sectionIds.map(async (id) => {
        const { count } = await adminDb
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .eq('section_id', id)
          .in('status', ON_ROSTER_STATUSES)
        return [id, count ?? 0] as const
      })
    )
    const countBySection = new Map(counts)
    const maxBySection = new Map<string, number | null>()
    for (const list of sectionsByCourse.values()) {
      for (const s of list) maxBySection.set(s.id, s.max_students)
    }
    const plannedBySection = new Map<string, number>()
    for (const r of resolved) {
      if (r.error || !r.sectionId) continue
      const status = r.existingEnrollment?.status
      const willAdd = !status || !(ON_ROSTER_STATUSES as readonly string[]).includes(status)
      if (!willAdd) continue
      plannedBySection.set(r.sectionId, (plannedBySection.get(r.sectionId) ?? 0) + 1)
      const max = maxBySection.get(r.sectionId)
      if (max != null && max > 0) {
        const projected = (countBySection.get(r.sectionId) ?? 0) + (plannedBySection.get(r.sectionId) ?? 0)
        if (projected > max) {
          r.warning = `Section will be over capacity (${projected}/${max})`
        }
      }
    }
  }

  return resolved
}

function classify(r: ResolvedRow): RosterRowResult {
  const base = {
    line: r.row.line,
    raw: r.row.raw,
    email: r.row.email,
    courseCode: r.row.sectionCode ? `${r.row.courseCode}/${r.row.sectionCode}` : r.row.courseCode,
    warning: r.warning,
  }
  if (r.error) return { ...base, status: 'error', detail: r.error }
  const status = r.existingEnrollment?.status
  if (status && (ON_ROSTER_STATUSES as readonly string[]).includes(status)) {
    return { ...base, status: 'already_enrolled', detail: `Already enrolled in ${r.sectionLabel}` }
  }
  if (status) {
    return { ...base, status: 'reenroll', detail: `Was ${status} — will be re-enrolled in ${r.sectionLabel}` }
  }
  if (r.needsAccount) {
    return { ...base, status: 'create_enroll', detail: `New account + enroll in ${r.sectionLabel}` }
  }
  return { ...base, status: 'enroll', detail: `Enroll in ${r.sectionLabel}` }
}

function summarize(results: RosterRowResult[], duplicatesDropped: number): RosterImportSummary {
  return {
    enroll: results.filter((r) => r.status === 'enroll').length,
    createAndEnroll: results.filter((r) => r.status === 'create_enroll').length,
    reenroll: results.filter((r) => r.status === 'reenroll').length,
    alreadyEnrolled: results.filter((r) => r.status === 'already_enrolled').length,
    errors: results.filter((r) => r.status === 'error').length,
    duplicatesDropped,
  }
}

function parseErrorResults(errors: { line: number; raw: string; reason: string }[]): RosterRowResult[] {
  return errors.map((e) => ({
    line: e.line,
    raw: e.raw,
    email: '',
    courseCode: '',
    status: 'error' as const,
    detail: e.reason,
  }))
}

/* ────────────────────────────────────────────────────────────────────────────
 * Actions
 * ──────────────────────────────────────────────────────────────────────────── */

export type RosterPreviewResponse =
  | { success: true; results: RosterRowResult[]; summary: RosterImportSummary }
  | { error: string }

export type RosterCommitResponse =
  | { success: true; results: RosterRowResult[]; summary: RosterImportSummary; createdAccounts: CreatedAccount[] }
  | { error: string }

/** Dry-run: classifies every pasted row without writing anything. */
export async function previewRosterImport(text: string): Promise<RosterPreviewResponse> {
  try {
    const auth = await verifyInstitutionAdmin('rosterImport')
    if ('error' in auth) return { error: auth.error }

    const parsedText = rosterTextSchema.safeParse(text)
    if (!parsedText.success) return { error: parsedText.error.issues[0].message }

    const { rows, errors, duplicateCount } = parseRosterText(parsedText.data)
    if (rows.length === 0 && errors.length === 0) {
      return { error: 'Nothing to import — paste one row per student, like "Jane Doe, jane@university.edu, CS-101"' }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const resolved = await resolveRoster(adminDb, auth.institutionId, rows)
    const results = [...parseErrorResults(errors), ...resolved.map(classify)].sort((a, b) => a.line - b.line)

    return { success: true as const, results, summary: summarize(results, duplicateCount) }
  } catch (error) {
    logger.error('previewRosterImport', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Commits ONE chunk of rows (the client chunks by ROSTER_CHUNK_SIZE and calls this
 * sequentially). Re-parses and re-resolves the chunk's text server-side, then per row:
 * create the account if needed (once per email), then an idempotent enrollment write.
 * One bad row never aborts the chunk.
 */
export async function commitRosterChunk(text: string): Promise<RosterCommitResponse> {
  try {
    const auth = await verifyInstitutionAdmin('rosterImport')
    if ('error' in auth) return { error: auth.error }

    const parsedText = rosterTextSchema.safeParse(text)
    if (!parsedText.success) return { error: parsedText.error.issues[0].message }

    const { rows, errors, duplicateCount } = parseRosterText(parsedText.data)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any
    const resolved = await resolveRoster(adminDb, auth.institutionId, rows)

    const results: RosterRowResult[] = parseErrorResults(errors)
    const createdByEmail = new Map<string, { userId: string; name: string; password: string }>()
    const failedEmails = new Map<string, string>()
    const createdAccounts: CreatedAccount[] = []

    for (const r of resolved) {
      const rowResult = classify(r)
      if (rowResult.status === 'error' || rowResult.status === 'already_enrolled') {
        results.push(rowResult)
        continue
      }

      /* Account: reuse the tenant profile, a just-created one, or create now. */
      let studentId = r.studentId ?? createdByEmail.get(r.row.email)?.userId
      if (!studentId) {
        const priorFailure = failedEmails.get(r.row.email)
        if (priorFailure) {
          results.push({ ...rowResult, status: 'error', detail: priorFailure })
          continue
        }
        const provisioned = await provisionStudentAccount(adminDb, {
          email: r.row.email,
          firstName: r.firstName!,
          lastName: r.lastName!,
          cwid: null,
          institutionId: auth.institutionId,
          invitedBy: auth.userId,
        })
        if (!provisioned.ok) {
          failedEmails.set(r.row.email, provisioned.error)
          results.push({ ...rowResult, status: 'error', detail: provisioned.error })
          continue
        }
        const name = `${r.firstName} ${r.lastName}`.trim()
        createdByEmail.set(r.row.email, { userId: provisioned.userId, name, password: provisioned.password })
        studentId = provisioned.userId
        logEvent({
          userId: auth.userId,
          eventType: 'student.created',
          metadata: { name, email: r.row.email, via: 'roster_import' },
        })
      }

      /* Enrollment write — idempotent. Re-enroll is a guarded UPDATE (state check in
         the WHERE, branch on rows affected); fresh enroll is an INSERT whose unique
         (student_id, section_id) violation downgrades to "already enrolled". */
      let enrollmentId: string | null = null
      let finalResult: RosterRowResult
      if (r.existingEnrollment) {
        const { data: updated, error } = await adminDb
          .from('enrollments')
          .update({
            status: 'enrolled',
            /* Reset so the student's self-unenroll window restarts from this re-add. */
            enrolled_at: new Date().toISOString(),
            source: 'import',
          })
          .eq('id', r.existingEnrollment.id)
          .in('status', ['dropped', 'withdrawn'])
          .select('id')
        if (error) {
          logger.error('commitRosterChunk: re-enroll failed', error, { enrollmentId: r.existingEnrollment.id })
          finalResult = { ...rowResult, status: 'error', detail: 'Could not re-enroll — try again' }
        } else if (!updated || updated.length === 0) {
          finalResult = { ...rowResult, status: 'already_enrolled', detail: `Already enrolled in ${r.sectionLabel}` }
        } else {
          enrollmentId = updated[0].id
          finalResult = { ...rowResult, status: 'reenroll', detail: `Re-enrolled in ${r.sectionLabel}` }
        }
      } else {
        const { data: inserted, error } = await adminDb
          .from('enrollments')
          .insert({ section_id: r.sectionId, student_id: studentId, status: 'enrolled', source: 'import' })
          .select('id')
          .single()
        if (error && error.code === '23505') {
          finalResult = { ...rowResult, status: 'already_enrolled', detail: `Already enrolled in ${r.sectionLabel}` }
        } else if (error || !inserted) {
          logger.error('commitRosterChunk: enroll failed', error, { studentId, sectionId: r.sectionId })
          finalResult = { ...rowResult, status: 'error', detail: 'Could not enroll — try again' }
        } else {
          enrollmentId = inserted.id
          finalResult = {
            ...rowResult,
            status: r.needsAccount ? 'create_enroll' : 'enroll',
            detail: `Enrolled in ${r.sectionLabel}`,
          }
        }
      }

      if (enrollmentId) {
        await emitEvent({
          type: 'enrollment_added',
          sectionId: r.sectionId!,
          actorId: auth.userId,
          audience: [studentId],
          institutionId: auth.institutionId,
          entity: { type: 'enrollment', id: enrollmentId },
          title: `Added to ${r.courseLabel}`,
          linkUrl: `/student/courses/${r.sectionId}`,
        })
      }
      results.push(finalResult)
    }

    /* Credentials email — once per created account, after its enrollments landed. */
    for (const [email, account] of createdByEmail) {
      const emailSent = await sendStudentCredentials(email, account.name, null, account.password)
      createdAccounts.push({ email, name: account.name, password: account.password, emailSent })
      for (const res of results) {
        if (res.email === email && res.status === 'create_enroll') res.emailSent = emailSent
      }
    }

    results.sort((a, b) => a.line - b.line)
    const summary = summarize(results, duplicateCount)
    logEvent({
      userId: auth.userId,
      eventType: 'roster.import_chunk',
      metadata: {
        rows: results.length,
        enrolled: summary.enroll + summary.reenroll,
        accountsCreated: summary.createAndEnroll,
        skipped: summary.alreadyEnrolled,
        errors: summary.errors,
      },
    })

    revalidatePath('/admin/students')
    revalidatePath('/admin')

    return { success: true as const, results, summary, createdAccounts }
  } catch (error) {
    logger.error('commitRosterChunk', error)
    return { error: 'Unexpected error' }
  }
}

/**
 * Updates the institution's self-unenroll policy ({ enabled, days } under
 * institutions.settings.selfUnenroll). While enabled, students see an Unenroll
 * button on their course pages for `days` days after each enrollment; the
 * student-side action re-checks this policy on every call.
 */
export async function updateEnrollmentPolicy(
  input: { enabled: boolean; days: number },
  expectedUpdatedAt?: string | null,
) {
  try {
    const auth = await verifyInstitutionAdmin('enrollmentPolicy')
    if ('error' in auth) return { error: auth.error }

    const parsed = selfUnenrollPolicySchema.safeParse(input)
    if (!parsed.success) return { error: 'Invalid policy — days must be between 1 and 365' }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminDb = createAdminClient() as any

    /* Merge under the settings JSONB without clobbering future sibling keys. */
    const { data: institution, error: fetchError } = await adminDb
      .from('institutions')
      .select('settings, updated_at')
      .eq('id', auth.institutionId)
      .single()
    if (fetchError || !institution) {
      logger.error('updateEnrollmentPolicy: fetch failed', fetchError, { institutionId: auth.institutionId })
      return { error: 'Could not load institution settings' }
    }

    /* Optimistic concurrency, the #724 house convention (#742). Two admins saving at
       once used to lose one change silently while BOTH were told it saved — proved
       live with two sessions, 7 days and 21 days, one success toast each, 7 stored.
       The guard rides in the WHERE so the stale write matches zero rows instead of
       clobbering a newer one.

       Note the read-modify-write on `settings` is the deeper hazard: the spread only
       protects sibling keys the READER saw, not one written concurrently by someone
       else. selfUnenroll is the only key in production today, so it cannot bite yet;
       this guard is what stops it biting the moment a second key exists.

       Requires the update_institutions_updated_at trigger added in the accompanying
       migration — without it the column never advances and this predicate would
       match forever. */
    let updateQuery = adminDb
      .from('institutions')
      .update({ settings: { ...(institution.settings ?? {}), selfUnenroll: parsed.data } })
      .eq('id', auth.institutionId)
    if (expectedUpdatedAt) {
      updateQuery = updateQuery.eq('updated_at', expectedUpdatedAt)
    } else {
      logger.warn('updateEnrollmentPolicy: no expectedUpdatedAt — stale-write guard NOT applied', { institutionId: auth.institutionId })
    }

    const { data: saved, error: updateError } = await updateQuery
      .select('settings, updated_at')
      .maybeSingle()
    if (updateError) {
      logger.error('updateEnrollmentPolicy: update failed', updateError, { institutionId: auth.institutionId })
      return { error: 'Failed to save the policy' }
    }
    /* Zero rows past verifyInstitutionAdmin can only mean the guard fired — the row
       is known to exist. Hand back what IS stored so the admin sees the winning
       value rather than being told to go find it. */
    if (expectedUpdatedAt && !saved) {
      logger.warn('updateEnrollmentPolicy: stale write rejected', { institutionId: auth.institutionId, expectedUpdatedAt })
      const { data: current } = await adminDb
        .from('institutions')
        .select('settings, updated_at')
        .eq('id', auth.institutionId)
        .maybeSingle()
      return {
        ...staleWriteError(),
        current: current
          ? { policy: parseInstitutionSettings(current.settings).selfUnenroll, updatedAt: current.updated_at as string }
          : undefined,
      }
    }

    logEvent({
      userId: auth.userId,
      eventType: 'institution.enrollment_policy_updated',
      metadata: { enabled: parsed.data.enabled, days: parsed.data.days },
    })
    revalidatePath('/admin/students')

    return { success: true as const, updatedAt: (saved?.updated_at as string | undefined) ?? null }
  } catch (error) {
    logger.error('updateEnrollmentPolicy', error)
    return { error: 'Unexpected error' }
  }
}
