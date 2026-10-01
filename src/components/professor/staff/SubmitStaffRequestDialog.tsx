// Dialog where the professor enters candidate info and submits for admin approval.
'use client'

import { useEffect, useRef, useTransition } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  submitStaffRequestSchema,
  STAFF_REQUEST_MESSAGE_MAX,
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  STAFF_ROLE_DESCRIPTIONS,
  toEndOfDayIso,
  type SubmitStaffRequestInput,
} from '@/lib/validations/section-staff'
import { submitStaffRequest } from '@/app/(dashboard)/professor/courses/[sectionId]/staff/actions'

interface SubmitStaffRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sectionId: string
  sectionEndDate: string | null
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

export function SubmitStaffRequestDialog({
  open,
  onOpenChange,
  sectionId,
  sectionEndDate,
}: SubmitStaffRequestDialogProps) {
  const [isPending, startTransition] = useTransition()

  const form = useForm<SubmitStaffRequestInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(submitStaffRequestSchema) as any,
    defaultValues: {
      section_id: sectionId,
      candidate_email: '',
      candidate_first_name: '',
      candidate_last_name: '',
      requested_role: 'ta',
      ends_at: sectionEndDate ? toDateInputValue(sectionEndDate) : '',
      message: '',
    },
  })

  const selectedRole = useWatch({ control: form.control, name: 'requested_role' }) ?? 'ta'
  const roleRefs = useRef<Array<HTMLButtonElement | null>>([])
  const messageValue = useWatch({ control: form.control, name: 'message' })

  /* Reset on CLOSE, not only on success (#748). form.reset() lived on the success
     branch alone, so cancelling or pressing Esc left the previous candidate's name,
     email and note sitting in the form for whoever opened it next. Same shape as the
     stale-dialog-state bug in #736 on another surface. */
  useEffect(() => {
    if (!open) {
      form.reset({
        section_id: sectionId,
        candidate_email: '',
        candidate_first_name: '',
        candidate_last_name: '',
        requested_role: 'ta',
        ends_at: sectionEndDate ? toDateInputValue(sectionEndDate) : '',
        message: '',
      })
    }
  }, [open, form, sectionId, sectionEndDate])

  function onSubmit(values: SubmitStaffRequestInput) {
    startTransition(async () => {
      const endsAt = toEndOfDayIso(values.ends_at ?? '')

      const res = await submitStaffRequest({
        ...values,
        ends_at: endsAt,
      })
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success('Request submitted — awaiting admin approval')
        form.reset()
        onOpenChange(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Request a Course Assistant</DialogTitle>
          <DialogDescription>
            Enter the candidate&apos;s details. Your institution admin will review and approve — once approved, the candidate receives an invite email.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Role picker — accessible radio group bound to react-hook-form */}
          <div className="space-y-2">
            <Label id="role-label">Role</Label>
            <div
              role="radiogroup"
              aria-labelledby="role-label"
              className="grid grid-cols-2 gap-2"
            >
              {STAFF_ROLES.map((role, idx) => {
                const checked = selectedRole === role
                return (
                  <button
                    key={role}
                    ref={(el) => { roleRefs.current[idx] = el }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked || (!selectedRole && idx === 0) ? 0 : -1}
                    onClick={() => form.setValue('requested_role', role, { shouldDirty: true })}
                    onKeyDown={(e) => {
                      /* Roving tabindex needs focus to MOVE with the selection (#748).
                         Selection changed but document.activeElement stayed put, so
                         the next arrow press was computed from the old index and the
                         user submitted a role they hadn't chosen — which here is the
                         difference between a TA and a read-only grader. */
                      const move = (delta: number) => {
                        e.preventDefault()
                        const nextIdx = (idx + delta + STAFF_ROLES.length) % STAFF_ROLES.length
                        form.setValue('requested_role', STAFF_ROLES[nextIdx], { shouldDirty: true })
                        roleRefs.current[nextIdx]?.focus()
                      }
                      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1)
                      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1)
                    }}
                    className={
                      'rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
                      (checked
                        ? 'border-primary bg-accent'
                        : 'border-border hover:bg-muted')
                    }
                  >
                    <div className="text-sm font-semibold">{STAFF_ROLE_LABELS[role]}</div>
                    <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                      {STAFF_ROLE_DESCRIPTIONS[role]}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Name fields */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="first_name">First name</Label>
              <Input
                id="first_name"
                {...form.register('candidate_first_name')}
                placeholder="Alex"
                autoComplete="given-name"
              />
              {form.formState.errors.candidate_first_name && (
                <p className="text-xs text-destructive">{form.formState.errors.candidate_first_name.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="last_name">Last name</Label>
              <Input
                id="last_name"
                {...form.register('candidate_last_name')}
                placeholder="Kumar"
                autoComplete="family-name"
              />
              {form.formState.errors.candidate_last_name && (
                <p className="text-xs text-destructive">{form.formState.errors.candidate_last_name.message}</p>
              )}
            </div>
          </div>

          {/* Email */}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              {...form.register('candidate_email')}
              placeholder="alex.kumar@university.edu"
              autoComplete="email"
            />
            {form.formState.errors.candidate_email && (
              <p className="text-xs text-destructive">{form.formState.errors.candidate_email.message}</p>
            )}
            <p className="text-[11px] text-muted-foreground">If this email is already in Scholera, the admin will link access; otherwise a new account will be created.</p>
          </div>

          {/* Access end date */}
          <div className="space-y-1.5">
            <Label htmlFor="ends_at">Access ends on</Label>
            <Input
              id="ends_at"
              type="date"
              {...form.register('ends_at')}
              defaultValue={sectionEndDate ? toDateInputValue(sectionEndDate) : ''}
            />
            {form.formState.errors.ends_at && (
              <p className="text-xs text-destructive">{form.formState.errors.ends_at.message}</p>
            )}
            <p className="text-[11px] text-muted-foreground">Defaults to your section&apos;s end date. Access auto-expires on this day.</p>
          </div>

          {/* Justification */}
          <div className="space-y-1.5">
            <Label htmlFor="message">Note for admin <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="message"
              {...form.register('message')}
              placeholder="Briefly explain why this person is a good fit."
              rows={3}
              maxLength={STAFF_REQUEST_MESSAGE_MAX}
            />
            {/* The note had no error block at all (#748): over 500 characters failed
                client validation, onSubmit never ran, and with nothing rendered the
                Submit button simply did nothing with no explanation. maxLength stops
                it happening in the first place; the counter says why. */}
            <div className="flex items-center justify-between gap-2">
              {form.formState.errors.message ? (
                <p className="text-xs text-destructive">{form.formState.errors.message.message}</p>
              ) : (
                <span />
              )}
              {/* Turns destructive AT the limit. maxLength prevents the invalid state
                  (better than an error after the fact) but it also means typing just
                  stops, which reads as "my keyboard broke" if nothing responds. */}
              <span
                className={cn(
                  'text-xs tabular-nums',
                  (messageValue?.length ?? 0) >= STAFF_REQUEST_MESSAGE_MAX
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}
              >
                {(messageValue?.length ?? 0)}/{STAFF_REQUEST_MESSAGE_MAX}
              </span>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Submitting…' : 'Submit for approval'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
