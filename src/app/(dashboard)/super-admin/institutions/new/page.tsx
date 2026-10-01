// Create Institution form page — wraps the client component CreateInstitutionForm
// inside a simple titled layout. The form handles its own state + submission.

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { CreateInstitutionForm } from '@/components/super-admin/institutions/CreateInstitutionForm'

export default function CreateInstitutionPage() {
  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      <div>
        <Link
          href="/super-admin"
          className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Institutions
        </Link>
        <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">
          Platform
        </p>
        <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
          Create Institution
        </h1>
        <p className="text-[15px] text-muted-foreground mt-2">
          Provision a new tenant. You can invite a primary institution admin now, or skip and invite later.
        </p>
      </div>

      <CreateInstitutionForm />
    </div>
  )
}
