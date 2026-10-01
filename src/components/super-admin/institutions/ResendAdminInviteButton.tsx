// Inline "Resend" button shown on pending institution_admin rows. Triggers a
// fresh temp password + welcome email via resendInstitutionAdminInvite.

'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { resendInstitutionAdminInvite } from '@/app/(dashboard)/super-admin/institutions/actions'
import { Button } from '@/components/ui/button'

export function ResendAdminInviteButton({ adminUserId, email }: { adminUserId: string; email: string }) {
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    startTransition(async () => {
      const result = await resendInstitutionAdminInvite(adminUserId)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`Invite resent to ${email}.`)
    })
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleClick}>
      {isPending ? 'Sending…' : 'Resend'}
    </Button>
  )
}
