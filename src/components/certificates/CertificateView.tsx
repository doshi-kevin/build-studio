/**
 * CertificateView — presentational certificate card, shared by the public page
 * and the in-app student view. No hooks, no client APIs (safe as a server
 * component). Sharing controls live in CertificateShareButtons.
 */
import { Award } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export interface CertificateViewData {
  studentName: string
  title: string
  description?: string
  institutionName: string
  skills: string[]
  issuedAt: string
}

export function CertificateView({ cert }: { cert: CertificateViewData }) {
  const issued = new Date(cert.issuedAt)
  const issuedLabel = Number.isNaN(issued.getTime())
    ? ''
    : issued.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  return (
    <div className="mx-auto w-full max-w-2xl rounded-2xl border-2 border-primary/20 bg-card p-8 text-center shadow-sm sm:p-12">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
        <Award className="h-7 w-7 text-primary" aria-hidden="true" />
      </div>
      <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {cert.institutionName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-foreground sm:text-3xl">Certificate of Achievement</h1>
      <p className="mt-6 text-sm text-muted-foreground">This certifies that</p>
      <p className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">{cert.studentName}</p>
      <p className="mt-4 text-sm text-muted-foreground">has successfully earned</p>
      <p className="mt-1 text-lg font-semibold text-primary">{cert.title}</p>
      {cert.description && (
        <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">{cert.description}</p>
      )}
      {cert.skills.length > 0 && (
        <div className="mt-6 flex flex-wrap justify-center gap-1.5">
          {cert.skills.map((s) => (
            <Badge key={s} variant="secondary" className="font-normal">
              {s}
            </Badge>
          ))}
        </div>
      )}
      {issuedLabel && <p className="mt-8 text-xs text-muted-foreground">Issued {issuedLabel}</p>}
    </div>
  )
}
