// Client-side table + filters for the admin TA/Grader directory. Lets admins
// search by name/email, filter by department/role/status, and revoke active
// assignments without leaving the page.
'use client'

import { useState, useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Search,
  Users,
  GraduationCap,
  Mail,
  UserX,
  Trash2,
  Building2,
  ShieldCheck,
  Send,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { STAFF_ROLE_LABELS } from '@/lib/validations/section-staff'
import { derivedStatus, isExpired } from '@/lib/section-staff/directory-utils'
import { revokeStaffAssignment, resendStaffInvite, deleteCourseAssistant, getCourseAssistantCascadeCounts } from '@/app/(dashboard)/admin/staff-requests/actions'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any

interface Department {
  id: string
  name: string
  code: string
}

interface StaffDirectoryTableProps {
  assignments: AnyRow[]
  departments: Department[]
}

function resolveJoin<T>(val: T | T[] | null | undefined): T | null {
  if (!val) return null
  return Array.isArray(val) ? val[0] : val
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  active: { dot: 'bg-success', text: 'text-foreground', label: 'Active' },
  ended: { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground', label: 'Ended' },
  removed: { dot: 'bg-destructive/70', text: 'text-muted-foreground', label: 'Revoked' },
}

export function StaffDirectoryTable({ assignments, departments }: StaffDirectoryTableProps) {
  const [search, setSearch] = useState('')
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [roleFilter, setRoleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [isPending, startTransition] = useTransition()
  const [revoking, setRevoking] = useState<AnyRow | null>(null)
  /* True when the row being closed out is past its end date, so its access already lapsed.
     Drives the dialog's wording and the button label; the server action independently decides
     whether to keep the existing ends_at, so this is presentation only. */
  const revokeAlreadyEnded = revoking ? isExpired(revoking.ends_at) : false
  const [revokeReason, setRevokeReason] = useState('')
  /* #725 part 2. deleteCourseAssistant shipped with no caller at all, which is the exact
     fault the issue was about for updateProgram, so it was still impossible to remove a
     course-assistant profile from the console. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [deleting, setDeleting] = useState<any | null>(null)
  const [deleteCounts, setDeleteCounts] = useState<{ activeAssignments: number; pastAssignments: number } | 'failed' | null>(null)
  const [resendingProfileId, setResendingProfileId] = useState<string | null>(null)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return assignments.filter((a) => {
      const staff = resolveJoin(a.staff)
      const section = resolveJoin(a.section)
      const course = resolveJoin(section?.course)
      const department = resolveJoin(course?.department)

      if (departmentFilter !== 'all' && department?.id !== departmentFilter) return false
      if (roleFilter !== 'all' && a.role !== roleFilter) return false
      if (statusFilter !== 'all' && derivedStatus(a) !== statusFilter) return false

      if (q) {
        const haystack = [
          staff?.name,
          staff?.email,
          course?.code,
          course?.title,
          department?.name,
          section?.section_code,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }

      return true
    })
  }, [assignments, search, departmentFilter, roleFilter, statusFilter])

  /* Which staff still hold an active assignment ANYWHERE, built from the unfiltered list.
     It has to ignore the filters: searching for one course hides that person's other rows,
     and reading the filtered list then offered Delete for someone the server refuses to
     delete. Raw `status`, not the derived display status, because deleteCourseAssistant
     checks `status = 'active'` and this guard has to check the same field. */
  const staffWithActiveAssignment = useMemo(() => {
    const ids = new Set<string>()
    for (const a of assignments) {
      if (a.status !== 'active') continue
      const id = resolveJoin(a.staff)?.id
      if (id) ids.add(id)
    }
    return ids
  }, [assignments])

  // Counts for the toolbar (respect department + role + search, but not status — so the status chips can show true totals).
  const counts = useMemo(() => {
    const q = search.trim().toLowerCase()
    let active = 0, ended = 0, removed = 0
    for (const a of assignments) {
      const staff = resolveJoin(a.staff)
      const section = resolveJoin(a.section)
      const course = resolveJoin(section?.course)
      const department = resolveJoin(course?.department)
      if (departmentFilter !== 'all' && department?.id !== departmentFilter) continue
      if (roleFilter !== 'all' && a.role !== roleFilter) continue
      if (q) {
        const hay = [staff?.name, staff?.email, course?.code, course?.title, department?.name, section?.section_code]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) continue
      }
      const ds = derivedStatus(a)
      if (ds === 'active') active++
      else if (ds === 'ended') ended++
      else removed++
    }
    return { active, ended, removed, all: active + ended + removed }
  }, [assignments, search, departmentFilter, roleFilter])

  function handleRevoke() {
    if (!revoking) return
    /* Read before the transition, because setRevoking(null) below clears what it derives from. */
    const wasAlreadyEnded = revokeAlreadyEnded
    startTransition(async () => {
      const res = await revokeStaffAssignment({
        staff_id: revoking.id,
        reason: revokeReason.trim() || undefined,
      })
      if (res.error) {
        toast.error(res.error)
      } else {
        /* The toast has to branch for the same reason the dialog does. One unconditional
           "Access revoked" told the admin they had just cut off access for someone whose
           access ended in January, immediately after a dialog that correctly said nothing
           would change for them. Contradicting the dialog you just showed is worse than
           saying nothing. */
        toast.success(
          wasAlreadyEnded
            ? 'Assignment closed out. Their end date is unchanged.'
            : 'Access revoked. Staff is no longer active on this section.',
        )
        setRevoking(null)
        setRevokeReason('')
      }
    })
  }

  function handleResendInvite(profileId: string, staffName: string) {
    setResendingProfileId(profileId)
    startTransition(async () => {
      const res = await resendStaffInvite({ profile_id: profileId })
      setResendingProfileId(null)
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success(`Fresh invite sent to ${staffName}`)
        if (res.emailWarning) {
          toast.warning(res.emailWarning, { duration: 8000 })
        }
      }
    })
  }

  return (
    <div className="space-y-4">
      {/* ── Toolbar ────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, course, or department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
            <SelectTrigger className="w-[180px]">
              <Building2 className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-[150px]">
              <GraduationCap className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value="ta">Teaching Assistant</SelectItem>
              <SelectItem value="grader">Grader</SelectItem>
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px]">
              <ShieldCheck className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ({counts.all})</SelectItem>
              <SelectItem value="active">Active ({counts.active})</SelectItem>
              <SelectItem value="ended">Ended ({counts.ended})</SelectItem>
              <SelectItem value="removed">Revoked ({counts.removed})</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-background p-12 text-center">
          <Users className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <h3 className="font-[family-name:var(--font-instrument-serif)] text-xl">
            {assignments.length === 0 ? 'No course assistants yet' : 'No matches'}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {assignments.length === 0
              ? 'Approved course assistant assignments will appear here.'
              : 'Try adjusting the search or filters.'}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-background overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Course Assistant</th>
                  <th className="text-left px-4 py-3 font-semibold">Role</th>
                  <th className="text-left px-4 py-3 font-semibold">Course</th>
                  <th className="text-left px-4 py-3 font-semibold">Instructor</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                  <th className="text-right px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const staff = resolveJoin(row.staff)
                  const hasActiveAssignment = staff?.id
                    ? staffWithActiveAssignment.has(staff.id)
                    : false
                  const section = resolveJoin(row.section)
                  const course = resolveJoin(section?.course)
                  const department = resolveJoin(course?.department)
                  const professor = resolveJoin(section?.professor)
                  const ds = derivedStatus(row)
                  const style = STATUS_STYLES[ds]
                  const isStaffPendingInvite = staff?.invite_status === 'pending'

                  return (
                    <tr key={row.id} className="border-t border-border/50 hover:bg-muted/10">
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-foreground">{staff?.name || '—'}</div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                          <Mail className="h-3 w-3 shrink-0" />
                          <span className="truncate max-w-[220px]">{staff?.email || '—'}</span>
                        </div>
                        {isStaffPendingInvite && staff?.id && (
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <span className="inline-block text-[10px] uppercase tracking-wider font-semibold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                              Invite pending
                            </span>
                            <button
                              type="button"
                              onClick={() => handleResendInvite(staff.id, staff.name || staff.email || 'course assistant')}
                              disabled={isPending && resendingProfileId === staff.id}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              title="Email a fresh invite link — invalidates the prior one"
                            >
                              <Send className="h-3 w-3" />
                              {isPending && resendingProfileId === staff.id ? 'Sending…' : 'Resend invite'}
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 align-top">
                        <span
                          className={
                            'text-[10px] uppercase tracking-wider font-semibold rounded-full px-2 py-0.5 border ' +
                            (row.role === 'ta'
                              ? 'border-foreground/30 bg-foreground/5 text-foreground'
                              : 'border-border bg-muted/40 text-muted-foreground')
                          }
                        >
                          {STAFF_ROLE_LABELS[row.role as 'ta' | 'grader']}
                        </span>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="font-mono text-[11px] font-semibold text-muted-foreground">
                          {course?.code || '—'}
                        </div>
                        <div className="text-xs truncate max-w-[220px]">{course?.title || '—'}</div>
                        <div className="text-[11px] text-muted-foreground/70 mt-0.5 capitalize">
                          {section?.semester} {section?.year} · {section?.section_code}
                        </div>
                        {department?.name && (
                          <div className="text-[11px] text-muted-foreground/70 mt-0.5 truncate max-w-[220px]">
                            {department.name}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div
                          className="text-xs truncate max-w-[180px]"
                          title={professor?.email || undefined}
                        >
                          {professor?.name || '—'}
                        </div>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className={'inline-flex items-center gap-1.5 text-[11px] font-medium ' + style.text}>
                          <div className={'h-1.5 w-1.5 rounded-full ' + style.dot} />
                          <span>
                            {style.label}
                            {ds === 'active' && row.ends_at && (
                              <span className="text-muted-foreground/70"> · ends {formatDate(row.ends_at)}</span>
                            )}
                            {/* An expired row rendered a bare "Ended" with no date, so the
                                admin could see neither when it ended nor that anything was
                                outstanding, which made the Close out button beside it look
                                like it contradicted the badge. Nothing in the app writes
                                status='ended', so these rows accumulate. */}
                            {ds !== 'active' && row.status === 'active' && row.ends_at && (
                              <span className="text-muted-foreground/70"> · {formatDate(row.ends_at)}, still open</span>
                            )}
                            {/* Closed rows showed no date at all, so the end date this branch
                                goes out of its way to PRESERVE was invisible everywhere in the
                                console. The close-out dialog promises "that end date is kept as
                                it is", and an admin had no way to see that it was. */}
                            {row.status === 'removed' && row.ends_at && (
                              <span className="text-muted-foreground/70"> · ended {formatDate(row.ends_at)}</span>
                            )}
                          </span>
                        </div>
                      </td>

                      <td className="px-4 py-3 align-top text-right">
                        {/* Raw status, not `ds`. A row whose ends_at has passed while the DB
                            row is still 'active' displays as "Ended", and gating Revoke on the
                            display status left it with no action at all: Revoke hidden because
                            it reads as ended, Delete hidden because the assignment really is
                            active. Revoking is exactly what closes it out and unlocks Delete. */}
                        {row.status === 'active' ? (
                          <button
                            type="button"
                            onClick={() => { setRevoking(row); setRevokeReason('') }}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          >
                            <UserX className="h-3 w-3" />
                            {ds === 'active' ? 'Revoke' : 'Close out'}
                          </button>
                        ) : hasActiveAssignment ? (
                          /* Delete removes the whole PROFILE, so it cannot be offered while the
                             person is still assigned somewhere, possibly a section the current
                             filter is hiding. An em-dash left the admin guessing why the button
                             appears on one closed row and not another. */
                          <span className="text-[11px] text-muted-foreground/70">Active elsewhere</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setDeleting(row)
                              setDeleteCounts(null)
                              getCourseAssistantCascadeCounts(staff.id)
                                .then((c) => setDeleteCounts(c ?? 'failed'))
                                .catch(() => setDeleteCounts('failed'))
                            }}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[11px] font-semibold text-destructive hover:bg-destructive-muted transition-colors"
                            title="Remove this course assistant's profile"
                          >
                            <Trash2 className="h-3 w-3" />
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Delete-profile dialog (#725 part 2) ────────────────────── */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) { setDeleting(null); setDeleteCounts(null) } }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-[family-name:var(--font-instrument-serif)] text-2xl">
              Delete this course assistant?
            </DialogTitle>
            <DialogDescription>
              This removes their profile and sign-in for good. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {deleteCounts === null ? (
              <p className="text-muted-foreground">Checking their course assignments…</p>
            ) : deleteCounts === 'failed' ? (
              /* Never a reassuring zero on a failed lookup — the #715 rule. */
              <p className="font-medium text-destructive">
                Couldn&apos;t check their course assignments. Deleting may remove someone who
                still has access.
              </p>
            ) : deleteCounts.activeAssignments > 0 ? (
              <p className="font-medium text-destructive">
                They are still assigned to {deleteCounts.activeAssignments} course
                section{deleteCounts.activeAssignments === 1 ? '' : 's'}. Revoke those first.
              </p>
            ) : (
              <p className="text-muted-foreground">
                No active assignments.
                {deleteCounts.pastAssignments > 0
                  ? ` ${deleteCounts.pastAssignments} past assignment${deleteCounts.pastAssignments === 1 ? '' : 's'} will be removed with the profile.`
                  : ''}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                isPending ||
                deleteCounts === null ||
                (deleteCounts !== 'failed' && deleteCounts.activeAssignments > 0)
              }
              onClick={() => {
                const staff = resolveJoin(deleting.staff)
                startTransition(async () => {
                  const res = await deleteCourseAssistant(staff.id)
                  if ('error' in res && res.error) {
                    toast.error(res.error)
                    return
                  }
                  /* No router.refresh(): deleteCourseAssistant revalidates /admin/staff
                     itself, which is how handleRevoke above already works. */
                  toast.success('Course assistant deleted')
                  setDeleting(null)
                  setDeleteCounts(null)
                })
              }}
            >
              {isPending ? 'Deleting…' : 'Delete profile'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Revoke dialog ──────────────────────────────────────────── */}
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) { setRevoking(null); setRevokeReason('') } }}
      >
        <DialogContent className="max-w-md">
          {/* Two different actions wear this dialog, so the copy cannot be fixed text. On a
              row that is still running, revoking cuts off access now. On a row whose ends_at
              has already passed, access ended on that date. Every access gate requires BOTH
              status='active' AND ends_at in the future, so promising to cut it off would
              describe something that already happened, and an admin who cannot trust this
              dialog cannot trust the delete one beside it either. */}
          <DialogHeader>
            <DialogTitle className="font-[family-name:var(--font-instrument-serif)] text-2xl">
              {revokeAlreadyEnded ? 'Close out this assignment?' : 'Revoke access?'}
            </DialogTitle>
            <DialogDescription>
              {revokeAlreadyEnded
                ? 'Their access already ended, so nothing changes for them. Here\u2019s exactly what happens:'
                : 'This ends the assignment immediately. Here\u2019s exactly what happens:'}
            </DialogDescription>
          </DialogHeader>

          <ul className="text-xs text-muted-foreground space-y-1.5 list-disc pl-5">
            {revokeAlreadyEnded ? (
              <>
                <li>
                  Their access to this section ended on{' '}
                  {revoking?.ends_at ? formatDate(revoking.ends_at) : 'its end date'}. This
                  doesn&apos;t take anything away that they still have.
                </li>
                <li>That end date is kept as it is. Closing this out does not change their service dates.</li>
                <li>It marks the assignment closed in our records, which is what lets you remove the profile afterwards.</li>
              </>
            ) : (
              <>
                <li>The staff member loses access to this section right away. They can&apos;t grade, take attendance, or open materials.</li>
                <li>Their end date is set to today.</li>
              </>
            )}
            <li>Any grades or attendance they already recorded stay intact.</li>
            <li>The action is logged to the audit trail with your optional reason below.</li>
            <li>No email is sent automatically — if they need to know, message them directly.</li>
          </ul>

          {revoking && (() => {
            const staff = resolveJoin(revoking.staff)
            const section = resolveJoin(revoking.section)
            const course = resolveJoin(section?.course)
            const courseLabel = course ? `${course.code} · ${course.title}` : section?.section_code || 'Section'
            return (
              <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-1.5">
                <div className="text-sm font-semibold">{staff?.name || staff?.email}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <GraduationCap className="h-3 w-3" />
                  {STAFF_ROLE_LABELS[revoking.role as 'ta' | 'grader']} · {courseLabel}
                </div>
              </div>
            )
          })()}

          <div className="space-y-1.5">
            <Label htmlFor="revoke-reason">Reason <span className="text-muted-foreground">(internal — optional)</span></Label>
            <Textarea
              id="revoke-reason"
              rows={3}
              placeholder="e.g. Student enrollment conflict; reassigned to another section."
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => { setRevoking(null); setRevokeReason('') }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={revokeAlreadyEnded ? 'default' : 'destructive'}
              onClick={handleRevoke}
              disabled={isPending}
            >
              {revokeAlreadyEnded
                ? isPending
                  ? 'Closing out…'
                  : 'Close out'
                : isPending
                  ? 'Revoking…'
                  : 'Revoke access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
