// Client form for super_admin Create Institution flow.
// Slug is auto-generated from name on first edit, then editable.
// Primary admin section is optional and collapsible — institutions can be
// created without an admin (UI surfaces a warning on the list view).

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  createInstitutionSchema,
  type CreateInstitutionInput,
} from '@/lib/validations/institution'
import { createInstitution } from '@/app/(dashboard)/super-admin/institutions/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

export function CreateInstitutionForm() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showAdminFields, setShowAdminFields] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)

  const form = useForm<CreateInstitutionInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createInstitutionSchema) as any,
    defaultValues: {
      name: '',
      slug: '',
      primaryAdminEmail: '',
      primaryAdminName: '',
    },
  })

  function onNameChange(value: string) {
    form.setValue('name', value)
    if (!slugTouched) {
      form.setValue('slug', slugify(value), { shouldValidate: false })
    }
  }

  /** Collapsing the admin section also clears its values, so Zod's bidirectional
   * "both or neither" refine sees them as absent rather than asymmetric. */
  function toggleAdminFields() {
    setShowAdminFields((prev) => {
      const next = !prev
      if (!next) {
        form.setValue('primaryAdminEmail', '', { shouldValidate: false })
        form.setValue('primaryAdminName', '', { shouldValidate: false })
        form.clearErrors(['primaryAdminEmail', 'primaryAdminName'])
      }
      return next
    })
  }

  function onSubmit(data: CreateInstitutionInput) {
    startTransition(async () => {
      const result = await createInstitution(data)
      if ('error' in result) {
        toast.error(result.error)
        return
      }
      const adminInvited = !!result.data.primaryAdminId
      toast.success(
        adminInvited
          ? `Institution "${data.name}" created and admin invited.`
          : `Institution "${data.name}" created. You can invite an admin from the list view.`,
      )
      router.push('/super-admin')
      router.refresh()
    })
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      {/* ── Required: institution identity ─────────────────────────── */}
      <div className="rounded-2xl border border-border bg-background p-6 space-y-4">
        <h2 className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
          Institution
        </h2>

        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            placeholder="e.g. University of Illinois Urbana-Champaign"
            {...form.register('name', { onChange: (e) => onNameChange(e.target.value) })}
          />
          {form.formState.errors.name && (
            <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            placeholder="uiuc"
            {...form.register('slug', { onChange: () => setSlugTouched(true) })}
          />
          <p className="text-[11px] text-muted-foreground">
            Lowercase letters, digits, and hyphens. Internal handle for now — future URL routing
            uses this.
          </p>
          {form.formState.errors.slug && (
            <p className="text-xs text-destructive">{form.formState.errors.slug.message}</p>
          )}
        </div>
      </div>

      {/* ── Optional: primary admin invite ───────────────────────────── */}
      <div className="rounded-2xl border border-border bg-background overflow-hidden">
        <button
          type="button"
          onClick={toggleAdminFields}
          className="w-full flex items-center justify-between p-6 hover:bg-muted/20 transition-colors"
        >
          <div className="text-left">
            <h2 className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              Primary Admin (optional)
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {showAdminFields
                ? 'Invite the LMS owner at this institution. They\'ll receive a temp password by email.'
                : 'Skip for now — invite an admin from the list view later.'}
            </p>
          </div>
          {showAdminFields ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
        </button>

        {showAdminFields && (
          <div className="px-6 pb-6 space-y-4 border-t border-border pt-4">
            <div className="space-y-1.5">
              <Label htmlFor="primaryAdminName">Admin name</Label>
              <Input
                id="primaryAdminName"
                placeholder="Jane Doe"
                {...form.register('primaryAdminName')}
              />
              {form.formState.errors.primaryAdminName && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.primaryAdminName.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="primaryAdminEmail">Admin email</Label>
              <Input
                id="primaryAdminEmail"
                type="email"
                placeholder="jane.doe@institution.edu"
                {...form.register('primaryAdminEmail')}
              />
              {form.formState.errors.primaryAdminEmail && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.primaryAdminEmail.message}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.push('/super-admin')}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isPending}
          className="rounded-full hover:scale-[1.02] active:scale-95 transition-[color,background-color,border-color,box-shadow,opacity,transform]"
        >
          {isPending ? 'Creating…' : showAdminFields ? 'Create & Invite' : 'Create Institution'}
        </Button>
      </div>
    </form>
  )
}
