// Inline form to invite an institution_admin into an existing institution.
// Lives inside the empty-admin warning card on the Institution Detail page.

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { inviteAdminToInstitution } from '@/app/(dashboard)/super-admin/institutions/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  institutionId: string
  institutionName: string
}

export function InviteAdminCard({ institutionId, institutionName }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) {
      toast.error('Name and email are required')
      return
    }
    startTransition(async () => {
      const result = await inviteAdminToInstitution({
        institutionId,
        name: name.trim(),
        email: email.trim(),
      })
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      toast.success(`Invite sent to ${email} for ${institutionName}.`)
      setName('')
      setEmail('')
      router.refresh()
    })
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
      <div className="space-y-1.5">
        <Label htmlFor="adminName">Admin name</Label>
        <Input
          id="adminName"
          placeholder="Jane Doe"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="adminEmail">Admin email</Label>
        <Input
          id="adminEmail"
          type="email"
          placeholder="admin@example.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        disabled={isPending}
      >
        {isPending ? 'Sending…' : 'Invite Admin'}
      </Button>
    </form>
  )
}
