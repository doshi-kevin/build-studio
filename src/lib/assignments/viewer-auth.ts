/**
 * Shared authorization for reading a submission's files in-app (zip/notebook viewers).
 *
 * One role-agnostic rule, used by every viewer action: you may read a submission's
 * files if you are the student who OWNS it, OR you are STAFF on its section. Assume an
 * attacker calls a viewer action directly with someone else's `submissionId` /
 * `filePath` — the checks below are what stop a cross-student / cross-tenant read
 * (the IDOR class the dedicated submissions bucket exists to prevent).
 *
 * Server-only: imports the admin client (service-role key).
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifySectionAccess } from '@/lib/auth/section-access'
import type { SubmissionFile } from '@/lib/validations/assignment'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveJoin = (val: any) => (Array.isArray(val) ? val[0] : val)

export interface AuthorizedSubmissionFile {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminDb: any
  /** The validated storage path (guaranteed to belong to this submission). */
  path: string
  /** The original file name as the student uploaded it. */
  fileName: string
}

/**
 * Authorize a read of one file on a submission and validate that `filePath` is actually
 * one of that submission's files. Returns the admin client + the validated path, or an
 * `{ error }` to surface to the caller. Never throws.
 */
export async function authorizeSubmissionFile(
  submissionId: string,
  filePath: string,
): Promise<AuthorizedSubmissionFile | { error: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'You need to sign in again.' }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any
  const { data: sub } = await adminDb
    .from('assignment_submissions')
    .select('id, student_id, files, assignment:assignments(section_id)')
    .eq('id', submissionId)
    .maybeSingle()
  if (!sub) return { error: 'Submission not found.' }

  const sectionId = resolveJoin(sub.assignment)?.section_id as string | undefined
  if (!sectionId) return { error: 'Submission not found.' }

  // Owner student, or staff on the submission's section. Verifying neither → deny.
  if (sub.student_id !== user.id) {
    const access = await verifySectionAccess(sectionId, user.id)
    if (!access.ok) return { error: 'You do not have access to this submission.' }
  }

  // The requested path MUST be one of this submission's own files — never trust a
  // client-supplied path against the bucket.
  const files = (sub.files as SubmissionFile[] | null) ?? []
  const match = files.find((f) => f.path === filePath)
  if (!match) return { error: 'File not found.' }

  return { adminDb, path: match.path, fileName: match.name }
}
