// Admin approval queue — one-click approve or reject with a required note.
'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2,
  XCircle,
  Clock,
  Mail,
  Calendar,
  User as UserIcon,
  GraduationCap,
  MessageSquare,
  AlertTriangle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { STAFF_ROLE_LABELS, toEndOfDayIso } from '@/lib/validations/section-staff'
import {
  approveStaffRequest,
  rejectStaffRequest,
} from '@/app/(dashboard)/admin/staff-requests/actions'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any

function resolveJoin<T>(val: T | T[] | null | undefined): T | null {
  if (!val) return null
  return Array.isArray(val) ? val[0] : val
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

export function StaffRequestQueue({ requests }: { requests: AnyRow[] }) {
  const [isPending, startTransition] = useTransition()
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [approving, setApproving] = useState<AnyRow | null>(null)
  const [approveEndsAt, setApproveEndsAt] = useState('')
  const [approveNote, setApproveNote] = useState('')
  const [promotionPrompt, setPromotionPrompt] = useState<
    | { candidateName: string; candidateEmail: string; endsAtIso: string | undefined; note: string | undefined }
    | null
  >(null)

  if (requests.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-background p-12 text-center">
        <Clock className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
        <h3 className="font-[family-name:var(--font-instrument-serif)] text-xl">All caught up</h3>
        <p className="text-sm text-muted-foreground mt-1">No pending course assistant requests right now.</p>
      </div>
    )
  }

  function openApproveDialog(req: AnyRow) {
    setApproving(req)
    setApproveEndsAt(toDateInputValue(req.ends_at))
    setApproveNote('')
  }

  function closeApproveDialog() {
    setApproving(null)
    setApproveEndsAt('')
    setApproveNote('')
  }

  function handleApprove() {
    if (!approving) return
    /* Second copy of the #748 crash — this one is in the admin console and wasn't
       reported. Same unguarded conversion, same RangeError, same error boundary. */
    const endsAtIso = toEndOfDayIso(approveEndsAt)
    const note = approveNote.trim() || undefined
    const requestId = approving.id
    startTransition(async () => {
      const res = await approveStaffRequest({
        request_id: requestId,
        ends_at: endsAtIso,
        note,
      })
      if (res.error) {
        toast.error(res.error)
      } else if (res.requires_student_promotion) {
        setPromotionPrompt({
          candidateName: res.candidate?.name || `${approving.candidate_first_name} ${approving.candidate_last_name}`,
          candidateEmail: res.candidate?.email || approving.candidate_email,
          endsAtIso,
          note,
        })
      } else {
        toast.success('Approved — invite sent to candidate')
        if (res.emailWarning) {
          toast.warning(res.emailWarning, { duration: 8000 })
        }
        closeApproveDialog()
      }
    })
  }

  function handleConfirmPromotion() {
    if (!approving || !promotionPrompt) return
    const { endsAtIso, note } = promotionPrompt
    const requestId = approving.id
    startTransition(async () => {
      const res = await approveStaffRequest({
        request_id: requestId,
        ends_at: endsAtIso,
        note,
        promote_existing_student: true,
      })
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success('Approved — student promoted to staff')
        if (res.emailWarning) {
          toast.warning(res.emailWarning, { duration: 8000 })
        }
        setPromotionPrompt(null)
        closeApproveDialog()
      }
    })
  }

  function handleReject() {
    if (!rejectingId) return
    const note = rejectNote.trim()
    if (!note) {
      toast.error('Please explain why you are rejecting this request')
      return
    }
    startTransition(async () => {
      const res = await rejectStaffRequest({ request_id: rejectingId, note })
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success('Request rejected — professor notified by email')
        setRejectingId(null)
        setRejectNote('')
      }
    })
  }

  return (
    <>
      <div className="space-y-3">
        {requests.map((req) => {
          const requester = resolveJoin(req.requester)
          const section = resolveJoin(req.section)
          const course = resolveJoin(section?.course)
          const courseLabel = course ? `${course.code} · ${course.title}` : section?.section_code || 'Section'
          const semesterLabel = section ? `${section.semester} ${section.year}` : ''

          return (
            <div
              key={req.id}
              className="rounded-2xl border border-border bg-background p-5"
            >
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-[15px]">
                      {req.candidate_first_name} {req.candidate_last_name}
                    </h3>
                    <span
                      className={
                        'text-[10px] uppercase tracking-wider font-semibold rounded-full px-2 py-0.5 border ' +
                        (req.requested_role === 'ta'
                          ? 'border-foreground/30 bg-foreground/5 text-foreground'
                          : 'border-border bg-muted/40 text-muted-foreground')
                      }
                    >
                      {STAFF_ROLE_LABELS[req.requested_role as 'ta' | 'grader']}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{req.candidate_email}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 shrink-0" />
                      <span>Through {formatDate(req.ends_at)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <GraduationCap className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {courseLabel}
                        {semesterLabel && <span className="text-muted-foreground/70"> · {semesterLabel}</span>}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <UserIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        Requested by {requester?.name || 'unknown'}
                      </span>
                    </div>
                  </div>

                  {req.message && (
                    <div className="mt-3 rounded-lg bg-muted/30 border border-border px-3 py-2 flex gap-2">
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
                      <p className="text-xs text-foreground/80 italic leading-relaxed">
                        &quot;{req.message}&quot;
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      setRejectingId(req.id)
                      setRejectNote('')
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => openApproveDialog(req)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-2 text-xs font-semibold hover:scale-[1.02] active:scale-95 transition-[opacity,transform] disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Approve
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <Dialog open={rejectingId !== null} onOpenChange={(open) => { if (!open) { setRejectingId(null); setRejectNote('') } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-[family-name:var(--font-instrument-serif)] text-2xl">
              Reject request
            </DialogTitle>
            <DialogDescription>
              The professor will receive an email with the reason. Be concise and specific.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="note">Reason</Label>
            <Textarea
              id="note"
              rows={4}
              placeholder="e.g. Candidate already holds a TA role in another department; revisit next semester."
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => { setRejectingId(null); setRejectNote('') }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleReject}
              disabled={isPending || !rejectNote.trim()}
            >
              {isPending ? 'Rejecting…' : 'Reject request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={approving !== null} onOpenChange={(open) => { if (!open) closeApproveDialog() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-[family-name:var(--font-instrument-serif)] text-2xl">
              Approve this request?
            </DialogTitle>
            <DialogDescription>
              The candidate will get an invite email and be activated on this section immediately. This cannot be undone from the queue — you&apos;d need to revoke the assignment.
            </DialogDescription>
          </DialogHeader>

          {approving && (() => {
            const section = resolveJoin(approving.section)
            const course = resolveJoin(section?.course)
            const courseLabel = course ? `${course.code} · ${course.title}` : section?.section_code || 'Section'
            return (
              <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-1.5">
                <div className="text-sm font-semibold">
                  {approving.candidate_first_name} {approving.candidate_last_name}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Mail className="h-3 w-3" /> {approving.candidate_email}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <GraduationCap className="h-3 w-3" />
                  {STAFF_ROLE_LABELS[approving.requested_role as 'ta' | 'grader']} · {courseLabel}
                </div>
              </div>
            )
          })()}

          <div className="space-y-1.5">
            <Label htmlFor="approve-ends-at">Access ends on</Label>
            <Input
              id="approve-ends-at"
              type="date"
              value={approveEndsAt}
              onChange={(e) => setApproveEndsAt(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Override the professor&apos;s end date if needed. Defaults to what they requested.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="approve-note">Internal note <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="approve-note"
              rows={2}
              placeholder="Visible to admins only — not sent to the candidate."
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={closeApproveDialog} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" onClick={handleApprove} disabled={isPending}>
              {isPending ? 'Approving…' : 'Send invite & approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={promotionPrompt !== null} onOpenChange={(open) => { if (!open) setPromotionPrompt(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-[family-name:var(--font-instrument-serif)] text-2xl">
              Promote student to staff?
            </DialogTitle>
            <DialogDescription>
              This email is already registered as a student. Promoting them will change their identity — they will lose access to the student dashboard and start signing in as staff.
            </DialogDescription>
          </DialogHeader>

          {promotionPrompt && (
            <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-1.5">
              <div className="text-sm font-semibold">{promotionPrompt.candidateName}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-3 w-3" /> {promotionPrompt.candidateEmail}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-foreground/20 bg-foreground/5 p-4 flex gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-foreground mt-0.5" />
            <div className="text-xs text-foreground/80 leading-relaxed space-y-1">
              <p><span className="font-semibold text-foreground">Their past enrollments stay on record</span> — course history is preserved in the database.</p>
              <p><span className="font-semibold text-foreground">They keep their password</span> — no re-setup required.</p>
              <p><span className="font-semibold text-foreground">/student routes will be blocked</span> for them from their next session onward.</p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setPromotionPrompt(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" onClick={handleConfirmPromotion} disabled={isPending}>
              {isPending ? 'Promoting…' : 'Promote & approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
